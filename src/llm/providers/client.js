/**
 * client.js — provider-call orchestration implementing the §6 error matrix
 * (PLAN-BACKEND.md §1.1 steps 5-7, §3.6, §4.6, §6).
 *
 * This is the network boundary for the provider layer. It owns:
 *   - fetch with an AbortController timeout (well under the MV3 30s
 *     fetch-termination ceiling, §0.6),
 *   - the §6 retry policy: 5xx → exactly 1 retry (~1.5s backoff); 429 → NO
 *     retry; 401/403 → no retry; OpenRouter model-rotation (400/404 "model
 *     not found") → the specific §6 message, no silent substitution; timeout
 *     → surface immediately (elapsed ≈ timeoutMs, not < 50%),
 *   - the tolerantParse → schema.validate → single repair-retry (§6) pipeline
 *     with the §6 terminal "heuristic-only" fallback result.
 *
 * `callProvider` is consumed by the phase-4 service worker; the error-matrix
 * rows in §9.2 are tested against it with the manual fetch stub.
 */

import { tolerantParse } from "../parse.js";
import { validate } from "../schema.js";
import { buildRepairPrompt } from "../prompt.js";
import {
  DEFAULT_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
  MAX_5XX_RETRIES,
} from "./constants.js";

// ─── §6 user-facing messages ────────────────────────────────────────────────

/**
 * @param {import("./registry.js").ProviderAdapter} adapter
 * @returns {string}
 */
function keyRejectedMessage(adapter) {
  return `Your API key was rejected by ${adapter.label}. Check it in Settings.`;
}

/**
 * @param {import("./registry.js").ProviderAdapter} adapter
 * @returns {string}
 */
function rateLimitedMessage(adapter) {
  return `${adapter.label} rate-limited this request. Free tiers reset over time — try again shortly, or switch providers in Settings.`;
}

/**
 * @param {import("./registry.js").ProviderAdapter} adapter
 * @returns {string}
 */
function serverErrorMessage(adapter) {
  return `${adapter.label} is having trouble on their end right now.`;
}

/**
 * @param {import("./registry.js").ProviderAdapter} adapter
 * @returns {string}
 */
function timeoutMessage(adapter) {
  return `${adapter.label} didn't respond in time. You can try again or switch providers.`;
}

/**
 * @param {import("./registry.js").ProviderAdapter} adapter
 * @returns {string}
 */
function networkMessage(adapter) {
  return `Couldn't reach ${adapter.label}. Check your internet connection or try a different provider.`;
}

/**
 * @param {import("./registry.js").ProviderAdapter} adapter
 * @param {number} status
 * @param {string} errorMessage
 * @returns {string}
 */
function genericHttpMessage(adapter, status, errorMessage) {
  const detail = errorMessage ? ` (${errorMessage})` : "";
  return `${adapter.label} returned HTTP ${status}.${detail}`;
}

/**
 * The §6 OpenRouter-rotation message — the specific one, never a generic
 * error, because silently substituting a different model changes analysis
 * quality unpredictably.
 *
 * @type {string}
 */
export const OPENROUTER_ROTATION_MESSAGE =
  "The free model ScamGuard uses on OpenRouter isn't available right now. " +
  "Try 'openrouter/free' (experimental) in Settings, or switch providers.";

/**
 * The §6 terminal parse-failure message ("heuristic-only" fallback copy).
 *
 * @type {string}
 */
export const PARSE_FAILED_MESSAGE =
  "The AI's response couldn't be read reliably — showing rule-based check only.";

/** @type {string} */
export const NO_KEY_MESSAGE = "No API key set for this provider. Open Settings to add one.";

/** @type {string} */
export const NO_MODEL_MESSAGE = "No model configured for this provider. Set one in Settings.";

// ─── fetch with timeout ─────────────────────────────────────────────────────

/**
 * @typedef {object} HttpResult
 * @property {"http"} kind
 * @property {number} status
 * @property {string} rawBody
 * @property {string} errorMessage  message extracted from the error body, if any.
 * @property {number} elapsedMs
 *
 * @typedef {object} TimeoutResult
 * @property {"timeout"} kind
 * @property {number} elapsedMs
 * @property {number | null} status
 * @property {string} rawBody
 * @property {string} errorMessage
 *
 * @typedef {object} NetworkResult
 * @property {"network"} kind
 * @property {number} elapsedMs
 * @property {Error} error
 *
 * @typedef {HttpResult | TimeoutResult | NetworkResult} FetchOutcome
 */

/**
 * Extract a human message from a provider error body. OpenAI-compatible
 * providers and OpenRouter use `{ error: { message } }`.
 *
 * @param {string} rawBody
 * @returns {string}
 */
function extractErrorMessage(rawBody) {
  if (typeof rawBody !== "string" || rawBody.length === 0) return "";
  try {
    const body = JSON.parse(rawBody);
    const msg = body?.error?.message ?? body?.message;
    return typeof msg === "string" ? msg : "";
  } catch {
    return "";
  }
}

/**
 * Perform a single POST with a timeout. The AbortController + setTimeout
 * fires at `timeoutMs`; the mocked-fetch tests listen for the abort signal,
 * exactly like a real fetch() rejection.
 *
 * @param {import("./registry.js").ProviderAdapter} adapter
 * @param {import("./registry.js").ProviderRequest} request
 * @param {number} timeoutMs
 * @param {typeof fetch} fetchImpl
 * @param {() => number} now
 * @returns {Promise<FetchOutcome>}
 */
async function performCall(adapter, request, timeoutMs, fetchImpl, now) {
  const controller = new AbortController();
  const started = now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: typeof request.body === "string" ? request.body : JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      return { kind: "timeout", elapsedMs: now() - started, status: null, rawBody: "", errorMessage: "" };
    }
    return { kind: "network", elapsedMs: now() - started, error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    clearTimeout(timer);
  }

  let rawBody = "";
  try {
    rawBody = await response.text();
  } catch {
    rawBody = "";
  }

  return {
    kind: "http",
    status: response.status,
    rawBody,
    errorMessage: extractErrorMessage(rawBody),
    elapsedMs: now() - started,
  };
}

/**
 * @param {FetchOutcome} outcome
 * @returns {outcome is HttpResult}
 */
function isHttp(outcome) {
  return outcome.kind === "http";
}

/**
 * Detect the OpenRouter "pinned model disappeared" case (§6): HTTP 400/404
 * with a model-not-found message in the body.
 *
 * @param {number} status
 * @param {string} errorMessage
 * @returns {boolean}
 */
export function isModelNotFoundError(status, errorMessage) {
  if (status !== 400 && status !== 404) return false;
  return /model/i.test(errorMessage) && /(not found|does not exist|doesn't exist|not exist|not available|invalid)/i.test(errorMessage);
}

/**
 * Map a non-2xx outcome to a §6 error result. Returns `null` when the
 * outcome is 2xx (caller goes to the parse path).
 *
 * @param {import("./registry.js").ProviderAdapter} adapter
 * @param {FetchOutcome} outcome
 * @returns {import("./client.js").ProviderCallError | null}
 */
function mapHttpError(adapter, outcome) {
  if (outcome.kind === "timeout") {
    return { status: "error", errorCode: "timeout", message: timeoutMessage(adapter), retried: false };
  }
  if (outcome.kind === "network") {
    return { status: "error", errorCode: "network_error", message: networkMessage(adapter), retried: false };
  }
  if (outcome.status >= 200 && outcome.status < 300) return null;
  if (outcome.status === 401 || outcome.status === 403) {
    return { status: "error", errorCode: "key_rejected", message: keyRejectedMessage(adapter), retried: false };
  }
  if (outcome.status === 429) {
    return { status: "error", errorCode: "rate_limited", message: rateLimitedMessage(adapter), retried: false };
  }
  if (adapter.id === "openrouter" && isModelNotFoundError(outcome.status, outcome.errorMessage)) {
    return { status: "error", errorCode: "model_not_found", message: OPENROUTER_ROTATION_MESSAGE, retried: false };
  }
  if (outcome.status >= 500) {
    return { status: "error", errorCode: "server_error", message: serverErrorMessage(adapter), retried: false };
  }
  return {
    status: "error",
    errorCode: "request_failed",
    message: genericHttpMessage(adapter, outcome.status, outcome.errorMessage),
    retried: false,
  };
}

// ─── parse → validate → repair pipeline (§4.6 / §6) ─────────────────────────

/**
 * Run tolerantParse → schema.validate → (if invalid) ONE repair retry per §6.
 * Never throws; returns the final outcome.
 *
 * @param {import("./registry.js").ProviderAdapter} adapter
 * @param {Record<string, unknown>} baseInput
 * @param {HttpResult} result
 * @param {number} timeoutMs
 * @param {typeof fetch} fetchImpl
 * @param {() => number} now
 * @param {number} startedAt
 * @returns {Promise<import("./client.js").ProviderCallSuccess | import("./client.js").ProviderCallError | import("./client.js").ProviderCallParseFailed>}
 */
async function parseVerdict(adapter, baseInput, result, timeoutMs, fetchImpl, now, startedAt) {
  let parsed = null;
  try {
    parsed = adapter.parseResponse(JSON.parse(result.rawBody));
  } catch {
    parsed = null;
  }
  let text = typeof parsed?.text === "string" ? parsed.text : null;
  let candidate = tolerantParse(text);
  let validation = candidate === null ? { valid: false, errors: ["response was not valid JSON"] } : validate(candidate);
  let usedFallbackRepair = false;

  if (!validation.valid) {
    usedFallbackRepair = true;
    const repair = buildRepairPrompt({
      systemPrompt: /** @type {string} */ (baseInput.systemPrompt),
      userPrompt: /** @type {string} */ (baseInput.userPrompt),
    });
    const repairInput = { ...baseInput, systemPrompt: repair.systemPrompt, userPrompt: repair.userPrompt };
    const repairReq = /** @type {import("./registry.js").ProviderAdapter} */ (adapter).buildRequest(repairInput);
    const repairOutcome = await performCall(adapter, repairReq, timeoutMs, fetchImpl, now);

    if (repairOutcome.kind === "http" && repairOutcome.status >= 200 && repairOutcome.status < 300) {
      let repairParsed = null;
      try {
        repairParsed = adapter.parseResponse(JSON.parse(repairOutcome.rawBody));
      } catch {
        repairParsed = null;
      }
      text = typeof repairParsed?.text === "string" ? repairParsed.text : null;
      candidate = tolerantParse(text);
      validation =
        candidate === null
          ? { valid: false, errors: ["repair response was not valid JSON"] }
          : validate(candidate);
    } else {
      // The repair attempt itself failed at the HTTP level (§6: don't loop).
      const mapped = mapHttpError(adapter, repairOutcome);
      if (mapped) {
        return { ...mapped, retried: true };
      }
    }
  }

  if (validation.valid && candidate !== null) {
    return {
      status: "ok",
      llmVerdict: candidate,
      provider: {
        id: adapter.id,
        model: /** @type {string} */ (baseInput.model),
        latencyMs: now() - startedAt,
        usedFallbackRepair,
      },
      usage: parsed?.usage,
    };
  }

  return { status: "parse-failed", message: PARSE_FAILED_MESSAGE, usedRepairRetry: true };
}

/**
 * @typedef {object} ProviderCallSuccess
 * @property {"ok"} status
 * @property {Record<string, unknown>} llmVerdict  validated §4.5 verdict object.
 * @property {{ id: string; model: string; latencyMs: number; usedFallbackRepair: boolean }} provider
 * @property {{ inputTokens: number | null; outputTokens: number | null }} [usage]
 *
 * @typedef {object} ProviderCallError
 * @property {"error"} status
 * @property {"no_key" | "no_model" | "key_rejected" | "rate_limited" | "server_error" |
 *   "timeout" | "network_error" | "model_not_found" | "request_failed"} errorCode
 * @property {string} message
 * @property {boolean} retried
 *
 * @typedef {object} ProviderCallParseFailed
 * @property {"parse-failed"} status
 * @property {string} message
 * @property {boolean} usedRepairRetry
 *
 * @typedef {ProviderCallSuccess | ProviderCallError | ProviderCallParseFailed} ProviderCallResult
 */

/**
 * Run the full §1.1-steps-5-7 flow for one provider call: build request,
 * fetch with timeout, apply the §6 retry policy, then the
 * parse→validate→single-repair pipeline. Returns a discriminated
 * `ProviderCallResult`. Never throws.
 *
 * @param {import("./registry.js").ProviderAdapter} adapter
 * @param {{
 *   listing?: import("../shared/types.js").Listing | null;
 *   heuristics?: import("../shared/types.js").HeuristicSignals | null;
 *   systemPrompt?: string;
 *   userPrompt?: string;
 *   imageParts?: Array<Record<string, unknown>>;
 *   model?: string | null;
 *   apiKey?: string | null;
 *   timeoutMs?: number;
 *   fetchImpl?: typeof fetch;
 *   now?: () => number;
 *   sleep?: (ms: number) => Promise<void>;
 * }} [options]
 * @returns {Promise<ProviderCallResult>}
 */
export async function callProvider(adapter, options = {}) {
  const timeoutMs = options.timeoutMs ?? adapter.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const model = options.model ?? adapter.defaultModel ?? null;
  const apiKey = options.apiKey ?? null;

  if (!model || typeof model !== "string" || model.length === 0) {
    return { status: "error", errorCode: "no_model", message: NO_MODEL_MESSAGE, retried: false };
  }
  if ((!apiKey || typeof apiKey !== "string" || apiKey.length === 0) && adapter.authStyle !== "none") {
    return { status: "error", errorCode: "no_key", message: NO_KEY_MESSAGE, retried: false };
  }

  const startedAt = now();
  const baseInput = {
    listing: options.listing ?? null,
    heuristics: options.heuristics ?? null,
    systemPrompt: options.systemPrompt ?? "",
    userPrompt: options.userPrompt ?? "",
    imageParts: options.imageParts ?? [],
    model,
    apiKey,
  };

  const buildFor = (input) => adapter.buildRequest(input);

  // Main attempt.
  let outcome = await performCall(adapter, buildFor(baseInput), timeoutMs, fetchImpl, now);

  // §6 timeout row: retry once ONLY if elapsed < 50% of timeout (a genuine
  // timeout has elapsed ≈ timeoutMs and surfaces immediately).
  if (outcome.kind === "timeout" && outcome.elapsedMs < timeoutMs * 0.5) {
    outcome = await performCall(adapter, buildFor(baseInput), timeoutMs, fetchImpl, now);
  }

  // §6 5xx row: exactly one retry with ~1.5s backoff.
  if (outcome.kind === "http" && outcome.status >= 500 && MAX_5XX_RETRIES > 0) {
    await sleep(RETRY_BACKOFF_MS);
    const retryOutcome = await performCall(adapter, buildFor(baseInput), timeoutMs, fetchImpl, now);
    if (isHttp(retryOutcome) && retryOutcome.status >= 200 && retryOutcome.status < 300) {
      return parseVerdict(adapter, baseInput, retryOutcome, timeoutMs, fetchImpl, now, startedAt);
    }
    const mapped = mapHttpError(adapter, retryOutcome);
    if (mapped) return { ...mapped, retried: true };
  }

  if (isHttp(outcome) && outcome.status >= 200 && outcome.status < 300) {
    return parseVerdict(adapter, baseInput, outcome, timeoutMs, fetchImpl, now, startedAt);
  }

  const mapped = mapHttpError(adapter, outcome);
  return mapped ?? {
    status: "error",
    errorCode: "request_failed",
    message: genericHttpMessage(adapter, 0, ""),
    retried: false,
  };
}
