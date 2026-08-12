/**
 * parse.js — tolerant JSON extraction from raw provider responses
 * (PLAN-BACKEND.md §4.6, §6 "Malformed JSON from model").
 *
 * Provider models are told to emit a single JSON object, but in practice
 * they occasionally wrap it in markdown fences, prefix it with prose
 * ("here's your analysis:"), or truncate it. `tolerantParse` is the
 * belt-and-braces layer that recovers the object in the common messy cases.
 *
 * Per the §8 file plan and phase-3 spec, `tolerantParse` NEVER throws — it
 * returns `null` on failure so the caller (client.js §6 orchestration) can
 * route into the single repair-retry path instead of crashing.
 */

/**
 * Parse a string as JSON without throwing. Returns the parsed value on
 * success, or `null` on any failure (empty input, non-JSON, malformed).
 * Used by the provider adapters' `parseResponse` implementations to read
 * the envelope body defensively.
 *
 * @param {string} text
 * @returns {unknown | null}
 */
export function safeParseJson(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Recover a JSON object from a raw LLM response string.
 *
 * Strategy (§4.6):
 *  1. Trim whitespace.
 *  2. Strip markdown code fences (``` and ```json) wherever they appear.
 *  3. Take the substring from the FIRST `{` to the LAST `}` — this drops
 *     leading prose ("here's your analysis:") and trailing chatter.
 *  4. JSON.parse the candidate. Return the object on success.
 *
 * Never throws: returns `null` for non-string/empty input, no brace found,
 * or a parse failure — the caller's repair path handles `null`.
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
export function tolerantParse(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text.length === 0) return null;

  text = text.replace(/```(?:json)?/gi, "").trim();

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  const candidate = text.slice(first, last + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return /** @type {Record<string, unknown>} */ (parsed);
    }
    return null;
  } catch {
    return null;
  }
}
