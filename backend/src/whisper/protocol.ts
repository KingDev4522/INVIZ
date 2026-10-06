/**
 * Whisper transcription protocol (backend side).
 * Builds provider multipart bodies and applies the model-fallback discipline
 * (turbo → v3 on model errors only) over a caller-supplied key pool.
 * Audio arrives from the frontend as base64 (contract: TranscribeRequest).
 */
import {
  WHISPER_FALLBACK_MODEL,
  WHISPER_PRIMARY_MODEL,
} from "../../../shared/constants.js";
import {
  GatewayError,
  GroqKeyPool,
  postTranscription,
} from "../gateway/gateway.js";

export class TranscriptionError extends Error {
  readonly status: number | null;
  readonly fatal: boolean;
  constructor(message: string, status: number | null, fatal: boolean) {
    super(message);
    this.name = "TranscriptionError";
    this.status = status;
    this.fatal = fatal;
  }
}

export interface ProtocolOptions {
  pool: GroqKeyPool;
  model?: string;
  language?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Exact-view copy: Buffer pooling makes buffer/views subtle — be explicit. */
function toExactFile(audio: Buffer, mimeType: string): File {
  return new File([new Uint8Array(audio)], "audio.webm", { type: mimeType });
}

function formFor(audio: Buffer, mimeType: string, model: string, language?: string): FormData {
  const form = new FormData();
  form.append("file", toExactFile(audio, mimeType));
  form.append("model", model);
  form.append("response_format", "json");
  if (language !== undefined && language !== "") {
    form.append("language", language);
  }
  return form;
}

function toTranscriptionError(err: unknown): TranscriptionError {
  if (err instanceof GatewayError) {
    if (err.kind === "auth") {
      return new TranscriptionError("Groq key rejected (HTTP 401)", 401, true);
    }
    if (err.kind === "rate_limit") {
      return new TranscriptionError("rate limited (retry with backoff)", 429, false);
    }
    if (err.kind === "timeout" || err.kind === "network") {
      return new TranscriptionError(err.message, null, false);
    }
    return new TranscriptionError(err.message, err.status, true);
  }
  return new TranscriptionError(
    err instanceof Error ? `network: ${err.message}` : "network failure",
    null,
    false,
  );
}

export async function transcribeViaPool(
  audio: Buffer,
  mimeType: string,
  opts: ProtocolOptions,
): Promise<{ text: string }> {
  const models = [opts.model ?? WHISPER_PRIMARY_MODEL, WHISPER_FALLBACK_MODEL];
  let lastError: TranscriptionError | null = null;
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i] ?? WHISPER_PRIMARY_MODEL;
    try {
      // eslint-disable-next-line no-await-in-loop
      return await postTranscription({
        pool: opts.pool,
        form: () => formFor(audio, mimeType, model, opts.language),
        timeoutMs: opts.timeoutMs ?? 60000,
        maxRetries: 0,
        fetchImpl: opts.fetchImpl,
      });
    } catch (err) {
      const mapped = toTranscriptionError(err);
      const isModelError =
        err instanceof GatewayError &&
        err.kind === "provider" &&
        (err.status === 400 || err.status === 404);
      lastError = mapped;
      if (!isModelError || i === models.length - 1) throw mapped;
    }
  }
  throw lastError ?? new TranscriptionError("transcription failed", null, true);
}
