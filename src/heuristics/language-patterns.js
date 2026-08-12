/**
 * language-patterns.js — phrase lists for the listing-level language signals.
 *
 * Kept separate from signals.js (per PLAN-BACKEND.md §8 file plan) so the
 * phrase lists are independently testable/extendable. These serve the LISTING
 * heuristics (§2.2 / §5.1) and are calibrated against the main flow's
 * false-positive tolerance (§5.4) — note this is intentionally DIFFERENT from
 * `payment-check/payment-scam-patterns.js`, which serves §4.7's Message &
 * Payment Check and deliberately favors false positives. Do not merge the two.
 *
 * Matching is substring-with-word-boundaries (case-insensitive), so short
 * tokens like "upi" do not false-match inside unrelated words ("kupi", "rupiah").
 */

/** Urgency pressure language ("today only", "first come", …). Weight 10 (§5.1). */
export const URGENCY_LANGUAGE_PATTERNS = [
  // English
  "urgent sale",
  "urgent selling",
  "today only",
  "only today",
  "last day",
  "last chance",
  "first come",
  "first come first serve",
  "must sell",
  "quick sale",
  "clearance sale",
  "sell fast",
  "price negotiable only today",
  // Hinglish
  "aaj hi",
  "sirf aaj",
  "jaldi karo",
  "jaldi bechna",
  "jaldi sell",
  "turant",
  "le lo",
];

/** Advance-fee / booking-fee / courier-fee language. Weight 20 (§5.1). */
export const ADVANCE_FEE_LANGUAGE_PATTERNS = [
  // English — compound phrases only; a bare "advance" is too common to be a signal.
  "booking amount",
  "token advance",
  "token amount",
  "token money",
  "advance amount",
  "advance payment",
  "advance pay",
  "pay advance",
  "advance via",
  "advance to",
  "courier fee",
  "courier charge",
  "shipping fee",
  "delivery fee",
  "delivery charge",
  "gst fee",
  "gst charge",
  "registration fee",
  "insurance fee",
  "processing fee",
  "transfer fee",
  "refundable deposit",
  // Hinglish
  "advance do",
  "token do",
  "pehle paisa",
  "paisa pehle",
  "pehle bhejo",
  "booking karo",
];

/**
 * Off-platform payment language ("pay via UPI only", "gpay", …). Weight 20
 * (§5.1). App names ("upi", "gpay", "phonepe") are deliberately included bare
 * per §2.2's example list, at the cost of some false positives on legit
 * "UPI accepted" listings — flagged as a known v1 calibration tradeoff.
 */
export const OFF_PLATFORM_PAYMENT_LANGUAGE_PATTERNS = [
  // English
  "upi",
  "gpay",
  "google pay",
  "phonepe",
  "paytm",
  "pay first",
  "payment first",
  "pay upfront",
  "only upi",
  "upi only",
  "upi payment",
  "upi transfer",
  "advance via",
  "bank transfer",
  "neft",
  "imps",
  "cash deposit",
  // Hinglish
  "gpay karo",
  "phonepe karo",
  "upi se bhejo",
  "pehle pay",
];

/**
 * Grouped export — keys match the HeuristicSignals field names so signals.js
 * can iterate without an extra mapping layer.
 */
export const LANGUAGE_PATTERN_GROUPS = {
  urgencyLanguage: URGENCY_LANGUAGE_PATTERNS,
  advanceFeeLanguage: ADVANCE_FEE_LANGUAGE_PATTERNS,
  offPlatformPaymentLanguage: OFF_PLATFORM_PAYMENT_LANGUAGE_PATTERNS,
};

/**
 * Escape a string for use inside a RegExp.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a word-boundary RegExp for a phrase. Wrapping in `\b` keeps short
 * tokens ("upi") from matching inside unrelated words.
 *
 * @param {string} phrase
 * @returns {RegExp}
 */
function phraseToRegExp(phrase) {
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i");
}

/**
 * Match a piece of text against a phrase list. Returns the distinct matched
 * phrases in list order. Case-insensitive; word-boundary aware. Never throws
 * on empty/null text — returns [].
 *
 * @param {string | null | undefined} text
 * @param {readonly string[]} patterns
 * @returns {string[]}
 */
export function matchTextAgainstPatterns(text, patterns) {
  if (typeof text !== "string" || text.length === 0) return [];
  const matched = [];
  for (const phrase of patterns) {
    if (phraseToRegExp(phrase).test(text)) matched.push(phrase);
  }
  return matched;
}
