/**
 * Qwen reasoning client — REAL, live Groq (PRD 6.4 §1.2, §4.5).
 * Pinned qwen/qwen3.8-27b with openai/gpt-oss-20b fallback, reasoning_effort
 * policy, token bounds. No response_format: Groq rejects json_object for
 * these models (HTTP 400, live-proven); SYSTEM_PROMPT_V1 mandates JSON-only
 * output and every response passes the output-contract validator instead.
 * Effort "none" omits reasoning_effort (gpt-oss rejects "none"; qwen works
 * either way). Malformed output is a failure, never an interpretation.
 */
import {
  QWEN_CONTRACT_RETRY_HEADROOM,
  QWEN_FALLBACK_MODEL,
  QWEN_MAX_COMPLETION_TOKENS_INTERACTIVE,
  QWEN_PRIMARY_MODEL,
} from "../../../shared/constants.js";
import {
  GatewayError,
  GroqKeyPool,
  postChat,
} from "../gateway/gateway.js";
import { postChatOpenRouter, type OpenRouterRef } from "../gateway/openrouter.js";
import { postChatOllama, type OllamaRef } from "../gateway/ollama.js";
import {
  validateModelOutput,
  ModelOutputError,
} from "../../../shared/response-validator.js";
import { SYSTEM_PROMPT_V1 } from "./schemas.js";
import { logger } from "../../../shared/logger.js";
import type { AgentOutcome } from "../../../shared/types.js";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface ReasonInput {
  systemPrompt?: string;
  userPayload: string;
  /** Interactive calls use "none"; async enrichment may use low/medium. */
  effort?: ReasoningEffort;
  maxCompletionTokens?: number;
  pool: GroqKeyPool;
  /**
   * Second reasoning vendor. Absent (or empty key) = Groq-only, exactly the
   * previous behavior. Audio never routes here — reasoning only.
   */
  openrouter?: OpenRouterRef;
  /**
   * LOCAL reasoning provider (additive). Absent/empty = never used. Preferred
   * over cloud when present; Groq stays a bounded standby.
   */
  ollama?: OllamaRef;
  /**
   * Primary provider selector. "auto" (default) = local-first with a bounded
   * cloud standby chain (NEVER rotation). An explicit name pins it first.
   */
  llmProvider?: "auto" | "ollama" | "groq" | "openrouter";
  /** Voice-turn correlation id, for provider log attribution only. */
  turnId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type ReasoningProvider = "ollama" | "openrouter" | "groq";

/**
 * Round-robin was REMOVED in Phase 2. `auto` now means local-first with a
 * bounded cloud standby chain; it never alternates between healthy providers,
 * so a normal turn consumes no cloud reasoning quota.
 */
let roundRobinCursor = 0; // retained only so __resetReasoningRotation stays total
/**
 * Latched when OpenRouter rejects its key (401/403): skipped until process
 * restart. A dead key must not cost a wasted call on every turn.
 */
let openrouterSuspended = false;
/**
 * Latched when the local Ollama endpoint is unreachable/misconfigured. Local
 * inference that is down must not add latency to every single turn; Groq takes
 * over immediately and the latch is cleared by a restart.
 */
let ollamaSuspended = false;

/** Test-only reset for latches (deterministic assertions). */
export function __resetReasoningRotation(): void {
  roundRobinCursor = 0;
  openrouterSuspended = false;
  ollamaSuspended = false;
}

/**
 * Builds the attempt order for ONE reasoning operation.
 *
 * Phase 2 policy — no rotation, ever:
 * - `auto`    → preference order [ollama, openrouter, groq]: local first, cloud
 *               only as a bounded standby when local actually FAILS.
 * - a pinned provider → that provider first, then the remaining configured ones
 *               as standbys (so an explicit choice still degrades gracefully).
 *
 * The list contains each available provider at most once, which is what makes
 * the failover loop in reasonOnce unable to ping-pong.
 */
export function reasoningOrder(
  available: ReasoningProvider[],
  llmProvider: "auto" | ReasoningProvider = "auto",
): ReasoningProvider[] {
  if (available.length === 0) return [];
  if (llmProvider !== "auto" && available.includes(llmProvider)) {
    return [llmProvider, ...available.filter((p) => p !== llmProvider)];
  }
  // `available` is already built in preference order (local → cloud) and is
  // returned as-is: a healthy local provider MUST end the request.
  return available;
}

/** Stable, log-safe classification of why a provider was abandoned. */
export function fallbackReasonFor(provider: ReasoningProvider, err: unknown): string {
  const kind = err instanceof GatewayError ? err.kind : "unknown";
  if (provider !== "ollama") {
    return `${provider.toUpperCase()}_${kind.toUpperCase()}`;
  }
  switch (kind) {
    case "network":
      return "OLLAMA_UNAVAILABLE";
    case "timeout":
      return "OLLAMA_TIMEOUT";
    case "auth":
      return "OLLAMA_MODEL_MISSING";
    case "schema":
      return "OLLAMA_MALFORMED_OUTPUT";
    case "provider":
      return "OLLAMA_HTTP_ERROR";
    default:
      return `OLLAMA_${kind.toUpperCase()}`;
  }
}

export class QwenError extends Error {
  readonly fatal: boolean;
  /** Suggested HTTP mapping for the route layer (default 500). */
  readonly httpStatus: number;
  constructor(message: string, fatal: boolean, httpStatus = 500) {
    super(message);
    this.name = "QwenError";
    this.fatal = fatal;
    this.httpStatus = httpStatus;
  }
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

function extractContent(res: unknown): unknown {
  const typed = res as ChatResponse;
  const content = typed.choices?.[0]?.message?.content;
  if (content === undefined || content === null) {
    throw new QwenError("chat response had no message content", true);
  }
  return content;
}

/** Max contract-level re-asks per model before the outcome is a hard failure. */
const CONTRACT_ATTEMPTS = 2;

function correctionSuffix(rejection: string): string {
  return (
    `\n\n[FORMAT CORRECTION — your previous reply was rejected: ${rejection}]\n` +
    `Reply again with ONLY the single JSON object described above. ` +
    `No prose before or after it, no markdown code fences, no explanation, ` +
    `no extra keys inside the "action" object.`
  );
}

/**
 * Runs the model loop (primary → fallback) against ONE vendor, with the
 * contract-level corrective re-ask. Throws QwenError; the caller decides
 * whether the other vendor gets a turn (failover).
 */
async function attemptVendor(
  provider: ReasoningProvider,
  models: string[],
  chat: (model: string, userPayload: string, attempt: number) => Promise<unknown>,
  input: ReasonInput,
): Promise<AgentOutcome> {
  let lastError: QwenError | null = null;
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i] ?? QWEN_PRIMARY_MODEL;
    try {
      // Contract-level retry: reasoning models intermittently answer with prose,
      // a fenced block, or a stray key. One corrective re-ask with extra token
      // headroom recovers those turns instead of failing the user's whole task.
      // Only a *rejected reply* is retried — never a transport/provider error.
      let userPayload = input.userPayload;
      for (let attempt = 0; attempt < CONTRACT_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await chat(model, userPayload, attempt);
        const content = extractContent(res);
        try {
          return validateModelOutput(content);
        } catch (err) {
          if (err instanceof ModelOutputError && attempt + 1 < CONTRACT_ATTEMPTS) {
            userPayload = input.userPayload + correctionSuffix(err.message);
            continue;
          }
          throw err;
        }
      }
      throw new QwenError("output contract violated after re-ask", true);
    } catch (err) {
      if (err instanceof ModelOutputError) {
        throw new QwenError(`output contract violated: ${err.message}`, true);
      }
      if (err instanceof GatewayError) {
        const httpStatus =
          err.kind === "rate_limit" ? 429 : err.kind === "timeout" ? 504 : 500;
        lastError = new QwenError(`gateway ${err.kind}: ${err.message}`, !err.retryable, httpStatus);
        if (provider === "openrouter" && err.kind === "auth") {
          // Dead key: latch off so every turn doesn't waste a call on it.
          openrouterSuspended = true;
          logger.error("reasoning: OpenRouter key rejected — latched to Groq-only", {
            errorCode: "PROVIDER_AUTH",
          });
        }
        if (provider === "ollama" && (err.kind === "auth" || err.kind === "network")) {
          // Missing model or Ollama not running: latch off so turns don't each
          // pay a connection timeout before failing over.
          ollamaSuspended = true;
          logger.warn("reasoning: local Ollama unavailable — latched to cloud", {
            provider,
            kind: err.kind,
          });
        }
        // Fallback model is for provider/model failures, not for auth or
        // rate-limit states (rotating models cannot fix those — but the OTHER
        // vendor can, which the caller handles).
        const fallbackWorthy = err.kind === "provider" || err.kind === "schema";
        if (!fallbackWorthy || i === models.length - 1) throw lastError;
        continue;
      }
      throw new QwenError(
        err instanceof Error ? err.message : "reasoning failed",
        true,
      );
    }
  }
  throw lastError ?? new QwenError("reasoning failed", true);
}

function chatBody(input: ReasonInput, userPayload: string, attempt: number): Record<string, unknown> {
  const effort = input.effort ?? "none";
  return {
    messages: [
      { role: "system", content: input.systemPrompt ?? SYSTEM_PROMPT_V1 },
      { role: "user", content: userPayload },
    ],
    // reasoning_effort only when reasoning is actually requested.
    ...(effort !== "none" ? { reasoning_effort: effort } : {}),
    max_completion_tokens:
      (input.maxCompletionTokens ?? QWEN_MAX_COMPLETION_TOKENS_INTERACTIVE) +
      // Headroom on the re-ask: a reply cut off mid-object is the most
      // common cause of "not parseable JSON".
      (attempt > 0 ? QWEN_CONTRACT_RETRY_HEADROOM : 0),
  };
}

/** Chat-shaped content for the local model (Ollama takes the same messages). */
function localChatBody(input: ReasonInput, userPayload: string, attempt: number): Record<string, unknown> {
  return { messages: chatBody(input, userPayload, attempt).messages };
}

export async function reasonOnce(input: ReasonInput): Promise<AgentOutcome> {
  const orRef =
    input.openrouter !== undefined && input.openrouter.apiKey !== "" && !openrouterSuspended
      ? input.openrouter
      : null;
  const localRef =
    input.ollama !== undefined && input.ollama.url !== "" && !ollamaSuspended
      ? input.ollama
      : null;
  // Preference order: local (free, unmetered) → OpenRouter → Groq. Groq is
  // always available, so it is the terminal standby.
  const available: ReasoningProvider[] = [
    ...(localRef !== null ? (["ollama"] as ReasoningProvider[]) : []),
    ...(orRef !== null ? (["openrouter"] as ReasoningProvider[]) : []),
    "groq",
  ];
  const order = reasoningOrder(available, input.llmProvider ?? "auto");
  let lastError: QwenError | null = null;
  for (const provider of order) {
    try {
      if (provider === "ollama" && localRef !== null) {
        logger.info("reasoning via ollama", {
          provider: "ollama",
          model: localRef.model,
          ...(input.turnId !== undefined && input.turnId !== "" ? { turnId: input.turnId } : {}),
        });
        // Local inference: SINGLE attempt (no hidden retry) — a slow local
        // model must not multiply requests per turn.
        // eslint-disable-next-line no-await-in-loop
        return await attemptVendor(
          provider,
          [localRef.model],
          (model, userPayload, attempt) =>
            postChatOllama({
              ref: { url: localRef.url, model, ...(localRef.keepAlive !== undefined ? { keepAlive: localRef.keepAlive } : {}) },
              body: localChatBody(input, userPayload, attempt),
              // Bounded so a cold load is never mistaken for a dead endpoint
              // (which would spend cloud quota on a healthy local model).
              timeoutMs: input.timeoutMs ?? 180_000,
              maxRetries: 0,
              ...(input.turnId !== undefined && input.turnId !== "" ? { turnId: input.turnId } : {}),
              fetchImpl: input.fetchImpl,
            }).then((r) => ({
              // Normalized into the SAME shape extractContent already reads, so
              // the local model goes through the identical validation pipeline
              // as every cloud provider — no separate, weaker local path.
              choices: [{ message: { content: r.content } }],
            })),
          input,
        );
      }
      if (provider === "openrouter" && orRef !== null) {
        logger.info("reasoning via openrouter", { provider: "openrouter", model: orRef.model });
        // eslint-disable-next-line no-await-in-loop
        return await attemptVendor(
          provider,
          [orRef.model],
          (model, userPayload, attempt) =>
            postChatOpenRouter({
              ref: { apiKey: orRef.apiKey, model },
              body: chatBody(input, userPayload, attempt),
              timeoutMs: input.timeoutMs ?? 30000,
              maxRetries: 1,
              fetchImpl: input.fetchImpl,
            }),
          input,
        );
      }
      logger.info("reasoning via groq", { provider: "groq", model: QWEN_PRIMARY_MODEL });
      // eslint-disable-next-line no-await-in-loop
      return await attemptVendor(
        provider,
        [QWEN_PRIMARY_MODEL, QWEN_FALLBACK_MODEL],
        (model, userPayload, attempt) =>
          postChat({
            pool: input.pool,
            body: { model, ...chatBody(input, userPayload, attempt) },
            timeoutMs: input.timeoutMs ?? 30000,
            maxRetries: 1,
            fetchImpl: input.fetchImpl,
          }),
        input,
      );
    } catch (err) {
      // Cross-provider failover: a 429/timeout/outage on one quota must not end
      // the user's command when another provider is healthy. `order` contains
      // each provider at most once, so this can never loop. Cloud is touched
      // ONLY after the local provider actually failed.
      if (err instanceof QwenError) {
        logger.warn("reasoning provider failed; failing over", {
          provider,
          ...(input.turnId !== undefined && input.turnId !== "" ? { turnId: input.turnId } : {}),
          httpStatus: err.httpStatus,
          outcome: "failure",
          fallbackReason: fallbackReasonFor(provider, err),
          reason: err.message,
        });
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new QwenError("reasoning failed", true);
}
