const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");

/*
 * Stores the full Baileys auth state (creds + signal keys) as one JSON blob
 * in Upstash Redis via its REST API, instead of local files. This is what
 * makes persistent WhatsApp login work on Render's free tier, where the
 * filesystem is wiped on every restart/redeploy/spin-down.
 *
 * Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (free tier
 * at upstash.com — no credit card, no expiry on the free database).
 */

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = process.env.UPSTASH_REDIS_KEY || "baileys-auth";

async function redisGet(key) {
  const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Upstash GET failed: ${res.status}`);
  const data = await res.json();
  return data.result || null;
}

async function redisSet(key, value) {
  const res = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "text/plain" },
    body: value
  });
  if (!res.ok) throw new Error(`Upstash SET failed: ${res.status}`);
}

async function useRedisAuthState() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set to use redis auth state");
  }

  const raw = await redisGet(REDIS_KEY);
  const stored = raw ? JSON.parse(raw, BufferJSON.reviver) : null;

  const creds = stored?.creds || initAuthCreds();
  const keys = stored?.keys || {};

  let saving = false;
  let pending = false;

  async function persist() {
    if (saving) { pending = true; return; }
    saving = true;
    try {
      const payload = JSON.stringify({ creds, keys }, BufferJSON.replacer);
      await redisSet(REDIS_KEY, payload);
    } finally {
      saving = false;
      if (pending) { pending = false; await persist(); }
    }
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = keys[type]?.[id];
            if (value) {
              if (type === "app-state-sync-key") {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }
          }
          return data;
        },
        set: async data => {
          for (const type in data) {
            keys[type] = keys[type] || {};
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) keys[type][id] = value;
              else delete keys[type][id];
            }
          }
          await persist();
        }
      }
    },
    saveCreds: persist
  };
}

module.exports = { useRedisAuthState };
