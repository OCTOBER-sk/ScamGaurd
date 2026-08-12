/**
 * browser-api.js — browser-API shims for Chrome ↔ Firefox normalization
 * (PLAN-BACKEND.md §7.1, §8 storage/ file plan, PLAN-FRONTEND.md §8.3).
 *
 * Exports two layers:
 *   1. Storage shims (§7.1): chromeStorageAreaBackend, chromeLocalStorageBackend,
 *      createMemoryStorageBackend — unchanged from phase 4.
 *   2. Runtime/messaging/action shim (§8.3): chromeRuntime, chromeTabs,
 *      chromeAction — promise-normalized wrappers that work with both
 *      Chrome's callback-based chrome.* and Firefox's promise-based browser.*.
 *
 * No component file ever calls chrome.* directly — always through this shim
 * — so a second manifest.firefox.json is the only Firefox-specific artifact
 * needed for v1 (§8.3).
 *
 * No API key ever touches this module — it only moves opaque JSON blobs
 * between the caller and a storage area, or relays messages.
 */

/**
 * @typedef {object} StorageAreaBackend
 *   The promise-shaped storage seam the storage modules accept. This is the
 *   exact minimal interface `chrome.storage.local` / `chrome.storage.session`
 *   get adapted to (their real API is callback-based).
 * @property {(keys: string | string[] | null) => Promise<Record<string, unknown>>} get
 *   Resolves with the stored items. A string key resolves to `{ [key]: value }`
 *   (or `{}` when the key is absent) — matching chrome.storage semantics.
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

/**
 * Promisify the callback-based `chrome.storage` area API into a
 * `StorageAreaBackend`. Works with any area (`chrome.storage.local`,
 * `chrome.storage.session`) since they share the same get/set/remove shape.
 * `chrome.runtime.lastError` is surfaced as a rejected promise.
 *
 * NOTE: `chrome.storage.sync` is deliberately NOT exposed anywhere in the
 * storage layer (§7.1: API keys must never round-trip through the user's
 * Google account — sync storage is exactly wrong for secrets).
 *
 * @param {object} area  a `chrome.storage.*` area (local or session).
 * @returns {StorageAreaBackend}
 */
export function chromeStorageAreaBackend(area) {
  if (!area || typeof area.get !== "function") {
    throw new TypeError("chromeStorageAreaBackend: expected a chrome.storage area");
  }

  /** @param {(done: () => void) => void} run */
  const wrap = (run) =>
    new Promise((resolve, reject) => {
      run(() => {
        const lastError = globalThis.chrome?.runtime?.lastError;
        if (lastError) {
          reject(new Error(String(lastError.message ?? "chrome.storage error")));
        } else {
          resolve();
        }
      });
    });

  return {
    get(keys) {
      return new Promise((resolve, reject) => {
        area.get(keys, (items) => {
          const lastError = globalThis.chrome?.runtime?.lastError;
          if (lastError) {
            reject(new Error(String(lastError.message ?? "chrome.storage error")));
          } else {
            resolve(items ?? {});
          }
        });
      });
    },
    set(items) {
      return wrap((done) => area.set(items, done));
    },
    remove(keys) {
      return wrap((done) => area.remove(keys, done));
    },
  };
}

/**
 * The production binding for settings + history: `chrome.storage.local`
 * (§2.4, §7.1 — keys live ONLY in local storage, never sync). Returns null
 * when chrome is unavailable (e.g. plain Node) so callers can pick a
 * fallback — the extension's own contexts always have chrome present.
 *
 * @returns {StorageAreaBackend | null}
 */
export function chromeLocalStorageBackend() {
  const area = globalThis.chrome?.storage?.local;
  if (!area) return null;
  return chromeStorageAreaBackend(area);
}

/**
 * A tiny in-memory `StorageAreaBackend` for tests and non-chrome contexts —
 * the "tiny injectable storage backend" the storage modules were built
 * around (phase-4 spec: tests must run without chrome APIs). Matches
 * chrome.storage semantics: get("key") resolves `{ key: value }`, absent
 * keys resolve to `{}`, and each returned object is a fresh copy so stored
 * state can't be mutated through a read result.
 *
 * @param {Record<string, unknown>} [initial]
 * @returns {StorageAreaBackend & { snapshot: () => Record<string, unknown> }}
 */
export function createMemoryStorageBackend(initial = {}) {
  /** @type {Record<string, unknown>} */
  const store = { ...initial };

  return {
    async get(keys) {
      const result = {};
      if (keys === null || keys === undefined) {
        Object.assign(result, store);
      } else if (Array.isArray(keys)) {
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
        }
      } else {
        const key = String(keys);
        if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
      }
      return structuredClone(result);
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        store[key] = structuredClone(value);
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete store[key];
      }
    },
    snapshot() {
      return structuredClone(store);
    },
  };
}

// ─── Runtime / messaging / action shims (§8.3) ─────────────────────────────
//
// Firefox's `browser.*` namespace is Promise-native; Chrome's `chrome.*` is
// callback-based for some APIs. These shims normalize both to a consistent
// Promise-based interface. Every extension-context file (popup, options,
// content script) should import from here rather than calling chrome.*
// directly, so the Firefox port is a manifest change, not a code rewrite.

/**
 * Normalize a callback-style chrome API method into a Promise-returning one.
 * If the chrome namespace is absent (e.g. plain Node tests), returns a
 * function that rejects with a clear error.
 *
 * @param {(cb: (...args: unknown[]) => void) => void} chromeMethod
 * @returns {(...args: unknown[]) => Promise<unknown>}
 */
function promisifyChrome(chromeMethod) {
  return (...args) =>
    new Promise((resolve, reject) => {
      chromeMethod(...args, (...results) => {
        const lastError = globalThis.chrome?.runtime?.lastError;
        if (lastError) {
          reject(new Error(String(lastError.message ?? "chrome API error")));
        } else {
          resolve(results.length <= 1 ? results[0] : results);
        }
      });
    });
}

/**
 * Whether the browser.* (Firefox) namespace is available. Used to pick the
 * right backend at init time.
 *
 * @type {boolean}
 */
const IS_FIREFOX = typeof globalThis.browser !== "undefined" && typeof globalThis.browser?.runtime?.sendMessage === "function";

/**
 * Runtime messaging shim — wraps chrome.runtime.sendMessage /
 * browser.runtime.sendMessage into a uniform Promise interface.
 *
 * @type {{
 *   sendMessage: (message: unknown) => Promise<unknown>,
 *   onMessage: { addListener: (cb: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void) => void },
 * }}
 */
export const chromeRuntime = (() => {
  if (IS_FIREFOX) {
    return {
      sendMessage: (msg) => globalThis.browser.runtime.sendMessage(msg),
      onMessage: globalThis.browser.runtime.onMessage,
    };
  }
  if (typeof globalThis.chrome?.runtime !== "undefined") {
    return {
      sendMessage: promisifyChrome((msg, cb) => globalThis.chrome.runtime.sendMessage(msg, cb)),
      onMessage: globalThis.chrome.runtime.onMessage,
    };
  }
  // Not in a browser context (Node tests) — provide no-op stubs.
  return {
    sendMessage: async () => { throw new Error("chrome.runtime is not available"); },
    onMessage: { addListener() {} },
  };
})();

/**
 * Tabs query shim — wraps chrome.tabs.query / browser.tabs.query.
 *
 * @type {{
 *   query: (queryInfo: { active?: boolean; currentWindow?: boolean }) => Promise<Array<{ id?: number; url?: string }>>,
 *   sendMessage: (tabId: number, message: unknown) => Promise<unknown>,
 * }}
 */
export const chromeTabs = (() => {
  if (IS_FIREFOX) {
    return {
      query: (info) => globalThis.browser.tabs.query(info),
      sendMessage: (tabId, msg) => globalThis.browser.tabs.sendMessage(tabId, msg),
    };
  }
  if (typeof globalThis.chrome?.tabs !== "undefined") {
    return {
      query: promisifyChrome((info, cb) => globalThis.chrome.tabs.query(info, cb)),
      sendMessage: promisifyChrome((tabId, msg, cb) => globalThis.chrome.tabs.sendMessage(tabId, msg, cb)),
    };
  }
  return {
    query: async () => [],
    sendMessage: async () => { throw new Error("chrome.tabs is not available"); },
  };
})();

/**
 * Action (toolbar icon) shim — wraps chrome.action / browser.browserAction.
 *
 * @type {{
 *   setBadgeText: (details: { text: string; tabId?: number }) => Promise<void>,
 *   setBadgeBackgroundColor: (details: { color: string; tabId?: number }) => Promise<void>,
 * }}
 */
export const chromeAction = (() => {
  if (IS_FIREFOX) {
    const api = globalThis.browser?.browserAction ?? globalThis.browser?.action;
    if (api) {
      return {
        setBadgeText: (d) => api.setBadgeText(d),
        setBadgeBackgroundColor: (d) => api.setBadgeBackgroundColor(d),
      };
    }
  }
  if (typeof globalThis.chrome?.action !== "undefined") {
    return {
      setBadgeText: promisifyChrome((d, cb) => globalThis.chrome.action.setBadgeText(d, cb)),
      setBadgeBackgroundColor: promisifyChrome((d, cb) => globalThis.chrome.action.setBadgeBackgroundColor(d, cb)),
    };
  }
  return {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
  };
})();
