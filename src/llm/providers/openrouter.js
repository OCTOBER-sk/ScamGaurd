/**
 * openrouter.js — ProviderAdapter for OpenRouter (PLAN-BACKEND.md §3.2 row 4).
 *
 * §0.4 rules, enforced here:
 *   - NEVER default to the `openrouter/free` auto-router — it "routes
 *     unpredictably" and can land on reasoning models with unpredictable
 *     latency that ignore response_format.
 *   - Pin an explicit `:free` model (`OPENROUTER_DEFAULT_MODEL`); the exact
 *     current slug is resolved at runtime in the options page's
 *     provider-preset fetch because OpenRouter's free catalog rotates.
 *   - Use `response_format` json_schema when the pinned model supports it,
 *     falling back to json_object. The adapter exposes `preferJsonSchema`;
 *     the options page flips it based on the model's `supported_parameters`.
 *
 * 20s timeout per §4.4 (routed free models can be slower than native).
 */

import { buildOpenAICompatibleRequest, parseOpenAICompatibleResponse } from "./openai-compat.js";
import {
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_SCHEMA_NAME,
  DEFAULT_TIMEOUT_MS,
} from "./constants.js";
import { RISK_VERDICT_SCHEMA } from "../schema.js";
import { runTestConnection } from "./test-connection.js";

/**
 * @type {import("./registry.js").ProviderAdapter}
 */
export const openrouter = {
  id: "openrouter",
  label: "OpenRouter",
  defaultEndpoint: "https://openrouter.ai/api/v1/chat/completions",
  authStyle: "bearer",
  authKeyName: "Authorization",
  defaultModel: OPENROUTER_DEFAULT_MODEL,
  visionCapableModels: [
    "google/gemini-2.5-flash:free",
    "qwen/qwen2.5-vl-7b-instruct:free",
  ],
  supportsJsonMode: true,
  jsonModeStyle: "openai-response-format",
  // §3.2 row 4: json_schema when the pinned model supports it, else
  // json_object. Flipped by the options page per the model's
  // supported_parameters; this is the documented v1 default.
  preferJsonSchema: true,
  timeoutMs: DEFAULT_TIMEOUT_MS,

  buildRequest(input) {
    const responseFormat = this.preferJsonSchema
      ? {
          type: "json_schema",
          json_schema: {
            name: OPENROUTER_SCHEMA_NAME,
            strict: false,
            schema: RISK_VERDICT_SCHEMA,
          },
        }
      : { type: "json_object" };

    return buildOpenAICompatibleRequest({
      endpoint: this.defaultEndpoint,
      model: input.model,
      authStyle: this.authStyle,
      authKeyName: this.authKeyName,
      apiKey: input.apiKey,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      imageParts: input.imageParts,
      responseFormat,
    });
  },

  parseResponse(raw) {
    return parseOpenAICompatibleResponse(raw);
  },

  async testConnection(apiKey, model) {
    return runTestConnection(this, { apiKey, model });
  },
};
