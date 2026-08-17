/**
 * constants.js — shared provider-layer constants (PLAN-BACKEND.md §3.2, §4.4,
 * §3.6). Zero runtime deps; safe to import from any extension context.
 */

/**
 * Sampling temperature for risk analysis (§4.4): low for run-to-run
 * consistency, not creative-writing territory.
 *
 * @type {number}
 */
export const TEMPERATURE = 0.2;

/**
 * Token budgets per §4.4. Vision requests carry the extra `visionNotes`
 * array, so they get more room.
 *
 * @type {number}
 */
export const MAX_TOKENS_TEXT = 1024;
/** @type {number} */
export const MAX_TOKENS_VISION = 1536;

/**
 * Default per-provider request timeout (ms). §4.4: Groq/Cerebras 12s,
 * everything else 20s. Used by the client (§6) when a provider has no
 * tighter configured value.
 *
 * @type {number}
 */
export const DEFAULT_TIMEOUT_MS = 20000;

/** @type {number} */
export const FAST_TIMEOUT_MS = 12000;

/**
 * Anthropic API version header required by all /v1/messages requests
 * (§3.2 row 8).
 *
 * @type {string}
 */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Anthropic forced-tool JSON pattern (§3.2 row 8): the model is told to call
 * exactly one tool whose input is the §4.5 verdict. This is the standard
 * no-native-response_format workaround for Claude.
 *
 * @type {string}
 */
export const ANTHROPIC_TOOL_NAME = "submit_risk_verdict";

/**
 * OpenRouter pinned-`:free`-model default. §0.4 / §3.2 row 4: NEVER default
 * to `openrouter/free` (the auto-router) — it routes unpredictably and can
 * land on reasoning models that ignore response_format. Instead pin an
 * explicit `:free` model. The exact current slug is resolved at runtime in
 * the options page's provider-preset fetch (OpenRouter's free catalog
 * rotates); this is the documented fallback default, NOT authoritative.
 *
 * @type {string}
 */
export const OPENROUTER_DEFAULT_MODEL = "openai/gpt-oss-20b:free";

/**
 * Name required by OpenRouter's `json_schema` response_format variant
 * (OpenAI-style structured output needs a schema `name`).
 *
 * @type {string}
 */
export const OPENROUTER_SCHEMA_NAME = "risk_verdict";

/**
 * `timeoutMs` default values per §4.4: 12s for Groq/Cerebras (their fast
 * free tiers), 20s for everyone else. Used by the provider presets in
 * §3.2 and by client.js as a floor.
 *
 * @type {number}
 */
export const RETRY_BACKOFF_MS = 1500;

/**
 * The §6 single automatic-retry budget: 5xx gets exactly one retry.
 *
 * @type {number}
 */
export const MAX_5XX_RETRIES = 1;
