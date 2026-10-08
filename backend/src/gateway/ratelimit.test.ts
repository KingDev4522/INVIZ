/**
 * Rate-limit handling regressions (live-measured).
 *
 * Measured against Groq: the request/token budget is PER-ACCOUNT — two keys
 * return byte-identical `x-ratelimit-remaining-*` — and a 429 carries
 * `retry-after: 2`. The previous fixed 60s per-key cooldown meant two 429s a
 * second apart took the whole gateway offline for a minute, which the user saw
 * as "AI service unavailable. Basic navigation still works."
 */
import { describe, expect, it } from "vitest";
import {
  GatewayError,
  GroqKeyPool,
  postChat,
  retryAfterMs,
} from "./gateway.js";

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

function httpError(status: number, hdrs: Record<string, string> = {}): Response {
  return {
    ok: false,
    status,
    headers: headers(hdrs),
    text: async () => "err",
  } as unknown as Response;
}

describe("retryAfterMs", () => {
  it("reads a numeric retry-after in seconds", () => {
    expect(retryAfterMs(httpError(429, { "retry-after": "2" }))).toBe(2000);
  });

  it("reads a Groq duration reset header", () => {
    expect(retryAfterMs(httpError(429, { "x-ratelimit-reset-tokens": "22s" }))).toBe(22_000);
  });

  it("prefers retry-after over the reset header", () => {
    const res = httpError(429, { "retry-after": "2", "x-ratelimit-reset-tokens": "22s" });
    expect(retryAfterMs(res)).toBe(2000);
  });

  it("returns null when the provider offers no hint", () => {
    expect(retryAfterMs(httpError(429))).toBeNull();
  });
});

describe("cooldown is bounded, not a minute-long outage", () => {
  it("never cools longer than a few seconds even with no hint", () => {
    let now = 0;
    const pool = new GroqKeyPool(["k1"], { now: () => now });
    const applied = pool.reportRateLimit("k1", null);
    expect(applied).toBeLessThanOrEqual(5_000);
  });

  it("clamps an absurd provider hint instead of obeying it literally", () => {
    let now = 0;
    const pool = new GroqKeyPool(["k1"], { now: () => now });
    // Groq reports reset-tokens as low as ~130ms for this account, so a large
    // bound would park the gateway for seconds after a single 429.
    expect(pool.reportRateLimit("k1", 3_600_000)).toBeLessThanOrEqual(1_000);
  });

  it("honours a short provider hint", () => {
    let now = 0;
    const pool = new GroqKeyPool(["k1"], { now: () => now });
    expect(pool.reportRateLimit("k1", 250)).toBe(250);
  });

  it("reports the account budget as limited, then free again", () => {
    let now = 0;
    const pool = new GroqKeyPool(["k1", "k2"], { now: () => now });
    expect(pool.isRateLimited()).toBe(false);
    const wait = pool.reportRateLimit("k1", 2000);
    expect(pool.isRateLimited()).toBe(true);
    expect(pool.retryAfterRemainingMs()).toBe(wait);
    now += wait;
    expect(pool.isRateLimited()).toBe(false);
  });

  it("treats the budget as shared: one key's 429 limits the account", () => {
    let now = 0;
    const pool = new GroqKeyPool(["k1", "k2"], { now: () => now });
    pool.reportRateLimit("k1", 2000);
    // Rotating to k2 cannot buy fresh budget, so k2 is not a fresh start.
    expect(pool.isRateLimited()).toBe(true);
  });

  it("keeps auth quarantine per-key, unlike the shared rate limit", () => {
    let now = 0;
    const pool = new GroqKeyPool(["k1", "k2"], { now: () => now });
    pool.reportAuthFailure("k1");
    expect(pool.usableCount()).toBe(1);
    expect(pool.next()).toBe("k2");
  });
});

describe("postChat rate-limit path", () => {
  it("waits out a brief rate limit instead of refusing the call", async () => {
    // A request arriving during the recovery window must succeed, not fail.
    // A hard refusal here is what made a single 429 cascade into a burst of
    // failures for the user.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return httpError(429, { "retry-after": "0" });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"type":"answer","text":"ok"}' } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const pool = new GroqKeyPool(["k1"]);
    // Pre-cool the pool, as a prior request would have.
    pool.reportRateLimit("k1", 120);
    const out = await postChat({ pool, body: {}, fetchImpl, maxRetries: 2 });
    expect(out).toBeDefined();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("recovers on retry when the provider's short hint is honoured", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return httpError(429, { "retry-after": "0" });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"type":"answer","text":"ok"}' } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const out = await postChat({
      pool: new GroqKeyPool(["k1"]),
      body: {},
      fetchImpl,
      maxRetries: 2,
    });
    expect(calls).toBe(2);
    expect(out).toBeDefined();
  });

  it("still bounds retries instead of looping forever", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return httpError(429, { "retry-after": "0" });
    }) as unknown as typeof fetch;
    const err = await postChat({
      pool: new GroqKeyPool(["k1"]),
      body: {},
      fetchImpl,
      maxRetries: 2,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).kind).toBe("rate_limit");
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("never converts two 429s into a minute-long outage", async () => {
    let now = 0;
    const pool = new GroqKeyPool(["k1", "k2"], { now: () => now });
    // The old cooldown was a fixed 60s per key: two 429s a second apart left
    // every key unusable for a minute. Assert the recovery window instead of
    // sleeping through a real one.
    pool.reportRateLimit("k1", 2000);
    pool.reportRateLimit("k2", 2000);
    expect(pool.isRateLimited()).toBe(true);
    now += 2000;
    expect(pool.isRateLimited()).toBe(false);
    expect(pool.usableCount()).toBe(2);
  });

  it("bounds the burst even when the provider keeps saying 429", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return httpError(429, { "retry-after": "0" });
    }) as unknown as typeof fetch;
    await postChat({
      pool: new GroqKeyPool(["k1", "k2"]),
      body: {},
      fetchImpl,
      maxRetries: 2,
    }).catch(() => undefined);
    expect(calls).toBeLessThanOrEqual(4); // size + maxRetries, never unbounded
  });
});