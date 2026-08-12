# ScamGuard

Bring-your-own-key scam risk checker for OLX & Quikr listings — your key, your data, your verdict.

- **Listing analysis**: heuristic pre-check (instant) + LLM verdict (streams in) → verdict seal.
- **Message & Payment Check**: flags QR "scan-to-receive" / UPI collect-request scams that run in chat, off the listing page.

## Docs

- [`PLAN-BACKEND.md`](PLAN-BACKEND.md) — non-UI architecture (data contracts, providers, prompts, scoring, security)
- [`PLAN-FRONTEND.md`](PLAN-FRONTEND.md) — UI/UX + extension shell (design system, popup states, options, manifest)

## Status

Phase 1/9 in progress — fixtures + heuristics. See repo history for per-phase commits.

## License

MIT
