/**
 * anthropic.js — ProviderAdapter for Anthropic Claude (PLAN-BACKEND.md §3.2
 * row 8).
 *
 * Anthropic has no native `response_format`; the standard forced-JSON pattern
 * is tool-use: declare exactly one tool whose `input_schema` is the §4.5
 * verdict and force it via `tool_choice: {type:"tool"}`. The model then
 * returns a `tool_use` block whose `input` is the JSON object.
 *
 * Auth: `x-api-key` header PLUS the required `anthropic-version` header.
 * Vision: native base64 image source blocks. Model is user-specified
 * (no free tier). 20s timeout per §4.4.
 */

import { safeParseJson } from "../parse.js";
import {
  ANTHROPIC_VERSION,
  ANTHROPIC_TOOL_NAME,
  TEMPERATURE,
  MAX_TOKENS_TEXT,
  MAX_TOKENS_VISION,
  DEFAULT_TIMEOUT_MS,
} from "./constants.js";
import { RISK_VERDICT_SCHEMA } from "../schema.js";
import { runTestConnection } from "./test-connection.js";

/**
 * Claude model IDs known to accept image input (3.x/4.x multimodal families).
 *
 * @type {string[]}
 */
const VISION_CAPABLE_MODELS = [
  "claude-3-5-haiku-latest",
  "claude-3-5-sonnet-latest",
  "claude-3-7-sonnet-latest",
  "claude-sonnet-4-latest",
  "claude-sonnet-4-5-latest",
  "claude-haiku-4-5-latest",
  "claude-opus-4-1-latest",
];

/**
 * @type {import("./registry.js").ProviderAdapter}
 */
export const anthropic = {
  id: "anthropic",
  label: "Anthropic Claude",
  defaultEndpoint: "https://api.anthropic.com/v1/messages",
  authStyle: "header",
  authKeyName: "x-api-key",
  defaultModel: null,
  visionCapableModels: VISION_CAPABLE_MODELS,
  supportsJsonMode: true,
  jsonModeStyle: "prompt-only",
  timeoutMs: DEFAULT_TIMEOUT_MS,

  buildRequest(input) {
    const imageParts = Array.isArray(input.imageParts) ? input.imageParts : [];
    const maxTokens = imageParts.length > 0 ? MAX_TOKENS_VISION : MAX_TOKENS_TEXT;

    return {
      url: this.defaultEndpoint,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": input.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: {
        model: input.model,
        max_tokens: maxTokens,
        temperature: TEMPERATURE,
        system: input.systemPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: input.userPrompt }, ...imageParts],
          },
        ],
        tools: [
          {
            name: ANTHROPIC_TOOL_NAME,
            description: "Submit the structured risk assessment for the marketplace listing.",
            input_schema: RISK_VERDICT_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: ANTHROPIC_TOOL_NAME },
      },
    };
  },

  parseResponse(raw) {
    const body = typeof raw === "string" ? safeParseJson(raw) : raw;
    const blocks = /** @type {any} */ (body)?.content ?? [];
    const usage = /** @type {any} */ (body)?.usage;
    const parsedUsage =
      usage && typeof usage === "object"
        ? {
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
            outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
          }
        : undefined;
    const toolUse = blocks.find((b) => b?.type === "tool_use");
    if (toolUse && toolUse.input !== undefined) {
      return { text: JSON.stringify(toolUse.input), usage: parsedUsage };
    }
    const textParts = blocks
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .filter((t) => typeof t === "string" && t.length > 0);
    return { text: textParts.length > 0 ? textParts.join("\n") : null, usage: parsedUsage };
  },

  async testConnection(apiKey, model) {
    return runTestConnection(this, { apiKey, model });
  },
};
