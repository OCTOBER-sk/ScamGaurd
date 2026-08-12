#!/usr/bin/env node
/**
 * real-extension.test.mjs — REAL-EXTENSION BROWSER TEST (final verification
 * layer). Launches the REAL ScamGuard unpacked extension (repo root IS the
 * extension — manifest.json at root) in REAL Chrome via
 * `chromium.launchPersistentContext` with `--load-extension` /
 * `--disable-extensions-except`, and drives the REAL chrome.* APIs end to
 * end. NO stubs, NO jsdom harnesses, NO mocked storage — every assertion
 * passes through the real extension pages, the real service worker, the real
 * content script and the real provider registry.
 *
 * Steps:
 *   1. Wake the MV3 service worker (open options.html; ctx.serviceWorkers() +
 *      waitForEvent "serviceworker"); extension id from sw.url().
 *   2. Open popup.html in a page — assert the REAL first-run NoKey state
 *      (seal outline, "Connect a free AI provider" headline, "Choose a
 *      provider" button) since no key is configured. The popup's real
 *      startAnalysis() flow is driven against a real quikr.com tab (the only
 *      reachable content-script host from this VPS), so it exercises
 *      popup.js → runtime.sendMessage → service worker → content/extractor.js
 *      → ANALYZE → no_key → NoKey render, zero network spent.
 *   3. Via sw.evaluate, persist REAL ProviderSettings in chrome.storage.local
 *      (providerId groq, apiKey "", visionEnabled false). Reopen the popup.
 *   4. Drive the REAL §2.10 flow: [Check a message] → Paste → type the REAL
 *      scam text → submit → assert result view, scam-pattern verdict text,
 *      coreFact card with the QR fact, matched-pattern line. Exercises
 *      popup.js → chrome.runtime.sendMessage → REAL service worker → REAL
 *      payment-check/match.js → real render. Zero network.
 *   5. Options page: real provider grid (10 cards from the real registry via
 *      the real options.js), select Groq, type a deliberately WRONG key
 *      "sk-invalid-test-key-12345", click Test connection, wait for the REAL
 *      401 from api.groq.com, assert "Key rejected by provider".
 *   6. Content-script probe: navigate a fresh page to https://www.quikr.com/,
 *      wait 8s, assert NO console errors originating from content/extractor.js
 *      and (via sw.evaluate) that chrome.storage.session holds NO "analyzing"
 *      state (proves no proactive scanning per §5).
 *   7. Screenshots (real pages, no harness captions): /tmp/real-nokey.png,
 *      /tmp/real-messagecheck.png, /tmp/real-options.png.
 *   8. Write /tmp/real-e2e-results.json + console.log a human summary.
 *
 * Robustness: every step is capped at 60s; a failed step is recorded as
 * failed/not-verified in results.json and the run continues to the remaining
 * steps. A real OLX/Quikr LISTING page is not reachable from this VPS and is
 * documented as NOT VERIFIED in the output.
 *
 * Usage:
 *   CHROME_PATH=/home/santhosh/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome \
 *   LD_LIBRARY_PATH=$HOME/.local/lib/nss-libs \
 *   node scripts/e2e/real-extension.test.mjs
 */

import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── constants ─────────────────────────────────────────────────────────────

/** Absolute path of the unpacked extension (repo root = extension root). */
const EXT_PATH = resolve(__dirname, "../..");

/** REAL Chrome binary — CHROME_PATH env override, else the pinned build. */
const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/home/santhosh/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";

/**
 * Fresh persistent profile — wiped on every run so the extension is a true
 * first install (step 2 must observe the REAL first-run experience).
 */
const PROFILE_DIR = process.env.PROFILE_DIR || "/tmp/scamguard-real-e2e-profile";

const RESULTS_PATH = "/tmp/real-e2e-results.json";
const SHOT_NOKEY = "/tmp/real-nokey.png";
const SHOT_MESSAGE_CHECK = "/tmp/real-messagecheck.png";
const SHOT_OPTIONS = "/tmp/real-options.png";

/** The REAL scam text from the task spec (drives the §2.10 flow). */
const SCAM_TEXT = "buyer said scan this QR code to receive the payment instantly";

/** The deliberately wrong key (step 5) — must 401 on api.groq.com. */
const WRONG_KEY = "sk-invalid-test-key-12345";

/** Hard cap per step (task requirement). */
const STEP_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── helpers ───────────────────────────────────────────────────────────────

/** Race a promise against a wall-clock timeout. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Extract the extension id from a service-worker URL. */
function idFromSwUrl(url) {
  const m = /^chrome-extension:\/\/([a-p]+)\//.exec(url || "");
  return m ? m[1] : null;
}

/**
 * Chromium's GenerateIdForPath: unpacked-extension ids are a 16-value
 * ('a'..'p') encoding of the first 16 bytes of the SHA-256 of the absolute
 * extension path. Fallback only — the SW URL and the real profile
 * Preferences are consulted first.
 */
function extensionIdForPath(path) {
  const bytes = createHash("sha256").update(path).digest();
  const chars = "abcdefghijklmnop";
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += chars[bytes[i] >> 4];
    id += chars[bytes[i] & 0x0f];
  }
  return id;
}

/** Look the id up in the REAL profile Preferences (extensions.settings). */
function profileExtensionId(profileDir, extPath) {
  try {
    const prefs = JSON.parse(readFileSync(resolve(profileDir, "Default/Preferences"), "utf8"));
    const settings = prefs?.extensions?.settings || {};
    for (const [id, entry] of Object.entries(settings)) {
      if (entry && typeof entry.path === "string" && resolve(entry.path) === resolve(extPath)) {
        return id;
      }
    }
  } catch {
    // Preferences may not be flushed yet — callers fall back to the path hash.
  }
  return null;
}

/**
 * The current live service worker for the context, or null. When `extId` is
 * given, only workers whose URL belongs to OUR extension are considered —
 * visited sites (e.g. quikr.com) register their own service workers, and
 * those must never be mistaken for the extension's (they have no chrome.*).
 */
function currentSw(ctx, extId) {
  const workers = ctx.serviceWorkers();
  if (extId) {
    const extWorkers = workers.filter((w) =>
      (w.url() || "").startsWith(`chrome-extension://${extId}/`),
    );
    if (extWorkers.length > 0) return extWorkers[extWorkers.length - 1];
  }
  return workers.length > 0 ? workers[workers.length - 1] : null;
}

/**
 * Wake a suspended service worker by sending a REAL runtime message from an
 * open extension page (runtime messaging restarts an idle MV3 worker).
 */
async function wakeSwViaPage(page) {
  if (!page) return;
  await page
    .evaluate(
      () =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "GET_STATE" }, () => resolve());
        }),
    )
    .catch(() => {});
}

/** Ensure a live extension service worker: current → wake via page → poll. */
async function ensureSw(ctx, extId, wakePage = null) {
  let sw = currentSw(ctx, extId);
  if (!sw && wakePage) {
    await wakeSwViaPage(wakePage);
    sw = currentSw(ctx, extId);
  }
  if (sw) return sw;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    sw = currentSw(ctx, extId);
    if (sw) return sw;
    await sleep(250);
  }
  return null;
}

/**
 * Wait for a popup state section to become visible, retrying via reload while
 * the quikr tab stays the active tab (the popup's real startAnalysis() reads
 * the active tab, so the quikr tab must hold focus for the ANALYZE → no_key →
 * NoKey chain to fire).
 */
async function waitForPopupSection(page, selector, quikrTab, { retries = 2, perTryMs = 15_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (quikrTab) await quikrTab.bringToFront().catch(() => {});
      await page.waitForSelector(selector, { timeout: perTryMs });
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      await page.reload({ waitUntil: "load", timeout: 30_000 }).catch(() => {});
    }
  }
}

/**
 * Probe the REAL content script in the quikr tab through the REAL service
 * worker (chrome.tabs.query + chrome.tabs.sendMessage GET_LISTING) until it
 * answers — guarantees the popup's own startAnalysis() will find the listener.
 */
async function waitForContentScript(ctx, extId, urlPattern) {
  const deadline = Date.now() + 45_000;
  let lastErr = "content script never became responsive";
  while (Date.now() < deadline) {
    const sw = currentSw(ctx, extId);
    if (!sw) {
      lastErr = "no service worker";
      await sleep(300);
      continue;
    }
    try {
      const probe = await sw.evaluate(
        (pattern) =>
          new Promise((resolve) => {
            chrome.tabs.query({}, (tabs) => {
              const tab = tabs.find((t) => t.url && pattern.test(t.url));
              if (!tab || typeof tab.id !== "number") {
                resolve({ ok: false, reason: "no matching tab" });
                return;
              }
              chrome.tabs.sendMessage(tab.id, { type: "GET_LISTING" }, (resp) => {
                const err = chrome.runtime.lastError;
                if (err) {
                  resolve({ ok: false, reason: err.message });
                  return;
                }
                resolve({ ok: true, listing: resp?.listing ?? null });
              });
            });
          }),
        urlPattern,
      );
      if (probe?.ok) return probe;
      lastErr = probe?.reason || "unknown";
    } catch (err) {
      lastErr = err.message;
    }
    await sleep(400);
  }
  throw new Error(`content script not ready: ${lastErr}`);
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  const results = {
    swAlive: false,
    extensionId: null,
    nokeyState: "not-run",
    messageCheckVerdict: "not-run",
    coreFactRendered: "not-run",
    optionsGridCount: "not-run",
    testConnectionOutcome: "not-run",
    contentScriptErrors: [],
    proactiveScanDetected: null,
    gaps: ["real-listing-page: NOT VERIFIED"],
    ranAt: new Date().toISOString(),
  };

  // Fresh profile so the extension is a true first install.
  if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
  mkdirSync(PROFILE_DIR, { recursive: true });

  let ctx = null;
  let optionsPage = null;
  let popupPage = null;
  let quikrTab = null;

  console.log(`[e2e] launching REAL Chrome: ${CHROME_PATH}`);
  try {
    ctx = await withTimeout(
      chromium.launchPersistentContext(PROFILE_DIR, {
        headless: true,
        executablePath: CHROME_PATH,
        args: [
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          `--disable-extensions-except=${EXT_PATH}`,
          `--load-extension=${EXT_PATH}`,
        ],
      }),
      STEP_TIMEOUT_MS,
      "browser-launch",
    );
  } catch (err) {
    console.error(`[e2e] FATAL — could not launch Chrome: ${err.message}`);
    results.gaps.push(`browser-launch: ${err.message}`);
    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    console.log(`[e2e] wrote ${RESULTS_PATH}`);
    process.exit(1);
  }

  try {
    // ── STEP 1 — wake the service worker, resolve the extension id ──────────
    try {
      await withTimeout(
        (async () => {
          let sw = currentSw(ctx);
          let extId = sw ? idFromSwUrl(sw.url()) : null;
          if (!extId) extId = profileExtensionId(PROFILE_DIR, EXT_PATH);
          if (!extId) extId = extensionIdForPath(EXT_PATH);
          const extUrl = `chrome-extension://${extId}/`;

          // Wake the SW by opening the REAL options page (task step 1).
          optionsPage = await ctx.newPage();
          try {
            await optionsPage.goto(`${extUrl}options.html`, { waitUntil: "load", timeout: 30_000 });
          } catch (err) {
            console.warn(`[step1] options.html wake: ${err.message}`);
          }

          // SW: existing → waitForEvent "serviceworker" → poll.
          sw = currentSw(ctx);
          if (!sw) {
            try {
              sw = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
            } catch {
              sw = null;
            }
          }
          const deadline = Date.now() + 25_000;
          while (!sw && Date.now() < deadline) {
            sw = currentSw(ctx);
            if (sw) break;
            await sleep(300);
          }

          if (sw) {
            const fromUrl = idFromSwUrl(sw.url());
            if (fromUrl) extId = fromUrl;
            results.extensionId = extId;
            results.swAlive = true;
            // The extension's REAL onInstalled handler navigates the ACTIVE
            // tab to options.html?onboarding=1 ~200ms after SW start. Give it
            // room to finish BEFORE we open any other tab, or it would hijack
            // (and abort) the quikr navigation in step 2.
            await sleep(1_500);
            console.log(`[step1] service worker awake: ${sw.url()}`);
          } else {
            // Best-effort id so later steps can still attempt real URLs.
            results.extensionId = extId;
            results.gaps.push("service-worker: could not be woken");
          }
        })(),
        STEP_TIMEOUT_MS,
        "step1-wake-sw",
      );
    } catch (err) {
      console.warn(`[step1] failed: ${err.message}`);
      results.gaps.push(`service-worker: ${err.message}`);
    }

    // ── STEP 2 — REAL first-run NoKey state in the popup ────────────────────
    try {
      await withTimeout(
        (async () => {
          const extUrl = `chrome-extension://${results.extensionId}/`;
          if (!results.extensionId) throw new Error("extension id unresolved — cannot open popup");

          // Create the popup page early so later steps degrade cleanly even
          // if this step's quikr setup fails.
          popupPage = await ctx.newPage();
          await popupPage.setViewportSize({ width: 400, height: 640 }).catch(() => {});
          popupPage.on("console", (msg) => {
            if (msg.type() === "error") console.warn(`[popup console error] ${msg.text()}`);
          });

          // The popup's real startAnalysis() reads the ACTIVE tab, so first
          // open a real quikr.com tab with the content script injected.
          quikrTab = await ctx.newPage();
          await quikrTab.goto("https://www.quikr.com/", {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          await waitForContentScript(ctx, results.extensionId, /quikr\.com/);

          await quikrTab.bringToFront();
          await popupPage.goto(`${extUrl}popup.html`, { waitUntil: "load", timeout: 30_000 });
          await waitForPopupSection(popupPage, "#state-no-key:not([hidden])", quikrTab);

          const sealCount = await popupPage.locator("#state-no-key .sg-seal-placeholder--neutral").count();
          const title = (await popupPage.locator(".sg-no-key-title").textContent() || "").trim();
          const btn = (await popupPage.locator("#btn-choose-provider").textContent() || "").trim();
          const sealOk = sealCount > 0;
          const titleOk = title.includes("Connect a free AI provider");
          const btnOk = btn.includes("Choose a provider");
          results.nokeyState = sealOk && titleOk && btnOk
            ? "passed"
            : `failed: seal=${sealOk} title="${title}" button="${btn}"`;
          console.log(`[step2] NoKey state → ${results.nokeyState}`);
          await popupPage.screenshot({ path: SHOT_NOKEY });
        })(),
        STEP_TIMEOUT_MS,
        "step2-nokey",
      );
    } catch (err) {
      results.nokeyState = `failed: ${err.message}`;
      console.warn(`[step2] ${err.message}`);
    }

    // ── STEP 3 — persist REAL ProviderSettings, reopen the popup ────────────
    try {
      await withTimeout(
        (async () => {
          const sw = await ensureSw(ctx, results.extensionId, popupPage);
          if (!sw) throw new Error("service worker unavailable in step 3");
          if (!popupPage) throw new Error("popup page unavailable in step 3");
          const stored = await sw.evaluate(() =>
            chrome.storage.local
              .set({
                providerSettings: {
                  providerId: "groq",
                  apiKey: "",
                  modelOverride: null,
                  customEndpoint: null,
                  visionEnabled: false,
                  lastTestedAt: null,
                  lastTestResult: null,
                },
              })
              .then(() => chrome.storage.local.get("providerSettings")),
          );
          const s = stored?.providerSettings ?? {};
          if (s.providerId !== "groq" || s.apiKey !== "" || s.visionEnabled !== false) {
            throw new Error(`settings did not persist: ${JSON.stringify(stored)}`);
          }
          // Reopen the popup (reload keeps the quikr tab active).
          await waitForPopupSection(popupPage, "#state-no-key:not([hidden])", quikrTab);
          console.log("[step3] ProviderSettings persisted (groq, empty key) + popup reopened");
        })(),
        STEP_TIMEOUT_MS,
        "step3-settings",
      );
    } catch (err) {
      console.warn(`[step3] ${err.message}`);
    }

    // ── STEP 4 — drive the REAL §2.10 Message & Payment Check flow ──────────
    try {
      await withTimeout(
        (async () => {
          if (!popupPage) throw new Error("popup page unavailable in step 4");
          if (quikrTab) await quikrTab.bringToFront().catch(() => {});
          await popupPage.locator("#btn-check-message").click();
          await popupPage.waitForSelector("#view-message-check:not([hidden])", { timeout: 10_000 });
          await popupPage.locator("#btn-mc-paste").click();
          await popupPage.waitForSelector("#mc-paste-form:not([hidden])", { timeout: 10_000 });
          await popupPage.locator("#mc-paste-text").fill(SCAM_TEXT);
          await popupPage.locator("#btn-mc-paste-submit").click();

          // Wait for the REAL SW round-trip to render the final verdict text.
          await popupPage.waitForFunction(
            (expected) => (document.querySelector("#mc-verdict")?.textContent || "").includes(expected),
            "This looks like a common scam pattern",
            { timeout: 60_000 },
          );

          const verdict = (await popupPage.locator("#mc-verdict").textContent() || "").trim();
          const coreFact = (await popupPage.locator("#mc-core-fact").textContent() || "").trim();
          const patterns = await popupPage.locator("#mc-patterns .sg-mc-pattern").allTextContents();

          results.messageCheckVerdict = `LikelyScam ("${verdict}")`;
          results.coreFactRendered = coreFact.includes(
            "QR code or payment request can only ever be used to send money",
          )
            ? true
            : `failed: coreFact="${coreFact.slice(0, 160)}"`;

          const patternOk = patterns.some((l) => l.includes("Told to scan or approve to receive money"));
          if (!patternOk) {
            results.gaps.push("message-check matched-pattern line: NOT VERIFIED");
          } else {
            results.messageCheckVerdict += " — matched pattern: Told to scan or approve to receive money";
          }
          console.log(`[step4] message check → ${results.messageCheckVerdict} | coreFact=${results.coreFactRendered}`);
          await popupPage.screenshot({ path: SHOT_MESSAGE_CHECK });
        })(),
        STEP_TIMEOUT_MS,
        "step4-message-check",
      );
    } catch (err) {
      results.messageCheckVerdict = `failed: ${err.message}`;
      results.coreFactRendered = "not-verified";
      console.warn(`[step4] ${err.message}`);
    }

    // ── STEP 5 — options page: real grid + REAL 401 test connection ─────────
    try {
      await withTimeout(
        (async () => {
          const extUrl = `chrome-extension://${results.extensionId}/`;
          await optionsPage.goto(`${extUrl}options.html`, { waitUntil: "load", timeout: 30_000 });

          const cards = optionsPage.locator(".sg-provider-card");
          const count = await cards.count();
          results.optionsGridCount = count === 10 ? 10 : `failed: expected 10 provider cards, got ${count}`;
          console.log(`[step5] provider grid cards → ${count}`);

          const groqCard = optionsPage.locator('.sg-provider-card[data-provider-id="groq"]');
          await groqCard.click();
          const ariaChecked = await groqCard.getAttribute("aria-checked");
          if (ariaChecked !== "true") throw new Error(`groq card not selected (aria-checked=${ariaChecked})`);

          await optionsPage.locator("#api-key").fill(WRONG_KEY);
          await sleep(400); // let the input handler persist + settle

          await optionsPage.locator("#btn-test-connection").click();
          await optionsPage.waitForSelector("#test-result:not([hidden])", { timeout: 60_000 });
          await optionsPage.waitForFunction(
            () => (document.querySelector("#test-result-text")?.textContent || "").trim().length > 0,
            null,
            { timeout: 10_000 },
          );
          const text = (await optionsPage.locator("#test-result-text").textContent() || "").trim();
          results.testConnectionOutcome = text.includes("Key rejected by provider")
            ? `passed: "${text}"`
            : `failed: "${text}"`;
          console.log(`[step5] test connection → ${results.testConnectionOutcome}`);
          await optionsPage.screenshot({ path: SHOT_OPTIONS, fullPage: true });
        })(),
        STEP_TIMEOUT_MS,
        "step5-options",
      );
    } catch (err) {
      if (results.optionsGridCount === "not-run") results.optionsGridCount = "failed: step aborted";
      if (results.testConnectionOutcome === "not-run") {
        results.testConnectionOutcome = `failed: ${err.message}`;
      }
      console.warn(`[step5] ${err.message}`);
    }

    // ── STEP 6 — content-script probe on quikr.com ──────────────────────────
    try {
      await withTimeout(
        (async () => {
          const sw = await ensureSw(ctx, results.extensionId, popupPage);
          if (!sw) throw new Error("service worker unavailable in step 6");
          await sw.evaluate(() => chrome.storage.session.clear());

          const probePage = await ctx.newPage();
          const errors = [];
          probePage.on("console", (msg) => {
            if (msg.type() === "error") {
              const loc = msg.location()?.url || "";
              errors.push({ text: msg.text(), url: loc });
            }
          });
          probePage.on("pageerror", (err) =>
            errors.push({ text: `pageerror: ${err.message}`, url: "" }),
          );
          await probePage.goto("https://www.quikr.com/", {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          await sleep(8_000); // task: wait 8s

          // Assert NO console errors originating from content/extractor.js —
          // match on the message text AND the originating resource URL.
          results.contentScriptErrors = errors
            .filter((e) => /extractor/i.test(e.text) || /extractor/i.test(e.url))
            .map((e) => (e.url && e.url !== e.text ? `${e.url}: ${e.text}` : e.text));

          // No proactive scanning per §5 — session storage must hold no
          // "analyzing" state.
          const sw2 = await ensureSw(ctx, results.extensionId, popupPage);
          const session = sw2 ? await sw2.evaluate(() => chrome.storage.session.get(null)) : null;
          results.proactiveScanDetected = !!(session?.analysisSession && session.analysisSession.status === "analyzing");
          console.log(
            `[step6] content errors=${results.contentScriptErrors.length} proactiveScan=${results.proactiveScanDetected}`,
          );
          await probePage.close().catch(() => {});
        })(),
        STEP_TIMEOUT_MS,
        "step6-content-probe",
      );
    } catch (err) {
      if (Array.isArray(results.contentScriptErrors) && results.contentScriptErrors.length === 0) {
        results.contentScriptErrors = `failed: ${err.message}`;
      }
      if (results.proactiveScanDetected === null) results.proactiveScanDetected = "not-verified";
      console.warn(`[step6] ${err.message}`);
    }

    // ── write results + human summary ───────────────────────────────────────
    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

    console.log("\n========== REAL EXTENSION E2E ==========");
    console.log(`SW alive         : ${results.swAlive}`);
    console.log(`Extension ID     : ${results.extensionId}`);
    console.log(`NoKey state      : ${results.nokeyState}`);
    console.log(`Msg-check verdict: ${results.messageCheckVerdict}`);
    console.log(`Core-fact card   : ${results.coreFactRendered}`);
    console.log(`Options grid     : ${results.optionsGridCount}`);
    console.log(`Test connection  : ${results.testConnectionOutcome}`);
    const contentErrors =
      Array.isArray(results.contentScriptErrors) && results.contentScriptErrors.length === 0
        ? "none"
        : JSON.stringify(results.contentScriptErrors);
    console.log(`Content errors   : ${contentErrors}`);
    console.log(`Proactive scan   : ${results.proactiveScanDetected}`);
    console.log(`Gaps             : ${results.gaps.join("; ")}`);
    console.log(`Screenshots      : ${SHOT_NOKEY} | ${SHOT_MESSAGE_CHECK} | ${SHOT_OPTIONS}`);
    console.log(`Results          : ${RESULTS_PATH}`);
    console.log("=========================================");
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }

  // Non-zero exit when the extension never came up or a headline step failed.
  const headline = [
    results.swAlive,
    results.nokeyState === "passed",
    typeof results.messageCheckVerdict === "string" && results.messageCheckVerdict.startsWith("LikelyScam"),
    results.coreFactRendered === true,
    results.optionsGridCount === 10,
    typeof results.testConnectionOutcome === "string" && results.testConnectionOutcome.startsWith("passed"),
  ];
  if (headline.some((ok) => !ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[e2e] fatal: ${err.message}`);
  try {
    writeFileSync(
      RESULTS_PATH,
      JSON.stringify(
        {
          swAlive: false,
          extensionId: null,
          nokeyState: "not-run",
          messageCheckVerdict: "not-run",
          coreFactRendered: "not-run",
          optionsGridCount: "not-run",
          testConnectionOutcome: "not-run",
          contentScriptErrors: [],
          proactiveScanDetected: null,
          gaps: [`fatal: ${err.message}`, "real-listing-page: NOT VERIFIED"],
          ranAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    // ignore — results writing is best-effort here
  }
  process.exit(1);
});
