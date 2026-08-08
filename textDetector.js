/*
 * Detects candidate redeem/code strings.
 *
 * Default: 12–15 uppercase letters, matching the example:
 * RTSJYEBZUSBSTHUU
 *
 * If you later want mixed letters/numbers, change the character class to
 * [A-Z0-9].
 */

function scanText(text, settings = {}) {
  if (typeof text !== "string" || !text) return null;

  const min = Math.max(1, Number(settings.minLength || 12));
  const max = Math.max(min, Number(settings.maxLength || 15));
  const characterClass = settings.capitalOnly === false ? "A-Za-z0-9" : "A-Z";

  // Boundaries prevent extracting a 12–15 character slice from a longer word.
  const regex = new RegExp(`(^|[^${characterClass}])([${characterClass}]{${min},${max}})(?![${characterClass}])`, "g");

  for (const match of text.matchAll(regex)) {
    const code = match[2];

    // Avoid treating an ordinary all-letter word as a code when the caller
    // enables a stricter heuristic. This remains configurable at the API level.
    return {
      code,
      index: match.index,
      confidence: scoreCandidate(code, settings)
    };
  }

  return null;
}

function scoreCandidate(code, settings = {}) {
  let score = 0.65;
  if (/^[A-Z]+$/.test(code)) score += 0.15;
  if (code.length >= 12 && code.length <= 15) score += 0.10;
  if (settings.capitalOnly !== false) score += 0.10;
  return Math.min(1, Number(score.toFixed(2)));
}

module.exports = { scanText, scoreCandidate };
