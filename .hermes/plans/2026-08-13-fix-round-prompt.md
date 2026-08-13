Midas, one targeted fix round on the ScamGuard rebuild. You completed a rebuild; three rendering flaws were found in the real screenshots. Fix ONLY these, nothing else.

## FIX 1 (popup — seal verdict word overflow)
Current: renderSeal() (popup.js) puts the verdict word INSIDE the 72px circular seal via flex column. At 16px Fraunces 600 + 0.06em letter-spacing, "SUSPICIOUS" is ~110px wide — wider than the 72px circle, so the text overflows past the ring and looks like it follows the circle curve. Per PLAN-FRONTEND.md §1.4 (ASCII layout), the verdict word belongs on its own straight text line BELOW the seal ring, with the score inside the ring.

HARD RULES:
- Keep the 72px circular seal (rings, brass glow, stamp animation, verdict-colored ring) as the emblem.
- Score number stays INSIDE the circle (center), Fraunces 700 ~26px.
- The verdict word renders as a straight horizontal text line BELOW the seal: Fraunces 600, 14px, letter-spacing 0.04em, uppercase optional, verdict color (e.g. --sg-suspicious), line-height 1.2, text-align center. It must NEVER overflow horizontally — 14px max, no wider.
- Structure it as: seal circle element + verdict text element, both inside the existing seal container (adjust CSS so the container is no longer the 72px circle itself — the circle becomes a child), OR keep the circle and append the verdict line under it. Either way: verdict text visually below the ring, straight baseline, fully inside the popup width.
- renderSeal() output shape stays: score span + verdict span; only the CSS layout and wrapper change. Check every state that calls renderSeal (Report, Analyzing placeholder, NoKey neutral seal) still renders correctly.
- Keep prefers-reduced-motion behavior and the verdict color mapping.

## FIX 2 (options — provider card "No free tier" note)
The paid-note on OpenAI and Anthropic cards renders duplicated/overlapping and overflows the card bounds. 
HARD RULES:
- Render the paid note ONCE per card, as a clean compact badge: 11px, --sg-muted or warning-tinted color, single line, `white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%`.
- Give every card that carries the note the SAME badge treatment (consistent styling, same placement — e.g. bottom of card, or inline after the note text). No duplication, no overflow, no layout shift between cards.
- Equalize card internal padding: all provider cards get identical padding (12px) and `align-items: stretch` / `height: 100%` so the grid is uniform. Fix the Custom card cramping.

## FIX 3 (options — vision toggle disabled state)
When the selected provider has no vision support, the toggle is disabled but looks like a normal off-toggle. HARD RULES:
- Disabled state: `opacity: 0.45` on the toggle + `cursor: not-allowed` on the row + keep the explanatory "Selected provider does not support vision" note. The toggle must clearly read as non-activatable, but stay visible.
- Do not change the enabled on/off styling.

## CONSTRAINTS (unchanged from the rebuild)
- Only touch popup.js, popup.css, options.css, options.js as needed (and regenerate harnesses after: node scripts/e2e/build-harness.mjs; update scripts/e2e/options-harness.html by hand if options markup changed — it should NOT need markup changes for Fix 2/3, only CSS).
- npm test must stay 254/254. npm run lint 0 violations. No new deps, no bundler, MV3.
- Do NOT touch service-worker, backend, tests, manifest, results.json.

## SELF-REVIEW (mandatory)
1. git status — only intended files.
2. npm test 254/254, npm run lint 0.
3. Regenerate harnesses; confirm popup-harness renders: verdict word as a STRAIGHT line under the seal (not inside the circle).
4. Report: what changed per fix, test counts, anything you could not verify.
