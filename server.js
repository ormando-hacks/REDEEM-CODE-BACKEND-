require("dotenv").config();

const express = require("express");
const pino = require("pino");
const cors = require("cors");
const session = require("./session");
const { scanText } = require("./textDetector");

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";

const state = {
  detectorRunning: false,
  settings: {
    minLength: Number(process.env.CODE_MIN_LENGTH || 12),
    maxLength: Number(process.env.CODE_MAX_LENGTH || 15),
    capitalOnly: true,
    groups: true,
    channels: true,
    privateChats: false,
    duplicateProtection: true,
    notifications: true,
    soundDuration: 5,
    vibration: true
  },
  stats: { groups: 0, channels: 0, messages: 0 },
  detections: []
};

function recordDetection(result, source = "text") {
  if (!result?.code) return null;

  const duplicate = state.detections.find(
    x => x.code === result.code &&
         Date.now() - x.timestamp < Number(process.env.CODE_COOLDOWN_MS || 30000)
  );
  if (state.settings.duplicateProtection && duplicate) return duplicate;

  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    code: result.code,
    source,
    timestamp: Date.now()
  };

  state.detections.unshift(item);
  state.detections = state.detections.slice(0, 200);
  return item;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "whatsapp-code-detector", time: new Date().toISOString() });
});

app.post("/api/session/start", async (req, res) => {
  try {
    const phoneNumber = String(req.body?.phoneNumber || "").trim();
    const result = await session.start(phoneNumber);
    res.json(result);
  } catch (error) {
    logger.error(error);
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/session/status", (req, res) => {
  res.json(session.status());
});

app.post("/api/session/disconnect", async (req, res) => {
  try {
    await session.disconnect();
    state.detectorRunning = false;
    res.json({ ok: true });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/detector/start", (req, res) => {
  if (!session.status().connected) {
    return res.status(409).json({ ok: false, error: "WhatsApp session is not connected" });
  }
  state.detectorRunning = true;
  res.json({ ok: true, running: true });
});

app.post("/api/detector/stop", (req, res) => {
  state.detectorRunning = false;
  res.json({ ok: true, running: false });
});

app.get("/api/detector/status", (req, res) => {
  res.json({
    ok: true,
    running: state.detectorRunning,
    stats: state.stats,
    detections: state.detections.slice(0, 20)
  });
});

app.get("/api/settings", (req, res) => res.json({ ok: true, settings: state.settings }));

app.post("/api/settings", (req, res) => {
  const incoming = req.body || {};
  const numeric = (key, fallback) => {
    const n = Number(incoming[key]);
    return Number.isFinite(n) ? n : fallback;
  };

  state.settings.minLength = Math.max(1, Math.min(50, numeric("minLength", state.settings.minLength)));
  state.settings.maxLength = Math.max(state.settings.minLength, Math.min(50, numeric("maxLength", state.settings.maxLength)));

  for (const key of ["capitalOnly", "groups", "channels", "privateChats", "duplicateProtection", "notifications", "vibration"]) {
    if (typeof incoming[key] === "boolean") state.settings[key] = incoming[key];
  }

  const sound = numeric("soundDuration", state.settings.soundDuration);
  state.settings.soundDuration = Math.max(1, Math.min(30, sound));

  res.json({ ok: true, settings: state.settings });
});

app.get("/api/detections", (req, res) => {
  res.json({ ok: true, detections: state.detections });
});

app.delete("/api/detections", (req, res) => {
  state.detections = [];
  res.json({ ok: true });
});

// Local testing endpoint. Does not touch WhatsApp — lets you verify the
// detector and frontend before a real session is linked.
app.post("/api/test/text", (req, res) => {
  const result = scanText(String(req.body?.text || ""), state.settings);
  if (result) recordDetection(result, "text-test");
  state.stats.messages++;
  res.json({ ok: true, match: result || null });
});

session.onMessage(message => {
  if (!state.detectorRunning) return;
  state.stats.messages++;

  if (message.type === "text") {
    const result = scanText(message.text, state.settings);
    if (result) recordDetection(result, "whatsapp-text");
  }
});

app.use((err, req, res, next) => {
  logger.error(err);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

app.listen(port, host, () => {
  logger.info(`Backend listening on http://${host}:${port}`);
});
