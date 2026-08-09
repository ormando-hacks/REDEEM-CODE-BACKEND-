const path = require("path");
const fs = require("fs");
const EventEmitter = require("events");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = require("@whiskeysockets/baileys");
const { useRedisAuthState } = require("./redisAuthState");

/*
 * Real WhatsApp session adapter, backed by Baileys.
 *
 * Public interface used by the rest of the app:
 *   start(phoneNumber) -> requests a pairing code (or reuses a saved session)
 *   status()           -> current connection state, including the pairing code
 *   disconnect()       -> logs out and wipes the saved auth
 *   onMessage(cb)       -> subscribe to incoming text messages
 *   onConnection(cb)    -> subscribe to connection state changes
 *
 * Auth storage: if UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set,
 * credentials persist to Upstash Redis — required on Render's free tier,
 * whose filesystem is wiped on every restart/redeploy/spin-down. Otherwise
 * falls back to a local auth_info_baileys/ folder (fine for local dev, or
 * for a paid Render plan with a persistent disk mounted at AUTH_DIR).
 */

const emitter = new EventEmitter();
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "auth_info_baileys");
const USE_REDIS = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || "silent" });

async function loadAuthState() {
  if (USE_REDIS) return useRedisAuthState();
  return useMultiFileAuthState(AUTH_DIR);
}

async function clearAuthState() {
  if (USE_REDIS) {
    const { initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");
    const fresh = JSON.stringify({ creds: initAuthCreds(), keys: {} }, BufferJSON.replacer);
    await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(process.env.UPSTASH_REDIS_KEY || "baileys-auth")}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "text/plain" },
      body: fresh
    });
    return;
  }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}

let sock = null;
let state = {
  connected: false,
  connecting: false,
  phoneNumber: null,
  pairingCode: null,
  lastError: null
};
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 6;

function extractText(message) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

async function connectSocket(digits, { requestCode }) {
  const { state: authState, saveCreds } = await loadAuthState();
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: authState,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 5000
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", update => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      reconnectAttempts = 0;
      state.connected = true;
      state.connecting = false;
      state.pairingCode = null;
      state.lastError = null;
      console.log("[session] connection open for", digits);
      emitter.emit("connection", { connected: true });
    }

    if (connection === "close") {
      state.connected = false;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const restartRequired = statusCode === DisconnectReason.restartRequired; // 515
      state.lastError = { statusCode, message: lastDisconnect?.error?.message || "connection closed" };
      console.error("[session] connection closed:", JSON.stringify(state.lastError));

      if (loggedOut) {
        state.connecting = false;
        emitter.emit("connection", { connected: false, error: state.lastError });
        clearAuthState().catch(() => {});
        return;
      }

      // 515 "restart required" is WhatsApp's normal signal right after a
      // pairing code is accepted — Baileys expects an immediate reconnect
      // using the now-registered credentials, not a fresh pairing code.
      // Any other non-logout close is also worth a bounded number of
      // automatic retries (transient network drops, Render cold starts).
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = restartRequired ? 500 : Math.min(2000 * reconnectAttempts, 10000);
        console.log(`[session] reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${delay}ms, reason: ${restartRequired ? "restart required (515)" : "close"}`);
        state.connecting = true;
        emitter.emit("connection", { connected: false, error: state.lastError, reconnecting: true });
        setTimeout(() => {
          connectSocket(digits, { requestCode: false }).catch(err => {
            console.error("[session] reconnect failed:", err.message);
          });
        }, delay);
      } else {
        state.connecting = false;
        console.error("[session] giving up after", reconnectAttempts, "reconnect attempts");
        emitter.emit("connection", { connected: false, error: state.lastError });
      }
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const text = extractText(msg.message);
      if (text) emitter.emit("message", { type: "text", text, id: msg.key.id || null });
    }
  });

  if (requestCode && !authState.creds.registered) {
    // Give the socket a moment to finish establishing its connection to
    // WhatsApp's servers before requesting a pairing code — requesting
    // immediately after makeWASocket() is a common cause of
    // "Couldn't link device" errors on the phone.
    await new Promise(resolve => setTimeout(resolve, 3000));
    const code = await sock.requestPairingCode(digits);
    state.pairingCode = code;
    console.log("[session] pairing code issued:", code, "for", digits);
    return { ok: true, connecting: true, phoneNumber: digits, pairingCode: code };
  }

  return { ok: true, connecting: true, phoneNumber: digits, message: "Reusing saved session" };
}

async function start(phoneNumber) {
  const digits = String(phoneNumber || "").replace(/\D/g, "");
  if (digits.length < 7) {
    throw new Error("phoneNumber must be in international format, digits only (no + or spaces)");
  }
  console.log("[session] start() called for", digits);

  if (sock) {
    try { sock.end(undefined); } catch (_) { /* ignore */ }
    sock = null;
  }

  reconnectAttempts = 0;
  state = { connected: false, connecting: true, phoneNumber: digits, pairingCode: null, lastError: null };

  return connectSocket(digits, { requestCode: true });
}

async function disconnect() {
  if (sock) {
    try { await sock.logout(); } catch (_) { /* ignore */ }
    try { sock.end(undefined); } catch (_) { /* ignore */ }
    sock = null;
  }
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // block any in-flight reconnect timer from firing
  await clearAuthState();
  state = { connected: false, connecting: false, phoneNumber: null, pairingCode: null, lastError: null };
  emitter.emit("connection", { connected: false });
}

function status() {
  return { ok: true, ...state };
}

function onMessage(callback) {
  emitter.on("message", callback);
  return () => emitter.off("message", callback);
}

function onConnection(callback) {
  emitter.on("connection", callback);
  return () => emitter.off("connection", callback);
}

module.exports = { start, disconnect, status, onMessage, onConnection };
