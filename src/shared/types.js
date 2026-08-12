/**
 * types.js — JSDoc typedefs for the internal universal data shapes.
 *
 * Type-only module: ships no runtime exports. Typing is done via JSDoc +
 * a `tsc --checkJs` CI step (per PLAN-BACKEND.md §8 file plan) so the shipped
 * bundle stays dependency-free. Field names here are the contract — the rest
 * of the codebase and all provider adapters must match these EXACTLY.
 */

/**
 * @typedef {"none" | "low" | "medium" | "high"} Severity4
 * @typedef {"none" | "low" | "medium"} Severity3
 * @typedef {"olx" | "quikr" | "unknown"} Platform
 * @typedef {"high" | "partial" | "low"} ExtractionConfidence
 * @typedef {"INR" | "unknown"} Currency
 */

/**
 * Parsed price block of a listing. `amount` is the plain numeric value with
 * no currency symbols or commas; `raw` is the original scraped text for
 * display/debugging.
 *
 * @typedef {object} ListingPrice
 * @property {number | null} amount  Parsed numeric value, no currency symbol/commas.
 * @property {Currency} currency     "INR" when a ₹/Rs./INR marker was seen, else "unknown".
 * @property {string | null} raw     Original text as scraped, for display/debugging.
 */

/**
 * A single listing photo reference.
 *
 * @typedef {object} ListingImage
 * @property {string} url          Absolute image URL.
 * @property {boolean} isThumbnail True when the URL/class suggests a thumbnail variant.
 */

/**
 * A scraped marketplace listing — the raw material heuristics and the LLM
 * prompt wrapper work from. All extraction is best-effort: missing fields are
 * `null`, never thrown. (PLAN-BACKEND.md §2.1)
 *
 * @typedef {object} Listing
 * @property {Platform} platform
 * @property {string} url                     location.href at scrape time.
 * @property {string | null} adId             OLX: numeric iid from URL (e.g. "1827354630");
 *                                            Quikr: platform-specific id — must fall back to
 *                                            null rather than guess.
 * @property {string | null} title
 * @property {ListingPrice} price
 * @property {string | null} description      Full text, HTML stripped.
 * @property {string | null} sellerName
 * @property {string | null} sellerMemberSince Raw text e.g. "Feb 2014" — NOT parsed to a Date.
 * @property {number | null} sellerItemsListed OLX: "9 Items listed" → 9. Quikr has none → null.
 * @property {boolean | null} sellerVerified  null = platform doesn't expose this / not found.
 * @property {string | null} location
 * @property {string | null} postedAt         Raw text ("Today", "Yesterday", "19 Jul") — not
 *                                            parsed to an absolute date.
 * @property {ListingImage[]} images
 * @property {number} imageCount
 * @property {ExtractionConfidence} extractionConfidence
 *                                            "high": title+price+description found via primary
 *                                            meta/DOM strategies.
 *                                            "partial": fallbacks used or one of the three
 *                                            required fields missing.
 *                                            "low": fewer than 2 of {title, price, description}
 *                                            recovered — UI must show a "couldn't read this
 *                                            page well" state, never a confident verdict.
 * @property {string} extractedAt             ISO 8601 timestamp.
 */

/**
 * Pre-computed price-anomaly signal.
 *
 * @typedef {object} PriceAnomalySignal
 * @property {boolean} triggered
 * @property {Severity4} severity
 * @property {number | null} ratioVsCategoryTypical price / typical-range midpoint; null when no
 *                                                  category match or unknown price.
 * @property {string} note
 */

/**
 * Seller-age / activity signal.
 *
 * @typedef {object} SellerAgeSignal
 * @property {boolean} triggered             true if account looks new/low-activity.
 * @property {string | null} memberSinceRaw
 * @property {number | null} itemsListed
 */

/**
 * Photo-count signal.
 *
 * @typedef {object} PhotoSignals
 * @property {number} count
 * @property {boolean} triggered             true if 0-1 photos on a high-value listing.
 * @property {Severity3} severity
 */

/**
 * Contact-channel leak signal (phone/email/WhatsApp in description).
 *
 * @typedef {object} ContactChannelLeakSignal
 * @property {boolean} triggered
 * @property {string[]} matches              Redacted/partial matches for display — full PII is
 *                                           never persisted or sent anywhere.
 */

/**
 * Language-based signals (urgency / advance-fee / off-platform payment).
 *
 * @typedef {object} LanguageSignal
 * @property {boolean} triggered
 * @property {string[]} matchedPhrases
 */

/**
 * Deterministic heuristic signals — computed synchronously, zero network,
 * before any LLM call. (PLAN-BACKEND.md §2.2 / §5.1)
 *
 * @typedef {object} HeuristicSignals
 * @property {PriceAnomalySignal} priceAnomaly
 * @property {SellerAgeSignal} sellerAge
 * @property {PhotoSignals} photoSignals
 * @property {ContactChannelLeakSignal} contactChannelLeak
 * @property {LanguageSignal} urgencyLanguage
 * @property {LanguageSignal} advanceFeeLanguage
 * @property {LanguageSignal} offPlatformPaymentLanguage
 * @property {number} heuristicScore         0-100 deterministic weighted sum (§5.1).
 * @property {string} computedAt             ISO 8601.
 */

/**
 * Every module in this file is type-only; there is deliberately nothing to
 * import at runtime. Importing it is a no-op and exists so tooling (tsc,
 * editors) picks up the typedefs.
 *
 * @type {Record<string, never>}
 */
export const types = {};
