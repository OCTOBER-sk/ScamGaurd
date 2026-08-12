/**
 * openai-compat.js — shared request builder + response parser for all
 * OpenAI-compatible chat-completions providers (§3.2: groq, cerebras,
 * openrouter, mistral, deepseek, openai, ollama, custom).
 *
 * Every provider in that family shares the same wire shape:
 *   POST <endpoint>
 *   { model, messages:[{role:"system"},{role:"user"}],
 *     temperature: 0.2, max_tokens, response_format? }
 * and the same response envelope:
 *   { choices:[{ message: { content } }], usage:{ prompt_tokens,
 *     completion_tokens } }
 * The `custom` adapter supports a gemini-native variant separately.
 */

import {
  TEMPERATURE,
  MAX_TOKENS_TEXT,
  MAX_TOKENS_VISION,
} from "./constants.js";
import { safeParseJson } from "../parse.js";

/**
 * @typedef {"bearer" | "header" | "query-param" | "none"} AuthStyle
 * @typedef {"openai-response-format" | "gemini-response-schema" | "prompt-only"} JsonModeStyle
 */

/**
 * Build a chat-completions request object. `imageParts` must already be in
 * the OpenAI-compatible image_url shape produced by vision.js
 * (`{ type: "image_url", image_url: { url } }`).
 *
 * @param {object} input
 * @param {string} input.endpoint
 * @param {string} input.model
 * @param {AuthStyle} input.authStyle
 * @param {string | null} input.authKeyName
 * @param {string} input.apiKey
 * @param {string} input.systemPrompt
 * @param {string} input.userPrompt
 * @param {Array<{ type: string; image_url?: { url: string }; inlineData?: unknown }>} [input.imageParts]
 * @param {unknown} [input.responseFormat]  response_format body, e.g. { type: "json_object" }.
 * @param {"prompt-only"} [input.jsonModeStyle]  when "prompt-only", omit response_format entirely.
 * @returns {{ url: string; headers: Record<string, string>; body: Record<string, unknown> }}
 */
export function buildOpenAICompatibleRequest(input) {
  const headers = { "Content-Type": "application/json" };
  if (input.authStyle === "bearer") {
    headers.Authorization = `Bearer ${input.apiKey}`;
  } else if (input.authStyle === "header" && input.authKeyName) {
    headers[input.authKeyName] = input.apiKey;
  }
  // query-param auth is handled by the caller (it mutates the URL), and
  // "none" (ollama) simply sends no auth header.

  const imageParts = Array.isArray(input.imageParts) ? input.imageParts : [];
  const maxTokens = imageParts.length > 0 ? MAX_TOKENS_VISION : MAX_TOKENS_TEXT;

  let content = input.userPrompt;
  if (imageParts.length > 0) {
    content = [
      { type: "text", text: input.userPrompt },
      ...imageParts,
    ];
  }

  /** @type {Record<string, unknown>} */
  const body = {
    model: input.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content },
    ],
    temperature: TEMPERATURE,
    max_tokens: maxTokens,
  };

  if (input.jsonModeStyle !== "prompt-only" && input.responseFormat !== undefined) {
    body.response_format = input.responseFormat;
  }

  return { url: input.endpoint, headers, body };
}

/**
 * Extract `{ text, usage }` from an OpenAI-compatible response envelope.
 * Accepts a pre-parsed object or a raw JSON string. Returns `text: null`
 * when the envelope is missing/invalid — the caller's tolerantParse then
 * drives the §6 repair path.
 *
 * @param {unknown} raw
 * @returns {{ text: string | null; usage?: { inputTokens: number | null; outputTokens: number | null } }}
 */
export function parseOpenAICompatibleResponse(raw) {
  const body =
    typeof raw === "string" ? safeParseJson(raw) : raw;
  const choice = /** @type {any} */ (body)?.choices?.[0];
  const content = choice?.message?.content;
  let text = typeof content === "string" && content.length > 0 ? content : null;

  if (text === null) {
    // Some OpenAI-compatible providers return tool_calls instead of content;
    // surface the serialized arguments so tolerantParse can still recover.
    const args = choice?.message?.tool_calls?.[0]?.function?.arguments;
    if (typeof args === "string" && args.length > 0) text = args;
  }

  const usage = /** @type {any} */ (body)?.usage;
  return {
    text,
    usage:
      usage && typeof usage === "object"
        ? {
            inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
            outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
          }
        : undefined,
  };
}

/**
 * The OpenAI-compatible `response_format` for JSON-object mode (§3.2).
 *
 * @type {{ type: "json_object" }}
 */
export const JSON_OBJECT_FORMAT = { type: "json_object" };
