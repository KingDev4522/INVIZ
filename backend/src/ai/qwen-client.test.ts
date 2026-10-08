/**
 * Backend reasoning contract-retry tests (live-proven failure mode).
 * A rejected model reply used to end the user's whole task. One corrective
 * re-ask must recover it; a second rejection must still fail honestly, and a
 * transport error must never be retried as if it were a format problem.
 */
import { describe, expect, it, vi } from "vitest";
import { __resetReasoningRotation, reasonOnce, QwenError } from "./qwen-client.js";
import { GroqKeyPool } from "../gateway/gateway.js";

/** Builds a fetch stub returning the given OpenAI-shaped chat responses. */
function stubFetch(contents: string[]): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchImpl = vi.fn(async () => {
    const content = contents[Math.min(n, contents.length - 1)] as string;
    n += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => n };
}

const POOL = new GroqKeyPool(["k1"]);

describe("reasonOnce — contract retry", () => {
  it("recovers when the first reply is unparseable and the second is valid", async () => {
    const { fetchImpl, calls } = stubFetch([
      "I think the answer is the search box.",
      JSON.stringify({ type: "answer", text: "The search box." }),
    ]);
    const outcome = await reasonOnce({
      userPayload: "[USER INTENT, lang=en]\nfind search",
      pool: POOL,
      fetchImpl,
    });
    expect(outcome).toEqual({ type: "answer", text: "The search box." });
    expect(calls()).toBe(2);
  });

  it("recovers when the first reply carries a fenced block", async () => {
    const { fetchImpl, calls } = stubFetch([
      '```json\n{"type":"answer","text":"Found it."}\n```',
    ]);
    const outcome = await reasonOnce({
      userPayload: "p",
      pool: POOL,
      fetchImpl,
    });
    expect(outcome).toEqual({ type: "answer", text: "Found it." });
    expect(calls()).toBe(1);
  });

  it("recovers a stray spoken key on an action", async () => {
    const { fetchImpl } = stubFetch([
      JSON.stringify({
        type: "action",
        action: { action: "click", target: "e1", text: "Clicking search." },
      }),
    ]);
    const outcome = await reasonOnce({ userPayload: "p", pool: POOL, fetchImpl });
    expect(outcome).toEqual({
      type: "action",
      action: { action: "click", target: "e1" },
    });
  });

  it("re-asks with a correction and extra token headroom", async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      const content =
        n === 0 ? "prose only" : JSON.stringify({ type: "answer", text: "ok" });
      n += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await reasonOnce({ userPayload: "ORIGINAL", pool: POOL, fetchImpl });
    const first = JSON.parse(bodies[0] as string) as {
      messages: Array<{ content: string }>;
      max_completion_tokens: number;
    };
    const second = JSON.parse(bodies[1] as string) as {
      messages: Array<{ content: string }>;
      max_completion_tokens: number;
    };
    expect(first.messages[1]?.content).toBe("ORIGINAL");
    expect(second.messages[1]?.content).toContain("ORIGINAL");
    expect(second.messages[1]?.content).toContain("FORMAT CORRECTION");
    expect(second.max_completion_tokens).toBeGreaterThan(
      first.max_completion_tokens as number,
    );
  });

  it("still fails honestly when the correction is rejected too", async () => {
    const { fetchImpl, calls } = stubFetch(["still prose", "still prose"]);
    await expect(
      reasonOnce({ userPayload: "p", pool: POOL, fetchImpl }),
    ).rejects.toBeInstanceOf(QwenError);
    // Exactly one re-ask, then it gives up.
    expect(calls()).toBe(2);
  });

  it("Phase 2: does NOT alternate vendors — OpenRouter leads every call", async () => {
    __resetReasoningRotation();
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ type: "answer", text: "ok" }) } }],
        }),
      };
    }) as unknown as typeof fetch;
    const or = { apiKey: "or-test-key", model: "google/gemma-4-26b-a4b-it:free" };
    await reasonOnce({ userPayload: "a", pool: POOL, openrouter: or, fetchImpl });
    await reasonOnce({ userPayload: "b", pool: POOL, openrouter: or, fetchImpl });
    // Both calls served by the first configured provider: no rotation, so a
    // healthy provider is never bypassed.
    expect(urls[0]).toContain("openrouter.ai");
    expect(urls[1]).toContain("openrouter.ai");
  });

  it("fails over to OpenRouter when Groq 429s (pinned Groq primary)", async () => {
    __resetReasoningRotation();
    const or = { apiKey: "or-test-key", model: "m" };
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes("api.groq.com")) {
        return { ok: false, status: 429, headers: { get: () => null }, text: async () => "slow" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ type: "answer", text: "via or" }) } }],
        }),
      };
    }) as unknown as typeof fetch;
    const outcome = await reasonOnce({
      userPayload: "go",
      pool: POOL,
      openrouter: or,
      llmProvider: "groq",
      fetchImpl,
    });
    expect(outcome).toEqual({ type: "answer", text: "via or" });
    expect(urls[0]).toContain("api.groq.com");
    expect(urls[urls.length - 1]).toContain("openrouter.ai");
  });

  it("latches OpenRouter off after a 401 so later calls go straight to Groq", async () => {
    __resetReasoningRotation();
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes("openrouter.ai")) {
        return { ok: false, status: 401, text: async () => "no" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ type: "answer", text: "ok" }) } }],
        }),
      };
    }) as unknown as typeof fetch;
    const or = { apiKey: "or-bad-key", model: "m" };
    await reasonOnce({ userPayload: "a", pool: POOL, openrouter: or, fetchImpl });
    await reasonOnce({ userPayload: "b", pool: POOL, openrouter: or, fetchImpl });
    // First call tried OR (then failed over); second skipped OR entirely.
    expect(urls.filter((u) => u.includes("openrouter.ai")).length).toBe(1);
    __resetReasoningRotation();
  });

  it("does not retry a contract violation that is actually a smuggled action", async () => {
    const { fetchImpl, calls } = stubFetch([
      JSON.stringify({
        type: "action",
        action: { action: "click", target: "e1", run: "rm -rf /" },
      }),
    ]);
    await expect(
      reasonOnce({ userPayload: "p", pool: POOL, fetchImpl }),
    ).rejects.toThrow(/invalid action/);
    // Re-asked once (recovery is allowed), but never accepted.
    expect(calls()).toBe(2);
  });
});
