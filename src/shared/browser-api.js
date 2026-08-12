/**
 * browser-api.js — minimal browser-API shims for the storage layer
 * (PLAN-BACKEND.md §7.1, §8 storage/ file plan).
 *
 * Scope is deliberately tiny: this file exists ONLY to give the storage
 * modules (settings/history/session) a promisified, injectable seam onto a
 * `chrome.storage` area, so production wiring is a one-liner and tests can
 * pass any Promise-shaped backend. It knows nothing about fetch, DOM, or
 * messages — the full browser shim is the frontend phase's job (per the
 * phase-4 spec: "otherwise skip; frontend phase 6 owns the full shim").
 *
 * No API key ever touches this module — it only moves opaque JSON blobs
 * between the caller and a storage area.
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
