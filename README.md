# ScamGaurd

Chrome MV3 extension that flags scams on OLX.in & Quikr — on the listing page and in the chat/payment flow. Bring your own key (BYOK): no account, no telemetry; the only data that leaves your machine is the listing/message text you send to the LLM provider you chose.

## What it does

- **Listing analysis** — instant heuristic pre-check (deterministic 0–100) plus optional LLM verdict streamed from your key → verdict seal in the popup.
- **Message & Payment Check** — catches the fraud class that runs off-page: 6 offline patterns for UPI collect-request / QR "scan-to-receive" tricks, with a `coreFact` verdict always shown.
- **Popup** — 8 states (first-run, NoKey, analyzing, verdict, error, …), dual light/dark theme via `prefers-color-scheme`.
- **Options** — 10-provider BYOK grid (Groq, OpenRouter, OpenAI, Anthropic, Mistral, DeepSeek, Cerebras, Gemini, local Ollama, …), model override, vision toggle.
- **Privacy** — keys only in `chrome.storage.local` (never `sync`), scoped host matches (`olx.in/item/*`, `quikr.com/*`), zero runtime dependencies, no proactive scanning.

## Status

- ✅ 254/254 unit+integration tests, lint clean, CI green — verified
- ✅ Real-browser E2E pass: popup states, options grid, message-check click-through, NoKey first-run, 401 failure state
- ⏳ Live listing-page extraction pending — OLX/Quikr blocked from the dev network; fixture capture script at `scripts/redact-fixture.js`
- ⏳ Chrome Web Store submission pending (privacy tab + store assets)

## Install (dev)

1. Load the repo folder: `chrome://extensions` → Developer mode → **Load unpacked**.
2. Open options → add a provider key (Groq or OpenRouter work out of the box).
3. Visit an OLX item / Quikr listing, or open the popup → **Message & Payment Check**.

## Docs

- [`PLAN-BACKEND.md`](PLAN-BACKEND.md) — extractor, heuristics, LLM fusion, scoring, security
- [`PLAN-FRONTEND.md`](PLAN-FRONTEND.md) — UI/UX, design system, popup states, manifest
- [`VERIFICATION.md`](VERIFICATION.md) — per-layer proof matrix

## License

MIT
