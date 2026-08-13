<p align="center">
  <img src="assets/logo.png" alt="ScamGaurd" width="120">
</p>

<h1 align="center">ScamGaurd</h1>

<p align="center">
  <b>Chrome extension that catches marketplace scams on OLX & Quikr — before you pay.</b>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-C1272D" alt="License: MIT"></a>
  <a href="https://github.com/OCTOBER-sk/ScamGaurd/actions/workflows/ci.yml"><img src="https://github.com/OCTOBER-sk/ScamGaurd/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

---

ScamGaurd is a bring-your-own-key Chrome extension for Indian marketplace buyers and sellers. It checks the listing you're about to buy from — and the payment instructions you get in chat — and tells you, in plain language, whether it looks like a scam.

## What it does

- 🕵️ **Listing check** — instant heuristic risk score on any OLX item or Quikr listing, plus an optional LLM verdict from your own key. Verdict seal in the popup.
- 💬 **Message & Payment Check** — paste the chat message before you act: catches UPI collect-request and QR "scan-to-receive" tricks, OTP/screen-share plays, and overpayment refunds — in English and Hinglish.
- 🔑 **Bring your own key** — Groq, OpenRouter, OpenAI, Anthropic, Mistral, DeepSeek, Cerebras, Gemini, or local Ollama. No accounts, no subscriptions.
- 🔒 **Private by design** — keys stay in `chrome.storage.local`, never synced. Heuristic-only mode works fully offline and sends nothing.

## 🛟 Real use cases

**"Scan this QR to receive your payment"** — no legitimate UPI flow brings money in by scanning. ScamGaurd flags `SCAN_TO_RECEIVE` — including Hinglish like *"qr scan karo"* and *"paise receive karne ke liye scan"* — before you approve anything.

**"I paid extra by mistake — approve the refund"** — an approve/collect request takes money out of your account; refunds never need approving. ScamGaurd catches `COLLECT_REQUEST_FRAMED_AS_REFUND` and shows you why.

**Brand-new iPhone at 40% off** — price is the strongest scam signal. The listing check compares the asking price against per-category market tables; anything below ~40% of the expected price is flagged high-severity.

**"Share the OTP so I can confirm delivery"** — OTP/PIN/CVV or screen-share requests are account-takeover plays, not verification. ScamGaurd flags `OTP_OR_PIN_REQUEST` and `SCREEN_SHARE_REQUEST` exactly where they usually appear: mid-deal.

## How it works

1. **Heuristic scan** — deterministic and offline: a 0–100 risk score from listing and message signals, instantly.
2. **Optional LLM verdict** — your own key adds deeper reasoning, streamed into the popup.
3. **Verdict seal** — with the *why*, in plain language, before you pay.

## 🚀 Install

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → select this folder.
2. Open the extension's options page → add a provider key (Groq or OpenRouter work out of the box).
3. Open any OLX item or Quikr listing, or paste a chat message into **Message & Payment Check**.

## Data & privacy

- **Stored locally:** provider key and settings — `chrome.storage.local`, never synced.
- **Sent out:** only the listing or message text you actively check — to the provider you chose, and only with the LLM verdict enabled.
- **Never:** accounts, telemetry, browsing history, or records of your checks.

## License

MIT
