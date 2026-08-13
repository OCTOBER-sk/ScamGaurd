Midas, one micro-fix on the theme rebuild (single token value).

PROBLEM: dark palette --sg-high-risk: #D1544A on --sg-paper-raised (#1F1C19) computes ~3.8:1 — below the 4.5:1 WCAG AA target for the 14px verdict word (your own self-review flagged this).

FIX (exact):
- In popup.css AND options.css dark-palette media query: change --sg-high-risk from #D1544A to #D85A50 (≈4.6:1 on #1F1C19 — verify).
- Update the token-contract assertions in test/popup.test.js and test/options.test.js to #D85A50 (spec-driven change, same as before).
- Touch ONLY those 4 files. Run npm test (254/254) + npm run lint (0). Report the computed ratio for #D85A50 on #1F1C19.
