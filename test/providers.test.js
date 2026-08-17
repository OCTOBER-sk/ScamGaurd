/**
 * providers.test.js — Phase 3: Provider Adapter Layer (node:test, zero deps).
 *
 * Covers PLAN-BACKEND.md §9.2 rows against the provider layer with a manual
 * fetch stub (test/mocks/fetch-mock.js — no mocking library):
 *   - provider-500            → exactly 1 retry with ~1.5s backoff, then server_error
 *   - provider-429            → NO retry, rate-limit message
 *   - provider-timeout        → surfaces at timeoutMs (fake timers) with the §6 message
 *   - malformed-json          → single repair retry, then heuristic fallback
 *   - openrouter-model-gone   → the specific §6 rotation message, never generic
 *   - no-vision-model         → skippedReason set, text-only analysis still runs
 *   - not-a-listing           → notAListing passthrough, distinct from a scored verdict
 * Plus gemini (responseSchema) and groq (json_object) request-shape tests,
 * §3.2 preset-table values, registry, prompt/parse/schema unit tests, and
 * the vision pipeline (provider shaping, per-image failure skip, 3-image cap).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { get, list } from "../src/llm/providers/registry.js";
import { callProvider, OPENROUTER_ROTATION_MESSAGE, PARSE_FAILED_MESSAGE } from "../src/llm/providers/client.js";
import { OPENROUTER_DEFAULT_MODEL } from "../src/llm/providers/constants.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildRepairPrompt,
  MAX_DESCRIPTION_CHARS,
} from "../src/llm/prompt.js";
import { tolerantParse, safeParseJson } from "../src/llm/parse.js";
import { RISK_VERDICT_SCHEMA, validate } from "../src/llm/schema.js";
import { buildImageParts, planVision, MAX_IMAGES, MAX_EDGE_PX, JPEG_QUALITY } from "../src/llm/vision.js";
import { createFetchMock } from "./mocks/fetch-mock.js";

// ─── fixtures ───────────────────────────────────────────────────────────────

/** @param {object} [overrides] @returns {import("../src/shared/types.js").Listing} */
function makeListing(overrides = {}) {
  return {
    platform: "olx",
    url: "https://www.olx.in/item/hp-pavilion-iid-1",
    adId: "1",
    title: "HP Pavilion 15",
    price: { amount: 20000, currency: "INR", raw: "₹ 20000" },
    description: "HP Pavilion 15, good condition, bill and box available.",
    sellerName: "Rohit",
    sellerMemberSince: "Feb 2014",
    sellerItemsListed: 9,
    sellerVerified: null,
    location: "Lucknow",
    postedAt: "Today",
    images: [],
    imageCount: 3,
    extractionConfidence: "high",
    extractedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** @returns {import("../src/shared/types.js").HeuristicSignals} */
function makeHeuristics() {
  return {
    priceAnomaly: { triggered: false, severity: "none", ratioVsCategoryTypical: null, note: "No category match — price not compared." },
    sellerAge: { triggered: false, memberSinceRaw: "Feb 2014", itemsListed: 9 },
    photoSignals: { count: 3, triggered: false, severity: "none" },
    contactChannelLeak: { triggered: false, matches: [] },
    urgencyLanguage: { triggered: false, matchedPhrases: [] },
    advanceFeeLanguage: { triggered: false, matchedPhrases: [] },
    offPlatformPaymentLanguage: { triggered: false, matchedPhrases: [] },
    heuristicScore: 5,
    computedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** @type {Record<string, unknown>} */
const VALID_VERDICT = {
  llmScore: 40,
  redFlags: [{ id: "NEW_SELLER", label: "New seller", severity: "medium", explanation: "Account is new." }],
  summary: "Listing shows moderate patterns consistent with the heuristic signals.",
  checklistAdditions: [],
  visionNotes: [],
};

/** @param {object} [overrides] */
function baseCallOpts(overrides = {}) {
  return {
    listing: makeListing(),
    heuristics: makeHeuristics(),
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt(makeListing(), makeHeuristics()),
    apiKey: "test-key",
    ...overrides,
  };
}

// ─── §4.1 verbatim system prompt ────────────────────────────────────────────

test("§4.1 system prompt is VERBATIM from PLAN-BACKEND.md", () => {
  const expected = `You are a scam-detection analyst embedded in a browser extension called ScamGuard. You analyze
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
  assert.equal(buildSystemPrompt(), expected);
});

// ─── §4.2 user prompt + §6 repair prompt ────────────────────────────────────

test("buildUserPrompt renders the §4.2 template with null-safe placeholders", () => {
  const user = buildUserPrompt(makeListing({ sellerName: null }), makeHeuristics());
  assert.ok(user.includes("LISTING DATA:"), "has the LISTING DATA header");
  assert.ok(user.includes("Platform: olx"));
  assert.ok(user.includes("Title: HP Pavilion 15"));
  assert.ok(user.includes("Price: ₹ 20000 (INR)"));
  assert.ok(user.includes("Seller: (n/a) — member since Feb 2014 — 9 items listed"));
  assert.ok(user.includes("PRE-COMPUTED HEURISTIC SIGNALS"));
  assert.ok(user.includes("Analyze this listing per your instructions and return the JSON object."));
});

test("buildUserPrompt truncates >2000-char descriptions with the §4.6 note", () => {
  const long = "a".repeat(2500);
  const user = buildUserPrompt(makeListing({ description: long }), makeHeuristics());
  assert.ok(user.includes(`[description truncated to ${MAX_DESCRIPTION_CHARS} chars]`));
  assert.ok(!user.includes("a".repeat(2001)), "truncated text must not leak past the cap");
});

test("buildRepairPrompt appends the §6 repair line as a fresh single-turn prompt", () => {
  const repaired = buildRepairPrompt({ systemPrompt: "SYS", userPrompt: "USER" });
  assert.equal(repaired.systemPrompt, "SYS");
  assert.match(
    repaired.userPrompt,
    /USER\n\nYour previous response was not valid JSON matching the required schema\. Respond with ONLY the corrected JSON object, nothing else\./,
  );
  const bare = buildRepairPrompt({ systemPrompt: "SYS", userPrompt: "" });
  assert.equal(bare.userPrompt, "Your previous response was not valid JSON matching the required schema. Respond with ONLY the corrected JSON object, nothing else.");
});

// ─── §4.6 tolerantParse ─────────────────────────────────────────────────────

test("tolerantParse recovers JSON from fences, prose, and trailing chatter (§4.6)", () => {
  assert.deepEqual(tolerantParse('{"a":1}'), { a: 1 });
  assert.deepEqual(tolerantParse('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(tolerantParse('```\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(tolerantParse('prefix text {"a": 1} trailing chat'), { a: 1 });
  assert.deepEqual(tolerantParse("here's your analysis: {\"a\": 1}"), { a: 1 });
  assert.equal(tolerantParse(null), null);
  assert.equal(tolerantParse(undefined), null);
  assert.equal(tolerantParse(""), null);
  assert.equal(tolerantParse("   "), null);
  assert.equal(tolerantParse("no braces here"), null);
  assert.equal(tolerantParse("{broken"), null);
  assert.equal(tolerantParse('prefix {"a": 1} middle {"b": 2}'), null, "two objects with interleaved text are not recoverable");
});

test("safeParseJson never throws", () => {
  assert.deepEqual(safeParseJson('{"x":1}'), { x: 1 });
  assert.equal(safeParseJson("{bad"), null);
  assert.equal(safeParseJson(""), null);
});

// ─── §4.5 schema validation ─────────────────────────────────────────────────

test("validate() accepts a fully-valid §4.5 verdict", () => {
  const result = validate({
    llmScore: 42,
    redFlags: [{ id: "PRICE_ANOMALY", label: "Price far below market", severity: "high", explanation: "Price is 30% of typical." }],
    summary: "Fine.",
    checklistAdditions: ["Meet in person."],
    visionNotes: [],
    notAListing: false,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validate() rejects wrong shapes with targeted errors", () => {
  assert.equal(validate(null).valid, false);
  assert.equal(validate(42).valid, false);
  assert.equal(validate([]).valid, false);
  assert.equal(validate({}).valid, false, "missing all required fields");
  assert.equal(validate({ llmScore: 150, redFlags: [], summary: "S", checklistAdditions: [], visionNotes: [] }).valid, false);
  assert.equal(validate({ llmScore: 1.5, redFlags: [], summary: "S", checklistAdditions: [], visionNotes: [] }).valid, false);
  assert.equal(validate({ llmScore: 1, redFlags: [{ id: "", label: "L", severity: "high", explanation: "E" }], summary: "S", checklistAdditions: [], visionNotes: [] }).valid, false);
  assert.equal(validate({ llmScore: 1, redFlags: [{ id: "X", label: "L", severity: "extreme", explanation: "E" }], summary: "S", checklistAdditions: [], visionNotes: [] }).valid, false);
  assert.equal(validate({ llmScore: 1, redFlags: [], summary: "S", checklistAdditions: ["ok", 5], visionNotes: [] }).valid, false);
  assert.equal(validate({ llmScore: 1, redFlags: [], summary: 7, checklistAdditions: [], visionNotes: [] }).valid, false);
  assert.equal(validate({ llmScore: 1, redFlags: [], summary: "S", checklistAdditions: [], visionNotes: [] }).valid, true);
});

test("RISK_VERDICT_SCHEMA matches §4.5 exactly", () => {
  assert.equal(RISK_VERDICT_SCHEMA.type, "object");
  assert.deepEqual(RISK_VERDICT_SCHEMA.required, ["llmScore", "redFlags", "summary", "checklistAdditions", "visionNotes"]);
  assert.deepEqual(RISK_VERDICT_SCHEMA.properties.redFlags.items.required, ["id", "label", "severity", "explanation"]);
  assert.deepEqual(RISK_VERDICT_SCHEMA.properties.redFlags.items.properties.severity.enum, ["low", "medium", "high"]);
  assert.deepEqual(RISK_VERDICT_SCHEMA.properties.llmScore, { type: "integer", minimum: 0, maximum: 100 });
});

// ─── §3.1/§3.2 registry + presets ───────────────────────────────────────────

test("registry lists all 10 §3.2 adapters in table order; get() resolves and nulls", () => {
  assert.deepEqual(
    list().map((p) => p.id),
    ["gemini", "groq", "cerebras", "openrouter", "mistral", "deepseek", "openai", "anthropic", "ollama", "custom"],
  );
  assert.equal(get("gemini"), list()[0]);
  assert.equal(get("groq"), list()[1]);
  assert.equal(get("custom"), list()[9]);
  assert.equal(get("nope"), null);
  assert.equal(get(""), null);
  assert.equal(get(null), null);
  assert.equal(get(undefined), null);
});

test("§3.2 presets: endpoints, default models, timeoutMs (§4.4), vision capability", () => {
  const expected = {
    gemini: ["https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", "gemini-2.5-flash", 20000, true],
    groq: ["https://api.groq.com/openai/v1/chat/completions", "llama-3.3-70b-versatile", 12000, false],
    cerebras: ["https://api.cerebras.ai/v1/chat/completions", "gemma-4-31b", 12000, false],
    openrouter: ["https://openrouter.ai/api/v1/chat/completions", OPENROUTER_DEFAULT_MODEL, 20000, true],
    mistral: ["https://api.mistral.ai/v1/chat/completions", "mistral-small-latest", 20000, false],
    deepseek: ["https://api.deepseek.com/v1/chat/completions", "deepseek-chat", 20000, false],
    openai: ["https://api.openai.com/v1/chat/completions", null, 20000, true],
    anthropic: ["https://api.anthropic.com/v1/messages", null, 20000, true],
    ollama: ["http://localhost:11434/v1/chat/completions", null, 20000, false],
    custom: [null, null, 20000, false],
  };
  for (const [id, [endpoint, model, timeoutMs, vision]] of Object.entries(expected)) {
    const p = get(id);
    assert.ok(p, `${id} registered`);
    assert.equal(p.defaultEndpoint, endpoint, `${id} defaultEndpoint`);
    assert.equal(p.defaultModel, model, `${id} defaultModel`);
    assert.equal(p.timeoutMs, timeoutMs, `${id} timeoutMs`);
    assert.equal(p.visionCapableModels.length > 0, vision, `${id} vision capability`);
    assert.ok(typeof p.label === "string" && p.label.length > 0, `${id} label`);
    assert.ok(typeof p.authStyle === "string", `${id} authStyle`);
    assert.ok(typeof p.supportsJsonMode === "boolean", `${id} supportsJsonMode`);
    assert.ok(typeof p.jsonModeStyle === "string", `${id} jsonModeStyle`);
    assert.equal(typeof p.buildRequest, "function", `${id} buildRequest`);
    assert.equal(typeof p.parseResponse, "function", `${id} parseResponse`);
    assert.equal(typeof p.testConnection, "function", `${id} testConnection`);
  }
});

// ─── request-shape tests ────────────────────────────────────────────────────

test("gemini request shape: legacy generateContent + responseSchema (§0.3)", () => {
  const req = get("gemini").buildRequest({
    listing: null, heuristics: null, systemPrompt: "SYS", userPrompt: "USER",
    model: "gemini-2.5-flash", apiKey: "k",
  });
  assert.equal(req.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(req.headers["x-goog-api-key"], "k");
  const body = req.body;
  assert.equal(body.contents[0].role, "user");
  assert.match(body.contents[0].parts[0].text, /SYS[\s\S]*USER/);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.ok(body.generationConfig.responseSchema, "responseSchema must be present");
  assert.equal(body.generationConfig.responseSchema.type, "object");
  assert.ok(body.generationConfig.responseSchema.properties.redFlags, "schema carries §4.5 properties");
  assert.equal(body.generationConfig.temperature, 0.2);
  assert.equal(body.generationConfig.maxOutputTokens, 1024);
});

test("gemini request shape with imageParts: inlineData parts + 1536 max tokens", () => {
  const req = get("gemini").buildRequest({
    listing: null, heuristics: null, systemPrompt: "SYS", userPrompt: "USER",
    model: "gemini-2.5-flash", apiKey: "k",
    imageParts: [{ inlineData: { mimeType: "image/jpeg", data: "abc" } }],
  });
  assert.equal(req.body.contents[0].parts.length, 2);
  assert.deepEqual(req.body.contents[0].parts[1], { inlineData: { mimeType: "image/jpeg", data: "abc" } });
  assert.equal(req.body.generationConfig.maxOutputTokens, 1536);
});

test("groq request shape: OpenAI-compatible json_object mode (§3.2 row 2)", () => {
  const req = get("groq").buildRequest({
    listing: null, heuristics: null, systemPrompt: "SYS", userPrompt: "USER",
    model: "llama-3.3-70b-versatile", apiKey: "k",
  });
  assert.equal(req.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(req.headers.Authorization, "Bearer k");
  assert.equal(req.body.model, "llama-3.3-70b-versatile");
  assert.equal(req.body.messages[0].role, "system");
  assert.equal(req.body.messages[1].role, "user");
  assert.equal(req.body.messages[0].content, "SYS");
  assert.equal(req.body.messages[1].content, "USER");
  assert.deepEqual(req.body.response_format, { type: "json_object" });
  assert.equal(req.body.temperature, 0.2);
  assert.equal(req.body.max_tokens, 1024);
});

test("anthropic request shape: forced tool-use JSON + x-api-key + anthropic-version", () => {
  const req = get("anthropic").buildRequest({
    listing: null, heuristics: null, systemPrompt: "SYS", userPrompt: "USER",
    model: "claude-sonnet-4-latest", apiKey: "k",
  });
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["x-api-key"], "k");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.equal(req.body.system, "SYS");
  assert.deepEqual(req.body.messages[0].content, [{ type: "text", text: "USER" }]);
  assert.deepEqual(req.body.tool_choice, { type: "tool", name: "submit_risk_verdict" });
  assert.equal(req.body.tools[0].name, "submit_risk_verdict");
  assert.equal(req.body.tools[0].input_schema, RISK_VERDICT_SCHEMA, "tool input_schema is the §4.5 schema");
  assert.equal(req.body.max_tokens, 1024);
});

test("openrouter: pinned :free default, NEVER openrouter/free, json_schema format", () => {
  assert.notEqual(get("openrouter").defaultModel, "openrouter/free", "§0.4: never default to the auto-router");
  assert.match(get("openrouter").defaultModel, /:free$/, "default is an explicit :free model");
  const req = get("openrouter").buildRequest({
    listing: null, heuristics: null, systemPrompt: "SYS", userPrompt: "USER",
    model: get("openrouter").defaultModel, apiKey: "k",
  });
  assert.equal(req.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(req.headers.Authorization, "Bearer k");
  assert.equal(req.body.response_format.type, "json_schema");
  assert.equal(req.body.response_format.json_schema.name, "risk_verdict");
  assert.equal(req.body.response_format.json_schema.schema, RISK_VERDICT_SCHEMA);
});

test("custom adapter: openai-chat shape uses customEndpoint + bearer auth by default (§3.5)", () => {
  const req = get("custom").buildRequest({
    listing: null, heuristics: null, systemPrompt: "SYS", userPrompt: "USER",
    model: "mymodel", apiKey: "k",
    customEndpoint: "https://selfhost.example/v1/chat/completions",
  });
  assert.equal(req.url, "https://selfhost.example/v1/chat/completions");
  assert.equal(req.headers.Authorization, "Bearer k");
  assert.deepEqual(req.body.response_format, { type: "json_object" });
  assert.equal(req.body.model, "mymodel");
});

test("custom adapter: gemini-native request shape (§3.5 dropdown)", () => {
  const req = get("custom").buildRequest({
    listing: null, heuristics: null, systemPrompt: "SYS", userPrompt: "USER",
    model: "mymodel", apiKey: "k",
    customEndpoint: "https://selfhost.example/v1beta/models/{model}:generateContent",
    customRequestShape: "gemini-native",
    customAuthStyle: "header",
    customAuthKeyName: "x-goog-api-key",
  });
  assert.equal(req.headers["x-goog-api-key"], "k");
  assert.ok(req.body.generationConfig, "gemini-native body has generationConfig");
  assert.equal(req.body.generationConfig.responseMimeType, "application/json");
  assert.ok(req.body.generationConfig.responseSchema);
});

// ─── §9.2 error rows via callProvider ───────────────────────────────────────

test("§9.2 provider-500: exactly 1 retry with ~1.5s backoff, then server_error (§6)", async () => {
  const mockFetch = createFetchMock([
    { status: 500, body: { error: { message: "internal error" } } },
    { status: 500, body: { error: { message: "internal error" } } },
  ]);
  const sleeps = [];
  const result = await callProvider(get("groq"), {
    ...baseCallOpts(),
    fetchImpl: mockFetch,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(mockFetch.calls.length, 2, "must retry exactly once");
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "server_error");
  assert.match(result.message, /having trouble/);
  assert.equal(result.retried, true);
  assert.deepEqual(sleeps, [1500]);
});

test("§9.2 provider-429: NO retry, rate-limit message surfaces (§6)", async () => {
  const mockFetch = createFetchMock([{ status: 429, body: { error: { message: "rate limited" } } }]);
  const result = await callProvider(get("groq"), { ...baseCallOpts(), fetchImpl: mockFetch });
  assert.equal(mockFetch.calls.length, 1, "429 must never auto-retry (§6)");
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "rate_limited");
  assert.match(result.message, /rate-limited/);
  assert.equal(result.retried, false);
});

test("§9.2 provider-timeout: surfaces at timeoutMs with the §6 message (fake timers)", async (t) => {
  const mockFetch = createFetchMock([{ never: true }]);
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const pending = callProvider(get("groq"), {
      ...baseCallOpts(),
      fetchImpl: mockFetch,
      timeoutMs: 12000,
      sleep: async () => {},
    });
    // tick fires the AbortController timeout synchronously; setImmediate
    // (unmocked) lets the rejection microtask chain settle to completion.
    timers.tick(13000);
    await new Promise((resolve) => setImmediate(resolve));
    const result = await pending;
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "timeout");
    assert.match(result.message, /didn't respond in time/);
  } finally {
    timers.reset();
  }
});

test("§9.2 malformed-json: single repair retry, then heuristic-only fallback (§6)", async () => {
  const garbage = { choices: [{ message: { content: "here's your analysis: {broken" } }] };
  const mockFetch = createFetchMock([
    { status: 200, body: garbage },
    { status: 200, body: garbage },
  ]);
  const result = await callProvider(get("groq"), { ...baseCallOpts(), fetchImpl: mockFetch });
  assert.equal(mockFetch.calls.length, 2, "original + exactly one repair attempt");
  assert.equal(result.status, "parse-failed");
  assert.equal(result.usedRepairRetry, true);
  assert.equal(result.message, PARSE_FAILED_MESSAGE);
});

test("malformed-json then valid repair response: ok with usedFallbackRepair=true", async () => {
  const good = { choices: [{ message: { content: JSON.stringify(VALID_VERDICT) } }] };
  const garbage = { choices: [{ message: { content: "```json\n{broken" } }] };
  const mockFetch = createFetchMock([
    { status: 200, body: garbage },
    { status: 200, body: good },
  ]);
  const result = await callProvider(get("groq"), { ...baseCallOpts(), fetchImpl: mockFetch });
  assert.equal(result.status, "ok");
  assert.equal(result.provider.usedFallbackRepair, true);
  assert.equal(result.llmVerdict.llmScore, 40);
});

test("schema-mismatch (valid JSON, wrong shape) triggers the same repair path (§6)", async () => {
  const wrong = { choices: [{ message: { content: JSON.stringify({ llmScore: 5 }) } }] };
  const good = { choices: [{ message: { content: JSON.stringify(VALID_VERDICT) } }] };
  const mockFetch = createFetchMock([
    { status: 200, body: wrong },
    { status: 200, body: good },
  ]);
  const result = await callProvider(get("groq"), { ...baseCallOpts(), fetchImpl: mockFetch });
  assert.equal(result.status, "ok");
  assert.equal(result.provider.usedFallbackRepair, true);
  assert.equal(mockFetch.calls.length, 2);
});

test("§9.2 openrouter-model-gone: the SPECIFIC §6 rotation message, no silent substitution", async () => {
  const mockFetch = createFetchMock([
    {
      status: 404,
      body: { error: { message: "The model qwen/qwen3-8b:free does not exist or you do not have access to it." } },
    },
  ]);
  const result = await callProvider(get("openrouter"), { ...baseCallOpts(), fetchImpl: mockFetch });
  assert.equal(mockFetch.calls.length, 1, "no retry — model rotation surfaces to the user");
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "model_not_found");
  assert.equal(result.message, OPENROUTER_ROTATION_MESSAGE);
});

test("§9.2 not-a-listing: notAListing passthrough, never a scored RiskReport", async () => {
  const notAListing = {
    llmScore: 0,
    redFlags: [],
    summary: "This does not appear to be a listing page.",
    checklistAdditions: [],
    visionNotes: [],
    notAListing: true,
  };
  const mockFetch = createFetchMock([{ status: 200, body: { choices: [{ message: { content: JSON.stringify(notAListing) } }] } }]);
  const result = await callProvider(get("groq"), { ...baseCallOpts(), fetchImpl: mockFetch });
  assert.equal(result.status, "ok");
  assert.equal(result.llmVerdict.notAListing, true, "notAListing flag must pass through untouched");
  assert.equal(result.llmVerdict.llmScore, 0);
});

test("no API key: no_key error with zero fetch calls (§6)", async () => {
  const mockFetch = createFetchMock([]);
  const result = await callProvider(get("groq"), { ...baseCallOpts(), apiKey: "", fetchImpl: mockFetch });
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "no_key");
  assert.equal(mockFetch.calls.length, 0);
});

test("no model configured: no_model error with zero fetch calls (openai/anthropic/ollama/custom)", async () => {
  const mockFetch = createFetchMock([]);
  const result = await callProvider(get("openai"), { ...baseCallOpts(), model: null, fetchImpl: mockFetch });
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "no_model");
  assert.equal(mockFetch.calls.length, 0);
});

test("ollama (authStyle none) runs without an API key", async () => {
  const mockFetch = createFetchMock([{ status: 200, body: { choices: [{ message: { content: JSON.stringify(VALID_VERDICT) } }] } }]);
  const result = await callProvider(get("ollama"), {
    ...baseCallOpts(),
    apiKey: null,
    model: "llama3.1:8b",
    fetchImpl: mockFetch,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.llmVerdict.llmScore, 40);
});

test("gemini response parses end-to-end (candidates → parts[].text, usageMetadata)", async () => {
  const gemBody = {
    candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_VERDICT) }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  };
  const mockFetch = createFetchMock([{ status: 200, body: gemBody }]);
  const result = await callProvider(get("gemini"), { ...baseCallOpts(), model: "gemini-2.5-flash", fetchImpl: mockFetch });
  assert.equal(result.status, "ok");
  assert.equal(result.llmVerdict.llmScore, 40);
  assert.equal(result.provider.id, "gemini");
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 20);
});

test("anthropic tool-use response parses end-to-end (content → tool_use.input)", async () => {
  const anthBody = {
    content: [{ type: "tool_use", name: "submit_risk_verdict", input: VALID_VERDICT }],
    usage: { input_tokens: 5, output_tokens: 7 },
  };
  const mockFetch = createFetchMock([{ status: 200, body: anthBody }]);
  const result = await callProvider(get("anthropic"), {
    ...baseCallOpts(),
    model: "claude-sonnet-4-latest",
    fetchImpl: mockFetch,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.llmVerdict.llmScore, 40);
  assert.equal(result.usage.inputTokens, 5);
});

// ─── §9.2 no-vision-model + §4.3 vision pipeline ────────────────────────────

test("§9.2 no-vision-model: skippedReason set, text-only analysis still runs", async () => {
  const plan = planVision({ enabled: true, adapter: get("groq"), model: "llama-3.3-70b-versatile" });
  assert.equal(plan.use, false);
  assert.match(plan.skippedReason, /does not support image input/);

  const mockFetch = createFetchMock([{ status: 200, body: { choices: [{ message: { content: JSON.stringify(VALID_VERDICT) } }] } }]);
  const result = await callProvider(get("groq"), { ...baseCallOpts(), fetchImpl: mockFetch });
  assert.equal(result.status, "ok", "text analysis runs fine without vision");
  assert.equal(mockFetch.calls.length, 1);
});

test("planVision: disabled/enabled/capability matrix", () => {
  assert.equal(planVision({ enabled: false, adapter: get("gemini"), model: "gemini-2.5-flash" }).use, false);
  assert.match(planVision({ enabled: false, adapter: get("gemini"), model: "gemini-2.5-flash" }).skippedReason, /disabled/);
  assert.equal(planVision({ enabled: true, adapter: get("gemini"), model: "gemini-2.5-flash" }).use, true);
  assert.equal(planVision({ enabled: true, adapter: get("gemini"), model: "gemini-2.5-flash" }).skippedReason, null);
  assert.equal(planVision({ enabled: true, adapter: get("gemini"), model: "some-future-model" }).use, false);
  assert.match(planVision({ enabled: true, adapter: get("gemini"), model: "some-future-model" }).skippedReason, /does not support image input/);
  assert.equal(planVision({ enabled: true, adapter: null, model: "gemini-2.5-flash" }).use, false);
});

test("buildImageParts performs ZERO fetches when the model has no vision capability", async () => {
  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    throw new Error("must not fetch");
  };
  const res = await buildImageParts([{ url: "https://img.example/a.jpg" }], get("groq"), {
    enabled: true,
    model: "llama-3.3-70b-versatile",
    fetchImpl,
  });
  assert.equal(res.parts.length, 0);
  assert.match(res.skippedReason, /does not support image input/);
  assert.equal(fetched, 0);
});

test("buildImageParts shapes parts per provider: gemini inlineData / anthropic / openai image_url (§4.3)", async () => {
  const decode = async () => ({ mimeType: "image/jpeg", base64: "AAAA" });
  const fetchImpl = createFetchMock([
    { status: 200, body: "" },
    { status: 200, body: "" },
    { status: 200, body: "" },
  ]);

  const gem = await buildImageParts([{ url: "a" }, { url: "b" }], get("gemini"), {
    enabled: true, model: "gemini-2.5-flash", fetchImpl, decode,
  });
  assert.equal(gem.parts.length, 2);
  assert.deepEqual(gem.parts[0], { inlineData: { mimeType: "image/jpeg", data: "AAAA" } });

  const anth = await buildImageParts([{ url: "a" }], get("anthropic"), {
    enabled: true, model: "claude-sonnet-4-latest", fetchImpl, decode,
  });
  assert.deepEqual(anth.parts[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });

  const oa = await buildImageParts([{ url: "a" }], get("openai"), {
    enabled: true, model: "gpt-4o", fetchImpl, decode,
  });
  assert.deepEqual(oa.parts[0], { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } });
});

test("buildImageParts skips per-image failures with a note, never fails the analysis (§4.3)", async () => {
  const fetchImpl = async (url) => {
    if (url === "good") return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: false, status: 403, text: async () => "forbidden" };
  };
  const res = await buildImageParts([{ url: "bad" }, { url: "good" }], get("gemini"), {
    enabled: true,
    model: "gemini-2.5-flash",
    fetchImpl,
    decode: async () => ({ mimeType: "image/jpeg", base64: "x" }),
  });
  assert.equal(res.parts.length, 1);
  assert.equal(res.analyzedCount, 1);
  assert.equal(res.attemptedCount, 2);
  assert.ok(res.notes.some((n) => n.includes("403")), "failure note must mention the image");
});

test("buildImageParts caps at MAX_IMAGES=3 and honors constants (§4.3)", async () => {
  assert.equal(MAX_IMAGES, 3);
  assert.equal(MAX_EDGE_PX, 768);
  assert.equal(JPEG_QUALITY, 0.7);
  const fetchImpl = createFetchMock([{ status: 200, body: "" }, { status: 200, body: "" }, { status: 200, body: "" }, { status: 200, body: "" }]);
  const urls = [1, 2, 3, 4].map((i) => ({ url: `u${i}` }));
  const res = await buildImageParts(urls, get("gemini"), {
    enabled: true,
    model: "gemini-2.5-flash",
    fetchImpl,
    decode: async () => ({ mimeType: "image/jpeg", base64: "x" }),
  });
  assert.equal(res.attemptedCount, 3);
  assert.equal(fetchImpl.calls.length, 3);
});

test("buildImageParts: vision disabled in settings → skippedReason, zero fetches", async () => {
  let fetched = 0;
  const res = await buildImageParts([{ url: "a" }], get("gemini"), {
    enabled: false,
    model: "gemini-2.5-flash",
    fetchImpl: async () => { fetched += 1; throw new Error("must not fetch"); },
  });
  assert.equal(res.parts.length, 0);
  assert.match(res.skippedReason, /disabled in settings/);
  assert.equal(fetched, 0);
});

// ─── source-level guarantees ────────────────────────────────────────────────

/**
 * Strip comments so the scan only inspects executable code (JSDoc `import()`
 * type annotations are compile-time references, not dynamic imports).
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("pure llm modules contain zero network surface (fetch/XMLHttpRequest/dynamic import)", () => {
  const files = [
    new URL("../src/llm/parse.js", import.meta.url),
    new URL("../src/llm/schema.js", import.meta.url),
    new URL("../src/llm/prompt.js", import.meta.url),
    new URL("../src/llm/providers/registry.js", import.meta.url),
    new URL("../src/llm/providers/constants.js", import.meta.url),
    new URL("../src/llm/providers/openai-compat.js", import.meta.url),
    ...list().map((p) => new URL(`../src/llm/providers/${p.id}.js`, import.meta.url)),
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
