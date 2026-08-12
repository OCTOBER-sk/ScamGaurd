/**
 * mistral.js — ProviderAdapter for Mistral (PLAN-BACKEND.md §3.2 row 5).
 *
 * OpenAI-compatible chat-completions endpoint. Text-only. 20s timeout per
 * §4.4 (Mistral's Experiment tier can be slower than native fast tiers).
 */

import { buildOpenAICompatibleRequest, parseOpenAICompatibleResponse, JSON_OBJECT_FORMAT } from "./openai-compat.js";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";
import { runTestConnection } from "./test-connection.js";

/**
 * @type {import("./registry.js").ProviderAdapter}
 */
export const mistral = {
  id: "mistral",
  label: "Mistral AI",
  defaultEndpoint: "https://api.mistral.ai/v1/chat/completions",
  authStyle: "bearer",
  authKeyName: "Authorization",
  defaultModel: "mistral-small-latest",
  visionCapableModels: [],
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
