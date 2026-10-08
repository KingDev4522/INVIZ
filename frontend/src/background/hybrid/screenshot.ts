/**
 * EXPERIMENTAL (CONTEXT_MODE=hybrid): current-tab screenshot + controlled
 * image pipeline. Never touched by the default DOM path.
 *
 * SCOPE — what this is allowed to capture:
 * - ONLY the visible viewport of the ONE tab the assistant is reasoning about,
 *   via chrome.tabs.captureVisibleTab(windowId).
 * - NEVER the desktop, another application, an arbitrary window, or a
 *   full-screen capture (getDisplayMedia / tabCapture / debugger are not used
 *   anywhere in this file, and must stay that way).
 *
 * It is called only when the operator opted into hybrid mode AND the tab is
 * the active tab of its window (otherwise captureVisibleTab would photograph a
 * DIFFERENT tab, which would be worse than no screenshot at all). Every failure
 * path returns null so the caller silently degrades to the existing DOM
 * context — a screenshot problem must never break a turn.
 *
 * Phase 4 measurement: every capture records source/final dimensions, encoded
 * byte size and encode duration. Measurement first, optimisation never (this
 * pipeline deliberately does no speculative work).
 */
import type { HybridScreenshot } from "../../../../shared/api.js";
import {
  HYBRID_IMAGE_JPEG_QUALITY,
  HYBRID_IMAGE_MAX_DIMENSION,
} from "../../../../shared/constants.js";
import { logger } from "../../../../shared/logger.js";

/**
 * Schemes that cannot be screenshotted usefully and are already non-automatable
 * in the DOM path (matches the SYSTEM_PROMPT rule for chrome:// etc.).
 */
const RESTRICTED_URL_RE =
  /^(?:chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source|file|blob|data):/;

/** Splits a `data:image/...;base64,` URL into its base64 payload. */
function base64FromDataUrl(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  return dataUrl.slice(comma + 1);
}

/** base64 -> bytes without allocating a giant intermediate string per char. */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** bytes -> base64, chunked so String.fromCharCode never blows the arg limit. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Captures the current visible viewport of `tabId` and returns a compressed,
 * bounded image ready for the Ollama `images` wire format.
 *
 * Returns null — never throws — for every failure: restricted page, inactive
 * tab, missing tab, permission denial, rate limit, decode/encode failure.
 * The caller falls back to plain DOM context.
 */
export async function captureViewportScreenshot(tabId: number): Promise<HybridScreenshot | null> {
  const t2 = Date.now();

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    logger.warn("hybrid: screenshot skipped (tab unavailable)", { tabId });
    return null;
  }

  // captureVisibleTab photographs the ACTIVE tab of the window. If ours is not
  // active we would ship a screenshot of an unrelated page and the model would
  // reason about the wrong thing — refuse instead.
  if (tab.active !== true) {
    logger.info("hybrid: screenshot skipped (tab not active)", { tabId });
    return null;
  }
  if (tab.url !== undefined && tab.url !== "" && RESTRICTED_URL_RE.test(tab.url)) {
    logger.info("hybrid: screenshot skipped (restricted page)", { tabId });
    return null;
  }
  if (typeof tab.windowId !== "number") {
    logger.info("hybrid: screenshot skipped (no window)", { tabId });
    return null;
  }

  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    // Typical causes: missing activeTab/host grant, or the 2 captures/second
    // rate limit. Either way the turn continues with DOM context only.
    logger.warn("hybrid: screenshot capture failed; falling back to DOM context", {
      tabId,
      reason: err instanceof Error ? err.message : "unknown",
    });
    return null;
  }
  const t3 = Date.now();

  try {
    const sourceB64 = base64FromDataUrl(dataUrl);
    if (sourceB64 === null) {
      logger.warn("hybrid: screenshot malformed; falling back to DOM context", { tabId });
      return null;
    }
    const sourceBytes = Math.floor((sourceB64.length * 3) / 4);

    const t4 = Date.now();
    const pngBytes = base64ToBytes(sourceB64);
    const bitmap = await createImageBitmap(new Blob([pngBytes], { type: "image/png" }));
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;

    const longEdge = Math.max(sourceWidth, sourceHeight);
    const scale = longEdge > HYBRID_IMAGE_MAX_DIMENSION ? HYBRID_IMAGE_MAX_DIMENSION / longEdge : 1;
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      bitmap.close();
      logger.warn("hybrid: no 2d context; falling back to DOM context", { tabId });
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const jpegBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: HYBRID_IMAGE_JPEG_QUALITY,
    });
    const t5 = Date.now();

    const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
    if (jpegBytes.length === 0) {
      logger.warn("hybrid: empty encode; falling back to DOM context", { tabId });
      return null;
    }
    const b64 = bytesToBase64(jpegBytes);
    const t6 = Date.now();

    // Phase 4 record — one line, always emitted, so the experiment has data
    // even on runs that are never turned into a verdict.
    logger.info("hybrid: screenshot prepared", {
      tabId,
      sourceWidth,
      sourceHeight,
      sourceBytes,
      width,
      height,
      bytes: jpegBytes.length,
      captureMs: t3 - t2,
      encodeMs: t5 - t4,
      packageMs: t6 - t5,
      scale: Number(scale.toFixed(3)),
    });

    return {
      b64,
      width,
      height,
      bytes: jpegBytes.length,
      sourceWidth,
      sourceHeight,
      timings: {
        captureMs: t3 - t2,
        encodeMs: t5 - t4,
        packageMs: t6 - t5,
        frontendTotalMs: t6 - t2,
      },
    };
  } catch (err) {
    logger.warn("hybrid: image processing failed; falling back to DOM context", {
      tabId,
      reason: err instanceof Error ? err.message : "unknown",
    });
    return null;
  }
}
