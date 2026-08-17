/**
 * service-worker.test.js — Phase 5: Service Worker Orchestration (node:test,
 * zero runtime deps, no chrome APIs — everything runs through the injectable
 * stores + fetch seam).
 *
 * §9.2 flow rows driven through the SW message contract (ANALYZE → RESULT):
 *   - scammy listing    → High-Risk RiskReport (+ §0.6 persist-before-fetch)
 *   - provider-500      → exactly 1 retry, then the §6 server_error message
 *   - provider-429      → NO retry + the §6 rate-limit message
 *   - provider-timeout  → §6 timeout message (fake timers)
 *   - malformed-json    → single repair retry → heuristic-only report
 *                         (confidence "low")
 *   - not-a-listing     → NoAnalysis result, NEVER a 0-score report
 *   - no-key            → NoKey result, zero network
 *   - openrouter-gone   → the SPECIFIC §6 rotation message
 * Plus: no-model, no-listing pre-check, GET_LISTING/TEST_CONNECTION/GET_STATE
 * handlers, the §6 error-message table coverage, and source-level guarantees
 * (importable without chrome, relative-only imports).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createServiceWorkerApp } from "../src/background/service-worker.js";
import { OPENROUTER_DEFAULT_MODEL } from "../src/llm/providers/constants.js";
import { createMemoryStorageBackend } from "../src/shared/browser-api.js";
import { createSettingsStore } from "../src/storage/settings.js";
import { createHistoryStore } from "../src/storage/history.js";
import { createSessionStore, SESSION_KEY } from "../src/storage/session.js";
import { CORE_FACT } from "../src/shared/constants.js";
import {
  ERROR_MESSAGES,
  getErrorMessage,
  renderMessage,
  PAYMENT_LLM_UNAVAILABLE_MESSAGE,
} from "../src/shared/error-messages.js";
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

/** @param {object} [overrides] @returns {import("../src/storage/settings.js").ProviderSettings} */
function makeSettings(overrides = {}) {
  return {
    providerId: "groq",
    apiKey: "test-key",
    modelOverride: null,
    customEndpoint: null,
    visionEnabled: false,
    lastTestedAt: null,
    lastTestResult: null,
    ...overrides,
  };
}

/** @param {object} [overrides] @returns {Record<string, unknown>} valid §4.5 verdict */
function makeVerdict(overrides = {}) {
  return {
    llmScore: 40,
    notAListing: false,
    redFlags: [{ id: "NEW_SELLER", label: "New seller", severity: "medium", explanation: "Account is new." }],
    summary: "Listing shows moderate patterns consistent with the heuristic signals.",
    checklistAdditions: [],
    visionNotes: [],
    ...overrides,
  };
}

/**
 * Build an app wired to in-memory stores + an injectable fetch. All three
 * stores share one memory backend (distinct keys, mirrors the local/session
 * split in production). `sleep` defaults to a no-op so the 5xx backoff never
 * costs real time in tests.
 *
 * @param {object} [overrides]
 * @returns {{ app: ReturnType<typeof createServiceWorkerApp>, backend: ReturnType<typeof createMemoryStorageBackend>, settings: ReturnType<typeof createSettingsStore>, history: ReturnType<typeof createHistoryStore>, session: ReturnType<typeof createSessionStore> }}
 */
function makeApp(overrides = {}) {
  const backend = overrides.backend ?? createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl: overrides.fetchImpl ?? createFetchMock([]),
    sleep: overrides.sleep ?? (async () => {}),
    sendToTab: overrides.sendToTab,
    runNuancePassFn: overrides.runNuancePassFn,
    // Read Date.now at CALL time, not construction time — otherwise a fake
    // timer mock installed after makeApp() wouldn't be seen by the SW.
    now: overrides.now ?? (() => Date.now()),
  });
  return {
    app,
    backend,
    settings: createSettingsStore(backend),
    history: createHistoryStore(backend),
    session: createSessionStore(backend),
  };
}

/** Standard groq success body for a verdict. @param {object} verdict */
function groqBody(verdict) {
  return { choices: [{ message: { content: JSON.stringify(verdict) } }] };
}

// ─── §9.2 scammy listing → High-Risk RiskReport ─────────────────────────────

test("§9.2 scammy listing: heuristics-first, §0.6 persist-before-fetch, High-Risk RiskReport", async () => {
  // laptops midpoint = 102500 → 0.3× = 30750 (> 5000 so the photo signal fires).
  const price = 30750;
  const listing = makeListing({
    title: "HP Pavilion Laptop",
    description: "HP Pavilion 15 laptop. pay advance via UPI, urgent sale today only.",
    price: { amount: price, currency: "INR", raw: `₹ ${price}` },
    imageCount: 0,
    sellerItemsListed: 1,
    sellerMemberSince: "Jan 2026",
  });

  const scamVerdict = makeVerdict({
    llmScore: 90,
    redFlags: [{ id: "ADVANCE_FEE_REQUEST", label: "Advance payment requested", severity: "high", explanation: "Seller demands advance before meeting." }],
  });

  const { app, backend, settings, history, session } = makeApp({
    fetchImpl: createFetchMock([
      // The mock runs AT fetch time — prove the §0.6 session write already
      // happened (status "analyzing" + listing + heuristics) before the wire.
      () => {
        const snap = backend.snapshot();
        assert.equal(snap[SESSION_KEY]?.status, "analyzing", "§0.6: in-flight state persisted BEFORE the fetch");
        assert.ok(snap[SESSION_KEY]?.listing, "§0.6: listing persisted before fetch");
        assert.ok(snap[SESSION_KEY]?.heuristics, "§0.6: heuristics persisted before fetch");
        return { status: 200, body: groqBody(scamVerdict) };
      },
    ]),
  });
  await settings.set(makeSettings());

  const response = await app.handleMessage({ type: "ANALYZE", listing });

  assert.equal(response.ok, true);
  assert.equal(response.type, "RESULT");
  assert.equal(response.result.kind, "report");

  const report = response.result.report;
  assert.equal(report.score, 95, "round(0.45*100 + 0.55*90) = 95");
  assert.equal(report.verdict, "High-Risk", "95 ∈ 75–100");
  assert.equal(report.confidence, "high");
  assert.equal(typeof report.reportId, "string");
  assert.equal(report.listingUrl, listing.url);
  assert.equal(report.listingTitle, listing.title);

  // Red flags merge heuristic + LLM flags, deduped by id (heuristic wins).
  const ids = report.redFlags.map((f) => f.id);
  assert.ok(ids.includes("PRICE_ANOMALY"), `ids: ${ids}`);
  assert.ok(ids.includes("ADVANCE_FEE_REQUEST"), `ids: ${ids}`);
  assert.ok(ids.includes("OFF_PLATFORM_PAYMENT_ONLY"), `ids: ${ids}`);
  assert.ok(report.redFlags.every((f) => ["heuristic", "llm"].includes(f.source)));
  assert.equal(report.redFlags.find((f) => f.id === "ADVANCE_FEE_REQUEST").source, "heuristic", "deterministic flag wins over LLM duplicate");

  assert.ok(report.summary.length > 0);
  assert.ok(report.checklist.length >= 5, "base checklist + additions");
  assert.deepEqual(report.reportingResources.map((r) => r.value), ["cybercrime.gov.in", "1930"]);
  assert.equal(report.provider.id, "groq");
  assert.equal(report.provider.model, "llama-3.3-70b-versatile");
  assert.equal(report.rawListing, listing);

  // §1.1 step 8: history saved + session marked done.
  const historyList = await history.list();
  assert.equal(historyList.length, 1);
  assert.equal(historyList[0].reportId, report.reportId);
  assert.equal((await session.get()).status, "done");
});

test("legit listing fuses to a Safe verdict through the message contract", async () => {
  const legit = makeVerdict({ llmScore: 5 });
  const { app, settings } = makeApp({
    fetchImpl: createFetchMock([{ status: 200, body: groqBody(legit) }]),
  });
  await settings.set(makeSettings());

  const response = await app.handleMessage({ type: "ANALYZE", listing: makeListing() });
  assert.equal(response.result.kind, "report");
  assert.equal(response.result.report.verdict, "Safe", "heuristic 5 + llm 5 → ≤ 24 → Safe");
  assert.ok(response.result.report.score <= 24);
});

// ─── §9.2 provider-500 ───────────────────────────────────────────────────────

test("§9.2 provider-500: exactly 1 retry, then the §6 server_error message, heuristics stay visible", async () => {
  const fetchImpl = createFetchMock([
    { status: 500, body: { error: { message: "internal error" } } },
    { status: 500, body: { error: { message: "internal error" } } },
  ]);
  const { app, settings, session } = makeApp({ fetchImpl });

  await settings.set(makeSettings());
  const response = await app.handleMessage({ type: "ANALYZE", listing: makeListing() });

  assert.equal(fetchImpl.calls.length, 2, "5xx retries exactly once (§6)");
  assert.equal(response.ok, true);
  assert.equal(response.result.kind, "error");
  assert.equal(response.result.errorCode, "server_error");
  assert.equal(
    response.result.message,
    "Groq is having trouble on their end right now.",
    "§6 server_error copy verbatim",
  );
  assert.equal(response.result.retried, true);
  assert.equal(response.result.action, "tryAgain");
  assert.ok(response.result.heuristics, "§2.7: heuristic block stays visible on errors");
  assert.equal(await session.get(), null, "session cleared on terminal error");
});

// ─── §9.2 provider-429 ───────────────────────────────────────────────────────

test("§9.2 provider-429: NO retry + §6 rate-limit message", async () => {
  const fetchImpl = createFetchMock([{ status: 429, body: { error: { message: "rate limited" } } }]);
  const { app, settings } = makeApp({ fetchImpl });
  await settings.set(makeSettings());

  const response = await app.handleMessage({ type: "ANALYZE", listing: makeListing() });

  assert.equal(fetchImpl.calls.length, 1, "429 must never auto-retry (§6)");
  assert.equal(response.result.kind, "error");
  assert.equal(response.result.errorCode, "rate_limited");
  assert.equal(
    response.result.message,
    "Groq rate-limited this request. Free tiers reset over time — try again shortly, or switch providers in Settings.",
  );
  assert.equal(response.result.retried, false);
});

// ─── §9.2 provider-timeout ───────────────────────────────────────────────────

test("§9.2 provider-timeout: §6 timeout message surfaces (fake timers, no retry at full timeout)", async (t) => {
  const fetchImpl = createFetchMock([{ never: true }]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });
  await createSettingsStore(backend).set(makeSettings()); // groq timeoutMs = 12000

  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const pending = app.handleMessage({ type: "ANALYZE", listing: makeListing() });
    // The abort timer is only created after the SW's storage/vision microtask
    // hops reach callProvider — let the flow get to the fetch first, THEN
    // tick so the mocked timer actually exists to fire.
    await new Promise((resolve) => setImmediate(resolve));
    timers.tick(13000); // fires the AbortController timeout (12s)
    await new Promise((resolve) => setImmediate(resolve)); // let the abort rejection settle
    const response = await pending;

    assert.equal(fetchImpl.calls.length, 1, "elapsed ≈ timeoutMs → no retry (§6)");
    assert.equal(response.ok, true);
    assert.equal(response.result.kind, "error");
    assert.equal(response.result.errorCode, "timeout");
    assert.equal(
      response.result.message,
      "Groq didn't respond in time. Your heuristic pre-check is above — you can try again or switch providers.",
      "§6 timeout copy verbatim (with the pre-check phrase)",
    );
    assert.equal(response.result.action, "tryAgain");
  } finally {
    timers.reset();
  }
});

// ─── §9.2 malformed-json ─────────────────────────────────────────────────────

test("§9.2 malformed-json: 1 repair retry, then heuristic-only report with confidence low", async () => {
  const garbage = { choices: [{ message: { content: "here's your analysis: {broken" } }] };
  const fetchImpl = createFetchMock([
    { status: 200, body: garbage },
    { status: 200, body: garbage },
  ]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });
  await createSettingsStore(backend).set(makeSettings());

  const response = await app.handleMessage({ type: "ANALYZE", listing: makeListing() });

  assert.equal(fetchImpl.calls.length, 2, "original + exactly one repair attempt (§6)");
  assert.equal(response.result.kind, "report");
  const report = response.result.report;
  assert.equal(report.confidence, "low", "heuristic-only fallback confidence is low");
  assert.equal(
    report.summary,
    "The AI's response couldn't be read reliably — showing rule-based check only.",
    "§6 note rendered in the report summary",
  );
  assert.equal(report.provider.usedFallbackRepair, true);
  // Default fixture: 20000 vs laptops midpoint 102500 → ratio 0.195 → 30 pts.
  assert.equal(report.score, 30, "heuristicScore stands alone on the parse-failure path");
  assert.equal((await createSessionStore(backend).get()).status, "done");
});

// ─── §9.2 not-a-listing ──────────────────────────────────────────────────────

test("§9.2 not-a-listing: distinct NoAnalysis result, never a 0-score RiskReport", async () => {
  const notAListing = makeVerdict({
    llmScore: 0,
    notAListing: true,
    summary: "This does not appear to be a listing page.",
  });
  const fetchImpl = createFetchMock([{ status: 200, body: groqBody(notAListing) }]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });
  await createSettingsStore(backend).set(makeSettings());

  const response = await app.handleMessage({ type: "ANALYZE", listing: makeListing() });

  assert.equal(response.result.kind, "noAnalysis");
  assert.equal(response.result.message, ERROR_MESSAGES.no_analysis.message);
  assert.equal(response.result.report, undefined, "no report object for NoAnalysis");
  assert.deepEqual(await createHistoryStore(backend).list(), [], "NoAnalysis is never saved to history");
  assert.equal(await createSessionStore(backend).get(), null, "session cleared");
});

// ─── §9.2 no-key ─────────────────────────────────────────────────────────────

test("§9.2 no-key: NoKey result with zero network calls (§6 row 1)", async () => {
  const fetchImpl = createFetchMock([]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });
  await createSettingsStore(backend).set(makeSettings({ apiKey: "" }));

  const response = await app.handleMessage({ type: "ANALYZE", listing: makeListing() });

  assert.equal(fetchImpl.calls.length, 0, "no key → no fetch");
  assert.equal(response.ok, true);
  assert.equal(response.result.kind, "noKey");
  assert.equal(response.result.message, "No API key set for this provider. Open Settings to add one.");
  assert.equal(response.result.action, "openSettings");
  assert.ok(response.result.heuristics, "heuristic block still delivered");
  assert.deepEqual(await createHistoryStore(backend).list(), []);
});

// ─── §9.2 openrouter-model-gone ──────────────────────────────────────────────

test("§9.2 openrouter-model-gone: the SPECIFIC §6 rotation message, no generic error", async () => {
  assert.equal(OPENROUTER_DEFAULT_MODEL, "openai/gpt-oss-20b:free");
  const fetchImpl = createFetchMock([
    {
      status: 404,
      body: { error: { message: "The model openai/gpt-oss-20b:free does not exist or you do not have access to it." } },
    },
  ]);
  const { app, settings } = makeApp({ fetchImpl });
  await settings.set(makeSettings({ providerId: "openrouter" }));

  const response = await app.handleMessage({ type: "ANALYZE", listing: makeListing() });

  assert.equal(fetchImpl.calls.length, 1, "model rotation surfaces, never silently retried");
  assert.equal(response.result.kind, "error");
  assert.equal(response.result.errorCode, "model_not_found");
  assert.equal(response.result.message, ERROR_MESSAGES.model_not_found.message);
  assert.equal(response.result.action, "switchProvider");
});

// ─── no-model + no-listing defensive rows ────────────────────────────────────

test("no model configured (openai preset, no override): no_model error, zero fetches", async () => {
  const fetchImpl = createFetchMock([]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });
  await createSettingsStore(backend).set(makeSettings({ providerId: "openai", apiKey: "k" }));

  const response = await app.handleMessage({ type: "ANALYZE", listing: makeListing() });

  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(response.result.kind, "error");
  assert.equal(response.result.errorCode, "no_model");
  assert.equal(response.result.message, "No model configured for this provider. Set one in Settings.");
});

test("§6 no-listing: extractionConfidence low + <2 fields → NoListing BEFORE any network call", async () => {
  const fetchImpl = createFetchMock([]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });
  await createSettingsStore(backend).set(makeSettings());

  const homePage = makeListing({
    title: null,
    price: { amount: null, currency: "INR", raw: null },
    description: null,
    extractionConfidence: "low",
  });

  const response = await app.handleMessage({ type: "ANALYZE", listing: homePage });

  assert.equal(fetchImpl.calls.length, 0, "never spends a network call on a homepage");
  assert.equal(response.result.kind, "noListing");
  assert.equal(response.result.message, ERROR_MESSAGES.no_listing.message);
  assert.equal(await createSessionStore(backend).get(), null, "no session state for NoListing");
});

test("ANALYZE without a listing object → ok:false", async () => {
  const { app } = makeApp();
  const response = await app.handleMessage({ type: "ANALYZE" });
  assert.equal(response.ok, false);
  assert.match(response.error, /listing/);
});

// ─── GET_LISTING ─────────────────────────────────────────────────────────────

test("GET_LISTING forwards to the content script via sendToTab", async () => {
  let sent;
  const listing = makeListing();
  const { app } = makeApp({
    sendToTab: async (tabId, msg) => {
      sent = { tabId, msg };
      return { ok: true, listing };
    },
  });

  const response = await app.handleMessage({ type: "GET_LISTING", tabId: 7 });
  assert.equal(response.ok, true);
  assert.deepEqual(sent, { tabId: 7, msg: { type: "GET_LISTING" } });
  assert.equal(response.listing, listing);
});

test("GET_LISTING falls back to the sender's tab id and reports failures", async () => {
  const { app } = makeApp({
    sendToTab: async () => {
      throw new Error("no content script");
    },
  });
  const fromSender = await app.handleMessage({ type: "GET_LISTING" }, { sender: { tab: { id: 42 } } });
  assert.equal(fromSender.ok, false);
  assert.match(fromSender.error, /Could not reach the page/);

  const noTab = await app.handleMessage({ type: "GET_LISTING" }, { sender: {} });
  assert.equal(noTab.ok, false);
  assert.match(noTab.error, /No tab id/);
});

// ─── GET_STATE ───────────────────────────────────────────────────────────────

test("GET_STATE returns the done/report session after analysis", async () => {
  const { app, settings } = makeApp({
    fetchImpl: createFetchMock([{ status: 200, body: groqBody(makeVerdict()) }]),
  });
  await settings.set(makeSettings());
  await app.handleMessage({ type: "ANALYZE", listing: makeListing() });

  const state = await app.handleMessage({ type: "GET_STATE" });
  assert.equal(state.ok, true);
  assert.equal(state.session.status, "done");
  assert.equal(state.stale, false);
  assert.equal(state.message, null);
});

test("GET_STATE flags a stale analyzing session with the §6 interrupted message", async () => {
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl: createFetchMock([]),
    sleep: async () => {},
    now: () => Date.now(),
  });
  await createSettingsStore(backend).set(makeSettings());
  const oldStartedAt = new Date(Date.now() - 30000).toISOString();
  await backend.set({ [SESSION_KEY]: { status: "analyzing", startedAt: oldStartedAt } });

  const state = await app.handleMessage({ type: "GET_STATE" });
  assert.equal(state.ok, true);
  assert.equal(state.session.status, "analyzing");
  assert.equal(state.stale, true, "older than timeoutMs + 5s grace");
  assert.equal(state.message, ERROR_MESSAGES.interrupted.message);
});

// ─── CHECK_MESSAGE (§2.5 / §4.7 Message & Payment Check) ────────────────────

/** @param {object} [overrides] @returns {import("../src/payment-check/match.js").PaymentCheckInput} */
function makePaymentInput(overrides = {}) {
  return {
    mode: "pastedText",
    rawText: "buyer said just scan this QR to get the payment",
    guidedAnswers: null,
    listingContext: null,
    ...overrides,
  };
}

test("CHECK_MESSAGE scan-to-receive: LikelyScam + coreFact with ZERO provider calls when no key is configured", async () => {
  const fetchImpl = createFetchMock([]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });
  await createSettingsStore(backend).set(makeSettings({ apiKey: "" }));

  const response = await app.handleMessage({ type: "CHECK_MESSAGE", input: makePaymentInput() });

  assert.equal(response.ok, true);
  assert.equal(response.report.verdict, "LikelyScam", "pattern pass alone produces LikelyScam (§4.7)");
  assert.ok(
    response.report.matchedPatterns.some((p) => p.id === "SCAN_TO_RECEIVE"),
    `ids: ${response.report.matchedPatterns.map((p) => p.id)}`,
  );
  assert.equal(response.report.coreFact, CORE_FACT, "coreFact always populated, even with no provider (§4.7)");
  assert.ok(response.report.summary.length > 0, "deterministic summary present");
  assert.equal(typeof response.report.reportId, "string");
  assert.match(response.report.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fetchImpl.calls.length, 0, "no key → the LLM nuance pass is skipped entirely: zero network");
});

test("CHECK_MESSAGE returns the pattern result + coreFact even when the mocked LLM nuance pass rejects", async () => {
  const { app, settings } = makeApp({
    runNuancePassFn: async () => {
      throw new Error("provider offline");
    },
  });
  await settings.set(makeSettings()); // key configured — the nuance pass runs and fails

  const response = await app.handleMessage({
    type: "CHECK_MESSAGE",
    input: makePaymentInput({ rawText: "scan this qr to get the payment" }),
  });

  assert.equal(response.ok, true);
  assert.equal(response.report.verdict, "LikelyScam", "throwing nuance pass must never block the pattern result");
  assert.ok(response.report.matchedPatterns.some((p) => p.id === "SCAN_TO_RECEIVE"));
  assert.equal(response.report.coreFact, CORE_FACT, "coreFact survives an LLM failure (§4.7 / §6)");
  assert.ok(response.report.summary.length > 0);
});

test("CHECK_MESSAGE applies LLM-nuance adjustments when the pass succeeds (warning-to-others softened)", async () => {
  const { app, settings } = makeApp({
    runNuancePassFn: async (input, report) => {
      assert.equal(report.verdict, "LikelyScam", "seam receives the deterministic pattern result");
      assert.equal(report.coreFact, CORE_FACT);
      return {
        verdict: "NoRedFlagsFound",
        summary: "This text warns other people about this scam — it is not an instruction the user should act on.",
      };
    },
  });
  await settings.set(makeSettings());

  const response = await app.handleMessage({
    type: "CHECK_MESSAGE",
    input: makePaymentInput({ rawText: "scan this qr to get the payment" }),
  });

  assert.equal(response.ok, true);
  assert.equal(response.report.verdict, "NoRedFlagsFound", "nuance pass softens the verdict (§4.7)");
  assert.match(response.report.summary, /warns other people/);
  assert.equal(response.report.coreFact, CORE_FACT, "coreFact always populated");
  assert.ok(
    response.report.matchedPatterns.some((p) => p.id === "SCAN_TO_RECEIVE"),
    "patterns still reported after softening",
  );
});

test("CHECK_MESSAGE runs the real LLM nuance pass over the configured provider (exactly one fetch, no repair retry)", async () => {
  // A standard OpenAI-compatible nuance response (groq preset).
  const nuanceBody = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            verdict: "Caution",
            summary: "Context unclear — confirm who you are dealing with before acting.",
            reasoning: "ambiguous framing",
          }),
        },
      },
    ],
  };
  const fetchImpl = createFetchMock([{ status: 200, body: nuanceBody }]);
  const { app, settings } = makeApp({ fetchImpl });
  await settings.set(makeSettings()); // groq + key configured

  const response = await app.handleMessage({
    type: "CHECK_MESSAGE",
    input: makePaymentInput({
      rawText: "approve the payment request for the refund",
    }),
  });

  assert.equal(response.ok, true);
  assert.equal(fetchImpl.calls.length, 1, "additive pass is a single request — no repair retry (§4.7)");
  assert.equal(response.report.verdict, "Caution", "nuance verdict applied");
  assert.match(response.report.summary, /Context unclear/);
  assert.equal(response.report.coreFact, CORE_FACT);
  assert.ok(
    response.report.matchedPatterns.some((p) => p.id === "COLLECT_REQUEST_FRAMED_AS_REFUND"),
    "local pattern match stays authoritative",
  );
});

test("CHECK_MESSAGE without an input object → ok:false", async () => {
  const { app } = makeApp();
  const response = await app.handleMessage({ type: "CHECK_MESSAGE" });
  assert.equal(response.ok, false);
  assert.match(response.error, /input/);
});

// ─── GET_HISTORY (§2.3 / §8) ─────────────────────────────────────────────────

test("GET_HISTORY returns saved RiskReports after an ANALYZE flow", async () => {
  const { app, settings } = makeApp({
    fetchImpl: createFetchMock([{ status: 200, body: groqBody(makeVerdict()) }]),
  });
  await settings.set(makeSettings());
  await app.handleMessage({ type: "ANALYZE", listing: makeListing() });

  const response = await app.handleMessage({ type: "GET_HISTORY" });
  assert.equal(response.ok, true);
  assert.ok(Array.isArray(response.history));
  assert.equal(response.history.length, 1);
  assert.equal(typeof response.history[0].reportId, "string");
  assert.equal(response.history[0].listingTitle, "HP Pavilion 15");
  // The fixture's heuristic score (price anomaly on 20000 vs ~102500 midpoint)
  // fuses to the "Review" band — assert it's a valid §5.3 verdict, not a guess.
  assert.ok(
    ["Safe", "Review", "Suspicious", "High-Risk"].includes(response.history[0].verdict),
    `verdict: ${response.history[0].verdict}`,
  );
  assert.equal(typeof response.history[0].score, "number", "score is numeric");
});

test("GET_HISTORY returns an empty list before any analysis", async () => {
  const { app } = makeApp();
  const response = await app.handleMessage({ type: "GET_HISTORY" });
  assert.equal(response.ok, true);
  assert.deepEqual(response.history, []);
});

// ─── TEST_CONNECTION (§3.6) ──────────────────────────────────────────────────

test("TEST_CONNECTION success: §3.6 message + lastTestResult persisted", async () => {
  const fetchImpl = createFetchMock([
    { status: 200, body: { choices: [{ message: { content: JSON.stringify({ ok: true }) } }] } },
  ]);
  const backend = createMemoryStorageBackend();
  const settings = createSettingsStore(backend);
  const app = createServiceWorkerApp({
    settingsStore: settings,
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });

  const response = await app.handleMessage({
    type: "TEST_CONNECTION",
    providerId: "groq",
    apiKey: "sk-test",
    model: "llama-3.3-70b-versatile",
  });

  assert.equal(response.ok, true);
  assert.match(response.message, /^Connected — llama-3.3-70b-versatile responded in \d+ms\.$/);
  const stored = await settings.get();
  assert.equal(stored.lastTestResult, "success");
  assert.ok(stored.lastTestedAt, "timestamp persisted (§3.6 step 4)");
});

test("TEST_CONNECTION 401: the §3.6 verbatim 'key rejected' message + failure recorded", async () => {
  const fetchImpl = createFetchMock([{ status: 401, body: { error: { message: "unauthorized" } } }]);
  const backend = createMemoryStorageBackend();
  const settings = createSettingsStore(backend);
  const app = createServiceWorkerApp({
    settingsStore: settings,
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });

  const response = await app.handleMessage({
    type: "TEST_CONNECTION",
    providerId: "groq",
    apiKey: "bad-key",
    model: "llama-3.3-70b-versatile",
  });

  assert.equal(response.ok, false);
  assert.equal(response.message, "Key rejected by provider. Double-check you copied the full key.");
  assert.equal((await settings.get()).lastTestResult, "failure");
});

test("TEST_CONNECTION unknown provider → ok:false, no fetch", async () => {
  const fetchImpl = createFetchMock([]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });
  const response = await app.handleMessage({
    type: "TEST_CONNECTION",
    providerId: "nope",
    apiKey: "k",
    model: "m",
  });
  assert.equal(response.ok, false);
  assert.equal(response.message, "Unknown provider.");
  assert.equal(fetchImpl.calls.length, 0);
});

test("TEST_CONNECTION 429: the §3.6 verbatim 'key is valid' rate-limit message", async () => {
  const fetchImpl = createFetchMock([{ status: 429, body: { error: { message: "rate limited" } } }]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });

  const response = await app.handleMessage({
    type: "TEST_CONNECTION",
    providerId: "groq",
    apiKey: "valid-but-limited",
    model: "llama-3.3-70b-versatile",
  });

  assert.equal(response.ok, false);
  assert.equal(
    response.message,
    "Provider rate-limited this key right now. Your key is valid — try again in a minute.",
  );
});

test("TEST_CONNECTION malformed JSON back: the §3.6 verbatim structured-output message", async () => {
  const fetchImpl = createFetchMock([
    { status: 200, body: { choices: [{ message: { content: "sure, here you go" } }] } },
  ]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });

  const response = await app.handleMessage({
    type: "TEST_CONNECTION",
    providerId: "groq",
    apiKey: "k",
    model: "llama-3.3-70b-versatile",
  });

  assert.equal(response.ok, false);
  assert.equal(
    response.message,
    "Connected, but the model's response wasn't valid JSON. This provider/model may not support ScamGuard's structured-output mode — try another model.",
  );
});

test("TEST_CONNECTION timeout: the §3.6 verbatim 'no response within Ns' message (fake timers)", async (t) => {
  const fetchImpl = createFetchMock([{ never: true }]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });

  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const pending = app.handleMessage({
      type: "TEST_CONNECTION",
      providerId: "groq", // timeoutMs 12000
      apiKey: "k",
      model: "llama-3.3-70b-versatile",
    });
    await new Promise((resolve) => setImmediate(resolve)); // reach the fetch + timer
    timers.tick(13000);
    await new Promise((resolve) => setImmediate(resolve));
    const response = await pending;

    assert.equal(response.ok, false);
    assert.equal(
      response.message,
      "No response within 12s. Check your internet connection or try a different provider.",
    );
  } finally {
    timers.reset();
  }
});

// ─── unknown message ─────────────────────────────────────────────────────────

test("unknown message type → ok:false", async () => {
  const { app } = makeApp();
  const response = await app.handleMessage({ type: "FLY_TO_THE_MOON" });
  assert.equal(response.ok, false);
  assert.equal(response.error, "Unknown message type.");
});

// ─── §6 error-message table coverage ─────────────────────────────────────────

test("§6 matrix: every error row has a user-facing message + retry strategy", () => {
  const rowCodes = [
    "no_key",
    "key_rejected",
    "timeout",
    "rate_limited",
    "server_error",
    "network_error",
    "model_not_found",
    "request_failed",
    "no_model",
    "parse_failed",
    "no_listing",
    "no_analysis",
    "interrupted",
  ];
  for (const code of rowCodes) {
    const entry = ERROR_MESSAGES[code];
    assert.ok(entry, `ERROR_MESSAGES must cover §6 row "${code}"`);
    assert.ok(typeof entry.message === "string" && entry.message.length > 0, `${code}: message`);
    assert.ok(typeof entry.retry === "string" && entry.retry.length > 0, `${code}: retry strategy`);
    assert.ok(entry.action === null || typeof entry.action === "string", `${code}: action`);
  }
  // §6 Message & Payment Check LLM-failure note.
  assert.match(PAYMENT_LLM_UNAVAILABLE_MESSAGE, /AI review unavailable right now/);
});

test("getErrorMessage/renderMessage: lookups and {provider} substitution", () => {
  assert.equal(getErrorMessage("timeout"), ERROR_MESSAGES.timeout);
  assert.equal(getErrorMessage("bogus"), undefined);
  assert.equal(getErrorMessage(null), undefined);
  assert.equal(
    renderMessage(ERROR_MESSAGES.server_error.message, { provider: "Cerebras" }),
    "Cerebras is having trouble on their end right now.",
  );
  assert.equal(
    renderMessage(ERROR_MESSAGES.request_failed.message, { provider: "X", status: 418 }),
    "X returned HTTP 418.",
  );
});

// ─── source-level guarantees ─────────────────────────────────────────────────

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("service-worker.js is importable without chrome (no chrome.* at import time)", () => {
  // The import at the top of this file already proves it — nothing here
  // throws in plain Node. Assert the module exposes the factory + binder and
  // that the chrome binding is guarded, not top-level.
  assert.equal(typeof createServiceWorkerApp, "function");
  const code = readFileSync(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
  const stripped = stripComments(code);
  assert.doesNotMatch(stripped, /^chrome\./m, "no chrome.* at module top level");
  assert.match(stripped, /typeof globalThis\.chrome\.runtime\.onMessage/, "auto-bind is guarded");
  assert.doesNotMatch(stripped, /bindToChrome\(\);\s*$/, "bindToChrome is only called inside the guard");
});

test("service-worker + error-messages import only relative src paths (zero runtime deps)", () => {
  const files = [
    new URL("../src/background/service-worker.js", import.meta.url),
    new URL("../src/shared/error-messages.js", import.meta.url),
  ];
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(/^import\s+.*?from\s+["']([^"']+)["']/gm)) {
      const spec = match[1];
      assert.match(spec, /^\.\.?\//, `${file.pathname} must only import relative paths (got "${spec}")`);
    }
  }
});

test("no-key path stays sub-1s: heuristics computed instantly with zero network", async () => {
  const fetchImpl = createFetchMock([]);
  const backend = createMemoryStorageBackend();
  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(backend),
    historyStore: createHistoryStore(backend),
    sessionStore: createSessionStore(backend),
    fetchImpl,
    sleep: async () => {},
    now: () => Date.now(),
  });
  await createSettingsStore(backend).set(makeSettings({ apiKey: "" }));

  const start = Date.now();
  const response = await app.handleMessage({ type: "ANALYZE", listing: makeListing() });
  const elapsed = Date.now() - start;

  assert.equal(response.result.kind, "noKey");
  assert.equal(typeof response.result.heuristics.heuristicScore, "number");
  assert.ok(elapsed < 1000, `heuristics-first must stay sub-1s (took ${elapsed}ms)`);
});
