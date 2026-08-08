/*
 * Message-event normalization (text only).
 *
 * session.js already emits "message" events normalized to
 * { type: "text", text, id } straight from Baileys' messages.upsert
 * handler. This module is kept as a small optional layer in case you want
 * to normalize messages coming from another source later.
 */

function normalizeMessage(input) {
  if (!input || typeof input !== "object") return null;
  if (typeof input.text === "string") {
    return { type: "text", text: input.text, id: input.id || null };
  }
  return null;
}

module.exports = { normalizeMessage };
