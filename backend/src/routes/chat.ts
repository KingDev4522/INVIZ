/**
 * POST /v1/chat — live Qwen reasoning (PRD 6.4).
 * Validates the request, reasons through the shared key pool, and returns a
 * validated AgentOutcome. Qwen/model errors map to 5xx; bad input to 400.
 */
import { reasonOnce } from "../ai/qwen-client.js";
import { QwenError, type LatencyMarks } from "../ai/qwen-client.js";
import { traceFailure, traceRequestSeen } from "../ai/trace.js";
import { logger } from "../../../shared/logger.js";
import type { GroqKeyPool } from "../gateway/gateway.js";
import type { ContextMode } from "../../../shared/constants.js";
import { MAX_HYBRID_IMAGE_B64_CHARS } from "../../../shared/constants.js";
import type { HybridScreenshot } from "../../../shared/api.js";

export interface ChatDeps {
  pool: GroqKeyPool;
  openrouter?: { apiKey: string; model: string };
  ollama?: { url: string; model: string; keepAlive?: string };
  llmProvider?: "auto" | "ollama" | "groq" | "openrouter";
  /** EXPERIMENTAL: "dom" (default) drops any attached image. */
  contextMode?: ContextMode;
  fetchImpl?: typeof fetch;
}

const EFFORTS = ["none", "low", "medium", "high"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Base64 charset (standard alphabet, optional padding). No whitespace allowed. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validates the EXPERIMENTAL hybrid screenshot.
 *
 * Returns "absent" for the normal text-only request, "invalid" for a malformed
 * image (the request is rejected so a broken client never silently sends
 * garbage), or a narrowed value. Validation is deliberately strict because
 * this string is forwarded verbatim into a provider request.
 */
function readImage(
  raw: unknown,
):
  | { kind: "absent" }
  | { kind: "invalid"; message: string }
  | { kind: "valid"; value: HybridScreenshot } {
  if (raw === undefined) return { kind: "absent" };
  if (!isRecord(raw)) return { kind: "invalid", message: "image must be an object" };
  const b64 = raw["b64"];
  if (typeof b64 !== "string" || b64.length === 0) {
    return { kind: "invalid", message: "image.b64 must be a non-empty base64 string" };
  }
  if (b64.length > MAX_HYBRID_IMAGE_B64_CHARS) {
    return {
      kind: "invalid",
      message: `image.b64 exceeds ${MAX_HYBRID_IMAGE_B64_CHARS} characters (capture was not downscaled?)`,
    };
  }
  if (!BASE64_RE.test(b64)) {
    return { kind: "invalid", message: "image.b64 is not valid base64" };
  }
  const width = raw["width"];
  const height = raw["height"];
  if (!Number.isInteger(width) || (width as number) < 1 || (width as number) > 20000) {
    return { kind: "invalid", message: "image.width must be an integer in [1, 20000]" };
  }
  if (!Number.isInteger(height) || (height as number) < 1 || (height as number) > 20000) {
    return { kind: "invalid", message: "image.height must be an integer in [1, 20000]" };
  }
  const bytes = raw["bytes"];
  if (!Number.isInteger(bytes) || (bytes as number) < 1 || (bytes as number) > 4_000_000) {
    return { kind: "invalid", message: "image.bytes must be an integer in [1, 4000000]" };
  }
  return {
    kind: "valid",
    value: {
      b64,
      width: width as number,
      height: height as number,
      bytes: bytes as number,
      ...(typeof raw["sourceWidth"] === "number" ? { sourceWidth: raw["sourceWidth"] } : {}),
      ...(typeof raw["sourceHeight"] === "number" ? { sourceHeight: raw["sourceHeight"] } : {}),
      ...(isRecord(raw["timings"]) ? { timings: raw["timings"] as Record<string, number> } : {}),
    },
  };
}

/**
 * Phase 8: one consolidated latency record per reasoning turn.
 *
 * Timeline (all deltas relative to T1 = request received):
 *   T2..T6 arrive on image.timings (frontend capture/encode/context packaging)
 *   T1->T7  request parsing, payload handling, provider selection (backend prep)
 *   T7->T8  model inference (the serving provider)
 *   T8->T9  structured-output validation
 *
 * Missing marks mean that stage did not run (e.g. an error before T7). Log-only.
 */
function logLatency(
  marks: LatencyMarks,
  image: HybridScreenshot | undefined,
  outcomeType: string,
  contextMode: ContextMode | undefined,
  turnId: string | undefined,
): void {
  const t = marks;
  const timing = image?.timings;
  logger.info("latency: reasoning turn", {
    contextMode: contextMode ?? "dom",
    outcomeType,
    ...(turnId !== undefined ? { turnId } : {}),
    provider: t.provider ?? "none",
    // Frontend (Phase 8 T2-T6) — only present on a hybrid capture.
    ...(timing !== undefined
      ? {
          t2_captureMs: timing["captureMs"],
          t4_encodeMs: timing["encodeMs"],
          t5_contextMs: timing["contextMs"],
          t6_frontendTotalMs: timing["frontendTotalMs"],
        }
      : {}),
    // Image actually shipped.
    ...(image !== undefined
      ? {
          imageBytes: image.bytes,
          imageWidth: image.width,
          imageHeight: image.height,
          imageSourceWidth: image.sourceWidth,
          imageSourceHeight: image.sourceHeight,
        }
      : {}),
    // Backend (T7-T9) relative to T1.
    ...(t.t7 !== undefined ? { t1_to_t7_prepMs: t.t7 - t.t1 } : {}),
    ...(t.t7 !== undefined && t.t8 !== undefined ? { t7_to_t8_inferenceMs: t.t8 - t.t7 } : {}),
    ...(t.t8 !== undefined && t.t9 !== undefined ? { t8_to_t9_validateMs: t.t9 - t.t8 } : {}),
    backendTotalMs: (t.t9 ?? Date.now()) - t.t1,
  });
}

export async function handleChat(
  body: unknown,
  deps: ChatDeps,
): Promise<{ status: number; payload: unknown }> {
  if (!isRecord(body) || typeof body["userPayload"] !== "string" || body["userPayload"].trim() === "") {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "userPayload must be a non-empty string" } } };
  }
  if (body["userPayload"].length > 60000) {
    return { status: 400, payload: { error: { code: "PAYLOAD_TOO_LARGE", message: "userPayload exceeds 60000 characters" } } };
  }
  if (body["effort"] !== undefined && !(EFFORTS as readonly string[]).includes(String(body["effort"]))) {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "effort must be none|low|medium|high" } } };
  }
  const maxTokens = body["maxCompletionTokens"];
  if (
    maxTokens !== undefined &&
    (!Number.isInteger(maxTokens) || (maxTokens as number) < 16 || (maxTokens as number) > 16000)
  ) {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "maxCompletionTokens must be an integer in [16, 16000]" } } };
  }
  // Log-only correlation: proves which voice turn caused which provider call.
  const turnId = typeof body["turnId"] === "string" ? (body["turnId"] as string) : undefined;

  // EXPERIMENTAL hybrid context. A malformed image is a hard 400 (never send
  // garbage to a provider); a VALID image is only honoured when the backend
  // itself is opted in. In the default dom mode it is dropped and the request
  // is served exactly as it was before the prototype existed.
  const imageCheck = readImage(body["image"]);
  if (imageCheck.kind === "invalid") {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: imageCheck.message } } };
  }
  const hybridActive = deps.contextMode === "hybrid";
  const image = imageCheck.kind === "valid" && hybridActive ? imageCheck.value : undefined;
  if (imageCheck.kind === "valid" && !hybridActive) {
    logger.info("chat: image ignored (CONTEXT_MODE=dom)", {
      ...(turnId !== undefined ? { turnId } : {}),
      bytes: imageCheck.value.bytes,
      width: imageCheck.value.width,
      height: imageCheck.value.height,
    });
  }

  // T1 = request received. Emitted for EVERY turn (dom and hybrid) so the
  // experiment has a real baseline as well as a hybrid sample.
  const latency: LatencyMarks = { t1: Date.now() };

  // Opt-in terminal trace (INVIZ_AI_TRACE=true): allowlisted + truncated only.
  traceRequestSeen({
    ...(turnId !== undefined ? { turnId } : {}),
    provider: deps.llmProvider ?? "auto",
    model: deps.ollama?.model ?? "(cloud standby chain)",
    contextMode: hybridActive ? "hybrid" : "dom",
    userPayload: body["userPayload"] as string,
    ...(image !== undefined
      ? { imageMeta: { width: image.width, height: image.height, bytes: image.bytes } }
      : {}),
  });

  try {
    const outcome = await reasonOnce({
      systemPrompt: typeof body["systemPrompt"] === "string" ? body["systemPrompt"] : undefined,
      userPayload: body["userPayload"] as string,
      effort: (body["effort"] as "none" | "low" | "medium" | "high" | undefined) ?? "none",
      maxCompletionTokens: typeof maxTokens === "number" ? maxTokens : undefined,
      pool: deps.pool,
      ...(deps.openrouter !== undefined ? { openrouter: deps.openrouter } : {}),
      ...(deps.ollama !== undefined ? { ollama: deps.ollama } : {}),
      ...(deps.llmProvider !== undefined ? { llmProvider: deps.llmProvider } : {}),
      ...(image !== undefined ? { image } : {}),
      latency,
      ...(turnId !== undefined ? { turnId } : {}),
      fetchImpl: deps.fetchImpl,
    });
    logLatency(latency, image, outcome.type, deps.contextMode, turnId);
    return { status: 200, payload: outcome };
  } catch (err) {
    logLatency(latency, image, "error", deps.contextMode, turnId);
    if (err instanceof QwenError) {
      const status = err.httpStatus ?? 500;
      const code =
        status === 429 ? "RATE_LIMITED" : status === 504 ? "PROVIDER_TIMEOUT" : "REASONING_FAILED";
      traceFailure(turnId, "reasoning", code);
      // The client gets a generic code (no provider detail leaks to the page),
      // but the real cause is logged server-side. Without this line a contract
      // violation and an outage were indistinguishable from the outside.
      logger.warn("chat: reasoning failed", {
        ...(turnId !== undefined ? { turnId } : {}),
        errorCode: code,
        httpStatus: status,
        reason: err.message,
      });
      return { status, payload: { error: { code, message: "reasoning request failed" } } };
    }
    logger.error("chat: reasoning failed (unexpected)", {
      reason: err instanceof Error ? err.message : "unknown",
    });
    return { status: 500, payload: { error: { code: "REASONING_FAILED", message: "reasoning request failed" } } };
  }
}
