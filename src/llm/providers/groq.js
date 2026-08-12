/**
 * groq.js — ProviderAdapter for Groq (PLAN-BACKEND.md §3.2 row 2).
 *
 * OpenAI-compatible chat-completions endpoint. Text-only on the free tier as
 * of the §3.2 verification pass — vision toggle must stay disabled for this
 * preset. 12s timeout per §4.4 (Groq's fast free tier).
 */

import { buildOpenAICompatibleRequest, parseOpenAICompatibleResponse, JSON_OBJECT_FORMAT } from "./openai-compat.js";
import { FAST_TIMEOUT_MS } from "./constants.js";
import { runTestConnection } from "./test-connection.js";

/**
 * @type {import("./registry.js").ProviderAdapter}
 */
export const groq = {
  id: "groq",
  label: "Groq",
  defaultEndpoint: "https://api.groq.com/openai/v1/chat/completions",
  authStyle: "bearer",
  authKeyName: "Authorization",
  defaultModel: "llama-3.3-70b-versatile",
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
