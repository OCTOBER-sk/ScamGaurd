# STATUS — ScamGaurd (updated 2026-08-13)

## Currently true (verified)
- 254/254 unit+integration tests pass; lint 0 violations; CI green 4/4 on GitHub
- Theme rebuild 2026-08-13: system light/dark dual-theme via `prefers-color-scheme` — light palette (warm paper #FAF7F2, brass #8A6427) as :root default, dark palette (charcoal #161412, brass #C89B54) in `@media (prefers-color-scheme: dark)`. Token-driven: zero hardcoded hex/rgba in component rules (documented exception: intentional light canvas export card). `color-scheme: light dark` on :root. All component styles restyled: seal uses verdict-colored concentric rings via currentColor, three button tiers (primary/secondary/tertiary), cards use Notion-style shadows in light / border-only in dark, inputs with brass focus ring + glow, toggle switch token-driven, hover transforms removed from non-interactive elements.
- Real-browser E2E (real Chrome, real chrome APIs): popup states, options grid, message-check click-through, NoKey first-run, real 401 failure state — all PASS
- Message & Payment Check module: 6 patterns, offline, coreFact always — UNIT + REAL-E2E PASS
- LLM fusion real call: gpt-oss-20b:free, llmScore 65 → fused 54 "Suspicious" — PASS
- Model-rotation fallback (404 → next model) — PASS
- Security: no secrets in tracked files, chrome.storage.sync never used, npm audit 0 findings — PASS
- Content script injects cleanly on quikr.com, proactiveScan=false — PASS

## Uncertain
- Bundle size vs 1.5MB budget (fonts 273KB, JS small — likely passes, NEVER measured)
- Popup open <100ms (never measured)
- Real listing-page extraction quality (fixtures are modeled, not captured from live pages)

## Blocked
- B2/C11: live OLX/Quikr listing extraction — **VPS egress blocks OLX.in**; needs capture on Sandy's machine via scripts/redact-fixture.js
- E6: CWS submission — needs privacy-tab + policy review + store assets (MANUAL, pending)

## Next actions (ordered)
1. Capture real listing fixtures on Sandy's machine (scripts/redact-fixture.js) → close B2/C11/G-gap
2. Measure bundle size + popup open time (F1/F2) → likely quick PASS
3. Long-running service-worker lifecycle test in real Chrome (B9)
4. Adversarial UI attack pass (D4) + manual a11y (C8) + clipboard/canvas check (C9)
5. CWS readiness: privacy tab, policy review, store assets (E6)

## Tried & failed
- Direct transcript/scrape of OLX from VPS — blocked at network level (same class as YouTube egress block)
- ES-module content script — rejected by real Chrome classic-script context; fixed via classic-compat build (254/254 still green)

## Decision waiting
- None urgent. Pending: whether to prioritize CWS submission vs. new features after remaining verification closes.
