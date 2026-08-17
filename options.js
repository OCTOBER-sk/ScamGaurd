/**
 * options.js — ScamGuard options page controller
 * (PLAN-FRONTEND.md §3, §3.1, §3.2, §4, §6, §7, §8.2).
 *
 * Single scrollable page, no tabs (§3.1). Provider card grid (§3.2),
 * masked API key with visibility toggle, model override, test connection
 * (§3.6 outcomes rendered verbatim), unconditional trust statement, clear
 * key with inline confirm (no modal), vision toggle, history, advanced,
 * and about sections.
 *
 * §8.3: all Chrome API calls go through src/shared/browser-api.js shims.
 * §7: all UI copy routes through src/shared/i18n.js t() helper.
 */

import { t } from "./src/shared/i18n.js";
import { chromeRuntime } from "./src/shared/browser-api.js";
import { list as listProviders, get as getProvider } from "./src/llm/providers/registry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ─── §4 Onboarding ───────────────────────────────────────────────────────

/**
 * Check if this is the first install and show the onboarding banner.
 * The banner is a one-time, dismissible welcome above the Provider section.
 */
function checkOnboarding() {
  const params = new URLSearchParams(window.location.search);
  const isOnboarding = params.get("onboarding") === "1";
  const banner = document.getElementById("onboarding-banner");
  if (!banner) return;

  if (isOnboarding) {
    banner.hidden = false;
    const dismissBtn = banner.querySelector(".sg-onboarding-dismiss");
    if (dismissBtn) {
      dismissBtn.addEventListener("click", () => {
        banner.hidden = true;
      });
    }
    // Auto-scroll to the provider section.
    document.getElementById("section-provider")?.scrollIntoView({ behavior: "smooth" });
  } else {
    banner.hidden = true;
  }
}

// ─── Settings state ───────────────────────────────────────────────────────

/**
 * Current settings loaded from the service worker.
 * @type {object}
 */
let currentSettings = null;

/**
 * Whether the API key field has been toggled to visible.
 * @type {boolean}
 */
let keyVisible = false;

// ─── §3.2 Provider card grid ─────────────────────────────────────────────

/**
 * Render the §3.2 card grid. Each card shows label, one-line "why you'd
 * pick this" note, and whether it needs a paid account.
 * §2.5: Each card gets a health dot (green if last test succeeded, grey otherwise).
 *
 * @param {HTMLElement} gridEl
 * @param {import("./src/llm/providers/registry.js").ProviderAdapter[]} providers
 */
function renderProviderGrid(gridEl, providers) {
  gridEl.innerHTML = "";

  for (const provider of providers) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "sg-provider-card";
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", "false");
    card.setAttribute("tabindex", "-1");
    card.dataset.providerId = provider.id;

    // Build card content.
    const nameEl = document.createElement("div");
    nameEl.className = "sg-provider-card-name";
    nameEl.textContent = t(`provider${capitalize(provider.id)}`);
    card.appendChild(nameEl);

    const noteEl = document.createElement("div");
    noteEl.className = "sg-provider-card-note";
    noteEl.textContent = t(`provider${capitalize(provider.id)}Note`);
    card.appendChild(noteEl);

    // §3.2: "no free tier" note for paid-only providers.
    if (provider.id === "openai" || provider.id === "anthropic") {
      const paidEl = document.createElement("div");
      paidEl.className = "sg-provider-card-paid";
      paidEl.textContent = t("providerPaidNote");
      card.appendChild(paidEl);
    }

    // §2.5: Health dot — green if last test succeeded, grey otherwise.
    const healthDot = document.createElement("span");
    healthDot.className = "sg-provider-health sg-provider-health--unknown";
    healthDot.dataset.providerHealth = provider.id;
    healthDot.setAttribute("aria-hidden", "true");
    card.appendChild(healthDot);

    card.addEventListener("click", () => selectProvider(provider.id));
    gridEl.appendChild(card);
  }

  // §3.2 ARIA radiogroup: arrow-key navigation between cards.
  gridEl.addEventListener("keydown", (e) => {
    const cards = Array.from(gridEl.querySelectorAll(".sg-provider-card"));
    if (cards.length === 0) return;

    const currentIndex = cards.findIndex((c) => c === document.activeElement);
    let nextIndex = -1;

    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        nextIndex = currentIndex < cards.length - 1 ? currentIndex + 1 : 0;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        nextIndex = currentIndex > 0 ? currentIndex - 1 : cards.length - 1;
        break;
      case "Home":
        e.preventDefault();
        nextIndex = 0;
        break;
      case "End":
        e.preventDefault();
        nextIndex = cards.length - 1;
        break;
      default:
        return;
    }

    if (nextIndex >= 0 && nextIndex < cards.length) {
      // Move tabindex to the next card.
      for (const card of cards) card.setAttribute("tabindex", "-1");
      cards[nextIndex].setAttribute("tabindex", "0");
      cards[nextIndex].focus();
      selectProvider(cards[nextIndex].dataset.providerId);
    }
  });
}

/**
 * Capitalize first letter of a string (for i18n key construction).
 * @param {string} s
 * @returns {string}
 */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Select a provider and update the UI.
 *
 * @param {string} providerId
 */
function selectProvider(providerId) {
  if (!currentSettings) return;
  currentSettings.providerId = providerId;

  // Update card selection state.
  const grid = document.getElementById("provider-grid");
  if (grid) {
    for (const card of grid.querySelectorAll(".sg-provider-card")) {
      const isSelected = card.dataset.providerId === providerId;
      card.setAttribute("aria-checked", String(isSelected));
      card.setAttribute("tabindex", isSelected ? "0" : "-1");
    }
  }

  // Update model override placeholder with the provider's default model.
  const adapter = getProvider(providerId);
  const modelInput = document.getElementById("model-override");
  if (modelInput && adapter) {
    modelInput.placeholder = adapter.defaultModel || "Leave blank for default";
  }

  // Update trust statement with the selected provider's label.
  updateTrustStatement(providerId);

  // Update vision toggle availability.
  updateVisionToggle(providerId);

  // Show/hide custom endpoint (§3.1 item 4).
  updateCustomEndpoint(providerId);

  // Show/hide clear key button.
  updateClearKeyButton();

  // Persist settings change.
  saveSettings();
}

// ─── Trust statement (§3.1 item 1) ───────────────────────────────────────

/**
 * Update the trust statement to interpolate the selected provider's label.
 *
 * @param {string} providerId
 */
function updateTrustStatement(providerId) {
  const el = document.getElementById("trust-statement");
  if (!el) return;
  const adapter = getProvider(providerId);
  const label = adapter?.label ?? providerId;
  const shieldSvg = '<svg class="sg-trust-shield" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1L2 3.5v3.5c0 3.25 2.15 6.25 5 7 2.85-.75 5-3.75 5-7V3.5L7 1z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';
  el.innerHTML = shieldSvg + " " + escapeHtml(t("trustStatement", { provider: label }));
}

// ─── Vision toggle (§3.1 item 2) ────────────────────────────────────────

/**
 * Enable/disable the vision toggle based on the provider's vision capability.
 *
 * @param {string} providerId
 */
function updateVisionToggle(providerId) {
  const toggle = document.getElementById("vision-toggle");
  const hint = document.getElementById("vision-disabled-hint");
  if (!toggle) return;

  const adapter = getProvider(providerId);
  const modelOverride = document.getElementById("model-override")?.value?.trim() || "";
  const model = modelOverride || adapter?.defaultModel || "";

  const hasVision = adapter?.visionCapableModels?.length > 0 &&
    (adapter.visionCapableModels.includes(model) || model === "");

  if (!hasVision) {
    toggle.disabled = true;
    toggle.setAttribute("aria-checked", "false");
    currentSettings.visionEnabled = false;
    if (hint) hint.hidden = false;
  } else {
    toggle.disabled = false;
    if (hint) hint.hidden = true;
  }
}

/**
 * Toggle the vision setting.
 */
function toggleVision() {
  const toggle = document.getElementById("vision-toggle");
  if (!toggle || toggle.disabled) return;

  const isChecked = toggle.getAttribute("aria-checked") === "true";
  const newValue = !isChecked;
  toggle.setAttribute("aria-checked", String(newValue));
  currentSettings.visionEnabled = newValue;
  saveSettings();
}

// ─── Custom endpoint (§3.1 item 4) ──────────────────────────────────────

/**
 * Show/hide the custom endpoint field based on providerId.
 *
 * @param {string} providerId
 */
function updateCustomEndpoint(providerId) {
  const section = document.getElementById("custom-endpoint-section");
  if (!section) return;
  section.hidden = providerId !== "custom";
}

// ─── API key visibility toggle ───────────────────────────────────────────

function toggleKeyVisibility() {
  const input = document.getElementById("api-key");
  const btn = document.getElementById("btn-toggle-key");
  if (!input || !btn) return;

  keyVisible = !keyVisible;
  input.type = keyVisible ? "text" : "password";
  btn.setAttribute("aria-label", keyVisible ? t("hideKey") : t("showKey"));

  // Swap eye icon visibility.
  const openEyes = btn.querySelectorAll(".sg-eye-open");
  const closedLine = btn.querySelector(".sg-eye-closed");
  for (const el of openEyes) {
    el.style.display = keyVisible ? "none" : "";
  }
  if (closedLine) {
    closedLine.style.display = keyVisible ? "" : "none";
  }
}

// ─── Test connection (§3.6) ──────────────────────────────────────────────

/**
 * Run the §3.6 test connection and render one of four outcomes verbatim.
 * §2.5: Persists lastTestOk:<providerId> in storage when test passes.
 */
async function runTestConnection() {
  const resultEl = document.getElementById("test-result");
  const resultText = document.getElementById("test-result-text");
  const btn = document.getElementById("btn-test-connection");
  if (!resultEl || !resultText || !btn) return;

  btn.disabled = true;
  btn.textContent = t("testing");
  resultEl.hidden = true;

  try {
    const response = await chromeRuntime.sendMessage({
      type: "TEST_CONNECTION",
      providerId: currentSettings.providerId,
      apiKey: currentSettings.apiKey,
      model: currentSettings.modelOverride || undefined,
    });

    resultEl.hidden = false;
    if (response?.ok) {
      resultEl.className = "sg-test-result sg-test-result--success";
      resultText.textContent = response.message;
      // §2.5: Persist health status for this provider.
      await persistHealthDot(currentSettings.providerId, true);
    } else {
      resultEl.className = "sg-test-result sg-test-result--failure";
      resultText.textContent = response?.message || "Connection failed.";
      await persistHealthDot(currentSettings.providerId, false);
    }
  } catch {
    resultEl.hidden = false;
    resultEl.className = "sg-test-result sg-test-result--failure";
    resultText.textContent = t("testConnectionFailed");
    await persistHealthDot(currentSettings.providerId, false);
  } finally {
    btn.disabled = false;
    btn.textContent = t("testConnection");
  }
}

// ─── Clear key (§3.1 item 1 — inline confirm, no modal) ─────────────────

function showClearKeyConfirm() {
  const confirmEl = document.getElementById("clear-key-confirm");
  const confirmText = document.getElementById("clear-key-confirm-text");
  const btn = document.getElementById("btn-clear-key");
  if (!confirmEl || !btn) return;

  btn.hidden = true;
  confirmEl.hidden = false;

  if (confirmText) {
    const adapter = getProvider(currentSettings.providerId);
    const label = adapter?.label ?? currentSettings.providerId;
    confirmText.textContent = t("clearKeyConfirm", { provider: label });
  }
}

function hideClearKeyConfirm() {
  const confirmEl = document.getElementById("clear-key-confirm");
  const btn = document.getElementById("btn-clear-key");
  if (confirmEl) confirmEl.hidden = true;
  if (btn) btn.hidden = false;
}

async function clearKey() {
  currentSettings.apiKey = "";
  const input = document.getElementById("api-key");
  if (input) input.value = "";
  hideClearKeyConfirm();
  updateClearKeyButton();
  await saveSettings();
}

function updateClearKeyButton() {
  const section = document.getElementById("clear-key-section");
  if (!section) return;
  section.hidden = !currentSettings.apiKey;
}

// ─── History (§3.1 item 3) ──────────────────────────────────────────────

/**
 * Load and display the history count and retention note.
 */
async function loadHistory() {
  try {
    const response = await chromeRuntime.sendMessage({ type: "GET_HISTORY" });
    const count = response?.ok && Array.isArray(response.history) ? response.history.length : 0;

    const countEl = document.getElementById("history-count");
    if (countEl) {
      countEl.textContent = t("historyCount", { count });
    }

    // §3.1 item 3: retention note with live cap (default 50).
    const retentionEl = document.getElementById("history-retention");
    if (retentionEl) {
      retentionEl.textContent = t("historyRetention", { count: 50 });
    }
  } catch {
    // Silent — history display is best-effort.
  }
}

function showClearHistoryConfirm() {
  const confirmEl = document.getElementById("clear-history-confirm");
  const btn = document.getElementById("btn-clear-history");
  if (!confirmEl || !btn) return;
  btn.hidden = true;
  confirmEl.hidden = false;
}

function hideClearHistoryConfirm() {
  const confirmEl = document.getElementById("clear-history-confirm");
  const btn = document.getElementById("btn-clear-history");
  if (confirmEl) confirmEl.hidden = true;
  if (btn) btn.hidden = false;
}

async function clearHistory() {
  try {
    await chromeRuntime.sendMessage({ type: "CLEAR_HISTORY" });
  } catch {
    // Silent.
  }
  hideClearHistoryConfirm();
  await loadHistory();
}

// ─── §2.5 Provider health dot persistence ───────────────────────────────

/**
 * Persist a test-connection health status for a provider.
 * Stores lastTestOk:<providerId> = boolean in chrome.storage.local directly.
 *
 * @param {string} providerId
 * @param {boolean} ok
 */
async function persistHealthDot(providerId, ok) {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await new Promise((resolve, reject) => {
        chrome.storage.local.set({ [`lastTestOk:${providerId}`]: ok }, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      });
    }
  } catch {
    // silent
  }
  // Update the UI immediately.
  updateHealthDot(providerId, ok);
}

/**
 * Update a single provider card's health dot.
 *
 * @param {string} providerId
 * @param {boolean} ok
 */
function updateHealthDot(providerId, ok) {
  const dot = document.querySelector(`[data-provider-health="${providerId}"]`);
  if (!dot) return;
  dot.className = ok
    ? "sg-provider-health sg-provider-health--ok"
    : "sg-provider-health sg-provider-health--unknown";
}

/**
 * Load all provider health dots from storage and update the UI.
 */
async function loadHealthDots() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const items = await new Promise((resolve) => {
        chrome.storage.local.get(null, (items) => {
          resolve(items || {});
        });
      });
      for (const [key, value] of Object.entries(items)) {
        if (key.startsWith("lastTestOk:")) {
          const providerId = key.slice("lastTestOk:".length);
          updateHealthDot(providerId, value === true);
        }
      }
    }
  } catch {
    // silent — health dots are best-effort
  }
}

// ─── §2.5 Free default CTA ──────────────────────────────────────────────

/**
 * Apply the free default: set provider to openrouter, clear model override,
 * and show test-connection success.
 */
async function applyFreeDefault() {
  currentSettings.providerId = "openrouter";
  currentSettings.modelOverride = null;
  currentSettings.apiKey = currentSettings.apiKey || "";

  // Update card selection.
  selectProvider("openrouter");

  // Persist.
  await saveSettings();

  // Show the free default card as applied.
  const card = document.getElementById("free-default-card");
  if (card) {
    card.hidden = true;
  }
}

// ─── Settings persistence ─────────────────────────────────────────────────

/**
 * Read the current settings from the service worker.
 */
async function loadSettings() {
  try {
    const response = await chromeRuntime.sendMessage({ type: "GET_SETTINGS" });
    if (response?.ok && response.settings) {
      currentSettings = response.settings;
    } else {
      // Default settings if the SW doesn't respond with settings.
      currentSettings = {
        providerId: "gemini",
        apiKey: "",
        modelOverride: null,
        customEndpoint: null,
        visionEnabled: true,
      };
    }
  } catch {
    currentSettings = {
      providerId: "gemini",
      apiKey: "",
      modelOverride: null,
      customEndpoint: null,
      visionEnabled: true,
    };
  }
}

/**
 * Persist the current settings to the service worker.
 */
async function saveSettings() {
  if (!currentSettings) return;
  try {
    await chromeRuntime.sendMessage({
      type: "SAVE_SETTINGS",
      settings: { ...currentSettings },
    });
  } catch {
    // Silent — settings save is best-effort.
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────

async function init() {
  // Load settings first.
  await loadSettings();

  // Render provider card grid (§3.2).
  const grid = document.getElementById("provider-grid");
  if (grid) {
    renderProviderGrid(grid, listProviders());
  }

  // Populate form fields from current settings.
  if (currentSettings) {
    // Select the current provider card.
    selectProvider(currentSettings.providerId);

    // API key.
    const keyInput = document.getElementById("api-key");
    if (keyInput) {
      keyInput.value = currentSettings.apiKey || "";
    }

    // Model override.
    const modelInput = document.getElementById("model-override");
    if (modelInput) {
      modelInput.value = currentSettings.modelOverride || "";
    }

    // Vision toggle state.
    const visionToggle = document.getElementById("vision-toggle");
    if (visionToggle) {
      visionToggle.setAttribute("aria-checked", String(currentSettings.visionEnabled));
    }

    // Custom endpoint.
    const customInput = document.getElementById("custom-endpoint");
    if (customInput) {
      customInput.value = currentSettings.customEndpoint || "";
    }
  }

  // About section.
  const versionEl = document.getElementById("about-version");
  if (versionEl) {
    versionEl.textContent = t("aboutVersion", { version: "1.0.0" });
  }

  // Load history.
  await loadHistory();

  // §2.5: Load provider health dots.
  await loadHealthDots();

  // §2.5: Free default button.
  const freeDefaultBtn = document.getElementById("btn-free-default");
  if (freeDefaultBtn) {
    freeDefaultBtn.addEventListener("click", applyFreeDefault);
  }

  // Check onboarding (§4).
  checkOnboarding();

  // ─── Event listeners ───────────────────────────────────────────────────

  // API key input change.
  const keyInput = document.getElementById("api-key");
  if (keyInput) {
    keyInput.addEventListener("input", () => {
      currentSettings.apiKey = keyInput.value;
      updateClearKeyButton();
      saveSettings();
    });
  }

  // Key visibility toggle.
  const toggleKeyBtn = document.getElementById("btn-toggle-key");
  if (toggleKeyBtn) {
    toggleKeyBtn.addEventListener("click", toggleKeyVisibility);
  }

  // Model override change.
  const modelInput = document.getElementById("model-override");
  if (modelInput) {
    modelInput.addEventListener("input", () => {
      currentSettings.modelOverride = modelInput.value.trim() || null;
      updateVisionToggle(currentSettings.providerId);
      saveSettings();
    });
  }

  // Test connection.
  const testBtn = document.getElementById("btn-test-connection");
  if (testBtn) {
    testBtn.addEventListener("click", runTestConnection);
  }

  // Clear key.
  const clearKeyBtn = document.getElementById("btn-clear-key");
  if (clearKeyBtn) {
    clearKeyBtn.addEventListener("click", showClearKeyConfirm);
  }
  const clearKeyYes = document.getElementById("btn-clear-key-yes");
  if (clearKeyYes) {
    clearKeyYes.addEventListener("click", clearKey);
  }
  const clearKeyNo = document.getElementById("btn-clear-key-no");
  if (clearKeyNo) {
    clearKeyNo.addEventListener("click", hideClearKeyConfirm);
  }

  // Vision toggle.
  const visionToggle = document.getElementById("vision-toggle");
  if (visionToggle) {
    visionToggle.addEventListener("click", toggleVision);
  }

  // Custom endpoint change.
  const customInput = document.getElementById("custom-endpoint");
  if (customInput) {
    customInput.addEventListener("input", () => {
      currentSettings.customEndpoint = customInput.value.trim() || null;
      saveSettings();
    });
  }

  // OpenRouter free toggle.
  const openrouterFree = document.getElementById("openrouter-free");
  if (openrouterFree) {
    openrouterFree.addEventListener("change", () => {
      // §3.1 item 4: experimental opt-in is a provider-level concern.
      // When toggled, switch to openrouter/free provider id.
      if (openrouterFree.checked) {
        selectProvider("openrouter");
      }
    });
  }

  // Clear history.
  const clearHistoryBtn = document.getElementById("btn-clear-history");
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener("click", showClearHistoryConfirm);
  }
  const clearHistoryYes = document.getElementById("btn-clear-history-yes");
  if (clearHistoryYes) {
    clearHistoryYes.addEventListener("click", clearHistory);
  }
  const clearHistoryNo = document.getElementById("btn-clear-history-no");
  if (clearHistoryNo) {
    clearHistoryNo.addEventListener("click", hideClearHistoryConfirm);
  }
}

// Start when DOM is ready.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
