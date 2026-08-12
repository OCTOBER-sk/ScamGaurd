/**
 * vision.js — image preparation for vision-capable providers (PLAN-BACKEND.md
 * §4.3, §8 file plan).
 *
 * Pipeline per §4.3:
 *   1. Fetch each image URL (max 3, to control payload/latency/cost) — from
 *      the service worker, never the content script, to dodge page CSP.
 *   2. Strip EXIF + downscale client-side: createImageBitmap → OffscreenCanvas
 *      at max 768px longest edge → JPEG q0.7. EXIF often carries GPS/device
 *      data that is irrelevant to scam analysis and must not be forwarded.
 *   3. Shape the parts for the target provider:
 *        - gemini:        { inlineData: { mimeType, data } }
 *        - anthropic:     { type: "image", source: { type: "base64", media_type, data } }
 *        - openai-compat: { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }
 *   4. Per-image failure (hotlink protection, CORS, 404) SKIPS that image and
 *      records a note — never fails the whole analysis.
 *
 * Capability gating (§1.1 step 4): vision only runs when enabled AND the
 * chosen model is in the adapter's `visionCapableModels`. When it can't run,
 * `skippedReason` is set and the caller proceeds text-only.
 *
 * The decode step needs browser APIs (createImageBitmap / OffscreenCanvas)
 * that do not exist in Node; it is injectable via `options.decode` so the
 * Node test-suite can exercise fetch, capability gating and per-image
 * failure without a canvas implementation.
 */

/** @type {number} */
export const MAX_IMAGES = 3;

/** @type {number} */
export const MAX_EDGE_PX = 768;

/** @type {number} */
export const JPEG_QUALITY = 0.7;

/**
 * The production decode+downscale step: turns a fetched ArrayBuffer into a
 * JPEG q0.7 base64 string (EXIF stripped by redrawing onto a fresh canvas).
 * Browser-API dependent — only called when a vision-capable provider/model
 * is actually in use, never at import time.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} _url  (reserved; lets mocks distinguish calls)
 * @returns {Promise<{ mimeType: string; base64: string }>}
 */
export async function decodeAndResizeToJpegBase64(arrayBuffer, _url) {
  const bitmap = await createImageBitmap(new Blob([arrayBuffer], { type: "image/jpeg" }));
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, MAX_EDGE_PX / longest);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { mimeType: "image/jpeg", base64: btoa(binary) };
}

/**
 * Pure capability + eligibility check (§1.1 step 4, §6 "Vision unsupported
 * by chosen model"). Returns whether vision should run and, when not, the
 * reason to surface as `visionAnalysis.skippedReason`.
 *
 * @param {{
 *   enabled: boolean;
 *   adapter: { id?: string; visionCapableModels?: string[] } | null | undefined;
 *   model: string | null | undefined;
 * }} opts
 * @returns {{ use: true; skippedReason: null } | { use: false; skippedReason: string }}
 */
export function planVision({ enabled, adapter, model }) {
  if (!enabled) return { use: false, skippedReason: "Vision is disabled in settings." };
  const models = Array.isArray(adapter?.visionCapableModels) ? adapter.visionCapableModels : [];
  if (typeof model !== "string" || model.length === 0 || !models.includes(model)) {
    return {
      use: false,
      skippedReason: "The selected model does not support image input.",
    };
  }
  return { use: true, skippedReason: null };
}

/**
 * Build the provider-shaped image parts for the given images. Skips
 * unsupported models/disabled vision (sets `skippedReason`), fetches each
 * image (max `MAX_IMAGES`), decodes+downscales, and returns parts already
 * shaped for the target adapter. Per-image failures are recorded as notes,
 * never thrown.
 *
 * @param {Array<{ url: string } | string> | null | undefined} images
 * @param {{ id?: string; visionCapableModels?: string[]; requestShape?: "openai-chat" | "gemini-native" } | null | undefined} adapter
 * @param {{
 *   enabled?: boolean;
 *   model?: string | null;
 *   fetchImpl?: typeof fetch;
 *   decode?: (arrayBuffer: ArrayBuffer, url: string) => Promise<{ mimeType: string; base64: string }>;
 *   limit?: number;
 * }} [options]
 * @returns {Promise<{
 *   parts: Array<Record<string, unknown>>;
 *   skippedReason: string | null;
 *   notes: string[];
 *   analyzedCount: number;
 *   attemptedCount: number;
 * }>}
 */
export async function buildImageParts(images, adapter, options = {}) {
  const enabled = options.enabled ?? true;
  const model = options.model ?? null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const decode = options.decode ?? decodeAndResizeToJpegBase64;
  const limit = options.limit ?? MAX_IMAGES;

  const result = {
    parts: [],
    skippedReason: null,
    notes: [],
    analyzedCount: 0,
    attemptedCount: 0,
  };

  const plan = planVision({ enabled, adapter, model });
  if (!plan.use) {
    result.skippedReason = plan.skippedReason;
    return result;
  }

  const urls = (Array.isArray(images) ? images : [])
    .map((item) => (typeof item === "string" ? item : item?.url))
    .filter((url) => typeof url === "string" && url.length > 0);

  if (urls.length === 0) {
    result.skippedReason = "No listing images were available to analyze.";
    return result;
  }

  const buildPart = partBuilderFor(adapter?.id, adapter?.requestShape);

  for (const url of urls.slice(0, limit)) {
    result.attemptedCount += 1;
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        result.notes.push(`Image ${url} could not be fetched (HTTP ${response.status}).`);
        continue;
      }
      const arrayBuffer = await response.arrayBuffer();
      const { mimeType, base64 } = await decode(arrayBuffer, url);
      result.parts.push(buildPart(mimeType, base64));
      result.analyzedCount += 1;
    } catch {
      result.notes.push(`Image ${url} could not be processed.`);
    }
  }

  if (result.parts.length === 0) {
    result.notes.push("None of the listing images could be analyzed.");
  }

  return result;
}

/**
 * Return a function that shapes a `{ mimeType, base64 }` pair into the part
 * format the target adapter's buildRequest expects (§4.3). Unknown adapters
 * default to the OpenAI-compatible image_url shape.
 *
 * @param {string | null | undefined} adapterId
 * @param {"openai-chat" | "gemini-native"} [requestShape]
 * @returns {(mimeType: string, base64: string) => Record<string, unknown>}
 */
export function partBuilderFor(adapterId, requestShape) {
  if (adapterId === "gemini" || (adapterId === "custom" && requestShape === "gemini-native")) {
    return (mimeType, data) => ({ inlineData: { mimeType, data } });
  }
  if (adapterId === "anthropic") {
    return (mimeType, data) => ({
      type: "image",
      source: { type: "base64", media_type: mimeType, data },
    });
  }
  return (mimeType, data) => ({
    type: "image_url",
    image_url: { url: `data:${mimeType};base64,${data}` },
  });
}
