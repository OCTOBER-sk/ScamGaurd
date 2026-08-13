# THEME REBUILD SPEC — ScamGuard v3 (SYSTEM LIGHT/DARK + CLEAN PROFESSIONAL REDESIGN)

Agent: Midas. This spec REPLACES the current dark-only theme with a professional dual-theme that follows the OS (`prefers-color-scheme`). The current theme is judged generic/dark-only by the user — this is a craft and theming rebuild. Read FRONTEND-AUDIT-2026-08-13.md for context; read PLAN-FRONTEND.md §1.1-1.6 for identity intent.

## 0. DESIGN PHILOSOPHY (read first — this is the brief)

**Surface archetypes** (claude-design doctrine): the popup is a MONITOR surface — user watches a verdict form; density + glanceable hierarchy beat decoration; the seal + score is the single focal point, everything else quiet. The options page is a CONFIGURE surface — low decoration, clear labels, visible fields, obvious state. NO hero layouts, NO feature-tile grids, NO accent rails, NO glassmorphism, NO emoji in UI chrome, NO radial-glow-heavy elements. Generic = gradient heros + icon-tile grids + indigo accents + centered stacks — none of that here.

**Craft bar** (Notion system): warm neutrals (never cold blue-gray), whisper borders `1px solid rgba(…,0.10)`, multi-layer shadows whose individual opacity never exceeds 0.05, 4-weight type system (400 read / 500 interact / 600 emphasize / 700 announce), ONE accent color used sparingly, pill badges for tags. Light mode feels like quality paper; dark mode is layered charcoal, borders over shadows.

**Identity kept:** warm-brass accent (NOT indigo/blue — brass is the brand), Fraunces serif for the verdict seal + score only, the seal/stamp motif, calm factual copy.

## 1. THEMING ARCHITECTURE (mandatory)

- `:root` holds the LIGHT palette (system default). A single `@media (prefers-color-scheme: dark) { :root { … } }` override holds DARK values. Add `color-scheme: light dark;` on `:root`.
- EVERY color in popup.css and options.css must come from a token. ZERO hardcoded hex/rgba in component rules (search and eliminate — the only allowed exception: the intentional light-themed canvas export card in popup.js, which stays light by design and is documented).
- Native form controls get `color-scheme` so scrollbars/inputs render per mode.
- The theme MUST follow the OS instantly — no toggle, no manual override (v1 system-following only; the i18n/toggle scaffolding for a manual override is OUT of scope).

## 2. LIGHT PALETTE (new :root defaults — warm paper, per PLAN §1.2 original intent)

| Token | Value | Role |
|---|---|---|
| --sg-ink | #1C1B1A | Primary text (warm near-black) |
| --sg-paper | #FAF7F2 | Page/popup background (warm paper) |
| --sg-paper-raised | #FFFFFF | Cards, inputs, panels |
| --sg-paper-sunken | #F1EDE6 | Wells, code blocks, accordion content |
| --sg-brass | #8A6427 | Primary accent (AA on white: ~6.3:1 — verify) |
| --sg-brass-soft | rgba(138,100,39,0.10) | Brass tint fills, hover washes, badge bg |
| --sg-safe | #2F6B4A | Verdict Safe (≥4.5:1 on white — verify) |
| --sg-review | #8A6A1F | Verdict Review |
| --sg-suspicious | #B3541E | Verdict Suspicious |
| --sg-high-risk | #9A2B24 | Verdict High-Risk |
| --sg-line | rgba(28,27,26,0.10) | Hairlines, dividers, card borders (whisper) |
| --sg-border-strong | #8A857C | Interactive boundaries (inputs, buttons, toggles) ≥3:1 vs paper |
| --sg-muted | #6B665D | Secondary text (≥4.5:1 on paper — verify) |
| --sg-focus | #8A6427 | Focus ring (2px) — same brass, with 3px rgba(138,100,39,0.22) glow ring |
| Shadows | light mode: Notion-style layered — `0 1px 2px rgba(28,27,26,0.05), 0 2px 8px rgba(28,27,26,0.05)` for cards; buttons no shadow | Depth felt, not seen |

## 3. DARK PALETTE (media query override — refined charcoal, borders over shadows)

| Token | Value | Role |
|---|---|---|
| --sg-ink | #F2EFE9 | Primary text |
| --sg-paper | #161412 | Page/popup background |
| --sg-paper-raised | #1F1C19 | Cards, inputs, panels |
| --sg-paper-sunken | #100E0D | Wells, code blocks |
| --sg-brass | #C89B54 | Primary accent |
| --sg-brass-soft | rgba(200,155,84,0.14) | Brass tint fills/hover washes |
| --sg-safe | #4CAF7E | Verdict Safe (existing dark value) |
| --sg-review | #D4A24A | Verdict Review |
| --sg-suspicious | #E07B3F | Verdict Suspicious |
| --sg-high-risk | #D1544A | Verdict High-Risk |
| --sg-line | rgba(255,255,255,0.10) | Hairlines, card borders |
| --sg-border-strong | #6E675E | Interactive boundaries ≥3:1 on dark |
| --sg-muted | #B9B3A9 | Secondary text |
| --sg-focus | #C89B54 | Focus ring + rgba(200,155,84,0.22) glow |
| Shadows | dark mode: minimal — `0 1px 2px rgba(0,0,0,0.4)` only on floating things; use borders, not shadows, for separation | |

## 4. COMPONENT TREATMENT (both modes, token-driven)

1. **Seal** — the identity. Crisp, professional: concentric ring(s) in the VERDICT color (stroke), inner fill = `--sg-paper-raised`, score in Fraunces 700 26px `--sg-ink`, verdict word as STRAIGHT text below the ring (Fraunces 600 14px, verdict color, letter-spacing 0.04em). NO radial gradient glow — replace with a subtle ring shadow `0 2px 8px rgba(0,0,0,0.12)` (light) / `0 2px 8px rgba(0,0,0,0.35)` (dark). Keep the 120ms stamp-down animation + prefers-reduced-motion skip. Do NOT use color-mix() (keep compatibility simple) — use the tokens.
2. **Buttons** — three tiers:
   - Primary: bg `--sg-brass`, text white (light mode: white on #8A6427 ≈ 5:1 ✓ / dark mode: #1C1A17 on #C89B54), weight 600, radius 8px, min-height 32px, hover = darken 5% (light) / lighten 4% (dark), active = slight press. Inset top highlight ONLY in light mode (`inset 0 1px 0 rgba(255,255,255,0.25)`); dark mode none.
   - Secondary: transparent, `1px solid var(--sg-border-strong)` border, `--sg-ink` text, hover = `--sg-brass-soft` wash.
   - Tertiary/link: `--sg-brass` text (dark mode: `--sg-brass`), underline on hover.
   - Destructive (Clear key / Clear history): `--sg-high-risk` text, hover = rgba(154,43,36,0.08) wash (light) / rgba(209,84,74,0.14) (dark).
3. **Inputs** — bg `--sg-paper-raised`, `1px solid var(--sg-border-strong)`, radius 8px, padding 8px 12px, `--sg-ink` text, placeholder `--sg-muted` at 60% opacity. Focus: `border-color: var(--sg-brass)` + `box-shadow: 0 0 0 3px var(--sg-brass-soft)`; remove default outline only because the ring replaces it (visible focus satisfied). Key field keeps mono + letter-spacing.
4. **Cards** (provider grid, coreFact card, resources, checklist, heuristic block, history) — bg `--sg-paper-raised`, `1px solid var(--sg-line)`, radius 12px, padding 12px 14px. Light mode: soft layered shadow (Notion-style, ≤0.05). Dark mode: no shadow, border only. NO hover transforms on non-interactive cards. NO left accent rails — if a callout needs emphasis use the border + soft tint fill only (coreFact keeps its brass 2px LEFT border per PLAN §2.10 — that one is spec'd by the plan, keep it).
5. **Toggles** — track: off = `--sg-paper-sunken` fill + `1px solid var(--sg-border-strong)`, on = `--sg-brass`; thumb white (light) / `#1C1A17` (dark); disabled = opacity 0.45 + not-allowed; focus ring offset 4px.
6. **Provider cards** — equal height, 12px padding, title 14px/600, note 12px `--sg-muted`, paid badge = pill (9999px radius) `--sg-brass-soft` bg + `--sg-brass` text 11px/600. Selected: `--sg-brass` border + `--sg-brass-soft` ring + brass check glyph top-right.
7. **Red-flag severity dots** — keep 3-step scale (low = grey `--sg-muted`, medium = `--sg-review`, high = `--sg-high-risk`), always paired with text label.
8. **Eyebrows/section labels** — 11px, weight 600, uppercase, 0.08em, `--sg-muted`. Options sections separated by `--sg-line` hairlines + 28px rhythm.
9. **History items** — display-only (no pointer), dot + title + score + relative date, hover = `--sg-paper-sunken` wash (non-interactive affordance removal: NO cursor pointer).

## 5. TYPOGRAPHY

- Keep: Fraunces 600/700 (seal score + verdict word only), Inter 400/500/600 (everything else), JetBrains Mono (raw data). Same 5 self-hosted woff2, font-display swap. No new fonts.
- Tighten the scale for professional density: popup body 13px/1.5, labels 12px/500, section eyebrows 11px/600; options body 14px/1.55, inputs 14px, card titles 14px/600. Score 26px Fraunces. Verdict word 14px. Never below 12px for interactive-adjacent text.

## 6. VERIFICATION REQUIREMENTS (implementer must do)

- Light AND dark both render correctly. The harnesses link real CSS so they follow prefers-color-scheme automatically; you cannot see both modes in one screenshot — verify by temporarily forcing the media query (e.g. a debug query-param stylesheet or DevTools emulation) and by code review of every token swap. Use `chrome --force-dark-mode` only as a sanity check, never as proof.
- WCAG: verify contrast numerically for BOTH palettes: ink on paper ≥ 10:1, muted on paper ≥ 4.5:1, all 4 verdict colors on paper-raised ≥ 4.5:1 at 14px, brass on paper-raised ≥ 4.5:1, border-strong vs the surface it sits on ≥ 3:1 (1.4.11), focus ring ≥ 3:1 vs adjacent.
- `color-scheme: light dark` present. No hardcoded colors in popup.css/options.css outside :root + media query (grep for `#[0-9a-fA-F]{3,8}` and `rgba(` outside the token blocks — the ONLY allowed component-level hardcoded color is the intentional light canvas export in popup.js).

## 7. SCOPE

In scope: popup.css, options.css (token system + full restyle), popup.js + options.js (ONLY to remove any hardcoded colors / adapt to new tokens; keep the intentional light canvas export), test/popup.test.js + test/options.test.js (update token-contract assertions to the NEW light :root values — spec-driven change; keep all other assertions), scripts/e2e/options-harness.html (its hardcoded `background:#161412 !important` / `color:#F2EFE9` harness-chrome must become neutral/neutral-dark so both modes screenshot correctly — e.g. `#2A2825` chrome, or token-following), PLAN-FRONTEND.md (§1.2 palette table → dual-mode tables + a "system light/dark" note), STATUS.md (one line). Regenerate popup-harness.html + message-harness.html via `node scripts/e2e/build-harness.mjs` after popup.html/css changes.

HARD BAN: no changes to popup.html structure or element IDs, options.html structure or IDs, manifest.json, src/ (backend/i18n/storage/llm), content/, fonts, icons, test logic beyond the token assertions, results.json. No new deps, no bundler, MV3. popup stays 360px fixed, max-height 600px.

## 8. DELIVERABLES + SELF-REVIEW (mandatory, in order)

1. git status — only in-scope files.
2. grep audit: zero hardcoded colors outside token blocks (document the canvas export exception).
3. npm test 254/254 (token assertions updated to new values), npm run lint 0.
4. node scripts/e2e/build-harness.mjs regenerates cleanly.
5. Both-palette review: walk every component and confirm it reads correctly in BOTH palettes (write out the mapping you used to check — e.g. which token swaps). Report any token you had to adjust from this spec and why.
6. Contrast: list computed ratios for the light palette's verdict colors + muted + brass on paper-raised, and dark palette's equivalents. Flag anything under the numbers in §6.
7. Report: files changed, test/lint counts, theme behavior summary, remaining risks.
