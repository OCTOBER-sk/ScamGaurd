/**
 * build-harness.mjs — generates the browser E2E harness pages from the REAL
 * repo files + the REAL results.json produced by backend-e2e.mjs.
 *
 * Outputs:
 *   scripts/e2e/popup-harness.html     Report-state view (real RiskReport)
 *   scripts/e2e/message-harness.html   §2.10 message-check view (LikelyScam)
 *
 * CSS is LINKED to the real popup.css (not inlined) so screenshots always
 * reflect the current design. JS is inlined (with imports rewritten) because
 * the driver needs access to module-scoped functions (showMessageCheck, etc.).
 *
 * The real RiskReport + LikelyScam PaymentCheckReport are injected from
 * scripts/e2e/results.json into a chrome.* stub declared BEFORE the popup
 * module, so the REAL popup state machine renders real data.
 *
 * Usage:
 *   node scripts/e2e/build-harness.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = `${__dirname}/../..`;

const read = (p) => readFileSync(`${REPO}/${p}`, "utf8");
const write = (p, content) => writeFileSync(`${__dirname}/${p}`, content, "utf8");

// ─── inputs: REAL sources + REAL results ────────────────────────────────────

const results = JSON.parse(readFileSync(`${__dirname}/results.json`, "utf8"));
const report = results.report; // real RiskReport
const payment = results.paymentCheck; // real LikelyScam PaymentCheckReport

const popupHtml = read("popup.html");
const popupJs = read("popup.js");
const i18nJs = read("src/shared/i18n.js");
const browserApiJs = read("src/shared/browser-api.js");
const enJson = read("src/strings/en.json");

const scamText =
  "buyer said scan this QR code to receive the payment instantly";

// ─── bundle: splice real module sources into one inline ESM ─────────────────

function toEsm(moduleSource, options = {}) {
  let src = moduleSource;
  if (options.enJson) {
    src = src.replace(
      /^import en from "[^"]+" with \{[^}]*\};/m,
      `const en = ${enJson};`,
    );
  }
  src = src.replace(/^import [^;]+;\s*\n/gm, "");
  src = src.replace(/^export\s+(const|function|let|var)\b/gm, "$1");
  return src;
}

const bundle = [
  toEsm(i18nJs, { enJson: true }),
  toEsm(browserApiJs),
  toEsm(popupJs),
].join("\n\n");

// ─── chrome stub (classic script, runs BEFORE the module) ───────────────────

const historyEntry = [
  {
    reportId: report.reportId,
    listingTitle: report.listingTitle,
    score: report.score,
    verdict: report.verdict,
    createdAt: report.createdAt,
  },
];

function chromeStub() {
  return `(function () {
  var REPORT = ${JSON.stringify(report)};
  var PAYMENT = ${JSON.stringify(payment)};
  var HISTORY = ${JSON.stringify(historyEntry)};

  window.chrome = window.chrome || {};

  var respond = function (cb, resp) {
    if (typeof cb === "function") cb(resp);
  };

  var runtime = {
    onMessage: { addListener: function () {} },
    sendMessage: function (message, cb) {
      var type = message && message.type;
      switch (type) {
        case "GET_STATE":
          respond(cb, { ok: true, session: { status: "done", report: REPORT } });
          break;
        case "GET_HISTORY":
          respond(cb, { ok: true, history: HISTORY });
          break;
        case "CHECK_MESSAGE":
          respond(cb, { ok: true, report: PAYMENT });
          break;
        case "GET_LISTING":
          respond(cb, { ok: false, error: "harness: no live tab" });
          break;
        case "ANALYZE":
          respond(cb, { ok: false, error: "harness: analyze not run" });
          break;
        case "OPEN_OPTIONS":
        default:
          respond(cb, { ok: true });
      }
    }
  };
  chrome.runtime = runtime;

  chrome.storage = {
    session: {
      get: function (keys, cb) {
        if (typeof keys === "function") { cb = keys; }
        cb && cb({ session: { status: "done", report: REPORT } });
      }
    },
    local: {
      get: function (keys, cb) { if (typeof keys === "function") { cb = keys; } cb && cb({}); },
      set: function (items, cb) { cb && cb(); },
      remove: function (keys, cb) { cb && cb(); }
    }
  };

  chrome.tabs = {
    query: function (info, cb) { respond(cb, []); },
    sendMessage: function (tabId, msg, cb) { respond(cb, { ok: false }); }
  };

  chrome.action = {
    setBadgeText: function (details, cb) { respond(cb, undefined); },
    setBadgeBackgroundColor: function (details, cb) { respond(cb, undefined); },
    onClicked: { addListener: function () {} }
  };
})();`;
}

// ─── page shell ─────────────────────────────────────────────────────────────

const bodyInner = popupHtml
  .replace(/<script type="module"[^>]*><\/script>/g, "")
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .trim();

const backdropCss = `
html, body {
  width: 100% !important;
  min-width: 100% !important;
  max-height: none !important;
  min-height: 100vh !important;
  margin: 0 !important;
  background: #888 !important;
  display: flex !important;
  align-items: flex-start !important;
  justify-content: center !important;
  padding: 32px 16px !important;
  box-sizing: border-box;
}
#popup-frame {
  width: 360px;
  max-height: 620px;
  overflow-y: auto;
  background: var(--sg-paper, #FAF8F4);
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
}
#harness-note {
  position: fixed;
  bottom: 8px;
  left: 8px;
  right: 8px;
  text-align: center;
  font: 12px/1.4 ui-monospace, monospace;
  color: #444;
  background: rgba(255, 255, 255, 0.85);
  border-radius: 4px;
  padding: 4px 8px;
}
`;

function pageTemplate(title, driverJs) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — ScamGuard E2E harness</title>
  <link rel="stylesheet" href="../../popup.css">
  <style>
  ${backdropCss}
  </style>
</head>
<body>
  <!--
    E2E HARNESS — ${title}
    Links REAL popup.css for current design. JS is inlined (imports rewritten)
    because the driver needs access to module-scoped functions.
    chrome.* stub is declared BEFORE the popup module so the real state machine renders.
  -->
  <div id="popup-frame">
${bodyInner
    .split("\n")
    .map((l) => (l.length ? `    ${l}` : l))
    .join("\n")}
  </div>
  <div id="harness-note">ScamGuard E2E harness — ${title}. Links real popup.css.</div>

  <script>
  ${chromeStub()}
  </script>

  <script type="module">
  ${bundle}
  ${driverJs}
  </script>
</body>
</html>
`;
}

// ─── generate both pages ────────────────────────────────────────────────────

const popupDriver = `
// No driver needed — the GET_STATE stub answers "done" with the real
// RiskReport, so the real init() renders the Report state on load.
`;

const messageDriver = `
// §2.10 driver: let init() finish rendering the Report state from GET_STATE,
// then drive the real Message & Payment Check view (as [Check a message]
// would) against the real scan-to-receive scam text. CHECK_MESSAGE answers
// with the REAL LikelyScam PaymentCheckReport -> coreFact card renders.
setTimeout(function () {
  try {
    showMessageCheck(null);
    runMessageCheck({ mode: "pastedText", rawText: ${JSON.stringify(scamText)} });
  } catch (err) {
    console.error("[e2e driver]", err);
  }
}, 400);
`;

write("popup-harness.html", pageTemplate("Report state (real RiskReport)", popupDriver));
write("message-harness.html", pageTemplate("Message Check (LikelyScam)", messageDriver));

console.log("[build-harness] wrote scripts/e2e/popup-harness.html");
console.log("[build-harness] wrote scripts/e2e/message-harness.html");

// ─── render smoke-check: run the REAL popup bundle in jsdom ─────────────────
// jsdom executes the classic chrome stub during parse; the inline module
// bundle is evaluated explicitly in the jsdom realm (jsdom has no module
// loader). This proves the real popup.js state machine renders real data.

function assert(cond, label) {
  if (!cond) throw new Error(`smoke-check FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

async function smokeRender(page, waitMs, expected) {
  const html = readFileSync(`${__dirname}/${page}`, "utf8");
  const scripts = [
    ...html.matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]);
  assert(scripts.length === 2, `${page}: two inline scripts (stub + bundle)`);
  const [, bundle] = scripts;

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://www.olx.in/item/test-iid-1827354630.html",
  });
  dom.window.eval(bundle);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const doc = dom.window.document;

  console.log(`[smoke] ${page}`);
  for (const [label, fn] of expected) assert(fn(doc), label);
}

await smokeRender("popup-harness.html", 120, [
  ["report state visible", (d) => !d.getElementById("state-report").hidden],
  ["idle state hidden", (d) => d.getElementById("state-idle").hidden],
  ["seal shows real verdict", (d) => d.querySelector(".sg-seal-verdict")?.textContent.trim() === String(report.verdict)],
  ["seal shows real score", (d) => d.querySelector(".sg-seal-score")?.textContent.trim() === String(report.score)],
  ["red flags rendered", (d) => d.querySelectorAll(".sg-red-flag").length === (report.redFlags?.length ?? 0)],
  ["summary rendered", (d) => (d.getElementById("report-summary").textContent || "").trim().length > 0],
  ["history rendered", (d) => d.querySelectorAll(".sg-history-item").length === 1],
  ["payment nudge visible", (d) => !d.getElementById("payment-nudge").hidden],
]);

await smokeRender("message-harness.html", 700, [
  ["message-check view visible", (d) => !d.getElementById("view-message-check").hidden],
  ["result screen visible", (d) => !d.getElementById("mc-result-screen").hidden],
  ["input screen hidden", (d) => d.getElementById("mc-input-screen").hidden],
  ["verdict text is LikelyScam label", (d) => (d.getElementById("mc-verdict").textContent || "").includes("This looks like a common scam pattern")],
  ["coreFact card populated", (d) => (d.getElementById("mc-core-fact").textContent || "").length > 100],
  ["matched pattern chip rendered", (d) => (d.getElementById("mc-patterns").textContent || "").includes("Matched:")],
  ["driver switched away from report state", (d) => d.getElementById("state-report").hidden],
]);

console.log("[build-harness] render smoke-check PASSED");
