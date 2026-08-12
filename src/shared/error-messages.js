/**
 * error-messages.js — the §6 error-matrix message + retry table
 * (PLAN-BACKEND.md §6, PLAN-FRONTEND.md §2.7).
 *
 * Every row of the §6 matrix is mapped here to (a) the EXACT user-facing
 * message copy the plan specifies (§6 column 3), (b) its retry strategy
 * (§6 column 4), and (c) the contextual action the popup should offer
 * (frontend §2.7: "Open Settings" for key errors, "Try again" for
 * timeout/5xx, "Switch provider" for OpenRouter rotation).
 *
 * WHY THIS MODULE EXISTS: PLAN-FRONTEND.md §2.7 rules that "the frontend
 * does not author error copy per error type; it renders what the backend
 * sends" — so the service worker computes the final message string from
 * this table (substituting the provider label via `renderMessage`) and the
 * popup only ever displays the string it receives. One source of truth, no
 * wording drift between docs.
 *
 * The provider-layer (client.js) owns its own short message constants for
 * the §3.6/§6 provider contract; this table is the canonical *popup-facing*
 * copy for §6 column 3. Where the two overlap (e.g. 5xx, 429, OpenRouter
 * rotation, parse-failure) the wording matches §6 verbatim.
 *
 * Pure data module — zero runtime deps, safe to import from any context.
 */

/**
 * @typedef {"error" | "noKey" | "noListing" | "noAnalysis" | "heuristic-only"} MessageKind
 *   The popup-state family a §6 row maps to:
 *     - "error"          → frontend §2.7 Error state (heuristic block stays visible).
 *     - "noKey"          → frontend §2.8 NoKey state.
 *     - "noListing"      → frontend §2.6 NoListing state (pre-fetch).
 *     - "noAnalysis"     → frontend §2.5 NoAnalysis state (notAListing passthrough).
 *     - "heuristic-only" → NOT a popup state — the SW builds a heuristic-only
 *                          RiskReport (confidence "low") and ships a report.
 *
 * @typedef {"openSettings" | "tryAgain" | "switchProvider" | null} ErrorAction
 *   Contextual action for the popup's error card (frontend §2.7).
 */

/**
 * @typedef {object} ErrorMessageEntry
 * @property {MessageKind} kind
 * @property {string} message        §6 col-3 copy; may contain `{provider}`.
 * @property {string} retry          §6 col-4 strategy, human-readable.
 * @property {ErrorAction} action    Popup contextual action.
 */

/**
 * The full §6 table, keyed by the service worker's `errorCode` (which
 * mirrors the provider layer's error codes from client.js).
 *
 * @type {Record<string, ErrorMessageEntry>}
 */
export const ERROR_MESSAGES = {
  // §6 row "No API key set" — NoKey state (frontend §2.8); heuristics still
  // delivered in the result so the popup can show the instant signal.
  no_key: {
    kind: "noKey",
    message: "No API key set for this provider. Open Settings to add one.",
    retry: "none — user action required",
    action: "openSettings",
  },

  // §6 row "Invalid/rejected key".
  key_rejected: {
    kind: "error",
    message: "Your API key was rejected by {provider}. Check it in Settings.",
    retry: "none — user action required",
    action: "openSettings",
  },

  // §6 row "Timeout" — copy VERBATIM from the matrix (client.js's shorter
  // variant stays in the provider layer; the popup gets this exact line).
  timeout: {
    kind: "error",
    message:
      "{provider} didn't respond in time. Your heuristic pre-check is above — you can try again or switch providers.",
    retry:
      "1 automatic retry ONLY if elapsed time was <50% of timeoutMs; otherwise surface immediately",
    action: "tryAgain",
  },

  // §6 row "HTTP 429 (rate limited)" — NO auto-retry.
  rate_limited: {
    kind: "error",
    message:
      "{provider} rate-limited this request. Free tiers reset over time — try again shortly, or switch providers in Settings.",
    retry: "no auto-retry (respect the provider's rate limit)",
    action: "tryAgain",
  },

  // §6 row "HTTP 5xx" — exactly one retry with ~1.5s backoff.
  server_error: {
    kind: "error",
    message: "{provider} is having trouble on their end right now.",
    retry: "1 automatic retry with ~1.5s backoff",
    action: "tryAgain",
  },

  // §6 row "Network failure" (fetch rejected, not a timeout).
  network_error: {
    kind: "error",
    message:
      "Couldn't reach {provider}. Check your internet connection or try a different provider.",
    retry: "none automatic",
    action: "tryAgain",
  },

  // §6 row "OpenRouter model rotation" — the SPECIFIC message, never a
  // generic error, and never silent model substitution.
  model_not_found: {
    kind: "error",
    message:
      "The free model ScamGuard uses on OpenRouter isn't available right now. Try 'openrouter/free' (experimental) in Settings, or switch providers.",
    retry:
      "none automatic — surfaces to the user; silently substituting a different model changes analysis quality unpredictably",
    action: "switchProvider",
  },

  // §6 catch-all for unexpected HTTP statuses (client.js carries the status
  // detail in its own message, which the SW passes through for this row).
  request_failed: {
    kind: "error",
    message: "{provider} returned HTTP {status}.",
    retry: "none",
    action: "tryAgain",
  },

  // No model configured (openai/anthropic/ollama/custom presets without a
  // user-set model — §6-adjacent; surfaced like a key error).
  no_model: {
    kind: "error",
    message: "No model configured for this provider. Set one in Settings.",
    retry: "none — user action required",
    action: "openSettings",
  },

  // §6 rows "Malformed JSON" / "Schema mismatch" / "Repair retry also fails"
  // terminal path → heuristic-only RiskReport (confidence "low"), NOT an
  // error popup state. Message is the §6 note, rendered in the report.
  parse_failed: {
    kind: "heuristic-only",
    message: "The AI's response couldn't be read reliably — showing rule-based check only.",
    retry: "1 repair retry, then heuristic-only fallback — no further loops",
    action: null,
  },

  // §6 row "Non-listing page" — checked BEFORE any network call; popup state
  // NoListing (frontend §2.6, same copy so both docs never drift).
  no_listing: {
    kind: "noListing",
    message:
      "Couldn't read this page reliably. If you're on an OLX or Quikr listing, try refreshing — otherwise this page may not be a listing ScamGuard recognizes yet.",
    retry: "none — checked before any network call",
    action: null,
  },

  // §5.2 / frontend §2.5 NoAnalysis state (LLM returned notAListing: true).
  no_analysis: {
    kind: "noAnalysis",
    message:
      "This doesn't look like a listing page. ScamGuard works on individual OLX or Quikr listing pages — try opening a specific item.",
    retry: "none — not an error",
    action: null,
  },

  // §6 row "Service worker restarted mid-analysis" — the popup re-checks
  // chrome.storage.session on open and shows this copy instead of hanging.
  interrupted: {
    kind: "error",
    message: "Analysis may have been interrupted — try again",
    retry: "none — service worker restart; popup re-checks chrome.storage.session",
    action: "tryAgain",
  },
};

/**
 * The §6 row "Message & Payment Check: LLM pass fails/times out" note —
 * rendered as a small annotation under the pattern-match result + coreFact,
 * which are the final result in that path (additive polish, never a
 * dependency — §4.7).
 *
 * @type {string}
 */
export const PAYMENT_LLM_UNAVAILABLE_MESSAGE =
  "AI review unavailable right now — showing pattern-match result only.";

/**
 * Look up a §6 entry by error code. Returns `undefined` for unknown codes so
 * the service worker can fall back to the provider layer's own message.
 *
 * @param {string | null | undefined} errorCode
 * @returns {ErrorMessageEntry | undefined}
 */
export function getErrorMessage(errorCode) {
  if (typeof errorCode !== "string" || errorCode.length === 0) return undefined;
  return ERROR_MESSAGES[errorCode];
}

/**
 * Substitute `{provider}` / `{status}` placeholders in a §6 message template.
 * Unknown placeholders are left untouched; missing vars render as "".
 *
 * @param {string} template
 * @param {{ provider?: string | null; status?: string | number | null }} [vars]
 * @returns {string}
 */
export function renderMessage(template, vars = {}) {
  if (typeof template !== "string") return "";
  const provider = vars.provider ?? "";
  const status = vars.status ?? "";
  return template.replace(/\{provider\}/g, String(provider)).replace(/\{status\}/g, String(status));
}
