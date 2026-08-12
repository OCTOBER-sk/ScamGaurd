/**
 * service-worker.js — the §1.1 orchestrator + §6 error-matrix router
 * (PLAN-BACKEND.md §1.1 data flow, §0.6 persist-before-fetch, §3.6 test
 * connection, §6 error matrix, §8 background/ file plan).
 *
 * Implements the full listing-analysis flow:
 *
 *   ANALYZE(listing)
 *     ─ 1. heuristics.run() FIRST (pure sync, instant — §1.1 step 1)
 *     ─ 2. NoListing pre-check (extractionConfidence "low" + <2 required
 *          fields) BEFORE any network call (§6 row) — no session, no fetch
 *     ─ 3. persist {status:"analyzing", listing, heuristics, startedAt} to
 *          chrome.storage.session BEFORE any fetch (§0.6) — a mid-fetch
 *          service-worker restart can detect/report the interruption
 *     ─ 4. provider = registry.get(settings.providerId); model resolved from
 *          settings.modelOverride ?? adapter.defaultModel
 *     ─ 5. [optional] vision.buildImageParts (capability-gated §1.1 step 4)
 *     ─ 6. callProvider: fetch with timeout + §6 retry policy (5xx → 1 retry
 *          ~1.5s; 429 → NO retry; timeout → 1 retry ONLY if elapsed < 50% of
 *          timeoutMs) then tolerantParse → schema.validate → single repair
 *          retry → heuristic-only fallback
 *     ─ 7. scoring.fuse → §2.3 RiskReport
 *     ─ 8. history.save + session.complete, reply RESULT over the channel
 *
 * Message contract (popup → SW via chrome.runtime.sendMessage):
 *   GET_LISTING      { type, tabId? }            → forwards to the content
 *                                                  script; { ok, listing }
 *   ANALYZE          { type, listing }           → { ok, type:"RESULT",
 *                                                  result: AnalyzeResult }
 *   TEST_CONNECTION  { type, providerId, apiKey, model }
 *                                                  → { ok, message } (§3.6)
 *   GET_STATE        { type }                    → { ok, session, stale,
 *                                                  message? }
 *
 * AnalyzeResult is discriminated on `result.kind`:
 *   "report"      full §2.3 RiskReport (fused OR heuristic-only fallback)
 *   "noAnalysis"  LLM returned notAListing:true — never a 0-score report
 *   "noListing"   extraction too weak — never spent a network call
 *   "noKey"       first-run / key cleared (frontend §2.8)
 *   "error"       §6 error row — carries the backend-authored message +
 *                 the heuristic block so it stays visible (§2.7)
 *
 * TESTABILITY: this module is importable in plain Node — zero chrome.*
 * access at import time. Everything is wired through `createServiceWorkerApp`
 * with injected dependencies (stores, fetch, timers, tab bridge); the real
 * chrome binding (`bindToChrome`) is a function the extension's own
 * service-worker entry calls, and it is only invoked in a browser context
 * (guarded auto-bind at the bottom).
 */

import { get as registryGet } from "../llm/providers/registry.js";
import { callProvider } from "../llm/providers/client.js";
import { runTestConnection } from "../llm/providers/test-connection.js";
import { run as heuristicsRun } from "../heuristics/signals.js";
import { buildSystemPrompt, buildUserPrompt } from "../llm/prompt.js";
import { buildImageParts } from "../llm/vision.js";
import { fuse } from "../scoring/fuse.js";
import { REPORTING_RESOURCES } from "../shared/constants.js";
import { getErrorMessage, renderMessage } from "../shared/error-messages.js";
import { createSettingsStore } from "../storage/settings.js";
import { createHistoryStore } from "../storage/history.js";
import { createSessionStore } from "../storage/session.js";
import {
  chromeLocalStorageBackend,
  chromeStorageAreaBackend,
} from "../shared/browser-api.js";

// ─── constants ───────────────────────────────────────────────────────────────

/**
 * Base safe-buying checklist included in EVERY RiskReport (§2.3 checklist).
 * Listing-specific additions from the LLM (checklistAdditions) are appended
 * after these.
 *
 * @type {readonly string[]}
 */
const BASE_CHECKLIST = [
  "Inspect the item in person before paying anything.",
  "Meet in a public place or at the platform's recommended spot.",
  "Never pay an advance, booking fee, or token amount to 'reserve' an item.",
  "Never scan a QR code or approve a payment request to 'receive' money.",
  "Keep the conversation on the platform until the deal is done.",
];

/**
 * §6 row "Non-listing page": a listing only counts as extractable when its
 * extractionConfidence is not "low", OR at least 2 of {title, price, description}
 * were actually recovered. This is checked BEFORE any network call so the SW
 * never spends a provider request on a homepage.
 *
 * @param {import("../shared/types.js").Listing | null | undefined} listing
 * @returns {boolean}
 */
function isExtractableListing(listing) {
  if (!listing || typeof listing !== "object" || Array.isArray(listing)) return false;
  if (listing.extractionConfidence !== "low") return true;
  const present = [
    listing.title,
    listing.price?.amount,
    listing.description,
  ].filter((v) => v !== null && v !== undefined && v !== "").length;
  return present >= 2;
}

// ─── report assembly (§2.3) ──────────────────────────────────────────────────

/**
 * Build the §2.3 redFlags list: deterministic heuristic flags first (source
 * "heuristic"), then LLM flags (source "llm") that don't duplicate an id.
 * LLM duplicates of a heuristic id are dropped — the deterministic flag wins,
 * keeping the list stable and free of contradictory severity reads.
 *
 * @param {import("../shared/types.js").HeuristicSignals | null | undefined} heuristics
 * @param {Record<string, unknown> | null | undefined} llmVerdict
 * @returns {Array<{ id: string; label: string; severity: "low" | "medium" | "high"; explanation: string; source: "heuristic" | "llm" }>}
 */
function mergeRedFlags(heuristics, llmVerdict) {
  const h = heuristics ?? {};
  const flags = [];
  const seen = new Set();

  const pa = h.priceAnomaly ?? {};
  if (pa.triggered === true) {
    flags.push({
      id: "PRICE_ANOMALY",
      label: "Price far below typical market",
      severity: pa.severity === "high" ? "high" : "medium",
      explanation:
        typeof pa.note === "string" && pa.note.length > 0
          ? pa.note
          : "Price is well below the typical range for this item.",
      source: "heuristic",
    });
  }

  const sa = h.sellerAge ?? {};
  if (sa.triggered === true) {
    flags.push({
      id: "NEW_SELLER",
      label: "New or low-activity seller account",
      severity: "medium",
      explanation: "The seller account has little or no listing history.",
      source: "heuristic",
    });
  }

  const ph = h.photoSignals ?? {};
  if (ph.triggered === true) {
    flags.push({
      id: "LOW_PHOTO_COUNT",
      label: "Very few photos for a high-value item",
      severity: "medium",
      explanation: "A high-value item with almost no photos is harder to verify.",
      source: "heuristic",
    });
  }

  const cl = h.contactChannelLeak ?? {};
  if (cl.triggered === true) {
    flags.push({
      id: "CONTACT_CHANNEL_LEAK",
      label: "Contact details shared in the listing",
      severity: "low",
      explanation:
        "Phone/email/WhatsApp details in a listing are a soft risk signal when combined with other flags.",
      source: "heuristic",
    });
  }

  const ul = h.urgencyLanguage ?? {};
  if (ul.triggered === true) {
    flags.push({
      id: "URGENCY_PRESSURE",
      label: "Urgency-pressure language",
      severity: "low",
      explanation: `Pressure phrases matched: ${(ul.matchedPhrases ?? []).join(", ") || "none listed"}.`,
      source: "heuristic",
    });
  }

  const al = h.advanceFeeLanguage ?? {};
  if (al.triggered === true) {
    flags.push({
      id: "ADVANCE_FEE_REQUEST",
      label: "Advance / booking-fee language",
      severity: "high",
      explanation:
        "Advance-payment requests are the top named OLX fraud pattern — never pay to 'reserve' or 'release' an item.",
      source: "heuristic",
    });
  }

  const op = h.offPlatformPaymentLanguage ?? {};
  if (op.triggered === true) {
    flags.push({
      id: "OFF_PLATFORM_PAYMENT_ONLY",
      label: "Off-platform payment demanded",
      severity: "high",
      explanation:
        "The listing pushes payment off the platform — combine with other signals before acting.",
      source: "heuristic",
    });
  }

  for (const flag of flags) seen.add(flag.id.toUpperCase());

  const llmFlags = Array.isArray(llmVerdict?.redFlags) ? llmVerdict.redFlags : [];
  for (const flag of llmFlags) {
    if (!flag || typeof flag !== "object" || Array.isArray(flag)) continue;
    const f = /** @type {Record<string, unknown>} */ (flag);
    const id = typeof f.id === "string" ? f.id.toUpperCase() : "";
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const severity = f.severity === "low" || f.severity === "medium" || f.severity === "high"
      ? f.severity
      : "low";
    flags.push({
      id: typeof f.id === "string" ? f.id : id,
      label: typeof f.label === "string" ? f.label : id,
      severity,
      explanation: typeof f.explanation === "string" ? f.explanation : "",
      source: "llm",
    });
  }

  return flags;
}

/**
 * §2.3 visionAnalysis block. `performed` is true only when at least one image
 * was actually processed; `skippedReason` explains a skip; `notes` merge the
 * per-image pipeline notes with the LLM's own visionNotes.
 *
 * @param {Awaited<ReturnType<typeof buildImageParts>> | null | undefined} vision
 * @param {Record<string, unknown> | null | undefined} llmVerdict
 * @returns {{ performed: boolean; skippedReason: string | null; notes: string[] }}
 */
function buildVisionAnalysis(vision, llmVerdict) {
  const notes = Array.isArray(vision?.notes) ? [...vision.notes] : [];
  const llmNotes = Array.isArray(llmVerdict?.visionNotes) ? llmVerdict.visionNotes : [];
  for (const note of llmNotes) {
    if (typeof note === "string" && note.length > 0) notes.push(note);
  }
  return {
    performed: (vision?.parts?.length ?? 0) > 0,
    skippedReason: typeof vision?.skippedReason === "string" ? vision.skippedReason : null,
    notes,
  };
}

/**
 * Assemble the §2.3 RiskReport from the fusion result. For the heuristic-only
 * fallback (source "heuristic-only") the summary carries the §6 note instead
 * of LLM prose, and `provider` is synthesized from what the SW knows.
 *
 * @param {{
 *   listing: import("../shared/types.js").Listing | null | undefined;
 *   heuristics: import("../shared/types.js").HeuristicSignals | null | undefined;
 *   fusion: ReturnType<typeof fuse>;
 *   llmVerdict: Record<string, unknown> | null | undefined;
 *   vision: Awaited<ReturnType<typeof buildImageParts>> | null | undefined;
 *   provider: { id: string; model: string; latencyMs: number; usedFallbackRepair: boolean };
 *   summaryOverride?: string | null;
 *   uuid: () => string;
 * }} args
 * @returns {Record<string, unknown>}  the §2.3-shaped report.
 */
function buildReport({ listing, heuristics, fusion, llmVerdict, vision, provider, summaryOverride, uuid }) {
  const isHeuristicOnly = fusion.source === "heuristic-only";
  const checklist = [...BASE_CHECKLIST];
  const additions = Array.isArray(llmVerdict?.checklistAdditions) ? llmVerdict.checklistAdditions : [];
  for (const item of additions) {
    if (typeof item === "string" && item.length > 0) checklist.push(item);
  }

  return {
    reportId: uuid(),
    listingUrl: typeof listing?.url === "string" ? listing.url : "",
    listingTitle: typeof listing?.title === "string" ? listing.title : null,
    score: fusion.score,
    verdict: fusion.verdict,
    confidence: fusion.confidence,
    redFlags: mergeRedFlags(heuristics, llmVerdict),
    summary: isHeuristicOnly
      ? summaryOverride ?? "AI review unavailable — showing rule-based check only."
      : typeof llmVerdict?.summary === "string" && llmVerdict.summary.length > 0
        ? llmVerdict.summary
        : "No summary was provided.",
    checklist,
    reportingResources: REPORTING_RESOURCES,
    visionAnalysis: buildVisionAnalysis(vision, llmVerdict),
    provider: provider ?? { id: "unknown", model: "unknown", latencyMs: 0, usedFallbackRepair: false },
    rawListing: listing ?? null,
    createdAt: new Date().toISOString(),
  };
}

// ─── message handling ────────────────────────────────────────────────────────

/**
 * Map a provider-layer error result to the popup-facing §6 message.
 * Known error codes use the canonical ERROR_MESSAGES template (substituting
 * the provider label); the catch-all `request_failed` passes the provider
 * layer's own message through because it carries the HTTP status detail.
 *
 * @param {import("../llm/providers/registry.js").ProviderAdapter | null | undefined} adapter
 * @param {{ errorCode: string; message: string; retried: boolean }} providerError
 * @returns {{ kind: import("../shared/error-messages.js").MessageKind; message: string; action: import("../shared/error-messages.js").ErrorAction; entry: import("../shared/error-messages.js").ErrorMessageEntry | null }}
 */
function resolveErrorMessage(adapter, providerError) {
  const entry = getErrorMessage(providerError.errorCode);
  if (!entry) {
    return {
      kind: "error",
      message: providerError.message ?? "Something went wrong. Try again.",
      action: "tryAgain",
      entry: null,
    };
  }
  if (providerError.errorCode === "request_failed") {
    return { kind: "error", message: providerError.message, action: entry.action, entry };
  }
  return {
    kind: entry.kind,
    message: renderMessage(entry.message, { provider: adapter?.label ?? "" }),
    action: entry.action,
    entry,
  };
}

/**
 * The full §1.1 listing-analysis flow. Returns the ANALYZE response payload
 * (an AnalyzeResult under `result`).
 *
 * Ordering is load-bearing: heuristics first (instant), NoListing pre-check
 * before any network call, THEN the §0.6 persist-before-fetch session write,
 * then the provider call.
 *
 * @param {import("../shared/types.js").Listing} listing
 * @param {import("./service-worker.js").AppDeps} deps
 * @returns {Promise<{ ok: true; type: "RESULT"; result: object }>}
 */
async function runAnalysis(listing, deps) {
  const {
    settingsStore,
    historyStore,
    sessionStore,
    registry,
    callProviderFn,
    heuristicsRunFn,
    buildSystemPromptFn,
    buildUserPromptFn,
    buildImagePartsFn,
    fuseFn,
    fetchImpl,
    sleep,
    now,
    uuid,
  } = deps;

  const heuristics = heuristicsRunFn(listing);

  // §6 row "Non-listing page": extractionConfidence "low" + <2 required
  // fields → NoListing immediately, never a network call.
  if (!isExtractableListing(listing)) {
    return {
      ok: true,
      type: "RESULT",
      result: {
        kind: "noListing",
        message: getErrorMessage("no_listing").message,
        heuristics,
      },
    };
  }

  // §0.6: persist in-flight state BEFORE the fetch so a service-worker
  // restart can detect and report the interruption cleanly.
  await sessionStore.start(listing, heuristics);

  const settings = await settingsStore.get();
  const adapter = registry(settings.providerId);
  if (!adapter) {
    await sessionStore.clear();
    return {
      ok: true,
      type: "RESULT",
      result: {
        kind: "error",
        errorCode: "no_provider",
        message: "Configured provider is unavailable. Open Settings to choose one.",
        action: "openSettings",
        heuristics,
      },
    };
  }

  const model = settings.modelOverride ?? adapter.defaultModel;
  if (!model || typeof model !== "string" || model.length === 0) {
    await sessionStore.clear();
    return {
      ok: true,
      type: "RESULT",
      result: {
        kind: "error",
        errorCode: "no_model",
        message: renderMessage(getErrorMessage("no_model").message, { provider: adapter.label }),
        action: "openSettings",
        retried: false,
        heuristics,
      },
    };
  }

  // §1.1 step 4: optional vision — capability-gated inside buildImageParts
  // (planVision), degrades independently, never fails the analysis.
  let vision = null;
  try {
    vision = await buildImagePartsFn(listing?.images ?? [], adapter, {
      enabled: settings.visionEnabled,
      model,
      fetchImpl,
    });
  } catch {
    vision = { parts: [], skippedReason: "Vision processing failed unexpectedly.", notes: [] };
  }

  const systemPrompt = buildSystemPromptFn();
  const userPrompt = buildUserPromptFn(listing, heuristics);
  const startedAt = now();

  // §1.1 steps 5-6 + the entire §6 retry/repair matrix live in callProvider.
  const providerResult = await callProviderFn(adapter, {
    listing,
    heuristics,
    systemPrompt,
    userPrompt,
    imageParts: vision.parts,
    model,
    apiKey: settings.apiKey,
    timeoutMs: adapter.timeoutMs,
    fetchImpl,
    now,
    sleep,
  });

  const latencyMs = now() - startedAt;

  // ── ok: real verdict ──
  if (providerResult.status === "ok") {
    const llmVerdict = providerResult.llmVerdict;

    // §5.2 notAListing passthrough → distinct NoAnalysis result, NEVER a
    // 0-score RiskReport.
    if (llmVerdict.notAListing === true) {
      await sessionStore.clear();
      return {
        ok: true,
        type: "RESULT",
        result: { kind: "noAnalysis", message: getErrorMessage("no_analysis").message },
      };
    }

    const fusion = fuseFn(heuristics, llmVerdict);
    const report = buildReport({
      listing,
      heuristics,
      fusion,
      llmVerdict,
      vision,
      provider: providerResult.provider,
      uuid,
    });
    await historyStore.add(report);
    await sessionStore.complete(report);
    return { ok: true, type: "RESULT", result: { kind: "report", report } };
  }

  // ── parse-failed: repair exhausted → heuristic-only fallback report ──
  if (providerResult.status === "parse-failed") {
    const fusion = fuseFn(heuristics, null); // confidence "low" (§5.2/§6)
    const report = buildReport({
      listing,
      heuristics,
      fusion,
      llmVerdict: null,
      vision,
      provider: {
        id: adapter.id,
        model,
        latencyMs,
        usedFallbackRepair: true,
      },
      summaryOverride: providerResult.message,
      uuid,
    });
    await historyStore.add(report);
    await sessionStore.complete(report);
    return { ok: true, type: "RESULT", result: { kind: "report", report } };
  }

  // ── error: any §6 row (no_key / key_rejected / timeout / rate_limited /
  // ── server_error / network_error / model_not_found / request_failed) ──
  const mapped = resolveErrorMessage(adapter, providerResult);
  await sessionStore.clear();
  return {
    ok: true,
    type: "RESULT",
    result: {
      kind: mapped.kind,
      errorCode: providerResult.errorCode,
      message: mapped.message,
      action: mapped.action,
      retried: providerResult.retried,
      heuristics,
    },
  };
}

/**
 * GET_LISTING: forward the extract request to the content script in the given
 * tab. The tabId comes from the message (popup sender has no tab) or falls
 * back to the sender's tab when a content script asks.
 *
 * @param {{ tabId?: unknown } | null | undefined} message
 * @param {{ sender?: { tab?: { id?: unknown } } }} context
 * @param {import("./service-worker.js").AppDeps} deps
 * @returns {Promise<{ ok: boolean; listing?: import("../shared/types.js").Listing; error?: string }>}
 */
async function runGetListing(message, context, deps) {
  const tabId = message?.tabId ?? context?.sender?.tab?.id;
  if (typeof tabId !== "number") {
    return { ok: false, error: "No tab id available to extract from." };
  }
  if (typeof deps.sendToTab !== "function") {
    return { ok: false, error: "Tab messaging is not available in this context." };
  }
  try {
    const response = await deps.sendToTab(tabId, { type: "GET_LISTING" });
    if (response && response.ok === true) {
      return { ok: true, listing: response.listing ?? null };
    }
    return { ok: false, error: response?.error ?? "The page could not be extracted." };
  } catch {
    return {
      ok: false,
      error: "Could not reach the page. Try refreshing the tab and opening the extension again.",
    };
  }
}

/**
 * TEST_CONNECTION (§3.6): delegate to the shared runTestConnection (which
 * produces the four outcome messages verbatim) and persist the result +
 * timestamp onto ProviderSettings.lastTestedAt/lastTestResult.
 *
 * @param {{ providerId?: unknown; apiKey?: unknown; model?: unknown } | null | undefined} message
 * @param {import("./service-worker.js").AppDeps} deps
 * @returns {Promise<{ ok: boolean; message: string }>}
 */
async function runTestConnectionFlow(message, deps) {
  const adapter = deps.registry(String(message?.providerId ?? ""));
  if (!adapter) return { ok: false, message: "Unknown provider." };

  const apiKey = typeof message?.apiKey === "string" ? message.apiKey : "";
  const model =
    typeof message?.model === "string" && message.model.length > 0
      ? message.model
      : adapter.defaultModel;
  if (!model) return { ok: false, message: "Set a model for this provider first." };

  const outcome = await deps.runTestConnectionFn(adapter, { apiKey, model, fetchImpl: deps.fetchImpl });

  // §3.6 step 4: persist result + timestamp. Best-effort — never fail the
  // response because the settings write hiccuped.
  try {
    const current = await deps.settingsStore.get();
    await deps.settingsStore.set({
      ...current,
      lastTestedAt: new Date().toISOString(),
      lastTestResult: outcome.ok ? "success" : "failure",
    });
  } catch {
    /* persistence is best-effort here */
  }

  return { ok: outcome.ok, message: outcome.message };
}

/**
 * GET_STATE: return the current chrome.storage.session so a reconnecting
 * popup can render without assuming continuity. Also computes the §6
 * "restarted mid-analysis" stale flag (analyzing + older than timeoutMs + 5s)
 * and attaches the backend-authored interrupted message when stale.
 *
 * @param {import("./service-worker.js").AppDeps} deps
 * @returns {Promise<{ ok: true; session: import("../storage/session.js").AnalysisSession | null; stale: boolean; message: string | null }>}
 */
async function runGetState(deps) {
  const session = await deps.sessionStore.get();
  let stale = false;
  let message = null;
  if (session && session.status === "analyzing") {
    let timeoutMs = 0;
    try {
      const settings = await deps.settingsStore.get();
      timeoutMs = deps.registry(settings.providerId)?.timeoutMs ?? 0;
    } catch {
      /* unreadable settings → assume no timeout budget */
    }
    stale = await deps.sessionStore.isStale(timeoutMs);
    if (stale) message = getErrorMessage("interrupted").message;
  }
  return { ok: true, session, stale, message };
}

// ─── app factory ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} AppDeps
 *   Injectable seam. Tests supply in-memory stores + fetch mocks; the
 *   production binding (bindToChrome) supplies the chrome-backed versions.
 * @property {ReturnType<typeof createSettingsStore>} settingsStore
 * @property {ReturnType<typeof createHistoryStore>} historyStore
 * @property {ReturnType<typeof createSessionStore>} sessionStore
 * @property {(id: string | null | undefined) => import("../llm/providers/registry.js").ProviderAdapter | null} registry
 * @property {typeof callProvider} callProviderFn
 * @property {typeof runTestConnection} runTestConnectionFn
 * @property {typeof heuristicsRun} heuristicsRunFn
 * @property {typeof buildSystemPrompt} buildSystemPromptFn
 * @property {typeof buildUserPrompt} buildUserPromptFn
 * @property {typeof buildImageParts} buildImagePartsFn
 * @property {typeof fuse} fuseFn
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 * @property {() => string} [uuid]
 * @property {(tabId: number, message: unknown) => Promise<unknown>} [sendToTab]
 */

/**
 * Create the service-worker app with injected dependencies.
 *
 * @param {Partial<AppDeps>} [deps]
 * @returns {{
 *   handleMessage: (message: unknown, context?: { sender?: { tab?: { id?: unknown } } }) =>
 *     Promise<Record<string, unknown>>,
 * }}
 */
export function createServiceWorkerApp(deps = {}) {
  const settingsStore = deps.settingsStore;
  const historyStore = deps.historyStore;
  const sessionStore = deps.sessionStore;
  if (!settingsStore || !historyStore || !sessionStore) {
    throw new TypeError(
      "createServiceWorkerApp: settingsStore, historyStore and sessionStore are required",
    );
  }

  const appDeps = /** @type {AppDeps} */ ({
    settingsStore,
    historyStore,
    sessionStore,
    registry: deps.registry ?? registryGet,
    callProviderFn: deps.callProviderFn ?? callProvider,
    runTestConnectionFn: deps.runTestConnectionFn ?? runTestConnection,
    heuristicsRunFn: deps.heuristicsRunFn ?? heuristicsRun,
    buildSystemPromptFn: deps.buildSystemPromptFn ?? buildSystemPrompt,
    buildUserPromptFn: deps.buildUserPromptFn ?? buildUserPrompt,
    buildImagePartsFn: deps.buildImagePartsFn ?? buildImageParts,
    fuseFn: deps.fuseFn ?? fuse,
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? Date.now,
    uuid: deps.uuid ?? (() => crypto.randomUUID()),
    sendToTab: deps.sendToTab,
  });

  /**
   * Route one message from the popup (or any extension context). Every
   * branch resolves to a plain object; the outer try/catch is a last-resort
   * guard so a bug can never leave the caller hanging.
   *
   * @param {unknown} message
   * @param {{ sender?: { tab?: { id?: unknown } } }} [context]
   * @returns {Promise<Record<string, unknown>>}
   */
  async function handleMessage(message, context = {}) {
    try {
      const type = message && typeof message === "object" ? message.type : null;
      switch (type) {
        case "GET_LISTING":
          return await runGetListing(/** @type {object} */ (message), context, appDeps);
        case "ANALYZE": {
          const listing = /** @type {{ listing?: unknown }} */ (message).listing;
          if (!listing || typeof listing !== "object" || Array.isArray(listing)) {
            return { ok: false, error: "ANALYZE requires a listing object." };
          }
          return await runAnalysis(
            /** @type {import("../shared/types.js").Listing} */ (listing),
            appDeps,
          );
        }
        case "TEST_CONNECTION":
          return await runTestConnectionFlow(
            /** @type {object} */ (message),
            appDeps,
          );
        case "GET_STATE":
          return await runGetState(appDeps);
        default:
          return { ok: false, error: "Unknown message type." };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { handleMessage };
}

// ─── production chrome binding ───────────────────────────────────────────────

/**
 * Promise-wrap chrome.tabs.sendMessage (callback API). Rejects on
 * chrome.runtime.lastError (e.g. no content script in the tab).
 *
 * @param {number} tabId
 * @param {unknown} message
 * @returns {Promise<unknown>}
 */
function defaultSendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    globalThis.chrome.tabs.sendMessage(tabId, message, (response) => {
      const lastError = globalThis.chrome.runtime?.lastError;
      if (lastError) {
        reject(new Error(String(lastError.message ?? "tabs.sendMessage failed")));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Bind the app to the real MV3 chrome APIs and register the onMessage
 * listener. Only call in a browser extension context — the guard at the
 * bottom of this file does exactly that. Returns the bound app.
 *
 * @returns {ReturnType<typeof createServiceWorkerApp>}
 */
export function bindToChrome() {
  const local = chromeLocalStorageBackend();
  const sessionArea = globalThis.chrome?.storage?.session;
  if (!local || !sessionArea) {
    throw new Error("chrome.storage is not available in this context");
  }

  const app = createServiceWorkerApp({
    settingsStore: createSettingsStore(local),
    historyStore: createHistoryStore(local),
    sessionStore: createSessionStore(chromeStorageAreaBackend(sessionArea)),
    sendToTab: defaultSendToTab,
  });

  globalThis.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    Promise.resolve()
      .then(() => app.handleMessage(message, { sender }))
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return true; // keep the channel open for the async response
  });

  return app;
}

// Auto-wire in a browser context ONLY. In Node (tests) globalThis.chrome is
// absent, so this is a no-op and the module stays importable without touching
// any chrome API at import time.
if (
  typeof globalThis !== "undefined" &&
  globalThis.chrome &&
  globalThis.chrome.runtime &&
  typeof globalThis.chrome.runtime.onMessage?.addListener === "function"
) {
  bindToChrome();
}
