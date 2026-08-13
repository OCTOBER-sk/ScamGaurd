# FRONTEND REBUILD SPEC — ScamGuard (Phase 3: REBUILD)

Agent: Midas. This is a REBUILD of the frontend, not a re-audit. Source of truth: this spec + FRONTEND-AUDIT-2026-08-13.md (read it first) + PLAN-FRONTEND.md.

## 1. SCOPE

### In scope (you WILL edit these)
- popup.html, popup.css, popup.js
- options.html, options.css, options.js
- src/strings/en.json (add keys)
- src/shared/i18n.js (only if t() needs a helper fix — avoid unless necessary)
- scripts/e2e/options-harness.html (mirror new options.html structure so screenshots show the new design)
- PLAN-FRONTEND.md (record the palette-drift + update affected sections — §1.2 palette table, §1.6, any line that says "light warm-cream")
- STATUS.md (add one line: frontend rebuild 2026-08-13)

### HARD BAN (never touch)
- src/background/service-worker.js, src/llm/*, src/heuristics/*, src/scoring/*, src/storage/*, src/payment-check/*, content/extractor.js, test/*, scripts/e2e/results.json, manifest.json, fonts/, icons/, .github/
- The two service-worker issues from the audit (#4 shim bypass, #9 tabId persistence) are BACKEND scope — Zeus will handle. Do NOT fix them. Just mention in your report.
- No new runtime dependencies. No bundler. No build step. No Google Fonts CDN. MV3. Content scripts stay classic.

## 2. DESIGN DIRECTION (identity preserved, craft elevated)

Keep the ScamGuard identity: warm charcoal + brass, Fraunces verdict seal, calm/factual tone, dark theme. The rebuild raises craft to the international benchmark (Raycast/Linear/Superhuman-class extension UI). Specific craft rules:

1. **Surface system — make layers READABLE.** Current raised surface (#1E1B18 on #161412) is nearly invisible → everything looks flat. New tokens:
   - `--sg-paper: #161412` (page) — keep
   - `--sg-paper-raised: #221D19` (cards, inputs, panels) — LIGHTER, clearly distinct
   - `--sg-paper-sunken: #100E0D` (inset wells, code blocks, accordion content)
   - `--sg-border: rgba(255,255,255,0.10)` — decorative hairlines only (dividers, card edges that sit on raised surfaces)
   - `--sg-border-strong: #6E675E` — NEW: interactive component boundaries (inputs, buttons, toggles, selected cards) — must reach ≥3:1 contrast vs the surface it sits on (WCAG 1.4.11). Verify numerically.
2. **Buttons — three explicit tiers, ONE primary per screen:**
   - Primary (filled): `background: var(--sg-brass)`, text `#1C1A17`, weight 600, inset top highlight `inset 0 1px 0 rgba(255,255,255,0.25)`, hover = lighten 4%, active = press. Used for: "Choose a provider →" (NoKey), "Test connection" (options), "Check this message" (message check submit).
   - Secondary (ghost): brass text on transparent, `1px solid var(--sg-border-strong)` border, hover = bg rgba(255,255,255,0.05). Used for: Copy report, Export card, Try again, Open Settings.
   - Tertiary (muted link-style): `--sg-muted` text, no border. Used for: "View raw data", "See all", Clear key (destructive styling separate: high-risk tinted).
   - Hover/active transitions: background-color/border-color 150ms, never opacity-only for filled buttons.
3. **Inputs — clearly visible fields.** `.sg-input`: `background: var(--sg-paper-raised)`, `border: 1px solid var(--sg-border-strong)`, radius 10px, `--sg-ink` text, placeholder `#8A847B`. Focus: `border-color: var(--sg-brass)` + `box-shadow: 0 0 0 3px rgba(200,155,84,0.22)` glow ring + `outline: none` REPLACED by the ring (still a visible focus indicator — meets 2.4.7). API-key field keeps mono font + letter-spacing. Eye icon button: 36px hit area, `--sg-muted` icon that brightens to ink on hover, visible border on focus.
4. **Toggle (Vision analysis)** — visible track: off = `#2A2622` fill + `1px solid var(--sg-border-strong)` border, thumb `#A8A29A`; on = `var(--sg-brass)` fill, thumb `#1C1A17`; focus-visible ring `outline: 2px solid var(--sg-brass); outline-offset: 4px` (ring must not be clipped). Label text `--sg-ink`.
5. **Provider cards (options)** — equal height (grid `align-items: stretch`), consistent padding 12px, radius 12px, `background: var(--sg-paper-raised)`, `border: 1px solid var(--sg-border)`. Hover: `border-color: rgba(255,255,255,0.25)`. Selected: `border-color: var(--sg-brass)` + `box-shadow: 0 0 0 1px var(--sg-brass), 0 0 16px rgba(200,155,84,0.15)` + a small brass check glyph (top-right). "No free tier" note: consistent tiny badge styling (muted text with warning-tinted icon), same treatment on every card that has it. Card title: 14px weight 600 ink; note: 12px `--sg-muted`.
6. **Verdict seal — FIX LEGIBILITY (plan violation today).** PLAN §6 requires verdict word ≥14px; current code renders it at 11px inside the seal. New seal treatment:
   - Score number: Fraunces 700, ~26px, `--sg-ink` — the hero element.
   - Verdict word: Fraunces 600, **16px**, letter-spacing 0.06em, verdict color, on a straight horizontal baseline (the curved/arc text is hard to read — replace with straight text under the score, still inside the seal ring). Color is never the only signal: word always rendered as text.
   - Keep: concentric rings, radial brass glow, stamp-down animation (120ms), `prefers-reduced-motion` skip.
7. **Privacy/trust statement** — add a small shield glyph (inline SVG, brass) and use `#B9B3A9` (up from `--sg-muted`) so the trust signal is actually read. Keep unconditional + provider-interpolated.
8. **History** — items become display-only: REMOVE `cursor: pointer` and any hover lift (audit: no click handler exists; re-opening a stored report needs a backend handler = out of scope). Keep dot color coding, title, score, relative date.
9. **Remove ALL hover transforms/lifts from non-interactive elements** (heuristic block, red-flag rows, resources, vision notes, mc-mode buttons). Hover affordances ONLY on real buttons/links/selectable cards.
10. **Options page structure** — keep single scrollable page, 640px max-width. Make section separation stronger: section titles 13px weight 600 uppercase 0.08em letter-spacing `--sg-muted`; sections separated by `1px solid rgba(255,255,255,0.08)` + 28px vertical rhythm. Title: "Settings" (drop the redundant "ScamGuard" wordmark — keep a small brass seal glyph next to it for brand).
11. **Positive letter-spacing on dark**: body/UI text gets `letter-spacing: 0.01em`-ish air (per dark-UI craft benchmark); body weight 400-500 with 500 for labels/emphasis.

## 3. MANDATORY FIXES (from audit — all of them)

1. **CRITICAL — provider radio group keyboard nav** (options.js): `keydown` on the grid container: ArrowRight/ArrowDown → next, ArrowLeft/ArrowUp → previous, Home/End → first/last; wrap-around; update `aria-checked` + `tabindex` (roving tabindex — only the selected card is tabbable) + call `selectProvider()`. Per WAI-ARIA radiogroup pattern.
2. **`aria-live="polite"` on message-check result view** (popup.html, #mc-result-screen or equivalent) — screen reader users get result announcements.
3. **`aria-live="polite"` on options test-connection result** (#test-result).
4. **Route ALL hardcoded UI strings through t()** — exact list (add these keys to en.json, use them):
   - heuristic labels (popup.js ~240-294): `heuristicPriceBelow: "Price {{pct}}% below typical"`, `heuristicPriceAbove`, `heuristicNewSeller: "New seller ({{count}} {{countPlural}})"`, `heuristicEstablishedSeller`, `heuristicUrgency`, `heuristicPhotoCount`, `heuristicOffPlatformPayment`, etc. — one key per distinct label template; use t() with vars. Keep `escapeHtml()` wrapping where inserted via innerHTML.
   - `showKey` / `hideKey` (eye toggle aria-label)
   - `testing: "Testing…"` (options button)
   - `testConnectionFailed: "Could not reach the service worker."`
   - `providerPaidNote: "No free tier — requires paid account"`
   - `messageCheckError: "Could not check this message."`
   - `appName: "ScamGuard"` + `reportTagline: "Checked with ScamGuard — your key, your data, your verdict."` (buildReportText)
   - Keep existing keys; the lint guard (npm run lint) must pass with zero violations after your changes — run it.
5. **Fix pluralization**: heuristic labels + checklist summary must handle count === 1 → "1 item" (use a small plural helper or t() with a plural-aware pattern; keep it dependency-free).
6. **Populate "Analyzing with {provider}…"** — after settings resolve, set the analyzing row text to `t("analyzingWith", {provider: label})`; keep the 3-dot pulse; reduced-motion freeze stays.
7. **Remove dead `OPEN_OPTIONS` message** from `openOptionsPage()` (popup.js) — keep only `chrome.runtime.openOptionsPage()`.
8. **Touch targets ≥24px**: "Check a message" header button → `min-height: 26px` + `padding: 5px 10px`; all buttons min 28px height; icon buttons ≥36px hit area.
9. **History**: remove `cursor: pointer` (see §2.8).
10. **Options toggle**: visible focus ring not clipped (see §2.4).

## 4. ADDITIONAL A11Y REQUIREMENTS (WCAG 2.2 AA — verify all)

- Keyboard: full tab order matches visual order; no positive tabindex; radiogroup + all buttons operable by keyboard alone.
- Focus visible everywhere: brass ring on ALL focusable elements (buttons, inputs, links, details/summary, history, toggle). Never `outline: none` without replacement.
- Non-text contrast (1.4.11): interactive boundaries ≥3:1 (inputs, buttons, toggle, selected cards, icon buttons) — use `--sg-border-strong` and verify.
- Text contrast: `--sg-ink` on paper ≥ 13:1; `--sg-muted` ≥ 6.5:1 on paper; all verdict colors on paper-raised ≥ 4.5:1 at label size (keep current brightened dark-theme verdict values — they pass).
- Color not the only signal: verdict word text, severity labels HIGH/MED/LOW, history dots paired with text.
- `aria-live` regions: state container (exists), message-check result (add), test-result (add).
- Labels: every input has a `<label>` (exists — keep); placeholder never the only label.
- `prefers-reduced-motion`: stamp animation, pulse, transitions all disabled (exists — keep and extend to any new motion).
- `lang="en"` + `dir` correctness: keep `lang="en"`; do not hardcode directional arrows — use CSS logical-safe glyphs or keep existing entities (acceptable for v1 English; do not introduce new LTR-specific positioning).

## 5. i18n — final state

- Zero hardcoded visible strings in popup.js / options.js (lint guard enforces — run `npm run lint` until 0 violations).
- All new keys added to src/strings/en.json, flat key:value, `{{var}}` interpolation.
- Do NOT translate LLM-authored content (summary/red-flag explanations) — that boundary stays.

## 6. CONSTRAINTS (non-negotiable)

- Popup: fixed 360px, max-height 600px, internal scroll. All 8 states + message-check surface + history footer intact. State machine logic/IDs used by service worker messages UNCHANGED (GET_STATE, ANALYZE, GET_LISTING, CHECK_MESSAGE, GET_HISTORY message shapes untouched).
- `npm test` → all 254 tests stay green (run it).
- `npm run lint` → 0 violations (run it).
- Fonts: same 5 self-hosted woff2, `font-display: swap`, no new weights, total budget < 100KB CSS+fonts.
- After rebuilding popup.html/options.html: run `node scripts/e2e/build-harness.mjs` to regenerate popup + message harnesses from your new files. Update scripts/e2e/options-harness.html by hand to mirror the new options.html structure (keep the caption bar, chrome.* stub, and harness note intact — only the mirrored page markup changes).
- No `chrome.*` calls outside the browser-api shim pattern used today (popup.js may use navigator.clipboard and canvas as it does today).
- Do not reorder/rename any `id` attributes the service worker or tests reference (e.g. `btn-check-message`, `state-container`, `mc-*` ids) unless you update every consumer — verify by running tests + real-extension E2E.

## 7. DELIVERABLES (exact)

1. Rebuilt: popup.html/css/js, options.html/css/js, en.json (new keys)
2. Updated: scripts/e2e/options-harness.html, PLAN-FRONTEND.md (§1.2 palette + drift record), STATUS.md (one line)
3. Regenerated: scripts/e2e/popup-harness.html, scripts/e2e/message-harness.html (via build-harness.mjs)
4. No other files touched.

## 8. FINAL SELF-REVIEW (mandatory — do all, in order)

1. `git status --short` → exactly the deliverables above, nothing else.
2. `npm test` → 254/254 green.
3. `npm run lint` → 0 violations.
4. `node scripts/e2e/build-harness.mjs` → regenerates successfully.
5. Re-read your diff: verify every §3 fix is actually present (radiogroup keydown, both aria-live additions, all t() routes, pluralization, analyzingWith, dead-code removal, touch targets, no cursor:pointer on history).
6. Verify the two SW issues from the audit are NOT touched.
7. Report: files changed, test/lint counts, which §3 items are done, remaining risks (e.g. anything you could not verify).
