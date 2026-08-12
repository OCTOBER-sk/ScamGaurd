/**
 * settings.js — ProviderSettings persistence (PLAN-BACKEND.md §2.4, §7.1).
 *
 * `ProviderSettings` lives in `chrome.storage.local` ONLY — never
 * `chrome.storage.sync` (§7.1: sync storage round-trips through the user's
 * Google account and is exactly wrong for API-key secrets).
 *
 * The store is built over an injectable `StorageAreaBackend` (see
 * src/shared/browser-api.js) so tests run with a tiny in-memory backend and
 * never need the chrome APIs. Production wiring is one line:
 * `createSettingsStore(chromeLocalStorageBackend())`.
 *
 * get() ALWAYS returns a fully-populated ProviderSettings object — every
 * §2.4 field present, missing stored fields defaulted — so the options page
 * and service worker never have to defend against a partial shape.
 */

import { chromeLocalStorageBackend } from "../shared/browser-api.js";

/**
 * @typedef {import("../llm/providers/registry.js").ProviderId} ProviderId
 */

/**
 * §2.4 ProviderSettings. All fields are required in the stored shape; get()
 * normalizes so callers always receive every key.
 *
 * @typedef {object} ProviderSettings
 * @property {ProviderId} providerId
 * @property {string} apiKey                    NEVER logged, NEVER sent anywhere
 *                                              but the chosen provider.
 * @property {string | null} modelOverride      null = use provider preset default.
 * @property {string | null} customEndpoint     only used when providerId === "custom".
 * @property {boolean} visionEnabled            user toggle; auto-disabled if the
 *                                              chosen model has no vision capability.
 * @property {string | null} lastTestedAt
 * @property {"success" | "failure" | null} lastTestResult
 */

/** Storage key under which the settings object lives. @type {string} */
export const SETTINGS_KEY = "providerSettings";

/**
 * Sensible initial values when nothing has been stored yet. The default
 * provider is Gemini (the §3.2 first row — free tier, vision-capable), key
 * empty so the UI shows the NoKey state until the user adds one (§6).
 *
 * @returns {ProviderSettings}
 */
export function defaultProviderSettings() {
  return {
    providerId: "gemini",
    apiKey: "",
    modelOverride: null,
    customEndpoint: null,
    visionEnabled: true,
    lastTestedAt: null,
    lastTestResult: null,
  };
}

/** §2.4 provider ids — used to validate stored providerId values. @type {readonly string[]} */
export const VALID_PROVIDER_IDS = [
  "gemini",
  "groq",
  "cerebras",
  "openrouter",
  "mistral",
  "deepseek",
  "openai",
  "anthropic",
  "ollama",
  "custom",
];

/**
 * Coerce an unknown stored value into a fully-populated ProviderSettings.
 * Every §2.4 field is either copied (when valid) or replaced with its
 * default — never throws, so a corrupted storage blob degrades to defaults
 * instead of breaking the options page.
 *
 * @param {unknown} raw
 * @returns {ProviderSettings}
 */
export function normalizeSettings(raw) {
  const base = defaultProviderSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const src = /** @type {Record<string, unknown>} */ (raw);

  const providerId = VALID_PROVIDER_IDS.includes(String(src.providerId))
    ? /** @type {ProviderId} */ (String(src.providerId))
    : base.providerId;

  return {
    providerId,
    apiKey: typeof src.apiKey === "string" ? src.apiKey : base.apiKey,
    modelOverride:
      typeof src.modelOverride === "string" ? src.modelOverride : null,
    customEndpoint:
      typeof src.customEndpoint === "string" ? src.customEndpoint : null,
    visionEnabled:
      typeof src.visionEnabled === "boolean" ? src.visionEnabled : base.visionEnabled,
    lastTestedAt:
      typeof src.lastTestedAt === "string" ? src.lastTestedAt : null,
    lastTestResult:
      src.lastTestResult === "success" || src.lastTestResult === "failure"
        ? src.lastTestResult
        : null,
  };
}

/**
 * The provider-settings store. `backend` is any `StorageAreaBackend` — in
 * production `chromeLocalStorageBackend()`, in tests a tiny in-memory stub.
 *
 * @typedef {import("../shared/browser-api.js").StorageAreaBackend} StorageAreaBackend
 */

/**
 * @param {StorageAreaBackend} backend
 * @returns {{
 *   get: () => Promise<ProviderSettings>,
 *   set: (settings: ProviderSettings) => Promise<ProviderSettings>,
 *   clear: () => Promise<void>,
 * }}
 */
export function createSettingsStore(backend) {
  return {
    /** Read + normalize the stored settings (always a full §2.4 object). */
    async get() {
      const items = await backend.get(SETTINGS_KEY);
      return normalizeSettings(items[SETTINGS_KEY]);
    },

    /**
     * Normalize then persist the settings. Returns the normalized object so
     * callers can round-trip without re-reading storage.
     */
    async set(settings) {
      const normalized = normalizeSettings(settings);
      await backend.set({ [SETTINGS_KEY]: normalized });
      return normalized;
    },

    /**
     * Wipe the settings entry entirely (§7.1 "Clear key": remove the whole
     * entry, not just blank the field). The next get() returns defaults.
     */
    async clear() {
      await backend.remove(SETTINGS_KEY);
    },
  };
}

/**
 * Production binding: settings backed by `chrome.storage.local`. Throws if
 * chrome is unavailable (plain Node) — the extension's own contexts always
 * have it; tests use createSettingsStore with their own backend instead.
 *
 * @returns {ReturnType<typeof createSettingsStore>}
 */
export function chromeSettingsStore() {
  const backend = chromeLocalStorageBackend();
  if (!backend) {
    throw new Error("chrome.storage.local is not available in this context");
  }
  return createSettingsStore(backend);
}
