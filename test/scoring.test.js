/**
 * scoring.test.js — §5.2/§5.3 fusion (node:test, zero runtime deps).
 *
 * Covers:
 *   - exact fusion math: round(0.45*heuristicScore + 0.55*llmScore)
 *   - every verdict-band boundary (24/25/49/50/74/75/100)
 *   - §5.3 escalation override (ADVANCE_FEE_REQUEST / OFF_PLATFORM_PAYMENT_ONLY
 *     high-severity redFlags floor the verdict at Suspicious regardless of
 *     the numeric score)
 *   - heuristic-only fallback (llmVerdict absent → score = heuristicScore,
 *     confidence "low")
 *   - notAListing passthrough (distinct NoAnalysis marker, NO fusion)
 *   - exported constants pinned to the plan's exact values
 *   - source-level zero-network + zero-chrome guarantees
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fuse,
  FUSION_WEIGHTS,
  ESCALATION_RED_FLAG_IDS,
  ESCALATION_FLOOR_VERDICT,
  hasEscalationTrigger,
} from "../src/scoring/fuse.js";
import { LISTING_VERDICT_BANDS, verdictForScore } from "../src/shared/constants.js";

/** @param {object} overrides @returns {import("../src/shared/types.js").HeuristicSignals} */
function makeHeuristics(overrides = {}) {
  return {
    priceAnomaly: { triggered: false, severity: "none", ratioVsCategoryTypical: null, note: "" },
    sellerAge: { triggered: false, memberSinceRaw: null, itemsListed: null },
    photoSignals: { count: 0, triggered: false, severity: "none" },
    contactChannelLeak: { triggered: false, matches: [] },
    urgencyLanguage: { triggered: false, matchedPhrases: [] },
    advanceFeeLanguage: { triggered: false, matchedPhrases: [] },
    offPlatformPaymentLanguage: { triggered: false, matchedPhrases: [] },
    heuristicScore: 0,
    computedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** @param {object} overrides @returns {Record<string, unknown>} valid §4.5 verdict */
function makeVerdict(overrides = {}) {
  return {
    llmScore: 0,
    notAListing: false,
    redFlags: [],
    summary: "",
    checklistAdditions: [],
    visionNotes: [],
    ...overrides,
  };
}

const redFlag = (id, severity) => ({ id, label: id, severity, explanation: "test flag" });

// ─── §5.2 exact fusion math ─────────────────────────────────────────────────

test("§5.2 exact fusion: heuristic 70 + llm 40 -> round(53.5) = 54", () => {
  const result = fuse(
    makeHeuristics({ heuristicScore: 70 }),
    makeVerdict({ llmScore: 40 }),
  );
  assert.equal(result.score, 54);
  assert.equal(result.source, "fused");
  assert.equal(result.confidence, "high");
  assert.equal(result.escalated, false);
  assert.equal(result.verdict, "Suspicious"); // 54 ∈ 50–74
});

test("§5.2 weights: h=100,l=0 -> 45 (Review); h=0,l=100 -> 55 (Suspicious)", () => {
  const hOnly = fuse(makeHeuristics({ heuristicScore: 100 }), makeVerdict({ llmScore: 0 }));
  assert.equal(hOnly.score, 45);
  assert.equal(hOnly.verdict, "Review");

  const lOnly = fuse(makeHeuristics({ heuristicScore: 0 }), makeVerdict({ llmScore: 100 }));
  assert.equal(lOnly.score, 55);
  assert.equal(lOnly.verdict, "Suspicious");
});

test("FUSION_WEIGHTS match §5.2 verbatim (0.45 heuristic / 0.55 llm)", () => {
  assert.deepEqual(FUSION_WEIGHTS, { heuristic: 0.45, llm: 0.55 });
});

// ─── §5.3 verdict-band boundaries ───────────────────────────────────────────

test("§5.3 band boundaries: 24/25/49/50/74/75/100 -> exact verdicts", () => {
  const cases = [
    [24, "Safe"],
    [25, "Review"],
    [49, "Review"],
    [50, "Suspicious"],
    [74, "Suspicious"],
    [75, "High-Risk"],
    [100, "High-Risk"],
  ];
  for (const [score, expected] of cases) {
    // heuristicScore === llmScore === score → fusedScore === score exactly.
    const result = fuse(
      makeHeuristics({ heuristicScore: score }),
      makeVerdict({ llmScore: score }),
    );
    assert.equal(result.score, score, `fused score for ${score}`);
    assert.equal(result.verdict, expected, `verdict for score ${score}`);
    assert.equal(result.source, "fused");
  }
});

test("fused bands agree with the shared LISTING_VERDICT_BANDS table (§5.3)", () => {
  assert.deepEqual(
    LISTING_VERDICT_BANDS.map((b) => b.verdict),
    ["Safe", "Review", "Suspicious", "High-Risk"],
  );
  for (const band of LISTING_VERDICT_BANDS) {
    // h === l === min lands exactly on the band's inclusive lower bound.
    assert.equal(verdictForScore(band.min), band.verdict, `min ${band.min}`);
    assert.equal(verdictForScore(band.max), band.verdict, `max ${band.max}`);
  }
});

// ─── §5.3 escalation override ────────────────────────────────────────────────

test("§5.3 escalation: well-presented listing (score 20) with ADVANCE_FEE_REQUEST high -> Suspicious", () => {
  // h=0, l=36 → round(19.8) = 20 → Safe band numerically.
  const result = fuse(
    makeHeuristics({ heuristicScore: 0 }),
    makeVerdict({ llmScore: 36, redFlags: [redFlag("ADVANCE_FEE_REQUEST", "high")] }),
  );
  assert.equal(result.score, 20); // numeric score is NOT floored — only the verdict
  assert.equal(result.verdict, "Suspicious"); // floored to Suspicious
  assert.equal(result.escalated, true);
  assert.equal(result.source, "fused");
});

test("§5.3 escalation: OFF_PLATFORM_PAYMENT_ONLY high also floors to Suspicious", () => {
  const result = fuse(
    makeHeuristics({ heuristicScore: 24 }),
    makeVerdict({
      llmScore: 24,
      redFlags: [redFlag("OFF_PLATFORM_PAYMENT_ONLY", "high")],
    }),
  );
  assert.equal(result.score, 24); // Safe band numerically…
  assert.equal(result.verdict, "Suspicious"); // …overridden to Suspicious
  assert.equal(result.escalated, true);
});

test("§5.3 escalation never lowers an already-≥Suspicious verdict", () => {
  const atFloor = fuse(
    makeHeuristics({ heuristicScore: 55 }),
    makeVerdict({
      llmScore: 55,
      redFlags: [redFlag("ADVANCE_FEE_REQUEST", "high")],
    }),
  );
  assert.equal(atFloor.verdict, "Suspicious");
  assert.equal(atFloor.escalated, true);

  const highRisk = fuse(
    makeHeuristics({ heuristicScore: 90 }),
    makeVerdict({
      llmScore: 90,
      redFlags: [redFlag("OFF_PLATFORM_PAYMENT_ONLY", "high")],
    }),
  );
  assert.equal(highRisk.verdict, "High-Risk");
  assert.equal(highRisk.escalated, true);
});

test("§5.3 escalation: non-high severity or unrelated ids do NOT escalate", () => {
  const mediumFee = fuse(
    makeHeuristics({ heuristicScore: 10 }),
    makeVerdict({
      llmScore: 10,
      redFlags: [redFlag("ADVANCE_FEE_REQUEST", "medium")],
    }),
  );
  assert.equal(mediumFee.verdict, "Safe");
  assert.equal(mediumFee.escalated, false);

  const unrelatedHigh = fuse(
    makeHeuristics({ heuristicScore: 10 }),
    makeVerdict({
      llmScore: 10,
      redFlags: [redFlag("SCREEN_SHARE_REQUEST", "high")],
    }),
  );
  assert.equal(unrelatedHigh.verdict, "Safe");
  assert.equal(unrelatedHigh.escalated, false);
});

test("escalation ids are case-insensitive (defensive: sloppy lowercase still floors)", () => {
  const result = fuse(
    makeHeuristics({ heuristicScore: 20 }),
    makeVerdict({
      llmScore: 20,
      redFlags: [redFlag("advance_fee_request", "high")],
    }),
  );
  assert.equal(result.verdict, "Suspicious");
  assert.equal(result.escalated, true);
});

test("ESCALATION_RED_FLAG_IDS / ESCALATION_FLOOR_VERDICT match §5.3 verbatim", () => {
  assert.deepEqual(ESCALATION_RED_FLAG_IDS, [
    "ADVANCE_FEE_REQUEST",
    "OFF_PLATFORM_PAYMENT_ONLY",
  ]);
  assert.equal(ESCALATION_FLOOR_VERDICT, "Suspicious");
  assert.ok(LISTING_VERDICT_BANDS.some((b) => b.verdict === ESCALATION_FLOOR_VERDICT));
});

test("hasEscalationTrigger: true only for high-severity targeted ids, never throws", () => {
  assert.equal(hasEscalationTrigger(makeVerdict({ redFlags: [redFlag("ADVANCE_FEE_REQUEST", "high")] })), true);
  assert.equal(hasEscalationTrigger(makeVerdict({ redFlags: [redFlag("OFF_PLATFORM_PAYMENT_ONLY", "high")] })), true);
  assert.equal(hasEscalationTrigger(makeVerdict({ redFlags: [redFlag("ADVANCE_FEE_REQUEST", "low")] })), false);
  assert.equal(hasEscalationTrigger(makeVerdict({ redFlags: [redFlag("OTHER", "high")] })), false);
  assert.equal(hasEscalationTrigger(makeVerdict()), false);
  assert.equal(hasEscalationTrigger(null), false);
  assert.equal(hasEscalationTrigger("nonsense"), false);
  assert.equal(hasEscalationTrigger({ redFlags: "not-an-array" }), false);
  assert.equal(hasEscalationTrigger({ redFlags: [null, 42, { id: "ADVANCE_FEE_REQUEST", severity: "high" }] }), true);
});

// ─── heuristic-only fallback (§5.2 / §6) ────────────────────────────────────

test("heuristic-only fallback: llmVerdict null -> score = heuristicScore, confidence low", () => {
  const result = fuse(makeHeuristics({ heuristicScore: 70 }), null);
  assert.equal(result.score, 70);
  assert.equal(result.verdict, "Suspicious"); // 70 ∈ 50–74
  assert.equal(result.confidence, "low");
  assert.equal(result.source, "heuristic-only");
  assert.equal(result.escalated, false);
});

test("heuristic-only fallback: undefined / garbage llmVerdict behave like null", () => {
  for (const garbage of [undefined, {}, [], "nonsense", 42, { redFlags: 1 }]) {
    const result = fuse(makeHeuristics({ heuristicScore: 25 }), garbage);
    assert.equal(result.source, "heuristic-only", JSON.stringify(garbage));
    assert.equal(result.score, 25);
    assert.equal(result.verdict, "Review");
    assert.equal(result.confidence, "low");
  }
});

test("heuristic-only fallback: heuristics null/garbage degrade to score 0, never throw", () => {
  const result = fuse(null, null);
  assert.equal(result.source, "heuristic-only");
  assert.equal(result.score, 0);
  assert.equal(result.verdict, "Safe");
  assert.equal(result.confidence, "low");

  assert.equal(fuse({}, null).score, 0);
  assert.equal(fuse({ heuristicScore: -5 }, null).score, 0); // clamped to 0
  assert.equal(fuse({ heuristicScore: 200 }, null).score, 100); // clamped to 100
});

// ─── notAListing passthrough (§5.2) ─────────────────────────────────────────

test("notAListing passthrough: distinct NoAnalysis marker, NO fusion, no score", () => {
  const result = fuse(
    makeHeuristics({ heuristicScore: 90 }),
    makeVerdict({ llmScore: 90, notAListing: true }),
  );
  assert.equal(result.source, "notAListing");
  assert.equal(result.score, null);
  assert.equal(result.verdict, "NoAnalysis");
  assert.equal(result.confidence, "low");
  assert.equal(result.escalated, false);
});

test("notAListing passthrough wins even with escalation triggers present", () => {
  const result = fuse(
    makeHeuristics({ heuristicScore: 0 }),
    makeVerdict({
      llmScore: 100,
      notAListing: true,
      redFlags: [redFlag("ADVANCE_FEE_REQUEST", "high")],
    }),
  );
  assert.equal(result.source, "notAListing");
  assert.equal(result.score, null);
  assert.equal(result.verdict, "NoAnalysis");
  assert.equal(result.escalated, false);
});

test("notAListing absent/false on a valid verdict still fuses normally", () => {
  const noKey = fuse(makeHeuristics({ heuristicScore: 50 }), makeVerdict({ llmScore: 50, notAListing: false }));
  assert.equal(noKey.source, "fused");
  assert.equal(noKey.score, 50);

  const absent = fuse(makeHeuristics({ heuristicScore: 50 }), makeVerdict({ llmScore: 50 }));
  assert.equal(absent.source, "fused");
});

// ─── source-level guarantees ────────────────────────────────────────────────

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("fuse.js is pure: zero network surface, zero chrome/storage references", () => {
  const file = new URL("../src/scoring/fuse.js", import.meta.url);
  const code = stripComments(readFileSync(file, "utf8"));
  assert.doesNotMatch(code, /\bfetch\s*\(/, "must not call fetch()");
  assert.doesNotMatch(code, /XMLHttpRequest/, "must not use XMLHttpRequest");
  assert.doesNotMatch(code, /WebSocket/, "must not use WebSocket");
  assert.doesNotMatch(code, /sendBeacon/, "must not use sendBeacon");
  assert.doesNotMatch(code, /import\s*\(/, "must not use dynamic import");
  assert.doesNotMatch(code, /chrome\./, "must not touch any chrome API");
});
