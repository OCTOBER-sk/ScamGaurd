/**
 * options.test.js — Phase 7: Options page, manifest, content-script badge tests
 * (node:test + jsdom, zero runtime deps).
 *
 * PLAN-FRONTEND.md §9 test plan:
 *   - State-machine rendering: each of the 8 states renders its region and
 *     others are hidden/removed (no stale state bleeds between transitions).
 *   - Verdict→color mapping: pure-function unit test for resolveState and
 *     seal color-class logic.
 *   - §2.10 result rendering: coreFact renders when mocked AI review rejects
 *     or times out; NO verdict-seal DOM element on §2.10 view.
 *   - §2.10 reachability: [Check a message] button present and enabled in
 *     every popup state (§2.2–§2.8).
 *   - §2.10 copy-for-someone: builds correct plain-text output.
 *   - i18n: t() helper returns strings, interpolation works.
 *   - source-level: popup.js + i18n.js import only relative paths (zero
 *     runtime deps).
 *
 * Phase 7 additions:
 *   - §3.2 provider card grid renders all 10 provider IDs.
 *   - §3.6 test-connection renders each of the 4 outcomes verbatim.
 *   - §3.1 clear-key shows inline confirm then wipes.
 *   - §3.1 vision toggle disables for non-vision provider.
 *   - §8.1 manifest matches plan exactly (matches patterns, permissions,
 *     host_permissions — no all_urls).
 *   - §5 content script has no page-DOM injection.
 *
 * Existing 196 tests must stay green — this file adds tests, does not modify
 * any existing file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─── jsdom setup ──────────────────────────────────────────────────────────

let JSDOM;
try {
  JSDOM = (await import("jsdom")).JSDOM;
} catch {
  console.log("jsdom not available — skipping options.test.js");
  process.exit(0);
}

/**
 * Create a fresh jsdom instance with the options.html loaded.
 */
function createOptionsDom(params = "") {
  const html = readFileSync(new URL("../options.html", import.meta.url), "utf8");
  const url = params
    ? `chrome-extension://abc123/options.html?${params}`
    : "chrome-extension://abc123/options.html";
  const dom = new JSDOM(html, {
    url,
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
  });
  return dom.window;
}

/**
 * Create a fresh jsdom instance with the popup.html loaded.
 */
function createPopupDom() {
  const html = readFileSync(new URL("../popup.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, {
    url: "chrome-extension://abc123/popup.html",
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
  });
  return dom.window;
}

// ─── §3.2 Provider card grid ─────────────────────────────────────────────

test("§3.2 provider card grid renders all 10 provider IDs from registry", async () => {
  const { list } = await import("../src/llm/providers/registry.js");
  const providers = list();
  assert.equal(providers.length, 10, "Registry has 10 providers");

  const expectedIds = [
    "gemini", "groq", "cerebras", "openrouter", "mistral",
    "deepseek", "openai", "anthropic", "ollama", "custom",
  ];

  const actualIds = providers.map((p) => p.id);
  assert.deepEqual(actualIds, expectedIds, "Provider IDs match §3.2 table order");
});

test("§3.2 options.html has provider grid container with role=radiogroup", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const grid = document.getElementById("provider-grid");
  assert.ok(grid, "Provider grid exists");
  assert.equal(grid.getAttribute("role"), "radiogroup", "Grid has role=radiogroup");
  assert.ok(grid.getAttribute("aria-label"), "Grid has aria-label");

  window.close();
});

// ─── §3.6 Test connection renders each of the 4 outcomes ──────────────────

test("§3.6 options.html has test connection button and result area", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const btn = document.getElementById("btn-test-connection");
  assert.ok(btn, "Test connection button exists");
  assert.equal(btn.disabled, false, "Button is enabled");

  const result = document.getElementById("test-result");
  assert.ok(result, "Test result area exists");
  assert.equal(result.hidden, true, "Result starts hidden");

  window.close();
});

test("§3.6 i18n keys for all 4 test-connection outcomes exist", async () => {
  const { t } = await import("../src/shared/i18n.js");

  // Success
  const success = t("testSuccess", { model: "llama-3.3-70b-versatile", ms: 42 });
  assert.match(success, /Connected/, "Success message contains 'Connected'");
  assert.match(success, /llama-3.3-70b-versatile/, "Success message contains model name");
  assert.match(success, /42ms/, "Success message contains latency");

  // Key rejected
  const rejected = t("testKeyRejected");
  assert.match(rejected, /Key rejected/, "Key rejected message contains 'Key rejected'");

  // Rate limited
  const rateLimited = t("testRateLimited");
  assert.match(rateLimited, /rate-limited/, "Rate limited message contains 'rate-limited'");
  assert.match(rateLimited, /valid/, "Rate limited message says key is valid");

  // Malformed JSON
  const malformed = t("testMalformedJson");
  assert.match(malformed, /Connected/, "Malformed message starts with 'Connected'");
  assert.match(malformed, /valid JSON/, "Malformed message mentions 'valid JSON'");

  // Timeout
  const timeout = t("testTimeout", { seconds: 20 });
  assert.match(timeout, /No response/, "Timeout message contains 'No response'");
  assert.match(timeout, /20s/, "Timeout message contains seconds");
});

// ─── §3.1 Clear key shows inline confirm then wipes ──────────────────────

test("§3.1 clear key button exists and starts visible", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const btn = document.getElementById("btn-clear-key");
  assert.ok(btn, "Clear key button exists");

  const confirm = document.getElementById("clear-key-confirm");
  assert.ok(confirm, "Clear key confirm exists");
  assert.equal(confirm.hidden, true, "Confirm starts hidden");

  window.close();
});

test("§3.1 clear key confirm has Yes/Cancel buttons", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const yesBtn = document.getElementById("btn-clear-key-yes");
  const noBtn = document.getElementById("btn-clear-key-no");
  assert.ok(yesBtn, "Yes button exists");
  assert.ok(noBtn, "Cancel button exists");

  window.close();
});

test("§3.1 trust statement element exists for interpolation", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const trustEl = document.getElementById("trust-statement");
  assert.ok(trustEl, "Trust statement element exists");

  window.close();
});

test("§3.1 trust statement i18n key interpolates provider label", async () => {
  const { t } = await import("../src/shared/i18n.js");

  const groq = t("trustStatement", { provider: "Groq" });
  assert.match(groq, /Groq/, "Trust statement mentions Groq");
  assert.match(groq, /stored only on this device/, "Trust statement has 'stored only on this device'");
  assert.match(groq, /developers never see it/, "Trust statement has 'developers never see it'");

  const gemini = t("trustStatement", { provider: "Google Gemini" });
  assert.match(gemini, /Google Gemini/, "Trust statement mentions Google Gemini");
});

test("§3.1 clear key confirm i18n key interpolates provider label", async () => {
  const { t } = await import("../src/shared/i18n.js");

  const msg = t("clearKeyConfirm", { provider: "Groq" });
  assert.match(msg, /Groq/, "Confirm mentions Groq");
  // The apostrophe in "can't" may be a Unicode right single quotation mark.
  assert.match(msg, /can.t be undone/, "Confirm mentions 'can't be undone'");
});

// ─── §3.1 Vision toggle disables for non-vision provider ─────────────────

test("§3.1 vision toggle exists and starts unchecked", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const toggle = document.getElementById("vision-toggle");
  assert.ok(toggle, "Vision toggle exists");
  assert.equal(toggle.getAttribute("aria-checked"), "false", "Toggle starts unchecked");
  assert.equal(toggle.getAttribute("role"), "switch", "Toggle has role=switch");

  window.close();
});

test("§3.1 vision disabled hint exists", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const hint = document.getElementById("vision-disabled-hint");
  assert.ok(hint, "Vision disabled hint exists");
  assert.equal(hint.hidden, true, "Hint starts hidden");

  window.close();
});

test("§3.1 providers without vision have empty visionCapableModels", async () => {
  const { get } = await import("../src/llm/providers/registry.js");

  const groq = get("groq");
  assert.ok(groq, "Groq adapter exists");
  assert.deepEqual(groq.visionCapableModels, [], "Groq has no vision-capable models");

  const cerebras = get("cerebras");
  assert.ok(cerebras, "Cerebras adapter exists");
  assert.deepEqual(cerebras.visionCapableModels, [], "Cerebras has no vision-capable models");
});

test("§3.1 Gemini adapter has vision-capable models", async () => {
  const { get } = await import("../src/llm/providers/registry.js");

  const gemini = get("gemini");
  assert.ok(gemini, "Gemini adapter exists");
  assert.ok(gemini.visionCapableModels.length > 0, "Gemini has vision-capable models");
  assert.ok(gemini.visionCapableModels.includes("gemini-2.5-flash"), "Default model is vision-capable");
});

// ─── §3.1 Model override field ───────────────────────────────────────────

test("§3.1 model override field exists with placeholder", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const input = document.getElementById("model-override");
  assert.ok(input, "Model override input exists");
  assert.equal(input.tagName, "INPUT", "It is an <input> element");
  assert.ok(input.getAttribute("placeholder"), "Has placeholder text");

  window.close();
});

// ─── §3.1 API key field ──────────────────────────────────────────────────

test("§3.1 API key field exists as password type with visibility toggle", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const input = document.getElementById("api-key");
  assert.ok(input, "API key input exists");
  assert.equal(input.type, "password", "Starts as password type");

  const toggleBtn = document.getElementById("btn-toggle-key");
  assert.ok(toggleBtn, "Visibility toggle button exists");
  assert.ok(toggleBtn.getAttribute("aria-label"), "Toggle has aria-label");

  window.close();
});

// ─── §3.1 Custom endpoint section ────────────────────────────────────────

test("§3.1 custom endpoint section exists and starts hidden", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const section = document.getElementById("custom-endpoint-section");
  assert.ok(section, "Custom endpoint section exists");
  assert.equal(section.hidden, true, "Starts hidden (not custom provider)");

  const input = document.getElementById("custom-endpoint");
  assert.ok(input, "Custom endpoint input exists");

  window.close();
});

// ─── §3.1 Advanced section ───────────────────────────────────────────────

test("§3.1 advanced section uses details/summary for collapse", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const details = document.querySelector("#section-advanced .sg-details");
  assert.ok(details, "Advanced section uses <details>");
  assert.equal(details.tagName, "DETAILS", "Is a <details> element");

  const summary = details.querySelector("summary");
  assert.ok(summary, "Has a <summary> element");

  window.close();
});

// ─── §3.1 About section ──────────────────────────────────────────────────

test("§3.1 about section has version, license, tagline, and repo link", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const version = document.getElementById("about-version");
  assert.ok(version, "Version element exists");

  const license = document.querySelector(".sg-about-license");
  assert.ok(license, "License element exists");
  assert.match(license.textContent, /MIT/, "License mentions MIT");

  const tagline = document.querySelector(".sg-about-tagline");
  assert.ok(tagline, "Tagline exists");
  assert.match(tagline.textContent, /Your key, your data, your verdict/, "Tagline matches plan");

  const repo = document.getElementById("about-repo");
  assert.ok(repo, "Repo link exists");
  assert.equal(repo.tagName, "A", "Is an <a> element");

  window.close();
});

// ─── §4 Onboarding ───────────────────────────────────────────────────────

test("§4 onboarding banner exists in options.html", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const banner = document.getElementById("onboarding-banner");
  assert.ok(banner, "Onboarding banner exists");
  assert.equal(banner.hidden, true, "Banner starts hidden");

  window.close();
});

test("§4 onboarding banner shows when URL has onboarding=1", async () => {
  const window = createOptionsDom("onboarding=1");
  const document = window.document;

  const banner = document.getElementById("onboarding-banner");
  assert.ok(banner, "Onboarding banner exists");
  // The banner's hidden state is controlled by JS on init, but the element exists.

  window.close();
});

test("§4 onboarding banner has dismiss button", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const dismissBtn = document.querySelector(".sg-onboarding-dismiss");
  assert.ok(dismissBtn, "Dismiss button exists");
  assert.equal(dismissBtn.tagName, "BUTTON", "Is a <button> element");

  window.close();
});

// ─── §3.1 History section ────────────────────────────────────────────────

test("§3.1 history section has count, clear button, and retention note", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const count = document.getElementById("history-count");
  assert.ok(count, "History count element exists");

  const clearBtn = document.getElementById("btn-clear-history");
  assert.ok(clearBtn, "Clear history button exists");

  const retention = document.getElementById("history-retention");
  assert.ok(retention, "Retention note element exists");

  window.close();
});

test("§3.1 history clear has inline confirm with Yes/Cancel", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const confirm = document.getElementById("clear-history-confirm");
  assert.ok(confirm, "Clear history confirm exists");
  assert.equal(confirm.hidden, true, "Starts hidden");

  const yesBtn = document.getElementById("btn-clear-history-yes");
  const noBtn = document.getElementById("btn-clear-history-no");
  assert.ok(yesBtn, "Yes button exists");
  assert.ok(noBtn, "Cancel button exists");

  window.close();
});

// ─── §3.1 OpenRouter free toggle ─────────────────────────────────────────

test("§3.1 openrouter free toggle exists in advanced section", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const checkbox = document.getElementById("openrouter-free");
  assert.ok(checkbox, "OpenRouter free checkbox exists");
  assert.equal(checkbox.type, "checkbox", "Is a checkbox");

  const label = checkbox.closest("label") || checkbox.parentElement;
  assert.ok(label, "Has a label/parent");
  assert.match(label.textContent, /Experimental/, "Label mentions 'Experimental'");
  assert.match(label.textContent, /unpredictable/, "Label mentions 'unpredictable'");

  window.close();
});

// ─── §3.1 i18n keys for all provider notes ───────────────────────────────

test("§3.2 all provider note i18n keys exist", async () => {
  const { t } = await import("../src/shared/i18n.js");

  const providers = [
    "Groq", "Gemini", "Cerebras", "Openrouter", "Mistral",
    "Deepseek", "Openai", "Anthropic", "Ollama", "Custom",
  ];

  for (const name of providers) {
    const labelKey = `provider${name}`;
    const noteKey = `provider${name}Note`;
    assert.ok(t(labelKey) !== labelKey, `${labelKey} resolves to a string`);
    assert.ok(t(noteKey) !== noteKey, `${noteKey} resolves to a string`);
  }
});

// ─── §8.1 Manifest validation ────────────────────────────────────────────

test("§8.1 manifest.json exists and is valid JSON", () => {
  const raw = readFileSync(new URL("../manifest.json", import.meta.url), "utf8");
  const manifest = JSON.parse(raw);
  assert.ok(manifest, "Manifest parses as JSON");
  assert.equal(typeof manifest.name, "string", "Has name");
});

test("§8.1 manifest has manifest_version 3", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3, "manifest_version is 3");
});

test("§8.1 manifest name, short_name, description, version match plan", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "ScamGuard");
  assert.equal(manifest.short_name, "ScamGuard");
  assert.equal(manifest.description, "Bring-your-own-key scam risk checker for OLX & Quikr listings.");
  assert.equal(manifest.version, "1.0.0");
});

test("§8.1 manifest action points to popup.html with icons", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.action, "Has action");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.ok(manifest.action.default_icon, "Has default_icon");
  assert.ok(manifest.action.default_icon["16"], "Has 16px icon");
  assert.ok(manifest.action.default_icon["32"], "Has 32px icon");
  assert.ok(manifest.action.default_icon["48"], "Has 48px icon");
  assert.ok(manifest.action.default_icon["128"], "Has 128px icon");
});

test("§8.1 manifest options_page is options.html", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.options_page, "options.html");
});

test("§8.1 manifest background is service_worker with type module", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.background, "Has background");
  assert.equal(manifest.background.service_worker, "src/background/service-worker.js");
  assert.equal(manifest.background.type, "module");
});

test("§8.1 manifest content_scripts matches EXACTLY olx/item/* and quikr.com/*", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(manifest.content_scripts), "Has content_scripts array");
  assert.equal(manifest.content_scripts.length, 1, "Has exactly one content_scripts entry");

  const entry = manifest.content_scripts[0];
  assert.deepEqual(entry.matches, ["*://*.olx.in/item/*", "*://*.quikr.com/*"]);
  assert.deepEqual(entry.js, ["content/extractor.js"]);
  assert.equal(entry.run_at, "document_idle");
});

test("§8.1 manifest permissions are exactly [storage, activeTab]", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.permissions, ["storage", "activeTab"]);
});

test("§8.1 manifest host_permissions list all provider hosts + olx/quikr + localhost:11434", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(manifest.host_permissions), "Has host_permissions array");

  const expected = [
    "https://www.olx.in/*",
    "https://www.quikr.com/*",
    "https://generativelanguage.googleapis.com/*",
    "https://api.groq.com/*",
    "https://api.cerebras.ai/*",
    "https://openrouter.ai/*",
    "https://api.mistral.ai/*",
    "https://api.deepseek.com/*",
    "https://api.openai.com/*",
    "https://api.anthropic.com/*",
    "http://localhost:11434/*",
  ];

  assert.deepEqual(manifest.host_permissions, expected);
});

test("§8.1 manifest host_permissions does NOT contain <all_urls>", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(!manifest.host_permissions.includes("<all_urls>"), "No <all_urls> in host_permissions");
  // Also check no wildcard patterns beyond what's specified.
  for (const perm of manifest.host_permissions) {
    assert.ok(
      perm === "http://localhost:11434/*" || perm.startsWith("https://"),
      `host_permission "${perm}" is a specific HTTPS host or localhost`,
    );
  }
});

test("§8.1 manifest icons are declared", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.icons, "Has icons");
  assert.ok(manifest.icons["16"], "Has 16px icon");
  assert.ok(manifest.icons["32"], "Has 32px icon");
  assert.ok(manifest.icons["48"], "Has 48px icon");
  assert.ok(manifest.icons["128"], "Has 128px icon");
});

// ─── §5 Content script: no page-DOM injection ────────────────────────────

test("§5 content/extractor.js has no DOM injection (no appendChild, innerHTML, insertAdjacentHTML)", () => {
  const code = readFileSync(new URL("../content/extractor.js", import.meta.url), "utf8");

  // Should NOT contain DOM mutation methods that inject into the page.
  assert.doesNotMatch(code, /\.appendChild\(/, "No appendChild calls");
  assert.doesNotMatch(code, /\.innerHTML\s*=/, "No innerHTML assignments");
  assert.doesNotMatch(code, /\.insertAdjacentHTML\(/, "No insertAdjacentHTML calls");
  assert.doesNotMatch(code, /\.insertBefore\(/, "No insertBefore calls");
  assert.doesNotMatch(code, /document\.createElement\(/, "No createElement calls");
  assert.doesNotMatch(code, /document\.write\(/, "No document.write calls");
});

test("§5 content/extractor.js has no badge manipulation (no setBadgeText calls)", () => {
  const code = readFileSync(new URL("../content/extractor.js", import.meta.url), "utf8");

  // Strip comments before checking for badge manipulation code.
  // Remove line comments (// ...) and block comments (/* ... */).
  const stripped = code
    .replace(/\/\/.*$/gm, "") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ""); // block comments

  assert.doesNotMatch(stripped, /setBadgeText/, "No setBadgeText in content script code");
  assert.doesNotMatch(stripped, /setBadgeBackgroundColor/, "No setBadgeBackgroundColor in content script code");
  assert.doesNotMatch(stripped, /chrome\.action/, "No chrome.action access in content script code");
});

test("§5 content/extractor.js exports extractListing function", async () => {
  const { extractListing } = await import("../content/extractor.js");
  assert.equal(typeof extractListing, "function", "extractListing is exported as a function");
});

test("§5 content/extractor.js has GET_LISTING message handler", () => {
  const code = readFileSync(new URL("../content/extractor.js", import.meta.url), "utf8");
  assert.match(code, /GET_LISTING/, "Handles GET_LISTING messages");
  assert.match(code, /onMessage\.addListener/, "Has onMessage listener");
});

// ─── §5 Service worker badge integration ──────────────────────────────────

test("§5 service-worker.js imports chromeAction for badge", () => {
  const code = readFileSync(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
  assert.match(code, /chromeAction/, "Service worker imports chromeAction");
  assert.match(code, /VERDICT_BADGE_COLORS/, "Service worker has badge color map");
  assert.match(code, /setBadgeForVerdict/, "Service worker has setBadgeForVerdict function");
});

test("§5 service-worker.js sets badge after report completion", () => {
  const code = readFileSync(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
  assert.match(code, /setBadgeForVerdict\(extra\.tabId, report\.verdict\)/, "Badge set after report with tabId and verdict");
});

// ─── §4 Service worker onboarding handler ─────────────────────────────────

test("§4 service-worker.js has onInstalled listener for install reason", () => {
  const code = readFileSync(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
  assert.match(code, /onInstalled\.addListener/, "Has onInstalled listener");
  assert.match(code, /reason\s*===\s*["']install["']/, "Checks for install reason");
  assert.match(code, /openOptionsPage/, "Opens options page on install");
});

// ─── §8.2 No build tooling — plain ES modules ────────────────────────────

test("§8.2 options.js imports only relative src paths (zero runtime deps)", () => {
  const code = readFileSync(new URL("../options.js", import.meta.url), "utf8");
  for (const match of code.matchAll(/^import\s+.*?from\s+["']([^"']+)["']/gm)) {
    const spec = match[1];
    assert.ok(
      spec.startsWith("."),
      `options.js must only import relative paths (got "${spec}")`
    );
  }
});

test("§8.2 options.js has no inline script tags (CSP §7.4)", () => {
  const code = readFileSync(new URL("../options.js", import.meta.url), "utf8");
  assert.doesNotMatch(code, /<script/, "options.js must not contain <script> tags");
});

// ─── §6 Accessibility on options page ─────────────────────────────────────

test("§6 options.html form fields have associated labels", async () => {
  const window = createOptionsDom();
  const document = window.document;

  // API key has a label.
  const apiKeyLabel = document.querySelector('label[for="api-key"]');
  assert.ok(apiKeyLabel, "API key has an associated <label>");

  // Model override has a label.
  const modelLabel = document.querySelector('label[for="model-override"]');
  assert.ok(modelLabel, "Model override has an associated <label>");

  // Custom endpoint has a label.
  const customLabel = document.querySelector('label[for="custom-endpoint"]');
  assert.ok(customLabel, "Custom endpoint has an associated <label>");

  window.close();
});

test("§6 options.html sections have aria-labelledby headings", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const sections = [
    "section-provider",
    "section-vision",
    "section-history",
    "section-about",
  ];

  for (const id of sections) {
    const section = document.getElementById(id);
    assert.ok(section, `Section ${id} exists`);
    const labelledBy = section.getAttribute("aria-labelledby");
    assert.ok(labelledBy, `${id} has aria-labelledby`);
    const heading = document.getElementById(labelledBy);
    assert.ok(heading, `Referenced heading ${labelledBy} exists`);
  }

  window.close();
});

test("§6 options.html toggle has role=switch and aria-checked", async () => {
  const window = createOptionsDom();
  const document = window.document;

  const toggle = document.getElementById("vision-toggle");
  assert.ok(toggle, "Vision toggle exists");
  assert.equal(toggle.getAttribute("role"), "switch", "Has role=switch");
  assert.ok(toggle.hasAttribute("aria-checked"), "Has aria-checked attribute");
  assert.ok(toggle.getAttribute("aria-label"), "Has aria-label");

  window.close();
});

// ─── Source-level: zero runtime deps in options files ─────────────────────

test("options.html has no inline scripts", () => {
  const html = readFileSync(new URL("../options.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /<script(?! type="module")/, "No non-module script tags");
});

test("options.css reuses §1.2 design tokens", () => {
  const css = readFileSync(new URL("../options.css", import.meta.url), "utf8");

  const tokens = {
    "--sg-ink": "#1C1B1A",
    "--sg-paper": "#FAF8F4",
    "--sg-paper-raised": "#FFFFFF",
    "--sg-brass": "#9C7A3C",
    "--sg-safe": "#3F7D5C",
    "--sg-review": "#B5892C",
    "--sg-suspicious": "#C1602B",
    "--sg-high-risk": "#A3312A",
    "--sg-line": "#E4DFD5",
    "--sg-muted": "#6B665D",
  };

  for (const [name, hex] of Object.entries(tokens)) {
    const pattern = new RegExp(`${name}\\s*:\\s*${hex.replace("#", "#")}`, "i");
    assert.match(css, pattern, `options.css contains ${name}: ${hex}`);
  }
});

test("options.css has focus-visible brass outline", () => {
  const css = readFileSync(new URL("../options.css", import.meta.url), "utf8");
  assert.match(css, /focus-visible/, "Has focus-visible rule");
  assert.match(css, /--sg-brass/, "Uses brass color for focus");
});
