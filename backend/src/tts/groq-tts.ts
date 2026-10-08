/**
 * Groq TTS synthesis — REAL, live Groq /audio/speech endpoint.
 * Server-side only: holds the provider key, performs synthesis, returns audio.
 * Request shaping (chunking, language segmentation, caching) lives in the
 * frontend; this module synthesizes what the validated route hands it.
 * Live only (PRD 4 §67).
 *
 * Provider notes:
 * - One vendor now serves reasoning, transcription and speech, so there is a
 *   single key set and a single rate-limit story.
 * - The endpoint returns raw audio bytes (not a JSON base64 envelope).
 * - canopylabs/orpheus-v1-english is English-only and requires the account
 *   holder to accept its terms once; both are surfaced as distinct, actionable
 *   errors instead of a generic failure.
 */
import {
  GROQ_SPEECH_ENDPOINT,
  TTS_MODEL,
  TTS_REQUEST_TIMEOUT_MS,
  TTS_RESPONSE_FORMAT,
  TTS_VOICE,
} from "../../../shared/constants.js";
import { needsRomanization, transliterateHi } from "./transliterate.js";
import type { GroqKeyPool } from "../gateway/gateway.js";

export type TtsLang = "en" | "hi";

export interface GroqSpeechRequest {
  model: string;
  input: string;
  voice: string;
  response_format: string;
}

export class TtsAuthError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`TTS key rejected (HTTP ${status}) — check the server's GROQ_API_KEYS`);
    this.name = "TtsAuthError";
    this.status = status;
  }
}

/**
 * The TTS model is gated behind a one-time terms acceptance in the Groq
 * console. It is an account task, not a code fault, so it gets its own error
 * and its own instruction instead of a generic 500.
 */
export class TtsTermsError extends Error {
  readonly status: number;
  constructor() {
    super(
      "TTS model terms not accepted — the account holder must open the model page in the Groq console and accept",
    );
    this.name = "TtsTermsError";
    this.status = 400;
  }
}

export class TtsRequestError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`TTS request failed (HTTP ${status}): ${body.slice(0, 200)}`);
    this.name = "TtsRequestError";
    this.status = status;
  }
}

/** Pure request builder — unit-tested, no network. */
export function buildGroqSpeechRequest(text: string): GroqSpeechRequest {
  return {
    model: TTS_MODEL,
    input: text,
    voice: TTS_VOICE,
    response_format: TTS_RESPONSE_FORMAT,
  };
}

const WAV_HEADER_BYTES = 44;

/**
 * Wraps raw PCM16 mono samples in a WAV container for HTMLAudio playback.
 * Pure function — unit-tested (magic bytes, sizes, round-trip).
 */
export function wavWrap(pcm: Uint8Array, sampleRate = 24000): Uint8Array {
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.length);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}

/** True when the bytes already carry a RIFF/WAVE container. */
export function isWavContainer(bytes: Uint8Array): boolean {
  if (bytes.length < WAV_HEADER_BYTES) return false;
  return (
    String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0) === "RIFF" &&
    String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0) === "WAVE"
  );
}

const DEFAULT_SAMPLE_RATE = 24000;

function parseSampleRate(mimeType: string | undefined): number {
  if (mimeType === undefined) return DEFAULT_SAMPLE_RATE;
  const match = /rate=(\d+)/.exec(mimeType);
  const rate = match?.[1] !== undefined ? Number(match[1]) : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_SAMPLE_RATE;
}

/**
 * Normalizes the provider's audio to a playable WAV blob. Groq returns a WAV
 * container directly; a bare PCM payload (no RIFF header) is wrapped so the
 * browser's audio element can always play what we hand it.
 */
function toPlayableWav(bytes: Uint8Array, mimeType: string | undefined): Blob {
  if (isWavContainer(bytes)) {
    return new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" });
  }
  const wav = wavWrap(bytes, parseSampleRate(mimeType));
  return new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" });
}

export interface SynthesizeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface GroqErrorBody {
  error?: { message?: string; code?: string };
}

/**
 * Live speech synthesis through the shared key pool. Rotating keys here is not
 * cosmetic: TTS and reasoning share Groq's quota, and a single key serving both
 * was the direct cause of mid-turn 429s.
 */
export async function synthesizeChunk(
  text: string,
  lang: TtsLang,
  deps: { pool: GroqKeyPool; apiKey?: string },
  options: SynthesizeOptions = {},
): Promise<Blob> {
  // Orpheus is English-only: romanize Devanagari so Hindi still speaks instead
  // of being refused or mangled.
  const speakable =
    lang === "hi" && needsRomanization(text) ? transliterateHi(text) : text;
  const key = deps.apiKey ?? deps.pool.next();
  if (key === null || key === "") {
    throw new TtsAuthError(401);
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? TTS_REQUEST_TIMEOUT_MS,
  );
  try {
    const res = await (options.fetchImpl ?? fetch)(GROQ_SPEECH_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildGroqSpeechRequest(speakable)),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new TtsAuthError(res.status);
    }
    if (res.status === 429) {
      throw new TtsRequestError(res.status, "rate limited");
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      let code = "";
      let message = raw;
      try {
        const parsed = JSON.parse(raw) as GroqErrorBody;
        code = parsed.error?.code ?? "";
        message = parsed.error?.message ?? raw;
      } catch {
        // non-JSON error body: keep the raw text
      }
      if (code === "model_terms_required" || /terms acceptance/i.test(message)) {
        throw new TtsTermsError();
      }
      throw new TtsRequestError(res.status, message);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) {
      throw new TtsRequestError(res.status, "empty audio returned");
    }
    return toPlayableWav(bytes, res.headers.get("content-type") ?? undefined);
  } finally {
    clearTimeout(timeout);
  }
}