# PROJECT — ScamGaurd

**Owner:** Sandy (Santhoshkumar S)
**Repo:** https://github.com/OCTOBER-sk/ScamGaurd (local: ~/projects/ScamGaurd)
**Last updated:** 2026-08-12

## What / Why / For whom
Chrome MV3 extension (BYOK — bring your own key) that detects marketplace scams on OLX.in / Quikr for Indian buyers AND sellers. The 2026-08-12 research pass expanded scope: the most damaging fraud class happens OFF-page in chat/payment flows (UPI "scan to receive" = collect-request trick), so ScamGaurd has two check surfaces: listing-page analysis + a deliberate "Message & Payment Check" the user opens before acting on a payment instruction.

## Success criteria (measurable)
- [ ] All automated + real-browser verification items PASS (see VERIFICATION.md — currently 4 ⚠️ NOT VERIFIED + 2 🕐 PENDING-MANUAL)
- [ ] Real listing-page extraction verified (needs a machine where OLX/Quikr is reachable — VPS egress is blocked)
- [ ] CWS submission ready (privacy tab, policy review, store assets)

## Constraints
- **VPS egress blocks OLX.in / Quikr** — live fixture capture must happen on Sandy's machine (scripts/redact-fixture.js)
- 6GB/2vCPU VPS — no heavy local models; OpenRouter/OpenCode Go for LLM calls
- BYOK: user supplies provider key (Groq/OpenRouter/etc.), keys only in chrome.storage.local
- Zero runtime dependencies (`dependencies: {}`), MV3, scoped matches, no `<all_urls>`

## Architecture (concise)
- **Backend (brains):** extractor (confidence-graded, never throws) → heuristics (deterministic 0-100) → optional LLM fusion (tolerant parse, schema-validate) → verdict + payment-pattern checks (6 patterns, offline, coreFact always)
- **Frontend:** popup (8 states, dark premium theme — brass seal, charcoal), options (10-provider grid, key field, model override, vision toggle), content script (classic-script compat, no proactive scan)
- **Docs of record:** PLAN-BACKEND.md (1076 lines), PLAN-FRONTEND.md, VERIFICATION.md (matrix), SCAMGUARD-AUDIT-REPORT.pdf

## Stack / tools
JS (ES modules → classic-compat build for content scripts), node:test, npm lint, GitHub Actions CI, playwright-driven real-extension E2E harness (scripts/e2e/real-extension.test.mjs, needs CHROME_PATH + LD_LIBRARY_PATH=$HOME/.local/lib/nss-libs).
