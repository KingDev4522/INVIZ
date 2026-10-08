/**
 * OpenRouter chat client — REAL, live openrouter.ai (second reasoning vendor).
 * Server-side only: holds the OpenRouter key, speaks OpenAI-compatible
 * chat/completions, maps outcomes to GatewayError so reasonOnce can fail over
 * between vendors inside a single call (bounded standby chain, never rotation).
 * Bounded: at most 1 + maxRetries attempts, Retry-After honored on 429,
 * 4xx (except 429) never retried.
 */
import { OPENROUTER_BASE_URL } from "../../../shared/constants.js";
import { GatewayError, retryAfterMs } from "./gateway.js";

export interface OpenRouterRef {
  apiKey: string;
  model: string;
}

export interface OpenRouterCallOptions {
  ref: OpenRouterRef;
  body: Record<string, unknown>;
  timeoutMs?: number;
  /** Retries after the first try for retryable failures (default 1). */
  maxRetries?: number;
  baseBackoffMs?: number;
  fetchImpl?: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, baseMs: number): number {
  const capped = Math.min(baseMs * 2 ** attempt, 5000);
  return capped + Math.random() * capped * 0.25;
}

/**
 * POST chat/completions through OpenRouter. Returns parsed JSON.
 * Auth failures (401/403) throw immediately — the caller latches the vendor
 * off instead of retrying a dead key. Quota errors (429) wait out the
 * provider's own hint once, then throw for cross-vendor failover.
 */
export async function postChatOpenRouter(opts: OpenRouterCallOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const maxRetries = opts.maxRetries ?? 1;
  const baseBackoffMs = opts.baseBackoffMs ?? 400;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let retriesUsed = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.ref.apiKey}`,
          "Content-Type": "application/json",
          HTTP_REFERER: "http://127.0.0.1:8787",
          "X-Title": "INVIZ",
        },
        body: JSON.stringify({ ...opts.body, model: opts.ref.model }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        if (retriesUsed >= maxRetries) throw new GatewayError("timeout", "OpenRouter timed out");
        retriesUsed += 1;
        await sleep(backoffMs(retriesUsed, baseBackoffMs));
        continue;
      }
      if (retriesUsed >= maxRetries) {
        throw new GatewayError(
          "network",
          err instanceof Error ? `OpenRouter network failure: ${err.message}` : "OpenRouter network failure",
        );
      }
      retriesUsed += 1;
      await sleep(backoffMs(retriesUsed, baseBackoffMs));
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new GatewayError("auth", `OpenRouter key rejected (HTTP ${res.status})`, res.status);
    }
    if (res.status === 429) {
      const wait = retryAfterMs(res) ?? 1000;
      if (retriesUsed >= maxRetries) {
        throw new GatewayError("rate_limit", `OpenRouter rate limited (HTTP 429, retry after ${wait}ms)`, 429);
      }
      retriesUsed += 1;
      await sleep(Math.min(Math.max(wait, 100), 5000));
      continue;
    }
    if (res.status >= 500) {
      if (retriesUsed >= maxRetries) {
        throw new GatewayError("provider", `OpenRouter error (HTTP ${res.status})`, res.status);
      }
      retriesUsed += 1;
      await sleep(backoffMs(retriesUsed, baseBackoffMs));
      continue;
    }
    if (!res.ok) {
      throw new GatewayError("provider", `OpenRouter rejected request (HTTP ${res.status})`, res.status);
    }
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new GatewayError("schema", "OpenRouter response was not JSON");
    }
  }
}
