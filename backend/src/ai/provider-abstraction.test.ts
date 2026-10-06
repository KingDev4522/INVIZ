/**
 * Provider-abstraction tests: local-first rotation, explicit provider pinning,
 * bounded single fallback, and cross-provider isolation (spec cases 10–14).
 * Existing Groq/OpenRouter tests are untouched and must stay green.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  __resetReasoningRotation,
  fallbackReasonFor,
  reasonOnce,
  reasoningOrder,
  QwenError,
} from "./qwen-client.js";
import { GatewayError, GroqKeyPool } from "../gateway/gateway.js";

const POOL = new GroqKeyPool(["k1"]);
const LOCAL = { url: "http://127.0.0.1:11434", model: "qwen3.5:9b-q4_K_M" };
const OR = { apiKey: "or-test-key", model: "google/gemma-4-26b-a4b-it:free" };
const VALID = JSON.stringify({ type: "answer", text: "ok" });

/**
 * Records which host served each call. Returns each vendor's REAL response
 * shape: Ollama replies `{message:{content}}`, the OpenAI-compatible vendors
 * reply `{choices:[{message:{content}}]}`.
 */
function tracer(behaviour?: (url: string) => "fail-429" | "fail-404" | "refused" | "ok") {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const verdict = behaviour?.(url) ?? "ok";
    if (verdict === "fail-429") {
      return { ok: false, status: 429, headers: { get: () => null }, text: async () => "slow" };
    }
    if (verdict === "fail-404") {
      return { ok: false, status: 404, text: async () => "missing" };
    }
    if (verdict === "refused") {
      throw new TypeError("fetch failed"); // Ollama not running
    }
    if (isLocal(url)) {
      return { ok: true, status: 200, json: async () => ({ message: { content: VALID }, eval_count: 5 }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: VALID } }] }) };
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

const isLocal = (u: string): boolean => u.includes("127.0.0.1:11434");
const isOr = (u: string): boolean => u.includes("openrouter.ai");
const isGroq = (u: string): boolean => u.includes("api.groq.com");

describe("reasoningOrder — provider selection (case 11, Phase 2: NO rotation)", () => {
  it("omits unconfigured providers and never repeats one (no loop)", () => {
    __resetReasoningRotation();
    const a = reasoningOrder(["ollama", "groq"]);
    expect(a).not.toContain("openrouter");
    expect(new Set(a).size).toBe(a.length);
  });

  it("Phase 2: auto is local-first, NOT rotation — repeated calls give the SAME order", () => {
    __resetReasoningRotation();
    const first = reasoningOrder(["ollama", "openrouter", "groq"]);
    const second = reasoningOrder(["ollama", "openrouter", "groq"]);
    const third = reasoningOrder(["ollama", "openrouter", "groq"]);
    expect(first).toEqual(["ollama", "openrouter", "groq"]);
    // Regression guard for the whole point of Phase 2: a healthy local
    // provider must lead EVERY turn, so no cloud quota is burned.
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first[0]).toBe("ollama");
  });

  it("pins the explicit provider first", () => {
    __resetReasoningRotation();
    for (let i = 0; i < 4; i += 1) {
      expect(reasoningOrder(["ollama", "openrouter", "groq"], "groq")[0]).toBe("groq");
    }
  });

  it("ignores a pinned provider that is not configured", () => {
    __resetReasoningRotation();
    expect(reasoningOrder(["groq"], "ollama")).toEqual(["groq"]);
  });
});

describe("fallbackReasonFor — failure classification", () => {
  it("maps local failures to stable, log-safe codes", () => {
    expect(fallbackReasonFor("ollama", new GatewayError("network", "x"))).toBe("OLLAMA_UNAVAILABLE");
    expect(fallbackReasonFor("ollama", new GatewayError("timeout", "x"))).toBe("OLLAMA_TIMEOUT");
    expect(fallbackReasonFor("ollama", new GatewayError("auth", "x", 404))).toBe(
      "OLLAMA_MODEL_MISSING",
    );
    expect(fallbackReasonFor("ollama", new GatewayError("schema", "x"))).toBe(
      "OLLAMA_MALFORMED_OUTPUT",
    );
    expect(fallbackReasonFor("ollama", new GatewayError("provider", "x", 500))).toBe(
      "OLLAMA_HTTP_ERROR",
    );
  });

  it("names the cloud provider for cloud failures", () => {
    expect(fallbackReasonFor("groq", new GatewayError("rate_limit", "x", 429))).toBe(
      "GROQ_RATE_LIMIT",
    );
    expect(fallbackReasonFor("openrouter", new GatewayError("auth", "x", 401))).toBe(
      "OPENROUTER_AUTH",
    );
  });
});

describe("reasonOnce — local provider preferred", () => {
  it("cases 2/3: a healthy Ollama NEVER calls OpenRouter or Groq (repeated turns)", async () => {
    __resetReasoningRotation();
    for (let turn = 0; turn < 4; turn += 1) {
      const t = tracer();
      const out = await reasonOnce({
        userPayload: "p",
        pool: POOL,
        ollama: LOCAL,
        llmProvider: "auto",
        fetchImpl: t.fetchImpl,
      });
      expect(out).toEqual({ type: "answer", text: "ok" });
      expect(t.urls).toHaveLength(1);
      expect(isLocal(t.urls[0] as string)).toBe(true);
      expect(t.urls.some(isOr)).toBe(false);
      expect(t.urls.some(isGroq)).toBe(false);
    }
  });

  it("case 17: one successful local turn = exactly one local request", async () => {
    __resetReasoningRotation();
    const t = tracer();
    await reasonOnce({ userPayload: "p", pool: POOL, ollama: LOCAL, fetchImpl: t.fetchImpl });
    expect(t.urls).toHaveLength(1);
  });

  it("keeps the local model tag exact — no silent substitution", async () => {
    __resetReasoningRotation();
    let sentModel = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (isLocal(url)) {
        sentModel = (JSON.parse(String(init.body)) as Record<string, unknown>)["model"] as string;
        return { ok: true, status: 200, json: async () => ({ message: { content: VALID } }) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: VALID } }] }) };
    }) as unknown as typeof fetch;
    await reasonOnce({ userPayload: "p", pool: POOL, ollama: LOCAL, fetchImpl });
    expect(sentModel).toBe("qwen3.5:9b-q4_K_M");
  });

  it("case 19: keep_alive is forwarded to Ollama when configured", async () => {
    __resetReasoningRotation();
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (isLocal(url)) {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return { ok: true, status: 200, json: async () => ({ message: { content: VALID } }) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: VALID } }] }) };
    }) as unknown as typeof fetch;
    await reasonOnce({
      userPayload: "p",
      pool: POOL,
      ollama: { ...LOCAL, keepAlive: "10m" },
      fetchImpl,
    });
    expect(body["keep_alive"]).toBe("10m");
  });

  it("case 20: local inference stays on one attempt and cloud is never touched", async () => {
    __resetReasoningRotation();
    const t = tracer();
    await reasonOnce({ userPayload: "p", pool: POOL, ollama: LOCAL, fetchImpl: t.fetchImpl });
    expect(t.urls).toHaveLength(1);
    expect(t.urls.filter(isLocal)).toHaveLength(1);
  });

  it("uses local Ollama when healthy (case 10/13: never touches cloud)", async () => {
    __resetReasoningRotation();
    const { urls, fetchImpl } = tracer();
    const out = await reasonOnce({
      userPayload: "p",
      pool: POOL,
      ollama: LOCAL,
      llmProvider: "ollama",
      fetchImpl,
    });
    expect(out).toEqual({ type: "answer", text: "ok" });
    expect(urls.length).toBe(1);
    expect(isLocal(urls[0] as string)).toBe(true);
  });

  it("falls back to cloud exactly once when Ollama is not running, and latches (cases 2/7)", async () => {
    __resetReasoningRotation();
    const first = tracer((u) => (isLocal(u) ? "refused" : "ok"));
    const out = await reasonOnce({
      userPayload: "p",
      pool: POOL,
      ollama: LOCAL,
      llmProvider: "ollama",
      fetchImpl: first.fetchImpl,
    });
    expect(out).toEqual({ type: "answer", text: "ok" });
    expect(first.urls.filter(isLocal)).toHaveLength(1); // one local attempt only
    expect(first.urls.filter(isGroq)).toHaveLength(1); // one bounded fallback
    // Local is now latched off: the next turn must NOT re-probe the dead
    // endpoint (no per-turn connection timeouts).
    const second = tracer();
    await reasonOnce({
      userPayload: "p",
      pool: POOL,
      ollama: LOCAL,
      llmProvider: "ollama",
      fetchImpl: second.fetchImpl,
    });
    expect(second.urls.filter(isLocal)).toHaveLength(0);
    expect(second.urls.length).toBeGreaterThan(0);
  });

  it("a local 429 also cascades once without retrying local", async () => {
    __resetReasoningRotation();
    const t = tracer((u) => (isLocal(u) ? "fail-429" : "ok"));
    const out = await reasonOnce({
      userPayload: "p",
      pool: POOL,
      ollama: LOCAL,
      llmProvider: "ollama",
      fetchImpl: t.fetchImpl,
    });
    expect(out).toEqual({ type: "answer", text: "ok" });
    expect(t.urls.filter(isLocal)).toHaveLength(1);
  });

  it("falls back when the exact model is missing locally (case 3)", async () => {
    __resetReasoningRotation();
    const t = tracer((u) => (isLocal(u) ? "fail-404" : "ok"));
    const out = await reasonOnce({
      userPayload: "p",
      pool: POOL,
      ollama: LOCAL,
      llmProvider: "ollama",
      fetchImpl: t.fetchImpl,
    });
    expect(out).toEqual({ type: "answer", text: "ok" });
    expect(t.urls.filter(isLocal)).toHaveLength(1);
    expect(t.urls.some(isGroq)).toBe(true);
  });

  it("case 7: never ping-pongs — each provider is visited at most once", async () => {
    __resetReasoningRotation();
    // Everything fails: the cascade must be finite. Cloud vendors may each
    // self-retry once (pre-existing, bounded); what must never happen is
    // Ollama→Groq→Ollama, so the ORDERED SET of visited providers has no
    // repeats and local is attempted exactly once.
    const t = tracer(() => "fail-429");
    await expect(
      reasonOnce({
        userPayload: "p",
        pool: POOL,
        ollama: LOCAL,
        openrouter: OR,
        llmProvider: "ollama",
        fetchImpl: t.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(QwenError);
    expect(t.urls.filter(isLocal)).toHaveLength(1);
    // No revisits after a switch: each provider appears in one contiguous run.
    const sequence = t.urls.map((u) => (isLocal(u) ? "ollama" : isOr(u) ? "openrouter" : "groq"));
    const runs = sequence.filter((p, i) => p !== sequence[i - 1]);
    expect(new Set(runs).size).toBe(runs.length);
  });

  it("case 14: one reasoning operation = one local inference attempt", async () => {
    __resetReasoningRotation();
    const t = tracer();
    await reasonOnce({
      userPayload: "p",
      pool: POOL,
      ollama: LOCAL,
      llmProvider: "ollama",
      fetchImpl: t.fetchImpl,
    });
    expect(t.urls).toHaveLength(1);
  });

  it("case 6/7: malformed local output never reaches the caller as an action", async () => {
    __resetReasoningRotation();
    const fetchImpl = (async (url: string) => {
      if (isLocal(url)) {
        return { ok: true, status: 200, json: async () => ({ message: { content: "I think you should click it" } }) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: VALID } }] }) };
    }) as unknown as typeof fetch;
    const out = await reasonOnce({
      userPayload: "p",
      pool: POOL,
      ollama: LOCAL,
      llmProvider: "ollama",
      fetchImpl,
    });
    // Cloud answered a VALID outcome; the prose reply was never executed.
    expect(out).toEqual({ type: "answer", text: "ok" });
  });

  it("case 13: Groq-only mode never contacts Ollama", async () => {
    __resetReasoningRotation();
    const t = tracer();
    const out = await reasonOnce({
      userPayload: "p",
      pool: POOL,
      ollama: LOCAL,
      llmProvider: "groq",
      fetchImpl: t.fetchImpl,
    });
    expect(out).toEqual({ type: "answer", text: "ok" });
    expect(t.urls.every(isGroq)).toBe(true);
    expect(t.urls.some(isLocal)).toBe(false);
    expect(t.urls.some(isOr)).toBe(false);
  });

  it("cloud-only (no ollama ref) behaves exactly as before", async () => {
    __resetReasoningRotation();
    const t = tracer();
    await reasonOnce({ userPayload: "p", pool: POOL, fetchImpl: t.fetchImpl });
    expect(t.urls.every(isGroq)).toBe(true);
  });
});
