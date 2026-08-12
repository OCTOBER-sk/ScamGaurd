/**
 * session.js — in-flight analysis state (PLAN-BACKEND.md §0.6, §6).
 *
 * A thin wrapper over `chrome.storage.session` holding the §1.1 step-2 state
 * that MUST be persisted BEFORE the provider fetch starts, so a service-worker
 * restart (idle termination, fetch > 30s) can resume or report failure
 * cleanly instead of the popup hanging forever.
 *
 * State machine (single object under one key):
 *   - `start(listing, heuristics)`   → { status: "analyzing", listing,
 *                                        heuristics, startedAt }
 *   - `complete(report)`             → { status: "done", report }
 *   - `clear()`                      → remove the key (absent = nothing in flight)
 *
 * `isStale(timeoutMs)` implements the §6 "restarted mid-analysis" row: true
 * only for a still-"analyzing" state whose startedAt is older than
 * `timeoutMs + 5s`. The done/report state is never stale.
 *
 * Same injectable `StorageAreaBackend` seam as settings/history; production
 * wires `chromeSessionStorageBackend()`.
 */

import { chromeStorageAreaBackend } from "../shared/browser-api.js";

/** Storage key for the in-flight-analysis object. @type {string} */
export const SESSION_KEY = "analysisSession";

/**
 * Grace period beyond the provider timeout after which an "analyzing" state
 * counts as interrupted (§6 row: "older than timeoutMs + 5s").
 *
 * @type {number}
 */
export const STALE_GRACE_MS = 5000;

/**
 * @typedef {object} AnalysisSession
 * @property {"analyzing" | "done"} status
 * @property {import("../shared/types.js").Listing | null} [listing]
 *                                       present for "analyzing" (§1.1 step 2).
 * @property {import("../shared/types.js").HeuristicSignals | null} [heuristics]
 *                                       present for "analyzing".
 * @property {string} [startedAt]        ISO 8601; present for "analyzing".
 * @property {Record<string, unknown>} [report]
 *                                       present for "done" (§1.1 step 8).
 */

/**
 * @typedef {import("../shared/browser-api.js").StorageAreaBackend} StorageAreaBackend
 */

/**
 * @param {StorageAreaBackend} backend
 * @returns {{
 *   start: (listing: import("../shared/types.js").Listing,
 *     heuristics: import("../shared/types.js").HeuristicSignals) =>
 *     Promise<AnalysisSession>,
 *   complete: (report: Record<string, unknown>) => Promise<AnalysisSession>,
 *   get: () => Promise<AnalysisSession | null>,
 *   isStale: (timeoutMs: number) => Promise<boolean>,
 *   clear: () => Promise<void>,
 * }}
 */
export function createSessionStore(backend) {
  return {
    /**
     * Persist the in-flight "analyzing" state. Callers MUST invoke this
     * before awaiting the provider fetch (§0.6) so a mid-fetch SW restart can
     * detect and report the interruption.
     */
    async start(listing, heuristics) {
      const session = {
        status: "analyzing",
        listing: listing ?? null,
        heuristics: heuristics ?? null,
        startedAt: new Date().toISOString(),
      };
      await backend.set({ [SESSION_KEY]: session });
      return session;
    },

    /** Write the finished result so a reconnecting popup can render it. */
    async complete(report) {
      const session = { status: "done", report };
      await backend.set({ [SESSION_KEY]: session });
      return session;
    },

    /** Read the current session, or null when nothing is in flight. */
    async get() {
      const items = await backend.get(SESSION_KEY);
      const value = items[SESSION_KEY];
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return /** @type {AnalysisSession} */ (value);
    },

    /**
     * §6 "restarted mid-analysis" check: true only when the state is still
     * "analyzing" AND its startedAt is older than `timeoutMs + STALE_GRACE_MS`.
     * A done/report or absent state is never stale.
     */
    async isStale(timeoutMs) {
      const session = await this.get();
      if (!session || session.status !== "analyzing") return false;
      const started = typeof session.startedAt === "string"
        ? Date.parse(session.startedAt)
        : NaN;
      if (!Number.isFinite(started)) return true; // unreadable timestamp → assume interrupted
      const budgetMs =
        (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : 0) +
        STALE_GRACE_MS;
      return Date.now() - started > budgetMs;
    },

    /** Remove the in-flight state entirely (absent = nothing in flight). */
    async clear() {
      await backend.remove(SESSION_KEY);
    },
  };
}

/**
 * Production binding: `chrome.storage.session`. In-memory and scoped to the
 * current browser session — exactly right for transient in-flight state that
 * must not survive a browser restart. Throws if chrome is unavailable
 * (plain Node) — the extension's own contexts always have it.
 *
 * @returns {ReturnType<typeof createSessionStore>}
 */
export function chromeSessionStore() {
  const area = globalThis.chrome?.storage?.session;
  if (!area) {
    throw new Error("chrome.storage.session is not available in this context");
  }
  return createSessionStore(chromeStorageAreaBackend(area));
}
