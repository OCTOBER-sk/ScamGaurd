/**
 * gemini.js — ProviderAdapter for Google Gemini (PLAN-BACKEND.md §3.2 row 1).
 *
 * Targets the LEGACY `generateContent` endpoint (chosen in §0.3 over the new
 * Interactions API for v1 simplicity): POST .../models/{model}:generateContent
 * with `x-goog-api-key`, `responseMimeType: "application/json"` +
 * `responseSchema` for structured output, and native inline-image parts for
 * vision. Swapping to the Interactions API later is a config change in this
 * one adapter, not a rewrite.
 */

import { safeParseJson } from "../parse.js";
import {
  TEMPERATURE,
  MAX_TOKENS_TEXT,
  MAX_TOKENS_VISION,
} from "./constants.js";
import { RISK_VERDICT_SCHEMA } from "../schema.js";
import { runTestConnection } from "./test-connection.js";

/**
 * Model IDs known to accept image input. Gemini rotates model IDs faster
 * than a build can track (§3.2 row 1 note), so this is a curated list of the
 * flash-class multimodal families; the options-page "Test connection" flow
 * (ListModels / manual override) is the source of truth for current IDs.
 *
 * @type {string[]}
 */
const VISION_CAPABLE_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-flash",
  "gemini-3-flash-lite",
  "gemini-3-pro",
  "gemini-3-pro-flash",
];

/**
 * @type {import("./registry.js").ProviderAdapter}
 */
export const gemini = {
  id: "gemini",
  label: "Google Gemini",
  defaultEndpoint:
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
  authStyle: "header",
  authKeyName: "x-goog-api-key",
  defaultModel: "gemini-2.5-flash",
  visionCapableModels: VISION_CAPABLE_MODELS,
  supportsJsonMode: true,
  jsonModeStyle: "gemini-response-schema",
  timeoutMs: 20000,

  buildRequest(input) {
    const imageParts = Array.isArray(input.imageParts) ? input.imageParts : [];
    const maxOutputTokens = imageParts.length > 0 ? MAX_TOKENS_VISION : MAX_TOKENS_TEXT;
    const text = [input.systemPrompt, input.userPrompt].filter(Boolean).join("\n\n");

    return {
      url: this.defaultEndpoint.replace("{model}", encodeURIComponent(input.model)),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": input.apiKey,
      },
      body: {
        contents: [
          {
            role: "user",
            parts: [{ text }, ...imageParts],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RISK_VERDICT_SCHEMA,
          maxOutputTokens,
          temperature: TEMPERATURE,
        },
      },
    };
  },

  parseResponse(raw) {
    const body = typeof raw === "string" ? safeParseJson(raw) : raw;
    const candidate = /** @type {any} */ (body)?.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const textParts = parts
      .map((p) => (typeof p?.text === "string" ? p.text : null))
      .filter((t) => t !== null && t.length > 0);
    const text = textParts.length > 0 ? textParts.join("\n") : null;

    const um = /** @type {any} */ (body)?.usageMetadata;
    return {
      text,
      usage:
        um && typeof um === "object"
          ? {
              inputTokens: typeof um.promptTokenCount === "number" ? um.promptTokenCount : null,
              outputTokens: typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : null,
            }
          : undefined,
    };
  },

  async testConnection(apiKey, model) {
    return runTestConnection(this, { apiKey, model });
  },
};
