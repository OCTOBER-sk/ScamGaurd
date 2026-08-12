/**
 * match.js — Message & Payment Check core (PLAN-BACKEND.md §-1, §2.5, §4.7).
 *
 * `match(input)` is a PURE SYNCHRONOUS function: zero network, zero I/O,
 * never throws — it returns a fully-populated `PaymentCheckReport` for any
 * input, including null/garbage (mirroring the "heuristics never blocked by
 * network" principle from §1.2). The deterministic pattern pass (§4.7) runs
 * first and alone can produce a `LikelyScam` verdict; the optional `nuance`
 * seam lets the LLM pass (prompt.js) soften/adjust it, but is never a
 * dependency — if it throws or is absent, the pattern result and `coreFact`
 * still render (§4.7, §6 error matrix row "Message & Payment Check: LLM pass
 * fails/times out").
 *
 * Verdict rule (§4.7, per phase-2 spec): the three structural patterns
 * (SCAN_TO_RECEIVE, COLLECT_REQUEST_FRAMED_AS_REFUND, OTP_OR_PIN_REQUEST)
 * alone → LikelyScam; the other three alone → Caution; two+ caution patterns
 * corroborate each other → LikelyScam; nothing → NoRedFlagsFound.
 */

import { CORE_FACT } from "../shared/constants.js";
import {
  matchPaymentScamPatterns,
  PAYMENT_SCAM_PATTERNS,
  STRUCTURAL_PATTERN_IDS,
} from "./payment-scam-patterns.js";

// ─── local typedefs (mirror §2.5 exactly; promotion into shared/types.js is
// ─── a later phase's job — types.js is deliberately untouched here) ─────────

/**
 * @typedef {"LikelyScam" | "Caution" | "NoRedFlagsFound"} PaymentCheckVerdict
 * @typedef {"pastedText" | "describedFlow"} PaymentCheckMode
 * @typedef {"buying" | "selling"} PaymentCheckRole
 */

/**
 * @typedef {object} PaymentCheckInput  §2.5 PaymentCheckInput.
 * @property {PaymentCheckMode} mode
 * @property {string | null} rawText              present for "pastedText".
 * @property {{ role: PaymentCheckRole; wasAskedToScanOrApprove: boolean;
 *              claimedReasonForCode: string | null } | null} guidedAnswers
 *                                               present for "describedFlow".
 * @property {{ listingUrl: string; listingTitle: string } | null} listingContext
 *                                               present when opened from a RiskReport.
 */

/**
 * @typedef {object} MatchedPattern  §2.5 matchedPatterns item.
 * @property {string} id
 * @property {string} label
 * @property {string} explanation
 */

/**
 * @typedef {object} PaymentCheckReport  §2.5 PaymentCheckReport.
 * @property {string} reportId
 * @property {PaymentCheckVerdict} verdict
 * @property {MatchedPattern[]} matchedPatterns
 * @property {string} coreFact                always populated, on every verdict.
 * @property {string} summary
 * @property {string} createdAt
 */

/**
 * @typedef {object} NuanceAdjustments  what the LLM-nuance pass may change.
 * @property {PaymentCheckVerdict} [verdict]
 * @property {string} [summary]
 * @property {MatchedPattern[]} [matchedPatterns]
 */

/**
 * @typedef {(report: PaymentCheckReport, input: PaymentCheckInput) =>
 *   NuanceAdjustments | null | undefined | void} NuanceSeam
 *   Mockable injection seam for the §4.7 LLM pass. In production the service
 *   worker performs the async provider call itself (using prompt.js) and
 *   passes the parsed result back through a closure; tests pass a sync mock.
 */

// ─── deterministic fallback summaries (plain-language, calm — §4.1 tone) ────

const DEFAULT_SUMMARY = {
  LikelyScam:
    "This matches patterns used in marketplace payment fraud. Do not scan anything, do not approve any payment request, and do not share any PIN, OTP, or CVV — no matter what the other person says.",
  Caution:
    "Part of this text resembles a known payment-scam pattern, but not conclusively on its own. Verify who you are dealing with before sending, scanning, approving, or sharing anything.",
  NoRedFlagsFound:
    "No known payment-scam patterns were found in this text. The fact below still applies to any payment step.",
};

/**
 * Map a set of matched pattern ids to a verdict per the rule above.
 *
 * @param {Iterable<string>} patternIds
 * @returns {PaymentCheckVerdict}
 */
export function verdictForPatternIds(patternIds) {
  const ids = new Set(patternIds);
  if (ids.size === 0) return "NoRedFlagsFound";
  for (const structuralId of STRUCTURAL_PATTERN_IDS) {
    if (ids.has(structuralId)) return "LikelyScam";
  }
  // Only caution-tier patterns left. A single one is Caution; two or more
  // corroborate each other (e.g. screenshot + overpayment-refund) and
  // escalate to LikelyScam (§4.7's "FAKE_SCREENSHOT_THEN_QR … the text
  // describing this sequence is itself close to diagnostic").
  return ids.size >= 2 ? "LikelyScam" : "Caution";
}

/**
 * Collect the patterns present in the input, in §4.7 table order. Matches
 * against every text the input carries (rawText for "pastedText", the
 * claimed-reason free text for "describedFlow" — either may be present) and
 * maps `wasAskedToScanOrApprove` to SCAN_TO_RECEIVE (approving/scannning to
 * receive is exactly that mechanic). Never throws; empty input → [].
 *
 * @param {PaymentCheckInput | null | undefined} input
 * @returns {MatchedPattern[]}
 */
function collectPatterns(input) {
  const ids = new Set();

  const rawText = input?.rawText ?? null;
  const reason = input?.guidedAnswers?.claimedReasonForCode ?? null;
  for (const text of [rawText, reason]) {
    if (typeof text === "string" && text.length > 0) {
      for (const matched of matchPaymentScamPatterns(text)) {
        ids.add(matched.id);
      }
    }
  }

  if (input?.guidedAnswers?.wasAskedToScanOrApprove === true) {
    ids.add("SCAN_TO_RECEIVE");
  }

  return PAYMENT_SCAM_PATTERNS.filter((p) => ids.has(p.id)).map((p) => ({
    id: p.id,
    label: p.label,
    explanation: p.explanation,
  }));
}

/**
 * Merge a nuance-pass result into the report. Only valid fields are applied;
 * everything else is left untouched so a partial/malformed LLM response can
 * never blank out required fields (§2.5: coreFact always populated).
 *
 * @param {PaymentCheckReport} report
 * @param {NuanceAdjustments | null | undefined} adjustments
 * @returns {PaymentCheckReport}
 */
function applyAdjustments(report, adjustments) {
  if (!adjustments || typeof adjustments !== "object") return report;
  const { verdict, summary, matchedPatterns } = adjustments;
  if (
    verdict === "LikelyScam" ||
    verdict === "Caution" ||
    verdict === "NoRedFlagsFound"
  ) {
    report.verdict = verdict;
  }
  if (typeof summary === "string" && summary.trim().length > 0) {
    report.summary = summary.trim();
  }
  if (Array.isArray(matchedPatterns)) {
    report.matchedPatterns = matchedPatterns;
  }
  return report;
}

/**
 * Run the Message & Payment Check over a `PaymentCheckInput` and produce a
 * fully-populated `PaymentCheckReport`. Pure synchronous, zero network.
 *
 * The optional `options.nuance` seam is the mockable hook for the §4.7 LLM
 * nuance pass: if supplied, it is called with the deterministic report and
 * the input, and any `{ verdict, summary, matchedPatterns }` it returns are
 * merged over the result. The seam is called inside a try/catch — a throwing
 * seam (or an absent provider, or an offline network) must never take down
 * the pattern result or the `coreFact` (§4.7 / §6).
 *
 * @param {PaymentCheckInput | null | undefined} input
 * @param {{ nuance?: NuanceSeam | null }} [options]
 * @returns {PaymentCheckReport}
 */
export function match(input, options = {}) {
  const matchedPatterns = collectPatterns(input);
  const verdict = verdictForPatternIds(matchedPatterns.map((m) => m.id));

  const report = {
    reportId: crypto.randomUUID(),
    verdict,
    matchedPatterns,
    coreFact: CORE_FACT,
    summary: DEFAULT_SUMMARY[verdict],
    createdAt: new Date().toISOString(),
  };

  const nuance = options && typeof options === "object" ? options.nuance : null;
  if (typeof nuance === "function") {
    try {
      applyAdjustments(report, nuance(report, input));
    } catch {
      // §4.7: the LLM pass is additive polish, never a dependency.
    }
  }

  return report;
}
