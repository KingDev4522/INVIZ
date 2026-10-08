/**
 * Local-provider (Ollama) availability-suspension tests.
 *
 * The defect these guard: the suspension was a permanent boolean latch, so
 * "Ollama was not running when the backend started" could only be undone by
 * restarting the backend — even after the operator started Ollama. That is the
 * single biggest defect in local-first behaviour, so its replacement is pinned
 * here from both sides: it must NOT hammer a down endpoint, and it MUST come
 * back on its own.
 *
 * The clock is injected (`input.now`) so cooldown behaviour is deterministic
 * and no test waits in real time.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetReasoningRotation,
  noteOllamaProbeHealthy,
  reasonOnce,
} from "./qwen-client.js";
import { GroqKeyPool } from "../gateway/gateway.js";
import { OLLAMA_SUSPEND_COOLDOWN_MS } from "../../../shared/constants.js";

const POOL = new GroqKeyPool(["k1"]);
const LOCAL = { url: "http://127.0.0.1:11434", model: "qwen3.5:9b-q4_K_M" };
const VALID = JSON.stringify({ type: "answer", text: "ok" });

/** How the local endpoint behaves on this call. */
type LocalMode = "ok" | "down" | "missing" | "empty" | "broken";

/**
 * Mutable so a test can bring Ollama "up" mid-run without any real process:
 * that is exactly the unavailable → available transition under test.
 */
function harness(state: { local: LocalMode }) {
  const calls = { local: 0, groq: 0 };
  const fetchImpl = (async (url: string) => {
    if (url.includes("127.0.0.1:11434")) {
      calls.local += 1;
      if (state.local === "down") throw new TypeError("fetch failed");
      if (state.local === "missing") return { ok: false, status: 404, text: async () => "no model" };
      // Ollama is RUNNING but unhealthy (failed model load / OOM): HTTP 500.
      if (state.local === "broken") return { ok: false, status: 500, text: async () => "boom" };
      if (state.local === "empty") {
        return { ok: true, status: 200, json: async () => ({ message: { content: "   " } }) };
      }
      return { ok: true, status: 200, json: async () => ({ message: { content: VALID }, eval_count: 5 }) };
    }
    calls.groq += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: VALID } }] }) };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const turn = (now: number, fetchImpl: typeof fetch) => ({
  pool: POOL,
  ollama: LOCAL,
  userPayload: "test payload",
  now: () => now,
  fetchImpl,
});

describe("local Ollama availability suspension — bounded and self-healing", () => {
  beforeEach(() => {
    __resetReasoningRotation();
  });

  it("falls back to cloud when the local endpoint is down", async () => {
    const state = { local: "down" as LocalMode };
    const { calls, fetchImpl } = harness(state);
    const out = await reasonOnce(turn(1_000, fetchImpl));
    expect(out.type).toBe("answer");
    expect(calls.local).toBe(1);
    expect(calls.groq).toBe(1);
  });

  it("does NOT re-contact a down local provider inside the cooldown", async () => {
    const state = { local: "down" as LocalMode };
    const { calls, fetchImpl } = harness(state);
    await reasonOnce(turn(1_000, fetchImpl));
    expect(calls.local).toBe(1);
    // One millisecond before the cooldown expires: still skipped.
    await reasonOnce(turn(1_000 + OLLAMA_SUSPEND_COOLDOWN_MS - 1, fetchImpl));
    expect(calls.local).toBe(1);
    expect(calls.groq).toBe(2);
  });

  it("RECOVERS local inference after the cooldown with no backend restart", async () => {
    const state = { local: "down" as LocalMode };
    const { calls, fetchImpl } = harness(state);
    await reasonOnce(turn(1_000, fetchImpl));
    expect(calls.local).toBe(1);
    expect(calls.groq).toBe(1);

    state.local = "ok"; // operator starts Ollama
    const out = await reasonOnce(turn(1_000 + OLLAMA_SUSPEND_COOLDOWN_MS, fetchImpl));

    expect(out.type).toBe("answer");
    expect(calls.local).toBe(2); // local was tried again
    expect(calls.groq).toBe(1); // and it served the turn: no extra cloud spend
  });

  it("re-arms the cooldown when local is still down (bounded probing, not a loop)", async () => {
    const state = { local: "down" as LocalMode };
    const { calls, fetchImpl } = harness(state);
    await reasonOnce(turn(0, fetchImpl));
    expect(calls.local).toBe(1);

    await reasonOnce(turn(OLLAMA_SUSPEND_COOLDOWN_MS, fetchImpl));
    expect(calls.local).toBe(2); // one probe per cooldown, on expiry

    await reasonOnce(turn(2 * OLLAMA_SUSPEND_COOLDOWN_MS - 1, fetchImpl));
    expect(calls.local).toBe(2); // and the re-armed cooldown holds

    await reasonOnce(turn(2 * OLLAMA_SUSPEND_COOLDOWN_MS, fetchImpl));
    expect(calls.local).toBe(3); // exactly one probe, never a retry storm
  });

  it("does NOT retry an unknown model tag as if it were a transient outage", async () => {
    const state = { local: "missing" as LocalMode };
    const { calls, fetchImpl } = harness(state);
    await reasonOnce(turn(0, fetchImpl));
    expect(calls.local).toBe(1);

    // A long time later, with no probe clearing it, it stays suspended.
    await reasonOnce(turn(OLLAMA_SUSPEND_COOLDOWN_MS * 100, fetchImpl));
    await reasonOnce(turn(OLLAMA_SUSPEND_COOLDOWN_MS * 200, fetchImpl));
    expect(calls.local).toBe(1);
    expect(calls.groq).toBe(3);
  });

  it("treats an HTTP 500 from a RUNNING Ollama as an availability fault", async () => {
    // A server that is up but unhealthy (failed model load, out of memory)
    // costs a full round trip on every turn if left eligible, so it must be
    // cooled down exactly like a server that is not running at all.
    const state = { local: "broken" as LocalMode };
    const { calls, fetchImpl } = harness(state);
    await reasonOnce(turn(0, fetchImpl));
    expect(calls.local).toBe(1);
    expect(calls.groq).toBe(1); // cloud covered the turn

    await reasonOnce(turn(10, fetchImpl)); // well inside the cooldown
    expect(calls.local).toBe(1); // skipped, no repeated 25s stalls
    expect(calls.groq).toBe(2); // that turn went straight to cloud

    // ...and it recovers by itself once Ollama is healthy again.
    state.local = "ok";
    const out = await reasonOnce(turn(OLLAMA_SUSPEND_COOLDOWN_MS, fetchImpl));
    expect(out.type).toBe("answer");
    expect(calls.local).toBe(2);
    expect(calls.groq).toBe(2); // local served it: no extra cloud spend
  });

  it("clears the suspension from a positive probe (the /v1/validation recovery path)", async () => {
    const state = { local: "down" as LocalMode };
    const { calls, fetchImpl } = harness(state);
    await reasonOnce(turn(0, fetchImpl));
    expect(calls.local).toBe(1);

    state.local = "ok";
    noteOllamaProbeHealthy(); // what checkOllama() calls on a healthy probe
    // Deep inside the cooldown it would otherwise stay skipped.
    await reasonOnce(turn(10, fetchImpl));
    expect(calls.local).toBe(2);
  });

  it("keeps a healthy local provider eligible on every following turn", async () => {
    const state = { local: "ok" as LocalMode };
    const { calls, fetchImpl } = harness(state);
    await reasonOnce(turn(0, fetchImpl));
    await reasonOnce(turn(1, fetchImpl));
    await reasonOnce(turn(2, fetchImpl));
    expect(calls.local).toBe(3);
    expect(calls.groq).toBe(0); // local ends the request; no cloud spend
  });

  it("does not suspend local on malformed output (capability fault, not availability)", async () => {
    const state = { local: "empty" as LocalMode };
    const { calls, fetchImpl } = harness(state);
    await reasonOnce(turn(0, fetchImpl));
    await reasonOnce(turn(10, fetchImpl)); // well inside any cooldown
    expect(calls.local).toBe(2); // retried each turn, unchanged behaviour
    expect(calls.groq).toBe(2);
  });
});