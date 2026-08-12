/**
 * registry.js — provider registry (PLAN-BACKEND.md §3.1, §8 file plan).
 *
 * `get(id)` returns the matching ProviderAdapter or `null`; `list()` returns
 * every adapter in the §3.2 table order. The typedef for the shared
 * `ProviderAdapter` interface lives here so every adapter module can
 * reference it via JSDoc `import()` without a circular runtime import.
 */

import { gemini } from "./gemini.js";
import { groq } from "./groq.js";
import { cerebras } from "./cerebras.js";
import { openrouter } from "./openrouter.js";
import { mistral } from "./mistral.js";
import { deepseek } from "./deepseek.js";
import { openai } from "./openai.js";
import { anthropic } from "./anthropic.js";
import { ollama } from "./ollama.js";
import { custom } from "./custom.js";

/**
 * @typedef {"gemini" | "groq" | "cerebras" | "openrouter" | "mistral" |
 *   "deepseek" | "openai" | "anthropic" | "ollama" | "custom"} ProviderId
 */

/**
 * @typedef {"bearer" | "header" | "query-param" | "none"} ProviderAuthStyle
 * @typedef {"openai-response-format" | "gemini-response-schema" | "prompt-only"} ProviderJsonModeStyle
 */

/**
 * @typedef {object} ProviderRequest
 * @property {string} url
 * @property {Record<string, string>} headers
 * @property {unknown} body
 */

/**
 * @typedef {object} ProviderParsedResponse
 * @property {string | null} text
 * @property {{ inputTokens: number | null; outputTokens: number | null }} [usage]
 */

/**
 * ProviderAdapter interface (§3.1). Every preset in §3.2 implements exactly
 * this shape. `defaultModel` / `defaultEndpoint` may be `null` for the
 * user-specified rows (openai, anthropic, ollama, custom) — the options
 * page must collect a value before those can be used.
 *
 * The `buildRequest` input carries optional `custom*` fields that ONLY the
 * `custom` adapter reads (endpoint, auth style, JSON mode, request shape) —
 * an additive extension of §3.1 so ProviderSettings can be applied.
 *
 * @typedef {object} ProviderAdapter
 * @property {ProviderId} id
 * @property {string} label
 * @property {string | null} defaultEndpoint
 * @property {ProviderAuthStyle} authStyle
 * @property {string | null} authKeyName
 * @property {string | null} defaultModel
 * @property {string[]} visionCapableModels   model IDs known to accept image input.
 * @property {boolean} supportsJsonMode
 * @property {ProviderJsonModeStyle} jsonModeStyle
 * @property {number} timeoutMs               §4.4: 12s groq/cerebras, 20s others.
 * @property {(input: {
 *   listing: import("../shared/types.js").Listing | null;
 *   heuristics: import("../shared/types.js").HeuristicSignals | null;
 *   systemPrompt: string;
 *   userPrompt: string;
 *   imageParts?: Array<Record<string, unknown>>;
 *   model: string;
 *   apiKey: string;
 *   customEndpoint?: string | null;
 *   customAuthStyle?: ProviderAuthStyle;
 *   customAuthKeyName?: string | null;
 *   customJsonModeStyle?: ProviderJsonModeStyle;
 *   customRequestShape?: "openai-chat" | "gemini-native";
 * }) => ProviderRequest} buildRequest
 * @property {(raw: unknown) => ProviderParsedResponse} parseResponse
 * @property {(apiKey: string, model: string) => Promise<{ ok: boolean; message: string }>} testConnection
 */

/**
 * All ten adapters, in §3.2 table order (canonical list() order).
 *
 * @type {ProviderAdapter[]}
 */
const PROVIDERS = [
  gemini,
  groq,
  cerebras,
  openrouter,
  mistral,
  deepseek,
  openai,
  anthropic,
  ollama,
  custom,
];

/**
 * Look up a provider adapter by id.
 *
 * @param {string | null | undefined} id
 * @returns {ProviderAdapter | null}
 */
export function get(id) {
  if (typeof id !== "string" || id.length === 0) return null;
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * List all registered adapters (a fresh array; safe to mutate by callers).
 *
 * @returns {ProviderAdapter[]}
 */
export function list() {
  return [...PROVIDERS];
}
