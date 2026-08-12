/**
 * payment-scam-patterns.js — phrase/regex lists for Message & Payment Check
 * (PLAN-BACKEND.md §4.7).
 *
 * Six pattern ids, exactly as specified in the §4.7 table:
 *   SCAN_TO_RECEIVE, COLLECT_REQUEST_FRAMED_AS_REFUND, FAKE_SCREENSHOT_THEN_QR,
 *   OVERPAYMENT_REFUND_REQUEST, SCREEN_SHARE_REQUEST, OTP_OR_PIN_REQUEST
 *
 * Deliberately separate from `heuristics/language-patterns.js` (§8 file plan):
 * that file serves the LISTING heuristics with §5.4's false-positive tolerance,
 * this one serves the payment-check flow with §4.7's OPPOSITE calibration —
 * permissive matching, favoring false positives over false negatives, because
 * an unnecessary warning costs a few seconds while a missed one costs money
 * that a cleared UPI transaction never comes back. Do not merge the two.
 *
 * Each pattern matches if ANY of its `phrases` (word-boundary substring,
 * case-insensitive) or ANY of its `regexes` (loose, code-switch-tolerant)
 * hits the text.
 */

/**
 * @typedef {object} PaymentScamPattern
 * @property {string} id          UPPER_SNAKE_CASE id from the §4.7 table.
 * @property {string} label       Short human-readable label (matchedPatterns).
 * @property {string} explanation 1-2 sentence plain-language reason.
 * @property {readonly string[]} phrases  Word-boundary substrings, EN + Hinglish.
 * @property {readonly RegExp[]} regexes  Flexible constructions (word order,
 *                                        code-switching) that substrings can't cover.
 */

/**
 * The six patterns in §4.7 table order (canonical output order).
 *
 * @type {PaymentScamPattern[]}
 */
export const PAYMENT_SCAM_PATTERNS = [
  {
    id: "SCAN_TO_RECEIVE",
    label: "Told to scan or approve to receive money",
    explanation:
      "Scanning a QR code or approving a payment request can only ever send money, never receive it — there is no legitimate UPI flow where scanning brings money in.",
    phrases: [
      // English
      "scan to receive",
      "scan to receive payment",
      "scan and receive",
      "scan to get paid",
      "scan to get payment",
      "scan to get the payment",
      "scan this qr",
      "scan the qr",
      "scan qr",
      "qr scan",
      "approve to receive",
      "approve to receive payment",
      "approve to get paid",
      "approve to get payment",
      "approve the payment",
      // Hinglish
      "scan karke paise",
      "scan karke paise le lo",
      "scan karke paise lo",
      "scan karo paise",
      "scan karo",
      "qr scan karo",
      "paise lene ke liye scan",
      "paise receive",
      "paisa receive",
      "receive karne ke liye scan",
      "receive karne ke liye qr",
      "approve karo paise",
      "approve karke paise",
      "paise approve karo",
      "paise aa jayenge",
      "paise aayenge",
    ],
    regexes: [
      /scan.{0,30}(?:receive|received|paid|payment|paisa|paise|le lo|lelo)/i,
      /(?:receive|received|paid|payment|paisa|paise).{0,30}scan/i,
      /approve.{0,30}(?:receive|received|paid|payment|paisa|paise)/i,
      /(?:receive|received|paid|payment|paisa|paise).{0,30}approve/i,
      /qr.{0,25}(?:scan|karo|karke)/i,
    ],
  },
  {
    id: "COLLECT_REQUEST_FRAMED_AS_REFUND",
    label: "Collect request framed as a refund",
    explanation:
      "A UPI collect/approve request described as a refund, cashback, or overpayment correction is the scan-to-pay trick with a different cover story — refunds are always sender-initiated, never something the recipient approves.",
    phrases: [
      // English
      "collect request",
      "collect-request",
      "collect request for refund",
      "payment request",
      "upi request",
      "approve the request",
      "approve the payment request",
      "approve the collect request",
      "approve request",
      "approve to get refund",
      "approve for refund",
      "request for refund",
      "approve the refund",
      // Hinglish
      "request approve karo",
      "request approve",
      "approve karo request",
      "request aaya hai",
      "request aayi hai",
      "collect request aaya hai",
      "refund ke liye approve",
      "refund ke liye request",
      "refund aane ke liye approve",
      "refund receive karne ke liye approve",
      "approve karke refund",
      "cashback approve",
      "refund ka collect request",
      "refund ke liye collect request",
    ],
    regexes: [
      /request.{0,35}(?:approve|refund|cashback)/i,
      /(?:approve|refund|cashback).{0,35}request/i,
      /collect.{0,20}(?:request|karo|aaya|aayi|bheja|bheji)/i,
      /(?:refund|cashback).{0,35}(?:approve|request|aaya|aayi|karo)/i,
    ],
  },
  {
    id: "FAKE_SCREENSHOT_THEN_QR",
    label: "Payment screenshot followed by a scan/approve ask",
    explanation:
      "A payment-confirmation screenshot right before a request to scan or approve something is the classic false-confidence setup — the screenshot's whole job is to make the real ask look safe.",
    phrases: [
      // English
      "payment screenshot",
      "payment proof",
      "transaction screenshot",
      "confirmation screenshot",
      "screenshot of the payment",
      "screenshot of payment",
      "screenshot of transaction",
      "proof of payment",
      "paid screenshot",
      // Hinglish
      "screenshot bhej",
      "screenshot bheja",
      "screenshot bhej diya",
      "screenshot dekh",
      "screenshot send",
      "screenshot send kiya",
      "screenshot check",
      "screenshot le",
    ],
    regexes: [
      /screenshot.{0,40}(?:scan|approve|complete|release|confirm|verify|karo|karke)/i,
      /(?:scan|approve|complete|release|confirm|verify|karke).{0,40}screenshot/i,
      /proof.{0,40}(?:scan|approve|complete|release|confirm|verify)/i,
    ],
  },
  {
    id: "OVERPAYMENT_REFUND_REQUEST",
    label: "Claimed overpayment refunded via QR/request",
    explanation:
      "A 'buyer' claiming to have overpaid and asking for the difference back through a QR code, link, or collect request is the overpayment con — the overpayment never happened, and the 'refund' step is the actual theft.",
    phrases: [
      // English
      "overpaid",
      "overpayment",
      "over payment",
      "over pay",
      "more than the amount",
      "refund the difference",
      "refund the extra",
      "refund the amount",
      "send the difference",
      "send back the extra",
      "extra amount",
      "extra amount wapas",
      "difference wapas",
      "send back",
      // Hinglish
      "extra paisa",
      "extra bheja",
      "extra bhej diya",
      "zyada bheja",
      "zyada bhej diya",
      "zyada paisa",
      "zyada bheja hai",
      "refund karo",
      "paise wapas",
      "paisa wapas",
      "wapas bhejo",
    ],
    regexes: [
      /(?:overpaid|over[\s-]?paid|extra|zyada).{0,30}(?:refund|wapas|back|difference)/i,
      /(?:refund|wapas|back|difference).{0,30}(?:extra|zyada|overpaid)/i,
      /(?:extra|zyada).{0,15}paisa/i,
    ],
  },
  {
    id: "SCREEN_SHARE_REQUEST",
    label: "Remote access / screen-share requested",
    explanation:
      "No legitimate marketplace payment step ever requires installing a remote-access app or sharing your screen — this is used to watch you type your PIN/OTP or take over the device.",
    phrases: [
      // English
      "anydesk",
      "teamviewer",
      "team viewer",
      "quick support",
      "screen share",
      "screen-sharing",
      "screenshare",
      "screen sharing",
      "share your screen",
      "share screen",
      "screen control",
      "remote access",
      "remote control",
      "remote connect",
      "remote app",
      "screen connect",
      // Hinglish
      "screen share karo",
      "screen kholo",
      "anydesk install",
      "teamviewer install",
    ],
    regexes: [
      /(?:share|kholo|karo).{0,15}screen/i,
      /screen.{0,15}(?:share|kholo|karo|control|connect)/i,
      /anydesk|teamviewer|team[\s-]?viewer|quick[\s-]?support/i,
    ],
  },
  {
    id: "OTP_OR_PIN_REQUEST",
    label: "Asked to share OTP/PIN/CVV",
    explanation:
      "A PIN or OTP is only ever needed to authorize an outgoing payment or a login — sharing it to 'receive' or 'verify' a payment always ends with money leaving your account.",
    phrases: [
      // English
      "otp",
      "cvv",
      "upi pin",
      "enter your pin",
      "enter pin",
      "share your pin",
      "share pin",
      "pin number",
      "pin details",
      // Hinglish
      "pin batao",
      "pin bolo",
      "pin do",
      "pin share",
      "apna pin",
      "otp batao",
      "otp bata",
      "otp bolo",
      "otp do",
      "otp bhejo",
      "otp send",
      "otp share",
      "otp share karo",
      "otp chahiye",
      "otp mang",
    ],
    regexes: [
      /otp.{0,20}(?:share|bata|batao|bolo|do|bhejo|send|chahiye|mang|karo)/i,
      /(?:share|bata|batao|bolo|do|bhejo|send|chahiye|mang|karo).{0,20}otp/i,
      /pin.{0,15}(?:batao|bolo|do|share|chahiye|mang|enter)/i,
      /(?:share|enter|batao|bolo).{0,15}pin/i,
      /(?:cvv|pin).{0,20}(?:chahiye|mang|batao|bolo|do|share)/i,
    ],
  },
];

/**
 * The three pattern ids whose mechanics are close to structural fact
 * (§4.7): a scan/collect-request can only ever send money, and a
 * PIN/OTP/CVV is only ever needed to authorize an outgoing payment. A match
 * on any of these alone is enough for a `LikelyScam` verdict (§4.7, and the
 * `coreFact` rationale). The other three patterns are strong but need
 * corroboration before they alone produce `LikelyScam`.
 *
 * @type {ReadonlySet<string>}
 */
export const STRUCTURAL_PATTERN_IDS = new Set([
  "SCAN_TO_RECEIVE",
  "COLLECT_REQUEST_FRAMED_AS_REFUND",
  "OTP_OR_PIN_REQUEST",
]);

/**
 * Escape a string for use inside a RegExp.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a word-boundary RegExp for a phrase. Wrapping in `\b` keeps short
 * tokens ("otp", "qr") from matching inside unrelated words.
 *
 * @param {string} phrase
 * @returns {RegExp}
 */
function phraseToRegExp(phrase) {
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i");
}

/**
 * Match text against the six §4.7 patterns. Returns the matched patterns in
 * canonical (§4.7 table) order as `{ id, label, explanation }` objects — the
 * exact shape of `PaymentCheckReport.matchedPatterns` items (§2.5). A pattern
 * is matched if any of its phrases or regexes hits. Case-insensitive,
 * word-boundary aware, never throws on empty/null input — returns [].
 *
 * @param {string | null | undefined} text
 * @returns {Array<{ id: string; label: string; explanation: string }>}
 */
export function matchPaymentScamPatterns(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const matched = [];
  for (const pattern of PAYMENT_SCAM_PATTERNS) {
    let hit = false;
    for (const phrase of pattern.phrases) {
      if (phraseToRegExp(phrase).test(text)) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      for (const re of pattern.regexes) {
        if (re.test(text)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) {
      matched.push({ id: pattern.id, label: pattern.label, explanation: pattern.explanation });
    }
  }
  return matched;
}
