/**
 * prompt.js — dedicated short LLM-nuance prompt for Message & Payment Check
 * (PLAN-BACKEND.md §4.7).
 *
 * Intentionally separate from `llm/prompt.js`'s listing-analysis prompt: the
 * two jobs are different enough to warrant their own prompts rather than
 * overloading one prompt with a mode flag (§4.7). This prompt is short — it
 * refines a locally-computed pattern-match result, it does not re-detect
 * patterns from scratch.
 *
 * The LLM pass is OPTIONAL and additive: if it fails or times out, the
 * pattern-match result and `coreFact` still render (§4.7). Nothing here is
 * ever called from match.js — the service worker builds the request with
 * `buildNuanceUserPrompt`, performs the async provider call, and feeds the
 * parsed result back through match()'s `nuance` seam.
 */

/**
 * System prompt for the nuance pass. Instructs the model to (a) context-check
 * so it never flags someone WARNING others about a scam (§4.7's explicit
 * example), (b) choose one of the three verdict bands, (c) write a plain
 * 1-3 sentence summary — and to respond with ONLY a single JSON object
 * (`tolerantParse` handles minor deviations per §3.6/§6).
 *
 * @type {string}
 */
export const NUANCE_SYSTEM_PROMPT = `You are a safety reviewer inside ScamGuard, a browser extension that protects people from marketplace payment fraud. A local rule-based matcher has already reviewed a short piece of user-supplied chat text (or a guided payment-flow description) and flagged specific patterns.

You have exactly two jobs:

1. CONTEXT CHECK (most important). Decide whether the text is genuinely part of a live payment instruction the user is being asked to act on, or something the pattern matcher cannot distinguish:
- If the text WARNS OTHERS about a scam or describes a past scam the user already avoided (e.g. "someone tried to make me scan a QR code to receive money, don't fall for it"), it is NOT a scam instruction — respond verdict "NoRedFlagsFound" and say so in the summary.
- If the text is a neutral explanation of how payments work, soften to "NoRedFlagsFound" or "Caution" as the facts warrant.
- If the text is a live ask — scan this, approve this, share your PIN/OTP/CVV, send money — keep or strengthen the flagged verdict.

2. VERDICT + SUMMARY. Choose exactly one of: "LikelyScam" | "Caution" | "NoRedFlagsFound". Write a 1-3 sentence plain-language summary in simple English (Hinglish-friendly): what was flagged and why, and one concrete safe action. Never be alarmist, never accuse anyone, never claim certainty beyond what the text supports.

Hard facts you must never contradict or soften: a QR code or payment request can only ever be used to SEND money, never to receive it; a PIN/OTP/CVV is only ever needed to authorize an outgoing payment or a login, never to receive money. ScamGuard already shows this fact to the user, so do not restate it in your summary.

Respond with ONLY a single JSON object — no prose before or after, no markdown code fences:
{"verdict": "LikelyScam" | "Caution" | "NoRedFlagsFound", "summary": "<1-3 plain sentences>", "reasoning": "<one sentence explaining the context that drove your verdict, or 'no context change'>"}`;

/**
 * Build the user message for the nuance pass. Carries the input text (or
 * guided answers), the locally-computed pattern matches, and the current
 * verdict, then asks for the refined JSON object.
 *
 * @param {import("./match.js").PaymentCheckInput | null | undefined} input
 * @param {import("./match.js").PaymentCheckReport} report
 * @returns {string}
 */
export function buildNuanceUserPrompt(input, report) {
  const lines = [];
  lines.push("PAYMENT CHECK INPUT");
  lines.push(`Mode: ${input?.mode ?? "unknown"}`);

  if (typeof input?.rawText === "string" && input.rawText.length > 0) {
    lines.push("Pasted text:");
    lines.push(`"""`);
    lines.push(input.rawText);
    lines.push(`"""`);
  }

  const ga = input?.guidedAnswers ?? null;
  if (ga) {
    lines.push(`Role in conversation: ${ga.role}`);
    lines.push(`Was asked to scan or approve something: ${ga.wasAskedToScanOrApprove ? "yes" : "no"}`);
    if (typeof ga.claimedReasonForCode === "string" && ga.claimedReasonForCode.length > 0) {
      lines.push(`Claimed reason for the code/request: "${ga.claimedReasonForCode}"`);
    }
  }

  lines.push("");
  lines.push("LOCAL PATTERN-MATCH RESULT");
  lines.push(`Current verdict: ${report.verdict}`);
  if (report.matchedPatterns.length === 0) {
    lines.push("Matched patterns: none");
  } else {
    lines.push("Matched patterns:");
    for (const p of report.matchedPatterns) {
      lines.push(`- ${p.id}: ${p.label}`);
      lines.push(`  ${p.explanation}`);
    }
  }

  lines.push("");
  lines.push(
    "If the text above warns other people about a scam or describes a past scam rather than " +
      "instructing the user to do something, say so and respond with verdict NoRedFlagsFound. " +
      "Otherwise confirm or adjust the verdict based on context. Return the JSON object.",
  );

  return lines.join("\n");
}
