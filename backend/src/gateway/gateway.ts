/**
 * AI Gateway — REAL (PRD 6.4 §1.1; PRD 4 §30–34, §89).
 * Single OpenAI-compatible client for all Groq traffic (chat + transcription).
 * Key pool with health tracking, auth-failure quarantine, rate-limit cooldown,
 * bounded retries with jittered backoff, and normalized errors.
 * Callers never touch HTTP, keys, or provider payloads.
 */
import { GROQ_BASE_URL } from "../../../shared/constants.js";
import type { AIError } from "../../../shared/types.js";

export type GatewayErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "provider"
  | "schema";

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(kind: GatewayErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "GatewayError";
    this.kind = kind;
    this.status = status;
    this.retryable = kind === "rate_limit" || kind === "timeout" || kind === "network";
  }
}

/** Normalized error for controller/logging consumption (PRD 4 §89). */
export function toAIError(
  err: unknown,
  source: AIError["source"],
): AIError {
  if (err instanceof GatewayError) {
    return { code: `GATEWAY_${err.kind.toUpperCase()}`, recoverable: err.retryable, source };
  }
  return {
    code: "GATEWAY_NETWORK",
    recoverable: true,
    source,
  };
}

interface KeyState {
  key: string;
  badAuth: boolean;
  coolUntil: number;
  failures: number;
}

export interface PoolOptions {
  cooldownMs?: number;
  now?: () => number;
}

/**
 * Rate-limit cooldown bounds.
 *
 * Measured live against Groq: the request budget is PER-ACCOUNT, not per-key —
 * two keys return byte-identical `x-ratelimit-remaining-*` counters — and a
 * 429 carries `retry-after: 2`. The old fixed 60s cooldown therefore killed
 * both keys for a full minute after two 429s one second apart, which surfaced
 * to the user as "AI service unavailable". The provider's own retry-after is
 * now honoured, clamped to a short window so a burst cannot take the gateway
 * offline for a minute.
 */
const MIN_COOLDOWN_MS = 100;
/**
 * Upper bound on how long a rate limit can park the gateway.
 *
 * Measured live: Groq reports `x-ratelimit-reset-tokens` as low as ~130ms for
 * this account, so the budget recovers almost immediately. An earlier 5s cap
 * turned a single 429 into five seconds of refused requests — strictly worse
 * than the provider's own guidance and the direct cause of the "every request
 * fails" reports. The bound now exists only to stop a pathological hint.
 */
const MAX_COOLDOWN_MS = 1_000;
const DEFAULT_RETRY_AFTER_MS = 250;

/** Extracts a cooldown from `retry-after` / `x-ratelimit-reset-*` headers. */
export function retryAfterMs(res: Response, nowMs: number = Date.now()): number | null {
  const retryAfter = res.headers?.get?.("retry-after");
  if (retryAfter !== null && retryAfter !== undefined && retryAfter !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  for (const header of ["x-ratelimit-reset-tokens", "x-ratelimit-reset-requests"]) {
    const raw = res.headers?.get?.(header);
    if (raw === null || raw === undefined || raw === "") continue;
    // Groq sends durations ("22s", "1h2m3.4s") as well as epoch seconds.
    const duration = /^\d+(?:\.\d+)?s$/.exec(raw);
    if (duration !== null) return Math.round(Number(duration[0].slice(0, -1)) * 1000);
    const epoch = Number(raw);
    if (Number.isFinite(epoch) && epoch > 1_000_000_000) return Math.max(0, epoch * 1000 - nowMs);
  }
  return null;
}

function clampCooldown(ms: number): number {
  return Math.min(Math.max(ms, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
}

/**
 * Round-robin pool with health tracking. Auth failures quarantine a key for
 * the session (genuinely per-key); rate limits cool the pool per-endpoint,
 * because Groq's token budget is shared across all keys but tracked
 * separately for chat vs audio endpoints.
 */
export class GroqKeyPool {
  private readonly states: KeyState[];
  private cursor = -1;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  /**
   * Per-endpoint rate-limit cooldowns. Groq tracks separate token/request
   * budgets for chat completions vs audio transcription vs audio speech.
   * A 429 on TTS should not park reasoning calls.
   * Key = endpoint path suffix (e.g. "/chat/completions", "/audio/transcriptions").
   */
  private rateLimitedUntilByEndpoint = new Map<string, number>();

  constructor(keys: string[], opts: PoolOptions = {}) {
    this.states = keys.map((key) => ({ key, badAuth: false, coolUntil: 0, failures: 0 }));
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_RETRY_AFTER_MS;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.states.length;
  }

  usableCount(): number {
    const now = this.now();
    return this.states.filter((s) => !s.badAuth && s.coolUntil <= now).length;
  }

  /**
   * True while the budget for a specific endpoint is known to be exhausted.
   * Callers use this to fail fast with an honest RATE_LIMITED instead of
   * spending more requests on calls that cannot succeed.
   * When no endpoint is provided, returns true if ANY endpoint is limited.
   */
  isRateLimited(endpoint?: string): boolean {
    const now = this.now();
    if (endpoint !== undefined) {
      return now < (this.rateLimitedUntilByEndpoint.get(endpoint) ?? 0);
    }
    for (const until of this.rateLimitedUntilByEndpoint.values()) {
      if (now < until) return true;
    }
    return false;
  }

  /** Milliseconds until the endpoint's budget frees up (0 when not limited). */
  retryAfterRemainingMs(endpoint?: string): number {
    const now = this.now();
    if (endpoint !== undefined) {
      return Math.max(0, (this.rateLimitedUntilByEndpoint.get(endpoint) ?? 0) - now);
    }
    let max = 0;
    for (const until of this.rateLimitedUntilByEndpoint.values()) {
      max = Math.max(max, until - now);
    }
    return Math.max(0, max);
  }

  /** Next healthy key (round-robin) or null when all are quarantined/cooled. */
  next(): string | null {
    if (this.states.length === 0) return null;
    const now = this.now();
    for (let i = 0; i < this.states.length; i += 1) {
      this.cursor = (this.cursor + 1) % this.states.length;
      const state = this.states[this.cursor];
      if (state !== undefined && !state.badAuth && state.coolUntil <= now) {
        return state.key;
      }
    }
    return null;
  }

  /**
   * First non-quarantined key regardless of cooldown. Used ONLY for bounded
   * retries when every key is cooling: the backoff sleep already served as the
   * slowdown, so the retry reuses the cooled key instead of dying with a false
   * auth error. Auth-quarantined keys are never returned here.
   */
  peekCooling(): string | null {
    return this.states.find((s) => !s.badAuth)?.key ?? null;
  }

  reportSuccess(key: string): void {
    const state = this.states.find((s) => s.key === key);
    if (state !== undefined) state.failures = 0;
  }

  reportAuthFailure(key: string): void {
    const state = this.states.find((s) => s.key === key);
    if (state !== undefined) state.badAuth = true;
  }

  /**
   * Records a 429 and returns the cooldown actually applied. Callers MUST wait
   * exactly this long before retrying, otherwise the pool's own guard will
   * (correctly) refuse the retry. `retryAfterMs` comes from the provider's
   * headers when present. `endpoint` scopes the cooldown so that e.g. a TTS
   * 429 does not block chat completions.
   */
  reportRateLimit(key: string, retryAfter?: number | null, endpoint?: string): number {
    const state = this.states.find((s) => s.key === key);
    const wait = clampCooldown(retryAfter ?? this.cooldownMs);
    if (state !== undefined) {
      state.failures += 1;
      state.coolUntil = this.now() + wait;
    }
    const ep = endpoint ?? "__global__";
    this.rateLimitedUntilByEndpoint.set(ep, this.now() + wait);
    return wait;
  }
}

export interface CallOptions {
  pool: GroqKeyPool;
  timeoutMs?: number;
  /** Retryable-attempt retries after the first try (bounded; default 2). */
  maxRetries?: number;
  baseBackoffMs?: number;
  fetchImpl?: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number, baseMs: number): number {
  const capped = Math.min(baseMs * 2 ** attempt, 5000);
  return capped + Math.random() * capped * 0.25;
}

async function attemptFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GatewayError("timeout", `request timed out after ${timeoutMs}ms`);
    }
    throw new GatewayError(
      "network",
      err instanceof Error ? `network failure: ${err.message}` : "network failure",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Core loop: rotate keys on 401, back off + retry on 429/5xx/timeout.
 * Total attempts bounded by keys + maxRetries. Never infinite (PRD 4 §89).
 */
async function executeWithPolicy(
  url: string,
  buildInit: (key: string) => RequestInit,
  opts: CallOptions,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const maxRetries = opts.maxRetries ?? 2;
  const baseBackoffMs = opts.baseBackoffMs ?? 400;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxAttempts = opts.pool.size + maxRetries;
  let retriesUsed = 0;
  let lastError: GatewayError = new GatewayError("provider", "no usable keys in pool");

  // Extract endpoint path for per-endpoint rate limit scoping. TTS 429s
  // should not park chat completions, and vice versa.
  let endpoint: string;
  try { endpoint = new URL(url).pathname; } catch { endpoint = url; }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // If the endpoint's budget is momentarily spent, wait the provider's own
    // recovery hint rather than refusing the call outright. A hard refusal
    // here turned one 429 into a burst of failures, because a burst of
    // requests arriving during the window all failed instead of waiting.
    if (opts.pool.isRateLimited(endpoint)) {
      const wait = opts.pool.retryAfterRemainingMs(endpoint);
      if (wait > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(wait);
      }
    }
    // Healthy keys first; a cooling (never quarantined) key is reused for
    // bounded retries — the backoff sleep already served as the slowdown.
    // Total iterations stay capped by maxAttempts regardless.
    const key = opts.pool.next() ?? opts.pool.peekCooling();
    if (key === null) {
      throw new GatewayError(
        "auth",
        "all Groq keys quarantined or cooling down",
      );
    }
    let res: Response;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await attemptFetch(url, buildInit(key), timeoutMs, fetchImpl);
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      if (!err.retryable || retriesUsed >= maxRetries) throw err;
      retriesUsed += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoffDelay(retriesUsed, baseBackoffMs));
      continue;
    }

    if (res.status === 401) {
      opts.pool.reportAuthFailure(key);
      lastError = new GatewayError("auth", "Groq key rejected (HTTP 401)", 401);
      continue; // rotate key; rotation does not consume the retry budget
    }
    if (res.status === 429) {
      // Honour the provider's own recovery hint instead of a fixed penalty.
      // Rotating to another key cannot help: the budget is shared account-wide.
      // Scoped to this endpoint so TTS 429 doesn't park reasoning.
      const wait = opts.pool.reportRateLimit(key, retryAfterMs(res), endpoint);
      lastError = new GatewayError(
        "rate_limit",
        `Groq rate limited (HTTP 429, retry after ${wait}ms)`,
        429,
      );
      if (retriesUsed >= maxRetries) throw lastError;
      retriesUsed += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(wait);
      continue;
    }
    if (res.status >= 500) {
      if (retriesUsed >= maxRetries) {
        throw new GatewayError("provider", `Groq error (HTTP ${res.status})`, res.status);
      }
      retriesUsed += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoffDelay(retriesUsed, baseBackoffMs));
      continue;
    }
    opts.pool.reportSuccess(key);
    return res;
  }
  throw lastError;
}

/** POST chat/completions through the pool. Returns parsed JSON. */
export async function postChat(
  opts: CallOptions & { body: Record<string, unknown> },
): Promise<unknown> {
  const res = await executeWithPolicy(
    `${GROQ_BASE_URL}/chat/completions`,
    (key) => ({
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts.body),
    }),
    opts,
  );
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new GatewayError("schema", "chat response was not JSON");
  }
}

export interface TranscriptionResult {
  text: string;
}/** POST audio/transcriptions through the pool. Returns validated text. */
export async function postTranscription(
  opts: CallOptions & { form: () => FormData },
): Promise<TranscriptionResult> {
  const res = await executeWithPolicy(
    `${GROQ_BASE_URL}/audio/transcriptions`,
    (key) => ({
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: opts.form(),
    }),
    opts,
  );
  if (!res.ok) {
    // Non-retryable client error (e.g. 400/404 model problems): surface the
    // status so callers can apply model-fallback discipline.
    throw new GatewayError(
      "provider",
      `transcription failed (HTTP ${res.status})`,
      res.status,
    );
  }
  let data: { text?: unknown };
  try {
    data = (await res.json()) as { text?: unknown };
  } catch {
    throw new GatewayError("schema", "transcription response was not JSON");
  }
  if (typeof data.text !== "string" || data.text.trim() === "") {
    throw new GatewayError("schema", "transcription returned empty text");
  }
  return { text: data.text };
}
