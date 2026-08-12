/**
 * constants.js — shared constants (PLAN-BACKEND.md §4.7, §5.3, §8 file plan).
 *
 * Ships: the Message & Payment Check anchor fact, the reporting resources,
 * and the §5.3 listing-verdict band thresholds. Plain data + one pure helper —
 * zero runtime deps, safe to import from any extension context.
 */

/**
 * The anchor fact for Message & Payment Check (§4.7). Always populated on
 * EVERY PaymentCheckReport verdict — even `NoRedFlagsFound`, even in a total
 * LLM-failure/offline state — because it is the single fact that defeats the
 * large majority of real UPI/QR fraud scripts (§-1). It is hardcoded here in
 * the extension itself, never LLM-generated, and must never depend on a
 * network call succeeding to reach the user.
 *
 * VERBATIM from PLAN-BACKEND.md §4.7 — do not reword.
 *
 * @type {string}
 */
export const CORE_FACT =
  "A QR code or payment request can only ever be used to send money, never to receive it. " +
  "If anyone — no matter how convincing — asks you to scan something or enter your PIN/OTP to " +
  "'receive' a payment, that is always false, with no exceptions.";

/**
 * Reporting resources shown on High-Risk listings and on payment-check
 * warnings (PLAN-BACKEND.md §2.3 / §-1). Values are the exact strings the
 * plan names: the 1930 helpline and cybercrime.gov.in. Label/value pairs match
 * the RiskReport.reportingResources shape.
 *
 * @typedef {object} ReportingResource
 * @property {string} label
 * @property {string} value
 */

/**
 * @type {ReportingResource[]}
 */
export const REPORTING_RESOURCES = [
  { label: "National Cyber Crime Reporting Portal", value: "cybercrime.gov.in" },
  { label: "Cyber Crime Helpline (toll-free)", value: "1930" },
];

/**
 * Listing-verdict band thresholds (PLAN-BACKEND.md §5.3). Inclusive ranges on
 * the 0-100 fused score. The popup color/tone mapping is a frontend concern
 * and lives in PLAN-FRONTEND.md, not here.
 *
 * @typedef {object} VerdictBand
 * @property {number} min     Inclusive lower bound.
 * @property {number} max     Inclusive upper bound.
 * @property {"Safe" | "Review" | "Suspicious" | "High-Risk"} verdict
 */

/**
 * @type {VerdictBand[]}
 */
export const LISTING_VERDICT_BANDS = [
  { min: 0, max: 24, verdict: "Safe" },
  { min: 25, max: 49, verdict: "Review" },
  { min: 50, max: 74, verdict: "Suspicious" },
  { min: 75, max: 100, verdict: "High-Risk" },
];

/**
 * Map a fused 0-100 score to its §5.3 verdict band. Rounds to the nearest
 * integer first (the fusion in §5.2 already rounds, this is defensive against
 * float drift). Returns null for non-finite/out-of-range input — callers must
 * treat null as "no verdict", never as "Safe".
 *
 * @param {number | null | undefined} score
 * @returns {"Safe" | "Review" | "Suspicious" | "High-Risk" | null}
 */
export function verdictForScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  const n = Math.round(score);
  for (const band of LISTING_VERDICT_BANDS) {
    if (n >= band.min && n <= band.max) return band.verdict;
  }
  return null;
}
