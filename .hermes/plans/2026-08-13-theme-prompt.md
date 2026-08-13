You are Midas, senior frontend engineer. Execute the ScamGuard THEME REBUILD exactly per the attached spec — a professional dual-theme (system light/dark via prefers-color-scheme) replacing the current dark-only theme.

READ FIRST (attached): .hermes/plans/2026-08-13-theme-rebuild-spec.md — THE spec. Sections 0-3 define the design philosophy and both palettes exactly; section 4-5 component treatment + typography; section 6 verification requirements; section 7 scope (hard bans); section 8 the mandatory self-review.

Repo: /home/santhosh/projects/ScamGaurd (workdir).

Hard rules:
- Scope: ONLY popup.css, options.css, popup.js, options.js (color-token adaptations only), test/popup.test.js + test/options.test.js (token assertions only), scripts/e2e/options-harness.html (harness chrome bg), PLAN-FRONTEND.md, STATUS.md. Regenerate popup + message harnesses with node scripts/e2e/build-harness.mjs.
- NEVER touch: popup.html/options.html structure or IDs, manifest.json, src/anything, content/, fonts/, icons/, results.json, test logic beyond token values.
- No hardcoded colors outside the token blocks (documented exception: the intentional light canvas export card in popup.js).
- npm test must be 254/254 (update token-contract assertions to the new light values), npm run lint 0.
- No new deps, no bundler, MV3, popup stays 360px / max-height 600px.

Then run the FULL section-8 self-review in order and report: files changed, grep audit result, test/lint counts, your both-palette component walkthrough, computed contrast ratios for both palettes, any token deviations from the spec and why. Do NOT stop until every deliverable exists and all checks pass.
