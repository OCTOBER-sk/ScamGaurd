/**
 * prompt.js — listing-analysis prompt construction (PLAN-BACKEND.md §4.1,
 * §4.2, §4.6, §6 repair prompt).
 *
 * Exports:
 *   - `buildSystemPrompt()`  — the §4.1 system prompt, VERBATIM.
 *   - `buildUserPrompt(listing, heuristics)` — the §4.2 wrapper template,
 *     with the §4.6 >2000-char description truncation rule applied.
 *   - `buildRepairPrompt(original)` — the §6 single repair-retry prompt.
 */

/**
 * Maximum description length fed to the model before truncation (§4.6).
 * Keeps Cerebras's ~8,192 token free-tier context cap reachable once
 * system prompt + heuristics + response budget are accounted for.
 */
export const MAX_DESCRIPTION_CHARS = 2000;

/**
 * The system prompt from §4.1 — VERBATIM. Do not reword. The phase-3 spec
 * requires this exact string; `test/providers.test.js` asserts it equals the
 * source string.
 *
 * @returns {string}
 */
export function buildSystemPrompt() {
  return `You are a scam-detection analyst embedded in a browser extension called ScamGuard. You analyze
second-hand marketplace listings from Indian classifieds sites (OLX, Quikr) and output a
structured risk assessment. You are not a general chatbot — you have exactly one job.

You will be given: (1) listing data scraped from the page, (2) a set of pre-computed heuristic
signals, and optionally (3) listing photos. Weigh these signal categories:

- PRICE: Is the price implausibly low for the stated item/condition? Sellers legitimately
  discount for quick sale, damage, or urgency — a low price alone is weak evidence. Combine it
  with other signals before treating it as strong.
- SELLER SIGNALS: New accounts, very few items listed, and no verification are weak-to-moderate
  signals, not proof. Long-established accounts with many listings are reassuring but not
  conclusive (compromised accounts exist).
- PHOTOS: If images are provided, look for signs of AI generation (unnaturally perfect lighting,
  subtle anatomical/geometric inconsistencies, repeated background artifacts, mismatched
  shadows), stock/catalog photos reused for a "used" item, or photos that don't match the
  stated condition/model. State your confidence honestly — reverse-image-style AI-generation
  detection from a single image is not reliable; describe what you observe, don't overclaim
  certainty.
- LANGUAGE: Urgency pressure ("today only," "first come first serve"), requests to move off
  the platform to WhatsApp/Telegram before any vetting, advance-payment/booking-fee/token
  language, "pay via UPI/GPay only," refusal to negotiate combined with refusal to meet in
  person, and courier/insurance/GST "fee" framing are the strongest textual scam indicators for
  this market.
- WHAT THIS ANALYSIS CANNOT SEE: you have no way to verify the seller's real identity, whether
  the item physically exists, or what happens in a private chat. State this limitation in your
  summary when the risk is genuinely ambiguous — do not manufacture false certainty in either
  direction.

Respond with ONLY a single JSON object matching this exact schema — no prose before or after,
no markdown code fences:

{
  "llmScore": <integer 0-100, your independent risk estimate>,
  "redFlags": [ { "id": "<UPPER_SNAKE_CASE>", "label": "<short label>", "severity":
    "low"|"medium"|"high", "explanation": "<1-2 plain sentences>" } ],
  "summary": "<2-4 sentences, calm and factual, no alarmism>",
  "checklistAdditions": ["<any listing-specific safe-buying advice beyond the standard
    checklist>"],
  "visionNotes": ["<only if photos were provided; empty array otherwise>"]
}

If the input does not look like a real marketplace listing (e.g. it's empty, it's a search
results page, or the text is unrelated to a for-sale item), respond with:
{"llmScore": 0, "redFlags": [], "summary": "This does not appear to be a listing page.",
"checklistAdditions": [], "visionNotes": [], "notAListing": true}

Never include personal opinions about the seller as a person, never accuse anyone of a crime —
frame everything as "this listing shows patterns associated with X" not "this seller is
scamming you." Keep the tone calm and factual; the reader may be anxious about losing money.`;
}

/**
 * Render a value as the wrapper's "(n/a)" placeholder when it's missing.
 * Preserves real 0/false values (e.g. photo count 0 must render as "0").
 *
 * @param {unknown} value
 * @returns {string}
 */
function render(value) {
  if (value === null || value === undefined || value === "") return "(n/a)";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * Render a matched-phrases array for the wrapper ("a, b, c" or "(none)").
 *
 * @param {unknown} value
 * @returns {string}
 */
function renderList(value) {
  if (Array.isArray(value) && value.length > 0) {
    return value.map((v) => String(v)).join(", ");
  }
  return "(none)";
}

/**
 * Build the §4.2 user-prompt wrapper. Null-safe: any missing listing or
 * heuristic field renders as "(n/a)" rather than throwing. Descriptions
 * longer than `MAX_DESCRIPTION_CHARS` are truncated with the §4.6 note.
 *
 * @param {import("../shared/types.js").Listing | null | undefined} listing
 * @param {import("../shared/types.js").HeuristicSignals | null | undefined} heuristics
 * @returns {string}
 */
export function buildUserPrompt(listing, heuristics) {
  const l = listing ?? {};
  const price = l.price ?? {};
  const h = heuristics ?? {};
  const pa = h.priceAnomaly ?? {};
  const seller = h.sellerAge ?? {};
  const photos = h.photoSignals ?? {};
  const leak = h.contactChannelLeak ?? {};
  const urgency = h.urgencyLanguage ?? {};
  const advance = h.advanceFeeLanguage ?? {};
  const offPlatform = h.offPlatformPaymentLanguage ?? {};

  let description = typeof l.description === "string" ? l.description : "";
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description =
      `${description.slice(0, MAX_DESCRIPTION_CHARS)}\n[description truncated to ${MAX_DESCRIPTION_CHARS} chars]`;
  }

  return `LISTING DATA:
Platform: ${render(l.platform)}
Title: ${render(l.title)}
Price: ${render(price.raw)} (${render(price.currency)})
Description: ${description.length > 0 ? description : "(n/a)"}
Seller: ${render(l.sellerName)} — member since ${render(l.sellerMemberSince)} — ${render(l.sellerItemsListed)} items listed
Location: ${render(l.location)}
Posted: ${render(l.postedAt)}
Photo count: ${render(l.imageCount)}
Extraction confidence: ${render(l.extractionConfidence)}

PRE-COMPUTED HEURISTIC SIGNALS (already calculated, do not recompute — use as context):
- Price anomaly: ${render(pa.triggered)} (${render(pa.severity)}) — ${render(pa.note)}
- New/low-activity seller: ${render(seller.triggered)}
- Low photo count flag: ${render(photos.triggered)}
- Contact-channel leak in description: ${render(leak.triggered)}
- Urgency language matched: ${renderList(urgency.matchedPhrases)}
- Advance-fee language matched: ${renderList(advance.matchedPhrases)}
- Off-platform payment language matched: ${renderList(offPlatform.matchedPhrases)}

Analyze this listing per your instructions and return the JSON object.`;
}

/**
 * The exact repair-retry line from §6 ("Repair-retry prompt").
 *
 * @type {string}
 */
export const REPAIR_PROMPT_LINE =
  "Your previous response was not valid JSON matching the required schema. " +
  "Respond with ONLY the corrected JSON object, nothing else.";

/**
 * Build the §6 repair-retry prompt: the original system + user prompt with
 * the repair line appended. Per §6 this is sent as a FRESH single-turn
 * request (client.js does that), never a multi-turn conversation.
 *
 * @param {{ systemPrompt: string; userPrompt: string } | null | undefined} original
 * @returns {{ systemPrompt: string; userPrompt: string }}
 */
export function buildRepairPrompt(original) {
  const systemPrompt = (original && typeof original.systemPrompt === "string") ? original.systemPrompt : "";
  const userPrompt =
    (original && typeof original.userPrompt === "string" ? original.userPrompt : "")
      .trimEnd();
  return {
    systemPrompt,
    userPrompt: userPrompt.length > 0 ? `${userPrompt}\n\n${REPAIR_PROMPT_LINE}` : REPAIR_PROMPT_LINE,
  };
}
