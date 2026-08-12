/**
 * extractor.js — content-script DOM extractor for OLX + Quikr listing pages.
 *
 * Strategy (PLAN-BACKEND.md §2.1):
 *   1. Primary: `og:` meta tags (title/description/image) — confirmed present
 *      and reliable on live OLX.in pages during the 2026-08-11 research pass.
 *   2. Primary: attribute/class selectors that are stable enough to rely on
 *      (`.ad-price`, `[class*="price"]`, …) — the exact `data-aut-id` values
 *      must be observed live at build time (see PLAN-FRONTEND.md §10); the
 *      selectors here are the documented generic tier.
 *   3. Fallback: resilient text-pattern matching over rendered DOM text nodes
 *      ("AD ID <n>", "Member since <Mon YYYY>", "<N> Items listed", …) — needed
 *      because OLX is a React SPA with hashed, non-documented class names.
 *
 * Guarantees: NEVER throws on missing/malformed fields — every missing field is
 * `null`. Quikr exposes no items-listed count → `null`. A top-level guard
 * returns a low-confidence baseline for pathological pages so the content
 * script can never crash a host page.
 *
 * This module is a pure function of a `Document` (injectable for jsdom tests);
 * the MV3 content-script entry point that calls `extractListing(document)`
 * ships in a later phase (see PLAN-FRONTEND.md §2/§10).
 *
 * §5 (PLAN-FRONTEND.md): the content script's ONLY presentation concern is
 * responding to GET_LISTING messages from the service worker. Badge behavior
 * (chrome.action.setBadgeText) is handled by the service worker after
 * analysis completes — the content script never touches the badge or injects
 * any UI into the page DOM.
 */

/** Matches an element whose ENTIRE text is a rupee price ("₹ 6,500"). */
const PRICE_LIKE_RE = /^\s*(?:₹|\u20b9|rs\.?\s*|inr\s*)\s*[\d,]+(?:\.\d{1,2})?\s*$/i;

/** Finds the first rupee price anywhere in text ("…₹ 6,500…"). */
const PRICE_SEARCH_RE = /(?:₹|\u20b9|rs\.?\s*|inr\s*)\s*[\d,]+(?:\.\d{1,2})?/i;

/** Images that are clearly UI chrome, not listing photos. */
const JUNK_IMG_RE = /(?:icon|logo|sprite|avatar|placeholder|pixel|tracker|spacer|\.svg)/i;

/**
 * Parse a scraped price string into the §2.1 `ListingPrice` shape.
 * Strips ₹/Rs./INR markers and thousands separators ("₹ 6,500" → 6500,
 * "Rs. 1,29,999" → 129999). Non-string/empty input → all-null price, never throws.
 *
 * @param {unknown} raw
 * @returns {{ amount: number | null, currency: "INR" | "unknown", raw: string | null }}
 */
export function parsePrice(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { amount: null, currency: "unknown", raw: null };
  }
  const trimmed = raw.trim();
  const currency = /(?:₹|\u20b9|rs\.?|inr)/i.test(trimmed) ? "INR" : "unknown";
  const cleaned = trimmed
    .replace(/(?:₹|\u20b9|rs\.?|inr)/gi, " ")
    .replace(/[,\s]/g, "")
    .replace(/[^\d.]/g, "");
  const amount = Number.parseFloat(cleaned);
  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    currency,
    raw: trimmed,
  };
}

/**
 * Determine which platform a document belongs to. URL hostname is the primary
 * signal; lightweight content hints cover hosts we can't see (tests, SPAs).
 *
 * @param {Document} doc
 * @returns {"olx" | "quikr" | "unknown"}
 */
export function detectPlatform(doc) {
  const host = (doc?.location?.hostname || "").toLowerCase();
  if (/(^|\.)olx\.(in|com)$/.test(host)) return "olx";
  if (/(^|\.)quikr\.com$/.test(host)) return "quikr";
  // Content hints (only reached when the URL host is empty/unavailable).
  const bodyText = doc?.body?.textContent || "";
  if (/\bAD ID\b/i.test(bodyText)) return "olx";
  if (/kuikr\.com/i.test(doc?.documentElement?.outerHTML || "")) return "quikr";
  return "unknown";
}

/** @param {Document} doc @returns {string} */
function getBodyText(doc) {
  return doc?.body?.textContent || "";
}

/** Read og: meta tags plus the name=description fallback. */
function readMeta(doc) {
  const get = (selector) => {
    const el = doc.querySelector(selector);
    return el ? el.getAttribute("content") : null;
  };
  return {
    ogTitle: get('meta[property="og:title"]'),
    ogDescription: get('meta[property="og:description"]'),
    ogImage: get('meta[property="og:image"]'),
    nameDescription: get('meta[name="description"]'),
  };
}

/**
 * Strip the marketplace site suffix from a document.title ("… | OLX",
 * "… - Quikr"). Weak last-resort fallback — the og:title/heading paths
 * virtually always succeed first.
 *
 * @param {string} raw
 * @returns {string}
 */
function cleanDocTitle(raw) {
  return raw.split(/\s+[-–—|]\s+/)[0].trim() || raw.trim();
}

/** @returns {{ value: string | null, usedFallback: boolean }} */
function extractTitle(doc, meta) {
  if (meta.ogTitle) return { value: meta.ogTitle.trim(), usedFallback: false };
  for (const selector of ["h1", "h2"]) {
    const el = doc.querySelector(selector);
    if (el && el.textContent.trim()) {
      return { value: el.textContent.trim(), usedFallback: false };
    }
  }
  const attrEl = doc.querySelector(
    '[class*="title" i], [class*="heading" i], [data-aut-id*="title" i], [data-testid*="title" i]',
  );
  if (attrEl && attrEl.textContent.trim()) {
    return { value: attrEl.textContent.trim(), usedFallback: false };
  }
  if (doc.title) return { value: cleanDocTitle(doc.title), usedFallback: true };
  return { value: null, usedFallback: false };
}

/** @returns {{ value: string | null, usedFallback: boolean }} */
function extractDescription(doc, meta) {
  if (meta.ogDescription) return { value: meta.ogDescription.trim(), usedFallback: false };
  for (const selector of [
    '[class*="description" i]',
    '[class*="desc" i]',
    '[data-aut-id*="description" i]',
    '[data-testid*="description" i]',
  ]) {
    const el = doc.querySelector(selector);
    if (el && el.textContent.trim()) {
      return { value: el.textContent.trim(), usedFallback: false };
    }
  }
  if (meta.nameDescription) return { value: meta.nameDescription.trim(), usedFallback: true };
  const paragraph = [...doc.querySelectorAll("p")].find(
    (p) => p.textContent.trim().length >= 20,
  );
  if (paragraph) return { value: paragraph.textContent.trim(), usedFallback: true };
  return { value: null, usedFallback: false };
}

/**
 * First leaf element whose own text is exactly a rupee price, in document
 * order. Part of the text-pattern chain (§2.1) — OLX's hashed class names
 * defeat selector-based price extraction, so a leaf-element price match is the
 * reliable DOM strategy there.
 *
 * @param {Document} doc
 * @returns {string | null}
 */
function findPriceByLeafScan(doc) {
  for (const el of doc.querySelectorAll("body *")) {
    if (el.childElementCount > 0) continue; // leaves only
    const text = (el.textContent || "").trim();
    if (PRICE_LIKE_RE.test(text)) return text;
  }
  return null;
}

/**
 * Price extraction, primary-then-fallback:
 *   1. og:price:amount meta (primary)
 *   2. price attribute/class selectors (primary)
 *   3. leaf-element price scan (text-pattern chain)
 *   4. body-wide price search (text-pattern chain)
 *
 * @param {Document} doc
 * @returns {{ amount: number | null, currency: "INR" | "unknown", raw: string | null, usedFallback: boolean }}
 */
function extractPrice(doc) {
  // 1. og meta (primary)
  const ogAmount = doc.querySelector('meta[property="og:price:amount"]')?.getAttribute("content");
  if (ogAmount && PRICE_SEARCH_RE.test(ogAmount)) {
    const parsed = parsePrice(ogAmount);
    const ogCurrency = doc.querySelector('meta[property="og:price:currency"]')?.getAttribute("content");
    if (ogCurrency && /inr/i.test(ogCurrency)) parsed.currency = "INR";
    return { ...parsed, usedFallback: false };
  }
  // 2. attribute/class selectors (primary)
  for (const selector of [
    '[class*="price" i]',
    '[data-aut-id*="price" i]',
    '[data-testid*="price" i]',
    ".ad-price",
  ]) {
    const el = doc.querySelector(selector);
    if (el && PRICE_LIKE_RE.test(el.textContent.trim())) {
      return { ...parsePrice(el.textContent), usedFallback: false };
    }
  }
  // 3. leaf-element scan (text-pattern chain)
  const leaf = findPriceByLeafScan(doc);
  if (leaf) return { ...parsePrice(leaf), usedFallback: true };
  // 4. body-wide search (text-pattern chain)
  const bodyMatch = getBodyText(doc).match(PRICE_SEARCH_RE);
  if (bodyMatch) return { ...parsePrice(bodyMatch[0]), usedFallback: true };
  return { amount: null, currency: "unknown", raw: null, usedFallback: false };
}

/** OLX: iid from URL, then "AD ID <n>" text. Quikr: null rather than guess. */
function extractAdId(doc, platform) {
  if (platform !== "olx") return null;
  const fromUrl = (doc?.location?.pathname || "").match(/iid-(\d+)/);
  if (fromUrl) return fromUrl[1];
  const fromText = getBodyText(doc).match(/\bAD ID\s*:?\s*(\d+)/i);
  return fromText ? fromText[1] : null;
}

/** True when a verified-seller badge is mentioned; null when not found (§2.1). */
function detectSellerVerified(bodyText) {
  if (/\b(?:verified seller|seller is verified|badge[^.\n]{0,30}verified)\b/i.test(bodyText)) {
    return true;
  }
  return null;
}

/**
 * Seller block fields. Strategy: Quikr's `.seller-info` block first, then
 * per-leaf anchored text patterns, then body-wide regex fallbacks for text
 * embedded in larger nodes on real pages.
 */
function extractSellerInfo(doc, platform, bodyText) {
  let sellerName = null;
  let sellerMemberSince = null;
  let sellerItemsListed = null;
  let location = null;
  let postedAt = null;

  // Quikr: name + city live in one seller block.
  if (platform === "quikr") {
    const infoEl = doc.querySelector(".seller-info, [class*='seller-info' i], [class*='seller_info' i]");
    if (infoEl) {
      const parts = [...infoEl.children]
        .map((child) => child.textContent.trim())
        .filter(Boolean);
      const lines = parts.length > 0 ? parts : infoEl.textContent.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      if (lines.length > 0) sellerName = lines[0];
      const rest = lines.slice(1).filter(Boolean);
      if (rest.length > 0) location = rest.join(", ");
    }
  }

  // Per-leaf anchored text patterns (primary text strategy).
  for (const el of doc.querySelectorAll("body *")) {
    if (el.childElementCount > 0) continue;
    const text = (el.textContent || "").trim();
    if (!text) continue;
    if (sellerName === null) {
      const m = text.match(/^Posted\s*by\s*:?\s*(.+?)\s*$/i);
      if (m) sellerName = m[1].trim();
    }
    if (sellerMemberSince === null) {
      const m = text.match(/^Member\s+since\s+([A-Za-z]{3,9}\s+\d{4})$/i);
      if (m) sellerMemberSince = m[1];
    }
    if (sellerItemsListed === null) {
      const m = text.match(/^(\d+)\s+Items?\s+listed$/i);
      if (m) sellerItemsListed = Number.parseInt(m[1], 10);
    }
    if (location === null) {
      const m = text.match(/^Location\s*:\s*(.+)$/i);
      if (m) location = m[1].trim();
    }
    if (postedAt === null) {
      const m = text.match(/^Posted\s*:\s*(.+)$/i);
      if (m) postedAt = m[1].trim();
    }
  }

  // Body-wide fallbacks (resilient path for text embedded in larger nodes).
  if (sellerName === null) {
    const m = bodyText.match(/\bPosted\s*by\s*:?\s*(.+?)(?=\s*(?:Member\s+since|$))/i);
    if (m) sellerName = m[1].trim();
  }
  if (sellerMemberSince === null) {
    const m = bodyText.match(/\bMember\s+since\s+([A-Za-z]{3,9}\s+\d{4})/i);
    if (m) sellerMemberSince = m[1];
  }
  if (sellerItemsListed === null) {
    const m = bodyText.match(/(\d+)\s+Items?\s+listed/i);
    if (m) sellerItemsListed = Number.parseInt(m[1], 10);
  }
  if (location === null) {
    const m = bodyText.match(/\bLocation\s*:\s*(.+?)(?=\s*\b(?:Posted\s*:|Member\s+since|Items?\s+listed|₹|$))/i);
    if (m) location = m[1].trim();
  }
  if (postedAt === null) {
    const m = bodyText.match(/\bPosted\s*:\s*(.+?)(?=\s*\b(?:Location\s*:|Member\s+since|Items?\s+listed|₹|$))/i);
    if (m) postedAt = m[1].trim();
  }

  return { sellerName, sellerMemberSince, sellerItemsListed, location, postedAt };
}

/**
 * Collect listing photos. og:image is the canonical primary image; DOM `<img>`
 * elements supplement it, deduped by URL. UI-chrome images are filtered out.
 *
 * @param {Document} doc
 * @param {string | null} ogImage
 * @returns {{ url: string, isThumbnail: boolean }[]}
 */
function extractImages(doc, ogImage) {
  const seen = new Set();
  const images = [];
  const push = (url, isThumbnail) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    images.push({ url, isThumbnail });
  };
  if (ogImage) push(ogImage, false);
  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
    if (!/^https?:\/\//i.test(src)) continue;
    if (JUNK_IMG_RE.test(src)) continue;
    push(src, /thumb/i.test(`${src} ${img.className || ""}`));
  }
  return images;
}

/**
 * §2.1 extractionConfidence:
 *   "low"     — fewer than 2 of {title, price, description} recovered.
 *   "high"    — all three recovered, none via the text-pattern fallback chain.
 *   "partial" — any fallback used, or one of the three required fields missing.
 *
 * @returns {"high" | "partial" | "low"}
 */
function computeConfidence(titleValue, descriptionValue, price, { titleUsedFallback, descriptionUsedFallback, priceUsedFallback }) {
  const foundCount = [titleValue, descriptionValue, price.amount].filter(
    (v) => v !== null && v !== undefined,
  ).length;
  if (foundCount < 2) return "low";
  const usedFallback = titleUsedFallback || descriptionUsedFallback || priceUsedFallback;
  if (foundCount === 3 && !usedFallback) return "high";
  return "partial";
}

/**
 * Extract a full `Listing` from a listing-page document. Pure, synchronous,
 * never throws — missing fields are `null`, and pathological documents return
 * a low-confidence baseline.
 *
 * @param {Document} doc
 * @returns {import("../shared/types.js").Listing}
 */
export function extractListing(doc) {
  const url = (doc?.location?.href) || "";
  const extractedAt = new Date().toISOString();
  const platform = detectPlatform(doc);
  const baseline = {
    platform,
    url,
    adId: null,
    title: null,
    price: { amount: null, currency: "unknown", raw: null },
    description: null,
    sellerName: null,
    sellerMemberSince: null,
    sellerItemsListed: null,
    sellerVerified: null,
    location: null,
    postedAt: null,
    images: [],
    imageCount: 0,
    extractionConfidence: "low",
    extractedAt,
  };

  // A content script must never throw on a malformed/unrelated page — that
  // would break the host page's UX. On any error, degrade to the baseline.
  try {
    const meta = readMeta(doc);
    const title = extractTitle(doc, meta);
    const description = extractDescription(doc, meta);
    const price = extractPrice(doc);
    const bodyText = getBodyText(doc);
    const seller = extractSellerInfo(doc, platform, bodyText);
    const images = extractImages(doc, meta.ogImage);

    return {
      platform,
      url,
      adId: extractAdId(doc, platform),
      title: title.value,
      price: { amount: price.amount, currency: price.currency, raw: price.raw },
      description: description.value,
      sellerName: seller.sellerName,
      sellerMemberSince: seller.sellerMemberSince,
      sellerItemsListed: seller.sellerItemsListed,
      sellerVerified: detectSellerVerified(bodyText),
      location: seller.location,
      postedAt: seller.postedAt,
      images,
      imageCount: images.length,
      extractionConfidence: computeConfidence(title.value, description.value, price, {
        titleUsedFallback: title.usedFallback,
        descriptionUsedFallback: description.usedFallback,
        priceUsedFallback: price.usedFallback,
      }),
      extractedAt,
    };
  } catch {
    return baseline;
  }
}

// ─── §5 Content-script entry point ────────────────────────────────────────
//
// Listen for GET_LISTING messages from the service worker and respond with
// the extracted listing data. This is the ONLY runtime behavior in the
// content script — no badge manipulation, no page-DOM injection.
// §5: badge behavior is entirely handled by the service worker after
// analysis completes (PLAN-FRONTEND.md §5).

if (
  typeof globalThis !== "undefined" &&
  typeof globalThis.chrome !== "undefined" &&
  typeof globalThis.chrome.runtime !== "undefined" &&
  typeof globalThis.chrome.runtime.onMessage?.addListener === "function"
) {
  globalThis.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = message && typeof message === "object" ? message.type : null;
    if (type === "GET_LISTING") {
      try {
        const listing = extractListing(document);
        sendResponse({ ok: true, listing });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : "Extraction failed",
        });
      }
      return true; // keep the channel open for async response
    }
    // Not our message — ignore.
    return false;
  });
}
