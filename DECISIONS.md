# DECISIONS — ScamGaurd

Append-only log. Newest last.

| Date | Decision | Reason | Alternatives | Owner |
|---|---|---|---|---|
| 2026-08-11 | Ground truth = official first-party docs over third-party blogs where sources conflict | Fast-moving provider rate limits caused self-contradictory sources | Treat all sources equal | Atom |
| 2026-08-12 | Add "Message & Payment Check" as first-class in-scope module (additive, off-page surface) | Real Indian incident research: most damaging OLX/Quikr fraud happens in chat/payment flow, targets sellers, listing page gives no signal | Keep listing-only analysis (would miss the dominant fraud class) | Sandy |
| 2026-08-12 | BYOK model stays: user-supplied provider key, keys only in chrome.storage.local, never sync | No backend hosting cost; user controls data; E2/E3 security gates pass | Hosted backend (cost, trust, scope) | Sandy |
| 2026-08-12 | Verification standard: build → attack → verify → prove; levels STATIC→REAL-BROWSER; "not verified" is first-class | Mocks prove components, real execution proves integration; agent claims are never evidence | Treat untested as done | Sandy |
| 2026-08-12 | VPS-side OLX verification deferred to Sandy's machine (redact-fixture.js) | VPS egress blocks OLX.in; live fixtures need a reachable network | Ship unverified (rejected) | Sandy |
