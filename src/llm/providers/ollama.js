/**
 * ollama.js — ProviderAdapter for local Ollama (PLAN-BACKEND.md §3.2 row 9).
 *
 * Local OpenAI-compatible endpoint at http://localhost:11434/v1/chat/
 * completions. NO auth header. Model is user-specified (e.g. llama3.1:8b).
 * Vision is model-dependent and can't be known statically for arbitrary
 * local models — leave `visionCapableModels` empty for v1; local vision
 * support is a documented future enhancement.
 */

import { buildOpenAICompatibleRequest, parseOpenAICompatibleResponse, JSON_OBJECT_FORMAT } from "./openai-compat.js";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";
import { runTestConnection } from "./test-connection.js";

/**
 * @type {import("./registry.js").ProviderAdapter}
 */
export const ollama = {
  id: "ollama",
  label: "Ollama (local)",
  defaultEndpoint: "http://localhost:11434/v1/chat/completions",
  authStyle: "none",
  authKeyName: null,
  defaultModel: null,
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
