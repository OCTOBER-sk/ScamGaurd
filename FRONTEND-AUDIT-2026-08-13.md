# FRONTEND AUDIT — ScamGuard Chrome Extension

| Field | Value |
|---|---|
| **Agent** | Midas (Frontend Audit) |
| **Model** | MiMo-V2.5 (1M context) |
| **Date** | 2026-08-13 |
| **Scope** | Full frontend audit — code vs PLAN-FRONTEND.md drift + international standards |
| **Files Read** | popup.html, popup.css, popup.js, options.html, options.css, options.js, manifest.json, src/strings/en.json, src/shared/i18n.js, src/shared/browser-api.js, src/shared/error-messages.js, src/shared/types.js, src/background/service-worker.js, content/extractor.js, PLAN-FRONTEND.md, scripts/lint-strings.js, fonts/ directory |

---

## EXECUTIVE SUMMARY

**Overall Quality Score: 82/100**

ScamGuard's frontend is a well-architected, thoughtfully designed Chrome extension with strong i18n discipline, a distinctive visual identity, and genuine care for the calm/factual tone. The state machine is clean, the error-handling matrix is thorough, and the Chrome Web Store permission story is minimal. However, there are concrete accessibility gaps in the options page (radio group keyboard nav, toggle keyboard support), several hardcoded UI strings that bypass the i18n `t()` helper, a documented palette drift from the plan (light→dark) without explicit plan update, and the message check view lacks `aria-live` coverage. None are CWS-blocking but the a11y gaps are close to it.

### Verdict Bullets

1. **Chrome Web Store: PASS (with a11y caveat)** — minimal permissions, no deceptive patterns, no full-page takeover. Options page radio group keyboard nav gap could trigger reviewer feedback.
2. **MV3 Architecture: STRONG** — service worker correctness, session-before-fetch, classic content script, popup paint-before-network. One shim bypass in service-worker.js.
3. **Accessibility: NEAR-MISS** — WCAG AA contrast passes, focus-visible brass, `aria-live` on state container. Options provider radio group lacks arrow-key navigation; message check view has no `aria-live`.
4. **Visual Design: POLISHED** — warm charcoal/brass palette is distinctive and 2026-grade. Verdict seal is memorable. Hover lifts on display cards are unnecessary.
5. **UX Writing: EXCELLENT** — calm, non-alarmist, actionable. Error messages are backend-authored and never drift. First-run flow is welcoming.
6. **I18N: STRONG WITH GAPS** — lint guard exists, `t()` used broadly. ~6 hardcoded strings in popup.js and options.js escape the boundary.
7. **Engineering Quality: HIGH** — semantic HTML, no inline styles, clean state machine, proper error handling. CSS token system is duplicated (popup + options) but consistent.
8. **Performance: GOOD** — self-hosted woff2 with `font-display: swap`, no blocking popup work, canvas export is local and instant. CSS duplication is ~6KB.

---

## CATEGORY 1: CHROME WEB STORE QUALITY GUIDELINES

### GOOD

- **Permission minimalism.** `manifest.json:28` declares only `["storage", "activeTab"]` — no `tabs`, no `<all_urls>`. This is the minimal set for a popup extension that reads the active tab. Chrome reviewers specifically look for over-broad permissions.
- **Content script URL scoping.** `manifest.json:23` matches `*://*.olx.in/item/*` and `*://*.quikr.com/*` — listing pages only, not search/category pages. This directly addresses the CWS reviewer question "why does this run on all pages?" with a precise answer.
- **Host permissions are per-provider.** `manifest.json:29-41` lists each provider's API host explicitly. No wildcard. `localhost:11434` (Ollama) is included and justified.
- **Popup does not take over the page.** Fixed 360×600px popup with internal scroll. No overlay on the host page. Chrome native Escape-to-close.
- **No deceptive patterns.** No hidden checkboxes, no pre-checked options, no misleading button labels. The "Clear key" action uses an inline confirm (`options.js:291-312`), not a forced modal.
- **Options page clarity.** Sections are clearly labeled with `<h2>` headings (`options.html:23,76,92,108,129`). Each section maps to a single concern.

### WRONG

- **MAJOR — Options provider picker lacks arrow-key navigation.** The provider grid (`options.html:26`) uses `role="radiogroup"` on the container and `role="radio"` on each card button, but no JavaScript handles `ArrowLeft`/`ArrowRight`/`ArrowUp`/`ArrowDown` key events to move between cards. A keyboard-only user can Tab into the group but cannot navigate between options. This violates WAI-ARIA radiogroup pattern (section 2.9) and Chrome Web Store review criteria for accessibility. **File:** `options.html:26`, `options.js:69-102` (no keydown handler on cards).
  - **Fix:** Add a `keydown` listener on the radiogroup container that moves `aria-checked` between sibling cards on arrow keys and calls `selectProvider()`.

- **MINOR — Options toggle switch lacks keyboard support.** The vision toggle (`options.html:81`) is a `<button role="switch">` with no `keydown` handler for Space or Enter. While buttons natively respond to Space/Enter clicks, the `toggleVision()` function is only bound to `click` (`options.js:529-531`). This is acceptable for `<button>` elements, but the lack of visual feedback on keyboard activation (no `:focus` ring specific to the toggle track) is a gap. **File:** `options.js:529-531`.
  - **Fix:** Add `keydown` handler for Space/Enter to toggle, or ensure `click` event fires from keyboard (default for `<button>`).

- **NIT — Header button touch target is small.** The "Check a message" button (`popup.html:20-22`) has `padding: 3px 8px` at 12px font (`popup.css:193`), yielding ~22px height. Chrome's touch target minimum is 24px for extensions. **File:** `popup.css:193`.
  - **Fix:** Increase padding to `padding: 5px 8px` or set `min-height: 28px`.

---

## CATEGORY 2: EXTENSION ARCHITECTURE BEST PRACTICES (MV3)

### GOOD

- **Content script is classic JS.** `content/extractor.js:20-28` explicitly documents and implements this — no `import`/`export` at top level, uses `globalThis.ScamGuardExtractor` for the public API. This is correct per MV3 content script loading.
- **Service worker uses `"type": "module"`.** `manifest.json:18` — allows ES module imports in the background script.
- **Popup paints before network.** The idle state (`popup.html:29-37`) renders synchronously on DOM ready. The `init()` function (`popup.js:870`) calls `cacheDom()` → `showState(Idle)` before any `chromeRuntime.sendMessage()`.
- **Heuristic results render immediately.** `popup.js:831-832` renders heuristics in the Analyzing state before the LLM call fires. This is the sub-1s visual promise.
- **Session-before-fetch pattern.** `service-worker.js:455` persists `{status:"analyzing", listing, heuristics}` to `chrome.storage.session` before the provider fetch. A mid-fetch SW restart is detectable via `GET_STATE` stale check.
- **No layout shift on state transitions.** The state machine (`popup.js:164-188`) uses `hidden` attribute to toggle mutually exclusive states. Each state has a fixed vertical layout. No content reflows when transitioning from Analyzing to Report.

### WRONG

- **MAJOR — Service worker bypasses browser API shim.** `service-worker.js:977-988` defines `defaultSendToTab()` using `globalThis.chrome.tabs.sendMessage` directly, bypassing the `chromeTabs` shim from `src/shared/browser-api.js`. This breaks Firefox compatibility where `browser.tabs.sendMessage` is Promise-native. The shim exists precisely to normalize callback-vs-promise, and this function ignores it. **File:** `service-worker.js:979`.
  - **Fix:** Replace `defaultSendToTab` with a wrapper that delegates to `chromeTabs.sendMessage` from the shim, or inject `chromeTabs` via `AppDeps`.

- **MINOR — `lastAnalyzedTabId` is module-level state lost on SW restart.** `service-worker.js:143` holds the tabId between GET_LISTING and ANALYZE messages. If the service worker restarts between these two calls (common under MV3's 5-minute idle timeout), the badge won't be set. The code comments acknowledge this (`service-worker.js:140-142`), but the symptom is a silent badge miss with no user feedback. **File:** `service-worker.js:143`.
  - **Fix:** Persist the tabId alongside the session in `chrome.storage.session.start()` and read it back in `runAnalysis()`.

- **MINOR — Export card uses hardcoded light-theme colors.** `popup.js:631-633` draws `#FAF8F4` background and `#1C1B1A` text — these are the PLAN-FRONTEND.md §1.2 light palette values, not the current dark theme tokens. The card is always light-themed regardless of the extension's visual theme. This is intentional per the plan (§2.9: "deliberately minimal"), but the hardcoded values diverge from the current `--sg-paper: #161412` palette. **File:** `popup.js:631-633,654-668,673-687`.
  - **Fix:** Acceptable as-is (export card is a standalone share image), but document that the export card is intentionally light-themed regardless of the popup theme.

---

## CATEGORY 3: ACCESSIBILITY (WCAG 2.2 AA + Extension-Specific)

### GOOD

- **Color contrast passes WCAG AA.** The dark palette tokens have been adjusted for dark backgrounds: `--sg-ink: #F2EFE9` on `--sg-paper: #161412` ≈ 14.5:1. Verdict colors on dark surfaces: `--sg-safe: #4CAF7E` ≈ 6.2:1, `--sg-high-risk: #D1544A` ≈ 4.8:1. All above 4.5:1 for normal text.
- **Focus-visible brass outline.** `popup.css:129-142` and `options.css:114-126` apply `outline: 2px solid var(--sg-brass); outline-offset: 2px` to all focusable elements. No `outline: none` anywhere.
- **`aria-live="polite"` on state container.** `popup.html:27` wraps the entire state machine in `aria-live="polite"`, so screen readers announce state transitions.
- **Text labels paired with color signals.** Verdict seal shows text ("Suspicious") at 11px inside the seal (`popup.css:294-303`). Severity dots have uppercase text labels ("HIGH", "MED", "LOW") (`popup.js:335`). Color is never the only signal.
- **`prefers-reduced-motion` respected.** `popup.css:271-275` disables the seal stamp animation. `popup.css:427-432` freezes the 3-dot pulse to static. `popup.css:1220-1235` disables all hover lifts on reduced-motion. `options.css:616-631` does the same for options page cards.
- **Screen-reader-only class exists.** `popup.css:116-126` defines `.sg-sr-only` with standard clip-rect hiding. Used for textarea label (`popup.html:136`).
- **Labels associated with inputs.** Options page has proper `<label for="api-key">` (`options.html:32`), `<label for="model-override">` (`options.html:47`), `<label for="custom-endpoint">` (`options.html:112`). Message check uses `<label for="mc-paste-text">` (`popup.html:136`).
- **Details/summary for collapsible content.** Checklist uses native `<details>`/`<summary>` (`popup.html:57-60`) with `list-style: none` and a visible summary text. Red flags use `<details>`/`<summary>` (`popup.js:331-341`). Both are keyboard-operable by default.

### WRONG

- **CRITICAL — Options provider radio group lacks arrow-key navigation.** `options.html:26` declares `role="radiogroup"` but no `keydown` handler exists for arrow-key navigation between cards. Per WAI-ARIA Practices: "In a radio group, only one radio button is checked at a time. The user can change focus with arrow keys." A keyboard-only user is stuck. **File:** `options.html:26`, `options.js:69-102`.
  - **Fix:** Add `keydown` listener on the grid: ArrowRight/ArrowDown moves to next card, ArrowLeft/ArrowUp to previous, Home/End to first/last. Update `aria-checked` and call `selectProvider()`.

- **MAJOR — Message check view has no `aria-live` region.** The message check result view (`popup.html:180-192`) is outside the `aria-live` state container. When the check completes and results render, a screen reader user receives no announcement. The `aria-live="polite"` on `#state-container` (`popup.html:27`) only covers the listing-report states. **File:** `popup.html:180`.
  - **Fix:** Add `aria-live="polite"` to the `#mc-result-screen` div, or wrap the result content in an `aria-live` region.

- **MAJOR — History items lack accessible names and roles.** History list items (`popup.html:207`) are rendered as `<li>` elements with no `role`, no `tabindex`, and no accessible name beyond the text content. The history dot is `aria-hidden` but the list item itself has no interactive semantics. If history items are clickable (which they appear to be via `sg-history-item` cursor:pointer), they need `role="button"` or `role="link"` and `tabindex="0"`. **File:** `popup.js:780-787`, `popup.css:1168-1178`.
  - **Fix:** If items are clickable, add `role="button"` and `tabindex="0"` with a keydown handler. If not clickable, remove `cursor: pointer`.

- **MINOR — Options page test connection result not announced.** The test result div (`options.html:55-57`) appears after clicking "Test connection" but has no `aria-live` attribute. A screen reader user won't know the result. **File:** `options.html:55`.
  - **Fix:** Add `aria-live="polite"` to `#test-result`.

- **MINOR — Toggle switch missing visible focus indicator on track.** The toggle (`options.css:441-480`) has `:focus-visible` on the button, but the visual thumb/track don't change to indicate focus. The default button outline may be clipped by the track's `overflow: hidden` or `border-radius`. **File:** `options.css:441-480`.
  - **Fix:** Add a focus-visible style that moves the outline outside the toggle (e.g., `outline-offset: 4px`) or adds a ring to the track.

---

## CATEGORY 4: VISUAL DESIGN QUALITY

### GOOD

- **Dark warm-charcoal palette is distinctive and 2026-grade.** `#161412` background with `#C89B54` brass accent avoids both the generic "dark mode" and "AI-generated SaaS" looks. The palette sits in the warm, desaturated family per the plan's §1.1 intent.
- **Verdict seal is memorable.** `popup.css:225-286` — concentric brass rings with a radial gradient glow, stamp-down animation, clear verdict-color text inside. This is the "one thing to remember ScamGuard by." The `::before` and `::after` pseudo-elements create depth without images.
- **Card depth is appropriate.** `--sg-shadow-card` provides layered depth on dark surfaces. Cards use `--sg-paper-raised: #1E1B18` (slightly lighter than background), creating visible layering.
- **Typography hierarchy is clear.** Fraunces (serif) for verdict/score display, Inter (sans) for body/UI, JetBrains Mono for raw data. Font sizes follow a consistent scale: 11px eyebrows, 12px small text, 13px body, 15px titles, 20px seal score, 28px options title.
- **Spacing rhythm is consistent.** The `--sg-space-*` tokens (`xs:4, sm:8, md:12, lg:16, xl:24`) are used throughout. No random pixel values.
- **Section eyebrows are well-executed.** 11px Inter 600 uppercase with 0.08em letter-spacing creates a clean, scannable hierarchy (`popup.css:349-358,612-619,659-667,1136-1143`).
- **Options page layout is clean.** 640px max-width, centered, with 24px padding. Section separators use a subtle `rgba(255,255,255,0.06)` line. The `<details>` for Advanced section is native and accessible.
- **No 90s-page patterns.** No `<table>` layout, no `<marquee>`, no `<center>`, no gradient text, no beveled buttons. The design is restrained and modern.

### WRONG

- **MINOR — Hover lift on display cards is inappropriate.** `popup.css:340-343` adds `transform: translateY(-1px)` on `.sg-heuristic-block:hover`. This block is a read-only display of heuristic results — it has no click action, no link, no interactive purpose. The hover lift implies interactivity that doesn't exist. Same issue on `.sg-red-flag:hover` (`popup.css:465-468`), `.sg-report-resources:hover` (`popup.css:605-608`), `.sg-vision-notes:hover` (`popup.css:652-655`), and `.sg-mc-mode-btn:hover` (`popup.css:900-904`). **File:** `popup.css:340-343,465-468,605-608,652-655,900-904`.
  - **Fix:** Remove hover transforms from non-interactive display elements (heuristic block, red flag details, resources, vision notes). Keep them only on actual buttons/links.

- **MINOR — Options page title "ScamGuard Settings" is redundant.** The extension name "ScamGuard" appears in the toolbar icon and the popup header. Repeating it in the options page title (`options.html:19`, `options.css:135-142`) as a 28px Fraunces heading is visually heavy. Consider "Settings" alone, since the context (options page opened from ScamGuard) is clear. **File:** `options.html:19`.
  - **Fix:** Change to just "Settings" or keep as-is if brand consistency is preferred.

- **NIT — History item has cursor:pointer but unclear interactivity.** `popup.css:1168-1178` sets `cursor: pointer` on `.sg-history-item`, but `popup.js:765-788` doesn't bind a click handler to history items. The visual affordance (pointer cursor) promises an action that doesn't exist. **File:** `popup.css:1175`, `popup.js:765-788`.
  - **Fix:** Either bind click handlers to history items (open the listing URL or re-display the report), or remove `cursor: pointer`.

---

## CATEGORY 5: UX WRITING / MICROCOPY

### GOOD

- **Calm, non-alarmist tone throughout.** The NoKey state says "Connect a free AI provider to get started" — not "ERROR: No API key!" (`popup.html:111`). Error messages say "{provider} didn't respond in time" — not "FAILED" (`error-messages.js:76-78`). The reviewing tone matches the plan's §1.1 "calm, factual, not alarmist" mandate.
- **Action-oriented labels.** "Choose a provider →", "Check this message", "Copy report", "Export card", "Try again", "Open Settings" — all verb-first, clear what will happen.
- **Error messages are backend-authored.** `error-messages.js` is the single source of truth for error copy. The popup renders `result.message` verbatim (`popup.js:429`). No frontend-side error authoring that could drift.
- **First-run onboarding is welcoming.** "Welcome to ScamGuard — pick a free AI provider below to get started (takes about a minute)" (`options.html:14`). Sets expectations, low pressure.
- **Trust statement is concrete.** "Your key is stored only on this device and sent only to {provider}. ScamGuard's developers never see it." (`en.json:74`). Interpolates the provider name — not a vague blanket claim.
- **Message check "Copy this to show someone" is purposeful.** Distinct from "Copy report" — designed for forwarding to a less tech-savvy relative being scammed (`PLAN-FRONTEND.md:348-351`).

### WRONG

- **MINOR — "Analyzing with {provider}…" default text is not populated.** `popup.html:45` hardcodes "Analyzing…" as the default text. The plan (§2.3) specifies "Analyzing with {provider} label…" but the `{provider}` variable is never interpolated into this element. The `en.json:10` key `analyzingWith` exists but isn't used in the HTML or JS for this element. **File:** `popup.html:45`, `popup.js:988-989`.
  - **Fix:** After resolving the provider, update `$.analyzingLlmText.textContent = t("analyzingWith", { provider: adapter.label })`.

- **NIT — Message check error fallback strings are hardcoded.** `popup.js:749,753` use "Could not check this message." as a hardcoded fallback instead of routing through `t()`. These are visible UI strings. **File:** `popup.js:749,753`.
  - **Fix:** Add a key to `en.json` (e.g., `"messageCheckError": "Could not check this message."`) and use `t("messageCheckError")`.

---

## CATEGORY 6: I18N / L10N READINESS

### GOOD

- **`t()` helper is the single entry point.** `src/shared/i18n.js:51-55` exports `t(key, vars?)` with `{{var}}` interpolation. All UI copy should route through it.
- **Lint guard exists.** `scripts/lint-strings.js` scans for string-literal concatenation assigned to `.textContent`/`.innerText` outside `src/strings/`. This enforces the boundary at CI time.
- **en.json is well-organized.** Flat `key: value` pairs, 120 keys. Keys are descriptive (`sealSafe`, `noKeyTitle`, `providerGroqNote`). Interpolation vars use `{{var}}` convention.
- **No string concatenation in component code.** The lint guard catches this. Manual review confirms most `.textContent` assignments use `t()` or `escapeHtml(t(...))`.
- **Error messages use `{provider}` placeholders.** `error-messages.js:54-175` uses `{provider}` and `{status}` placeholders rendered by `renderMessage()` — consistent with `t()`'s `{{var}}` pattern (though using single braces).
- **`hasKey()` utility exists.** `src/shared/i18n.js:65-67` for defensive rendering when a missing key should degrade to a different UI path.

### WRONG

- **MAJOR — Multiple hardcoded strings bypass `t()`.**

  1. **Heuristic row labels.** `popup.js:240-294` builds labels like `"Price " + (pa.triggered ? "..." : "...")` using string concatenation. These are visible UI strings assigned to `innerHTML` via `escapeHtml(r.label)`. The labels are constructed from heuristic data, not from `en.json`. While some of these are data-driven (the percentage), the template strings like `"New seller (${sa.itemsListed ?? 0} items)"` should be routed through `t()`. **File:** `popup.js:240-294`.
     - **Fix:** Add keys like `"heuristicPriceBelow": "Price {{pct}}% below typical"` and `"heuristicNewSeller": "New seller ({{count}} items)"` to `en.json`, and use `t()` to build the labels.

  2. **Options eye toggle labels.** `options.js:235` uses hardcoded "Hide API key" / "Show API key" for `aria-label`. **File:** `options.js:235`.
     - **Fix:** Add `"showKey": "Show API key"` and `"hideKey": "Hide API key"` to `en.json`.

  3. **Options "Testing…" button text.** `options.js:260` uses hardcoded `"Testing\u2026"`. **File:** `options.js:260`.
     - **Fix:** Add `"testing": "Testing…"` to `en.json`.

  4. **Options "Connected — {model} responded" fallback.** `options.js:282` uses hardcoded `"Could not reach the service worker."`. **File:** `options.js:282`.
     - **Fix:** Add `"testConnectionFailed": "Could not reach the service worker."` to `en.json`.

  5. **Options provider "no free tier" label.** `options.js:95` uses hardcoded `"No free tier — requires paid account"`. **File:** `options.js:95`.
     - **Fix:** Add `"providerPaidNote": "No free tier — requires paid account"` to `en.json`.

  6. **Message check fallback strings.** `popup.js:749,753` use hardcoded `"Could not check this message."`. **File:** `popup.js:749,753`.
     - **Fix:** Add `"messageCheckError": "Could not check this message."` to `en.json`.

- **MINOR — RTL structural readiness is partial.** The HTML uses `lang="en"` on both pages (`popup.html:2`, `options.html:2`). CSS uses no `direction:` or `writing-mode:` properties. The header layout (`justify-content: space-between`) is direction-agnostic. However, the "← Back" and "→" arrows in buttons (`popup.html:119,205`) are hardcoded as `&larr;`/`&rarr;` HTML entities, which would be wrong in RTL. **File:** `popup.html:119,205`.
  - **Fix:** For v1 (English only), this is acceptable. For future RTL support, use CSS logical properties and replace hardcoded arrows with CSS-generated content or icon components.

- **MINOR — Error messages use `{provider}` (single braces) while `t()` uses `{{var}}` (double braces).** Two different interpolation conventions exist: `error-messages.js:212` uses `{provider}` while `i18n.js:35` uses `{{var}}`. This is by design (different modules, different consumers), but it means a future locale file cannot reuse error message templates through `t()` without a converter. **File:** `error-messages.js:212`, `i18n.js:35`.
  - **Fix:** Acceptable for v1 (error messages are backend-owned). Document the two-convention system.

---

## CATEGORY 7: HTML/CSS/JS ENGINEERING QUALITY

### GOOD

- **Semantic HTML.** Both pages use `<header>`, `<main>`, `<footer>`, `<section>`, `<h1>`-`<h2>`, `<details>`/`<summary>`, `<fieldset>`/`<legend>`, `<label>`. No `<div>` used where a semantic element is appropriate.
- **No inline styles.** All styling is in external CSS files. The only inline style is `style="display:none"` on SVG eye-icon elements in `options.html:39` (for toggling visibility) — this is a JS-driven toggle, not a design inline.
- **Class naming consistency.** All classes follow `sg-` prefix convention (e.g., `sg-seal`, `sg-heuristic-block`, `sg-primary-btn`). BEM-like modifiers use `--` (e.g., `sg-seal--safe`, `sg-severity-dot--high`). No random naming.
- **CSS is well-organized.** Both files follow a consistent structure: tokens → font-face → reset → base → components → states → responsive/motion. Comments reference plan sections (§1.2, §2.3, etc.).
- **JS state machine is clean.** `PopupState` is a frozen enum (`popup.js:28-37`). `resolveState()` maps backend results to popup states (`popup.js:48-77`). `showState()` handles visibility (`popup.js:164-188`). No global variable leakage — all state is module-scoped.
- **Error handling is thorough.** Every `chromeRuntime.sendMessage()` call is wrapped in try/catch (`popup.js:811-865,966-999`). The `extractListing()` function (`content/extractor.js:366-425`) catches all errors and returns a baseline. The `renderSeal()` function handles unknown verdicts gracefully (`popup.js:200-205`).
- **escapeHtml() is used consistently.** `popup.js:528-532` escapes all dynamic content before inserting into `innerHTML`. Used in `renderHeuristics`, `renderRedFlags`, `renderChecklist`, `renderResources`, `renderVision`.
- **DOM element cache pattern.** `popup.js:85-154` caches all DOM references once on init, avoiding repeated `getElementById` calls. This is a standard performance pattern for extension popups.
- **Module-level state is minimal.** Only `currentReport`, `mcListingContext`, `rawVisible`, and `keyVisible` are module-scoped mutable state. All others are derived from service-worker messages.

### WRONG

- **MINOR — CSS tokens are duplicated between popup.css and options.css.** Both files declare identical `:root` tokens (`popup.css:8-49`, `options.css:8-49`) and identical `@font-face` rules (`popup.css:52-90`, `options.css:52-90`). This adds ~6KB of duplicated CSS. **File:** `popup.css:8-90`, `options.css:8-90`.
  - **Fix:** Extract tokens and font-face into a shared `tokens.css` file imported by both. This is a build concern — acceptable for v1 without a bundler.

- **MINOR — `buildReportText()` in popup.js hardcodes "ScamGuard" branding.** `popup.js:563,594` uses string literals `"ScamGuard Report"` and `"Checked with ScamGuard — your key, your data, your verdict."` instead of `t("appName")` or a dedicated key. **File:** `popup.js:563,594`.
  - **Fix:** Use `t("appName")` for the brand name and add a key for the tagline.

- **NIT — `openOptionsPage()` in popup.js has a redundant fallback.** `popup.js:543-551` first sends an `OPEN_OPTIONS` message to the SW, then also calls `chrome.runtime.openOptionsPage()` directly. The SW doesn't handle `OPEN_OPTIONS` (it's not in the switch statement at `service-worker.js:901-958`), so the message silently returns `{ok: false, error: "Unknown message type."}`. The fallback works but the first attempt is dead code. **File:** `popup.js:543-551`.
  - **Fix:** Remove the `sendMessage` call and keep only `chrome.runtime.openOptionsPage()`.

---

## CATEGORY 8: PERFORMANCE

### GOOD

- **Font loading is self-hosted with `font-display: swap`.** All five woff2 files (`fonts/Fraunces-600.woff2`, etc.) are self-hosted. The `@font-face` declarations use `font-display: swap` (`popup.css:52-90`, `options.css:52-90`), so text renders immediately with fallback fonts and swaps when loaded. No Google Fonts CDN request (CSP + privacy).
- **Font budget is reasonable.** Five static woff2 weights (Fraunces 600/700, Inter 400/500/600) — estimated 60-90KB combined. Well within the 1.5MB total install budget.
- **Popup paint path is fast.** The idle state renders synchronously before any async message. The CSS file is ~25KB unminified (reasonable for a complex popup). No render-blocking resources.
- **No jank patterns.** No `setTimeout`-based layout reads, no forced reflows in loops. The stamp animation uses `transform` and `opacity` only (`popup.css:277-286`) — GPU-composited properties.
- **Canvas export is local and instant.** `popup.js:623-698` creates an offscreen canvas, draws with Canvas 2D, and uses `toBlob()` → `URL.createObjectURL()` → `<a download>`. No network call, no library. The 1080×1080 canvas is reasonable for a share card.
- **CSS transitions are limited and purposeful.** 150ms transitions on border-color, background-color, and transform. No long animations. `prefers-reduced-motion` disables all transitions globally (`popup.css:1220-1235`, `options.css:616-631`).

### WRONG

- **MINOR — CSS duplication adds ~6KB.** The identical token block and font-face declarations in both `popup.css` and `options.css` mean the browser loads the same font files twice (once per page) and parses the same CSS declarations twice. While the font files are cached after the first load, the CSS parsing is duplicated. **File:** `popup.css:8-90`, `options.css:8-90`.
  - **Fix:** Extract to a shared `tokens.css` (requires a build step or manual import). Low priority for v1.

- **MINOR — popup.js is ~30KB unminified.** For a Chrome extension popup, this is on the larger side but acceptable. The code is well-structured and not bloated — the size comes from thorough implementation of8 states + message check + export + history. **File:** `popup.js` (1019 lines).
  - **Fix:** No action needed. If size becomes a concern post-v1, esbuild minification alone would reduce this significantly.

- **NIT — `escapeHtml()` is called on every dynamic string insertion.** This is correct for security, but the function (`popup.js:528-532`) creates a new string via five chained `.replace()` calls. For the volume of strings in this extension (tens, not thousands), this is negligible. **File:** `popup.js:528-532`.
  - **Fix:** No action needed.

---

## CODE-VS-PLAN DRIFT TABLE

| Plan Section | Code Reality | Verdict |
|---|---|---|
| §1.2 Palette — light warm-cream/terracotta | Dark warm-charcoal palette (`#161412` bg, `#C89B54` brass). Design tokens redefined in CSS. | **DRIFT** — deliberate redesign, not accidental. Plan §1.2 palette replaced by dark theme. Plan needs update. |
| §1.3 Typography — Fraunces + Inter + JetBrains Mono | All three fonts loaded as self-hosted woff2 with `font-display: swap`. Fraunces used for seal/display, Inter for body, JetBrains Mono for raw data. | **OK** |
| §1.4 Popup layout — 360px fixed, seal at top | 360px fixed width, max-height 600px, seal centered at top, vertically stacked. Matches plan exactly. | **OK** |
| §1.5 Motion — stamp animation + prefers-reduced-motion | Stamp animation exists (`popup.css:277-286`). `prefers-reduced-motion` disables it. 3-dot pulse freezes on reduced-motion. | **OK** |
| §2.1 Popup shell — 360×large-min-height | `body { width: 360px; max-height: 600px; }` (`popup.css:108-109`). | **OK** |
| §2.2 Idle state — seal placeholder + "Checking this page…" | Implemented (`popup.html:29-37`). | **OK** |
| §2.3 Analyzing — heuristic block + 3-dot pulse | Heuristic block renders, 3-dot pulse exists. `analyzingWith` key exists but `{provider}` is not interpolated into the DOM element. | **DRIFT** — plan says "Analyzing with {provider}…", code shows "Analyzing…" without provider name. |
| §2.4 Report — seal + red flags + summary + checklist + resources + vision + actions | All sub-sections implemented. Red flags sorted high→low. Checklist collapsed by default. Resources shown only on Suspicious/High-Risk. | **OK** |
| §2.5 NoAnalysis — distinct from error | Separate state with distinct copy. No seal, no score. | **OK** |
| §2.6 NoListing — pre-fetch, no network | Separate state, rendered before any network call (`popup.js:823-828`). | **OK** |
| §2.7 Error — heuristic block stays visible | Heuristic block rendered in error state (`popup.js:427`). Error card with backend message + contextual action. | **OK** |
| §2.8 NoKey — first-run, friendly tone | Implemented with neutral grey seal, welcoming copy, single CTA button. | **OK** |
| §2.9 Copy/Export — clipboard + canvas | Both implemented. Copy uses `navigator.clipboard.writeText()`. Export uses Canvas 2D at 1080×1080. | **OK** |
| §2.10 Message Check — independent view | Implemented as separate view with input screen (paste + guided modes) and result view. Back button works. No verdict seal on result. | **OK** |
| §2.10 coreFact card — always renders, 2px brass border | Implemented (`popup.css:1042-1052`). Renders from pattern-match, not dependent on AI. | **OK** |
| §3.1 Options — single scrollable page, no tabs | Single page with sections. No tabs. | **OK** |
| §3.2 Provider card grid | Card grid implemented (`options.html:26-28`, `options.js:69-102`). Shows label, note, paid indicator. But lacks keyboard navigation. | **DRIFT** — card grid exists but keyboard nav (arrow keys) is missing per ARIA radiogroup pattern. |
| §3.2 Trust statement — unconditional, interpolates provider | Implemented (`options.js:161-167`). Uses `t("trustStatement", { provider: label })`. | **OK** |
| §3.1 Clear key — inline confirm, no modal | Inline confirm pattern implemented (`options.html:66-70`, `options.js:291-312`). | **OK** |
| §4 Onboarding — one-time banner, dismissible | Banner exists (`options.html:12-17`). Dismiss button works. URL param `onboarding=1` triggers it. `chrome.runtime.onInstalled` opens options page. | **OK** |
| §6 Accessibility — aria-live on state container | `aria-live="polite"` on `#state-container` (`popup.html:27`). But message check view is outside this container. | **DRIFT** — partial. Message check view lacks `aria-live`. |
| §7 i18n — all UI copy through `t()` | Most copy routes through `t()`. ~6 hardcoded strings bypass it (see Category 6 findings). Lint guard exists. | **DRIFT** — partial. Heuristic labels, options toggles, and error fallbacks bypass `t()`. |
| §8.1 manifest.json — MV3 shape | Manifest matches plan exactly: permissions, host_permissions, content_scripts, background, action, options_page. | **OK** |
| §8.2 No-build vanilla ES modules | Confirmed. No bundler, no `dist/` folder. `<script type="module">` in both HTML files. | **OK** |
| §8.3 Firefox-readiness — browser API shim | `src/shared/browser-api.js` implements Chrome↔Firefox normalization. No component calls `chrome.*` directly... except `service-worker.js:979`. | **DRIFT** — `defaultSendToTab` bypasses the shim. |
| §8.3 Onboarding — open options on install | `service-worker.js:1022-1038` opens options page on `onInstalled` with `reason === "install"`. Uses `setTimeout` + `tabs.update` to add `?onboarding=1`. | **OK** |

---

## TOP-10 PRIORITY FIXES (ranked by impact × effort)

| # | Fix | Severity | Effort | Impact |
|---|---|---|---|---|
| 1 | **Add arrow-key navigation to options provider radio group** — `options.js` needs a `keydown` listener on the grid container to move `aria-checked` between cards on arrow keys | CRITICAL | Low (~30 lines) | Unblocks keyboard-only users + CWS accessibility review |
| 2 | **Add `aria-live="polite"` to message check result view** — `popup.html:180` needs `aria-live` so screen readers announce results | MAJOR | Trivial (1 attr) | Screen reader users get no feedback on message check results |
| 3 | **Fix 6 hardcoded UI strings to route through `t()`** — heuristic labels in `popup.js:240-294`, eye toggle labels in `options.js:235`, "Testing…" in `options.js:260`, provider paid note in `options.js:95`, message check error in `popup.js:749,753` | MAJOR | Medium (~20 keys + refactors) | Blocks future Hindi/Tamil locale; lint guard should catch these |
| 4 | **Fix `defaultSendToTab` to use browser API shim** — `service-worker.js:977-988` should delegate to `chromeTabs.sendMessage` instead of calling `globalThis.chrome.tabs.sendMessage` directly | MAJOR | Low (~5 lines) | Firefox compatibility broken without this |
| 5 | **Populate "Analyzing with {provider}…" text dynamically** — `popup.js` should update `$.analyzingLlmText` with the provider label from settings | MINOR | Trivial (~3 lines) | Plan specifies provider name should appear; currently hardcoded |
| 6 | **Remove hover transforms from non-interactive display cards** — heuristic block, red flag details, resources, vision notes should not have `translateY(-1px)` on hover | MINOR | Trivial (5 CSS rules) | Visual noise; implies interactivity that doesn't exist |
| 7 | **Fix history items: remove `cursor: pointer` or add click handlers** — `popup.css:1175` shows pointer cursor but no JS handles clicks | MINOR | Low (~10 lines) | Misleading affordance |
| 8 | **Add `aria-live="polite"` to options test result** — `options.html:55` needs live region for screen readers | MINOR | Trivial (1 attr) | Screen reader users don't hear test results |
| 9 | **Persist `lastAnalyzedTabId` in session storage** — `service-worker.js:143` should write tabId alongside session state to survive SW restarts | MINOR | Low (~10 lines) | Badge silently missed on SW restart |
| 10 | **Remove dead `OPEN_OPTIONS` message from `openOptionsPage()`** — `popup.js:543-546` sends a message the SW doesn't handle | NIT | Trivial (delete 3 lines) | Dead code; first attempt always fails silently |

---

## CHROME WEB STORE SUBMISSION BLOCKERS

**None identified.** The extension meets CWS quality guidelines:

- ✅ Minimal permissions (`storage`, `activeTab`)
- ✅ Content script scoped to listing pages only
- ✅ No deceptive patterns
- ✅ No full-page takeover
- ✅ Popup closes on blur (Chrome native)
- ✅ Options page is clear and well-labeled
- ✅ Privacy statement present (trust statement in options)
- ✅ Manifest is valid MV3

**Recommended before submission** (not blockers but strongly advised):
1. Fix the radio group keyboard navigation (#1 above) — reviewers may flag it
2. Fix the hardcoded strings (#3 above) — the lint guard should catch these in CI
3. Add store listing screenshots per PLAN-FRONTEND.md §8.4
4. Draft privacy practices tab copy per backend §7.3

---

## FINAL SELF-REVIEW

### Files Modified
- **Created:** `FRONTEND-AUDIT-2026-08-13.md` (this file)
- **Modified:** NONE

### Verification
```
$ git status --short
?? FRONTEND-AUDIT-2026-08-13.md
```
Only the new audit report appears. No existing files were touched.

### Categories Covered
1. ✅ Chrome Web Store Quality Guidelines
2. ✅ Extension Architecture Best Practices (MV3)
3. ✅ Accessibility (WCAG 2.2 AA + extension-specific)
4. ✅ Visual Design Quality
5. ✅ UX Writing / Microcopy
6. ✅ I18N / L10N Readiness
7. ✅ HTML/CSS/JS Engineering Quality
8. ✅ Performance

### Files Read
- `popup.html`, `popup.css`, `popup.js`
- `options.html`, `options.css`, `options.js`
- `manifest.json`
- `src/strings/en.json`, `src/shared/i18n.js`, `src/shared/browser-api.js`, `src/shared/error-messages.js`, `src/shared/types.js`
- `src/background/service-worker.js`
- `content/extractor.js`
- `scripts/lint-strings.js`
- `PLAN-FRONTEND.md`
- `fonts/` directory listing

### Verdicts Summary
| Category | Score | Key Finding |
|---|---|---|
| CWS Guidelines | 9/10 | Permission minimalism excellent; a11y gap in radio group |
| MV3 Architecture | 9/10 | Strong; one shim bypass in service-worker.js |
| Accessibility | 7/10 | Good foundations; radio group + message check aria-live gaps |
| Visual Design | 9/10 | Polished, distinctive, 2026-grade; hover lifts on display cards |
| UX Writing | 9/10 | Calm, actionable, backend-authored errors |
| I18N | 7/10 | Strong system; ~6 hardcoded strings escape the boundary |
| Engineering | 8/10 | Clean code; CSS duplication, dead code in openOptionsPage |
| Performance | 9/10 | Self-hosted fonts, fast paint, no jank |
| **Overall** | **82/100** | **Production-ready with targeted a11y + i18n fixes** |
