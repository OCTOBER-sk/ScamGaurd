/**
 * heuristics.test.js — deterministic heuristic signals (node:test, zero deps).
 *
 * Fixture cases per PLAN-BACKEND.md §9.2:
 *   - scammy listing   → heuristicScore ≥ 70 (price 0.3×, 0 photos, 1 item,
 *                        "pay advance via UPI, urgent sale today only")
 *   - legit listing    → heuristicScore ≤ 15 (market price, 5 photos, 40 items)
 *   - ambiguous listing → low score, single weak signal never over-triggers
 * Plus targeted tests for category matching, price ratios, language-pattern
 * matching (EN + Hinglish) and contact-leak redaction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import priceTable from "../src/heuristics/price-table.json" with { type: "json" };
import { run, matchCategory, computePriceRatio, redactMatch } from "../src/heuristics/signals.js";
import {
  matchTextAgainstPatterns,
  URGENCY_LANGUAGE_PATTERNS,
  ADVANCE_FEE_LANGUAGE_PATTERNS,
  OFF_PLATFORM_PAYMENT_LANGUAGE_PATTERNS,
} from "../src/heuristics/language-patterns.js";

/** @param {string} categoryId @returns {number} typical-range midpoint */
function midpoint(categoryId) {
  const [min, max] = priceTable.categories[categoryId].rangeInr;
  return (min + max) / 2;
}

/** @param {object} overrides @returns {import("../shared/types.js").Listing} */
function makeListing(overrides = {}) {
  return {
    platform: "olx",
    url: "https://www.olx.in/item/test-iid-1",
    adId: "1",
    title: null,
    price: { amount: null, currency: "INR", raw: null },
    description: null,
    sellerName: null,
    sellerMemberSince: null,
    sellerItemsListed: null,
    sellerVerified: null,
    location: null,
    postedAt: null,
    images: [],
    imageCount: 0,
    extractionConfidence: "high",
    extractedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("§9.2 scammy listing: low price (0.3x), 0 photos, new seller, advance+UPI+urgency language -> score >= 70", () => {
  const price = Math.round(midpoint("laptops") * 0.3);
  const signals = run(
    makeListing({
      title: "HP Pavilion Laptop",
      description: "HP Pavilion 15 laptop. pay advance via UPI, urgent sale today only.",
      price: { amount: price, currency: "INR", raw: `₹ ${price}` },
      imageCount: 0,
      sellerItemsListed: 1,
      sellerMemberSince: "Jan 2026",
    }),
  );

  assert.ok(signals.heuristicScore >= 70, `expected >= 70, got ${signals.heuristicScore}`);
  assert.ok(Number.isInteger(signals.heuristicScore));

  // Price anomaly: ratio 0.3 → full 30 points, severity "high".
  assert.equal(signals.priceAnomaly.triggered, true);
  assert.equal(signals.priceAnomaly.severity, "high");
  assert.ok(signals.priceAnomaly.ratioVsCategoryTypical < 0.4);
  assert.ok(signals.priceAnomaly.note.length > 0);

  // Language signals all fire.
  assert.equal(signals.offPlatformPaymentLanguage.triggered, true);
  assert.equal(signals.advanceFeeLanguage.triggered, true);
  assert.equal(signals.urgencyLanguage.triggered, true);

  // Seller + photo signals fire.
  assert.equal(signals.sellerAge.triggered, true);
  assert.equal(signals.sellerAge.itemsListed, 1);
  assert.equal(signals.photoSignals.triggered, true);
  assert.equal(signals.photoSignals.count, 0);

  assert.match(signals.computedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("§9.2 legit listing: market price, 5 photos, 40 items since 2019 -> score <= 15", () => {
  const price = Math.round(midpoint("phones"));
  const signals = run(
    makeListing({
      title: "Samsung Galaxy M14 4GB 128GB",
      description: "Samsung Galaxy M14 4GB/128GB, 9 months old, bill and box available.",
      price: { amount: price, currency: "INR", raw: `₹ ${price}` },
      imageCount: 5,
      sellerItemsListed: 40,
      sellerMemberSince: "Feb 2019",
    }),
  );

  assert.ok(signals.heuristicScore <= 15, `expected <= 15, got ${signals.heuristicScore}`);
  assert.equal(signals.priceAnomaly.triggered, false);
  assert.equal(signals.priceAnomaly.severity, "none");
  assert.equal(signals.photoSignals.triggered, false);
  assert.equal(signals.sellerAge.triggered, false);
  assert.equal(signals.urgencyLanguage.triggered, false);
  assert.equal(signals.advanceFeeLanguage.triggered, false);
  assert.equal(signals.offPlatformPaymentLanguage.triggered, false);
  assert.equal(signals.contactChannelLeak.triggered, false);
});

test("§9.2 ambiguous listing: slightly low price only -> noticed but never over-triggers", () => {
  const price = Math.round(midpoint("tvs") * 0.7);
  const signals = run(
    makeListing({
      title: "Mi LED TV 32 inch",
      description: "Mi LED TV 32 inch smart android tv, working fine.",
      price: { amount: price, currency: "INR", raw: `₹ ${price}` },
      imageCount: 3,
      sellerItemsListed: 40,
      sellerMemberSince: "Feb 2019",
    }),
  );

  // A single weak signal must not produce a meaningful score.
  assert.ok(signals.heuristicScore <= 15, `expected <= 15, got ${signals.heuristicScore}`);
  assert.equal(signals.priceAnomaly.triggered, true);
  assert.equal(signals.priceAnomaly.severity, "low");
  assert.ok(signals.priceAnomaly.ratioVsCategoryTypical > 0.6);
  assert.ok(signals.priceAnomaly.ratioVsCategoryTypical < 0.9);
  // ...and nothing else fired.
  assert.equal(signals.photoSignals.triggered, false);
  assert.equal(signals.sellerAge.triggered, false);
  assert.equal(signals.urgencyLanguage.triggered, false);
  assert.equal(signals.advanceFeeLanguage.triggered, false);
  assert.equal(signals.offPlatformPaymentLanguage.triggered, false);
});

test("unknown category / missing price: price anomaly not triggered, no throw", () => {
  const noCategory = run(
    makeListing({
      title: "Antique chess set",
      description: "Hand-carved wooden chess set.",
      price: { amount: 500, currency: "INR", raw: "₹ 500" },
      sellerItemsListed: 5,
    }),
  );
  assert.equal(noCategory.priceAnomaly.triggered, false);
  assert.equal(noCategory.priceAnomaly.ratioVsCategoryTypical, null);
  assert.equal(noCategory.heuristicScore, 0);

  const noPrice = run(
    makeListing({ title: "HP Pavilion Laptop", description: "Laptop for sale", sellerItemsListed: 5 }),
  );
  assert.equal(noPrice.priceAnomaly.triggered, false);
  assert.equal(noPrice.priceAnomaly.ratioVsCategoryTypical, null);
});

test("fully-empty listing: nulls everywhere still produce a complete signal object", () => {
  const signals = run(makeListing());
  assert.equal(signals.heuristicScore, 5); // unknown items-listed → the §5.1 mild 5-point penalty
  assert.equal(signals.priceAnomaly.triggered, false);
  assert.equal(signals.sellerAge.triggered, false);
  assert.equal(signals.sellerAge.itemsListed, null);
  assert.equal(signals.contactChannelLeak.matches.length, 0);
  assert.match(signals.computedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("contact-channel leak: phone in description is flagged and redacted, +10 points", () => {
  const signals = run(
    makeListing({
      title: "HP Pavilion Laptop",
      description: "Great condition laptop. My number is 9876543210.",
      price: { amount: 80000, currency: "INR", raw: "₹ 80,000" },
      imageCount: 3,
      sellerItemsListed: 5,
    }),
  );
  assert.equal(signals.contactChannelLeak.triggered, true);
  assert.ok(signals.contactChannelLeak.matches.length >= 1);
  // Redacted form — full PII must never be stored.
  for (const match of signals.contactChannelLeak.matches) {
    assert.ok(!match.includes("9876543210"), "full phone number leaked into signal");
  }
  assert.equal(signals.heuristicScore, 10);
});

test("matchCategory picks the best-fit category by keyword hits", () => {
  assert.equal(matchCategory(makeListing({ title: "HP Pavilion Laptop", description: "" })), "laptops");
  assert.equal(matchCategory(makeListing({ title: "Samsung Galaxy M14", description: "" })), "phones");
  assert.equal(matchCategory(makeListing({ title: "Mi LED TV 32 inch", description: "smart android tv" })), "tvs");
  assert.equal(matchCategory(makeListing({ title: "No match here", description: "" })), null);
});

test("computePriceRatio: price / midpoint, null when price unusable", () => {
  const [min, max] = priceTable.categories.laptops.rangeInr;
  const mid = (min + max) / 2;
  assert.equal(computePriceRatio(mid, "laptops"), 1);
  assert.equal(computePriceRatio(mid * 0.3, "laptops"), 0.3);
  assert.equal(computePriceRatio(null, "laptops"), null);
  assert.equal(computePriceRatio(0, "laptops"), null);
  assert.equal(computePriceRatio(-100, "laptops"), null);
});

test("redactMatch never exposes full PII", () => {
  assert.equal(redactMatch("9876543210"), "98••••••10");
  assert.equal(redactMatch("+919876543210"), "91••••••••10");
  assert.equal(redactMatch("test.seller@example.com"), "te•••@example.com");
  assert.equal(redactMatch("not contact info"), "•••");
});

test("language patterns: English phrases match", () => {
  const urgency = matchTextAgainstPatterns("URGENT SALE today only, first come first serve", URGENCY_LANGUAGE_PATTERNS);
  assert.ok(urgency.includes("urgent sale"));
  assert.ok(urgency.includes("today only"));

  const advance = matchTextAgainstPatterns("needs booking amount and token advance", ADVANCE_FEE_LANGUAGE_PATTERNS);
  assert.ok(advance.includes("booking amount"));
  assert.ok(advance.includes("token advance"));

  const offPlatform = matchTextAgainstPatterns("pay via UPI or gpay only", OFF_PLATFORM_PAYMENT_LANGUAGE_PATTERNS);
  assert.ok(offPlatform.includes("upi"));
  assert.ok(offPlatform.includes("gpay"));
});

test("language patterns: Hinglish phrases match; short tokens don't false-match inside words", () => {
  assert.ok(matchTextAgainstPatterns("jaldi karo", URGENCY_LANGUAGE_PATTERNS).includes("jaldi karo"));
  assert.ok(matchTextAgainstPatterns("paisa pehle bhejo", ADVANCE_FEE_LANGUAGE_PATTERNS).includes("paisa pehle"));
  assert.ok(matchTextAgainstPatterns("gpay karo", OFF_PLATFORM_PAYMENT_LANGUAGE_PATTERNS).includes("gpay karo"));

  // Word boundaries: "upi" must not match inside "rupiah"/"kupi", "advance" must
  // not match "advancement", "tv" is not a language pattern at all.
  assert.equal(matchTextAgainstPatterns("rupiah kupi", OFF_PLATFORM_PAYMENT_LANGUAGE_PATTERNS).length, 0);
  assert.equal(matchTextAgainstPatterns("advancement of tech", ADVANCE_FEE_LANGUAGE_PATTERNS).length, 0);
  assert.deepEqual(matchTextAgainstPatterns(null, URGENCY_LANGUAGE_PATTERNS), []);
  assert.deepEqual(matchTextAgainstPatterns("", URGENCY_LANGUAGE_PATTERNS), []);
});
