/**
 * POST /v1/transcribe — live Whisper transcription (PRD 6.3).
 * Accepts base64 audio (JSON, no multipart needed on this boundary) and
 * returns transcript text. Model fallback discipline lives in the protocol.
 */
import { transcribeViaPool, TranscriptionError } from "../whisper/protocol.js";
import { logger } from "../../../shared/logger.js";
import type { GroqKeyPool } from "../gateway/gateway.js";

export interface TranscribeDeps {
  pool: GroqKeyPool;
  fetchImpl?: typeof fetch;
}

const MAX_AUDIO_BASE64_CHARS = 7_000_000; // ~5MB of audio

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function handleTranscribe(
  body: unknown,
  deps: TranscribeDeps,
): Promise<{ status: number; payload: unknown }> {
  if (!isRecord(body) || typeof body["audioBase64"] !== "string" || body["audioBase64"] === "") {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "audioBase64 must be a non-empty string" } } };
  }
  if (body["audioBase64"].length > MAX_AUDIO_BASE64_CHARS) {
    return { status: 413, payload: { error: { code: "PAYLOAD_TOO_LARGE", message: "audio exceeds the 60-second capture budget" } } };
  }
  const language = body["language"];
  if (language !== undefined && typeof language !== "string") {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "language must be a string" } } };
  }
  let audio: Buffer;
  try {
    audio = Buffer.from(body["audioBase64"] as string, "base64");
  } catch {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "audioBase64 is not valid base64" } } };
  }
  if (audio.length === 0) {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "audio decoded to zero bytes" } } };
  }
  const mimeType =
    typeof body["mimeType"] === "string" && body["mimeType"] !== ""
      ? (body["mimeType"] as string)
      : "audio/webm;codecs=opus";
  const turnId = typeof body["turnId"] === "string" ? (body["turnId"] as string) : undefined;
  try {
    const result = await transcribeViaPool(audio, mimeType, {
      pool: deps.pool,
      language: typeof language === "string" ? language : undefined,
      fetchImpl: deps.fetchImpl,
    });
    return { status: 200, payload: { text: result.text } };
  } catch (err) {
    if (err instanceof TranscriptionError) {
      if (!err.fatal) {
        logger.warn("transcribe: rate limited", {
          ...(turnId !== undefined ? { turnId } : {}),
          errorCode: "RATE_LIMITED",
          httpStatus: 429,
          audioBytes: audio.length,
        });
        return { status: 429, payload: { error: { code: "RATE_LIMITED", message: "transcription rate limited" } } };
      }
      const code = err.status === 401 ? "PROVIDER_AUTH" : "TRANSCRIPTION_FAILED";
      return { status: 500, payload: { error: { code, message: "transcription failed" } } };
    }
    return { status: 500, payload: { error: { code: "TRANSCRIPTION_FAILED", message: "transcription failed" } } };
  }
}
