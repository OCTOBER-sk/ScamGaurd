/**
 * i18n.js — minimal translation helper (PLAN-FRONTEND.md §7).
 *
 * Flat key: value lookup with {{var}} interpolation. No ICU pluralization
 * library needed for v1's copy volume (§7). The strings file is imported as
 * a static JSON module — zero runtime fetch, zero eval.
 *
 * `t(key, vars?)` is the single entry point for ALL UI copy in the popup
 * and options pages. Component code must NEVER use string literals for
 * visible text — always route through this helper so adding a locale file
 * later is additive, not a refactor (§7).
 *
 * §2.6: When chrome.i18n exists (extension context), delegates to
 * chrome.i18n.getMessage(key, vars) with a fallback to the bundled
 * en.json (so jsdom unit tests, which have no chrome.i18n, still pass).
 */

import en from "../strings/en.json" with { type: "json" };

/**
 * The active locale's string map. For v1, always the English map. A future
 * locale switch would reassign this reference.
 *
 * @type {Record<string, string>}
 */
const strings = en;

/**
 * Replace {{var}} placeholders in a template string with the corresponding
 * values from `vars`. Unknown placeholders are left untouched; missing vars
 * render as "".
 *
 * @param {string} template
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
function interpolate(template, vars) {
  if (!vars || typeof vars !== "object") return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = vars[key];
    return value !== undefined && value !== null ? String(value) : "";
  });
}

/**
 * Check whether chrome.i18n.getMessage is available (extension context).
 *
 * @returns {boolean}
 */
function hasChromeI18n() {
  return typeof chrome !== "undefined"
    && chrome.i18n
    && typeof chrome.i18n.getMessage === "function";
}

/**
 * Look up a UI string by key and interpolate any {{var}} placeholders.
 * When chrome.i18n is available, delegates to chrome.i18n.getMessage()
 * with a fallback to the bundled English strings (§2.6).
 *
 * Returns the raw English string if the key exists, or the key itself as a
 * fallback (so missing keys are visible during development instead of
 * rendering nothing).
 *
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function t(key, vars) {
  let template;

  if (hasChromeI18n()) {
    // chrome.i18n.getMessage returns "" for missing keys, and uses $1/$2
    // positional placeholders (NOT {{var}}). Run our {{var}} interpolate so
    // callers can use one consistent interpolation syntax across both paths.
    const msg = chrome.i18n.getMessage(key);
    if (msg) return interpolate(msg, vars);
    // Fallback to bundled strings.
    template = strings[key];
  } else {
    template = strings[key];
  }

  if (typeof template !== "string") return key;
  return interpolate(template, vars);
}

/**
 * Check whether a key exists in the current locale's strings. Useful for
 * defensive rendering where a missing key should degrade to a different
 * UI path rather than showing the raw key.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function hasKey(key) {
  if (hasChromeI18n()) {
    const msg = chrome.i18n.getMessage(key);
    if (msg) return true;
  }
  return typeof strings[key] === "string";
}
