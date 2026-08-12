/**
 * history.js — RiskReport history persistence (PLAN-BACKEND.md §2.3, §8).
 *
 * Stores a capped, newest-first list of RiskReports under a single key so
 * cap + oldest-eviction is a single `slice` — a report with its rawListing
 * blob is a few KB and 50 entries fit comfortably in chrome.storage.local's
 * quota. The cap is configurable (default 50) and eviction is oldest-first.
 *
 * Built over the same injectable `StorageAreaBackend` seam as settings.js —
 * tests pass an in-memory backend; production wires `chromeLocalStorageBackend()`.
 *
 * All returned lists are defensive copies — mutating a returned array never
 * touches stored state.
 */

import { chromeLocalStorageBackend } from "../shared/browser-api.js";

/** Storage key for the whole history list. @type {string} */
export const HISTORY_KEY = "riskReportHistory";

/** @type {number} */
export const DEFAULT_HISTORY_CAP = 50;

/**
 * @typedef {object} RiskReportLite
 *   Minimal §2.3 RiskReport shape — the fields history actually keys on.
 *   History stores full §2.3 RiskReport objects; only `reportId` is relied
 *   on here (get-by-id lookups). The full typedef lives in the frontend
 *   phase's shared types.
 * @property {string} reportId
 */

/**
 * Coerce a cap option into a sane integer ≥ 1. Non-finite/negative input
 * falls back to the default so callers can't configure eviction off by
 * accident.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeCap(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_HISTORY_CAP;
  }
  return Math.floor(value);
}

/**
 * @typedef {import("../shared/browser-api.js").StorageAreaBackend} StorageAreaBackend
 */

/**
 * @param {StorageAreaBackend} backend
 * @param {{ cap?: number }} [options]
 * @returns {{
 *   list: () => Promise<import("./history.js").RiskReportLite[]>,
 *   add: (report: import("./history.js").RiskReportLite) =>
 *     Promise<import("./history.js").RiskReportLite[]>,
 *   set: (reports: import("./history.js").RiskReportLite[]) =>
 *     Promise<import("./history.js").RiskReportLite[]>,
 *   get: (reportId: string) =>
 *     Promise<import("./history.js").RiskReportLite | null>,
 *   clear: () => Promise<void>,
 * }}
 */
export function createHistoryStore(backend, options = {}) {
  const cap = normalizeCap(options?.cap);

  /** @returns {Promise<import("./history.js").RiskReportLite[]>} */
  async function readAll() {
    const items = await backend.get(HISTORY_KEY);
    const stored = items[HISTORY_KEY];
    if (!Array.isArray(stored)) return [];
    // Drop anything that isn't a plausible report object (never throw on a
    // corrupted blob), then enforce the cap.
    return stored
      .filter(
        (r) => r && typeof r === "object" && !Array.isArray(r) && typeof r.reportId === "string",
      )
      .slice(0, cap);
  }

  /** @param {import("./history.js").RiskReportLite[]} reports @returns {Promise<void>} */
  async function writeAll(reports) {
    await backend.set({ [HISTORY_KEY]: reports.slice(0, cap) });
  }

  return {
    /** Newest-first copy of every stored report (empty array when none). */
    async list() {
      return readAll();
    },

    /**
     * Insert one report at the front (newest-first) and evict the oldest
     * beyond the cap. Returns the resulting list.
     */
    async add(report) {
      if (!report || typeof report !== "object") {
        throw new TypeError("history.add: report must be an object");
      }
      if (typeof report.reportId !== "string" || report.reportId.length === 0) {
        throw new TypeError("history.add: report.reportId must be a non-empty string");
      }
      const current = await readAll();
      const next = [report, ...current.filter((r) => r.reportId !== report.reportId)];
      await writeAll(next);
      return next.slice(0, cap);
    },

    /** Replace the entire history (newest-first), capped + oldest-evicted. */
    async set(reports) {
      if (!Array.isArray(reports)) {
        throw new TypeError("history.set: reports must be an array");
      }
      const normalized = reports.filter(
        (r) =>
          r && typeof r === "object" && !Array.isArray(r) && typeof r.reportId === "string",
      );
      await writeAll(normalized);
      return normalized.slice(0, cap);
    },

    /** Fetch a single report by id, or null when absent. */
    async get(reportId) {
      const current = await readAll();
      return current.find((r) => r.reportId === reportId) ?? null;
    },

    /** Wipe the history entirely. */
    async clear() {
      await backend.remove(HISTORY_KEY);
    },
  };
}

/**
 * Production binding: history backed by `chrome.storage.local` (persists
 * across browser restarts — the natural home for past analyses). Throws if
 * chrome is unavailable (plain Node).
 *
 * @returns {ReturnType<typeof createHistoryStore>}
 */
export function chromeHistoryStore() {
  const backend = chromeLocalStorageBackend();
  if (!backend) {
    throw new Error("chrome.storage.local is not available in this context");
  }
  return createHistoryStore(backend);
}
