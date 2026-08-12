/**
 * openai.js — ProviderAdapter for OpenAI (PLAN-BACKEND.md §3.2 row 7).
 *
 * OpenAI-compatible chat-completions endpoint. No free tier — the model is
 * user-specified (defaultModel is null; the options page must collect one).
 * Vision-capable. JSON mode is `response_format: {type:"json_object"}`
 * (per the phase-3 spec's "OpenAI-compatible: response_format json_object"
 * rule); the stricter `json_schema` + `strict:true` variant is a documented
 * future option — the tolerantParse + schema.validate + §6 repair pipeline
 * already gives equivalent output-safety. 20s timeout per §4.4.
 */

import { buildOpenAICompatibleRequest, parseOpenAICompatibleResponse, JSON_OBJECT_FORMAT } from "./openai-compat.js";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";
import { runTestConnection } from "./test-connection.js";

/**
 * Model IDs known to accept image input (GPT-4o / 4.1 / 4.5 families).
 *
 * @type {string[]}
 */
const VISION_CAPABLE_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4.5",
  "gpt-4.5-preview",
  "gpt-5",
];

/**
 * @type {import("./registry.js").ProviderAdapter}
 */
export const openai = {
  id: "openai",
  label: "OpenAI",
  defaultEndpoint: "https://api.openai.com/v1/chat/completions",
  authStyle: "bearer",
  authKeyName: "Authorization",
  defaultModel: null,
  visionCapableModels: VISION_CAPABLE_MODELS,
  supportsJsonMode: true,
  jsonModeStyle: "openai-response-format",
  timeoutMs: DEFAULT_TIMEOUT_MS,

  buildRequest(input) {
    return buildOpenAICompatibleRequest({
      endpoint: this.defaultEndpoint,
      model: input.model,
      authStyle: this.authStyle,
      authKeyName: this.authKeyName,
      apiKey: input.apiKey,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      imageParts: input.imageParts,
      responseFormat: JSON_OBJECT_FORMAT,
    });
  },

  parseResponse(raw) {
    return parseOpenAICompatibleResponse(raw);
  },

  async testConnection(apiKey, model) {
    return runTestConnection(this, { apiKey, model });
  },
};
