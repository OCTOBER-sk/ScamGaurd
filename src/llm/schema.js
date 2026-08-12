/**
 * schema.js — the §4.5 structured-output schema + a hand-rolled validator
 * (PLAN-BACKEND.md §4.5, §6 "Schema mismatch" row).
 *
 * `RISK_VERDICT_SCHEMA` is the single shared JSON-Schema object for the
 * listing-analysis LLM verdict. Provider adapters transform it into their
 * own request format (Gemini `responseSchema`, OpenAI/OpenRouter
 * `response_format`, Anthropic tool `input_schema`). It is NOT an external
 * validation library — `validate()` below is a small manual walker matching
 * the exact §4.5 shape, keeping this package zero-runtime-dep.
 *
 * Deliberate, documented deviations from the §4.5 literal text:
 *   - `redFlags` items additionally require `id` and `label` to be non-empty
 *     strings, and `severity` to be one of low|medium|high — the plan's
 *     schema already declares these `required`, so this is tightening the
 *     runtime check to the declared contract, not adding fields.
 *   - `summary` is validated as a string (may be empty per the plan schema;
 *     callers decide how to render it).
 */

/** @typedef {import("./parse.js")} parseJs */

/**
 * §4.5 structured-output schema object. Used verbatim as the provider-level
 * schema (transformed per provider style in §3.2), and by `validate()`.
 *
 * @type {object}
 */
export const RISK_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    llmScore: { type: "integer", minimum: 0, maximum: 100 },
    notAListing: { type: "boolean" },
    redFlags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          explanation: { type: "string" },
        },
        required: ["id", "label", "severity", "explanation"],
      },
    },
    summary: { type: "string" },
    checklistAdditions: { type: "array", items: { type: "string" } },
    visionNotes: { type: "array", items: { type: "string" } },
  },
  required: ["llmScore", "redFlags", "summary", "checklistAdditions", "visionNotes"],
};

const SEVERITIES = new Set(["low", "medium", "high"]);

/**
 * @typedef {object} ValidationResult
 * @property {boolean} valid
 * @property {string[]} errors  Human-readable messages; empty when valid.
 */

/**
 * Validate a candidate verdict object against the §4.5 schema. Returns
 * `{ valid: true, errors: [] }` or `{ valid: false, errors: [...] }`.
 * Never throws — callers pass the result into the §6 repair decision.
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validate(value) {
  const errors = [];

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["verdict is not an object"] };
  }
  const obj = /** @type {Record<string, unknown>} */ (value);

  const has = (key) => Object.prototype.hasOwnProperty.call(obj, key);

  for (const required of RISK_VERDICT_SCHEMA.required) {
    if (!has(required)) errors.push(`missing required field: ${required}`);
  }

  if (has("llmScore")) {
    const s = obj.llmScore;
    if (typeof s !== "number" || !Number.isInteger(s) || s < 0 || s > 100) {
      errors.push("llmScore must be an integer between 0 and 100");
    }
  }

  if (has("notAListing") && typeof obj.notAListing !== "boolean") {
    errors.push("notAListing must be a boolean");
  }

  if (has("redFlags")) {
    if (!Array.isArray(obj.redFlags)) {
      errors.push("redFlags must be an array");
    } else {
      for (const [i, flag] of obj.redFlags.entries()) {
        if (!flag || typeof flag !== "object" || Array.isArray(flag)) {
          errors.push(`redFlags[${i}] is not an object`);
          continue;
        }
        const f = /** @type {Record<string, unknown>} */ (flag);
        if (typeof f.id !== "string" || f.id.length === 0) errors.push(`redFlags[${i}].id must be a non-empty string`);
        if (typeof f.label !== "string" || f.label.length === 0) errors.push(`redFlags[${i}].label must be a non-empty string`);
        if (typeof f.severity !== "string" || !SEVERITIES.has(f.severity)) {
          errors.push(`redFlags[${i}].severity must be one of low|medium|high`);
        }
        if (typeof f.explanation !== "string" || f.explanation.length === 0) {
          errors.push(`redFlags[${i}].explanation must be a non-empty string`);
        }
      }
    }
  }

  if (has("summary") && typeof obj.summary !== "string") {
    errors.push("summary must be a string");
  }

  for (const key of ["checklistAdditions", "visionNotes"]) {
    if (has(key)) {
      if (!Array.isArray(obj[key])) {
        errors.push(`${key} must be an array`);
      } else {
        for (const [i, item] of obj[key].entries()) {
          if (typeof item !== "string") errors.push(`${key}[${i}] must be a string`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
