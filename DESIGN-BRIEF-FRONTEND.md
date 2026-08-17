# ScamGuard Frontend Enhancement Brief (for Midas / opencode)

> Audience: Midas (frontend coding agent). Read this whole file before writing any code.
> Supervisor: Atom (Hermes). Atom will run `npm test`, `npm run lint`, and a real-Chrome E2E after you finish. Your work must keep the existing **256 tests green** and add **0 npm dependencies**.

## 0. Hard constraints (do NOT violate)
- **Vanilla ES modules, NO build step.** `<script type="module">` already in `popup.html`/`options.html`. Do not add esbuild/vite/webpack/bundlers. Do not add any `npm install` package to the shipped bundle.
- **Keep all 8 popup states** working: idle, analyzing, report, noanalysis, nolisting, error, nokey, messagecheck. Do not remove or rename state sections in `popup.html`.
- **Do not touch backend.** No changes to `src/llm/*`, `background/*`, `content/*`, scoring, or `PLAN-BACKEND.md`. Frontend-only.
- **Tests + lint must stay green.** `npm test` (node --test) and `npm run lint` (string-concat guard) are gates. The lint rule forbids string-literal concatenation assigned to `.textContent`/`.innerText` outside `src/strings/`. Route ALL user-visible copy through `t()` in `src/shared/i18n.js` (or `chrome.i18n.getMessage`).
- **Keep the calm, non-alarmist, inspection-stamp identity.** Per the frontend-design discipline, the verdict seal is the ONE signature element — spend boldness there, keep everything else quiet. Do not introduce neon, do not add a second accent color besides brass + one surgical red.

## 1. Design skills applied (these are requirements, not suggestions)
- **frontend-design**: distinctive, subject-grounded (Indian + global classifieds, street-level trust, money changing hands). Restraint: take one real risk (the seal becomes a live instrument — §3) and keep the rest disciplined. Copy is design material — write plain, active, end-user-side copy.
- **theme-factory**: consistent named token system. You may ONLY add tokens listed in §2. Do not redefine existing `--sg-*` tokens.
- **brand-guidelines**: the provided `assets/logo.png` is the brand mark — a transparent red shield with an **S + checkmark** monogram (`#D91A05` red). Use it as the consistent brand asset (§2). Derive the single alert red from it.

## 2. Deliverables (do all, in this order)

### 2.1 Brand reconciliation (logo + one red)
- Add CSS token (light): `--sg-alert: #D91A05;` (dark): `--sg-alert: #E5483B;` (brightened for contrast on charcoal — verify >=4.5:1 on `--sg-paper-raised`).
- **Header brand mark**: in `popup.html` replace the inline `<svg class="sg-header-icon">` ring with `<img class="sg-header-logo" src="assets/logo.png" width="18" height="18" alt="">` and add `.sg-header-logo { border-radius: 3px; }`. Keep `.sg-header-name` "ScamGuard".
- **Options "About"**: add the same `assets/logo.png` (24px) above the About text.
- **Red usage (surgical only)**: apply `--sg-alert` to (a) the LikelyScam message-verdict icon + border in the Message Check result view, (b) a left border accent on the "Call 1930 / report" resource row when verdict is High-Risk, (c) the High-Risk seal color may STAY `--sg-high-risk` (do not swap the verdict scale), but `--sg-alert` is the alert accent for danger microcopy. Red appears ONLY in these danger moments — never decoratively.
- Do NOT change the toolbar/store icon files (icons/icon-*.png) — leave those.

### 2.2 Seal as a live instrument (the one risk)
- In `popup.js`, the report seal is built into `#report-seal` / `.sg-seal-score`. Change the **score circle** to an SVG with:
  - a base ring (currentColor, low opacity),
  - a **progress arc** whose length = `score/100` (use `stroke-dasharray`/`stroke-dashoffset` on a `<circle>`), colored by verdict,
  - a **second thin arc** (inner, 2px) representing backend `confidence` (high=full, medium=⅔, low=⅓ length), muted color.
  - Keep the numeric score (Fraunces) and the verdict word text centered/inside — text must remain the accessible signal (color-blind safe).
- Keep the existing `sg-stamp` entrance animation and `prefers-reduced-motion` guard.
- The `analyzing` state seal can stay a simple pulse (no arc needed).
- Inspect `popup.js` to find exactly how the seal is currently constructed (search `report-seal`, `sg-seal-score`, `verdict`) and extend it — do not rewrite unrelated code.

### 2.3 Provenance footer (trust differentiator)
- Under the report body (after actions row, before the payment nudge), add a quiet line: `t('reportProvenance', { provider })` → copy: *"Decided on your device · via {provider}"*. `provider` = the user's configured provider label (read from settings store; fall back to "your provider" if unknown). Style: 11px, `--sg-muted`, centered, `margin-top: var(--sg-space-md)`. This is a new `t()` key in `src/strings/en.json`.

### 2.4 History rows re-open the report
- In `popup.js`, the history list (`#history-list`) currently renders static rows. Make each row a `<button>` that, on click, re-renders the stored `RiskReport` via the SAME report-render function used for live results (so it looks identical to a live report). Keep "See all" working. Check `src/storage/history.js` for the stored shape (it stores the full report). If the stored shape lacks the raw report, store it (additive, don't break existing schema — add a `report` field if missing, guard with `?.`).

### 2.5 Options: "use free default" + provider health dot
- In `options.html`/`options.js`, above the provider card grid (`#provider-grid`), add a prominent CTA card: *"Use ScamGuard's free default"* → sets provider to `openrouter` (or the preset free default) with NO model override and shows the Test-connection success. Plain button, brass primary style.
- Each provider card: add a small **health dot** (green if last `testConnection` for that provider succeeded, grey otherwise). Persist a `lastTestOk:<providerId>` boolean in storage when Test connection passes; read it to render the dot. Reuse `--sg-safe` for green.

### 2.6 Internationalization hardening (CWS-required)
- Convert `src/shared/i18n.js` `t()` to call `chrome.i18n.getMessage(key, vars)` when `chrome.i18n` exists, with a **fallback** to the bundled `src/strings/en.json` (so jsdom unit tests, which have no `chrome.i18n`, still pass). Keep the same `t(key, vars)` signature.
- Add `default_locale": "en"` to `manifest.json`.
- Create `_locales/en/messages.json` generated from `src/strings/en.json` (chrome.i18n format: `{ "key": { "message": "..." } }`). Also create `_locales/es/messages.json` and `_locales/hi/messages.json` as **partial machine translations** (translate the high-traffic keys: header, nokey, report states, message-check, provider CTA, provenance; leave untranslated keys absent — chrome.i18n falls back to default_locale). Mark es/hi as partial via a comment at top of those files: `// PARTIAL — machine-translated, needs native review`.
- Keep `src/strings/en.json` as the source of truth (the fallback reads it). The `_locales/en/messages.json` must stay in sync with it for the keys you add (provenance, provider CTA, etc.).
- Do NOT run a translation service; write reasonable es/hi strings for the listed keys yourself.

### 2.7 International copy generalization
- The extension only scores OLX/Quikr listings (backend scope) — keep that factual. But generalize the **Message & Payment Check** + tone to be marketplace-agnostic and useful globally:
  - Update NoAnalysis/NoListing copy from "OLX or Quikr listing" → "a marketplace listing (like OLX, Quikr, Facebook Marketplace, or Craigslist)".
  - Message-check intro copy: broaden beyond UPI (keep QR/scan-to-receive + fake payment confirmation + overpayment refund + "pay via app then vanish" patterns — these are universal; the existing 6 patterns already are).
  - Privacy disclosure (options provider section) must be **prominent** (already static — make it slightly emphasized with a `--sg-brass-soft` background box) because the 2026 CWS policy update demands prominent data-handling disclosure. Keep the exact wording pattern from `PLAN-FRONTEND.md §3.1`.
- Manifest `description` + README: mention "marketplace listings (OLX, Quikr, …)" and that the Message Check works for any chat/payment request worldwide.

## 3. What NOT to do
- No new dependencies. No build step. No backend changes. No removing tests. No redesign of the palette beyond §2.1. No alarmist red everywhere. No confetti. No hover-tilt.

## 4. Verification YOU must run before finishing
1. `npm test` → 256+ pass (gates). If a test fails because of a legit API change you made, FIX the test to match the new intended behavior (do not delete tests).
2. `npm run lint` → clean.
3. `node scripts/e2e/real-extension.test.mjs` is run by Atom later; you do NOT need to run it, but ensure no syntax errors by `node --check popup.js options.js`.
4. Open `popup.html`/`options.html` mentally: every new string goes through `t()`.

## 5. Report back (to Atom)
List files changed, tests pass count, lint result, and any key you added to `en.json` so Atom can mirror it into `_locales/en/messages.json` if you didn't. Note any test you had to modify and why.
