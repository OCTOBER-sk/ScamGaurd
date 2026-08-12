/**
 * deepseek.js — ProviderAdapter for DeepSeek (PLAN-BACKEND.md §3.2 row 6).
 *
 * OpenAI-compatible chat-completions endpoint. Text-only. `deepseek-chat`
 * maps to the current V-series flash-class model; DeepSeek retired old
 * aliases mid-2026 (source doc §5), so the exact ID is re-verified at build
 * time. 20s timeout per §4.4.
 */

import { buildOpenAICompatibleRequest, parseOpenAICompatibleResponse, JSON_OBJECT_FORMAT } from "./openai-compat.js";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";
import { runTestConnection } from "./test-connection.js";

/**
 * @type {import("./registry.js").ProviderAdapter}
 */
export const deepseek = {
  id: "deepseek",
  label: "DeepSeek",
  defaultEndpoint: "https://api.deepseek.com/v1/chat/completions",
  authStyle: "bearer",
  authKeyName: "Authorization",
  defaultModel: "deepseek-chat",
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
