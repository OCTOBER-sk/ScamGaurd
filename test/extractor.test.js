/**
 * extractor.test.js — DOM extraction tests (node:test + jsdom, zero runtime deps).
 *
 * Covers: both real-shape fixtures, the §2.1 extractionConfidence bands,
 * "missing fields are null, never throws", price parsing, platform detection,
 * and pathological documents (empty body, junk page).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { extractListing, parsePrice, detectPlatform } from "../content/extractor.mjs";

/** @param {string} name @returns {string} */
function loadFixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

/** @param {string} html @param {string} url @returns {import("../shared/types.js").Listing} */
function extract(html, url) {
  const dom = new JSDOM(html, { url });
  return extractListing(dom.window.document);
}

test("OLX fixture: recovers all fields, price via text-pattern fallback -> partial confidence", () => {
  const html = loadFixture("olx-listing-real.html");
  const listing = extract(
    html,
    "https://www.olx.in/item/mi-led-32-smart-android-led-tv-in-haidarganj-lucknow-iid-1827354630",
  );

  assert.equal(listing.platform, "olx");
  assert.equal(
    listing.url,
    "https://www.olx.in/item/mi-led-32-smart-android-led-tv-in-haidarganj-lucknow-iid-1827354630",
  );
  assert.equal(listing.adId, "1827354630");
  assert.equal(listing.title, 'Mi LED 32" Smart Android LED TV');
  assert.equal(listing.price.amount, 6500);
  assert.equal(listing.price.currency, "INR");
  assert.equal(listing.price.raw, "₹ 6,500");
  assert.match(listing.description, /^Mi 32 inch smart android led tv/);
  assert.equal(listing.sellerName, "Test Seller");
  assert.equal(listing.sellerMemberSince, "Feb 2014");
  assert.equal(listing.sellerItemsListed, 9);
  assert.equal(listing.sellerVerified, null);
  assert.equal(listing.location, "Haidarganj, Lucknow");
  assert.equal(listing.postedAt, "Today");
  assert.equal(listing.imageCount, 1);
  assert.equal(listing.images[0].url, "https://images.olx.in/example/photo1.jpg");
  assert.equal(listing.images[0].isThumbnail, false);
  assert.match(listing.extractedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // The fixture ships synthetic hashed class names (no observed data-aut-id
  // attributes yet — see the fixture's own header comment), so the price can
  // only be recovered via the §2.1 text-pattern fallback chain. Per the plan
  // that means "partial": title/description came from og: meta, price from a
  // fallback. Once a live capture's real attributes are recorded (PLAN-FRONTEND
  // §10), the primary selector tier kicks in and confidence rises to "high".
  assert.equal(listing.extractionConfidence, "partial");
});

test("Quikr fixture: recovers fields, absent fields are null and never throw", () => {
  const html = loadFixture("quikr-listing-real.html");
  const listing = extract(html, "https://www.quikr.com/item/samsung-galaxy-m14-4gb-128gb");

  assert.equal(listing.platform, "quikr");
  assert.equal(listing.title, "Samsung Galaxy M14 4GB 128GB");
  assert.equal(listing.price.amount, 8999);
  assert.equal(listing.price.currency, "INR");
  assert.equal(listing.price.raw, "₹ 8,999");
  assert.match(listing.description, /^Samsung Galaxy M14 4GB\/128GB/);
  assert.equal(listing.sellerName, "Quikr User");
  assert.equal(listing.location, "Coimbatore");

  // Quikr-specific absences must be null, not a thrown error (§2.1 / §9.2).
  assert.equal(listing.adId, null);
  assert.equal(listing.sellerItemsListed, null);
  assert.equal(listing.sellerMemberSince, null);
  assert.equal(listing.sellerVerified, null);
  assert.equal(listing.postedAt, null);

  assert.equal(listing.imageCount, 1);
  assert.equal(listing.images[0].url, "https://teja8.kuikr.com/example/photo.jpg");

  // Quikr fixture: title/description via og: meta, price via the .ad-price
  // selector (primary tier) -> nothing used the fallback chain.
  assert.equal(listing.extractionConfidence, "high");
});

test("degraded page: missing description -> partial confidence, missing field null, never throws", () => {
  const html = loadFixture("olx-listing-real.html")
    // Drop og:description and the description paragraph block.
    .replace('<meta property="og:description" content="Mi 32 inch smart android led tv. Working condition, no issues. Selling because moving out of city. Price negotiable.">', "")
    .replace(/<div class="css-7u8i9o">[\s\S]*?<\/div>/, "");
  const listing = extract(html, "https://www.olx.in/item/x-iid-123");

  assert.equal(listing.title, 'Mi LED 32" Smart Android LED TV');
  assert.equal(listing.price.amount, 6500);
  assert.equal(listing.description, null);
  assert.equal(listing.extractionConfidence, "partial");
});

test("non-listing page: fewer than 2 of {title, price, description} -> low confidence, never throws", () => {
  const listing = extract(
    "<html><body><div>some search results page</div></body></html>",
    "https://www.olx.in/",
  );
  assert.equal(listing.platform, "olx");
  assert.equal(listing.title, null);
  assert.equal(listing.price.amount, null);
  assert.equal(listing.description, null);
  assert.equal(listing.extractionConfidence, "low");
});

test("empty document: returns low-confidence baseline, never throws", () => {
  const listing = extract("<html><head></head><body></body></html>", "https://www.olx.in/item/x-iid-1");
  assert.equal(listing.title, null);
  assert.equal(listing.price.amount, null);
  assert.equal(listing.extractionConfidence, "low");
  assert.equal(listing.imageCount, 0);
});

test("parsePrice: strips ₹/Rs./INR markers and separators", () => {
  assert.deepEqual(parsePrice("₹ 6,500"), { amount: 6500, currency: "INR", raw: "₹ 6,500" });
  assert.deepEqual(parsePrice("Rs. 1,29,999"), { amount: 129999, currency: "INR", raw: "Rs. 1,29,999" });
  assert.deepEqual(parsePrice("INR 8999"), { amount: 8999, currency: "INR", raw: "INR 8999" });
  assert.deepEqual(parsePrice("6,500.50"), { amount: 6500.5, currency: "unknown", raw: "6,500.50" });
});

test("parsePrice: unparseable input -> null amount, never throws", () => {
  assert.deepEqual(parsePrice("not a price"), { amount: null, currency: "unknown", raw: "not a price" });
  assert.deepEqual(parsePrice(null), { amount: null, currency: "unknown", raw: null });
  assert.deepEqual(parsePrice(""), { amount: null, currency: "unknown", raw: null });
});

test("detectPlatform: resolves hostnames and content hints", () => {
  assert.equal(detectPlatform(new JSDOM("<html></html>", { url: "https://www.olx.in/item/x-iid-1" }).window.document), "olx");
  assert.equal(detectPlatform(new JSDOM("<html></html>", { url: "https://www.quikr.com/item/x" }).window.document), "quikr");
  // Content hint: AD ID text marks an OLX page even without a URL host.
  assert.equal(detectPlatform(new JSDOM("<html><body>AD ID 123</body></html>").window.document), "olx");
  // Content hint: kuikr.com image CDN marks a Quikr page.
  assert.equal(detectPlatform(new JSDOM('<html><body><img src="https://teja8.kuikr.com/x.jpg"></body></html>').window.document), "quikr");
  assert.equal(detectPlatform(new JSDOM("<html><body>unrelated</body></html>").window.document), "unknown");
});
