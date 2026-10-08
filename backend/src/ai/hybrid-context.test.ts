/**
 * EXPERIMENTAL hybrid context — backend contract tests.
 *
 * These pin the two properties the prototype is allowed to have:
 *  1. CONTEXT_MODE=dom (the DEFAULT) is behaviourally identical to
 *     pre-prototype: an attached image is dropped and never reaches a provider.
 *  2. CONTEXT_MODE=hybrid sends the image to the LOCAL provider only, with the
 *     vision instruction attached, and never to the cloud standby.
 *
 * Plus the hard limits (malformed / oversized image) and the output contract,
 * which must be exactly as strict with an image as without one.
 */
import { describe, expect, it } from "vitest";
import { handleChat } from "../routes/chat.js";
import { __resetReasoningRotation, reasonOnce } from "./qwen-client.js";
import { GroqKeyPool } from "../gateway/gateway.js";

const POOL = new GroqKeyPool(["k1"]);
const LOCAL = { url: "http://127.0.0.1:11434", model: "qwen3.5:9b-q4_K_M" };
const VALID = JSON.stringify({ type: "answer", text: "ok" });
const IMG = { b64: "aGVsbG8=", width: 640, height: 480, bytes: 5 };

const isLocal = (u: string): boolean => u.includes("127.0.0.1:11434");

interface Call {
  url: string;
  body: Record<string, any> | undefined;
}

/** Records every outbound request body so assertions can inspect the wire. */
function recorder(behaviour: "ok" | "ollama-down" = "ok") {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : undefined });
    // Simulate a local outage so the bounded cloud standby is exercised.
    if (behaviour === "ollama-down" && isLocal(url)) throw new TypeError("fetch failed");
    if (isLocal(url)) {
      return { ok: true, status: 200, json: async () => ({ message: { content: VALID }, eval_count: 5 }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: VALID } }] }) };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const localMessages = (calls: Call[]): Record<string, any>[] =>
  (calls.find((c) => isLocal(c.url))?.body?.messages ?? []) as Record<string, any>[];

const cloudMessages = (calls: Call[]): Record<string, any>[] =>
  (calls.find((c) => !isLocal(c.url))?.body?.messages ?? []) as Record<string, any>[];

describe("CONTEXT_MODE gating (default must stay exactly DOM)", () => {
  it("dom (default) DROPS an attached image — no provider ever sees it", async () => {
    const { calls, fetchImpl } = recorder();
    const res = await handleChat(
      { userPayload: "[VERIFIED PAGE STATE]\nPAGE url=https://x.test generation=1", image: IMG },
      { pool: POOL, ollama: LOCAL, llmProvider: "ollama", fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.body?.messages).toBeDefined();
      for (const message of call.body!.messages as Record<string, any>[]) {
        expect(message).not.toHaveProperty("images");
        expect(String(message["content"])).not.toContain("PAGE VISUAL CONTEXT");
      }
    }
  });

  it("hybrid forwards the image to the LOCAL provider with the vision instruction", async () => {
    const { calls, fetchImpl } = recorder();
    const res = await handleChat(
      { userPayload: "[VERIFIED PAGE STATE]\nPAGE url=https://x.test generation=1", image: IMG },
      { pool: POOL, ollama: LOCAL, llmProvider: "ollama", contextMode: "hybrid", fetchImpl },
    );
    expect(res.status).toBe(200);
    const messages = localMessages(calls);
    expect(messages.length).toBe(2);
    expect(messages[1]?.["images"]).toEqual([IMG.b64]);
    expect(String(messages[0]?.["content"])).toContain("PAGE VISUAL CONTEXT");
    expect(String(messages[0]?.["content"])).toContain("NEVER invent an element id");
  });

  it("hybrid degrades to TEXT-ONLY on cloud fallback (no image, no vision instruction)", async () => {
    __resetReasoningRotation();
    const { calls, fetchImpl } = recorder("ollama-down"); // local outage -> Groq
    const res = await handleChat(
      { userPayload: "[VERIFIED PAGE STATE]\nPAGE url=https://x.test generation=1", image: IMG },
      { pool: POOL, ollama: LOCAL, llmProvider: "auto", contextMode: "hybrid", fetchImpl },
    );
    expect(res.status).toBe(200);
    const messages = cloudMessages(calls);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).not.toHaveProperty("images");
      // Never promise a screenshot the fallback model was not sent.
      expect(String(message["content"])).not.toContain("PAGE VISUAL CONTEXT");
    }
  });
});

describe("hybrid image validation is strict", () => {
  const base = { pool: POOL, ollama: LOCAL, fetchImpl: recorder().fetchImpl };

  it("rejects a non-object image", async () => {
    const res = await handleChat({ userPayload: "x", image: "nope" }, base);
    expect(res.status).toBe(400);
  });

  it("rejects non-base64", async () => {
    const res = await handleChat(
      { userPayload: "x", image: { ...IMG, b64: "not base64!!" } },
      base,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an image that was never downscaled (transport protection)", async () => {
    const res = await handleChat(
      { userPayload: "x", image: { ...IMG, b64: "A".repeat(1_500_001) } },
      base,
    );
    expect(res.status).toBe(400);
  });

  it("rejects impossible dimensions", async () => {
    const res = await handleChat({ userPayload: "x", image: { ...IMG, width: 0 } }, base);
    expect(res.status).toBe(400);
  });

  it("a request without an image is unaffected (unchanged contract)", async () => {
    const { fetchImpl } = recorder();
    const res = await handleChat(
      { userPayload: "[VERIFIED PAGE STATE]\nPAGE url=https://x.test generation=1" },
      { pool: POOL, ollama: LOCAL, llmProvider: "ollama", fetchImpl },
    );
    expect(res.status).toBe(200);
  });
});

describe("output contract is unchanged with an image attached", () => {
  it("rejects malformed model output exactly as it does without an image", async () => {
    __resetReasoningRotation();
    const bad = "I think you should click the button.";
    const fetchImpl = (async (url: string) =>
      isLocal(url)
        ? { ok: true, status: 200, json: async () => ({ message: { content: bad }, eval_count: 5 }) }
        : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: bad } }] }) }) as unknown as typeof fetch;

    await expect(
      reasonOnce({
        pool: POOL,
        ollama: LOCAL,
        llmProvider: "ollama",
        userPayload: "page state",
        image: IMG,
        fetchImpl,
      }),
    ).rejects.toThrow();
  });

  it("still enforces the closed target grammar (no coordinates, no selectors)", async () => {
    __resetReasoningRotation();
    // Coordinate / selector style targeting is NOT part of the schema. The
    // backend must keep rejecting it even when an image is attached — a
    // screenshot must never become a way to execute at pixels.
    const coordinate = JSON.stringify({
      type: "action",
      action: { action: "click", parameters: { x: 120, y: 440 }, pageGeneration: 1 },
    });
    const fetchImpl = (async (url: string) =>
      isLocal(url)
        ? { ok: true, status: 200, json: async () => ({ message: { content: coordinate }, eval_count: 5 }) }
        : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: coordinate } }] }) }) as unknown as typeof fetch;

    await expect(
      reasonOnce({
        pool: POOL,
        ollama: LOCAL,
        llmProvider: "ollama",
        userPayload: "page state",
        image: IMG,
        fetchImpl,
      }),
    ).rejects.toThrow();
  });
});
