#!/usr/bin/env node
/**
 * redact-fixture.js — scrub PII from captured listing HTML fixtures.
 * Per PLAN-FRONTEND.md §10: never commit real seller phone/email/name.
 * Usage: node scripts/redact-fixture.js <path-to-html> [--in-place]
 * Prints redacted output to stdout unless --in-place is given.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , file, flag] = process.argv;
if (!file) {
  console.error("Usage: node scripts/redact-fixture.js <html-file> [--in-place]");
  process.exit(1);
}

let html = readFileSync(file, "utf8");

// Phone numbers: +91-XXXXXXXXXX / 10-digit / with spaces/dashes
html = html.replace(/(?<!\d)(\+?91[\s-]?)?[6-9]\d{9}(?!\d)/g, "9999999999");
// Emails
html = html.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "test@example.com");
// WhatsApp numbers (with "whatsapp" hint nearby)
html = html.replace(/(whatsapp[^0-9]{0,20})\+?\d[\d\s-]{8,14}/gi, "$1 9999999999");

const out = `<!-- REDACTED by scripts/redact-fixture.js — PII replaced with placeholders -->\n${html}`;

if (flag === "--in-place") {
  writeFileSync(file, out);
  console.log(`Redacted in place: ${file}`);
} else {
  process.stdout.write(out);
}
