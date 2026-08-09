const crypto = require("node:crypto");

/**
 * Mounts mobile-safe routes onto the existing Express server.
 * The state object may be replaced with a database-backed adapter by the host.
 * Nothing in this module accepts or stores full SMS bodies.
 */
function mountMobileRoutes(app, { state, persistDetection, getAuthorizedChannels }) {
  if (!state.mobileDetections) state.mobileDetections = [];

  app.post("/api/detections/mobile", async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const source = typeof req.body?.source === "string" ? req.body.source : "";
    const timestamp = Number(req.body?.timestamp);
    if (!/^[A-Z0-9]{12,50}$/.test(code) || !["sms", "whatsapp", "manual"].includes(source)) {
      return res.status(400).json({ ok: false, error: "Invalid detection payload" });
    }
    const item = {
      id: crypto.randomUUID(),
      code,
      source,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      createdAt: new Date().toISOString(),
    };
    const duplicate = state.mobileDetections.find((entry) => entry.code === item.code && entry.source === item.source);
    if (!duplicate) {
      state.mobileDetections.unshift(item);
      state.mobileDetections = state.mobileDetections.slice(0, 500);
      if (typeof persistDetection === "function") await persistDetection(item);
    }
    return res.json({ ok: true, detection: duplicate || item });
  });

  app.get("/api/channels/metrics", async (_req, res) => {
    try {
      const channels = typeof getAuthorizedChannels === "function" ? await getAuthorizedChannels() : [];
      return res.json({
        ok: true,
        channels: (Array.isArray(channels) ? channels : []).map((channel) => ({
          id: String(channel.id || channel.jid || ""),
          name: String(channel.name || channel.subject || "Authorized channel"),
          authorized: channel.authorized !== false,
          followers: Number.isFinite(channel.followers) ? channel.followers : null,
          checkedAt: channel.checkedAt || Date.now(),
        })),
      });
    } catch (_error) {
      return res.status(503).json({ ok: false, error: "Channel metrics are temporarily unavailable" });
    }
  });
}

module.exports = { mountMobileRoutes };
