# PLAN-BACKEND.md — ScamGuard "Brains" (non-UI architecture)

> Grounded in `SCAMGUARD_PROJECT.md` (requirements, market research, provider landscape) +
> live verification against official docs and live OLX.in pages on 2026-08-11, plus a second
> research pass on 2026-08-12 focused specifically on *what actually defrauds OLX/Quikr users in
> India right now* (real incident reports, cybercrime-helpline writeups, bank/fintech fraud
> advisories) rather than only generic "online marketplace scam" content. Every claim below is
> either sourced to `SCAMGUARD_PROJECT.md`, an official doc fetched during a research session, or
> explicitly marked as a design decision/assumption. Where source material conflicted with itself
> (common on fast-moving provider rate limits), official first-party docs were treated as ground
> truth over third-party blogs.

---

## -1. THE GAP THE 2026-08-11 PLAN MISSED (read this first)

The original architecture (§1–§6 below, mostly unchanged) analyzes the **listing page** — price,
seller signals, description language, photos — and produces a verdict before the user ever
messages anyone. That's correct and worth keeping. But the 2026-08-12 research pass, deliberately
searching for *real, dated Indian incident reports* rather than generic "marketplace scam" advice,
surfaced a hard fact that changes scope:

**The single most-cited, most financially damaging OLX/Quikr fraud pattern in India does not
happen on the listing page at all.** It happens in the chat that follows, usually within minutes
of a seller posting an ad, and it targets the **seller**, not the buyer:

1. A "buyer" contacts the seller within minutes, agrees to the asking price without haggling
   (itself the tell — real buyers negotiate), and says they'll pay by UPI right now.
2. They send a QR code or a UPI "collect request" and say some variant of *"scan this to receive
   the payment"* or *"I've sent ₹X, just approve it to confirm."*
3. Scanning a QR code and completing the flow — or approving a "collect request" notification —
   **authorizes an outgoing payment**, not an incoming one. The seller's own UPI PIN is what
   authorizes money leaving their account. The visual and conceptual framing ("scan to receive")
   is the entire trick; nothing technical is exploited.
4. A common variant sends a forged payment-confirmation screenshot first, to build false
   confidence, then the QR/collect-request follows, or the "buyer" claims they "overpaid" and
   asks for a partial refund — which is the same scan-to-pay trick run in reverse.

This is a distinct problem class from everything the original heuristics/LLM-prompt design
covers, because it happens **off-page, in WhatsApp or the platform's own chat, after the listing
has already been judged Safe** (a well-presented, fairly-priced, established-seller listing is
exactly the kind of ad this scam is run against, since the fraudster's whole plan depends on
reaching a real seller with a real item — the *listing itself* gives no signal). A tool that only
ever scores the listing page structurally cannot catch this, no matter how good its price/seller
heuristics get.

**Design consequence — new in-scope module, additive, does not change anything already
specified:** a second, independent check surface — "Message & Payment Check" — that the user
opens deliberately (paste chat text, or describe/paste a payment step) at the point they're
about to act on a payment instruction. This is **not** a replacement for the listing-analysis
flow; it's a second door into the same scoring/LLM machinery, because the highest-leverage moment
to warn someone is the 30 seconds before they scan a code, not five minutes earlier when they
first opened the listing. Full spec: §4.7 (prompt/detection) and §2.5 (data contract) below.
`PLAN-FRONTEND.md` §2.10 covers the corresponding UI surface.

This also reframes one existing line item: source doc's "conversation/link check" mode, previously
a minor variant of the user-prompt wrapper (old §4.2, retained below), was underspecified relative
to how important this path actually is — it's promoted from a footnote to a first-class, deliberately
designed feature with its own detection rules, not just a smaller heuristics subset of the same prompt.

---

## 0. WHAT CHANGED FROM `SCAMGUARD_PROJECT.md` AFTER RE-VERIFICATION

Read this first — it corrects/sharpens a few things the source doc flagged as "MEDIUM confidence, re-verify":

1. **Groq free tier is tighter than the source doc's "30 RPM / 14,400 RPD" framing.** Official
   Groq rate-limit docs (console.groq.com/docs/rate-limits, confirmed via search 2026-08-11)
   and cross-checked third-party trackers converge on **30 RPM / ~1,000 RPD / ~6,000 TPM** for
   most free-tier models as the current baseline (some models like Llama 4 Maverick are lower;
   Gemma 2 9B is higher on TPM only). The 14,400 RPD figure that appears in some third-party
   tables is stale/model-specific (older `llama-3.1-8b-instant` figure) and should not be relied
   upon in-product. **Design consequence: never hardcode a daily-limit number in the UI.** Read
   `x-ratelimit-remaining-requests` / `x-ratelimit-remaining-tokens` response headers at runtime
   and show *those* — see §6.
2. **Cerebras free tier is confirmed generous and stable across sources: ~1,000,000 tokens/day**,
   no card, **30 RPM**, with a **~8,192 token context cap on the free tier** (this context cap is
   new information not in the source doc — it matters because listing description + image
   analysis + system prompt could approach it on verbose listings; budget accordingly, §4.6).
3. **Gemini has TWO live structured-output surfaces as of Aug 2026**, not one: the legacy
   `generateContent` endpoint (`responseMimeType` + `responseSchema`) and the newer
   **Interactions API** (`POST /v1beta/interactions`, `response_format` with `mime_type` +
   `schema`, requires an `Api-Revision` header). The legacy endpoint is still fully documented
   and functional (Google's own docs let you toggle between them), and it is the simpler,
   better-supported integration for a v1 BYOK extension — **decision: target `generateContent`
   for v1**, structure the Gemini adapter so swapping to Interactions later is a config change,
   not a rewrite. Documented at ai.google.dev/gemini-api/docs/generate-content/structured-output.
4. **OpenRouter's `openrouter/free` auto-router is real and documented**, but OpenRouter's own
   ecosystem guidance (independently corroborated by third-party integration guides) says it
   "routes unpredictably" and is **not recommended for production** — it can route to
   reasoning/thinking models with unpredictable latency and to models that don't strictly honor
   `response_format`. **Decision: ScamGuard's default OpenRouter preset pins an explicit
   `:free` model tested for JSON reliability** (e.g. a Llama/Qwen/Trinity-class `:free` model
   with confirmed structured-output + non-thinking behavior), with `openrouter/free` offered
   only as an explicit "auto/experimental" opt-in in Advanced Settings, never the default.
5. **A new, materially important fact not anticipated in the source doc: Chrome Web Store
   Limited Use / Disclosure policy updates are already in force.** Per Google's official Chrome
   for Developers blog (developer.chrome.com/blog/cws-policy-updates-2026, dated 2026-07-01) and
   the Program Policies page, **enforcement began August 1, 2026** (10 days before this plan was
   written): (a) any data an extension collects must be *strictly necessary* to its disclosed
   single purpose, (b) **all** collection must be prominently disclosed regardless of whether
   it's "closely related" to the purpose, and (c) developers must **proactively notify users**
   if data handling changes post-install. This directly shapes ScamGuard's store listing and
   in-product consent copy — see §7.3. This is current, not evergreen guidance; PLAN-FRONTEND.md
   should re-verify before store submission since policy pages change.
6. **Manifest V3 service-worker lifecycle**: confirmed via developer.chrome.com/docs — idle
   termination is **~30 seconds**, but **any extension API call resets the idle timer** (Chrome
   110+), and a single **fetch() response taking longer than 30 seconds will itself terminate
   the worker**, independent of the idle timer. This is a hard constraint on the provider-call
   design in §5 — Cerebras/Groq are comfortably under 30s for typical listing-analysis payloads,
   but a slow/overloaded free-tier provider (Mistral Experiment tier, OpenRouter router fallback)
   could exceed it, so the SW must persist in-flight state to `chrome.storage.session` *before*
   awaiting the fetch, not after, so a restart can resume/report failure cleanly.

---

## 1. SYSTEM ARCHITECTURE

### 1.1 Full data flow (ASCII)

```
┌──────────────┐   GET_LISTING    ┌───────────────────┐
│  Popup (UI)  │ ───────────────► │ Content Script      │
│              │                  │ (extractor.js)       │
│              │ ◄─────────────── │ - detects listing pg │
│              │  Listing JSON    │ - scrapes DOM/meta    │
└──────┬───────┘                  └───────────────────┘
       │ ANALYZE {listing, settings}
       ▼
┌────────────────────────────────────────────────────────────┐
│ Background Service Worker (service-worker.js)                │
│                                                                │
│  1. heuristics.run(listing)         → HeuristicSignals        │
│     (pure sync function, zero network, <5ms)                  │
│                                                                │
│  2. persist {status:"analyzing", listing, heuristics}         │
│     to chrome.storage.session BEFORE any fetch (SW-restart    │
│     safety — see §0.6)                                        │
│                                                                │
│  3. provider = providerRegistry.get(settings.providerId)      │
│     req = provider.buildRequest(listing, heuristics, prompt)  │
│                                                                │
│  4. [optional] vision.buildImageParts(listing.images)         │
│     — only if provider+model support vision (capability flag) │
│                                                                │
│  5. fetch(provider.endpoint, req)  ──────► LLM Provider API   │
│                                     ◄────── raw response       │
│                                                                │
│  6. parse.tolerantParse(raw) → candidate JSON                 │
│     schema.validate(candidate) → valid | invalid               │
│     if invalid: repair.retryWithRepairPrompt() (max 1 retry)  │
│                                                                │
│  7. scoring.fuse(heuristics, llmVerdict) → RiskReport          │
│                                                                │
│  8. storage.history.save(RiskReport)                          │
│     chrome.storage.session.set({status:"done", report})       │
│                                                                │
└──────┬─────────────────────────────────────────────────────┘
       │ RESULT { report } (via runtime.sendMessage / port)
       ▼
┌──────────────┐
│  Popup (UI)  │  renders RiskReport
└──────────────┘
```

### 1.2 Why this shape

- **Heuristics run first and always** (even if the LLM call later fails) — the product's
  non-functional requirement is "sub-1s heuristic pre-check shown instantly" (source doc §4.2).
  Heuristics have zero dependency on network/provider, so they must be computable and
  renderable before the fetch even starts.
- **All provider calls happen in the service worker, never the content script** — required
  because content scripts execute in the *page's* origin and are subject to that page's CSP and
  CORS restrictions; the extension's own `host_permissions` only grant cross-origin fetch rights
  to code running in the extension's own contexts (service worker, popup, options page). This is
  standard MV3 practice and is also what source doc §6 already specifies — confirmed correct.
- **The vision stage is a structurally separate, optional step**, not folded into the main
  prompt, because (a) not all providers/models support image input, (b) it changes the request
  shape (multipart content array vs plain string), and (c) it must degrade independently — a
  provider that fails vision should still return a valid text-only verdict.

---

## 2. DATA CONTRACTS

All shapes below are the **internal universal schema** — the shape ScamGuard's own code passes
around. Provider adapters translate to/from this; the LLM never sees these exact field names
verbatim (the user-prompt wrapper serializes a trimmed subset — see §4.3).

### 2.1 `Listing`

```ts
interface Listing {
  platform: "olx" | "quikr" | "unknown";
  url: string;                      // location.href at scrape time
  adId: string | null;              // OLX: numeric iid from URL (e.g. "1827354630");
                                     // Quikr: platform-specific id — extractor must fall back
                                     // to null rather than guess (see §8 extractor notes)
  title: string | null;
  price: {
    amount: number | null;          // parsed numeric value, no currency symbol/commas
    currency: "INR" | "unknown";
    raw: string | null;             // original text as scraped, for display/debugging
  };
  description: string | null;       // full text, HTML stripped
  sellerName: string | null;
  sellerMemberSince: string | null; // raw text e.g. "Feb 2014" — do NOT attempt to parse to
                                     // a Date; OLX shows month+year only, ambiguous formats
                                     // across locales. Heuristics work off the raw string.
  sellerItemsListed: number | null; // OLX: "9 Items listed" → 9
  sellerVerified: boolean | null;   // null = platform doesn't expose this signal / not found
  location: string | null;
  postedAt: string | null;          // raw text ("Today", "Yesterday", "19 Jul") — NOT parsed to
                                     // absolute date; relative-time strings vary and are
                                     // ambiguous without a captured page-load timestamp anchor
  images: {
    url: string;
    isThumbnail: boolean;
  }[];
  imageCount: number;
  extractionConfidence: "high" | "partial" | "low";
  // "high": title+price+description all found via primary selectors/meta
  // "partial": some required fields fell back to secondary strategy or are missing
  // "low": fewer than 2 of {title, price, description} recovered — popup should show
  //        a clear "couldn't read this page well" state rather than a false-confidence verdict
  extractedAt: string;              // ISO 8601 timestamp
}
```

**Per-platform optionality note (source doc open question #1):** live inspection of a real
OLX.in listing page on 2026-08-11 (see §8.1 for the exact fetch) confirms `og:title`,
`og:description`, `og:image`, and the `AD ID <number>` text pattern are present and reliable.
Seller "member since," "Items listed" count, and location breadcrumb are present as rendered
text but **not** exposed via `og:` meta or a `<script type="application/ld+json">` block on the
page as fetched — meaning **the extractor must read live DOM text nodes for these fields, not
meta tags**, and needs resilient text-pattern matching (e.g. regex `/Member since (\w+ \d{4})/`,
`/(\d+)\s+Items listed/`) rather than a single stable selector, because OLX's frontend is a
React SPA with hashed/generated class names that are not documentation-stable. **This is a
correction to the source doc's assumption that `data-aut-id` attributes are confirmed present
and stable** — no independent public documentation of current `data-aut-id` values on OLX.in
could be found during this research pass. Design consequence: ship the extractor with (1) a
primary strategy using whatever stable `data-aut-id`/`data-testid`-style attributes the content
script observes at runtime via manual DevTools inspection during build (this is the developer's
job, not something this plan can hardcode from search results), (2) a documented text-pattern
fallback chain as described above, and (3) `extractionConfidence` so the UI never silently shows
a confident-looking score built on a low-confidence scrape.

### 2.2 `HeuristicSignals`

```ts
interface HeuristicSignals {
  priceAnomaly: {
    triggered: boolean;
    severity: "none" | "low" | "medium" | "high";
    ratioVsCategoryTypical: number | null; // price / typical-range midpoint, if a category
                                            // match was found in the local knowledge table
    note: string;
  };
  sellerAge: {
    triggered: boolean;              // true if account looks new/unverified
    memberSinceRaw: string | null;
    itemsListed: number | null;
  };
  photoSignals: {
    count: number;
    triggered: boolean;              // true if 0-1 photos on a high-value listing
    severity: "none" | "low" | "medium";
  };
  contactChannelLeak: {
    triggered: boolean;              // phone/email/WhatsApp number found in description
    matches: string[];               // redacted/partial matches for display, never full PII persisted
  };
  urgencyLanguage: {
    triggered: boolean;
    matchedPhrases: string[];        // e.g. "urgent sale", "today only", "first come"
  };
  advanceFeeLanguage: {
    triggered: boolean;
    matchedPhrases: string[];        // "booking amount", "token advance", "courier fee", "GST fee"
  };
  offPlatformPaymentLanguage: {
    triggered: boolean;
    matchedPhrases: string[];        // "UPI only", "pay first", "gpay", "advance via phonepe"
  };
  heuristicScore: number;            // 0-100, deterministic weighted sum — see §5.1
  computedAt: string;                // ISO 8601
}
```

### 2.3 `RiskReport` (final output shown in popup)

```ts
interface RiskReport {
  reportId: string;                  // uuid, generated client-side
  listingUrl: string;
  listingTitle: string | null;
  score: number;                     // 0-100 fused score
  verdict: "Safe" | "Review" | "Suspicious" | "High-Risk";
  confidence: "high" | "medium" | "low"; // reflects extractionConfidence + provider success
  redFlags: {
    id: string;                      // stable key, e.g. "PRICE_ANOMALY", "NEW_SELLER"
    label: string;                   // human-readable, e.g. "Price far below market"
    severity: "low" | "medium" | "high";
    source: "heuristic" | "llm" | "vision";
    explanation: string;             // 1-2 sentence plain-language reason
  }[];
  summary: string;                   // 2-4 sentence LLM-authored overview
  checklist: string[];               // ordered safe-buying action items
  reportingResources: {
    label: string;
    value: string;                   // "1930", "cybercrime.gov.in", etc.
  }[];
  visionAnalysis: {
    performed: boolean;
    skippedReason: string | null;    // "model has no vision capability" | "provider error" | null
    notes: string[];
  } | null;
  provider: {
    id: string;                      // "gemini" | "groq" | "cerebras" | ...
    model: string;
    latencyMs: number;
    usedFallbackRepair: boolean;     // true if the tolerant-parse/repair path was needed
  };
  rawListing: Listing;               // for the "raw data" accordion in the popup
  createdAt: string;                 // ISO 8601
}
```

### 2.4 `ProviderSettings` (stored in `chrome.storage.local`)

```ts
interface ProviderSettings {
  providerId: "gemini" | "groq" | "cerebras" | "openrouter" | "mistral" | "deepseek" | "openai" |
              "anthropic" | "ollama" | "custom";
  apiKey: string;                    // NEVER logged, NEVER sent anywhere but the chosen provider
  modelOverride: string | null;      // null = use provider preset default
  customEndpoint: string | null;     // only used when providerId === "custom"
  visionEnabled: boolean;            // user toggle; auto-disabled if model preset has no vision
  lastTestedAt: string | null;
  lastTestResult: "success" | "failure" | null;
}
```

### 2.5 `PaymentCheckInput` / `PaymentCheckReport` (Message & Payment Check, §-1 / §4.7)

Deliberately a **separate, smaller contract** from `Listing`/`RiskReport` — this flow has no
price/seller/photo signals to fuse (there's no listing object at all in the common case: a user
pastes a chat snippet or describes a payment instruction they just received), so reusing
`RiskReport`'s shape would carry fields that are always null and imply a false equivalence
between "I scored this listing" and "I scored this payment instruction." The two report types
render as visually distinct popup states (`PLAN-FRONTEND.md` §2.10) precisely so a user never
confuses a stale listing verdict with a live in-conversation warning.

```ts
interface PaymentCheckInput {
  mode: "pastedText" | "describedFlow";
  // "pastedText": user pasted a chat excerpt (WhatsApp/platform chat copy-paste)
  // "describedFlow": user answered a short guided prompt instead of pasting text — see
  //                   PLAN-FRONTEND.md §2.10 for why both entry points exist
  rawText: string | null;              // present for "pastedText"
  guidedAnswers: {
    role: "buying" | "selling";
    wasAskedToScanOrApprove: boolean;
    claimedReasonForCode: string | null;  // free text, e.g. "buyer said scan to receive"
  } | null;                              // present for "describedFlow"
  listingContext: { listingUrl: string; listingTitle: string } | null;
    // populated automatically when this flow is opened from an existing RiskReport (§4/frontend
    // §2.10 "Check this conversation" entry point) — null when opened standalone from the toolbar
}

interface PaymentCheckReport {
  reportId: string;
  verdict: "LikelyScam" | "Caution" | "NoRedFlagsFound";
  // deliberately a 3-band scale, not the 4-band Listing verdict scale (§5.3) — this flow answers
  // a narrower, more binary question ("is this payment step a trap?") and a 4-band numeric score
  // would imply a precision the pattern-matching here doesn't have
  matchedPatterns: {
    id: string;               // "SCAN_TO_RECEIVE", "COLLECT_REQUEST_FRAMED_AS_REFUND",
                               // "FAKE_SCREENSHOT_THEN_QR", "OVERPAYMENT_REFUND_REQUEST",
                               // "SCREEN_SHARE_REQUEST", "OTP_OR_PIN_REQUEST"
    label: string;
    explanation: string;
  }[];
  coreFact: string;            // always populated, always the same anchor fact regardless of
                                // verdict — see §4.7 rationale for why this line is non-negotiable
  summary: string;
  createdAt: string;
}
```

---

## 3. PROVIDER ADAPTER LAYER

### 3.1 Interface (all providers implement this)

```ts
interface ProviderAdapter {
  id: string;
  label: string;
  defaultEndpoint: string;
  authStyle: "bearer" | "header" | "query-param";
  authKeyName: string;               // "Authorization" | "x-goog-api-key" | "key"
  defaultModel: string;
  visionCapableModels: string[];     // model IDs known to accept image input
  supportsJsonMode: boolean;
  jsonModeStyle: "openai-response-format" | "gemini-response-schema" | "prompt-only";
  timeoutMs: number;                 // per-provider default, tuned to typical latency

  buildRequest(input: {
    listing: Listing;
    heuristics: HeuristicSignals;
    systemPrompt: string;
    userPrompt: string;
    imageParts?: { mimeType: string; base64: string }[];
    model: string;
    apiKey: string;
  }): { url: string; headers: Record<string,string>; body: unknown };

  parseResponse(raw: unknown): { text: string; usage?: { inputTokens:number; outputTokens:number } };

  testConnection(apiKey: string, model: string): Promise<{ ok: boolean; message: string }>;
}
```

### 3.2 Per-provider presets (verified 2026-08-11)

| id | endpoint | auth | default model | JSON mode | vision |
|---|---|---|---|---|---|
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `x-goog-api-key` header | `gemini-2.5-flash` (fallback to `gemini-3.x-flash` family if the account has access — **do not hardcode a single ID at build time; the options page "Test connection" flow must call `ListModels` or accept manual override** because Gemini model IDs rotate faster than this plan can track) | `responseMimeType: "application/json"` + `responseSchema` | yes, native inline image parts |
| `groq` | `https://api.groq.com/openai/v1/chat/completions` | `Authorization: Bearer` | `llama-3.3-70b-versatile` | `response_format: {type:"json_object"}` | no (text-only free models as of this research pass — do not enable vision toggle for Groq presets) |
| `cerebras` | `https://api.cerebras.ai/v1/chat/completions` | `Authorization: Bearer` | `llama3.1-8b` (fastest, comfortably inside the ~8,192 token free-tier context cap — see §0.2) | `response_format: {type:"json_object"}` (OpenAI-compatible) | no |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `Authorization: Bearer` | a pinned `:free` model verified for structured-output support, **not** `openrouter/free` (see §0.4) — resolve the exact current model slug in the options page's provider-preset fetch rather than hardcoding, since OpenRouter's free catalog rotates | `response_format: {type:"json_schema", json_schema:{...}}` when the pinned model supports it, else `{type:"json_object"}` | model-dependent; check `supported_parameters` on the model before enabling |
| `mistral` | `https://api.mistral.ai/v1/chat/completions` | `Authorization: Bearer` | `mistral-small-latest` | `response_format: {type:"json_object"}` | no |
| `deepseek` | `https://api.deepseek.com/v1/chat/completions` | `Authorization: Bearer` | `deepseek-chat` (maps to current V-series flash-class model; source doc's specific "V4 Flash" ID should be re-verified at build time since DeepSeek retired old aliases mid-2026 per source doc §5) | `response_format: {type:"json_object"}` | no |
| `openai` | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer` | user-specified (no free tier; don't assume a default) | `response_format: {type:"json_schema", strict:true, ...}` | yes |
| `anthropic` | `https://api.anthropic.com/v1/messages` | `x-api-key` header + `anthropic-version` header | user-specified | tool-use forced-JSON pattern (no native `response_format`) | yes |
| `ollama` | `http://localhost:11434/v1/chat/completions` | none | user-specified (e.g. `llama3.1:8b`) | `response_format: {type:"json_object"}` (OpenAI-compat mode) | model-dependent |
| `custom` | user-provided | user-selected style | user-specified | user-selected | user-toggle |

### 3.3 Example request/response — Gemini

```jsonc
// POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent
// Header: x-goog-api-key: <user's key>
{
  "contents": [{
    "role": "user",
    "parts": [{ "text": "<system prompt + user prompt, concatenated — see §4>" }]
  }],
  "generationConfig": {
    "responseMimeType": "application/json",
    "responseSchema": { "$ref": "#/RiskVerdictSchema (§4.5)" },
    "maxOutputTokens": 1024,
    "temperature": 0.2
  }
}
```
Response (trimmed): `{"candidates":[{"content":{"parts":[{"text":"{...RiskVerdict JSON...}"}]}}]}`
— `parseResponse` extracts `candidates[0].content.parts[0].text` and passes it to
`tolerantParse`.

### 3.4 Example request/response — Groq / Cerebras / OpenAI-compatible

```jsonc
// POST https://api.groq.com/openai/v1/chat/completions
// Header: Authorization: Bearer <key>
{
  "model": "llama-3.3-70b-versatile",
  "messages": [
    { "role": "system", "content": "<system prompt, §4.1>" },
    { "role": "user", "content": "<user prompt, §4.2>" }
  ],
  "response_format": { "type": "json_object" },
  "temperature": 0.2,
  "max_tokens": 1024
}
```
Response: standard OpenAI chat-completions shape —
`choices[0].message.content` is the JSON string. Cerebras and Mistral use the identical shape
(all are OpenAI-compatible per source doc §5, confirmed).

### 3.5 Example request — custom OpenAI-compatible endpoint

```jsonc
{
  "endpoint": "https://my-self-hosted-llm.example.com/v1/chat/completions",
  "authStyle": "bearer",
  "requestShape": "openai-chat",   // user picks from a dropdown: openai-chat | gemini-native
  "jsonModeStyle": "openai-response-format" // or "prompt-only" if the model doesn't support it
}
```
For `prompt-only` providers (no native JSON enforcement), the system prompt (§4.1) carries the
full weight of format compliance, and `parse.tolerantParse` + `schema.validate` +
`repair.retryWithRepairPrompt` (§3.6) become load-bearing rather than a backstop.

### 3.6 "Test Connection" flow

1. Options page calls `background.testConnection({providerId, apiKey, model})`.
2. Service worker sends a minimal request: system prompt = `"Reply with exactly this JSON: "
   {"ok": true}"`, small `max_tokens` (32), same auth/endpoint the real analysis would use.
3. Response handling:
   - HTTP 200 + parseable `{ok:true}` → `{ok: true, message: "Connected — <model> responded in
     <Nms>"}`.
   - HTTP 401/403 → `{ok:false, message:"Key rejected by provider. Double-check you copied the
     full key."}`.
   - HTTP 429 → `{ok:false, message:"Provider rate-limited this key right now. Your key is
     valid — try again in a minute."}` (this is a *success* signal for key validity, worded so
     the user doesn't think their key is broken).
   - Timeout → `{ok:false, message:"No response within Ns. Check your internet connection or
     try a different provider."}`.
   - Malformed JSON back → `{ok:false, message:"Connected, but the model's response wasn't
     valid JSON. This provider/model may not support ScamGuard's structured-output mode —
     try another model."}`.
4. Result + timestamp written to `ProviderSettings.lastTestedAt/lastTestResult`.

---

## 4. PROMPT ENGINEERING

### 4.1 System prompt (verbatim, ship this)

```
You are a scam-detection analyst embedded in a browser extension called ScamGuard. You analyze
second-hand marketplace listings from Indian classifieds sites (OLX, Quikr) and output a
structured risk assessment. You are not a general chatbot — you have exactly one job.

You will be given: (1) listing data scraped from the page, (2) a set of pre-computed heuristic
signals, and optionally (3) listing photos. Weigh these signal categories:

- PRICE: Is the price implausibly low for the stated item/condition? Sellers legitimately
  discount for quick sale, damage, or urgency — a low price alone is weak evidence. Combine it
  with other signals before treating it as strong.
- SELLER SIGNALS: New accounts, very few items listed, and no verification are weak-to-moderate
  signals, not proof. Long-established accounts with many listings are reassuring but not
  conclusive (compromised accounts exist).
- PHOTOS: If images are provided, look for signs of AI generation (unnaturally perfect lighting,
  subtle anatomical/geometric inconsistencies, repeated background artifacts, mismatched
  shadows), stock/catalog photos reused for a "used" item, or photos that don't match the
  stated condition/model. State your confidence honestly — reverse-image-style AI-generation
  detection from a single image is not reliable; describe what you observe, don't overclaim
  certainty.
- LANGUAGE: Urgency pressure ("today only," "first come first serve"), requests to move off
  the platform to WhatsApp/Telegram before any vetting, advance-payment/booking-fee/token
  language, "pay via UPI/GPay only," refusal to negotiate combined with refusal to meet in
  person, and courier/insurance/GST "fee" framing are the strongest textual scam indicators for
  this market.
- WHAT THIS ANALYSIS CANNOT SEE: you have no way to verify the seller's real identity, whether
  the item physically exists, or what happens in a private chat. State this limitation in your
  summary when the risk is genuinely ambiguous — do not manufacture false certainty in either
  direction.

Respond with ONLY a single JSON object matching this exact schema — no prose before or after,
no markdown code fences:

{
  "llmScore": <integer 0-100, your independent risk estimate>,
  "redFlags": [ { "id": "<UPPER_SNAKE_CASE>", "label": "<short label>", "severity":
    "low"|"medium"|"high", "explanation": "<1-2 plain sentences>" } ],
  "summary": "<2-4 sentences, calm and factual, no alarmism>",
  "checklistAdditions": ["<any listing-specific safe-buying advice beyond the standard
    checklist>"],
  "visionNotes": ["<only if photos were provided; empty array otherwise>"]
}

If the input does not look like a real marketplace listing (e.g. it's empty, it's a search
results page, or the text is unrelated to a for-sale item), respond with:
{"llmScore": 0, "redFlags": [], "summary": "This does not appear to be a listing page.",
"checklistAdditions": [], "visionNotes": [], "notAListing": true}

Never include personal opinions about the seller as a person, never accuse anyone of a crime —
frame everything as "this listing shows patterns associated with X" not "this seller is
scamming you." Keep the tone calm and factual; the reader may be anxious about losing money.
```

### 4.2 User-prompt wrapper (template, filled at request time)

```
LISTING DATA:
Platform: {{platform}}
Title: {{title}}
Price: {{price.raw}} ({{price.currency}})
Description: {{description}}
Seller: {{sellerName}} — member since {{sellerMemberSince}} — {{sellerItemsListed}} items listed
Location: {{location}}
Posted: {{postedAt}}
Photo count: {{imageCount}}
Extraction confidence: {{extractionConfidence}}

PRE-COMPUTED HEURISTIC SIGNALS (already calculated, do not recompute — use as context):
- Price anomaly: {{heuristics.priceAnomaly.triggered}} ({{heuristics.priceAnomaly.severity}}) —
  {{heuristics.priceAnomaly.note}}
- New/low-activity seller: {{heuristics.sellerAge.triggered}}
- Low photo count flag: {{heuristics.photoSignals.triggered}}
- Contact-channel leak in description: {{heuristics.contactChannelLeak.triggered}}
- Urgency language matched: {{heuristics.urgencyLanguage.matchedPhrases}}
- Advance-fee language matched: {{heuristics.advanceFeeLanguage.matchedPhrases}}
- Off-platform payment language matched: {{heuristics.offPlatformPaymentLanguage.matchedPhrases}}

Analyze this listing per your instructions and return the JSON object.
```

For the **conversation/link check** mode (source doc §4.1 item 7), the wrapper is a variant:
`MESSAGE TEXT: {{pastedText}}` or `LINK: {{pastedUrl}}` with heuristics limited to
urgency/advance-fee/off-platform-payment language matching (price/seller/photo signals don't
apply) — same system prompt, same output schema, `notAListing` naturally handles link-only input
gracefully by letting the LLM still assess pressure-tactic language in accompanying text.

### 4.3 Vision request construction

When `visionEnabled && provider.visionCapableModels.includes(model)`:
- Fetch each image URL from `listing.images` (max 3 images to control payload/latency/cost),
  fetch in the service worker (not content script, to avoid page CSP issues on image hosts).
- **Strip EXIF and downscale** client-side before sending: decode via `createImageBitmap`,
  redraw to an `OffscreenCanvas` at max 768px longest edge, re-encode as JPEG q=0.7. This
  achieves both the privacy requirement (EXIF often contains GPS/device data — irrelevant to a
  scam-listing photo but shouldn't be forwarded to a third party unnecessarily) and the
  lightweight requirement (source doc §4.2).
- Gemini: append `{"inlineData": {"mimeType": "image/jpeg", "data": "<base64>"}}` parts to the
  same `contents[0].parts` array as the text prompt.
- OpenAI-compatible vision models: `content: [{type:"text", text: userPrompt}, {type:
  "image_url", image_url:{url: "data:image/jpeg;base64,<...>"}}]`.
- If image fetch fails (hotlink protection, CORS, 404) for a given image: skip that image, don't
  fail the whole analysis; set `visionAnalysis.notes` to mention how many of N images were
  successfully analyzed.

### 4.4 Temperature & token budgets

| Setting | Value | Why |
|---|---|---|
| `temperature` | `0.2` | Risk analysis should be consistent run-to-run on the same listing; not creative-writing territory. |
| `max_tokens` (text-only) | `1024` | Generous for the schema in §4.1; empirically JSON verdicts run 200-500 tokens. |
| `max_tokens` (with vision notes) | `1536` | visionNotes array adds length. |
| `timeoutMs` default | `12000` (12s) for Groq/Cerebras; `20000` for Gemini/OpenRouter/Mistral/DeepSeek | Tuned to source doc's documented speed tiers (§5 there) with headroom, and to stay well under the MV3 30-second fetch-termination ceiling (§0.6). |

### 4.5 Structured-output schema object (shared across providers, transformed per §3.2 style)

```json
{
  "type": "object",
  "properties": {
    "llmScore": { "type": "integer", "minimum": 0, "maximum": 100 },
    "notAListing": { "type": "boolean" },
    "redFlags": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "label": { "type": "string" },
          "severity": { "type": "string", "enum": ["low", "medium", "high"] },
          "explanation": { "type": "string" }
        },
        "required": ["id", "label", "severity", "explanation"]
      }
    },
    "summary": { "type": "string" },
    "checklistAdditions": { "type": "array", "items": { "type": "string" } },
    "visionNotes": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["llmScore", "redFlags", "summary", "checklistAdditions", "visionNotes"]
}
```

### 4.6 Refusal / edge-case behavior

- Non-listing input → handled in-schema via `notAListing: true` (§4.1) rather than a provider
  refusal, which keeps parsing uniform.
- Extremely long descriptions (rare, but possible on Quikr free-text ads): truncate
  `description` to ~2,000 characters before building the prompt, note truncation in the prompt
  wrapper (`"[description truncated to 2000 chars]"`), to stay well inside Cerebras's ~8,192
  token free-tier context cap (§0.2) once system prompt + heuristics + response budget are
  accounted for.
- If the model returns prose refusing to analyze (rare on open models, more common if a provider
  applies its own moderation layer to "scam" framing) — `tolerantParse` will fail to find valid
  JSON; treat as a parse failure and follow the retry-with-repair path (§6), not a silent 0
  score.

### 4.7 Message & Payment Check — detection logic (§-1, §2.5)

This flow runs a **deterministic pattern-match pass first** (same "cheap and instant before any
network call" philosophy as heuristics.run() in §5.1), then an optional LLM pass for nuance —
mirroring the two-stage shape of the main flow, but tuned for a different job: recognizing a
small, well-documented set of payment-instruction traps rather than judging an entire listing.

**Why pattern-match first, and why it alone can be trusted to produce a `LikelyScam` verdict
without waiting on an LLM call:** every source found in the 2026-08-12 research pass (bank/fintech
fraud advisories, cybercrime-helpline writeups, direct incident reports) converges on the same
small set of phrasings and mechanics, because the scam itself is simple and doesn't vary much —
unlike listing scams, where wording is genuinely diverse. That means a short, high-precision
phrase/pattern list catches the overwhelming majority of real cases, and — critically — this is
exactly the kind of check where **speed matters more than nuance**: the danger moment is the user
about to scan a code *right now*, not a report they'll read later. A local, instant match beats a
technically-more-nuanced verdict that arrives 4 seconds late.

**Pattern list (local, `payment-scam-patterns.js`, independently testable/extendable per the same
`language-patterns.js` separation principle already used in §5.1):**

| Pattern id | What it matches | Why it's close to unambiguous |
|---|---|---|
| `SCAN_TO_RECEIVE` | Phrasing that frames scanning a QR code, or approving a UPI request/notification, as the mechanism for the *user* to **receive** money (e.g. "scan this to get paid," "scan and receive," "approve to receive payment") | A QR code / collect request can only ever request an outgoing payment from the scanner; there is no legitimate UPI flow where scanning "receives" money. This is close to a structural fact, not a judgment call — see `coreFact` below. |
| `COLLECT_REQUEST_FRAMED_AS_REFUND` | A "collect request" or "approve payment" notification described as being for a refund, cashback, or "correcting an overpayment" | Same underlying mechanic as `SCAN_TO_RECEIVE`, different cover story — refunds are always sender-initiated pushes, never something the recipient "approves." |
| `FAKE_SCREENSHOT_THEN_QR` | A payment-confirmation screenshot mentioned/pasted, followed by (or alongside) a request to scan something or approve something "to release/confirm/complete" the payment | The screenshot's job in this pattern is to manufacture false confidence right before the real ask; text describing this sequence is itself close to diagnostic even without verifying the screenshot's authenticity. |
| `OVERPAYMENT_REFUND_REQUEST` | Buyer claims to have sent more than the agreed amount and asks for the difference back via a QR/link/collect-request rather than a normal bank-to-bank transfer | Classic "overpayment" con — the "overpayment" never happened; the "refund" step is the actual theft. |
| `SCREEN_SHARE_REQUEST` | Any mention of being asked to install/open a remote-access or screen-sharing app (AnyDesk, TeamViewer, "Quick Support," etc.) to "help complete" or "verify" a payment | No legitimate marketplace payment step requires remote access to the other party's device. |
| `OTP_OR_PIN_REQUEST` | Any mention of being asked to share an OTP, UPI PIN, or card CVV over call/chat, framed as needed to "receive," "verify," or "unlock" a payment | A PIN/OTP is only ever needed to *authorize an outgoing payment or a login* — it is never required to receive money. This is the same anchor fact as `SCAN_TO_RECEIVE`, phrased around PIN-sharing instead of QR-scanning. |

Each pattern is matched with a short phrase/regex list (not a single string) to tolerate the
casual, code-switched (Hindi-English) phrasing typical of these chats — e.g. matching "scan karke
paise le lo," "collect request aaya hai," alongside the English equivalents — and matching is
intentionally permissive (favor false positives here over false negatives, opposite of the main
listing heuristics' calibration in §5.4) because the cost of an unnecessary warning is a few
seconds of the user's attention, while the cost of a missed one is measured in real money that is
**not recoverable** once a UPI transaction clears.

**The `coreFact` field is always populated, on every verdict, even `NoRedFlagsFound`:** *"A QR
code or payment request can only ever be used to send money, never to receive it. If anyone — no
matter how convincing — asks you to scan something or enter your PIN/OTP to 'receive' a payment,
that is always false, with no exceptions."* This is deliberately hardcoded in the extension
itself, not LLM-generated, because it's the single fact that defeats the large majority of real
cases (§-1) regardless of which specific script the scammer is running, and it must never depend
on a network call succeeding to reach the user. It ships as a constant in
`shared/constants.js` alongside the existing reporting-resource strings (§8 file plan) and is
rendered even in a total-LLM-failure / offline state.

**LLM pass (optional, adds nuance, never blocks the pattern-match result):** if a provider is
configured, the matched-pattern list plus the raw text is sent through a dedicated, much shorter
system prompt (not the listing-analysis prompt from §4.1 — the two jobs are different enough to
warrant a separate prompt rather than overloading one prompt with a mode flag) asking the model to
(a) confirm/soften the pattern-match verdict with reasoning about context the regex can't see
(e.g. the user pasted a message *warning someone else* about this scam, which should never be
flagged), and (b) write the plain-language `summary`. If this call fails or times out, the
pattern-match result and `coreFact` still render — the LLM pass is additive polish, not a
dependency, consistent with the "heuristics never blocked by network" principle already
established for the main flow (§1.2).

**Explicitly out of scope for v1, documented as such:** verifying whether a pasted "payment
screenshot" image is authentic (this would need either a vision call specifically trained/prompted
for screenshot-forgery tells, which is a different and much harder problem than the listing-photo
vision check in §4.3, or reverse-image lookup against known template scans — neither is reliable
enough to state a verdict on with confidence, and a false "this screenshot looks real" reading
would be actively dangerous here). ScamGuard flags the *pattern of behavior* around a screenshot
(§`FAKE_SCREENSHOT_THEN_QR`) rather than authenticating the image itself, and the `summary` copy
says so explicitly rather than implying image verification happened.

---

## 5. RISK SCORING

### 5.1 Heuristic score (deterministic, computed before any LLM call)

Weighted sum, each signal contributes 0 to its max weight, summed and clamped to 0-100:

| Signal | Max weight | Trigger condition |
|---|---|---|
| Price anomaly | 30 | `ratioVsCategoryTypical < 0.4` → full 30; `0.4–0.6` → 15; else 0. Category table is a small local JSON of common categories (phones, laptops, TVs, vehicles, furniture) with rough INR ranges — ships in `src/heuristics/price-table.json`, explicitly a v1 approximation, not authoritative. |
| Off-platform payment language | 20 | any match → 20 |
| Advance-fee language | 20 | any match → 20 |
| Urgency language | 10 | any match → 10 |
| New/low-activity seller | 10 | `itemsListed !== null && itemsListed <= 1` → 10; unknown/null → 5 (can't penalize what we can't see, but also can't fully reward it) |
| Low photo count on high-value item | 10 | `imageCount <= 1 && price.amount > 5000` → 10 |
| Contact-channel leak in description | 10 | (soft signal — sellers legitimately share numbers; only meaningfully combined with other flags, see fusion) → 10 if present |

This produces `HeuristicSignals.heuristicScore` — shown to the user **instantly**, before any
network call, satisfying the sub-1s requirement (source doc §4.2).

### 5.2 Fusion algorithm

```
fusedScore = round(
  (0.45 * heuristicScore) +
  (0.55 * llmScore)
)
```

**Why LLM-weighted slightly higher:** heuristics are keyword/threshold-based and miss nuance
(e.g. a legitimately urgent but honest relocation sale vs. a manufactured-urgency scam read the
same to a keyword matcher but differently to an LLM reading full context). But heuristics are
**never zero-weighted**, because they're the only signal guaranteed to exist even when the LLM
call fails entirely (§6) — in that failure path, `fusedScore = heuristicScore` and
`confidence` drops to `"low"`.

**If `notAListing: true`** from the LLM: don't fuse — return a distinct UI state, not a
score, so the user isn't shown a meaningless "12/100" for a page ScamGuard couldn't actually
analyze.

### 5.3 Verdict bands

| Score range | Verdict | Popup color/tone (frontend concern, noted here for consistency) |
|---|---|---|
| 0–24 | **Safe** | reassuring, still show checklist |
| 25–49 | **Review** | neutral, "a few things to check" |
| 50–74 | **Suspicious** | cautionary |
| 75–100 | **High-Risk** | strong warning + reporting resources surfaced prominently |

**Escalation override:** regardless of numeric score, if `redFlags` contains any `severity:
"high"` entry from the LLM tagged with id `ADVANCE_FEE_REQUEST` or `OFF_PLATFORM_PAYMENT_ONLY`,
floor the verdict at `"Suspicious"` even if the numeric fusion lands lower — these are the two
patterns most directly tied to actual money loss per the source doc's market research (§2.1-2.2
there), and a purely numeric threshold could under-warn on a listing that's otherwise
well-presented but explicitly demands advance UPI payment.

### 5.4 Calibration strategy (v1, honest about its limits)

There is no labeled Indian-marketplace-scam training set available to this project (source doc
doesn't claim one exists, and none was found in this research pass). **v1 calibration is
rule-based and manually tuned against the fixture set in §9**, not statistically fit. Document
this limitation in the README per the portfolio-honesty bar (source doc §7.2: "README factual").
Future work (explicitly out of v1 per source doc §4.3): collect real verdict/outcome feedback
(with consent) to calibrate weights empirically.

---

## 6. ERROR HANDLING MATRIX

| Failure mode | Detection | User-facing behavior | Retry strategy |
|---|---|---|---|
| No API key set | `ProviderSettings.apiKey` empty | Popup shows `NoKey` state with a direct link to options page; heuristic score still shown | none — user action required |
| Invalid/rejected key | HTTP 401/403 | "Your API key was rejected by {provider}. Check it in Settings." + link | none — user action required |
| Timeout | fetch exceeds `timeoutMs` (§4.4) | "{provider} didn't respond in time. Your heuristic pre-check is above — you can try again or switch providers." Heuristic result stays visible. | 1 automatic retry with same request **only if** elapsed time was <50% of timeout (suggests transient blip, not genuine overload); otherwise surface immediately |
| HTTP 429 (rate limited) | status code | "{provider} rate-limited this request. Free tiers reset over time — try again shortly, or switch providers in Settings." | no auto-retry (respect rate limit; auto-retrying into a 429 is bad citizenship on someone else's free tier) |
| HTTP 5xx | status code | "{provider} is having trouble on their end right now." | 1 automatic retry with exponential-ish backoff (~1.5s) — transient 5xx is common and worth one retry |
| Malformed JSON from model | `tolerantParse` throws | Attempt repair (below) | 1 repair retry, then fall through to heuristic-only result with `confidence:"low"` and a note: "The AI's response couldn't be read reliably — showing rule-based check only." |
| Schema mismatch (valid JSON, wrong shape) | `schema.validate` fails | Same repair path as malformed JSON | 1 repair retry |
| Vision unsupported by chosen model | capability flag check before building request | Vision toggle auto-disabled in UI with tooltip; analysis proceeds text-only, `visionAnalysis.skippedReason` set | n/a, not an error — expected path |
| Vision image fetch fails (per-image) | fetch throws / non-200 | Skip that image, continue with remaining | none |
| OpenRouter model rotation (pinned `:free` model disappears) | HTTP 400/404 "model not found" | "The free model ScamGuard uses on OpenRouter isn't available right now. Try 'openrouter/free' (experimental) in Settings, or switch providers." | none automatic — surfaces to user because silently substituting a different model changes analysis quality unpredictably |
| Non-listing page (e.g. user clicks icon on OLX homepage) | `extractionConfidence:"low"` + <2 required fields found, checked **before** any LLM call | Popup shows `NoListing` state immediately — never spends a network call analyzing a homepage | n/a |
| Service worker restarted mid-analysis | popup reconnects, checks `chrome.storage.session` for `status:"analyzing"` with a timestamp older than `timeoutMs + 5s` | Popup shows "Analysis may have been interrupted — try again" rather than hanging forever | n/a — this is why state is persisted *before* the fetch (§0.6) |
| Repair retry also fails | second parse/validate failure | Fall through to heuristic-only result, same as malformed-JSON terminal case above | none further — don't loop |
| Message & Payment Check: no matched patterns, no provider configured | pattern-match returns empty, `ProviderSettings.apiKey` empty | `NoRedFlagsFound` verdict shown alongside the `coreFact` (§4.7) regardless — the fact renders even when nothing else does | n/a |
| Message & Payment Check: LLM pass fails/times out | same failure modes as the main flow | Pattern-match result + `coreFact` render as final; a small note: "AI review unavailable right now — showing pattern-match result only." | none — this path is additive polish per §4.7, not required for a usable result |

**Repair-retry prompt** (used for the single allowed repair attempt): re-send the *original*
system+user prompt with an appended line: `"Your previous response was not valid JSON matching
the required schema. Respond with ONLY the corrected JSON object, nothing else."` — sent as a
fresh single-turn request (not a multi-turn conversation, to keep token usage minimal on free
tiers), with `max_tokens` unchanged.

---

## 7. SECURITY & PRIVACY

### 7.1 Key storage rules

- API keys live **only** in `chrome.storage.local`, **never** `chrome.storage.sync` (source doc
  §6 already specifies this correctly — sync storage round-trips through the user's Google
  account and is explicitly wrong for secrets).
- Keys are never logged via `console.log`/`console.error` anywhere in the codebase — enforce via
  a lint rule (custom ESLint rule or a simple pre-commit grep for the string `apiKey` inside
  `console.*` calls) rather than relying on developer discipline alone.
- The options-page key input is `type="password"` with a visibility-toggle button, not
  plaintext by default.
- A "Clear key" button in options wipes `chrome.storage.local` for that provider's settings
  entry entirely (not just blanks the field) — satisfies "clear-key button" in source doc §4.1.

### 7.2 What bytes cross the network, and to whom

Exactly three categories of outbound request exist, all initiated from the service worker:
1. **To the user's chosen LLM provider**: listing text (title/description/price/seller
   signals), heuristic signal summary, and (if vision enabled) downscaled/EXIF-stripped listing
   photos. The API key goes in that request's auth header. **Nothing else ever leaves the
   device** — no analytics ping, no telemetry, no ScamGuard-operated server (there isn't one).
2. **To the marketplace's own CDN**, when fetching full-resolution images for the vision
   downscale step (§4.3) — this is the same image the user is already viewing on the page, just
   fetched again in the SW context to process it; no new data exposure beyond what the page
   already loaded.
3. **To the user's chosen LLM provider again, for Message & Payment Check (§4.7)** — only ever
   the text the user explicitly pasted or the guided-flow answers they explicitly selected, plus
   the pattern-match id's already computed locally. No chat app, no clipboard, no page content is
   ever read automatically for this feature — it activates only on the user's deliberate paste/
   input action, same "nothing without a click" posture as §7.3's manifest notes and
   `PLAN-FRONTEND.md` §5's "no page scanning unless user clicks."

No other network destination exists. This is the entire trust story and should be stated
plainly in both the privacy policy and the options-page copy (§7.3, and PLAN-FRONTEND.md §4/§7).

### 7.3 Chrome Web Store compliance (August 2026 policy — see §0.5)

Given the confirmed-live policy update, and a same-day (2026-08-12) cross-check of independent
developer-facing coverage of it: reviewers are now specifically flagging vague category labels
like "usage data" and expect the Privacy tab to **name the actual data categories** (e.g.
"website content," "user activity" tied to a specific described use) rather than a generic blanket
term — this is a stricter reading than the July 1 announcement's own wording implies on its own,
so the listing copy below is written to the stricter bar:
- The store listing's "Privacy practices" tab must declare exactly what's collected, using named
  categories rather than a generic label: **(a) "Website content" — the listing content of the
  page the user is actively viewing, sent to a third-party AI provider the user has configured,
  for the disclosed purpose of scam-risk analysis; (b) "User activity" — text the user explicitly
  pastes or selects into the Message & Payment Check feature (§4.7), sent to the same
  user-configured provider for the same disclosed purpose.** Both are "necessary to the disclosed
  single purpose" and both should be named specifically, not folded into one vague line.
- The **user's API key is not "user data" collected by ScamGuard's developers** in the sense the
  policy targets (ScamGuard's developers never receive it — it only ever travels
  device→provider) — but it must still be disclosed as data the *extension* handles locally,
  with plain language: "Your API key is stored only on your device and is sent only to the AI
  provider you choose. ScamGuard's developers never see it or receive any data from your use of
  the extension."
- Because there genuinely is no ScamGuard-operated backend, the disclosure is unusually simple
  to write honestly — lean into that as differentiation (matches source doc §2.5 positioning).
- `host_permissions` in the manifest must be scoped to exactly: `olx.in`/`www.olx.in`,
  `quikr.com`/`www.quikr.com`, and the specific provider API hostnames the user could select
  (not a wildcard) — reviewers cross-check permissions against the privacy tab (confirmed via
  research, §0.5) and unexplained broad permissions are a common rejection cause.
- **Not applicable but worth a one-line note for future reviewers:** the same policy round
  separately bans extensions designed to bypass AI-service safety guardrails and extensions
  enabling real-money predictive-market betting — neither applies to ScamGuard (it consumes
  provider APIs normally and facilitates no wagering), but it's worth stating this explicitly in
  developer-facing docs so a future contributor doesn't need to re-research it.
- Re-verify this section against `developer.chrome.com/docs/webstore/program-policies/policies`
  immediately before submission — policy pages are explicitly noted (by Google's own blog post)
  as subject to continued updates.

### 7.4 CSP implications

MV3's default extension CSP already forbids remote code execution and `eval`; ScamGuard's build
must not introduce a custom `content_security_policy.extension_pages` override that loosens
this. No inline `<script>` in the popup/options HTML — all JS in separate files, referenced by
`<script src>`, consistent with source doc §6.

---

## 8. FILE PLAN

```
src/
  background/
    service-worker.js        // message router; orchestrates the flow in §1.1; owns
                              // chrome.storage.session lifecycle for in-flight state
  llm/
    providers/
      gemini.js               // ProviderAdapter impl, §3.2 row 1
      groq.js                 // §3.2 row 2
      cerebras.js              // §3.2 row 3
      openrouter.js            // §3.2 row 4
      mistral.js                // §3.2 row 5
      deepseek.js               // §3.2 row 6
      openai.js                  // §3.2 row 7
      anthropic.js                // §3.2 row 8
      ollama.js                    // §3.2 row 9
      custom.js                     // §3.2 row 10
      registry.js               // exports { get(id) -> ProviderAdapter, list() }
    prompt.js                  // exports buildSystemPrompt(), buildUserPrompt(listing,
                                // heuristics), buildRepairPrompt(original)
    parse.js                    // exports tolerantParse(rawText) -> object | throws
                                 // (strips markdown fences, finds first/last brace, etc.)
    schema.js                    // exports the schema from §4.5, validate(obj) -> {valid, errors}
    vision.js                     // exports buildImageParts(images, provider) — downscale,
                                   // EXIF-strip (§4.3), returns provider-shaped parts
  heuristics/
    price-table.json             // local category → typical INR range table (§5.1)
    signals.js                    // exports run(listing) -> HeuristicSignals (§2.2, §5.1)
    language-patterns.js           // exports the phrase lists for urgency/advance-fee/
                                    // off-platform-payment matching, kept separate from
                                    // signals.js so they're independently testable/extendable
  payment-check/
    payment-scam-patterns.js       // exports the phrase/regex lists for the 6 pattern ids in
                                    // §4.7, kept separate from language-patterns.js above since
                                    // they serve a different flow with different false-positive
                                    // tolerance (§4.7's "favor false positives" note)
    match.js                       // exports match(input: PaymentCheckInput) -> matched
                                    // patterns + verdict, pure sync function, zero network (§4.7)
    prompt.js                      // exports the dedicated short system prompt for the optional
                                    // LLM nuance pass (§4.7) — intentionally separate from
                                    // llm/prompt.js's listing-analysis prompt
  scoring/
    fuse.js                        // exports fuse(heuristics, llmVerdict) -> {score, verdict}
                                    // per §5.2-5.3
  storage/
    settings.js                     // get/set ProviderSettings (§2.4) in chrome.storage.local
    history.js                       // get/set/list RiskReport history, capped at N entries
                                      // (N configurable, default 50) with oldest-eviction
    session.js                        // thin wrapper over chrome.storage.session for the
                                       // in-flight-analysis state described in §0.6/§6
  shared/
    types.js                          // JSDoc typedefs for §2's interfaces (plain JS project
                                       // per build-tooling decision in PLAN-FRONTEND.md — typed
                                       // via JSDoc + a `tsc --checkJs` CI step rather than a
                                       // full TypeScript build, keeping the shipped bundle
                                       // dependency-free; alternative considered: full TS with
                                       // esbuild — rejected for v1 to minimize build complexity
                                       // for a solo-maintained portfolio project, revisit if
                                       // the codebase grows past this session's scope)
    constants.js                       // reporting resources (1930, cybercrime.gov.in),
                                        // verdict band thresholds (§5.3)
```

---

## 9. TEST PLAN

### 9.1 Framework

`node:test` (built into Node, zero extra dependency — appropriate for a "lightweight,
professional" bar without adding a test-runner dependency) with `fetch` mocked via a small
manual stub module (`test/mocks/fetch-mock.js`) rather than a heavier mocking library.

### 9.2 Fixture cases (write these first, then build providers/scoring against them)

| Fixture | Setup | Expected outcome |
|---|---|---|
| `scammy-listing.json` | Low price (ratio 0.3), 0 photos, new seller (1 item), description contains "pay advance via UPI, urgent sale today only" | heuristicScore ≥ 70 alone; after mocked-LLM fusion, verdict = High-Risk; `ADVANCE_FEE_REQUEST` or `OFF_PLATFORM_PAYMENT_ONLY` present → escalation floor applies (§5.3) |
| `legit-listing.json` | Market-typical price, 5 photos, seller with 40 items listed since 2019, plain description | heuristicScore ≤ 15; fused verdict = Safe |
| `ambiguous-listing.json` | Slightly-low price only, no other flags | verdict = Review, tests that a single weak signal doesn't over-trigger |
| `provider-500.test.js` | mock fetch → 500 | expect 1 retry, then error-matrix behavior from §6 |
| `provider-429.test.js` | mock fetch → 429 | expect NO retry (§6), correct user-facing message returned |
| `provider-timeout.test.js` | mock fetch → never resolves, use fake timers | expect timeout at configured `timeoutMs`, correct message |
| `malformed-json.test.js` | mock fetch → 200 with `"here's your analysis: {broken`  | expect repair-retry triggered once, then heuristic-only fallback if repair also fails |
| `no-vision-model.test.js` | provider preset with `visionCapableModels: []`, `visionEnabled:true` in settings | expect vision silently skipped, `visionAnalysis.skippedReason` set, text analysis still runs |
| `openrouter-model-gone.test.js` | mock fetch → 404 "model not found" | expect the specific OpenRouter-rotation message from §6, not a generic error |
| `not-a-listing.test.js` | mock LLM returns `{notAListing:true, ...}` | expect popup-state contract returns a distinct `NoAnalysis` result, not a 0-score RiskReport |
| `extractor.olx.test.js` (jsdom) | HTML fixture captured from a real OLX listing page (see PLAN-FRONTEND.md §10 for exact capture instructions) | extractor recovers title/price/description/adId with `extractionConfidence:"high"`; a *degraded* fixture (fields removed) recovers partial data with `extractionConfidence:"partial"` and never throws |
| `payment-check.scan-to-receive.test.js` | pasted text: "buyer said just scan this QR to get the payment" | `match()` returns `SCAN_TO_RECEIVE`, verdict `LikelyScam`, `coreFact` populated, zero network calls made |
| `payment-check.warning-to-others.test.js` | pasted text: a user warning a friend, e.g. "someone tried to get me to scan a QR to receive money, don't fall for it" | LLM-nuance pass (mocked) softens the pattern-match verdict since the text describes a scam rather than being part of one — tests §4.7's explicit "never flag someone warning others" case |
| `payment-check.no-provider.test.js` | pattern matched, `ProviderSettings.apiKey` empty | `LikelyScam` verdict + `coreFact` still render fully with no network call attempted |
| `payment-check.clean-text.test.js` | pasted text: ordinary negotiation, no patterns present | `NoRedFlagsFound`, `coreFact` still populated (§4.7's "always populated" rule) |
| `extractor.quikr.test.js` (jsdom) | HTML fixture from a real Quikr listing page | same shape of assertions; Quikr-specific field absence (e.g. no "items listed" count) must not crash extraction, must produce `null` not a thrown error |

### 9.3 CI wiring

GitHub Actions workflow (`.github/workflows/ci.yml`): on push/PR — `npm ci` → `npm run lint` →
`npm test` → (if `tsc --checkJs` is adopted per §8's shared/types.js note) `npm run typecheck`.
No build/publish step in CI for v1 (manual store upload is fine at this scale) — automating
Chrome Web Store publishing is explicitly out of scope, keep CI focused on correctness gates.

---

## 10. RESEARCH SOURCES (verified 2026-08-11, this session)

- **Real-world OLX/Quikr fraud patterns (2026-08-12 pass, the source for §-1 and §4.7)** —
  tech.olx.in's own published fraud-prevention writeup (confirming advance-payment fraud as OLX's
  own named top pattern), multiple independent 2026-dated consumer/fintech explainers (razorpay.com,
  jupiter.money, scantotal.net, scamdekho.in, authbridge.com, tribuneindia.com, fakeout.io) that
  independently converge on the QR-"scan to receive"/UPI-collect-request pattern as the dominant
  OLX/Quikr-specific fraud mechanic in 2025-2026, plus direct incident reporting (deccanherald.com,
  multiple dated cases) and a state-police advisory page (warangalpolice.telangana.gov.in) — this
  is the strongest-converging finding across the widest source spread of anything in this document,
  which is why §-1 treats it as near-certain rather than "medium confidence."
- Groq rate limits — console.groq.com/docs/rate-limits (official); cross-checked against
  independent trackers (grizzlypeaksoftware.com, tokenmix.ai, pricepertoken.com,
  costbench.com) which showed conflicting RPD figures — official docs and the majority-converging
  30 RPM/~1,000 RPD/~6,000 TPM figure were used; product must read live rate-limit response
  headers rather than hardcode (§0.1). Re-confirmed in the 2026-08-12 pass against four additional
  independent trackers, all converging on the same 30 RPM / ~1,000 RPD baseline (some report the
  older 14,400 RPD figure as still appearing on select legacy small models) — no change to §0.1's
  guidance.
- Cerebras free tier — cloud.cerebras.ai product docs via pricepertoken.com, tokenmix.ai,
  costbench.com, getaiperks.com, free-llm.com (converging on 1M tokens/day, 30 RPM, ~8,192 token
  free-tier context cap).
- Gemini structured output — ai.google.dev/gemini-api/docs/generate-content/structured-output
  (official, legacy `generateContent` endpoint) and ai.google.dev/gemini-api/docs/interactions/
  structured-output (official, new Interactions API) — both confirmed live and documented.
- OpenRouter — openrouter.ai/docs/guides/features/structured-outputs (official),
  openrouter.ai/openrouter (official `openrouter/free` router description), plus independent
  integration guidance (helloandy.net, buldrr.com) on the router's real-world reliability
  caveats.
- Chrome Web Store policy — developer.chrome.com/blog/cws-policy-updates-2026 (official,
  2026-07-01) and developer.chrome.com/docs/webstore/program-policies/policies (official),
  cross-checked against independent coverage (makeuseof.com, superchargebrowser.com,
  extensionfast.com) — all converge on the August 1, 2026 enforcement date.
- Manifest V3 service-worker lifecycle — developer.chrome.com/docs/extensions/develop/concepts/
  service-workers/lifecycle (official), cross-checked against chromium.org bug tracker
  discussion and independent MV3 migration guides for the fetch>30s termination behavior.
- OLX.in live page structure — direct `web_fetch` of a real OLX.in category page
  (www.olx.in/ambe-chowk_g5341606/tvs-video-audio_c1523) and a real individual listing page
  (www.olx.in/item/tvs-video-audio-c1523-mi-led-3239-smart-android-led-tv-in-haidarganj-lucknow-
  iid-1827354630) performed during this session, 2026-08-11 — confirmed URL pattern
  (`/item/<slug>-iid-<numeric>`), confirmed `og:title`/`og:description`/`og:image` meta tags,
  and confirmed rendered-text patterns for AD ID, "Posted by / Member since", "Items listed",
  and location breadcrumb. No public documentation of current `data-aut-id` attribute values
  was found — this is flagged as a build-time task for the developer using live DevTools
  inspection, not something safely hardcoded from search results (§2.1, §0 item — see also
  PLAN-FRONTEND.md §2 for the extractor implementation consequence).
- All provider free-tier claims in `SCAMGUARD_PROJECT.md` §5 were treated as MEDIUM-confidence
  per that document's own §9 confidence note, and re-verified in this session; §0 above documents
  every correction found.
