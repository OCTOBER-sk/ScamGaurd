/**
 * popup.js — ScamGuard popup state machine + rendering
 * (PLAN-FRONTEND.md §2, §2.10, §6, §7, §8.2).
 *
 * Eight mutually exclusive listing-report states (§2.2–§2.8) + one
 * independent §2.10 Message & Payment Check view. State is derived from
 * service-worker messages, never independently tracked — the popup asks
 * chrome.storage.session + sends GET_STATE on open rather than assuming
 * continuity (MV3 popups are destroyed on every close).
 *
 * §8.3: all Chrome API calls go through src/shared/browser-api.js shims.
 * §7: all UI copy routes through src/shared/i18n.js t() helper.
 * §6: aria-live="polite" on state container; focus-visible brass outline;
 *     text labels always paired with color signals.
 */

import { t } from "./src/shared/i18n.js";
import { chromeRuntime, chromeTabs } from "./src/shared/browser-api.js";

// ─── §2 Popup state machine ──────────────────────────────────────────────

/**
 * The eight listing-report popup states (§2.2–§2.8), plus a special
 * "messageCheck" pseudo-state for the §2.10 view.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const PopupState = Object.freeze({
  Idle: "idle",
  Analyzing: "analyzing",
  Report: "report",
  NoAnalysis: "noAnalysis",
  NoListing: "noListing",
  Error: "error",
  NoKey: "noKey",
  MessageCheck: "messageCheck",
});

/**
 * Map a service-worker AnalyzeResult kind (or session status) to the popup
 * state enum. The frontend never recomputes verdict bands — it renders
 * exactly what the backend decided (§2.4).
 *
 * @param {object} result  The SW ANALYZE response's `result` field, or null.
 * @param {{ stale?: boolean; message?: string | null } | null} sessionInfo
 * @returns {string} One of the PopupState values.
 */
export function resolveState(result, sessionInfo) {
  if (!result) {
    // No analysis result yet — check for stale session.
    if (sessionInfo?.stale) return PopupState.Error;
    return PopupState.Idle;
  }

  const kind = result.kind;

  // §2.4: report state — the frontend renders the verdict exactly as the
  // backend decided, never recomputing a band from the score.
  if (kind === "report") return PopupState.Report;

  // §2.5: LLM returned notAListing — distinct from an error.
  if (kind === "noAnalysis") return PopupState.NoAnalysis;

  // §2.6: extraction too low — pre-fetch, no network spent.
  if (kind === "noListing") return PopupState.NoListing;

  // §2.8: no key set — first-run / key cleared.
  if (kind === "noKey") return PopupState.NoKey;

  // §2.7: error state — heuristic block stays visible (§6).
  if (kind === "error") return PopupState.Error;

  // Stale analyzing session from GET_STATE.
  if (sessionInfo?.stale) return PopupState.Error;

  return PopupState.Idle;
}

// ─── DOM element cache ───────────────────────────────────────────────────

/**
 * Cached references to key DOM elements, populated once on init.
 * @type {Record<string, HTMLElement>}
 */
const $ = {};

function cacheDom() {
  $.stateContainer = document.getElementById("state-container");
  $.stateIdle = document.getElementById("state-idle");
  $.stateAnalyzing = document.getElementById("state-analyzing");
  $.stateReport = document.getElementById("state-report");
  $.stateNoAnalysis = document.getElementById("state-no-analysis");
  $.stateNoListing = document.getElementById("state-no-listing");
  $.stateError = document.getElementById("state-error");
  $.stateNoKey = document.getElementById("state-no-key");
  $.viewMessageCheck = document.getElementById("view-message-check");
  $.paymentNudge = document.getElementById("payment-nudge");
  $.historyFooter = document.getElementById("history-footer");

  // Idle
  $.idleText = $.stateIdle.querySelector(".sg-idle-text");

  // Analyzing
  $.analyzingSeal = document.getElementById("analyzing-seal");
  $.analyzingHeuristics = document.getElementById("analyzing-heuristics");
  $.analyzingLlmText = document.getElementById("analyzing-llm-text");

  // Report
  $.reportSeal = document.getElementById("report-seal");
  $.reportHeuristics = document.getElementById("report-heuristics");
  $.reportRedFlags = document.getElementById("report-red-flags");
  $.reportSummary = document.getElementById("report-summary");
  $.reportChecklist = document.getElementById("report-checklist");
  $.reportChecklistList = document.getElementById("report-checklist-list");
  $.reportResources = document.getElementById("report-resources");
  $.reportVision = document.getElementById("report-vision");
  $.btnCopyReport = document.getElementById("btn-copy-report");
  $.btnExportCard = document.getElementById("btn-export-card");
  $.btnRawData = document.getElementById("btn-raw-data");
  $.reportRawData = document.getElementById("report-raw-data");
  $.reportRawDataCode = document.getElementById("report-raw-data-code");

  // Error
  $.errorHeuristics = document.getElementById("error-heuristics");
  $.errorMessage = document.getElementById("error-message");
  $.errorActions = document.getElementById("error-actions");

  // NoKey
  $.btnChooseProvider = document.getElementById("btn-choose-provider");

  // §2.10 Message Check
  $.btnMcBack = document.getElementById("btn-mc-back");
  $.mcInputScreen = document.getElementById("mc-input-screen");
  $.mcResultScreen = document.getElementById("mc-result-screen");
  $.btnMcPaste = document.getElementById("btn-mc-paste");
  $.btnMcGuided = document.getElementById("btn-mc-guided");
  $.mcPasteForm = document.getElementById("mc-paste-form");
  $.mcGuidedForm = document.getElementById("mc-guided-form");
  $.mcPasteText = document.getElementById("mc-paste-text");
  $.btnMcPasteSubmit = document.getElementById("btn-mc-paste-submit");
  $.btnMcGuidedSubmit = document.getElementById("btn-mc-guided-submit");
  $.mcVerdict = document.getElementById("mc-verdict");
  $.mcCoreFact = document.getElementById("mc-core-fact");
  $.mcPatterns = document.getElementById("mc-patterns");
  $.mcAiReview = document.getElementById("mc-ai-review");
  $.btnMcCopy = document.getElementById("btn-mc-copy");

  // Header
  $.btnCheckMessage = document.getElementById("btn-check-message");

  // History
  $.historyList = document.getElementById("history-list");
  $.btnSeeAll = document.getElementById("btn-see-all");
}

// ─── State rendering ─────────────────────────────────────────────────────

/**
 * Show one state, hide all others. The state container's aria-live="polite"
 * ensures a screen-reader user hears the transition.
 *
 * @param {string} state  One of the PopupState values.
 */
function showState(state) {
  const regions = [
    $.stateIdle, $.stateAnalyzing, $.stateReport,
    $.stateNoAnalysis, $.stateNoListing, $.stateError,
    $.stateNoKey, $.viewMessageCheck,
  ];
  for (const el of regions) {
    if (el) el.hidden = true;
  }

  const nudgeVisible = state === PopupState.Report;
  if ($.paymentNudge) $.paymentNudge.hidden = !nudgeVisible;

  switch (state) {
    case PopupState.Idle: $.stateIdle.hidden = false; break;
    case PopupState.Analyzing: $.stateAnalyzing.hidden = false; break;
    case PopupState.Report: $.stateReport.hidden = false; break;
    case PopupState.NoAnalysis: $.stateNoAnalysis.hidden = false; break;
    case PopupState.NoListing: $.stateNoListing.hidden = false; break;
    case PopupState.Error: $.stateError.hidden = false; break;
    case PopupState.NoKey: $.stateNoKey.hidden = false; break;
    case PopupState.MessageCheck: $.viewMessageCheck.hidden = false; break;
    default: $.stateIdle.hidden = false; break;
  }
}

/**
 * Render the verdict seal at the 72px popup-header scale (§1.1).
 * The seal's color/label is driven by RiskReport.verdict — the frontend
 * never recomputes a band from the score (§2.4).
 *
 * @param {HTMLElement} container
 * @param {string} verdict   "Safe" | "Review" | "Suspicious" | "High-Risk"
 * @param {number | null} score  0-100
 */
function renderSeal(container, verdict, score) {
  const verdictClass = {
    "Safe": "safe",
    "Review": "review",
    "Suspicious": "suspicious",
    "High-Risk": "high-risk",
  }[verdict] || "safe";

  const verdictKey = {
    "Safe": "sealSafe",
    "Review": "sealReview",
    "Suspicious": "sealSuspicious",
    "High-Risk": "sealHighRisk",
  }[verdict] || "sealSafe";

  container.className = `sg-seal sg-seal--${verdictClass}`;
  container.innerHTML = `
    <span class="sg-seal-verdict">${escapeHtml(t(verdictKey))}</span>
    ${score != null ? `<span class="sg-seal-score">${Math.round(score)}</span>` : ""}
  `;
}

/**
 * Render the heuristic block (§2.3). Shows each triggered/not-triggered
 * signal as a row with a colored dot and label.
 *
 * @param {HTMLElement} container
 * @param {object | null} heuristics  HeuristicSignals from the SW
 */
function renderHeuristics(container, heuristics) {
  if (!heuristics || typeof heuristics !== "object") {
    container.innerHTML = "";
    return;
  }

  const rows = [];

  const pa = heuristics.priceAnomaly;
  if (pa) {
    rows.push({
      triggered: pa.triggered,
      label: "Price " + (pa.triggered ? `${Math.round((pa.ratioVsCategoryTypical ?? 0) * 100)}% below typical` : "within typical range"),
    });
  }

  const sa = heuristics.sellerAge;
  if (sa) {
    rows.push({
      triggered: sa.triggered,
      label: sa.triggered
        ? `New seller (${sa.itemsListed ?? 0} items)`
        : `Established seller (${sa.itemsListed ?? "?"} items)`,
    });
  }

  const ph = heuristics.photoSignals;
  if (ph) {
    rows.push({
      triggered: ph.triggered,
      label: ph.triggered
        ? `Low photo count (${ph.count} photos)`
        : `Adequate photos (${ph.count})`,
    });
  }

  const cl = heuristics.contactChannelLeak;
  if (cl) {
    rows.push({
      triggered: cl.triggered,
      label: cl.triggered ? "Contact details in listing" : "No contact leaks",
    });
  }

  const ul = heuristics.urgencyLanguage;
  if (ul) {
    rows.push({
      triggered: ul.triggered,
      label: ul.triggered ? "Urgency language detected" : "No urgency language",
    });
  }

  const of = heuristics.offPlatformPaymentLanguage;
  if (of) {
    rows.push({
      triggered: of.triggered,
      label: of.triggered ? "Off-platform payment language" : "No off-platform payment language",
    });
  }

  const af = heuristics.advanceFeeLanguage;
  if (af) {
    rows.push({
      triggered: af.triggered,
      label: af.triggered ? "Advance fee language detected" : "No advance fee language",
    });
  }

  if (rows.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <div class="sg-heuristic-title">${escapeHtml(t("heuristicTitle"))}</div>
    ${rows.map(r => `
      <div class="sg-heuristic-row">
        <span class="sg-heuristic-dot sg-heuristic-dot--${r.triggered ? "triggered" : "safe"}" aria-hidden="true"></span>
        <span class="sg-heuristic-label">${escapeHtml(r.label)}</span>
      </div>
    `).join("")}
  `;
}

/**
 * Render the red flags list (§2.4): sorted high → low, each row is a
 * details/summary accordion with a severity dot + label + chevron.
 *
 * @param {HTMLElement} container
 * @param {Array<{id: string; label: string; severity: "low"|"medium"|"high"; explanation: string}>} flags
 */
function renderRedFlags(container, flags) {
  if (!Array.isArray(flags) || flags.length === 0) {
    container.innerHTML = "";
    return;
  }

  // Sort: high first, then medium, then low.
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...flags].sort((a, b) =>
    (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
  );

  container.innerHTML = sorted.map(flag => `
    <details class="sg-red-flag">
      <summary class="sg-red-flag-header">
        <span class="sg-severity-dot sg-severity-dot--${flag.severity}" aria-hidden="true"></span>
        <span class="sg-severity-label sg-severity-label--${flag.severity}">${escapeHtml(flag.severity.toUpperCase())}</span>
        <span class="sg-red-flag-label">${escapeHtml(flag.label)}</span>
        <span class="sg-red-flag-chevron" aria-hidden="true">&#x25B8;</span>
      </summary>
      <div class="sg-red-flag-body">${escapeHtml(flag.explanation)}</div>
    </details>
  `).join("");
}

/**
 * Render the summary paragraph (§2.4).
 *
 * @param {HTMLElement} container
 * @param {string} summary
 */
function renderSummary(container, summary) {
  container.textContent = typeof summary === "string" ? summary : "";
}

/**
 * Render the safe-buying checklist (§2.4): collapsed by default.
 *
 * @param {HTMLElement} detailsEl
 * @param {HTMLElement} listEl
 * @param {string[]} checklist
 */
function renderChecklist(detailsEl, listEl, checklist) {
  if (!Array.isArray(checklist) || checklist.length === 0) {
    detailsEl.hidden = true;
    return;
  }
  detailsEl.hidden = false;
  const summary = detailsEl.querySelector(".sg-checklist-summary");
  summary.textContent = t("checklistExpand", { count: checklist.length });
  listEl.innerHTML = checklist.map(item =>
    `<li class="sg-checklist-item">${escapeHtml(item)}</li>`
  ).join("");
}

/**
 * Render reporting resources (§2.4): only shown on Suspicious/High-Risk.
 *
 * @param {HTMLElement} container
 * @param {Array<{label: string; value: string}>} resources
 */
function renderResources(container, resources) {
  if (!Array.isArray(resources) || resources.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = `
    <div class="sg-report-resources-title">${escapeHtml(t("reportResourcesTitle"))}</div>
    ${resources.map(r => {
      const isPhone = /^\d{10,}$/.test(r.value);
      const href = isPhone ? `tel:${r.value}` : `https://${r.value}`;
      return `
        <div class="sg-resource-row">
          <a class="sg-resource-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(r.value)}</a>
          <span>${escapeHtml(r.label)}</span>
        </div>
      `;
    }).join("")}
  `;
}

/**
 * Render vision analysis notes (§2.4): only if visionAnalysis.performed.
 *
 * @param {HTMLElement} container
 * @param {{ performed: boolean; notes: string[] }} vision
 */
function renderVision(container, vision) {
  if (!vision || !vision.performed || !Array.isArray(vision.notes) || vision.notes.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = `
    <div class="sg-vision-title">${escapeHtml(t("visionNotesTitle"))}</div>
    ${vision.notes.map(n => `<div class="sg-vision-note">${escapeHtml(n)}</div>`).join("")}
  `;
}

/**
 * Render the error state (§2.7): heuristic block stays visible + error card
 * with the backend-authored message + contextual action buttons.
 *
 * @param {object} result  The SW error result.
 * @param {object | null} heuristics
 */
function renderError(result, heuristics) {
  renderHeuristics($.errorHeuristics, heuristics);

  $.errorMessage.textContent = result.message || "Something went wrong.";

  // Build contextual action buttons per §2.7.
  $.errorActions.innerHTML = "";
  const action = result.action;

  if (action === "openSettings") {
    $.errorActions.appendChild(makeActionBtn(t("actionOpenSettings"), () => openOptionsPage()));
  } else if (action === "tryAgain") {
    $.errorActions.appendChild(makeActionBtn(t("actionTryAgain"), () => startAnalysis()));
  } else if (action === "switchProvider") {
    $.errorActions.appendChild(makeActionBtn(t("actionSwitchProvider"), () => openOptionsPage()));
  }
}

/**
 * Render the full Report state (§2.4).
 *
 * @param {object} report  RiskReport from the SW.
 */
function renderReport(report) {
  renderSeal($.reportSeal, report.verdict, report.score);
  renderHeuristics($.reportHeuristics, report.rawListing ? null : null);
  renderRedFlags($.reportRedFlags, report.redFlags);
  renderSummary($.reportSummary, report.summary);
  renderChecklist($.reportChecklist, $.reportChecklistList, report.checklist);

  // §2.4: reporting resources only on Suspicious/High-Risk.
  const showResources = report.verdict === "Suspicious" || report.verdict === "High-Risk";
  if (showResources) {
    renderResources($.reportResources, report.reportingResources);
  } else {
    $.reportResources.hidden = true;
  }

  renderVision($.reportVision, report.visionAnalysis);

  // Raw data (§2.4): Listing object in mono font for power users.
  $.reportRawData.hidden = true;
  $.reportRawDataCode.textContent = report.rawListing
    ? JSON.stringify(report.rawListing, null, 2)
    : "No raw data available.";
}

/**
 * Render the §2.10 Message & Payment Check result view.
 * The coreFact card ALWAYS renders (2px brass left border), even if AI
 * review fails/times out (§4.7). NO verdict seal on this screen (§2.10
 * deliberate design choice).
 *
 * @param {object} report  PaymentCheckReport from match.js.
 */
function renderMessageCheckResult(report) {
  $.mcInputScreen.hidden = true;
  $.mcResultScreen.hidden = false;

  // Verdict line — plain text + icon, NOT the seal motif (§2.10).
  const verdictClass = {
    LikelyScam: "scam",
    Caution: "caution",
    NoRedFlagsFound: "safe",
  }[report.verdict] || "safe";

  const verdictIcon = {
    LikelyScam: "\u26A0",
    Caution: "\u26A0",
    NoRedFlagsFound: "\u2714",
  }[report.verdict] || "\u2714";

  const verdictLabel = {
    LikelyScam: t("resultLikelyScam"),
    Caution: t("resultCaution"),
    NoRedFlagsFound: t("resultNoRedFlags"),
  }[report.verdict] || report.verdict;

  $.mcVerdict.className = `sg-mc-verdict sg-mc-verdict--${verdictClass}`;
  $.mcVerdict.innerHTML = `
    <span class="sg-mc-verdict-icon" aria-hidden="true">${verdictIcon}</span>
    <span>${escapeHtml(verdictLabel)}</span>
  `;

  // §2.10 coreFact card — ALWAYS renders, 2px brass left border.
  $.mcCoreFact.textContent = report.coreFact;

  // Matched patterns (§4.7).
  if (Array.isArray(report.matchedPatterns) && report.matchedPatterns.length > 0) {
    $.mcPatterns.innerHTML = report.matchedPatterns.map(p =>
      `<div class="sg-mc-pattern">Matched: ${escapeHtml(p.label)}</div>`
    ).join("");
  } else {
    $.mcPatterns.innerHTML = "";
  }

  // AI review row — hidden by default, shown if AI refines.
  $.mcAiReview.hidden = true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function makeActionBtn(label, onClick) {
  const btn = document.createElement("button");
  btn.className = "sg-action-btn";
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function openOptionsPage() {
  if (chromeRuntime?.sendMessage) {
    chromeRuntime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
  }
  // Fallback for extension context.
  if (typeof chrome !== "undefined" && chrome.runtime?.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
}

// ─── Report copy (§2.9) ──────────────────────────────────────────────────

/**
 * Build a plain-text report string from a RiskReport for clipboard copy.
 *
 * @param {object} report
 * @returns {string}
 */
function buildReportText(report) {
  const lines = [];
  lines.push(`ScamGuard Report`);
  lines.push(`Verdict: ${report.verdict} (${report.score}/100)`);
  lines.push("");
  if (report.listingTitle) lines.push(`Listing: ${report.listingTitle}`);
  if (report.listingUrl) lines.push(`URL: ${report.listingUrl}`);
  lines.push("");
  if (Array.isArray(report.redFlags) && report.redFlags.length > 0) {
    lines.push(`Red Flags (${report.redFlags.length}):`);
    for (const f of report.redFlags) {
      lines.push(`  [${f.severity.toUpperCase()}] ${f.label} — ${f.explanation}`);
    }
    lines.push("");
  }
  if (report.summary) {
    lines.push(`Summary: ${report.summary}`);
    lines.push("");
  }
  if (Array.isArray(report.checklist) && report.checklist.length > 0) {
    lines.push(`Safe-buying checklist:`);
    for (const item of report.checklist) {
      lines.push(`  ✓ ${item}`);
    }
    lines.push("");
  }
  if (Array.isArray(report.reportingResources) && report.reportingResources.length > 0) {
    lines.push(`Report fraud:`);
    for (const r of report.reportingResources) {
      lines.push(`  ${r.label}: ${r.value}`);
    }
    lines.push("");
  }
  lines.push("Checked with ScamGuard — your key, your data, your verdict.");
  return lines.join("\n");
}

/**
 * Copy report to clipboard (§2.9). Button label flips to "Copied ✓" for
 * 1.5s, then reverts.
 */
async function copyReport(report) {
  try {
    const text = buildReportText(report);
    await navigator.clipboard.writeText(text);
    $.btnCopyReport.textContent = t("copiedLabel");
    $.btnCopyReport.classList.add("sg-action-btn--copied");
    setTimeout(() => {
      $.btnCopyReport.textContent = t("actionsCopy");
      $.btnCopyReport.classList.remove("sg-action-btn--copied");
    }, 1500);
  } catch {
    // Clipboard API may fail in some contexts — silently ignore.
  }
}

/**
 * Export verdict seal + score + top flags as a 1080×1080 PNG share card
 * (§2.9). Uses plain Canvas 2D, zero network, zero deps.
 *
 * @param {object} report
 */
function exportCard(report) {
  const size = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // Background.
  ctx.fillStyle = "#FAF8F4";
  ctx.fillRect(0, 0, size, size);

  // Seal circle.
  const cx = size / 2;
  const cy = size / 2 - 60;
  const r = 140;

  const verdictColors = {
    Safe: "#3F7D5C",
    Review: "#B5892C",
    Suspicious: "#C1602B",
    "High-Risk": "#A3312A",
  };
  const sealColor = verdictColors[report.verdict] || "#9C7A3C";

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = sealColor;
  ctx.lineWidth = 6;
  ctx.stroke();

  // Verdict text.
  ctx.fillStyle = sealColor;
  ctx.font = "700 36px Georgia, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const verdictLabels = { Safe: "SAFE", Review: "REVIEW", Suspicious: "SUSPICIOUS", "High-Risk": "HIGH-RISK" };
  ctx.fillText(verdictLabels[report.verdict] || report.verdict.toUpperCase(), cx, cy - 20);

  // Score.
  ctx.font = "600 64px Georgia, serif";
  ctx.fillText(`${report.score}`, cx, cy + 30);

  // Score label.
  ctx.font = "400 24px sans-serif";
  ctx.fillStyle = "#6B665D";
  ctx.fillText("/ 100", cx, cy + 70);

  // Top 2 red flags.
  const topFlags = Array.isArray(report.redFlags) ? report.redFlags.slice(0, 2) : [];
  if (topFlags.length > 0) {
    ctx.fillStyle = "#1C1B1A";
    ctx.font = "600 28px sans-serif";
    ctx.textAlign = "center";
    let y = cy + r + 80;
    for (const flag of topFlags) {
      ctx.fillText(`[${flag.severity.toUpperCase()}] ${flag.label}`, cx, y);
      y += 44;
    }
  }

  // Wordmark.
  ctx.fillStyle = "#9C7A3C";
  ctx.font = "600 32px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("ScamGuard", cx, size - 60);

  // Download.
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scamguard-${report.verdict?.toLowerCase() ?? "report"}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

// ─── §2.10 Message Check ─────────────────────────────────────────────────

let mcListingContext = null;

function showMessageCheck(listingContext) {
  mcListingContext = listingContext || null;
  showState(PopupState.MessageCheck);

  // Reset to input screen.
  $.mcInputScreen.hidden = false;
  $.mcResultScreen.hidden = true;
  $.mcPasteForm.hidden = true;
  $.mcGuidedForm.hidden = true;
  $.btnMcPaste.hidden = false;
  $.btnMcGuided.hidden = false;
}

function hideMessageCheck() {
  showState(PopupState.Idle);
}

/**
 * Run the Message & Payment Check by sending the input to the service worker.
 * The SW calls match() from src/payment-check/match.js.
 *
 * @param {{ mode: string; rawText?: string; guidedAnswers?: object }} input
 */
async function runMessageCheck(input) {
  // Show loading/result view.
  $.mcInputScreen.hidden = true;
  $.mcResultScreen.hidden = false;
  $.mcVerdict.innerHTML = `<span class="sg-mc-verdict-icon" aria-hidden="true">&#x23F3;</span> <span>Checking&hellip;</span>`;
  $.mcCoreFact.textContent = "";
  $.mcPatterns.innerHTML = "";
  $.mcAiReview.hidden = true;

  try {
    const response = await chromeRuntime.sendMessage({
      type: "CHECK_MESSAGE",
      input: {
        ...input,
        listingContext: mcListingContext,
      },
    });

    if (response && response.ok && response.report) {
      renderMessageCheckResult(response.report);
    } else {
      $.mcVerdict.innerHTML = `<span>Could not check this message.</span>`;
      $.mcCoreFact.textContent = "";
    }
  } catch {
    $.mcVerdict.innerHTML = `<span>Could not check this message.</span>`;
    $.mcCoreFact.textContent = "";
  }
}

// ─── History ──────────────────────────────────────────────────────────────

/**
 * Render the last 5 history entries in the footer (§1.4).
 *
 * @param {Array<object>} historyList
 */
function renderHistory(historyList) {
  if (!Array.isArray(historyList) || historyList.length === 0) {
    $.historyList.innerHTML = `<li class="sg-history-empty">${escapeHtml(t("historyEmpty"))}</li>`;
    return;
  }

  const last5 = historyList.slice(-5).reverse();
  $.historyList.innerHTML = last5.map(item => {
    const verdictColors = {
      Safe: "var(--sg-safe)",
      Review: "var(--sg-review)",
      Suspicious: "var(--sg-suspicious)",
      "High-Risk": "var(--sg-high-risk)",
    };
    const dotColor = verdictColors[item.verdict] || "var(--sg-muted)";
    return `
      <li class="sg-history-item" data-report-id="${escapeHtml(item.reportId || "")}">
        <span class="sg-history-dot" style="background:${dotColor}" aria-hidden="true"></span>
        <span class="sg-history-title">${escapeHtml(item.listingTitle || "Untitled")}</span>
        <span class="sg-history-score">${item.score != null ? item.score : ""}</span>
      </li>
    `;
  }).join("");
}

// ─── Analysis flow ────────────────────────────────────────────────────────

let currentReport = null;

/**
 * Start the full analysis flow: GET_LISTING → ANALYZE → render.
 * Called when the popup opens on a listing page and there's no prior result.
 */
async function startAnalysis() {
  showState(PopupState.Idle);

  try {
    // Get the active tab.
    const tabs = await chromeTabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    if (!tab?.id) {
      showState(PopupState.Idle);
      return;
    }

    // Ask the service worker to extract listing data from the content script.
    const listingResponse = await chromeRuntime.sendMessage({
      type: "GET_LISTING",
      tabId: tab.id,
    });

    if (!listingResponse?.ok) {
      $.stateIdle.hidden = true;
      $.stateNoListing.hidden = false;
      return;
    }

    const listing = listingResponse.listing;
    if (!listing || listing.extractionConfidence === "low") {
      // §2.6: NoListing — extraction too low, shown pre-fetch.
      $.stateIdle.hidden = true;
      $.stateNoListing.hidden = false;
      return;
    }

    // Show Analyzing state immediately with the heuristic pre-check.
    showState(PopupState.Analyzing);
    renderHeuristics($.analyzingHeuristics, null); // heuristics come from the SW in the ANALYZE response

    // Start the LLM analysis.
    const analysisResponse = await chromeRuntime.sendMessage({
      type: "ANALYZE",
      listing,
    });

    if (!analysisResponse?.ok) {
      showState(PopupState.Idle);
      return;
    }

    const result = analysisResponse.result;
    const state = resolveState(result);

    if (state === PopupState.Report) {
      currentReport = result.report;
      renderReport(result.report);
      showState(PopupState.Report);
      $.paymentNudge.hidden = false;
    } else if (state === PopupState.Error) {
      renderError(result, result.heuristics);
      showState(PopupState.Error);
    } else if (state === PopupState.NoAnalysis) {
      showState(PopupState.NoAnalysis);
    } else if (state === PopupState.NoKey) {
      showState(PopupState.NoKey);
    } else {
      showState(PopupState.Idle);
    }
  } catch {
    showState(PopupState.Idle);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────

async function init() {
  cacheDom();
  showState(PopupState.Idle);

  // Bind event listeners.
  $.btnCheckMessage.addEventListener("click", () => showMessageCheck());

  $.btnMcBack.addEventListener("click", () => hideMessageCheck());

  $.btnMcPaste.addEventListener("click", () => {
    $.mcPasteForm.hidden = false;
    $.mcGuidedForm.hidden = true;
    $.btnMcPaste.hidden = true;
    $.btnMcGuided.hidden = false;
    $.mcPasteText.focus();
  });

  $.btnMcGuided.addEventListener("click", () => {
    $.mcGuidedForm.hidden = false;
    $.mcPasteForm.hidden = true;
    $.btnMcGuided.hidden = true;
    $.btnMcPaste.hidden = false;
  });

  $.btnMcPasteSubmit.addEventListener("click", () => {
    const text = $.mcPasteText.value.trim();
    if (!text) return;
    runMessageCheck({ mode: "pastedText", rawText: text });
  });

  $.btnMcGuidedSubmit.addEventListener("click", () => {
    const role = document.querySelector('input[name="mc-role"]:checked')?.value;
    const scan = document.querySelector('input[name="mc-scan"]:checked')?.value;
    const reason = document.getElementById("mc-reason")?.value?.trim() || null;

    const guidedAnswers = {
      role: role || "buying",
      wasAskedToScanOrApprove: scan === "yes",
      claimedReasonForCode: reason,
    };

    runMessageCheck({ mode: "describedFlow", guidedAnswers });
  });

  $.btnMcCopy.addEventListener("click", async () => {
    // Copy the coreFact + pattern info for forwarding to someone being scammed.
    const coreFact = $.mcCoreFact.textContent || "";
    const patterns = $.mcPatterns.textContent || "";
    const text = `${coreFact}\n\n${patterns}\n\nSent via ScamGuard`;
    try {
      await navigator.clipboard.writeText(text);
      $.btnMcCopy.textContent = t("copiedLabel");
      $.btnMcCopy.classList.add("sg-action-btn--copied");
      setTimeout(() => {
        $.btnMcCopy.textContent = t("copyForSomeone");
        $.btnMcCopy.classList.remove("sg-action-btn--copied");
      }, 1500);
    } catch {
      // silent
    }
  });

  // Payment nudge (§1.4) → opens message check with listing context.
  if ($.paymentNudge) {
    const nudgeBtn = $.paymentNudge.querySelector(".sg-nudge-btn");
    if (nudgeBtn) {
      nudgeBtn.addEventListener("click", () => {
        const ctx = currentReport?.rawListing
          ? { listingUrl: currentReport.listingUrl, listingTitle: currentReport.listingTitle }
          : null;
        showMessageCheck(ctx);
      });
    }
  }

  // Report actions.
  $.btnCopyReport.addEventListener("click", () => {
    if (currentReport) copyReport(currentReport);
  });

  $.btnExportCard.addEventListener("click", () => {
    if (currentReport) exportCard(currentReport);
  });

  let rawVisible = false;
  $.btnRawData.addEventListener("click", () => {
    rawVisible = !rawVisible;
    $.reportRawData.hidden = !rawVisible;
    $.btnRawData.textContent = rawVisible ? t("actionsRawDataHide") : t("actionsRawData");
    $.btnRawData.setAttribute("aria-expanded", String(rawVisible));
  });

  // NoKey → open options.
  $.btnChooseProvider.addEventListener("click", () => openOptionsPage());

  // Fetch initial state from the service worker.
  try {
    const stateResponse = await chromeRuntime.sendMessage({ type: "GET_STATE" });

    if (stateResponse?.ok) {
      const session = stateResponse.session;

      if (session?.status === "done" && session.report) {
        // §2.4: render the completed report.
        currentReport = session.report;
        renderReport(session.report);
        showState(PopupState.Report);
        $.paymentNudge.hidden = false;
      } else if (session?.status === "analyzing" && stateResponse.stale) {
        // §6: stale analyzing session — show error with interrupted message.
        renderError(
          { message: stateResponse.message || "Analysis may have been interrupted.", action: "tryAgain" },
          session.heuristics
        );
        showState(PopupState.Error);
      } else if (session?.status === "analyzing") {
        // Still analyzing — show the analyzing state with heuristics.
        showState(PopupState.Analyzing);
        renderHeuristics($.analyzingHeuristics, session.heuristics);
        // The analyzing LLM text stays as the default "Analyzing…"
      } else {
        // No session — start fresh analysis if on a listing page.
        startAnalysis();
      }
    } else {
      startAnalysis();
    }
  } catch {
    startAnalysis();
  }

  // Render history.
  try {
    const historyResponse = await chromeRuntime.sendMessage({ type: "GET_HISTORY" });
    if (historyResponse?.ok && Array.isArray(historyResponse.history)) {
      renderHistory(historyResponse.history);
    }
  } catch {
    // silent
  }
}

// Start when DOM is ready — guard against non-browser contexts (Node tests).
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
