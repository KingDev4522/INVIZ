/**
 * Whisper transcription client — backend HTTP edition (architecture split).
 * The frontend NEVER talks to Groq: capture audio is base64-encoded and POSTed
 * to the backend /v1/transcribe contract, which owns models, fallback, and
 * provider keys. Error contract preserved: 429 retryable, 401 fatal.
 */
import {
  BackendError,
  ENDPOINTS,
  type BackendRef,
} from "../../../shared/api.js";
import { logger } from "../../../shared/logger.js";

/**
 * Transcription retry policy: exactly ONE attempt per call.
 * The frontend never retries /v1/transcribe — not even on 429 — because every
 * retry spends free-tier quota against an already-exhausted budget. A 429 is
 * surfaced (with the provider's Retry-After hint when present) so the caller
 * can speak an honest "rate limited" message instead of retrying.
 */
export const MAX_TRANSCRIBE_ATTEMPTS = 1;

/** Parses a `retry-after` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null): number | null {
  if (value === null || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export interface Transcript {
  text: string;
  lang: "en" | "hi" | "mixed";
  source: "voice";
}

export class TranscriptionError extends Error {
  readonly status: number | null;
  /** False for 429 (caller may wait + start a NEW turn later); true otherwise.
   *  Note: "may retry" never means an automatic immediate retry — see
   *  MAX_TRANSCRIBE_ATTEMPTS. Permanent errors (400/401/403) are always fatal. */
  readonly fatal: boolean;
  /** Provider's retry-after hint in ms (429 only, null when absent). */
  readonly retryAfterMs: number | null;
  constructor(message: string, status: number | null, fatal: boolean, retryAfterMs: number | null = null) {
    super(message);
    this.name = "TranscriptionError";
    this.status = status;
    this.fatal = fatal;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface TranscribeOptions {
  backend: BackendRef;
  model?: string;
  /** BCP-47 hint (e.g. "en", "hi"). Unset = auto-detect (default; required for Hinglish). */
  language?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Voice-turn correlation id, carried into logs and the backend body. */
  turnId?: string;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  // btoa exists in browsers and Node 24+; the backend decodes symmetric JSON.
  return btoa(binary);
}

export async function transcribeAudio(
  audio: Blob,
  opts: TranscribeOptions,
): Promise<{ text: string }> {
  const audioBase64 = await blobToBase64(audio);
  if (audioBase64 === "") {
    throw new TranscriptionError("empty audio input", null, true);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90000);
  const turnId = opts.turnId ?? "no-turn";
  const startedAt = Date.now();
  // One shortcut press = one logged attempt. No content, no keys, no tokens:
  // byte length proves a real blob was sent without logging speech.
  logger.info("api: transcribe attempt", {
    turnId,
    requestType: "transcribe",
    timestampMs: startedAt,
    attempt: 1,
    maxAttempts: MAX_TRANSCRIBE_ATTEMPTS,
    audioBytes: audio.size,
  });
  let res: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.backend.token !== undefined && opts.backend.token !== "") {
      headers["Authorization"] = `Bearer ${opts.backend.token}`;
    }
    res = await (opts.fetchImpl ?? fetch)(`${opts.backend.url}${ENDPOINTS.transcribe}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        audioBase64,
        mimeType: audio.type !== "" ? audio.type : "audio/webm;codecs=opus",
        ...(opts.language !== undefined ? { language: opts.language } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    logger.warn("api: transcribe failed", {
      turnId,
      requestType: "transcribe",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "transport-error",
    });
    void err;
    throw new TranscriptionError(
      err instanceof Error && err.name === "AbortError"
        ? "transcription timed out"
        : "transcription transport failed",
      null,
      false,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (res.status === 429) {
    // Genuinely exhausted quota: do NOT retry here. Surface the hint so the
    // user waits instead of burning more quota.
    const retryAfterMs = parseRetryAfterMs(res.headers?.get?.("retry-after") ?? null);
    logger.warn("api: transcribe rate limited", {
      turnId,
      requestType: "transcribe",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "rate-limited",
      httpStatus: 429,
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    });
    throw new TranscriptionError(
      "API rate limit reached. Please wait and try again.",
      429,
      false,
      retryAfterMs,
    );
  }
  if (res.status === 401 || res.status === 403) {
    // Permanent credential rejection: never retried, never rotated client-side.
    logger.warn("api: transcribe failed", {
      turnId,
      requestType: "transcribe",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "auth-error",
      httpStatus: res.status,
    });
    throw new TranscriptionError("backend rejected frontend credentials", res.status, true);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn("api: transcribe failed", {
      turnId,
      requestType: "transcribe",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "error",
      httpStatus: res.status,
    });
    void body;
    throw new TranscriptionError(
      `transcription failed (HTTP ${res.status})`,
      res.status,
      true,
    );
  }
  const data = (await res.json()) as { text?: unknown };
  if (typeof data.text !== "string" || data.text.trim() === "") {
    logger.warn("api: transcribe failed", {
      turnId,
      requestType: "transcribe",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "empty-transcript",
      httpStatus: res.status,
    });
    throw new TranscriptionError("empty transcript returned", res.status, true);
  }
  logger.info("api: transcribe ok", {
    turnId,
    requestType: "transcribe",
    timestampMs: Date.now(),
    attempt: 1,
    outcome: "ok",
    httpStatus: res.status,
    transcriptChars: data.text.length,
  });
  return { text: data.text };
}

export { BackendError };
export type { BackendRef };
