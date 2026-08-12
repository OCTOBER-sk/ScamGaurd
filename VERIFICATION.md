# ScamGuard — Verification Matrix

> Standard: build → attack → verify → prove. Every claim below has a verification level.
> Levels: **STATIC** (code/lint) · **UNIT** (node:test) · **INTEGRATION** (real modules, mocked
> external) · **REAL-E2E** (real execution, real APIs) · **REAL-BROWSER** (real Chrome,
> real extension, no stubs) · **PERF** · **SECURITY** · **MANUAL** (human/device required).
> Status: ✅ PASS · ❌ FAIL · ⚠️ NOT VERIFIED · 🕐 PENDING-MANUAL.
> Rules: mocks prove components, real execution proves integration; agent claims are never
> evidence; never promote a verification level; "Not verified" is a first-class result.

## A. Automated pipeline (CI: `npm ci → npm run lint → npm test` — 4/4 green on GitHub)

| # | Claim | Level | Evidence | Status |
|---|-------|-------|----------|--------|
| A1 | 254 unit/integration tests pass | UNIT | `npm test` — 254/254, 0 fail | ✅ PASS |
| A2 | i18n boundary guard (no hardcoded copy outside src/strings/) | STATIC | `npm run lint` — 36 files, 0 violations | ✅ PASS |
| A3 | Manifest valid MV3, scoped matches, no `<all_urls>` | STATIC | python manifest parse + real Chrome load | ✅ PASS |
| A4 | Zero runtime dependencies | STATIC | package.json `dependencies: {}` | ✅ PASS |
| A5 | CI workflow executes and passes | REAL-E2E | GitHub Actions runs 31608613403/31608216782/31605120962/31600771808 — all success | ✅ PASS |

## B. Backend pipeline (real execution)

| # | Claim | Level | Evidence | Status |
|---|-------|-------|----------|--------|
| B1 | Extractor parses listing structure, confidence-graded, never throws | UNIT + INTEGRATION | extractor tests (fixtures) | ✅ PASS |
| B2 | Extractor on a REAL live listing page | REAL-E2E | — | ⚠️ NOT VERIFIED (VPS egress blocked for OLX; no reachable Quikr listing URL found) |
| B3 | Heuristics deterministic 0-100, weights per §5.1 | UNIT | heuristics tests, fixture-driven | ✅ PASS |
| B4 | Real LLM call → tolerant parse → schema validate → fusion | REAL-E2E | scripts/e2e run: gpt-oss-20b:free, 68.8s, llmScore 65 → fused 54 Suspicious | ✅ PASS |
| B5 | OpenRouter model-rotation fallback (404 → next model) | REAL-E2E | live run: deepseek:free 404 → gpt-oss-20b:free succeeded | ✅ PASS |
| B6 | Payment-check: 6 patterns, offline, coreFact always | UNIT + REAL-E2E | unit tests + real-extension run (LikelyScam, SCAN_TO_RECEIVE) | ✅ PASS |
| B7 | Error matrix: 500→1 retry, 429→never, timeout, repair | UNIT | mocked-fetch tests | ✅ PASS |
| B8 | Service worker persists state before fetch (SW-restart safety) | UNIT | ordering test | ✅ PASS |
| B9 | Service worker lifecycle in real Chrome (idle, restart mid-analysis) | REAL-BROWSER | — | ⚠️ NOT VERIFIED (needs long-running SW test) |

## C. Frontend (real rendered application)

| # | Claim | Level | Evidence | Status |
|---|-------|-------|----------|--------|
| C1 | 8 popup states render, no stale-state bleed | UNIT (jsdom) | popup tests | ✅ PASS |
| C2 | Popup renders in REAL Chrome with REAL chrome APIs | REAL-BROWSER | /tmp/real-nokey.png, /tmp/real-messagecheck.png (no harness bars) | ✅ PASS |
| C3 | §2.10 message-check full click-through: popup → real SW → match.js → render | REAL-BROWSER | real-extension.test.mjs step 4: LikelyScam + coreFact rendered | ✅ PASS |
| C4 | NoKey first-run state | REAL-BROWSER | real-extension.test.mjs step 2 + screenshot | ✅ PASS |
| C5 | Options: 10-provider real grid, key field, model override | REAL-BROWSER | real-extension.test.mjs step 5 + screenshot | ✅ PASS |
| C6 | Test connection REAL failure state (bad key → real 401 → message) | REAL-BROWSER | real Groq 401 → "Key rejected by provider…" rendered | ✅ PASS |
| C7 | Vision toggle auto-disables for non-vision providers | REAL-BROWSER | options screenshot (Groq selected → toggle disabled + note) | ✅ PASS |
| C8 | Keyboard navigation, screen-reader, focus states | MANUAL | — | 🕐 PENDING-MANUAL |
| C9 | Clipboard copy + canvas export in real browser | REAL-BROWSER | — | ⚠️ NOT VERIFIED (interaction asserted in jsdom only; clipboard/canvas need permissioned manual check) |
| C10 | Content script injects cleanly on real quikr.com, no proactive scan | REAL-BROWSER | real-extension.test.mjs step 6: 0 errors, proactiveScan=false | ✅ PASS |
| C11 | Content script extraction on a real listing page | REAL-BROWSER | — | ⚠️ NOT VERIFIED (no reachable real listing page from VPS; fixtures are modeled) |

## D. Design & UX (attack pass)

| # | Claim | Level | Evidence | Status |
|---|-------|-------|----------|--------|
| D1 | Dark premium theme renders (seal glow, charcoal, brass) | REAL-BROWSER | screenshots, pixel inspection | ✅ PASS |
| D2 | Contrast ≥ 4.5:1 for verdict labels | STATIC | computed ratios (15.5/7.1/7.1/5.2/4.6) | ✅ PASS |
| D3 | Slop audit: no gradients (except seal), no glass, no emoji decoration | STATIC | midas audit + visual check | ✅ PASS |
| D4 | Adversarial UI states (overflow, long text, extreme scores) | UNIT/REAL-BROWSER | — | ⚠️ NOT VERIFIED (attack pass pending) |

## E. Security

| # | Claim | Level | Evidence | Status |
|---|-------|-------|----------|--------|
| E1 | No secrets in tracked files | STATIC | grep (ghp_/sk-/AIza/BEGIN PRIVATE) — 0 hits | ✅ PASS |
| E2 | chrome.storage.sync never used | STATIC | grep — 0 usages | ✅ PASS |
| E3 | Keys only in chrome.storage.local, masked field, clear-key | STATIC + REAL-BROWSER | code + options screenshot | ✅ PASS |
| E4 | Network destinations = provider + image CDN only (§7.2) | STATIC | code audit | ✅ PASS |
| E5 | Dependency vulnerability audit | STATIC | `npm audit` (0 deps → 0 findings) | ✅ PASS |
| E6 | CWS policy review + privacy-tab submission | MANUAL | — | 🕐 PENDING-MANUAL |

## F. Performance

| # | Claim | Level | Evidence | Status |
|---|-------|-------|----------|--------|
| F1 | Bundle < 1.5MB install budget | PERF | — | ⚠️ NOT VERIFIED (never measured; fonts 273KB, JS small — likely passes, unproven) |
| F2 | Popup opens < 100ms | PERF | — | ⚠️ NOT VERIFIED (never measured) |
| F3 | Heuristics sub-1s | REAL-E2E | 2ms measured in E2E run | ✅ PASS |

## G. Gaps log (found → closed)

| Gap | Found by | Status |
|-----|----------|--------|
| `npm run lint` referenced missing scripts/lint-strings.js | zeus self-review (phase 2) | ✅ CLOSED (phase 8a) |
| SW missing CHECK_MESSAGE/GET_HISTORY handlers | midas self-review (phase 6) | ✅ CLOSED (phase 6.5) |
| Content script used ES-module syntax — incompatible with classic-script content scripts in real Chrome | real-browser test build (phase V-REAL) | ✅ CLOSED (extractor classic-compat fix, 254/254 still green) |
| Test-fixture contradictions (§5.1 null-seller penalty; price-ratio contribution) | Atom supervision | ✅ CLOSED (documented test changes) |
| Real listing-page extraction | egress limitation | 🕐 OPEN — capture via scripts/redact-fixture.js on a real machine |

## H. Test-change log (what → why → root cause → who was wrong)

| Change | Why | Root cause | Verdict |
|--------|-----|-----------|---------|
| test/heuristics.test.js fixtures: sellerItemsListed added; contact-leak description/price isolated | tests failed 17/19 | fixtures contradicted §5.1 (unknown seller = 5 pts) and the contact fixture also tripped price/urgency patterns | Implementation correct; tests were wrong |
| popup.test.js / options.test.js token hex values updated | dark theme palette | user override of §1.2 presentation palette; token NAMES unchanged, mapping semantics preserved | Test expectations updated to new palette (hexes were presentation, not contract) |
| extractor tests updated for classic-script-compat export shape | content script fix | real Chrome rejects `export` in classic content scripts | Implementation was wrong; fixed, tests updated to match |

*Last updated: 2026-08-12. Regenerate evidence with: `npm test && npm run lint && node scripts/e2e/real-extension.test.mjs` (needs CHROME_PATH + LD_LIBRARY_PATH=$HOME/.local/lib/nss-libs).*
