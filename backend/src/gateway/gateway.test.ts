/**
 * Gateway tests: pool health, key rotation, bounded retries, timeouts,
 * error normalization. Fake fetch only — no network. Run: npm test
 */
import { describe, expect, it, vi } from "vitest";
import {
  GatewayError,
  GroqKeyPool,
  postChat,
  postTranscription,
  toAIError,
} from "./gateway.js";

function okJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

function httpError(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => `error ${status}`,
  } as Response;
}

describe("GroqKeyPool", () => {
  it("round-robins across healthy keys", () => {
    const pool = new GroqKeyPool(["k1", "k2"]);
    const seen = new Set([pool.next(), pool.next(), pool.next(), pool.next()]);
    expect(seen).toEqual(new Set(["k1", "k2"]));
    expect(pool.usableCount()).toBe(2);
  });

  it("quarantines auth-failed keys and cools down rate-limited ones", () => {
    let now = 1000;
    const pool = new GroqKeyPool(["k1", "k2"], { cooldownMs: 60_000, now: () => now });
    pool.reportAuthFailure("k1");
    expect(pool.usableCount()).toBe(1);
    expect(pool.next()).toBe("k2");
    pool.reportRateLimit("k2");
    expect(pool.usableCount()).toBe(0);
    expect(pool.next()).toBeNull();
    now += 60_001; // cooldown expiry readmits k2, never k1
    expect(pool.usableCount()).toBe(1);
    expect(pool.next()).toBe("k2");
  });

  it("returns null for an empty pool", () => {
    expect(new GroqKeyPool([]).next()).toBeNull();
  });
});

describe("postChat", () => {
  it("posts JSON with bearer auth and returns parsed body", async () => {
    const seen: Array<{ url: string; auth: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
      seen.push({ url, auth: init.headers?.["Authorization"] ?? "", body: JSON.parse(init.body ?? "{}") });
      return okJson({ choices: [{ message: { content: "{}" } }] });
    }) as unknown as typeof fetch;
    const pool = new GroqKeyPool(["k1"]);
    const body = { model: "m", messages: [] };
    const res = await postChat({ pool, body, fetchImpl });
    expect((res as { choices: unknown[] }).choices.length).toBe(1);
    expect(seen[0]?.url).toContain("/chat/completions");
    expect(seen[0]?.auth).toBe("Bearer k1");
    expect(seen[0]?.body).toEqual(body);
  });

  it("rotates keys on 401 without consuming retries", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: { headers?: Record<string, string> }) => {
      const key = (init.headers?.["Authorization"] ?? "").replace("Bearer ", "");
      calls.push(key);
      if (key === "bad") return httpError(401);
      return okJson({ ok: true });
    }) as unknown as typeof fetch;
    const pool = new GroqKeyPool(["bad", "good"]);
    await postChat({ pool, body: {}, fetchImpl, maxRetries: 0 });
    expect(calls).toEqual(["bad", "good"]);
    expect(pool.usableCount()).toBe(1);
  });

  it("throws auth when every key is rejected", async () => {
    const fetchImpl = (async () => httpError(401)) as unknown as typeof fetch;
    const pool = new GroqKeyPool(["k1", "k2"]);
    const err = await postChat({ pool, body: {}, fetchImpl, maxRetries: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).kind).toBe("auth");
  });

  it("bounds 429 retries then throws rate_limit", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return httpError(429);
    }) as unknown as typeof fetch;
    const pool = new GroqKeyPool(["k1"]);
    const err = await postChat({
      pool,
      body: {},
      fetchImpl,
      maxRetries: 2,
      baseBackoffMs: 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).kind).toBe("rate_limit");
    expect(calls).toBe(3); // 1 try + 2 retries: bounded, never infinite
  });

  it("bounds provider-error retries", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return httpError(500);
    }) as unknown as typeof fetch;
    const pool = new GroqKeyPool(["k1"]);
    await expect(
      postChat({ pool, body: {}, fetchImpl, maxRetries: 1, baseBackoffMs: 1 }),
    ).rejects.toMatchObject({ kind: "provider" });
    expect(calls).toBe(2);
  });

  it("maps aborts to timeout errors", async () => {
    const fetchImpl = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (init.signal?.aborted === true) {
          onAbort();
          return;
        }
        init.signal?.addEventListener("abort", onAbort, { once: true });
      })) as unknown as typeof fetch;
    const pool = new GroqKeyPool(["k1"]);
    await expect(
      postChat({ pool, body: {}, fetchImpl, timeoutMs: 20 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("maps transport failures to network errors", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const pool = new GroqKeyPool(["k1"]);
    await expect(
      postChat({ pool, body: {}, fetchImpl, maxRetries: 0 }),
    ).rejects.toMatchObject({ kind: "network", retryable: true });
  });
});

describe("postTranscription", () => {
  it("returns validated text and rejects client errors with status", async () => {
    const okFetch = (async () => okJson({ text: "hi" })) as unknown as typeof fetch;
    const pool = new GroqKeyPool(["k1"]);
    await expect(
      postTranscription({ pool, form: () => new FormData(), fetchImpl: okFetch }),
    ).resolves.toEqual({ text: "hi" });

    const badFetch = (async () => httpError(400)) as unknown as typeof fetch;
    const err = await postTranscription({
      pool: new GroqKeyPool(["k1"]),
      form: () => new FormData(),
      fetchImpl: badFetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(400);
  });
});

describe("toAIError", () => {
  it("normalizes gateway errors into the AIError vocabulary", () => {
    expect(toAIError(new GatewayError("rate_limit", "x", 429), "QWEN")).toEqual({
      code: "GATEWAY_RATE_LIMIT",
      recoverable: true,
      source: "QWEN",
    });
    expect(toAIError(new GatewayError("auth", "x", 401), "WHISPER")).toEqual({
      code: "GATEWAY_AUTH",
      recoverable: false,
      source: "WHISPER",
    });
    expect(toAIError(new Error("boom"), "QWEN")).toEqual({
      code: "GATEWAY_NETWORK",
      recoverable: true,
      source: "QWEN",
    });
  });

  it("touches the clock exactly as needed (no real timers in pool tests)", () => {
    const now = vi.fn(() => 0);
    const pool = new GroqKeyPool(["k1"], { now });
    pool.reportRateLimit("k1");
    expect(now).toHaveBeenCalled();
    void pool;
  });
});
