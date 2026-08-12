/**
 * cerebras.js — ProviderAdapter for Cerebras (PLAN-BACKEND.md §3.2 row 3).
 *
 * OpenAI-compatible chat-completions endpoint. §0.2: free tier is generous
 * (~1M tokens/day, 30 RPM) but the free-tier CONTEXT is capped at ~8,192
 * tokens, so the default model is the fast llama3.1-8b and the prompt layer
 * truncates long descriptions (§4.6). Text-only. 12s timeout per §4.4.
 */

import { buildOpenAICompatibleRequest, parseOpenAICompatibleResponse, JSON_OBJECT_FORMAT } from "./openai-compat.js";
import { FAST_TIMEOUT_MS } from "./constants.js";
import { runTestConnection } from "./test-connection.js";

/**
 * @type {import("./registry.js").ProviderAdapter}
 */
export const cerebras = {
  id: "cerebras",
  label: "Cerebras",
  defaultEndpoint: "https://api.cerebras.ai/v1/chat/completions",
  authStyle: "bearer",
  authKeyName: "Authorization",
  defaultModel: "llama3.1-8b",
  visionCapableModels: [],
  supportsJsonMode: true,
  jsonModeStyle: "openai-response-format",
  timeoutMs: FAST_TIMEOUT_MS,

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
