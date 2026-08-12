/**
 * custom.js — ProviderAdapter for a user-configured custom endpoint
 * (PLAN-BACKEND.md §3.2 row 10, §3.5).
 *
 * §3.5: the user supplies an endpoint, an auth style, a request shape
 * (openai-chat | gemini-native) and a JSON mode style. Because a static
 * preset can't know these, the adapter reads them from the buildRequest
 * input's OPTIONAL `custom*` fields (set by the options page / service
 * worker from ProviderSettings) and degrades to a documented default:
 * openai-chat shape, bearer auth, response_format json_object.
 *
 * This is an additive extension of the §3.1 interface — the fields are
 * documented on the input and ignored by every other adapter.
 */

import {
  buildOpenAICompatibleRequest,
  parseOpenAICompatibleResponse,
  JSON_OBJECT_FORMAT,
} from "./openai-compat.js";
import { TEMPERATURE, MAX_TOKENS_TEXT, MAX_TOKENS_VISION, DEFAULT_TIMEOUT_MS } from "./constants.js";
import { RISK_VERDICT_SCHEMA } from "../schema.js";
import { safeParseJson } from "../parse.js";
import { runTestConnection } from "./test-connection.js";

/**
 * @type {import("./registry.js").ProviderAdapter}
 */
export const custom = {
  id: "custom",
  label: "Custom endpoint",
  defaultEndpoint: null,
  authStyle: "bearer",
  authKeyName: "Authorization",
  defaultModel: null,
  visionCapableModels: [],
  supportsJsonMode: true,
  jsonModeStyle: "openai-response-format",
  timeoutMs: DEFAULT_TIMEOUT_MS,

  buildRequest(input) {
    const customRequestShape = input.customRequestShape ?? "openai-chat";
    const customJsonModeStyle = input.customJsonModeStyle ?? "openai-response-format";
    const customAuthStyle = input.customAuthStyle ?? "bearer";
    const customAuthKeyName = input.customAuthKeyName ?? "Authorization";

    if (customRequestShape === "gemini-native") {
      const imageParts = Array.isArray(input.imageParts) ? input.imageParts : [];
      const maxOutputTokens = imageParts.length > 0 ? MAX_TOKENS_VISION : MAX_TOKENS_TEXT;
      const text = [input.systemPrompt, input.userPrompt].filter(Boolean).join("\n\n");
      const body = {
        contents: [{ role: "user", parts: [{ text }, ...imageParts] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RISK_VERDICT_SCHEMA,
          maxOutputTokens,
          temperature: TEMPERATURE,
        },
      };
      const headers = { "Content-Type": "application/json" };
      if (customAuthStyle === "bearer") headers.Authorization = `Bearer ${input.apiKey}`;
      else if (customAuthStyle === "header" && customAuthKeyName) headers[customAuthKeyName] = input.apiKey;
      return { url: input.customEndpoint ?? this.defaultEndpoint, headers, body };
    }

    return buildOpenAICompatibleRequest({
      endpoint: input.customEndpoint ?? this.defaultEndpoint,
      model: input.model,
      authStyle: customAuthStyle,
      authKeyName: customAuthKeyName,
      apiKey: input.apiKey,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      imageParts: input.imageParts,
      // "prompt-only" drops response_format entirely (§3.5); the system
      // prompt then carries the full weight of format compliance and the
      // tolerantParse/repair pipeline becomes load-bearing.
      jsonModeStyle: customJsonModeStyle === "prompt-only" ? "prompt-only" : undefined,
      responseFormat: customJsonModeStyle === "openai-response-format" ? JSON_OBJECT_FORMAT : undefined,
    });
  },

  parseResponse(raw) {
    const body = typeof raw === "string" ? safeParseJson(raw) : raw;
    if (body && Array.isArray(body.candidates)) {
      const candidate = body.candidates[0];
      const parts = candidate?.content?.parts ?? [];
      const text = parts
        .map((p) => (typeof p?.text === "string" ? p.text : null))
        .filter((t) => t !== null && t.length > 0)
        .join("\n");
      return { text: text || null };
    }
    return parseOpenAICompatibleResponse(raw);
  },

  async testConnection(apiKey, model) {
    return runTestConnection(this, { apiKey, model });
  },
};
