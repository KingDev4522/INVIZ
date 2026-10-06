/**
 * POST /v1/chat — live Qwen reasoning (PRD 6.4).
 * Validates the request, reasons through the shared key pool, and returns a
 * validated AgentOutcome. Qwen/model errors map to 5xx; bad input to 400.
 */
import { reasonOnce } from "../ai/qwen-client.js";
import { QwenError } from "../ai/qwen-client.js";
import { logger } from "../../../shared/logger.js";
import type { GroqKeyPool } from "../gateway/gateway.js";

export interface ChatDeps {
  pool: GroqKeyPool;
  openrouter?: { apiKey: string; model: string };
  ollama?: { url: string; model: string; keepAlive?: string };
  llmProvider?: "auto" | "ollama" | "groq" | "openrouter";
  fetchImpl?: typeof fetch;
}

const EFFORTS = ["none", "low", "medium", "high"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
      ...(turnId !== undefined ? { turnId } : {}),
      fetchImpl: deps.fetchImpl,
    });
    return { status: 200, payload: outcome };
  } catch (err) {
    if (err instanceof QwenError) {
      const status = err.httpStatus ?? 500;
      const code =
        status === 429 ? "RATE_LIMITED" : status === 504 ? "PROVIDER_TIMEOUT" : "REASONING_FAILED";
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
