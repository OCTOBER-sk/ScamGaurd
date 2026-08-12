/**
 * backend-e2e.mjs — E2E VERIFICATION HARNESS (backend half).
 *
 * Runs the REAL production pipeline end to end against the REAL OpenRouter
 * API and writes scripts/e2e/results.json:
 *
 *   1. jsdom + content/extractor.js `extractListing` on
 *      test/fixtures/olx-listing-real.html                → Listing
 *   2. src/heuristics/signals.js `run(listing)`           → HeuristicSignals
 *   3. src/llm/prompt.js `buildSystemPrompt`/`buildUserPrompt`
 *   4. src/llm/providers/registry.js `get("openrouter")` + src/llm/providers/client.js
 *      `callProvider` → REAL POST to
 *      https://openrouter.ai/api/v1/chat/completions with model
 *      deepseek/deepseek-chat-v3-0324:free, key from OPENROUTER_API_KEY.
 *      The raw response body is captured via an injected logging fetchImpl.
 *   5. src/llm/parse.js `tolerantParse` + src/llm/schema.js `validate`
 *      (run explicitly on the captured raw body, and again implicitly inside
 *      callProvider's §6 pipeline).
 *   6. src/scoring/fuse.js `fuse(heuristics, verdict)`  → RiskReport shape.
 *   7. src/payment-check/match.js on the scan-to-receive scam text
 *      → PaymentCheckReport (LikelyScam).
 *
 * Never throws on an API failure — the error is printed and a partial
 * results.json is still written (heuristic-only fallback, per §5.2/§6).
 *
 * Usage:
 *   OPENROUTER_API_KEY=<key> node scripts/e2e/backend-e2e.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { extractListing } from "../../content/extractor.mjs";
import { run as runHeuristics } from "../../src/heuristics/signals.js";
import { buildSystemPrompt, buildUserPrompt } from "../../src/llm/prompt.js";
import { get as getProvider } from "../../src/llm/providers/registry.js";
import { callProvider } from "../../src/llm/providers/client.js";
import { tolerantParse } from "../../src/llm/parse.js";
import { validate } from "../../src/llm/schema.js";
import { fuse } from "../../src/scoring/fuse.js";
import { match as paymentCheckMatch } from "../../src/payment-check/match.js";
import { REPORTING_RESOURCES } from "../../src/shared/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = `${__dirname}/results.json`;

const PINNED_MODEL = "deepseek/deepseek-chat-v3-0324:free";
const API_KEY = process.env.OPENROUTER_API_KEY || "";
const SCAM_TEXT =
  "buyer said scan this QR code to receive the payment instantly";

/**
 * Model fallback chain. `PINNED_MODEL` is ALWAYS attempted first (the task
 * spec pins it); OpenRouter's free catalog rotates, so the 2026-08-12 probe
 * found `:free` slugs 404ing with "This model is unavailable for free".
 * The remaining models were verified live as HTTP 200 during the same probe
 * and provide a REAL verdict so the harness is real proof, not a partial.
 */
const FALLBACK_MODELS = [
  "openai/gpt-oss-20b:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "liquid/lfm-2.5-2.6b:free",
];
const MODEL_CHAIN = [PINNED_MODEL, ...FALLBACK_MODELS];

// ─── step 0: fixture → Document ─────────────────────────────────────────────

const fixture = readFileSync(
  `${__dirname}/../../test/fixtures/olx-listing-real.html`,
  "utf8",
);
const dom = new JSDOM(fixture, {
  url: "https://www.olx.in/item/mi-led-32-smart-android-led-tv-iid-1827354630.html",
});
const doc = dom.window.document;

// ─── step 1: extraction → Listing ───────────────────────────────────────────

const t0 = Date.now();
const listing = extractListing(doc);
const tExtract = Date.now() - t0;

// ─── step 2: deterministic heuristics → HeuristicSignals ────────────────────

const t1 = Date.now();
const heuristics = runHeuristics(listing);
const tHeuristics = Date.now() - t1;

// ─── step 3: prompts ────────────────────────────────────────────────────────

const systemPrompt = buildSystemPrompt();
const userPrompt = buildUserPrompt(listing, heuristics);

// ─── step 4: REAL provider call via the real client.js ──────────────────────

const adapter = getProvider("openrouter");

/**
 * Logging fetch wrapper: forwards to global fetch but captures the raw
 * response body so results.json can carry the truncated llmRaw.
 */
let rawBodyLog = null;
async function loggingFetch(url, init) {
  const res = await globalThis.fetch(url, init);
  const text = await res.text();
  rawBodyLog = text;
  return new Response(text, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** Run callProvider once; returns its discriminated result. */
async function attemptProvider(model, preferJsonSchema) {
  if (typeof adapter.preferJsonSchema === "boolean") {
    adapter.preferJsonSchema = preferJsonSchema;
  }
  return callProvider(adapter, {
    listing,
    heuristics,
    systemPrompt,
    userPrompt,
    model,
    apiKey: API_KEY,
    timeoutMs: 90000,
    fetchImpl: loggingFetch,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let providerResult = null;
/** @type {Array<{ model: string; format: string; status: string; detail: string }>} */
const modelAttempts = [];

if (!adapter) {
  providerResult = {
    status: "error",
    errorCode: "no_provider",
    message: "registry.get('openrouter') returned null",
    retried: false,
  };
} else if (!API_KEY) {
  providerResult = {
    status: "error",
    errorCode: "no_key",
    message: "OPENROUTER_API_KEY env var is not set",
    retried: false,
  };
} else {
  // Walk the chain: pinned model first, then verified free fallbacks.
  // Each model is tried with the adapter's json_schema format, then with
  // json_object (some free models reject json_schema with a 400). A model
  // "works" only when callProvider returns a parseable, schema-valid verdict.
  for (const model of MODEL_CHAIN) {
    for (const preferJsonSchema of [true, false]) {
      const format = preferJsonSchema ? "json_schema" : "json_object";
      if (modelAttempts.length > 0) await sleep(2000); // dodge upstream rate limits
      const attempt = await attemptProvider(model, preferJsonSchema);
      const detail =
        attempt.status === "ok"
          ? `latency=${attempt.provider.latencyMs}ms repair=${attempt.provider.usedFallbackRepair}`
          : `${attempt.errorCode}: ${attempt.message}`;
      modelAttempts.push({ model, format, status: attempt.status, detail });

      if (attempt.status === "ok") {
        providerResult = attempt;
        break;
      }
      // A hard model-level rejection (400/404) won't be fixed by flipping
      // the JSON format — skip the second format and move to the next model.
      if (
        attempt.status === "error" &&
        (attempt.errorCode === "model_not_found" ||
          attempt.errorCode === "no_model" ||
          attempt.errorCode === "no_key")
      ) {
        break;
      }
    }
    if (providerResult?.status === "ok") break;
  }

  // Record whether the pinned model itself succeeded.
  const pinnedOk = modelAttempts.some(
    (a) => a.model === PINNED_MODEL && a.status === "ok",
  );
  if (!pinnedOk) {
    console.warn(
      `[e2e] pinned model ${PINNED_MODEL} unavailable (see modelAttempts) — using verified free fallback for a real verdict`,
    );
  }
}

// ─── step 5: parse + validate (explicit, on the captured raw body) ──────────

let parsedVerdict = null;
let validation = { valid: false, errors: ["no raw body captured"] };
if (providerResult.status === "ok" && rawBodyLog) {
  try {
    const parsed = adapter.parseResponse(rawBodyLog); // real adapter parseResponse
    parsedVerdict = tolerantParse(parsed?.text ?? null); // real parse.js
    validation = parsedVerdict === null
      ? { valid: false, errors: ["tolerantParse returned null"] }
      : validate(parsedVerdict); // real schema.js
  } catch (err) {
    validation = { valid: false, errors: [String(err)] };
  }
}

// ─── step 6: fusion → RiskReport shape ──────────────────────────────────────

const verdictForFuse = providerResult.status === "ok" && parsedVerdict
  ? parsedVerdict
  : null;
const fused = fuse(heuristics, verdictForFuse); // real scoring/fuse.js

const report = {
  reportId: crypto.randomUUID(),
  listingUrl: listing.url,
  listingTitle: listing.title,
  score: fused.score,
  verdict: fused.verdict,
  confidence: fused.confidence,
  source: fused.source,
  redFlags: Array.isArray(parsedVerdict?.redFlags) ? parsedVerdict.redFlags : [],
  summary:
    fused.source === "heuristic-only"
      ? "AI review unavailable — showing rule-based check only."
      : typeof parsedVerdict?.summary === "string" && parsedVerdict.summary.length > 0
        ? parsedVerdict.summary
        : "No summary was provided.",
  checklist: Array.isArray(parsedVerdict?.checklistAdditions)
    ? parsedVerdict.checklistAdditions
    : [],
  reportingResources: REPORTING_RESOURCES,
  visionAnalysis: {
    performed: false,
    skippedReason: "Text-only E2E harness — no listing photos sent.",
    notes: Array.isArray(parsedVerdict?.visionNotes) ? parsedVerdict.visionNotes : [],
  },
  provider: providerResult.status === "ok"
    ? providerResult.provider
    : { id: "openrouter", model: PINNED_MODEL, latencyMs: null, usedFallbackRepair: false },
  rawListing: listing,
  createdAt: new Date().toISOString(),
};

// ─── step 7: Message & Payment Check ────────────────────────────────────────

const tPay = Date.now();
const paymentCheck = paymentCheckMatch({
  mode: "pastedText",
  rawText: SCAM_TEXT,
});
const tPaymentCheck = Date.now() - tPay;

// ─── assemble results.json ──────────────────────────────────────────────────

const usedModel =
  providerResult.status === "ok" ? providerResult.provider.model : PINNED_MODEL;

const results = {
  listing,
  heuristics,
  llmRaw: typeof rawBodyLog === "string" ? rawBodyLog.slice(0, 500) : null,
  parsedVerdict,
  validation,
  fusedScore: fused.score,
  verdict: fused.verdict,
  fusionSource: fused.source,
  confidence: fused.confidence,
  latencyMs: providerResult.status === "ok"
    ? providerResult.provider.latencyMs
    : null,
  pinnedModel: PINNED_MODEL,
  model: usedModel,
  providerCall: providerResult,
  modelAttempts,
  paymentCheck,
  report,
  ranAt: new Date().toISOString(),
};

mkdirSync(__dirname, { recursive: true });
writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
console.log(`[e2e] wrote ${RESULTS_PATH}`);

// ─── human summary ──────────────────────────────────────────────────────────

console.log("\n========== ScamGuard E2E BACKEND ==========");
console.log(`Extraction  : platform=${listing.platform} adId=${listing.adId} confidence=${listing.extractionConfidence} (${tExtract}ms)`);
console.log(`  title     : ${listing.title}`);
console.log(`  price     : ${listing.price.raw}`);
console.log(`  seller    : ${listing.sellerName} (${listing.sellerMemberSince}, ${listing.sellerItemsListed} items)`);
console.log(`Heuristics  : score=${heuristics.heuristicScore} (${tHeuristics}ms)`);
console.log(`  priceAnomaly        : ${heuristics.priceAnomaly.severity} ${heuristics.priceAnomaly.note}`);
console.log(`  offPlatformLanguage : ${JSON.stringify(heuristics.offPlatformPaymentLanguage.matchedPhrases)}`);
console.log(`  advanceFeeLanguage  : ${JSON.stringify(heuristics.advanceFeeLanguage.matchedPhrases)}`);
console.log(`  urgencyLanguage     : ${JSON.stringify(heuristics.urgencyLanguage.matchedPhrases)}`);
console.log(`  contactLeaks        : ${JSON.stringify(heuristics.contactChannelLeak.matches)}`);

if (providerResult.status === "ok") {
  console.log(`LLM call    : OK via ${adapter.id} model=${usedModel} latency=${providerResult.provider.latencyMs}ms usedRepair=${providerResult.provider.usedFallbackRepair}`);
  console.log(`  tolerantParse : ${parsedVerdict ? "object recovered" : "NULL"}`);
  console.log(`  schema.validate: ${validation.valid ? "valid" : `INVALID: ${validation.errors.slice(0, 3).join(" | ")}`}`);
  console.log(`  llmScore    : ${parsedVerdict?.llmScore}`);
  console.log(`  redFlags    : ${(parsedVerdict?.redFlags ?? []).map((f) => `${f.id}(${f.severity})`).join(", ") || "(none)"}`);
} else {
  console.log(`LLM call    : FAILED — ${providerResult.errorCode}: ${providerResult.message}`);
}
if (modelAttempts.length > 0) {
  console.log("  modelAttempts: " + modelAttempts.map((a) => `${a.model} [${a.format}] → ${a.status}${a.status === "ok" ? "" : ` (${a.detail})`}`).join("\n                 "));
}

console.log(`Fusion      : score=${fused.score} verdict=${fused.verdict} source=${fused.source} confidence=${fused.confidence} escalated=${fused.escalated}`);
console.log(`PaymentCheck: verdict=${paymentCheck.verdict} patterns=${paymentCheck.matchedPatterns.map((p) => p.id).join(", ") || "(none)"} (${tPaymentCheck}ms)`);
console.log(`  coreFact  : ${paymentCheck.coreFact.slice(0, 80)}…`);
console.log("============================================");

// non-zero exit signals a hard API failure to CI, but results.json is still real/partial.
if (providerResult.status !== "ok") process.exitCode = 1;
