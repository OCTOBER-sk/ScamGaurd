# ScamGaurd

Chrome extension that checks OLX.in & Quikr listings — and the payment instructions that follow in chat — for scam patterns, before you pay.

## What it is

- **Listing check** — opens on any OLX item or Quikr listing: an instant heuristic risk score, plus an optional LLM verdict from your own key, shown as a verdict seal in the popup.
- **Message & Payment Check** — catches the fraud that happens off the listing page: UPI collect-request and QR "scan-to-receive" tricks, with a plain-language verdict you can read before acting on any payment instruction.
- Built for Indian marketplace buyers and sellers, in Chrome (Manifest V3).

## What it uses

- **Chrome MV3** — service worker, scoped content script (olx.in listings, quikr.com), no `all_urls`.
- **Deterministic heuristics** — instant, offline risk scoring.
- **Optional LLM verdict** — bring your own key: Groq, OpenRouter, OpenAI, Anthropic, Mistral, DeepSeek, Cerebras, Gemini, or local Ollama.
- **Zero runtime dependencies.**

## What it saves

- **Stored locally:** your provider key and settings — in `chrome.storage.local`, never synced to any account.
- **Sent out:** only the listing or message text you are actively checking — and only to the LLM provider you chose, only if you enable the LLM verdict. Heuristic-only mode sends nothing.
- **Never:** accounts, telemetry, browsing history, or any record of the checks you run.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open the extension's options page and add a provider key.
3. Open any OLX item or Quikr listing, or run **Message & Payment Check** before paying.

## License

MIT
