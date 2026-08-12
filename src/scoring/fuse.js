/**
 * fuse.js — risk-score fusion (PLAN-BACKEND.md §5.2, §5.3, §8 file plan).
 *
 * `fuse(heuristics, llmVerdict)` combines the deterministic heuristic score
 * (which always exists) with the LLM's independent verdict into a single
 * 0-100 fused score and a §5.3 verdict band:
 *
 *   fusedScore = round(0.45 * heuristicScore + 0.55 * llmScore)      (§5.2)
 *
 * Pure synchronous, zero network, never throws — it returns a fully-shaped
 * result for any input, including null/garbage, so the service worker can
 * call it unconditionally in the §1.1 step-7 path.
 *
 * Returned shapes (discriminated on `source`):
 *   - { source: "fused",          ... }  LLM verdict present + not a
 *                                         non-listing → §5.2 fusion.
 *   - { source: "heuristic-only", ... }  llmVerdict absent/null → score is
 *                                         heuristicScore, confidence "low"
 *                                         (§5.2 failure path, §6).
 *   - { source: "notAListing",    ... }  llmVerdict.notAListing === true →
 *                                         NO fusion, distinct marker
 *                                         (§5.2 "If notAListing: true"), never
 *                                         a meaningless number.
 *
 * §5.3 escalation override: regardless of the numeric band, a high-severity
 * redFlag tagged `ADVANCE_FEE_REQUEST` or `OFF_PLATFORM_PAYMENT_ONLY` floors
 * the verdict at "Suspicious". Only the verdict is floored — the numeric
 * score is left at the fusion result, because the plan floors the *verdict*,
 * not the score.
 */

import { verdictForScore } from "../shared/constants.js";

// ─── §5.2 fusion weights (single source of truth) ───────────────────────────

/** @type {{ heuristic: number; llm: number }} */
export const FUSION_WEIGHTS = { heuristic: 0.45, llm: 0.55 };

/** §5.3 escalation-override red-flag ids — VERBATIM from the plan. @type {readonly string[]} */
export const ESCALATION_RED_FLAG_IDS = [
  "ADVANCE_FEE_REQUEST",
  "OFF_PLATFORM_PAYMENT_ONLY",
];

/** §5.3 escalation floor verdict. @type {"Suspicious"} */
export const ESCALATION_FLOOR_VERDICT = "Suspicious";

/**
 * @typedef {"Safe" | "Review" | "Suspicious" | "High-Risk"} ListingVerdict
 * @typedef {"fused" | "heuristic-only" | "notAListing"} FusionSource
 * @typedef {"high" | "low"} FusionConfidence
 */

/**
 * @typedef {object} FusionResult  discriminated on `source` (§5.2).
 * @property {FusionSource} source
 * @property {number | null} score   0-100 when a score exists; null ONLY for
 *                                   `source === "notAListing"` (no fusion).
 * @property {ListingVerdict | "NoAnalysis"} verdict
 *                                   "NoAnalysis" ONLY for notAListing.
 * @property {FusionConfidence} confidence
 *                                   "high" when the LLM verdict fused;
 *                                   "low" on heuristic-only and notAListing.
 * @property {boolean} escalated     true when §5.3's override raised the verdict.
 */

const SEVERITY_ORDER = ["Safe", "Review", "Suspicious", "High-Risk"];

/**
 * Clamp a numeric score to the 0-100 verdict range. Returns 0 for any
 * non-finite value so the band logic below always sees a usable number.
 *
 * @param {unknown} value
 * @returns {number}
 */
function clampScore(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Does the LLM verdict carry a §5.3 escalation trigger? A redFlag triggers
 * only when its `id` is exactly `ADVANCE_FEE_REQUEST` or
 * `OFF_PLATFORM_PAYMENT_ONLY` AND its `severity` is "high". Id comparison is
 * case-insensitive (defensive — the schema says UPPER_SNAKE_CASE, but a
 * lowercased id from a sloppy model shouldn't silently lose the override).
 *
 * @param {unknown} llmVerdict
 * @returns {boolean}
 */
export function hasEscalationTrigger(llmVerdict) {
  if (!llmVerdict || typeof llmVerdict !== "object") return false;
  const redFlags = llmVerdict.redFlags;
  if (!Array.isArray(redFlags)) return false;
  for (const flag of redFlags) {
    if (!flag || typeof flag !== "object" || Array.isArray(flag)) continue;
    const f = /** @type {Record<string, unknown>} */ (flag);
    if (f.severity !== "high") continue;
    const id = typeof f.id === "string" ? f.id.toUpperCase() : "";
    if (ESCALATION_RED_FLAG_IDS.includes(id)) return true;
  }
  return false;
}

/**
 * Apply the §5.3 escalation override to a verdict.
 *
 * @param {ListingVerdict} verdict
 * @param {boolean} escalated
 * @returns {ListingVerdict}
 */
function applyEscalationFloor(verdict, escalated) {
  if (!escalated) return verdict;
  const floorIndex = SEVERITY_ORDER.indexOf(ESCALATION_FLOOR_VERDICT);
  const currentIndex = SEVERITY_ORDER.indexOf(verdict);
  return currentIndex < floorIndex ? ESCALATION_FLOOR_VERDICT : verdict;
}

/**
 * Fuse the deterministic heuristic score with the LLM verdict into the §5.2
 * score + §5.3 verdict. Pure synchronous, never throws.
 *
 * @param {import("../shared/types.js").HeuristicSignals | null | undefined} heuristics
 * @param {Record<string, unknown> | null | undefined} llmVerdict
 *   The validated §4.5 verdict object from the provider layer, or null when
 *   the provider call failed entirely (§6 → heuristic-only fallback).
 * @returns {FusionResult}
 */
export function fuse(heuristics, llmVerdict) {
  const isRecord =
    !!llmVerdict && typeof llmVerdict === "object" && !Array.isArray(llmVerdict);
  const isNotAListing = isRecord && llmVerdict.notAListing === true;

  // §5.2 "If notAListing: true": don't fuse — return a distinct UI state,
  // not a score, so the user is never shown a meaningless number for a page
  // that couldn't actually be analyzed.
  if (isNotAListing) {
    return {
      source: "notAListing",
      score: null,
      verdict: "NoAnalysis",
      confidence: "low",
      escalated: false,
    };
  }

  const heuristicScore = clampScore(heuristics?.heuristicScore);

  // A "verdict" only counts when it carries a usable llmScore. An empty or
  // garbage object (e.g. `{}`, `{ redFlags: 1 }`) is NOT a verdict — a real
  // verdict always arrives here schema-validated with llmScore present, so
  // treating score-less objects as absent keeps the §5.2/§6 failure path
  // honest instead of silently fusing a phantom 0.
  const hasUsableScore = isRecord && typeof llmVerdict.llmScore === "number" && Number.isFinite(llmVerdict.llmScore);

  // §5.2 / §6 failure path: no LLM verdict → the heuristic score stands
  // alone and confidence drops to "low".
  if (!hasUsableScore) {
    const verdict =
      verdictForScore(heuristicScore) ?? ESCALATION_FLOOR_VERDICT;
    return {
      source: "heuristic-only",
      score: heuristicScore,
      verdict,
      confidence: "low",
      escalated: false,
    };
  }

  const llmScore = clampScore(llmVerdict.llmScore);
  const fusedScore = Math.round(
    FUSION_WEIGHTS.heuristic * heuristicScore +
      FUSION_WEIGHTS.llm * llmScore,
  );

  const escalated = hasEscalationTrigger(llmVerdict);
  const baseVerdict =
    verdictForScore(fusedScore) ?? ESCALATION_FLOOR_VERDICT;

  return {
    source: "fused",
    score: fusedScore,
    verdict: applyEscalationFloor(baseVerdict, escalated),
    confidence: "high",
    escalated,
  };
}
