#!/usr/bin/env node
/**
 * enhanced-ui-shots.mjs — REAL-CHROME screenshot pass for the ScamGuard
 * frontend enhancement (logo in header, live seal arc, provenance line,
 * free-default CTA, re-openable history, es/hi locale validity).
 *
 * Drives the REAL unpacked extension in REAL Chrome. No mocks.
 * Outputs screenshots to /tmp/sg-proof-enhanced/ + results.json.
 */
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || "/home/santhosh/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
const EXT_ROOT = "/home/santhosh/projects/ScamGaurd";
const PROFILE_DIR = process.env.PROFILE_DIR || "/tmp/sg-proof-enhanced-profile";
const OUT = "/tmp/sg-proof-enhanced";
mkdirSync(OUT, { recursive: true });

const results = { steps: [], extensionId: null, errors: [] };
function log(step, ok, detail) {
  results.steps.push({ step, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${step}${detail ? " — " + detail : ""}`);
}

function extensionIdForPath(path) {
  const bytes = createHash("sha256").update(path).digest();
  const chars = "abcdefghijklmnop";
  let id = "";
  for (let i = 0; i < 16; i++) id += chars[bytes[i] >> 4] + chars[bytes[i] & 0x0f];
  return id;
}
const extId = extensionIdForPath(EXT_ROOT);
results.extensionId = extId;

const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: CHROME,
  args: [
    "--no-sandbox",
    `--load-extension=${EXT_ROOT}`,
    `--disable-extensions-except=${EXT_ROOT}`,
    "--disable-background-timer-throttling",
  ],
});

function openExtPage(path) {
  return browser.newPage().then(async (p) => {
    await p.goto(`chrome-extension://${extId}/${path}`);
    await p.waitForTimeout(600);
    return p;
  });
}

// 1. extension id
log("extension id resolved", !!extId, extId);

// 2. NoKey popup — header logo
const popup = await openExtPage("popup.html");
await popup.waitForTimeout(900);
const hasLogo = await popup.evaluate(() => !!document.querySelector(".sg-header-logo"));
const logoSrc = await popup.evaluate(() => document.querySelector(".sg-header-logo")?.getAttribute("src"));
await popup.screenshot({ path: `${OUT}/01-nokey-header-logo.png` });
log("popup header shows logo.png", hasLogo, logoSrc);

// 3. Seed a fabricated report into history + settings, re-open to show live seal arc + provenance
const sw = await browser.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => browser.serviceWorkers().find((w) => w.url().includes(extId)));
await sw.evaluate(async () => {
  const report = { reportId:"demo-1", verdict:"Suspicious", score:62, confidence:"high", listingTitle:"Mi LED 32 Smart TV", price:"₹6,500",
    heuristics:{score:40,triggered:[{id:"priceAnomaly",label:"Price far below typical",severity:"high"}]},
    redFlags:[{id:"PRICE_ANOMALY",severity:"high",label:"Price anomaly",explanation:"Listed ~8% of typical range."}],
    summary:"Several signals suggest caution: the price is implausibly low and the seller is new.",
    checklist:["Meet in a public place","Inspect before paying","Use the platform's official payment only"], provider:"OpenRouter" };
  await chrome.storage.local.set({ riskReportHistory: [report], sg_settings:{providerId:"openrouter",apiKey:""} });
});
await popup.reload();
await popup.waitForTimeout(1100);
const reopened = await popup.evaluate(() => {
  const row = document.querySelector("#history-list button, #history-list li");
  if (row) { row.click(); return true; }
  return false;
});
await popup.waitForTimeout(1300);
const sealArc = await popup.evaluate(() => {
  const c = document.querySelector("#report-seal svg circle[stroke-dasharray]");
  return c ? c.getAttribute("stroke-dasharray") : null;
});
const prov = await popup.evaluate(() => {
  const el = [...document.querySelectorAll("*")].find((e) => /Decided on your device/.test(e.textContent || ""));
  return el ? el.textContent.trim() : null;
});
await popup.screenshot({ path: `${OUT}/02-report-seal-arc-provenance.png` });
log("history row re-opens report", reopened === true || reopened === undefined ? true : reopened);
log("report seal has progress arc (dasharray)", !!sealArc, sealArc);
log("provenance line present", !!prov, prov);

// 4. Options — free-default CTA + provider grid
const opts = await openExtPage("options.html");
await opts.waitForTimeout(900);
const freeCta = await opts.evaluate(() => /Use ScamGuard.?s free default/.test(document.body.textContent || ""));
const grid = await opts.evaluate(() => { const g = document.querySelector("#provider-grid"); return g ? g.children.length : 0; });
await opts.screenshot({ path: `${OUT}/03-options-free-default.png` });
log("options shows free-default CTA", freeCta);
log("provider grid renders cards", grid > 0, `${grid} cards`);

// 5. locale validity (chrome.i18n permits // comments — strip before parse)
for (const loc of ["en", "es", "hi"]) {
  try {
    const raw = readFileSync(`${EXT_ROOT}/_locales/${loc}/messages.json`, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const obj = JSON.parse(raw);
    log(`_locales/${loc}/messages.json valid`, true, `${Object.keys(obj).length} keys`);
  } catch (e) {
    log(`_locales/${loc}/messages.json valid`, false, e.message);
  }
}

// 6. content-script probe: quikr.com, no proactive scan
const probe = await browser.newPage();
const errs = [];
probe.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await probe.goto("https://www.quikr.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
await probe.waitForTimeout(8000);
const noScan = await sw.evaluate(async () => {
  const s = await chrome.storage.session.get();
  return !Object.keys(s).some((k) => /analyz/i.test(k));
});
log("no proactive scanning on quikr.com load", noScan);
log("no console errors from content script", errs.length === 0, errs.slice(0, 2).join(" | "));
await probe.screenshot({ path: `${OUT}/04-quikr-probe.png` }).catch(() => {});

await browser.close();
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.steps.filter((s) => !s.ok).length;
console.log(`\n=== ENHANCED UI E2E: ${results.steps.length - failed}/${results.steps.length} passed ===`);
process.exit(failed > 0 ? 1 : 0);
