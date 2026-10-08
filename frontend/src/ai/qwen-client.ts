/**
 * Qwen reasoning client — backend HTTP edition (architecture split).
 * The frontend NEVER talks to Groq: it POSTs the assembled payload to the
 * backend /v1/chat contract and re-validates the returned outcome with the
 * shared validator (trust-but-verify at the boundary).
 */
import type { AgentOutcome } from "../../../shared/types.js";
import {
  BackendError,
  ENDPOINTS,
  type BackendRef,
  type HybridScreenshot,
} from "../../../shared/api.js";
import {
  validateModelOutput,
  ModelOutputError,
} from "../../../shared/response-validator.js";
import { logger } from "../../../shared/logger.js";

/**
 * Reasoning retry policy: exactly ONE attempt per call at this layer.
 * The frontend never retries /v1/chat — bounded retries with Retry-After
 * handling live in the backend gateway (one retry max). A 429 here means the
 * shared free-tier budget is spent: surface it, do not re-request it.
 */
export const MAX_REASON_ATTEMPTS = 1;

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface ReasonInput {
  userPayload: string;
  systemPrompt?: string;
  effort?: ReasoningEffort;
  maxCompletionTokens?: number;
  backend: BackendRef;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Voice-turn correlation id, carried into logs and the backend body. */
  turnId?: string;
  /**
   * Phase 2 per-task cancellation. Aborting rejects the in-flight /v1/chat
   * fetch promptly (the controller discards the result silently). Composed
   * with the timeout below — whichever fires first wins; no behavior change
   * when absent.
   */
  signal?: AbortSignal;
  /**
   * EXPERIMENTAL hybrid context (CONTEXT_MODE=hybrid only). Omitted entirely
   * on the default path, and the backend drops it when its own CONTEXT_MODE is
   * "dom" — so this can never alter production behaviour by itself.
   */
  image?: HybridScreenshot;
}

/** Why a reasoning call failed, so callers can speak an honest message. */
export type QwenErrorKind =
  | "transport"
  | "rate_limit"
  | "auth"
  | "server"
  | "output";

export class QwenError extends Error {
  readonly fatal: boolean;
  readonly kind: QwenErrorKind;
  readonly status: number | undefined;
  constructor(message: string, fatal: boolean, kind: QwenErrorKind, status?: number) {
    super(message);
    this.name = "QwenError";
    this.fatal = fatal;
    this.kind = kind;
    this.status = status;
  }
}

function authHeaders(backend: BackendRef): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (backend.token !== undefined && backend.token !== "") {
    headers["Authorization"] = `Bearer ${backend.token}`;
  }
  return headers;
}

/** One reasoning call through the backend. Validated twice (both sides). */
export async function reasonOnce(input: ReasonInput): Promise<AgentOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? 45000,
  );
  // User cancellation composes with the timeout: either aborts the fetch.
  const onExternalAbort = (): void => controller.abort();
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const turnId = input.turnId ?? "no-turn";
  // Payload CONTENT is never logged (page text + user intent); length proves a
  // real reasoning call was made without leaking either.
  logger.info("api: chat attempt", {
    turnId,
    requestType: "chat",
    timestampMs: Date.now(),
    attempt: 1,
    maxAttempts: MAX_REASON_ATTEMPTS,
    payloadChars: input.userPayload.length,
    ...(input.image !== undefined
      ? { hybridImageBytes: input.image.bytes, hybridImageWidth: input.image.width, hybridImageHeight: input.image.height }
      : {}),
  });
  let res: Response;
  try {
    res = await (input.fetchImpl ?? fetch)(`${input.backend.url}${ENDPOINTS.chat}`, {
      method: "POST",
      headers: authHeaders(input.backend),
      body: JSON.stringify({
        userPayload: input.userPayload,
        ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.maxCompletionTokens !== undefined
          ? { maxCompletionTokens: input.maxCompletionTokens }
          : {}),
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        ...(input.image !== undefined ? { image: input.image } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    logger.warn("api: chat failed", {
      turnId,
      requestType: "chat",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "transport-error",
    });
    void err;
    throw new QwenError("reasoning transport failed", false, "transport");
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
  if (res.status === 429) {
    // Shared budget spent: surface, do not re-request. The agent speaks the
    // RATE_LIMITED message and ends the task instead of retrying.
    logger.warn("api: chat rate limited", {
      turnId,
      requestType: "chat",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "rate-limited",
      httpStatus: 429,
    });
    throw new QwenError("API rate limit reached. Please wait and try again.", false, "rate_limit", 429);
  }
  if (res.status === 401 || res.status === 403) {
    // Permanent credential rejection: never retried.
    logger.warn("api: chat failed", {
      turnId,
      requestType: "chat",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "auth-error",
      httpStatus: res.status,
    });
    throw new QwenError("backend rejected frontend credentials", true, "auth", res.status);
  }
  if (!res.ok) {
    await res.text().catch(() => "");
    logger.warn("api: chat failed", {
      turnId,
      requestType: "chat",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "error",
      httpStatus: res.status,
    });
    throw new QwenError(
      `backend chat failed (HTTP ${res.status})`,
      true,
      "server",
      res.status,
    );
  }
  const data = (await res.json()) as unknown;
  try {
    const outcome = validateModelOutput(data);
    logger.info("api: chat ok", {
      turnId,
      requestType: "chat",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "ok",
      httpStatus: res.status,
      outcomeType: outcome.type,
    });
    return outcome;
  } catch (err) {
    // Include a rejected skill_id (truncated) when present: it is the most
    // common shape violation from small local models (invented id with caps /
    // dashes / spaces), and the id alone carries no page content or secrets.
    // Anything else about the rejected body is deliberately never logged.
    let rejectedSkillId: string | undefined;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const rawId = (data as Record<string, unknown>)["skill_id"];
      if (typeof rawId === "string" && rawId !== "") {
        rejectedSkillId = rawId.slice(0, 80);
      }
    }
    logger.warn("api: chat failed", {
      turnId,
      requestType: "chat",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "invalid-outcome",
      httpStatus: res.status,
      ...(rejectedSkillId !== undefined ? { rejectedSkillId } : {}),
    });
    throw new QwenError(
      err instanceof ModelOutputError
        ? `backend returned invalid outcome: ${err.message}`
        : "backend returned unreadable outcome",
      true,
      "output",
    );
  }
}

export { BackendError };
export type { BackendRef };
