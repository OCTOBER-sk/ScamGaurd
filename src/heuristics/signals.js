/**
 * signals.js — deterministic listing heuristics (PLAN-BACKEND.md §2.2 / §5.1).
 *
 * `run(listing)` is a pure synchronous function: zero network, <5ms. It must
 * run before any LLM call and never throw, even on a garbage/empty listing —
 * it returns a fully-populated HeuristicSignals object with every field set.
 */

import priceTable from "./price-table.json" with { type: "json" };
import {
  matchTextAgainstPatterns,
  LANGUAGE_PATTERN_GROUPS,
} from "./language-patterns.js";

// ─── §5.1 weights (single source of truth) ────────────────────────────────
const W = {
  priceAnomalyHigh: 30, // ratio < 0.4
  priceAnomalyMedium: 15, // ratio 0.4–0.6
  offPlatformPayment: 20,
  advanceFee: 20,
  urgency: 10,
  sellerNew: 10, // itemsListed !== null && <= 1
  sellerUnknown: 5, // itemsListed null — can't penalize unseen, can't reward
  lowPhotoHighValue: 10, // imageCount <= 1 && price > 5000
  contactLeak: 10,
};

const { categories } = priceTable;

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Escape a string for use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does the listing text (title + description) hit a category keyword?
 * @param {string | null | undefined} title
 * @param {string | null | undefined} description
 * @param {readonly string[]} keywords
 * @returns {number} number of distinct keywords matched.
 */
function countKeywordHits(title, description, keywords) {
  const text = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i").test(text)) hits += 1;
  }
  return hits;
}

/**
 * Pick the category the listing text most plausibly belongs to, or null.
 * Ties resolve to the first category in the price table.
 *
 * @param {import("../shared/types.js").Listing} listing
 * @returns {string | null} category id, e.g. "laptops".
 */
export function matchCategory(listing) {
  const title = listing?.title ?? null;
  const description = listing?.description ?? null;
  let best = null;
  let bestHits = 0;
  for (const [categoryId, category] of Object.entries(categories)) {
    const hits = countKeywordHits(title, description, category.keywords);
    if (hits > bestHits) {
      best = categoryId;
      bestHits = hits;
    }
  }
  return bestHits > 0 ? best : null;
}

/**
 * price / typical-range-midpoint for a category. Returns null when the price
 * is missing/not positive (the ratio would be meaningless).
 *
 * @param {number | null | undefined} amount
 * @param {string} categoryId
 * @returns {number | null}
 */
export function computePriceRatio(amount, categoryId) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const [min, max] = categories[categoryId].rangeInr;
  const midpoint = (min + max) / 2;
  return amount / midpoint;
}

/**
 * Classify a price ratio per §5.1's banding.
 * @param {number} ratio
 * @returns {{ severity: "high" | "medium" | "low" | "none", points: number }}
 */
function classifyPriceRatio(ratio) {
  if (ratio < 0.4) return { severity: "high", points: W.priceAnomalyHigh };
  if (ratio < 0.6) return { severity: "medium", points: W.priceAnomalyMedium };
  if (ratio < 0.9) return { severity: "low", points: 0 };
  return { severity: "none", points: 0 };
}

// ─── PII redaction (contact-channel-leak) ────────────────────────────────────

/**
 * Redact a matched phone/email so the stored signal never contains full PII
 * (PLAN-BACKEND.md §2.2: "never full PII persisted").
 *
 * @param {string} raw
 * @returns {string}
 */
export function redactMatch(raw) {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 6 && /^[+\d][\d\s-]*$/.test(trimmed)) {
    // Phone-like: keep first 2 + last 2 digits, bullet the middle.
    return digits.slice(0, 2) + "•".repeat(digits.length - 4) + digits.slice(-2);
  }
  const email = trimmed.match(/^([^@\s]{1,2})[^@\s]*@(.+)$/);
  if (email) return `${email[1]}•••@${email[2]}`;
  return "•••";
}

/**
 * Find phone/email/WhatsApp references in a description and return redacted
 * display matches. Empty array when nothing found (never throws).
 *
 * @param {string | null | undefined} description
 * @returns {string[]}
 */
function findContactLeaks(description) {
  if (typeof description !== "string" || description.length === 0) return [];

  const matches = [];
  const phoneRe = /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/g;
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  // WhatsApp numbers may be spaced/dashed ("98765 43210") and miss the phone
  // regex — catch them via the surrounding "whatsapp" hint.
  const whatsappRe = /whatsapp[^0-9]{0,20}((?:\+?\d[\d\s-]{8,14}))/gi;

  for (const m of description.matchAll(phoneRe)) matches.push(redactMatch(m[0]));
  for (const m of description.matchAll(emailRe)) matches.push(redactMatch(m[0]));
  for (const m of description.matchAll(whatsappRe)) matches.push(redactMatch(m[1]));

  return [...new Set(matches)];
}

// ─── main entry ──────────────────────────────────────────────────────────────

/**
 * Compute all deterministic heuristic signals for a listing.
 *
 * @param {import("../shared/types.js").Listing} listing
 * @returns {import("../shared/types.js").HeuristicSignals}
 */
export function run(listing) {
  const amount = listing?.price?.amount ?? null;
  const title = listing?.title ?? null;
  const description = listing?.description ?? null;
  const searchText = `${title ?? ""} ${description ?? ""}`;

  // 1. Price anomaly (§5.1: ratio < 0.4 → 30, 0.4–0.6 → 15, else 0).
  const categoryId = matchCategory(listing);
  const ratio = categoryId ? computePriceRatio(amount, categoryId) : null;
  let pricePoints = 0;
  let priceSeverity = "none";
  let priceNote = "";
  if (ratio === null) {
    priceNote = categoryId
      ? "No usable price — price anomaly not computed."
      : "No category match — price not compared to a typical range.";
  } else {
    const cls = classifyPriceRatio(ratio);
    pricePoints = cls.points;
    priceSeverity = cls.severity;
    const pct = Math.round(ratio * 100);
    if (priceSeverity === "high") {
      priceNote = `Price is about ${pct}% of the typical range for ${categoryId} — implausibly low for the stated item.`;
    } else if (priceSeverity === "medium") {
      priceNote = `Price is about ${pct}% of the typical range for ${categoryId} — well below typical market.`;
    } else if (priceSeverity === "low") {
      priceNote = `Price is about ${pct}% of the typical range for ${categoryId} — slightly low; weak signal on its own.`;
    } else {
      priceNote = `Price is around the typical range for ${categoryId}.`;
    }
  }
  const priceAnomaly = {
    triggered: priceSeverity !== "none",
    severity: priceSeverity,
    ratioVsCategoryTypical: ratio,
    note: priceNote,
  };

  // 2. Seller age/activity (§5.1: itemsListed <= 1 → 10; null → 5; else 0).
  const itemsListed = listing?.sellerItemsListed ?? null;
  const itemsListedIsNumber =
    typeof itemsListed === "number" && Number.isFinite(itemsListed);
  let sellerPoints = 0;
  let sellerTriggered = false;
  if (itemsListedIsNumber && itemsListed <= 1) {
    sellerPoints = W.sellerNew;
    sellerTriggered = true;
  } else if (!itemsListedIsNumber) {
    sellerPoints = W.sellerUnknown; // unknown — mild penalty, can't reward unseen
  }
  const sellerAge = {
    triggered: sellerTriggered,
    memberSinceRaw: listing?.sellerMemberSince ?? null,
    itemsListed,
  };

  // 3. Low photo count on a high-value item (§5.1: count <= 1 && price > 5000 → 10).
  const imageCount = listing?.imageCount ?? 0;
  const count = typeof imageCount === "number" ? imageCount : 0;
  const highValue = typeof amount === "number" && amount > 5000;
  const photoTriggered = count <= 1 && highValue;
  const photoSignals = {
    count,
    triggered: photoTriggered,
    severity: photoTriggered ? "medium" : "none",
  };

  // 4. Contact-channel leak in description (§5.1: any match → 10).
  const contactMatches = findContactLeaks(description);
  const contactChannelLeak = {
    triggered: contactMatches.length > 0,
    matches: contactMatches,
  };

  // 5. Language signals (§5.1: offPlatform 20, advanceFee 20, urgency 10).
  const urgencyMatched = matchTextAgainstPatterns(searchText, LANGUAGE_PATTERN_GROUPS.urgencyLanguage);
  const advanceFeeMatched = matchTextAgainstPatterns(searchText, LANGUAGE_PATTERN_GROUPS.advanceFeeLanguage);
  const offPlatformMatched = matchTextAgainstPatterns(searchText, LANGUAGE_PATTERN_GROUPS.offPlatformPaymentLanguage);

  const urgencyLanguage = { triggered: urgencyMatched.length > 0, matchedPhrases: urgencyMatched };
  const advanceFeeLanguage = { triggered: advanceFeeMatched.length > 0, matchedPhrases: advanceFeeMatched };
  const offPlatformPaymentLanguage = { triggered: offPlatformMatched.length > 0, matchedPhrases: offPlatformMatched };

  // 6. Fused deterministic score — weighted sum, clamped to 0–100 (§5.1).
  const rawScore =
    pricePoints +
    sellerPoints +
    (photoTriggered ? W.lowPhotoHighValue : 0) +
    (contactChannelLeak.triggered ? W.contactLeak : 0) +
    (urgencyLanguage.triggered ? W.urgency : 0) +
    (advanceFeeLanguage.triggered ? W.advanceFee : 0) +
    (offPlatformPaymentLanguage.triggered ? W.offPlatformPayment : 0);

  return {
    priceAnomaly,
    sellerAge,
    photoSignals,
    contactChannelLeak,
    urgencyLanguage,
    advanceFeeLanguage,
    offPlatformPaymentLanguage,
    heuristicScore: Math.min(100, Math.max(0, rawScore)),
    computedAt: new Date().toISOString(),
  };
}
