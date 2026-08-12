/**
 * payment-check.test.js — Message & Payment Check (node:test, zero runtime deps).
 *
 * Fixture cases per PLAN-BACKEND.md §9.2:
 *   - scan-to-receive → LikelyScam + coreFact populated + zero network
 *   - warning-to-others → mocked LLM-nuance pass softens the verdict
 *   - no-provider configured → LikelyScam + coreFact still render
 *   - clean negotiation text → NoRedFlagsFound, coreFact STILL populated
 *   - guidedAnswers path maps correctly (§2.5 / §4.7)
 * Plus per-pattern coverage (all six ids, EN + Hinglish), the verdict-band
 * rule (structural → LikelyScam; single caution → Caution; corroboration →
 * LikelyScam), source-level zero-network guarantees, and §5.3/§4.7 constants.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { match, verdictForPatternIds } from "../src/payment-check/match.js";
import {
  PAYMENT_SCAM_PATTERNS,
  matchPaymentScamPatterns,
  STRUCTURAL_PATTERN_IDS,
} from "../src/payment-check/payment-scam-patterns.js";
import { NUANCE_SYSTEM_PROMPT, buildNuanceUserPrompt } from "../src/payment-check/prompt.js";
import {
  CORE_FACT,
  REPORTING_RESOURCES,
  LISTING_VERDICT_BANDS,
  verdictForScore,
} from "../src/shared/constants.js";

/** @param {string} text @returns {import("../src/payment-check/match.js").PaymentCheckInput} */
function pasted(text) {
  return {
    mode: "pastedText",
    rawText: text,
    guidedAnswers: null,
    listingContext: null,
  };
}

/** @param {object} overrides @returns {import("../src/payment-check/match.js").PaymentCheckInput} */
function guided(overrides) {
  return {
    mode: "describedFlow",
    rawText: null,
    guidedAnswers: { role: "selling", wasAskedToScanOrApprove: false, claimedReasonForCode: null },
    listingContext: null,
    ...overrides,
  };
}

/** @param {ReturnType<typeof match>} report @returns {string[]} */
function matchedIds(report) {
  return report.matchedPatterns.map((p) => p.id);
}

// ─── §9.2: scan-to-receive ───────────────────────────────────────────────────

test("§9.2 scan-to-receive (EN): LikelyScam, SCAN_TO_RECEIVE, coreFact populated, zero network", () => {
  const report = match(pasted("buyer said just scan this QR to get the payment"));

  assert.equal(report.verdict, "LikelyScam");
  assert.ok(matchedIds(report).includes("SCAN_TO_RECEIVE"), `ids: ${matchedIds(report)}`);
  assert.equal(report.coreFact, CORE_FACT);
  assert.ok(report.coreFact.length > 0, "coreFact must be populated");
  assert.ok(report.summary.length > 0, "summary must be populated (deterministic fallback)");
  assert.equal(typeof report.reportId, "string");
  assert.ok(report.reportId.length > 0);
  assert.match(report.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // Every matchedPatterns item is exactly the §2.5 {id, label, explanation} shape.
  for (const p of report.matchedPatterns) {
    assert.deepEqual(Object.keys(p).sort(), ["explanation", "id", "label"]);
    assert.ok(p.label.length > 0 && p.explanation.length > 0);
  }
});

test("scan-to-receive Hinglish + approve-to-receive variants all map to LikelyScam", () => {
  for (const text of [
    "scan karke paise le lo",
    "scan karo paise receive honge",
    "approve to receive payment",
    "qr scan karo paise aa jayenge",
    "buyer said approve to get paid",
  ]) {
    const report = match(pasted(text));
    assert.equal(report.verdict, "LikelyScam", `expected LikelyScam for: ${text}`);
    assert.ok(matchedIds(report).includes("SCAN_TO_RECEIVE"), `SCAN_TO_RECEIVE missing for: ${text}`);
  }
});

// ─── §9.2: warning-to-others (mocked LLM-nuance pass) ─────────────────────────

test("§9.2 warning-to-others: mocked nuance seam softens the pattern verdict", () => {
  const text = "someone tried to get me to scan a QR to receive money, don't fall for it";

  // Deterministic pass alone flags it (the phrase text matches)...
  const base = match(pasted(text));
  assert.equal(base.verdict, "LikelyScam");
  assert.ok(matchedIds(base).includes("SCAN_TO_RECEIVE"));

  // ...but the §4.7 LLM-nuance pass (mocked here) recognizes it as a warning
  // to others, never something to flag as a live scam instruction.
  const seen = [];
  const final = match(pasted(text), {
    nuance: (report, input) => {
      seen.push({ report, input });
      return {
        verdict: "NoRedFlagsFound",
        summary: "This text warns other people about this scam — it is not an instruction the user should act on.",
        reasoning: "Text describes a past scam attempt, not a live ask.",
      };
    },
  });

  assert.equal(seen.length, 1, "nuance seam must be invoked exactly once");
  assert.equal(seen[0].input.rawText, text, "seam receives the input");
  assert.equal(seen[0].report.coreFact, CORE_FACT, "seam receives the deterministic report incl. coreFact");
  assert.equal(final.verdict, "NoRedFlagsFound", "mocked LLM pass softens the verdict");
  assert.match(final.summary, /warns other people/);
  assert.equal(final.coreFact, CORE_FACT, "coreFact still populated after softening");
});

test("nuance seam is additive polish: throwing/null/partial seams never break the report", () => {
  const input = pasted("scan this qr to get the payment");

  // Throwing seam → deterministic result survives untouched.
  const threw = match(input, {
    nuance: () => {
      throw new Error("provider offline");
    },
  });
  assert.equal(threw.verdict, "LikelyScam");
  assert.equal(threw.coreFact, CORE_FACT);

  // Null-returning seam → unchanged.
  const noop = match(input, { nuance: () => null });
  assert.equal(noop.verdict, "LikelyScam");

  // Partial seam with an invalid verdict → invalid field ignored, rest kept.
  const partial = match(input, {
    nuance: () => ({ verdict: "NotARealVerdict", summary: "custom summary" }),
  });
  assert.equal(partial.verdict, "LikelyScam", "invalid verdict must be ignored");
  assert.equal(partial.summary, "custom summary", "valid summary must be applied");
});

// ─── §9.2: no-provider configured ────────────────────────────────────────────

test("§9.2 no-provider configured: LikelyScam + coreFact render fully with no seam", () => {
  // No `nuance` passed == no provider configured — match() must still produce
  // the full report with zero network involvement.
  const report = match(pasted("approve the collect request"));
  assert.equal(report.verdict, "LikelyScam");
  assert.ok(matchedIds(report).includes("COLLECT_REQUEST_FRAMED_AS_REFUND"));
  assert.equal(report.coreFact, CORE_FACT);
  assert.ok(report.summary.length > 0);
  assert.ok(report.reportId.length > 0);
});

// ─── §9.2: clean negotiation text ────────────────────────────────────────────

test("§9.2 clean negotiation text: NoRedFlagsFound, coreFact STILL populated", () => {
  const report = match(pasted("Hello, is the price negotiable? I can pay cash if we meet in person."));
  assert.equal(report.verdict, "NoRedFlagsFound");
  assert.deepEqual(report.matchedPatterns, []);
  assert.equal(report.coreFact, CORE_FACT, "coreFact is always populated, even with no flags (§4.7)");
  assert.ok(report.summary.length > 0);
});

// ─── §9.2: guidedAnswers path ────────────────────────────────────────────────

test("§9.2 guidedAnswers: wasAskedToScanOrApprove maps to SCAN_TO_RECEIVE -> LikelyScam", () => {
  const report = match(
    guided({
      guidedAnswers: {
        role: "selling",
        wasAskedToScanOrApprove: true,
        claimedReasonForCode: "buyer said scan to receive the payment",
      },
    }),
  );
  assert.equal(report.verdict, "LikelyScam");
  assert.ok(matchedIds(report).includes("SCAN_TO_RECEIVE"));
  assert.equal(report.coreFact, CORE_FACT);
});

test("guidedAnswers: claimedReasonForCode is pattern-scanned (collect request framed as refund)", () => {
  const report = match(
    guided({
      guidedAnswers: {
        role: "selling",
        wasAskedToScanOrApprove: false,
        claimedReasonForCode: "they said they sent extra money and asked me to approve the collect request, they want the extra back",
      },
    }),
  );
  assert.equal(report.verdict, "LikelyScam");
  const ids = matchedIds(report);
  assert.ok(ids.includes("COLLECT_REQUEST_FRAMED_AS_REFUND"), `ids: ${ids}`);
  assert.ok(ids.includes("OVERPAYMENT_REFUND_REQUEST"), `ids: ${ids}`);
});

test("guidedAnswers: benign answers produce NoRedFlagsFound + coreFact", () => {
  const report = match(guided({}));
  assert.equal(report.verdict, "NoRedFlagsFound");
  assert.deepEqual(report.matchedPatterns, []);
  assert.equal(report.coreFact, CORE_FACT);
});

// ─── All six pattern ids: EN + Hinglish coverage ─────────────────────────────

test("all six §4.7 pattern ids exist with exact ids, in table order", () => {
  const expected = [
    "SCAN_TO_RECEIVE",
    "COLLECT_REQUEST_FRAMED_AS_REFUND",
    "FAKE_SCREENSHOT_THEN_QR",
    "OVERPAYMENT_REFUND_REQUEST",
    "SCREEN_SHARE_REQUEST",
    "OTP_OR_PIN_REQUEST",
  ];
  assert.deepEqual(
    PAYMENT_SCAM_PATTERNS.map((p) => p.id),
    expected,
  );
  assert.deepEqual([...STRUCTURAL_PATTERN_IDS].sort(), [
    "COLLECT_REQUEST_FRAMED_AS_REFUND",
    "OTP_OR_PIN_REQUEST",
    "SCAN_TO_RECEIVE",
  ]);
});

test("remaining patterns: English + Hinglish forms all match their own id", () => {
  const cases = [
    ["COLLECT_REQUEST_FRAMED_AS_REFUND", "approve the payment request for the refund"],
    ["COLLECT_REQUEST_FRAMED_AS_REFUND", "cashback ke liye request approve karo"],
    ["FAKE_SCREENSHOT_THEN_QR", "I sent the payment screenshot, now complete the release"],
    ["FAKE_SCREENSHOT_THEN_QR", "payment proof bheja hai, screenshot dekh lo"],
    ["OVERPAYMENT_REFUND_REQUEST", "I overpaid by mistake, send the difference back"],
    ["OVERPAYMENT_REFUND_REQUEST", "zyada paisa bhej diya, wapas bhejo"],
    ["SCREEN_SHARE_REQUEST", "install AnyDesk so I can help you complete the payment"],
    ["SCREEN_SHARE_REQUEST", "teamviewer install karo, screen share karo"],
    ["OTP_OR_PIN_REQUEST", "share your OTP to verify the payment"],
    ["OTP_OR_PIN_REQUEST", "upi pin batao"],
  ];
  for (const [id, text] of cases) {
    assert.ok(
      matchPaymentScamPatterns(text).some((p) => p.id === id),
      `expected ${id} to match: "${text}"`,
    );
  }
});

test("pattern matches are canonical-order and permissive without word-boundary false hits", () => {
  // Multiple patterns → §4.7 table order in the report.
  const report = match(pasted("here's the payment screenshot, scan this QR to get your money"));
  assert.deepEqual(matchedIds(report), ["SCAN_TO_RECEIVE", "FAKE_SCREENSHOT_THEN_QR"]);
  assert.equal(report.verdict, "LikelyScam");

  // Word boundaries: "otp" must not match inside "hotpot", "qr" not in "square".
  assert.deepEqual(matchPaymentScamPatterns("hotpot recipe, paint the square"), []);

  // Structural pattern → LikelyScam even alone; single caution → Caution.
  assert.equal(verdictForPatternIds(["SCAN_TO_RECEIVE"]), "LikelyScam");
  assert.equal(verdictForPatternIds(["OTP_OR_PIN_REQUEST"]), "LikelyScam");
  assert.equal(verdictForPatternIds(["FAKE_SCREENSHOT_THEN_QR"]), "Caution");
  assert.equal(verdictForPatternIds(["SCREEN_SHARE_REQUEST"]), "Caution");
  // Two caution patterns corroborate → LikelyScam.
  assert.equal(verdictForPatternIds(["FAKE_SCREENSHOT_THEN_QR", "OVERPAYMENT_REFUND_REQUEST"]), "LikelyScam");
  assert.equal(verdictForPatternIds([]), "NoRedFlagsFound");
});

// ─── Robustness: never throws, always complete ───────────────────────────────

test("match never throws and always returns a complete report on garbage input", () => {
  for (const bad of [null, undefined, {}, { mode: "pastedText" }, { mode: "describedFlow" }, 42, "text"]) {
    const report = match(/** @type {never} */ (bad));
    assert.equal(report.verdict, "NoRedFlagsFound", `input: ${String(bad)}`);
    assert.equal(report.coreFact, CORE_FACT);
    assert.deepEqual(report.matchedPatterns, []);
  }
});

test("listingContext passthrough (opened from an existing RiskReport) does not disturb matching", () => {
  const report = match({
    mode: "pastedText",
    rawText: "scan this qr to get the payment",
    guidedAnswers: null,
    listingContext: { listingUrl: "https://www.olx.in/item/x-iid-1", listingTitle: "Mi TV" },
  });
  assert.equal(report.verdict, "LikelyScam");
  assert.ok(matchedIds(report).includes("SCAN_TO_RECEIVE"));
});

// ─── Zero-network guarantee (source level) ───────────────────────────────────

/**
 * Strip block and line comments so the network-surface scan only inspects
 * executable code — JSDoc type annotations like `{import("./match.js")}` are
 * compile-time references, not dynamic imports.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("match.js and its dependencies contain zero network surface", () => {
  const files = [
    new URL("../src/payment-check/match.js", import.meta.url),
    new URL("../src/payment-check/payment-scam-patterns.js", import.meta.url),
    new URL("../src/payment-check/prompt.js", import.meta.url),
    new URL("../src/shared/constants.js", import.meta.url),
  ];
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.doesNotMatch(code, /\bfetch\s*\(/, `${file.pathname} must not call fetch()`);
    assert.doesNotMatch(code, /XMLHttpRequest/, `${file.pathname} must not use XMLHttpRequest`);
    assert.doesNotMatch(code, /WebSocket/, `${file.pathname} must not use WebSocket`);
    assert.doesNotMatch(code, /sendBeacon/, `${file.pathname} must not use sendBeacon`);
    assert.doesNotMatch(code, /import\s*\(/, `${file.pathname} must not use dynamic import`);
  }
});

// ─── §4.7 constants ──────────────────────────────────────────────────────────

test("CORE_FACT is verbatim from §4.7", () => {
  assert.equal(
    CORE_FACT,
    "A QR code or payment request can only ever be used to send money, never to receive it. " +
      "If anyone — no matter how convincing — asks you to scan something or enter your PIN/OTP to " +
      "'receive' a payment, that is always false, with no exceptions.",
  );
});

test("REPORTING_RESOURCES carries 1930 and cybercrime.gov.in in the §2.3 shape", () => {
  const values = REPORTING_RESOURCES.map((r) => r.value);
  assert.ok(values.includes("1930"));
  assert.ok(values.includes("cybercrime.gov.in"));
  for (const r of REPORTING_RESOURCES) {
    assert.equal(typeof r.label, "string");
    assert.ok(r.label.length > 0);
  }
});

test("§5.3 verdict bands map scores to the exact verdicts", () => {
  assert.deepEqual(
    LISTING_VERDICT_BANDS.map((b) => b.verdict),
    ["Safe", "Review", "Suspicious", "High-Risk"],
  );
  const cases = [
    [0, "Safe"],
    [24, "Safe"],
    [25, "Review"],
    [49, "Review"],
    [50, "Suspicious"],
    [74, "Suspicious"],
    [75, "High-Risk"],
    [100, "High-Risk"],
    [24.5, "Review"], // rounds to 25
  ];
  for (const [score, expected] of cases) {
    assert.equal(verdictForScore(score), expected, `score ${score}`);
  }
  assert.equal(verdictForScore(null), null);
  assert.equal(verdictForScore(NaN), null);
  assert.equal(verdictForScore(101), null);
  assert.equal(verdictForScore(-1), null);
});

// ─── prompt.js sanity ────────────────────────────────────────────────────────

test("nuance system prompt is short, structured-JSON, and explicitly covers warning-to-others", () => {
  assert.ok(NUANCE_SYSTEM_PROMPT.includes("WARNS OTHERS"));
  assert.ok(NUANCE_SYSTEM_PROMPT.includes("NoRedFlagsFound"));
  assert.ok(NUANCE_SYSTEM_PROMPT.includes("LikelyScam"));
  assert.ok(NUANCE_SYSTEM_PROMPT.length < 2500, "must stay a short prompt");
  // It must be the payment-check prompt, not the listing-analysis one (§4.7).
  assert.ok(!NUANCE_SYSTEM_PROMPT.includes("listing photos"));
  assert.ok(!NUANCE_SYSTEM_PROMPT.includes("heuristic"));
});

test("buildNuanceUserPrompt carries the text, guided answers, and current verdict", () => {
  const report = match(pasted("scan this qr to get the payment"));
  const prompt = buildNuanceUserPrompt(pasted("scan this qr to get the payment"), report);
  assert.ok(prompt.includes("scan this qr to get the payment"));
  assert.ok(prompt.includes("LikelyScam"));
  assert.ok(prompt.includes("SCAN_TO_RECEIVE"));

  const g = guided({
    guidedAnswers: { role: "buying", wasAskedToScanOrApprove: true, claimedReasonForCode: "to receive the money" },
  });
  const gPrompt = buildNuanceUserPrompt(g, match(g));
  assert.ok(gPrompt.includes("buying"));
  assert.ok(gPrompt.includes("yes"));
  assert.ok(gPrompt.includes("to receive the money"));
});
