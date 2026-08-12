/**
 * extractor.mjs — Node-facing ESM adapter over content/extractor.js.
 *
 * content/extractor.js is the REAL MV3 content-script entry: Chrome loads it
 * as a CLASSIC script, so it must not contain ES-module syntax. It exposes
 * its API as `globalThis.ScamGuardExtractor` instead of `export`. Node's ESM
 * test suite imports THIS adapter, which executes the implementation for its
 * side effects and re-exports the same three-function API the tests expect.
 *
 * Tests must import from here (../content/extractor.mjs), never from
 * extractor.js directly.
 */
import "./extractor.js";

const api = globalThis.ScamGuardExtractor;
if (!api || typeof api.extractListing !== "function") {
  throw new Error("content/extractor.js did not expose ScamGuardExtractor on globalThis");
}

export const parsePrice = api.parsePrice;
export const detectPlatform = api.detectPlatform;
export const extractListing = api.extractListing;
