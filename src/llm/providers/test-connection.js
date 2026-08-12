/**
 * test-connection.js — shared "Test Connection" flow (PLAN-BACKEND.md §3.6).
 *
 * Implements the §3.6 wire behavior once, so every adapter's
 * `testConnection()` (part of the §3.1 interface) is a thin delegate and the
 * logic is unit-testable without ten copies.
 *
 * §3.6 flow: send a minimal request (system prompt = the {ok:true} JSON
 * instruction, tiny max_tokens) on the SAME endpoint/auth the real analysis
 * would use, then map the outcome to a human message:
 *   - 200 + parseable JSON   → "Connected — <model> responded in <Nms>"
 *   - 401/403                → "Key rejected by provider."
 *   - 429                    → rate-limited (key is VALID — worded as such)
 *   - timeout                → no response within Ns
 *   - malformed JSON back    → model may not support structured output
 *
 * Note: schema/tool-enforced providers (Gemini responseSchema, Anthropic
 * forced tool) return the §4.5 verdict shape rather than {ok:true} for this
 * minimal prompt — so success is "HTTP 200 AND the body parses as JSON",
 * which honestly proves key validity + model health on every provider.
 */

import { tolerantParse, safeParseJson } from "../parse.js";

/**
 * The minimal JSON test prompt from §3.6.
 *
 * @type {string}
 */
const TEST_PROMPT = 'Reply with exactly this JSON: {"ok": true}';

/**
 * @typedef {object} TestConnectionResult
 * @property {boolean} ok
 * @property {string} message
 */

/**
 * Run the §3.6 test-connection flow against an adapter.
 *
 * @param {import("./registry.js").ProviderAdapter} adapter
 * @param {{ apiKey: string; model: string; fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<TestConnectionResult>}
 */
export async function runTestConnection(adapter, options = {}) {
  const { apiKey, model } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const request = adapter.buildRequest({
    listing: null,
    heuristics: null,
    systemPrompt: TEST_PROMPT,
    userPrompt: TEST_PROMPT,
    model,
    apiKey,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), adapter.timeoutMs ?? 20000);
  const startedAt = Date.now();

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
      return {
        ok: false,
        message: `No response within ${Math.round((adapter.timeoutMs ?? 20000) / 1000)}s. Check your internet connection or try a different provider.`,
      };
    }
    return {
      ok: false,
      message: `Couldn't reach ${adapter.label}. Check your internet connection or try a different provider.`,
    };
  } finally {
    clearTimeout(timer);
  }

  let rawBody = "";
  try {
    rawBody = await response.text();
  } catch {
    rawBody = "";
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message: "Key rejected by provider. Double-check you copied the full key.",
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      message:
        "Provider rate-limited this key right now. Your key is valid — try again in a minute.",
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      message: `Provider returned HTTP ${response.status}. Check your key and endpoint, then try again.`,
    };
  }

  const elapsedMs = Date.now() - startedAt;
  const body = safeParseJson(rawBody);
  const parsed = body ? adapter.parseResponse(body) : null;
  const text = typeof parsed?.text === "string" ? parsed.text : null;
  const parsedOk = text !== null && tolerantParse(text) !== null;

  if (!parsedOk) {
    return {
      ok: false,
      message:
        "Connected, but the model's response wasn't valid JSON. This provider/model may not support ScamGuard's structured-output mode — try another model.",
    };
  }

  return {
    ok: true,
    message: `Connected — ${model} responded in ${elapsedMs}ms.`,
  };
}
