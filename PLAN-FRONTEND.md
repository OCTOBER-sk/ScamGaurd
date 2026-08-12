# PLAN-FRONTEND.md — ScamGuard "Face" (UI/UX + extension shell)

> Companion to `PLAN-BACKEND.md`. Everything here consumes the data contracts, provider
> registry, and error-handling matrix defined there — this doc does not redefine them, it wires
> them to pixels. Grounded in `SCAMGUARD_PROJECT.md` + the 2026-08-11 research pass (OLX.in
> live-page inspection, Chrome Web Store policy update, MV3 service-worker lifecycle), plus a
> 2026-08-12 pass focused on real Indian OLX/Quikr fraud reports, which added one new feature
> surface (§2.10, "Check a message or payment step") to cover the QR-code / UPI-collect-request
> scam pattern that backend §-1 identified as the dominant real-world fraud mechanic — one this
> plan's original popup-only, listing-page-only surface could never reach on its own, since that
> scam runs entirely in chat, after the listing has already been judged Safe. Where a decision
> here has a backend-side consequence, it says so and points back with `§`.

---

## 0. WHAT THIS FILE OWNS VS. WHAT IT DOESN'T

Owns: popup UI, options page, content-script *presentation* concerns (badge/toast, not
extraction logic), design tokens, copy/microcopy, all eight listing-report UI states (§2.2–2.8)
plus the standalone Message & Payment Check surface (§2.10), history/export UI, accessibility,
i18n scaffolding, manifest.json, build tooling, store-listing assets.

Does not own (see `PLAN-BACKEND.md` instead): extraction logic (§2.1/§8 there), provider
adapters (§3), prompt engineering (§4), scoring (§5), payment-scam pattern-matching logic (§4.7 —
this doc only owns how a `PaymentCheckReport` is *displayed*, same division as the listing flow),
error *classification* (§6 — this doc only owns how each classified error is *displayed*),
storage schema (§2.4, §8).

---

## 1. DESIGN SYSTEM

### 1.1 Why not the default AI-generated look

Per the frontend-design discipline: a warm-cream/terracotta palette or a near-black/acid-accent
palette are both defaults that show up regardless of subject matter. ScamGuard's subject is
Indian classifieds — physical goods, street-level trust, money changing hands informally. The
design should feel like a **trustworthy inspection stamp**, not a generic SaaS dashboard or a
security-vendor black-and-red panic palette (which would work against the "calm, factual, not
alarmist" tone mandated in the system prompt, `PLAN-BACKEND.md` §4.1).

**Signature element:** a **verdict seal** — a circular badge (think: a rubber ink stamp / hallmark
mark, evoking the "verified" stamps used on Indian legal and financial documents) that renders
the score and verdict band. It appears at three scales: small (16×16 toolbar badge, simplified to
a dot+ring), medium (popup header, ~72px), large (share-card export, ~200px). This single motif
is the "one thing to remember ScamGuard by" — everything else stays quiet around it.

### 1.2 Palette

| Token | Hex | Role |
|---|---|---|
| `--sg-ink` | `#1C1B1A` | Primary text, near-black but warm (not pure `#000`) |
| `--sg-paper` | `#FAF8F4` | Popup background — warm off-white, paper/document feel, not clinical white |
| `--sg-paper-raised` | `#FFFFFF` | Cards/panels on top of paper background |
| `--sg-brass` | `#9C7A3C` | Primary brand accent — a muted brass/seal-ink tone, used for the stamp ring, links, primary buttons. Distinct from both terracotta-default and acid-green-default. |
| `--sg-safe` | `#3F7D5C` | Verdict: Safe (muted forest green, not neon) |
| `--sg-review` | `#B5892C` | Verdict: Review (amber-brass, close to brand accent — "review" is a shade of the brand, not a separate alert color) |
| `--sg-suspicious` | `#C1602B` | Verdict: Suspicious (burnt orange) |
| `--sg-high-risk` | `#A3312A` | Verdict: High-Risk (deep brick red, not pure alarm-red — stays in the same muted, "inked" family as the rest of the palette) |
| `--sg-line` | `#E4DFD5` | Hairline dividers, input borders |
| `--sg-muted` | `#6B665D` | Secondary text |

Rationale: all five semantic colors sit in the same desaturated, warm-toned family (nothing
neon, nothing pure-hue) so the verdict seal always looks like it belongs to the same object —
only its ink color changes, like a stamp re-inked in a different color, not a different UI
component swapped in. This directly supports the "calm and factual, no alarmism" requirement.

**Contrast check (WCAG AA, §6.6):** `--sg-ink` on `--sg-paper` = 15.1:1. All four verdict colors
on `--sg-paper-raised` (`#FFFFFF`) checked ≥ 4.5:1 for the 14px verdict label text; `--sg-high-risk`
on white = 6.2:1, `--sg-review` on white = 4.6:1 (the tightest — do not lighten `--sg-review`
further without re-checking).

### 1.3 Typography

| Role | Face | Notes |
|---|---|---|
| Display (verdict word, score number) | **Fraunces** (variable, use `opsz` axis at high optical size for the score number) | A serif with ink-trap-like detailing that echoes stamped/engraved document type — reinforces the "seal" motif without going full ornamental. Loaded as a self-hosted static-weight subset (600, 700) to stay inside the <1.5MB budget (§4.2 project doc) — do NOT load the full variable font or pull from Google Fonts CDN at runtime (CSP + privacy: no third-party script/font requests, §7.4 backend plan). |
| Body / UI | **Inter** (self-hosted, weights 400/500/600) | Neutral, high-legibility workhorse for descriptions, checklist items, settings forms. Deliberately *not* paired with another display-personality face — the seal motif and Fraunces already carry the identity; body text should get out of the way. |
| Data/mono (raw JSON accordion, ad ID, scores in compact contexts) | **JetBrains Mono** or system `ui-monospace` stack | Only for the "raw data" accordion (§2.7) and price/ID figures where tabular alignment matters. |

Font budget: Inter + Fraunces static subsets (Latin only, the four weights above) ≈ 60–90KB
woff2 combined — checked against the <1.5MB total install budget; do not add a fifth weight or
italic cuts without re-checking the budget in §8.4.

### 1.4 Layout concept (popup, ASCII)

```
┌─────────────────────────────────┐  360×large-min-height (see §2.1)
│ ScamGuard  [Check a message] [⚙]  │  header, 40px — §2.10 entry point lives here
│───────────────────────────────── │
│                                    │
│        ◉ 72px verdict seal        │  score + verdict band, centered
│         "Suspicious"               │  Fraunces, --sg-suspicious
│         62 / 100                    │
│                                       │
│  ⚡ Heuristic pre-check (instant)      │  shown BEFORE llm returns — §2.3
│  ▸ Price 55% below typical             │
│  ▸ New seller (1 item listed)           │
│                                           │
│  🤖 AI analysis                           │  streams in after fetch resolves
│  Red flags (3)                             │
│   ● HIGH  Off-platform payment requested    │
│   ● MED   Urgency language                   │
│   ● LOW   Low photo count                      │
│                                                   │
│  Summary: 2-4 sentence calm explanation           │
│                                                     │
│  ✓ Safe-buying checklist (5 items)                │  collapsed by default
│  ⚠ Report this: 1930 · cybercrime.gov.in           │  shown only if Suspicious+
│                                                       │
│  [Copy report]  [Export card]  [View raw data ▾]      │
│───────────────────────────────────────────────────── │
│  💬 About to pay or get paid? Check the message →     │  §2.10 contextual nudge, ALL verdicts
│───────────────────────────────────────────────────── │
│  History (last 5)                    [See all →]      │
└─────────────────────────────────────────────────────┘
```

One-sentence layout description: a vertically stacked single-column popup, seal-and-score as the
unmistakable focal point at top, heuristic results appearing instantly and AI results streaming
in beneath without reflowing what's already visible (heuristic block never moves once painted).

**Why the §2.10 nudge appears on every verdict, including Safe:** the QR/payment-scam pattern
(backend §-1) is run against normal-looking, well-priced, established-seller listings precisely
*because* the fraudster needs a real transaction to attach to — a Safe verdict on the listing
says nothing about what happens in the chat that follows. Hiding this row on Safe verdicts would
imply the opposite, so it is the one UI element that intentionally does not vary with the verdict
band — same treatment (`--sg-muted` text, `--sg-brass` icon/link) regardless of score, positioned
as a standing utility rather than a warning tied to this specific listing.

### 1.5 Motion

Minimal, purposeful only:
- Verdict seal: a single **stamp-down** micro-animation (120ms scale 1.08→1.0 + slight rotation
  settle, ease-out) the *first* time a report renders — evokes a physical stamp landing.
  Respect `prefers-reduced-motion`: skip entirely, seal just appears.
- Heuristic-to-AI transition: the "AI analysis" section fades+slides in (150ms) when the LLM
  response arrives — no skeleton shimmer (shimmer reads as "loading forever" on a fast product;
  use a static "Analyzing with {provider}…" label with a simple 3-dot pulse instead, see §2.3).
- No page-load choreography, no hover-tilt effects, no confetti on Safe verdicts (would undercut
  the calm/factual tone). This is a deliberate restraint choice, not an oversight.

---

## 2. POPUP — STATE MACHINE

The popup is a single `popup.html` that renders one of eight mutually exclusive states, driven
by messages from the service worker (`PLAN-BACKEND.md` §1.1, §6). State is derived, never
independently tracked — the popup asks `chrome.storage.session` + sends `GET_STATE` on open
rather than assuming continuity, because MV3 popups are destroyed on every close (no persistent
state of their own is possible or should be relied on).

### 2.1 Popup shell constraints

- Fixed width **360px** (Chrome's comfortable popup max before it looks stretched at typical
  display DPI), height auto up to **600px** max with internal scroll beyond that — never taller,
  to avoid the popup being clipped off-screen on small laptop displays.
  Opens in <100ms (§4.2 project doc) — this means the shell HTML/CSS must paint *before* any
  message round-trip to the service worker; skeleton/idle state (§2.2) is the very first paint.

### 2.2 State: `Idle` (popup opens, before any GET_LISTING response)

First paint, zero network/message dependency. Shows the ScamGuard header, seal placeholder
(outline only, no fill/color yet), and the text "Checking this page…". This state should be on
screen for well under 100ms in the common case — it exists so the popup never shows a blank
white flash.

### 2.3 State: `Analyzing` (heuristics done, LLM call in flight)

- Heuristic block renders **immediately and fully** the moment `heuristics.run()` resolves
  (backend §1.1 step 1–2) — this is the sub-1s requirement made visible. It is real content, not
  a placeholder: actual triggered/not-triggered rows with real heuristic score contribution.
- Below it, a quiet "🤖 Analyzing with {provider label}…" row with a 3-dot pulse (CSS-only,
  `prefers-reduced-motion`-safe by freezing the pulse to a static "…" when that media query is
  set).
- If elapsed time exceeds the provider's `timeoutMs` (`PLAN-BACKEND.md` §4.4) minus 1s, the pulse
  row's copy changes to "Still working — {provider} can be slow on free tiers" so the user isn't
  left wondering if it's frozen, without the popup needing to know provider internals beyond the
  label + configured timeout it already has.

### 2.4 State: `Report` (fused RiskReport received)

Full layout per §1.4. Verdict seal color/label driven by `RiskReport.verdict` (backend §2.3, §5.3
bands) — **the frontend never recomputes a band from the score**, it renders exactly what the
backend decided, so there is one source of truth for the score→verdict mapping.

Sub-sections:
- **Red flags list**: sorted `high → medium → low`, each row shows a colored dot (verdict-palette
  severity color, reusing `--sg-suspicious`/`--sg-high-risk` etc. is wrong here — severity needs
  its *own* 3-step scale distinct from the 4-step verdict scale, see §1.6 addendum below) +
  label + a chevron to expand the 1–2 sentence explanation inline (accordion per-row, not a
  separate screen).
- **Summary**: plain paragraph, no truncation — this is the LLM's calm explanation and is short
  by prompt design (2–4 sentences, backend §4.1).
- **Checklist**: collapsed by default behind "✓ Safe-buying checklist (N items) ▾" — expands to
  a plain `<ul>`. Collapsed by default because P1/P3 users (project doc §3) mostly want the
  verdict first; power users expand for the full list.
- **Reporting resources**: only rendered when `RiskReport.verdict` is `"Suspicious"` or
  `"High-Risk"` (backend §5.3) — showing "call 1930" on a Safe listing would undercut trust in
  the tool's calibration. Rendered as tappable rows (`tel:1930`, link to cybercrime.gov.in).
- **Vision notes**: only rendered if `visionAnalysis.performed === true` — otherwise omitted
  entirely (not shown-but-empty), to avoid clutter for text-only providers.
- **Actions row**: Copy report (plain text, §2.8), Export card (PNG, §2.8), View raw data
  (accordion revealing the `Listing` object in mono font, for power users/debugging — labeled
  plainly "Raw extracted data" not "Debug" to stay approachable).

**1.6 addendum — severity scale (distinct from verdict scale):**

| Severity | Color | Note |
|---|---|---|
| low | `--sg-muted` (grey, not a color at all) | deliberately desaturated — a "low" flag next to a "high" flag must not compete visually |
| medium | `--sg-review` (reused) | |
| high | `--sg-high-risk` (reused) | |

Only two of the three severity levels reuse verdict colors; "low" intentionally breaks the
pattern by going grey, because a low-severity single flag next to a high-severity one needs an
unambiguous visual hierarchy, not four colors competing at similar visual weight.

### 2.5 State: `NoAnalysis` (LLM returned `notAListing: true`, backend §5.2)

Distinct from an error — the tool worked correctly and determined this isn't a listing page.
Copy: "This doesn't look like a listing page. ScamGuard works on individual OLX or Quikr listing
pages — try opening a specific item." No seal, no score, a simple outline icon (magnifying
glass over a blank page). Still shows the "History" footer so the popup isn't a dead end.

### 2.6 State: `NoListing` (extraction confidence too low, backend §6 row, checked pre-fetch)

Same visual treatment as `NoAnalysis` but different copy, since this is a *scraping* failure not
an LLM judgment: "Couldn't read this page reliably. If you're on an OLX or Quikr listing, try
refreshing — otherwise this page may not be a listing ScamGuard recognizes yet."
This state must render **before any network call fires** (backend §6 row "Non-listing page"),
which the popup enforces by checking `extractionConfidence` in the message from the content
script before ever asking the service worker to analyze.

### 2.7 State: `Error` (any row from backend §6's error matrix except the two above)

One shared error-state component, parameterized by the exact user-facing message string the
service worker already computed (backend §6 column 3 — **the frontend does not author error
copy per error type; it renders what the backend sends**, so the two docs never drift out of
sync on wording). Layout: heuristic block **stays visible** (per backend §6, several rows
explicitly note "heuristic result stays visible") + an inline error card below it with the
message + a contextual action button (`Open Settings` for key errors, `Try again` for
timeout/5xx, `Switch provider` link for OpenRouter rotation). Never a full-screen takeover —
the user's instant heuristic signal is never taken away by a downstream failure.

### 2.8 State: `NoKey` (first run / key cleared)

Friendliest of the states, since this is the expected first-run experience, not a failure.
Shows the seal outline in a neutral "not yet configured" grey, headline "Connect a free AI
provider to get started," a one-line explainer ("ScamGuard uses your own API key — free tiers
from Groq or Cerebras work great and cost nothing"), and a single primary button: `Choose a
provider →` opening the options page. Heuristic-only mode is *not* offered as a silent fallback
here (unlike mid-analysis provider failures) — first-run should actively guide setup rather than
let a new user think heuristics-only is the whole product.

### 2.9 Copy-as-text / Export-card implementation

- **Copy report**: builds a plain-text template client-side from the in-memory `RiskReport`
  (verdict, score, red flags, summary, checklist, resources) and calls `navigator.clipboard
  .writeText()` from the popup context (permitted; popup is a full extension page, not a content
  script). Button label flips to "Copied ✓" for 1.5s, then reverts — no toast/snackbar needed for
  a single-popup-width surface.
- **Export card**: renders the *large* verdict seal + score + top 2 red flags + "ScamGuard"
  wordmark onto an offscreen `<canvas>` sized 1080×1080 (share-friendly square), then
  `canvas.toBlob()` → download via a generated `<a download>` link. Built with plain Canvas 2D
  (no image-generation library needed, no network call) — the entire operation is local and
  instant, consistent with the zero-telemetry, zero-extra-network-destination story in backend
  §7.2. Card copy is deliberately minimal (score + verdict + top flags) since it's meant to be
  legible as a small shared thumbnail, not a full report.

### 2.10 Feature: "Check a message or payment step" (backend §-1, §4.7, §2.5)

This is a **second, independent surface**, not a ninth popup state layered onto the listing-report
state machine — it has its own small view, reachable two ways:

1. **Standalone**, via the `[Check a message]` header button (§1.4 layout) — available from any
   popup state, including `Idle`/`NoKey`/`NoListing`, because the moment someone needs this has
   nothing to do with whether they're currently looking at a listing ScamGuard could score. A
   user who gets a suspicious WhatsApp message while off OLX entirely should still be able to
   open the extension and check it.
2. **Contextually**, via the `💬 About to pay or get paid?` row (§1.4) on any `Report` state —
   pre-fills `listingContext` (backend §2.5) so the eventual `PaymentCheckReport` is understood
   to relate to that listing, without the user re-typing anything.

**Entry screen** — two input modes, presented as two big tappable options, not a form with a mode
toggle (the two modes serve different comfort levels, and hiding one behind a toggle means a
nervous, hurried user might not notice it exists):
- **"Paste the message"** — a single `<textarea>`, placeholder: "Paste what they sent you —
  chat, WhatsApp, or describe what they're asking you to do." No character limit surfaced in UI
  (backend truncates internally per its own budget rules, same posture as listing descriptions).
- **"Answer 3 quick questions instead"** — for a user who doesn't want to paste raw chat text
  (privacy-conscious, or the "message" was actually a phone call): three single-tap questions —
  *Are you buying or selling?* / *Did they ask you to scan a QR code or approve a payment
  request?* (Yes/No/Not sure) / *What did they say the code or request was for?* (short free-text,
  optional). Maps directly to `PaymentCheckInput.guidedAnswers` (backend §2.5).

Both paths submit to the same `PaymentCheckReport` result view. This mirrors the existing
heuristic-then-AI shape (§2.3) but compressed: the **pattern-match result and `coreFact` render
instantly** (backend §4.7 — zero network, same sub-1s bar as §5.1's heuristics), then an "AI
review" row optionally refines the summary a moment later, never blocking the instant result.

**Result view layout:**

```
┌─────────────────────────────────┐
│ ← Back            Message check  │  header, distinct from listing-report header —
│───────────────────────────────── │  no verdict seal here (§ below explains why)
│                                    │
│  ⚠ This looks like a common scam  │  verdict line, plain text + icon, NOT the seal motif
│    pattern                          │
│                                       │
│  "A QR code or payment request can    │  coreFact, ALWAYS shown, own quiet card,
│   only ever be used to send money,     │  --sg-paper-raised background, present even
│   never to receive it. If anyone       │  if everything below fails to load
│   asks you to scan something or        │
│   enter your PIN to 'receive' a         │
│   payment, that's always false."         │
│                                             │
│  Matched: Scan-to-receive framing            │  pattern label(s), from §4.7's 6 pattern ids
│                                                 │
│  AI review: [pulse] Reviewing for context…       │  optional, non-blocking, §4.7
│                                                     │
│  [Copy this to show someone]  [Call 1930]           │
└─────────────────────────────────────────────────────┘
```

**Deliberate design choice — no verdict seal on this screen:** the seal motif (§1.1) is
specifically the listing-analysis signature; reusing it here would visually claim the same kind
of graded, numeric confidence (`62/100`) that this feature does not produce (backend §2.5's
3-band, non-numeric verdict is a deliberate departure from the 4-band scored verdict, precisely
to avoid implying false precision on a pattern-match check). Using a plain warning-icon-plus-text
treatment instead keeps the visual vocabulary honest about what kind of judgment this is.

**Colors:** `LikelyScam` uses `--sg-high-risk`, `Caution` uses `--sg-review`, `NoRedFlagsFound`
uses `--sg-safe` — reusing the existing verdict palette (§1.2) is correct here (same underlying
"how worried should you be" semantic), even though the seal *shape* is deliberately not reused.

**The `coreFact` card never depends on the AI review resolving** — it renders from the
pattern-match result immediately, styled with slightly heavier visual weight than the rest of the
result (a 2px `--sg-brass` left border, per the "one thing that's always true regardless of
provider status" treatment) since backend §4.7 specifies it must reach the user even in a
total-LLM-failure state. This is the one piece of copy in the entire extension that is hardcoded
rather than routed through `t()`/`src/strings/en.json` at the LLM-output layer — it *is* still a
`t()` string (i18n scaffolding, §7, still applies to it as UI copy), the distinction is only that
it never originates from a network response.

**"Copy this to show someone" button:** builds a plain-text version of the `coreFact` + matched
pattern + a one-line "sent via ScamGuard" note — sized and worded for forwarding *to the person
being scammed*, e.g. a less tech-familiar parent or relative, which is a realistic real-world use
of this feature the option list is written to specifically support (distinct from `Copy report`
in §2.9, which is written as a record for the copier, not a message to forward).

---

## 3. OPTIONS PAGE

### 3.1 Sections (top to bottom, single scrollable page — no tabs, this is not a big enough
surface to need navigation chrome)

1. **Provider & API key** — dropdown of the ten `ProviderAdapter` ids (backend §3.2), rendered
   with their `label`, a masked `type="password"` key field with a visibility-toggle eye icon
   (backend §7.1), an optional "Model override" text input (placeholder shows the preset default,
   e.g. `gemini-2.5-flash`, with a small note "leave blank to use ScamGuard's default"), and a
   **Test connection** button that calls `testConnection` (backend §3.6) and renders one of its
   four outcome messages verbatim in a colored inline result row (green/success uses `--sg-safe`,
   the three failure cases use `--sg-review` — not `--sg-high-risk`; a rejected key during setup
   is a fixable configuration issue, not a scary event).
   - Below the key field: a static, unconditional trust statement (not collapsible, always
     visible): *"Your key is stored only on this device and sent only to {provider}. ScamGuard's
     developers never see it."* — `{provider}` interpolates the selected provider's label, so the
     statement is always concretely true for the current selection rather than a vague blanket
     claim (ties to backend §7.3's CWS-disclosure language — **this exact sentence pattern should
     also appear, word-for-word where practical, in the store listing's privacy tab**, so a
     reviewer or user sees consistent language in both places).
   - **Clear key** button (backend §7.1) — destructive, so it opens a small inline confirm ("Clear
     saved key for {provider}? This can't be undone.") rather than a modal (avoid modal-on-modal
     inside what's already a small settings surface); confirmed action wipes storage and resets
     the field, no page reload needed.
2. **Vision analysis** — a single toggle, auto-disabled (with an explanatory tooltip, not just
   greyed out silently) when the selected provider/model has no vision capability (backend §3.2
   `visionCapableModels`). Copy: "Analyze listing photos for AI-generation and stock-photo tells
   (uses more of your free-tier quota per check)."
3. **History** — shows count of saved reports, a "Clear history" destructive action (same
   inline-confirm pattern as above), and the retention note: "ScamGuard keeps your last {N}
   checks on this device. Nothing is ever uploaded." `{N}` reads live from the configurable cap
   (backend §8 `storage/history.js`, default 50) rather than being hardcoded copy.
4. **Advanced** — collapsed by default (`<details>`, no JS needed for the collapse itself):
   custom endpoint fields for `providerId === "custom"` (backend §3.5), and the `openrouter/free`
   auto-router opt-in (backend §0.4) explicitly labeled "Experimental — routing is unpredictable
   on this option" rather than presented as an equal peer to the pinned default.
5. **About** — version number, link to the open-source repo, MIT license note, and the same
   positioning line from `SCAMGUARD_PROJECT.md` §2.5 ("Your key, your data, your verdict…") since
   this is the natural place for the elevator pitch a curious user or reviewer reads once.

### 3.2 Provider picker UX detail

Rendered as a **card grid**, not a plain `<select>` — each provider gets a small card showing its
label, a one-line "why you'd pick this" note (e.g. Groq: "Fastest free tier"; Gemini: "Best
overall quality, built-in vision"; Cerebras: "Most generous free quota"), and whether it needs a
paid account (OpenAI/Anthropic cards get a small "no free tier" note per backend §3.2). This
matters because provider choice is the single most consequential decision a new user makes and a
bare dropdown of ten unfamiliar IDs (`cerebras`, `deepseek`...) gives no signal for a first-time
chooser — the cards exist specifically to make backend §3.2's table legible to a non-technical
P1/P3 user (project doc §3) without them needing to leave the extension to research providers.

---

## 4. ONBOARDING (first install)

Triggered via `chrome.runtime.onInstalled` (`reason === "install"`) opening the options page
directly, landing on Provider & API key (§3.1 item 1) pre-scrolled into view, with a one-time
dismissible banner above it: "Welcome to ScamGuard — pick a free AI provider below to get
started (takes about a minute)." No multi-step wizard/modal sequence — the options page *is* the
onboarding flow, since the alternative (a separate onboarding UI to build and maintain) adds
surface area without adding value for a settings page this short. This is also why the `NoKey`
popup state (§2.8) exists — a user who skips onboarding and clicks the toolbar icon directly
still gets guided to the same place.

---

## 5. CONTENT SCRIPT — PRESENTATION SURFACE

The content script's *extraction* logic belongs to `PLAN-BACKEND.md` §2.1/§8. Its presentation
responsibilities (this doc) are intentionally minimal:

- **No injected UI on the page itself** — no floating button, no overlay, no page-DOM
  modification of any kind. ScamGuard is popup-only. This keeps the content script's footprint
  and permission story minimal (project doc §4.2 "no page scanning unless user clicks") and
  avoids fighting OLX/Quikr's own React re-renders, which would be a maintenance burden given
  §2.1 backend's note that both sites use hashed/unstable class names.
- **Toolbar badge** (`chrome.action.setBadgeText`/`setBadgeBackgroundColor`) is the only always-on
  visual signal, and only ever reflects the *last completed report for the current tab* — a small
  colored dot using the verdict palette (§1.2) once a check has been run on that tab, cleared on
  navigation to a new URL. It is never set proactively/automatically (that would mean auto-
  scanning every page load, explicitly out of scope per project doc §4.3) — it only appears after
  the user has manually triggered a check via the popup.

---

## 6. ACCESSIBILITY

- All interactive elements reachable by keyboard in visual order; popup traps focus sensibly
  (Chrome popups already close on blur, so no custom focus-trap library needed — just correct
  tab order and no positive `tabindex` values).
- Verdict seal's color is never the *only* signal — the verdict word ("Suspicious") is always
  rendered as text at ≥14px next to/inside the seal, and severity dots (§2.4) are always paired
  with a text label ("HIGH"), satisfying color-blind-safe design without a separate
  color-blind mode.
- `aria-live="polite"` region wrapping the state-machine container (§2) so a screen-reader user
  hears "Analyzing…" then the report summary as it changes, without needing to manually
  re-navigate the popup.
- Focus visible: a 2px `--sg-brass` outline on every focusable element (buttons, the collapsed
  checklist `<summary>`, history items) — never `outline: none` without a replacement.
- `prefers-reduced-motion` handling per §1.5.
- Options-page form fields all have associated `<label>` elements (not just placeholder text) —
  password field included, since placeholder-as-label is a common and specifically-flagged
  accessibility antipattern.

---

## 7. i18n SCAFFOLDING (v1: English only, structure ready for Hindi/Tamil)

- All UI copy lives in `src/strings/en.json` as flat `key: value` pairs, referenced via a small
  `t(key, vars?)` helper (simple `{{var}}` interpolation, no ICU pluralization library needed for
  v1's copy volume — revisit only if Hindi/Tamil pluralization rules force the issue later).
- **Explicitly not translated in v1, and not placed in the strings file:** the LLM-authored
  `summary`/`redFlags[].explanation`/`checklistAdditions` fields — those come back in whatever
  language the system prompt is written in (English, backend §4.1) regardless of UI locale; true
  output localization would mean localizing the *system prompt* (a backend §4 concern, explicitly
  future work) not just the UI shell. Document this boundary in the README so it's not mistaken
  for a bug later.
- No hardcoded string concatenation anywhere in component code (e.g. never `"Connected — " +
  model + " responded"` inline) — always `t('providerTestSuccess', {model, ms})` — so adding a
  locale file later is additive, not a refactor.

---

## 8. MANIFEST, BUILD, AND STORE ASSETS

### 8.1 `manifest.json` shape

```jsonc
{
  "manifest_version": 3,
  "name": "ScamGuard",
  "short_name": "ScamGuard",
  "description": "Bring-your-own-key scam risk checker for OLX & Quikr listings.",
  "version": "1.0.0",
  "action": { "default_popup": "popup.html", "default_icon": { /* 16/32/48/128 */ } },
  "options_page": "options.html",
  "background": { "service_worker": "background/service-worker.js", "type": "module" },
  "content_scripts": [{
    "matches": ["*://*.olx.in/item/*", "*://*.quikr.com/*"],
    "js": ["content/extractor.js"],
    "run_at": "document_idle"
  }],
  "permissions": ["storage", "activeTab"],
  "host_permissions": [
    "https://www.olx.in/*", "https://www.quikr.com/*",
    "https://generativelanguage.googleapis.com/*", "https://api.groq.com/*",
    "https://api.cerebras.ai/*", "https://openrouter.ai/*", "https://api.mistral.ai/*",
    "https://api.deepseek.com/*", "https://api.openai.com/*", "https://api.anthropic.com/*",
    "http://localhost:11434/*"
  ],
  "icons": { /* 16/32/48/128 */ }
}
```

Notes tying back to backend research:
- `content_scripts.matches` is scoped to the listing-page URL pattern only
  (`/item/*-iid-*` in practice, confirmed live in backend §8.1/§2.1 research), **not** all of
  olx.in — the content script has no reason to run on search/category pages, which also reduces
  the store-review "why do you need this permission" surface (backend §7.3).
- `host_permissions` lists every provider host explicitly rather than a wildcard, per backend
  §7.3's confirmed CWS reviewer behavior of cross-checking permissions against the privacy tab —
  `localhost:11434` (Ollama) is included deliberately since it's a documented v1 provider
  (backend §3.2) and omitting it would silently break that preset.
- No `"host_permissions": ["<all_urls>"]` anywhere, ever (project doc §6 "never all sites").
- `run_at: "document_idle"` (not `document_start`) since extraction only needs to happen on
  user click, not at page load — reinforces the "no page scanning unless user clicks" NFR by not
  even parsing the DOM until asked (the content script's `GET_LISTING` handler runs its
  extraction logic on-demand, not on injection).
- **§2.10's Message & Payment Check needs no manifest changes.** It's a popup-only view (no
  content script, no page access) that reuses the exact same `host_permissions` provider list
  already declared for listing analysis, since it calls the same `ProviderAdapter` layer (backend
  §3) with the user's already-configured provider — worth stating explicitly so a future
  contributor doesn't reflexively add a permission for it.

### 8.2 Build tooling decision

**Decision: no-build vanilla ES modules for v1**, not esbuild/Vite/WXT.

Reasoning: the codebase is plain JS with JSDoc types (backend §8 `shared/types.js` decision,
already locked there) and browsers now support ES module imports natively in both content
scripts (`"type":"module"` background) and popup/options pages via `<script type="module">`.
Introducing a bundler adds a build step, a config file, and a dependency surface for a project
whose stated NFR is a **<1.5MB total install** — a bundler's main value (tree-shaking,
minification, dependency bundling) matters most when pulling in npm packages, and this project
deliberately has none in the shipped bundle (backend §8, `test/` deps are dev-only). The one
place bundling would help — minifying for size — is handled adequately by hand-keeping the
codebase small and shipping unminified-but-small vanilla JS; if the unminified size becomes a
real problem post-v1, revisit with esbuild specifically for minification only, not as a
dependency-bundler (this mirrors the same "revisit if it grows past this session's scope"
posture backend §8 already takes on TypeScript).

Consequence: `<script src="...">` tags in `popup.html`/`options.html` reference `.js` files
directly with `type="module"`; no `dist/` folder, no `npm run build` step before loading
"unpacked" in Chrome during development — load the `src/` (or a flat `extension/`) folder as-is.

### 8.3 Firefox-readiness (project doc §6 "Firefox-ready structure")

- All Chrome API calls go through a 15-line shim module (`src/shared/browser-api.js`) exporting
  `runtime`, `storage`, `action`, `scripting` objects that resolve to `chrome.*` when
  `typeof browser === "undefined"` and to the native `browser.*` promise-based API otherwise —
  Firefox's `browser.*` namespace is Promise-native while Chrome's `chrome.*` is callback-based
  pre-MV3-alignment in some APIs, so the shim also normalizes callback-vs-promise where needed.
  No component file ever calls `chrome.*` directly — always through this shim — so a second
  `manifest.firefox.json` (Firefox still requires `background.scripts` + a persistent-or-event
  background page distinction in some MV3 states — **re-verify Firefox's current MV3 support
  level at build time**, this plan does not claim current Firefox MV3 parity as verified fact,
  unlike the Chrome specifics which were live-checked) is the only other Firefox-specific
  artifact needed for v1. Actually shipping to addons.mozilla.org is out of v1 scope per the
  "Chrome first" ordering in project doc §4.2, but the shim costs little now and avoids a
  same-logic rewrite later.

### 8.4 Store listing assets (Chrome Web Store)

- Icons 16/32/48/128px — a flattened, single-color version of the verdict-seal motif (§1.1) in
  `--sg-brass`, no verdict-color variants needed for the static icon (the *badge*, §5, carries
  dynamic color at runtime; the static icon stays neutral-brand).
- Screenshots: 1280×800, per confirmed CWS spec (backend §7.3 cites the same policy page) —
  minimum set: (1) popup `Report` state on a realistic-looking (but fabricated/placeholder, never
  a real scraped listing with real seller PII) OLX-style listing, (2) the §2.10 Message & Payment
  Check result screen showing the `coreFact` card on a fabricated "scan to receive" example, (3)
  options page provider picker, (4) the export-card output, (5) the `NoKey` first-run state. Five
  screenshots (the payment-check screen added specifically because it's the feature most likely
  to differentiate ScamGuard in store search/browsing — nothing else in this category addresses
  the QR-scam pattern, per backend §-1's research) tell the whole product story per project doc
  §7.3's "30-second demo" framing.
- Privacy practices tab copy: draft this section verbatim from backend §7.3's disclosure language
  before submission, and re-verify against `developer.chrome.com/docs/webstore/program-policies/
  policies` immediately before submitting, since backend §7.3 already flags that page as subject
  to change.
- Store description opens with the positioning line from project doc §2.5, unedited — it was
  already written to be honest and specific, not marketing copy that needs softening for a store
  audience.

---

## 9. TEST PLAN (frontend-specific, complements backend §9)

| Area | Approach |
|---|---|
| State-machine rendering | `node:test` + `jsdom`: feed each of the 8 states (§2.2–2.8) a fixture message payload, assert the correct DOM region is visible and others are hidden/removed (not just CSS-hidden — verify no stale state bleeds between transitions, e.g. an `Error` state must not still show a previous report's red-flags list underneath). |
| Verdict→color mapping | Pure-function unit test: given each of the four `RiskReport.verdict` values, assert the seal receives the exact corresponding `--sg-*` token — guards against the "frontend never recomputes the band" rule in §2.4 silently drifting. |
| Accessibility | Manual pass with a screen reader (VoiceOver/NVDA) before v1 ships, checklist-style against §6's bullet points — no automated a11y test infra added for v1 (axe-core etc. would be another dependency; a short manual pass against a written checklist is proportionate at this scale). |
| i18n boundary | A lint rule (simple regex-based pre-commit check, same style as backend §7.1's key-logging guard) that flags any string-literal concatenation assigned to `.textContent`/`.innerText` outside `src/strings/`, to keep §7's "no hardcoded copy" rule enforced rather than aspirational. |
| Export card | Snapshot the generated canvas as a PNG in a fixture test and diff against a committed reference image at a loose pixel-tolerance threshold (catches accidental layout breaks without being so strict that font-hinting differences across CI runners cause false failures). |
| Manifest validity | A CI step running Chrome's own manifest schema check (`chrome --headless --validate-manifest` or the `web-ext lint`-style tool) against `manifest.json` on every push — cheap, catches permission/schema typos before store submission. |
| §2.10 result rendering | Fixture test: feed a mocked `PaymentCheckReport` with `verdict:"LikelyScam"` and assert (a) the `coreFact` card renders, (b) it still renders when the mocked AI-review call is made to reject/timeout, (c) no verdict-seal DOM element is present anywhere on this view (guards against the "no seal reuse" design decision in §2.10 silently regressing). |
| §2.10 reachability | Assert the `[Check a message]` header button is present and enabled in every one of the 8 listing-report popup states (§2.2–2.8), including `NoKey`/`NoListing`/`Error` — guards against the "reachable from anywhere" requirement in §2.10 being accidentally scoped to only the `Report` state during implementation. |

---

## 10. FIXTURE-CAPTURE INSTRUCTIONS (for backend §9.2's `extractor.olx.test.js`/`quikr.test.js`)

Backend §9.2 references this section for exact capture steps — documented here because it's a
one-time manual developer task, not something either plan can safely automate or hardcode from
search results (per backend §2.1's finding that `data-aut-id` values have no stable public
documentation):

1. Open a real, currently-live OLX.in individual listing page (`/item/<slug>-iid-<numeric>`
   pattern, confirmed backend §8.1) in Chrome DevTools.
2. Right-click the rendered `<html>` root → "Copy → Copy outerHTML" **after** the page has fully
   hydrated (wait for the React SPA's client-side render to settle, not the initial server HTML,
   since backend §2.1 confirms member-since/items-listed/location are client-rendered text nodes
   not present in static meta tags).
3. Save as `test/fixtures/olx-listing-real.html`, then hand-redact any real seller phone number,
   email, or full name visible in the captured HTML before committing (replace with clearly-fake
   placeholder values — e.g. `Seller Name` → `Test Seller`, any digit-string matching a phone
   pattern → `9999999999`) — committing real scraped PII to a public repo is not acceptable even
   for test fixtures.
4. Repeat for a second OLX listing with a sparse/incomplete profile (few or no items listed, no
   verification badge) to produce the "partial confidence" fixture referenced in backend §9.2.
5. Repeat steps 1–4 for a Quikr listing page.
6. Record the specific `data-aut-id` (or current equivalent) attribute names observed at capture
   time directly in a comment block at the top of each fixture file, dated — this is the "build-
   time DevTools inspection" task backend §2.1 explicitly defers to the developer, and doing it
   once here means the extractor's primary-selector strategy (backend §2.1 item 1) has a real,
   dated source instead of a guess.
