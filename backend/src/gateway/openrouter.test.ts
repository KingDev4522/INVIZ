/**
 * OpenRouter client tests: request shape, bounded retries, error mapping.
 * Fake key only — the real key never appears outside .env.
 * Run: npm test
 */
import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "./gateway.js";
import { postChatOpenRouter } from "./openrouter.js";

const REF = { apiKey: "or-test-key", model: "google/gemma-4-26b-a4b-it:free" };

function okFetch(content: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  })) as unknown as typeof fetch;
}

describe("postChatOpenRouter", () => {
  it("posts bearer auth + model override to the OpenRouter endpoint", async () => {
    let url = "";
    let init: RequestInit = {};
    const fetchImpl = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return { ok: true, status: 200, json: async () => ({ choices: [] }) };
    }) as unknown as typeof fetch;
    await postChatOpenRouter({
      ref: REF,
      body: { messages: [{ role: "user", content: "hi" }] },
      fetchImpl,
      maxRetries: 0,
    });
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer or-test-key");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("google/gemma-4-26b-a4b-it:free");
    expect(JSON.stringify(body)).not.toContain("or-test-key");
  });

  it("maps 401 to auth (caller latches, never retries a dead key)", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      text: async () => "no",
    })) as unknown as typeof fetch;
    const err = await postChatOpenRouter({ ref: REF, body: {}, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).kind).toBe("auth");
    expect((err as GatewayError).retryable).toBe(false);
  });

  it("retries a 500 once, then throws provider", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
    })) as unknown as typeof fetch;
    const err = await postChatOpenRouter({
      ref: REF,
      body: {},
      fetchImpl,
      maxRetries: 1,
      baseBackoffMs: 1,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).kind).toBe("provider");
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 try + 1 bounded retry
  });

  it("never retries 4xx client errors", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => "bad",
    })) as unknown as typeof fetch;
    const err = await postChatOpenRouter({ ref: REF, body: {}, fetchImpl }).catch((e) => e);
    expect((err as GatewayError).kind).toBe("provider");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns parsed JSON on success", async () => {
    const out = await postChatOpenRouter({
      ref: REF,
      body: {},
      fetchImpl: okFetch(JSON.stringify({ type: "answer", text: "hi" })),
      maxRetries: 0,
    });
    expect(out).toEqual({ choices: [{ message: { content: "{\"type\":\"answer\",\"text\":\"hi\"}" } }] });
  });
});
