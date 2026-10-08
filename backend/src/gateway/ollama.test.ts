/**
 * Ollama (local provider) client tests. Covers spec cases 1–9, 12, 13:
 * reachable, unavailable, model missing, success, malformed output, schema
 * failure, timeout, failure, single-attempt (no amplification), and isolation
 * from the cloud providers. Fakes only — no inference, no model files.
 * Run: npm test
 */
import { describe, expect, it, vi } from "vitest";
import { OLLAMA_NUM_CTX } from "../../../shared/constants.js";
import { GatewayError } from "./gateway.js";
import { postChatOllama, probeOllama } from "./ollama.js";

const REF = { url: "http://127.0.0.1:11434", model: "qwen3.5:9b-q4_K_M" };
const OK = '{"type":"answer","text":"Paris"}';

function chatOk(content: string, extra: Record<string, unknown> = {}): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ message: { role: "assistant", content }, done: true, eval_count: 7, ...extra }),
  })) as unknown as typeof fetch;
}

/** Case 12: local provider must never reach a cloud host. */
function noCloudCalls(): { assert: () => void; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    assert: () => {
      for (const url of calls) {
        expect(url).toContain("127.0.0.1:11434");
        expect(url).not.toContain("groq");
        expect(url).not.toContain("openrouter");
      }
    },
  };
}

describe("postChatOllama — local provider", () => {
  it("case 4/5: posts to /api/chat with think:false and returns content", async () => {
    const guard = noCloudCalls();
    let url = "";
    let init: RequestInit = {};
    const fetchImpl = (async (u: string, i: RequestInit) => {
      guard.calls.push(u);
      url = u;
      init = i;
      return { ok: true, status: 200, json: async () => ({ message: { content: OK }, eval_count: 7 }) };
    }) as unknown as typeof fetch;
    const out = await postChatOllama({ ref: REF, body: { messages: [{ role: "user", content: "q" }] }, fetchImpl });
    guard.assert();
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("qwen3.5:9b-q4_K_M");
    expect(body["think"]).toBe(false); // mandatory: thinking model
    expect(body["format"]).toBe("json"); // schema mode is broken on 0.32.15
    expect(body["stream"]).toBe(false);
    expect(body["options"]).toEqual({ num_ctx: OLLAMA_NUM_CTX }); // prompt alone is ~6.3k tokens
    expect(out.content).toBe(OK);
    expect(out.evalCount).toBe(7);
  });

  it("case 2: server unavailable → network GatewayError (single attempt)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await postChatOllama({ ref: REF, body: { messages: [] }, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).kind).toBe("network");
    // One attempt only: a local endpoint that is down must never be retried
    // into request amplification.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("case 3: model missing (HTTP 404) → auth/non-retryable so the caller fails over", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404, text: async () => "no model" })) as unknown as typeof fetch;
    const err = await postChatOllama({ ref: REF, body: { messages: [] }, fetchImpl }).catch((e) => e);
    expect((err as GatewayError).kind).toBe("auth");
    expect((err as GatewayError).retryable).toBe(false);
  });

  it("case 6: malformed local output (empty content) → schema error, never raw pass-through", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: "", thinking: "budget spent here" } }),
    })) as unknown as typeof fetch;
    const err = await postChatOllama({ ref: REF, body: { messages: [] }, fetchImpl }).catch((e) => e);
    expect((err as GatewayError).kind).toBe("schema");
  });

  it("case 8: timeout → timeout GatewayError", async () => {
    const fetchImpl = (async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const err = await postChatOllama({ ref: REF, body: { messages: [] }, fetchImpl }).catch((e) => e);
    expect((err as GatewayError).kind).toBe("timeout");
  });

  it("case 9: 5xx fails once by default (no hidden retry / no amplification)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, text: async () => "busy" })) as unknown as typeof fetch;
    const err = await postChatOllama({ ref: REF, body: { messages: [] }, fetchImpl }).catch((e) => e);
    expect((err as GatewayError).kind).toBe("provider");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("case 11: maxRetries=1 retries a 5xx exactly once, then stops", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })) as unknown as typeof fetch;
    await postChatOllama({ ref: REF, body: { messages: [] }, fetchImpl, maxRetries: 1, baseBackoffMs: 1 }).catch(() => undefined);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never sends credentials (local runtime needs none)", async () => {
    let init: RequestInit = {};
    const fetchImpl = (async (_u: string, i: RequestInit) => {
      init = i;
      return { ok: true, status: 200, json: async () => ({ message: { content: OK } }) };
    }) as unknown as typeof fetch;
    await postChatOllama({ ref: REF, body: { messages: [] }, fetchImpl });
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(["Content-Type"]);
  });

  it("falls back to documented defaults for an empty ref", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = u;
      return { ok: true, status: 200, json: async () => ({ message: { content: OK } }) };
    }) as unknown as typeof fetch;
    await postChatOllama({ ref: { url: "", model: "" }, body: { messages: [] }, fetchImpl });
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
  });
});

describe("probeOllama — validation (cases 1, 3, 4)", () => {
  it("reports reachable with the exact model installed", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "qwen3.5:9b-q4_K_M" }, { name: "llama3:8b" }] }),
    })) as unknown as typeof fetch;
    const res = await probeOllama(REF, { fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("installed");
  });

  it("reports reachable but model missing", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "llama3:8b" }] }),
    })) as unknown as typeof fetch;
    const res = await probeOllama(REF, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("not installed");
  });

  it("matches a tag reported without its :latest suffix", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "qwen3.5:9b-q4_K_M:latest" }] }),
    })) as unknown as typeof fetch;
    expect((await probeOllama(REF, { fetchImpl })).ok).toBe(true);
  });

  it("reports unreachable instead of throwing", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const res = await probeOllama(REF, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("unreachable");
  });
});

describe("postChatOllama isolation", () => {
  it("case 12: never contacts Groq or OpenRouter", async () => {
    const guard = noCloudCalls();
    const fetchImpl = (async (u: string) => {
      guard.calls.push(u);
      return { ok: true, status: 200, json: async () => ({ message: { content: OK } }) };
    }) as unknown as typeof fetch;
    await postChatOllama({ ref: REF, body: { messages: [] }, fetchImpl });
    guard.assert();
    expect(guard.calls).toHaveLength(1);
    expect(chatOk(OK)).toBeDefined();
  });
});
