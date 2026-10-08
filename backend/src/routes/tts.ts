/**
 * POST /v1/tts — live Groq speech synthesis (PRD 6.2).
 * Accepts plain text (≤4000 chars; the frontend chunks) and returns WAV audio
 * as base64. Devanagari is romanized server-side before synthesis (the voice
 * is English-only). Provider refusals surface as real status codes, never
 * silence.
 */
import {
  synthesizeChunk,
  TtsAuthError,
  TtsRequestError,
  TtsTermsError,
} from "../tts/groq-tts.js";
import { TTS_MAX_CHARS } from "../../../shared/api.js";
import { logger } from "../../../shared/logger.js";
import type { GroqKeyPool } from "../gateway/gateway.js";

export interface TtsDeps {
  pool: GroqKeyPool;
  fetchImpl?: typeof fetch;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function handleTts(
  body: unknown,
  deps: TtsDeps,
): Promise<{ status: number; payload: unknown }> {
  if (!isRecord(body) || typeof body["text"] !== "string" || body["text"].trim() === "") {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "text must be a non-empty string" } } };
  }
  if (body["text"].length > TTS_MAX_CHARS) {
    return {
      status: 400,
      payload: {
        error: {
          code: "TEXT_TOO_LONG",
          message: `text exceeds ${TTS_MAX_CHARS} characters — chunk client-side`,
        },
      },
    };
  }
  if (body["lang"] !== "en" && body["lang"] !== "hi") {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "lang must be en|hi" } } };
  }
  const turnId = typeof body["turnId"] === "string" ? (body["turnId"] as string) : undefined;
  try {
    const blob = await synthesizeChunk(body["text"], body["lang"], { pool: deps.pool }, { fetchImpl: deps.fetchImpl });
    const buffer = Buffer.from(await blob.arrayBuffer());
    return {
      status: 200,
      payload: {
        audioBase64: buffer.toString("base64"),
        mimeType: "audio/wav",
        sampleRate: 24000,
      },
    };
  } catch (err) {
    if (err instanceof TtsAuthError) {
      logger.error("tts: provider rejected the key", { errorCode: "PROVIDER_AUTH" });
      return { status: 500, payload: { error: { code: "PROVIDER_AUTH", message: "speech provider rejected the server key" } } };
    }
    if (err instanceof TtsTermsError) {
      // Account-level, one-time action — the caller needs to say exactly what
      // to do rather than "synthesis failed".
      logger.error("tts: model terms not accepted", { errorCode: "TTS_TERMS" });
      return {
        status: 503,
        payload: {
          error: {
            code: "TTS_TERMS",
            message:
              "the TTS model's terms have not been accepted — open the model page in the Groq console and accept them once",
          },
        },
      };
    }
    if (err instanceof TtsRequestError) {
      if (err.status === 429) {
        logger.warn("tts: rate limited", {
          ...(turnId !== undefined ? { turnId } : {}),
          errorCode: "RATE_LIMITED",
          httpStatus: 429,
        });
        return { status: 429, payload: { error: { code: "RATE_LIMITED", message: "synthesis rate limited" } } };
      }
      logger.error("tts: synthesis failed", {
        errorCode: "TTS_FAILED",
        httpStatus: err.status,
        reason: err.message,
      });
      return { status: 500, payload: { error: { code: "TTS_FAILED", message: "synthesis failed" } } };
    }
    logger.error("tts: synthesis failed (unexpected)", {
      errorCode: "TTS_FAILED",
      reason: err instanceof Error ? err.message : "unknown",
    });
    return { status: 500, payload: { error: { code: "TTS_FAILED", message: "synthesis failed" } } };
  }
}