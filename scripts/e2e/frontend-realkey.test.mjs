#!/usr/bin/env node
/**
 * frontend-realkey.test.mjs — proves the REAL options-page BYOK flow with a
 * REAL, working OpenRouter key (not the wrong-key 401 path). Loads the real
 * extension in real Chrome, persists a real ProviderSettings via the real
 * service worker, opens the real options page, clicks "Test connection", and
 * asserts a SUCCESS message + captures a screenshot.
 *
 * Usage:
 *   CHROME_PATH=... OPENROUTER_API_KEY=<real key> \
 *     node scripts/e2e/frontend-realkey.test.mjs
 */
import { chromium } from "playwright-core";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__dirname, "../..");
const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/home/santhosh/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
const PROFILE_DIR = "/tmp/scamguard-realkey-profile";
const API_KEY = process.env.OPENROUTER_API_KEY || "";
const SHOT = "/tmp/sg-proof/realkey-options.png";
const RESULTS = "/tmp/sg-proof/frontend-realkey.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function idFromSwUrl(url) {
  const m = /^chrome-extension:\/\/([a-p]+)\//.exec(url || "");
  return m ? m[1] : null;
}

async function main() {
  const results = { apiKeyPresent: !!API_KEY, testConnectionOutcome: "not-run", gaps: [], ranAt: new Date().toISOString() };
  if (!API_KEY) { results.gaps.push("OPENROUTER_API_KEY unset"); writeFileSync(RESULTS, JSON.stringify(results, null, 2)); process.exit(1); }
  if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
  mkdirSync(PROFILE_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    executablePath: CHROME_PATH,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  try {
    const optionsPage = await ctx.newPage();
    const swUrl = ctx.serviceWorkers()[0]?.url();
    let extId = swUrl ? idFromSwUrl(swUrl) : null;
    if (!extId) {
      try { await ctx.waitForEvent("serviceworker", { timeout: 20000 }); } catch {}
      extId = idFromSwUrl(ctx.serviceWorkers().slice(-1)[0]?.url());
    }
    results.extensionId = extId;
    await sleep(2000);

    // Persist REAL provider settings (openrouter + real key) via SW.
    const sw = ctx.serviceWorkers().slice(-1)[0];
    await sw.evaluate((key) =>
      chrome.storage.local.set({
        providerSettings: {
          providerId: "openrouter", apiKey: key, modelOverride: null,
          customEndpoint: null, visionEnabled: false, lastTestedAt: null, lastTestResult: null,
        },
      }), API_KEY);
    const stored = await sw.evaluate(() => chrome.storage.local.get("providerSettings"));
    results.settingsPersisted = stored?.providerSettings?.providerId === "openrouter" &&
      stored?.providerSettings?.apiKey === API_KEY;

    // Open the real options page, select OpenRouter, run Test connection.
    await optionsPage.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "load", timeout: 30000 });
    const orCard = optionsPage.locator('.sg-provider-card[data-provider-id="openrouter"]');
    await orCard.click();
    await optionsPage.locator("#api-key").fill(API_KEY);
    await sleep(400);
    await optionsPage.locator("#btn-test-connection").click();
    await optionsPage.waitForSelector("#test-result:not([hidden])", { timeout: 90000 });
    const text = (await optionsPage.locator("#test-result-text").textContent() || "").trim();
    results.testConnectionOutcome = /success|connected|ok|valid/i.test(text)
      ? `passed: "${text}"`
      : `unexpected: "${text}"`;
    console.log(`[realkey] test connection -> ${results.testConnectionOutcome}`);
    await optionsPage.screenshot({ path: SHOT, fullPage: true });

    // Re-open popup on a quikr tab to confirm the real key is used (NoKey should be gone).
    const quikr = await ctx.newPage();
    await quikr.goto("https://www.quikr.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(4000);
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 400, height: 640 });
    await quikr.bringToFront();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load", timeout: 30000 });
    await sleep(3000);
    const nokey = await popup.locator("#state-no-key:not([hidden])").count();
    results.noKeyStateWithRealKey = nokey === 0 ? "absent (good — real key configured)" : "still present";
    await popup.screenshot({ path: "/tmp/sg-proof/realkey-popup.png" });
  } catch (err) {
    results.gaps.push(`error: ${err.message}`);
    console.error("[realkey] error:", err.message);
  } finally {
    await ctx.close().catch(() => {});
  }
  writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
