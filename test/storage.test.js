/**
 * storage.test.js — settings/history/session persistence (node:test,
 * zero runtime deps, no chrome APIs — everything runs through the injectable
 * `StorageAreaBackend` seam).
 *
 * Covers:
 *   - settings: defaults, round-trip normalization, clear, §7.1 "never sync"
 *   - history: cap + oldest-eviction (insert 55 → 50 kept, oldest dropped),
 *     get/set/list/clear, dedup, corruption tolerance
 *   - session: in-flight lifecycle start → get → complete → clear, §6 stale
 *     detection (timeoutMs + 5s grace)
 *   - browser-api: promisified adapter over a fake callback-style chrome
 *     storage area, lastError rejection, memory backend semantics
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  chromeStorageAreaBackend,
  createMemoryStorageBackend,
} from "../src/shared/browser-api.js";
import {
  SETTINGS_KEY,
  defaultProviderSettings,
  createSettingsStore,
  normalizeSettings,
} from "../src/storage/settings.js";
import {
  HISTORY_KEY,
  DEFAULT_HISTORY_CAP,
  createHistoryStore,
  normalizeCap,
} from "../src/storage/history.js";
import {
  SESSION_KEY,
  STALE_GRACE_MS,
  createSessionStore,
} from "../src/storage/session.js";

/** @param {string} id @returns {object} minimal §2.3-shaped report */
function makeReport(id) {
  return {
    reportId: id,
    listingUrl: `https://www.olx.in/item/x-iid-${id}`,
    score: 10,
    verdict: "Safe",
    createdAt: `2026-01-0${(Number(id) % 9) + 1}T00:00:00.000Z`,
  };
}

/** @returns {import("../src/shared/types.js").Listing} minimal listing */
function makeListing() {
  return {
    platform: "olx",
    url: "https://www.olx.in/item/x-iid-1",
    adId: "1",
    title: null,
    price: { amount: null, currency: "INR", raw: null },
    description: null,
    sellerName: null,
    sellerMemberSince: null,
    sellerItemsListed: null,
    sellerVerified: null,
    location: null,
    postedAt: null,
    images: [],
    imageCount: 0,
    extractionConfidence: "high",
    extractedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** @returns {import("../src/shared/types.js").HeuristicSignals} minimal signals */
function makeHeuristics() {
  return {
    priceAnomaly: { triggered: false, severity: "none", ratioVsCategoryTypical: null, note: "" },
    sellerAge: { triggered: false, memberSinceRaw: null, itemsListed: null },
    photoSignals: { count: 0, triggered: false, severity: "none" },
    contactChannelLeak: { triggered: false, matches: [] },
    urgencyLanguage: { triggered: false, matchedPhrases: [] },
    advanceFeeLanguage: { triggered: false, matchedPhrases: [] },
    offPlatformPaymentLanguage: { triggered: false, matchedPhrases: [] },
    heuristicScore: 0,
    computedAt: "2026-01-01T00:00:00.000Z",
  };
}

// ─── settings: defaults + round-trip ────────────────────────────────────────

test("settings.get() with nothing stored returns fully-populated §2.4 defaults", async () => {
  const store = createSettingsStore(createMemoryStorageBackend());
  const settings = await store.get();

  const defaults = defaultProviderSettings();
  for (const key of Object.keys(defaults)) {
    assert.ok(Object.prototype.hasOwnProperty.call(settings, key), `missing field: ${key}`);
  }
  assert.deepEqual(settings, defaults);
  assert.equal(settings.providerId, "gemini");
  assert.equal(settings.apiKey, "");
  assert.equal(settings.visionEnabled, true);
  assert.equal(settings.lastTestResult, null);
});

test("settings round-trip: set() normalizes + persists, get() reads back identical", async () => {
  const backend = createMemoryStorageBackend();
  const store = createSettingsStore(backend);

  const saved = await store.set({
    providerId: "groq",
    apiKey: "sk-test-123",
    modelOverride: "llama-3.3-70b-versatile",
    customEndpoint: null,
    visionEnabled: false,
    lastTestedAt: "2026-08-12T10:00:00.000Z",
    lastTestResult: "success",
  });

  assert.equal(saved.apiKey, "sk-test-123");
  const stored = backend.snapshot()[SETTINGS_KEY];
  assert.equal(stored.providerId, "groq");
  assert.equal(stored.lastTestResult, "success");

  assert.deepEqual(await store.get(), saved);
});

test("settings normalizes partial/corrupt stored blobs to full defaults", async () => {
  const backend = createMemoryStorageBackend({
    [SETTINGS_KEY]: { apiKey: "partial-only" },
  });
  const store = createSettingsStore(backend);
  const settings = await store.get();

  assert.equal(settings.apiKey, "partial-only"); // preserved
  assert.equal(settings.providerId, "gemini"); // defaulted
  assert.equal(settings.modelOverride, null); // defaulted
  assert.equal(settings.visionEnabled, true); // defaulted

  const bogus = createSettingsStore(
    createMemoryStorageBackend({ [SETTINGS_KEY]: { providerId: "not-a-provider", visionEnabled: "yes" } }),
  );
  const normalized = await bogus.get();
  assert.equal(normalized.providerId, "gemini");
  assert.equal(normalized.visionEnabled, true);

  assert.deepEqual(normalizeSettings(null), defaultProviderSettings());
  assert.deepEqual(normalizeSettings(42), defaultProviderSettings());
});

test("settings.clear() wipes the entry entirely (§7.1 clear-key), next get() returns defaults", async () => {
  const backend = createMemoryStorageBackend();
  const store = createSettingsStore(backend);
  await store.set({ providerId: "cerebras", apiKey: "sk-abc" });
  assert.ok(backend.snapshot()[SETTINGS_KEY], "entry must exist after set");

  await store.clear();
  assert.equal(backend.snapshot()[SETTINGS_KEY], undefined, "entry removed entirely");
  assert.deepEqual(await store.get(), defaultProviderSettings());
});

test("settings store writes through the injected backend (no chrome needed)", async () => {
  const calls = [];
  const spy = {
    async get(keys) {
      calls.push(["get", keys]);
      return {};
    },
    async set(items) {
      calls.push(["set", items]);
    },
    async remove(keys) {
      calls.push(["remove", keys]);
    },
  };
  const store = createSettingsStore(spy);
  await store.get();
  await store.set({ providerId: "gemini" });
  await store.clear();
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["get", "set", "remove"],
  );
  assert.deepEqual(calls[1][1], { [SETTINGS_KEY]: defaultProviderSettings() });
});

// ─── settings: §7.1 never-sync guarantee ────────────────────────────────────

test("§7.1: no chrome.storage.sync reference anywhere in storage/scoring/src shared layer", () => {
  const files = [
    new URL("../src/storage/settings.js", import.meta.url),
    new URL("../src/storage/history.js", import.meta.url),
    new URL("../src/storage/session.js", import.meta.url),
    new URL("../src/shared/browser-api.js", import.meta.url),
    new URL("../src/scoring/fuse.js", import.meta.url),
  ];
  for (const file of files) {
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /chrome\.storage\.sync/, `${file.pathname} must never reference chrome.storage.sync`);
  }
});

test("storage/scoring modules import only relative src paths (zero runtime deps)", () => {
  const files = [
    new URL("../src/storage/settings.js", import.meta.url),
    new URL("../src/storage/history.js", import.meta.url),
    new URL("../src/storage/session.js", import.meta.url),
    new URL("../src/shared/browser-api.js", import.meta.url),
    new URL("../src/scoring/fuse.js", import.meta.url),
  ];
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(/^import\s+.*?from\s+["']([^"']+)["']/gm)) {
      const spec = match[1];
      assert.match(spec, /^\.\.?\//, `${file.pathname} must only import relative paths (got "${spec}")`);
    }
  }
});

// ─── history: cap + oldest-eviction ─────────────────────────────────────────

test("history empty store -> list() returns []", async () => {
  const store = createHistoryStore(createMemoryStorageBackend());
  assert.deepEqual(await store.list(), []);
});

test("history add: newest-first order, get() by id, clear()", async () => {
  const store = createHistoryStore(createMemoryStorageBackend());
  await store.add(makeReport("a"));
  await store.add(makeReport("b"));

  const list = await store.list();
  assert.deepEqual(list.map((r) => r.reportId), ["b", "a"]);

  assert.equal((await store.get("a")).reportId, "a");
  assert.equal(await store.get("missing"), null);

  await store.clear();
  assert.deepEqual(await store.list(), []);
});

test("history eviction: insert 55 -> 50 kept, oldest 5 dropped, newest first", async () => {
  const store = createHistoryStore(createMemoryStorageBackend());
  for (let i = 1; i <= 55; i++) {
    await store.add(makeReport(String(i)));
  }

  const list = await store.list();
  assert.equal(list.length, DEFAULT_HISTORY_CAP, `cap must be ${DEFAULT_HISTORY_CAP}`);
  assert.equal(list[0].reportId, "55", "newest must be first");
  // Oldest 5 (1..5) evicted; 6..55 survive.
  const ids = list.map((r) => r.reportId);
  assert.ok(ids.includes("55") && ids.includes("6"), "newest kept");
  assert.ok(!ids.includes("1") && !ids.includes("5"), "oldest dropped");
  assert.deepEqual(ids, Array.from({ length: 50 }, (_, i) => String(55 - i)));
});

test("history configurable cap: cap 3, insert 5 -> 3 kept, oldest dropped", async () => {
  const store = createHistoryStore(createMemoryStorageBackend(), { cap: 3 });
  for (let i = 1; i <= 5; i++) await store.add(makeReport(String(i)));

  const list = await store.list();
  assert.deepEqual(list.map((r) => r.reportId), ["5", "4", "3"]);
});

test("history add dedupes by reportId (re-adding replaces in place)", async () => {
  const store = createHistoryStore(createMemoryStorageBackend(), { cap: 3 });
  await store.add(makeReport("dup"));
  await store.add(makeReport("x"));
  await store.add(makeReport("dup"));

  const list = await store.list();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((r) => r.reportId), ["dup", "x"]);
});

test("history set replaces the entire history, then caps", async () => {
  const store = createHistoryStore(createMemoryStorageBackend());
  await store.add(makeReport("old"));
  const reports = Array.from({ length: 7 }, (_, i) => makeReport(`r${i}`));
  const result = await store.set(reports);

  assert.equal(result.length, 7);
  assert.deepEqual((await store.list()).map((r) => r.reportId), ["r0", "r1", "r2", "r3", "r4", "r5", "r6"]);

  const capped = await store.set(Array.from({ length: 60 }, (_, i) => makeReport(`c${i}`)));
  assert.equal(capped.length, DEFAULT_HISTORY_CAP);
  assert.equal((await store.list()).length, DEFAULT_HISTORY_CAP);
});

test("history tolerates corrupt storage: garbage entries filtered, never throws", async () => {
  const store = createHistoryStore(
    createMemoryStorageBackend({
      [HISTORY_KEY]: [makeReport("ok"), null, "junk", 42, { noId: true }, { reportId: "valid2" }],
    }),
  );
  const list = await store.list();
  assert.deepEqual(list.map((r) => r.reportId), ["ok", "valid2"]);

  const bogus = createHistoryStore(createMemoryStorageBackend({ [HISTORY_KEY]: "not-an-array" }));
  assert.deepEqual(await bogus.list(), []);
});

test("history returned lists are defensive copies (mutation cannot touch storage)", async () => {
  const store = createHistoryStore(createMemoryStorageBackend());
  await store.add(makeReport("a"));

  const list = await store.list();
  list.length = 0; // mutate the returned array
  assert.equal((await store.list()).length, 1, "stored history unaffected");
});

test("history add/set reject invalid reports with a TypeError", async () => {
  const store = createHistoryStore(createMemoryStorageBackend());
  await assert.rejects(() => store.add(null), TypeError);
  await assert.rejects(() => store.add({}), TypeError);
  await assert.rejects(() => store.set("nope"), TypeError);
});

test("normalizeCap: non-finite/negative falls back to default 50", () => {
  assert.equal(normalizeCap(50), 50);
  assert.equal(normalizeCap(3.9), 3);
  assert.equal(normalizeCap(undefined), DEFAULT_HISTORY_CAP);
  assert.equal(normalizeCap(-1), DEFAULT_HISTORY_CAP);
  assert.equal(normalizeCap(NaN), DEFAULT_HISTORY_CAP);
  assert.equal(normalizeCap("10"), DEFAULT_HISTORY_CAP);
});

// ─── session: in-flight state lifecycle (§0.6 / §6) ─────────────────────────

test("session lifecycle: start -> analyzing state with listing/heuristics/startedAt", async () => {
  const store = createSessionStore(createMemoryStorageBackend());
  const listing = makeListing();
  const heuristics = makeHeuristics();

  const session = await store.start(listing, heuristics);
  assert.equal(session.status, "analyzing");
  assert.equal(session.listing, listing);
  assert.equal(session.heuristics, heuristics);
  assert.match(session.startedAt, /^\d{4}-\d{2}-\d{2}T/);

  const read = await store.get();
  assert.equal(read.status, "analyzing");
  assert.deepEqual(read.listing, listing);
  assert.deepEqual(read.heuristics, heuristics);
});

test("session: complete() writes the done/report state (§1.1 step 8)", async () => {
  const store = createSessionStore(createMemoryStorageBackend());
  await store.start(makeListing(), makeHeuristics());

  const report = { reportId: "r1", score: 80, verdict: "High-Risk" };
  const done = await store.complete(report);
  assert.equal(done.status, "done");
  assert.equal(done.report, report);

  const read = await store.get();
  assert.equal(read.status, "done");
  assert.deepEqual(read.report, report);
});

test("session: clear() removes the state; get() returns null when absent", async () => {
  const backend = createMemoryStorageBackend();
  const store = createSessionStore(backend);

  assert.equal(await store.get(), null, "nothing in flight initially");
  await store.start(makeListing(), makeHeuristics());
  assert.ok(backend.snapshot()[SESSION_KEY]);

  await store.clear();
  assert.equal(await store.get(), null);
  assert.equal(backend.snapshot()[SESSION_KEY], undefined);
});

test("session isStale: fresh analyzing -> false; old analyzing -> true; done/absent -> never", async () => {
  const backend = createMemoryStorageBackend();
  const store = createSessionStore(backend);

  // Absent → never stale.
  assert.equal(await store.isStale(12000), false);

  // Fresh analyzing → not stale.
  await store.start(makeListing(), makeHeuristics());
  assert.equal(await store.isStale(12000), false);

  // Done state → never stale even if long past.
  await store.complete({ reportId: "r1" });
  assert.equal(await store.isStale(12000), false);

  // Old analyzing state → stale once startedAt is beyond timeoutMs + 5s.
  const now = Date.now();
  const oldStartedAt = new Date(now - (STALE_GRACE_MS + 20000)).toISOString();
  await backend.set({ [SESSION_KEY]: { status: "analyzing", startedAt: oldStartedAt } });
  assert.equal(await store.isStale(12000), true, "past timeoutMs + grace");
  assert.equal(await store.isStale(0), true);

  // Just under the budget → not stale.
  const borderline = new Date(now - (STALE_GRACE_MS - 1000)).toISOString();
  await backend.set({ [SESSION_KEY]: { status: "analyzing", startedAt: borderline } });
  assert.equal(await store.isStale(0), false);
});

test("session isStale: unreadable startedAt counts as interrupted", async () => {
  const backend = createMemoryStorageBackend();
  const store = createSessionStore(backend);
  await backend.set({ [SESSION_KEY]: { status: "analyzing", startedAt: "not-a-date" } });
  assert.equal(await store.isStale(12000), true);
});

test("session corrupt blob -> get() returns null, never throws", async () => {
  const backend = createMemoryStorageBackend();
  const store = createSessionStore(backend);
  for (const garbage of ["junk", 42, null, [], [1, 2]]) {
    await backend.set({ [SESSION_KEY]: garbage });
    assert.equal(await store.get(), null, JSON.stringify(garbage));
    assert.equal(await store.isStale(12000), false, JSON.stringify(garbage));
  }
});

// ─── browser-api: promisified chrome adapter + memory backend ───────────────

test("chromeStorageAreaBackend promisifies a callback-style chrome area (get/set/remove)", async () => {
  /** @type {Record<string, unknown>} */
  const fakeStore = {};
  const fakeArea = {
    get(keys, cb) {
      const result = {};
      const keyList = keys === null ? Object.keys(fakeStore) : Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        if (Object.prototype.hasOwnProperty.call(fakeStore, key)) result[key] = fakeStore[key];
      }
      cb(result);
    },
    set(items, cb) {
      Object.assign(fakeStore, items);
      cb();
    },
    remove(keys, cb) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete fakeStore[key];
      cb();
    },
  };

  const backend = chromeStorageAreaBackend(fakeArea);
  await backend.set({ a: 1, b: "x" });
  assert.deepEqual(await backend.get("a"), { a: 1 });
  assert.deepEqual(await backend.get(["a", "b"]), { a: 1, b: "x" });
  assert.deepEqual(await backend.get("missing"), {}, "absent key resolves to {}");
  await backend.remove("a");
  assert.deepEqual(await backend.get("a"), {});
});

test("chromeStorageAreaBackend rejects when chrome.runtime.lastError is set", async () => {
  const fakeArea = {
    get(_keys, cb) {
      globalThis.chrome.runtime.lastError = { message: "boom" };
      cb({});
    },
    set(_items, cb) {
      globalThis.chrome.runtime.lastError = { message: "boom" };
      cb();
    },
    remove(_keys, cb) {
      globalThis.chrome.runtime.lastError = { message: "boom" };
      cb();
    },
  };

  // The adapter reads chrome.runtime.lastError — provide a minimal chrome
  // global and restore it afterwards so sibling tests aren't affected.
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { lastError: null } };
  try {
    const backend = chromeStorageAreaBackend(fakeArea);
    await assert.rejects(() => backend.get("k"), /boom/);
    await assert.rejects(() => backend.set({ k: 1 }), /boom/);
    await assert.rejects(() => backend.remove("k"), /boom/);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("createMemoryStorageBackend matches chrome.storage semantics and returns copies", async () => {
  const backend = createMemoryStorageBackend({ seeded: { n: 1 } });
  await backend.set({ key: { deep: [1, 2, 3] } });

  const read = await backend.get("key");
  read.key.deep.push(999); // mutate the read copy…
  assert.deepEqual((await backend.get("key")).key.deep, [1, 2, 3], "…stored value unaffected");

  assert.deepEqual(await backend.get("missing"), {});
  assert.deepEqual((await backend.get(null))["seeded"], { n: 1 });

  await backend.remove(["key", "seeded"]);
  assert.deepEqual(backend.snapshot(), {});
});
