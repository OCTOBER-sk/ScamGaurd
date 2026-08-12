/**
 * fetch-mock.js — manual fetch stub for tests (PLAN-BACKEND.md §9.1).
 *
 * No mocking library. `createFetchMock(sequence)` returns an async function
 * that serves the configured responses in order, then falls back to a
 * default response. Each call is recorded on `mock.calls` for assertions.
 *
 * A config entry is:
 *   { status, body, headers?, never? }
 *   - `body`: string (used verbatim), object/array (JSON.stringify'd), or
 *     null for an empty body.
 *   - `never: true`: returns a promise that rejects with an AbortError the
 *     moment the caller's AbortSignal fires (used by the timeout tests) —
 *     exactly how a real fetch() behaves when the AbortController aborts.
 *     If no abort signal is present it simply never settles.
 *
 * The response object is a minimal `Response`-shaped subset exposing
 * `ok`, `status`, `text()` and `arrayBuffer()`.
 */

/** @typedef {object} MockResponseConfig
 * @property {number} [status]
 * @property {unknown} [body]
 * @property {Record<string, string>} [headers]
 * @property {boolean} [never]
 */

/**
 * @param {MockResponseConfig} [config]
 * @returns {{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }}
 */
function makeResponse(config = {}) {
  const status = config.status ?? 200;
  const body = config.body;
  const raw = body === null || body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    async text() {
      return raw;
    },
    async arrayBuffer() {
      return new TextEncoder().encode(raw).buffer;
    },
  };
}

/**
 * @param {Array<MockResponseConfig | ((url: string, init: object) => MockResponseConfig)>} [sequence]
 * @param {{ defaultStatus?: number; defaultBody?: unknown }} [options]
 * @returns {typeof fetch & { calls: Array<{ url: string; init: object }>; sequence: unknown[] }}
 */
export function createFetchMock(sequence = [], options = {}) {
  const queue = [...sequence];
  const calls = [];
  const defaultStatus = options.defaultStatus ?? 200;
  const defaultBody = options.defaultBody ?? "";

  const mock = async (url, init = {}) => {
    calls.push({ url, init });
    const next = queue.shift();
    const config =
      typeof next === "function" ? next(url, init) : next;

    if (config && config.never === true) {
      const signal = init && init.signal ? init.signal : null;
      return new Promise((resolve, reject) => {
        if (!signal) return; // never settles without an abort signal
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        };
        signal.addEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      });
    }

    if (config) {
      return makeResponse(config);
    }
    return makeResponse({ status: defaultStatus, body: defaultBody });
  };

  mock.calls = calls;
  mock.sequence = queue;
  return mock;
}
