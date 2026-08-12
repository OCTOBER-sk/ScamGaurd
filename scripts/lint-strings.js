#!/usr/bin/env node
/**
 * lint-strings.js — i18n boundary guard (PLAN-FRONTEND.md §9 "i18n boundary").
 *
 * Flags string-literal concatenation assigned to `.textContent` / `.innerText`
 * in UI component code. All user-visible copy must route through the `t()`
 * helper from src/shared/i18n.js (§7); hardcoding assembled strings inline
 * (e.g. `"Connected — " + model + " responded"`) turns the future Hindi/Tamil
 * locale into a refactor instead of an addition.
 *
 * The only place string literals may live is the string catalog itself:
 * `src/strings/` (the `.textContent` rule simply does not apply there).
 *
 * Scope: every `.js` file under `src/` (minus `src/strings/`), plus the two
 * root-level pages `popup.js` and `options.js`. `content/extractor.js` and
 * `test/` are intentionally out of scope — the extractor READS page text for
 * scraping (not UI copy), and tests own their own fixture strings.
 *
 * Exit status: 0 = clean, 1 = one or more violations.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["src"];
const SCAN_FILES = ["popup.js", "options.js"];
const EXCLUDED_DIRS = new Set(["strings"]);

/** `.textContent` / `.innerText` assignment (captures the property, op, RHS). */
const ASSIGN_RE = /\.(textContent|innerText)\s*(\+=|=)\s*/g;

/**
 * True when `rhs` performs string-literal concatenation:
 *  - a quoted literal directly adjacent to a `+` operator, or
 *  - a template literal with `${...}` interpolation (the modern form of
 *    "literal + dynamic" assembly).
 */
function isStringConcat(rhs) {
  if (/["'`]\s*\+/.test(rhs)) return true;
  if (/\+\s*["'`]/.test(rhs)) return true;
  if (/`[^`]*\$\{[\s\S]*\}`/.test(rhs)) return true;
  return false;
}

/** True when the RHS is (or begins with) the allowed `t(...)` helper. */
function isTHelper(rhs) {
  return /^\s*t\s*\(/.test(rhs);
}

/**
 * Check a single assignment statement. Returns a violation string or null.
 *
 * @param {string} rhs    The right-hand side (raw source text).
 * @param {string} op     The assignment operator: `=` or `+=`.
 * @param {string} prop   The DOM property: `textContent` or `innerText`.
 * @returns {string | null}
 */
function checkAssignment(rhs, op, prop) {
  const trimmed = rhs.trim();
  if (isTHelper(trimmed)) return null;

  if (op === "+=") {
    // Compound assignment is itself string concatenation; any string literal
    // on the RHS (other than the t() helper) is hardcoded copy being appended.
    if (/(["'`])/.test(trimmed)) {
      return `\`.${prop}\` compound-assigned a string literal: ${preview(trimmed)}`;
    }
    return null;
  }

  if (isStringConcat(trimmed)) {
    return `string-literal concatenation assigned to \`.${prop}\`: ${preview(trimmed)}`;
  }
  return null;
}

/** Short, single-line preview of the offending expression. */
function preview(rhs) {
  const oneLine = rhs.replace(/\s+/g, " ").trim();
  return oneLine.length > 72 ? oneLine.slice(0, 72) + "…" : oneLine;
}

/** Recursively collect `.js` files under `dir`, skipping excluded subtrees. */
function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan one file for violations. Returns a list of `file:line: message`.
 *
 * @param {string} path
 * @returns {string[]}
 */
function scanFile(path) {
  const code = readFileSync(path, "utf8");
  const violations = [];
  const lineOf = (index) => code.slice(0, index).split("\n").length;

  ASSIGN_RE.lastIndex = 0;
  let match;
  while ((match = ASSIGN_RE.exec(code)) !== null) {
    const op = match[2];
    const prop = match[1];
    const rhsStart = ASSIGN_RE.lastIndex;

    // Walk forward from `=` to the end of the statement: a `;` at bracket
    // depth zero and outside any string/template literal. This lets RHS
    // expressions span multiple lines without tripping on the terminator.
    let quote = null;
    let escaped = false;
    let depth = 0;
    let end = rhsStart;
    for (; end < code.length; end++) {
      const ch = code[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth = Math.max(0, depth - 1);
      } else if (ch === ";" && depth === 0) {
        break;
      }
    }

    const rhs = code.slice(rhsStart, end);
    const problem = checkAssignment(rhs, op, prop);
    if (problem) {
      violations.push(
        `${path}:${lineOf(match.index)}: ${problem} — route visible copy through t("…")`
      );
    }

    // Resume scanning after the statement (never re-scan from inside the RHS).
    ASSIGN_RE.lastIndex = end;
  }

  return violations;
}

function main() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    files.push(...collectJsFiles(join(ROOT, dir)));
  }
  for (const file of SCAN_FILES) {
    files.push(join(ROOT, file));
  }

  const violations = [];
  for (const file of files) {
    violations.push(...scanFile(file));
  }

  if (violations.length > 0) {
    console.error("lint-strings: i18n boundary violations found:\n");
    for (const v of violations) console.error(`  - ${relative(ROOT, v)}`);
    console.error(
      `\n${violations.length} violation(s) in ${files.length} scanned file(s).\n` +
        `UI copy must come from the t() helper (src/shared/i18n.js), not inline string concatenation (PLAN-FRONTEND.md §7/§9).`
    );
    process.exit(1);
  }

  console.log(
    `lint-strings: ok — ${files.length} scanned, no hardcoded string-literal concatenation in .textContent/.innerText assignments`
  );
  process.exit(0);
}

main();
