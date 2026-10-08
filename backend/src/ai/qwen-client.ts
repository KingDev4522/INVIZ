/**
 * Qwen reasoning client — REAL, live Groq (PRD 6.4 §1.2, §4.5).
 * Pinned qwen/qwen3.8-27b with openai/gpt-oss-20b fallback, reasoning_effort
 * policy, token bounds. No response_format: Groq rejects json_object for
 * these models (HTTP 400, live-proven); SYSTEM_PROMPT_V2 mandates JSON-only
 * output and every response passes the output-contract validator instead.
 * Effort "none" omits reasoning_effort (gpt-oss rejects "none"; qwen works
 * either way). Malformed output is a failure, never an interpretation.
 */
import {
  OLLAMA_SUSPEND_COOLDOWN_MS,
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
import {
  traceContractRetry,
  traceFallback,
  traceFailure,
  traceOutcome,
  traceProviderAttempt,
} from "./trace.js";
import { SYSTEM_PROMPT_V2, HYBRID_SYSTEM_SUFFIX_V1 } from "./schemas.js";
import { logger } from "../../../shared/logger.js";
import type { AgentOutcome } from "../../../shared/types.js";
import type { HybridScreenshot } from "../../../shared/api.js";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

/**
 * EXPERIMENTAL Phase-8 latency marks. Created by the route (which owns T1),
 * filled in by the reasoning path (T7/T8/T9), then read back to emit a single
 * consolidated record.
 *
 * Pure observation: nothing here is ever consulted for a decision, so adding
 * it cannot alter behaviour, budgets or validation.
 */
export interface LatencyMarks {
  /** T1: request received by the route. */
  t1: number;
  /** T7: model request sent (the serving provider). */
  t7?: number;
  /** T8: model response received. */
  t8?: number;
  /** T9: structured output validated. */
  t9?: number;
  /** Provider that produced the marked response. */
  provider?: ReasoningProvider;
}

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
  /** Injectable clock (test seam) for the local-provider cooldown. */
  now?: () => number;
  /**
   * EXPERIMENTAL hybrid context: viewport screenshot (raw base64 JPEG).
   *
   * Attached ONLY to the local Ollama call, because that is the provider whose
   * multimodal wire format was verified for this model. The cloud standby path
   * is untouched: on fallback it sends the same text-only body it always has,
   * so a degraded (text-only) hybrid turn still carries the compact registry.
   */
  image?: HybridScreenshot;
  /** EXPERIMENTAL Phase-8 marks. Optional, observation only. */
  latency?: LatencyMarks;
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
 * Local Ollama availability state.
 *
 * A local endpoint that is DOWN must not add latency to every turn, so the
 * local provider is skipped while suspended and cloud takes over immediately.
 * The suspension is BOUNDED so a transient outage is self-healing: starting
 * Ollama later must recover local inference WITHOUT a backend restart (the
 * permanent latch this replaced forced exactly that restart).
 *
 * Two kinds, deliberately different:
 * - transient (any availability fault: "network", "timeout", "provider"/5xx)
 *   -> time-boxed for OLLAMA_SUSPEND_COOLDOWN_MS, then eligible for exactly one
 *   fresh probe. Re-fails -> re-armed.
 * - permanent ("auth" = unknown model tag, HTTP 404) -> never retried on a
 *   timer: a wrong tag cannot fix itself, and re-probing every turn would only
 *   re-pay the round trip. Cleared only by a live /api/tags probe that reports
 *   the model installed, or by a process restart.
 */
interface OllamaSuspendState {
  /** Skip the local provider while true. */
  suspended: boolean;
  /** True when the condition cannot fix itself (unknown model tag). */
  permanent: boolean;
  /** Epoch ms at which a time-boxed suspension becomes eligible again. */
  retryAt: number;
}

function freshOllamaSuspend(): OllamaSuspendState {
  return { suspended: false, permanent: false, retryAt: 0 };
}

let ollamaSuspend = freshOllamaSuspend();

/**
 * Should the local provider be skipped for this operation?
 *
 * On expiry the state is cleared HERE, so the caller goes straight on to make a
 * single fresh attempt — recovery costs one request, not a probe + a request.
 */
function ollamaIsSuspended(nowMs: number): boolean {
  if (!ollamaSuspend.suspended) return false;
  if (!ollamaSuspend.permanent && nowMs >= ollamaSuspend.retryAt) {
    ollamaSuspend = freshOllamaSuspend();
    logger.info("reasoning: local Ollama cooldown elapsed - retrying local inference", {
      provider: "ollama",
    });
    return false;
  }
  return true;
}

/** Arm the cooldown after a transient local failure (idempotent re-arm). */
function suspendOllamaTemporarily(nowMs: number, kind: string): void {
  if (ollamaSuspend.permanent) return; // never downgrade a permanent condition
  ollamaSuspend = {
    suspended: true,
    permanent: false,
    retryAt: nowMs + OLLAMA_SUSPEND_COOLDOWN_MS,
  };
  logger.warn("reasoning: local Ollama unavailable - cloud fallback, local re-probed after cooldown", {
    provider: "ollama",
    kind,
    cooldownMs: OLLAMA_SUSPEND_COOLDOWN_MS,
  });
}

/**
 * Live recovery hook for the Ollama health/validation path: a probe that
 * positively confirms reachability AND model presence proves any suspension is
 * stale, so clear it. Lets `POST /v1/validation` un-suspend the local provider
 * the moment the operator starts Ollama (or pulls the missing model).
 */
export function noteOllamaProbeHealthy(): void {
  if (!ollamaSuspend.suspended) return;
  ollamaSuspend = freshOllamaSuspend();
  logger.info("reasoning: local Ollama recovered - suspension cleared by live probe", {
    provider: "ollama",
  });
}

/** Test-only reset for latches (deterministic assertions). */
export function __resetReasoningRotation(): void {
  roundRobinCursor = 0;
  openrouterSuspended = false;
  ollamaSuspend = freshOllamaSuspend();
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
    if (i > 0) traceProviderAttempt(input.turnId, provider, model);
    try {
      // Contract-level retry: reasoning models intermittently answer with prose,
      // a fenced block, or a stray key. One corrective re-ask with extra token
      // headroom recovers those turns instead of failing the user's whole task.
      // Only a *rejected reply* is retried — never a transport/provider error.
      let userPayload = input.userPayload;
      for (let attempt = 0; attempt < CONTRACT_ATTEMPTS; attempt += 1) {
        // Phase-8 marks: written per attempt so the FINAL values always
        // describe the provider that actually served the turn (a failed local
        // attempt is overwritten by the standby that answered).
        const marks = input.latency;
        if (marks !== undefined) marks.t7 = Date.now();
        // eslint-disable-next-line no-await-in-loop
        const res = await chat(model, userPayload, attempt);
        if (marks !== undefined) {
          marks.t8 = Date.now();
          marks.provider = provider;
        }
        const content = extractContent(res);
        try {
          const outcome = validateModelOutput(content);
          if (marks !== undefined) marks.t9 = Date.now();
          traceOutcome(input.turnId, outcome, attempt);
          return outcome;
        } catch (err) {
          if (err instanceof ModelOutputError && attempt + 1 < CONTRACT_ATTEMPTS) {
            traceContractRetry(input.turnId, attempt);
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
        if (provider === "ollama") {
          const nowMs = (input.now ?? Date.now)();
          if (err.kind === "auth") {
            // Unknown model tag (Ollama HTTP 404). Permanent: not retried on a
            // timer. Only a live probe that finds the model installed, or a
            // restart, clears it.
            ollamaSuspend = {
              suspended: true,
              permanent: true,
              retryAt: Number.POSITIVE_INFINITY,
            };
            logger.error("reasoning: local Ollama model tag not found - not retried", {
              provider,
              kind: err.kind,
            });
          } else if (err.kind !== "schema") {
            // Availability faults: "network" (not running / refused),
            // "timeout" (too slow) and "provider" (HTTP 5xx — e.g. Ollama is up
            // but failed to load the model, or is out of memory). All of them
            // cost a full round trip on EVERY turn if left unsuspended, so all
            // of them get the same bounded cooldown.
            suspendOllamaTemporarily(nowMs, err.kind);
          }
          // NOTE: "schema" (malformed/empty local output) is deliberately NOT
          // suspended — that is a model-capability fault, not an availability
          // one, and each turn must be free to try local again.
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

/**
 * The system + user message pair shared by every provider.
 *
 * Deliberately image-free: the cloud standby bodies must stay byte-identical to
 * pre-prototype behaviour. Multimodal input is added only in localChatBody.
 */
function buildMessages(input: ReasonInput, userPayload: string): Array<Record<string, unknown>> {
  return [
    { role: "system", content: input.systemPrompt ?? SYSTEM_PROMPT_V2 },
    { role: "user", content: userPayload },
  ];
}

function chatBody(input: ReasonInput, userPayload: string, attempt: number): Record<string, unknown> {
  const effort = input.effort ?? "none";
  return {
    messages: buildMessages(input, userPayload),
    // reasoning_effort only when reasoning is actually requested.
    ...(effort !== "none" ? { reasoning_effort: effort } : {}),
    max_completion_tokens:
      (input.maxCompletionTokens ?? QWEN_MAX_COMPLETION_TOKENS_INTERACTIVE) +
      // Headroom on the re-ask: a reply cut off mid-object is the most
      // common cause of "not parseable JSON".
      (attempt > 0 ? QWEN_CONTRACT_RETRY_HEADROOM : 0),
  };
}

/**
 * Chat-shaped content for the local model (Ollama takes the same messages).
 *
 * This is the ONLY place an image is attached, and the only place the hybrid
 * instruction is appended — so the vision rules and the screenshot always
 * travel together. Never telling a text-only cloud model "you are given a
 * screenshot" avoids an instruction the model cannot satisfy (a hallucination
 * trap on the fallback path).
 */
function localChatBody(input: ReasonInput, userPayload: string, attempt: number): Record<string, unknown> {
  const messages = buildMessages(input, userPayload);
  const image = input.image;
  if (image !== undefined) {
    for (const message of messages) {
      if (message["role"] === "system") {
        message["content"] = `${String(message["content"])}${HYBRID_SYSTEM_SUFFIX_V1}`;
      } else if (message["role"] === "user") {
        // Ollama multimodal wire format (verified live): raw base64 strings in
        // an array, no data: prefix — `api.ImageData` decodes to []byte.
        message["images"] = [image.b64];
      }
    }
    logger.info("ollama: multimodal request", {
      provider: "ollama",
      ...(input.turnId !== undefined && input.turnId !== "" ? { turnId: input.turnId } : {}),
      imageBytes: image.bytes,
      imageWidth: image.width,
      imageHeight: image.height,
    });
  }
  return { messages };
}

export async function reasonOnce(input: ReasonInput): Promise<AgentOutcome> {
  const nowMs = (input.now ?? Date.now)();
  const orRef =
    input.openrouter !== undefined && input.openrouter.apiKey !== "" && !openrouterSuspended
      ? input.openrouter
      : null;
  const localRef =
    input.ollama !== undefined && input.ollama.url !== "" && !ollamaIsSuspended(nowMs)
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
  // P0-1: images are local-only. If one arrived but no local provider is
  // eligible, it stays out of every cloud request below (localChatBody is the
  // only place images attach). Log the text-only downgrade once per call.
  if (input.image !== undefined && localRef === null) {
    logger.info("hybrid: local unavailable; continuing text-only (image never sent to cloud)", {
      ...(input.turnId !== undefined && input.turnId !== "" ? { turnId: input.turnId } : {}),
      imageBytes: input.image.bytes,
      imageWidth: input.image.width,
      imageHeight: input.image.height,
    });
  }
  let lastError: QwenError | null = null;
  // A 429 on ANY provider means quota exhaustion, even when a later
  // provider fails differently (e.g. Groq 429s, then the local model fumbles
  // the JSON contract). Without this the caller reports the LAST error
  // (500/contract) and the user hears "AI service unavailable" for what is
  // really "wait a minute and retry".
  let sawRateLimit = false;
  for (const provider of order) {
    try {
      if (provider === "ollama" && localRef !== null) {
        traceProviderAttempt(input.turnId, provider, localRef.model);
        logger.info("reasoning via ollama", {
          provider: "ollama",
          model: localRef.model,
          ...(input.turnId !== undefined && input.turnId !== "" ? { turnId: input.turnId } : {}),
        });
        // Local inference: SINGLE attempt (no hidden retry) — a slow local
        // model must not multiply requests per turn.
        // eslint-disable-next-line no-await-in-loop
        const outcome = await attemptVendor(
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
        // Reached ONLY on success: clear any cooldown so a recovered local
        // provider stays eligible for every following turn. A failure throws
        // above, re-arming the cooldown instead.
        noteOllamaProbeHealthy();
        return outcome;
      }
      if (provider === "openrouter" && orRef !== null) {
        traceProviderAttempt(input.turnId, provider, orRef.model);
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
      traceProviderAttempt(input.turnId, provider, QWEN_PRIMARY_MODEL);
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
        const at = order.indexOf(provider);
        const next = at >= 0 ? order[at + 1] : undefined;
        traceFallback(input.turnId, provider, next ?? "(exhausted)", fallbackReasonFor(provider, err));
        logger.warn("reasoning provider failed; failing over", {
          provider,
          ...(input.turnId !== undefined && input.turnId !== "" ? { turnId: input.turnId } : {}),
          httpStatus: err.httpStatus,
          outcome: "failure",
          fallbackReason: fallbackReasonFor(provider, err),
          reason: err.message,
        });
        if (err.httpStatus === 429) sawRateLimit = true;
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  if (sawRateLimit && lastError !== null && lastError.httpStatus !== 429) {
    // Quota was the root cause; the terminal error is just noise. Surface
    // 429 so the route layer answers RATE_LIMITED ("wait and retry") instead
    // of REASONING_FAILED ("AI service unavailable").
    traceFailure(input.turnId, "all-providers", "quota-exhausted");
    throw new QwenError(
      `all reasoning providers failed after quota exhaustion: ${lastError.message}`,
      false,
      429,
    );
  }
  traceFailure(input.turnId, "all-providers", "reasoning-failed");
  throw lastError ?? new QwenError("reasoning failed", true);
}
