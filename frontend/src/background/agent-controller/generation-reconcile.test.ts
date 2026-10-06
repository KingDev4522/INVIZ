/**
 * Generation-reconciliation regression (live-reported bug).
 *
 * Reported: after switching the local model to llama3.2:3b, "open github"
 * worked but opening any REPOSITORY failed with "That action was blocked for
 * safety" (heard as "privacy issues"), differently on every repeat.
 *
 * Measured cause: the model proposed the CORRECT target and then wrote an
 * invented `pageGeneration` (42, 13, …) instead of the one in the page state.
 * WebGuard correctly rejected it as stale. Small local models cannot reliably
 * echo that number, and it is unreliable model input rather than a safety
 * signal — the controller has already loaded a fresh snapshot for the step.
 *
 * These tests pin the fix AND the guard rails around it.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { AgentController, type PageSnapshotLike } from "./controller.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";

const GEN = 11;
const REPO = "e3";

const SNAPSHOT: PageSnapshotLike = {
  url: "https://github.com/Jakubantalik",
  title: "GitHub",
  generation: GEN,
  items: [
    { id: "e1", role: "link", name: "Sign in", states: {}, fieldKind: null, sensitive: false },
    { id: REPO, role: "link", name: "thinking-orbs", states: {}, fieldKind: null, sensitive: false },
    { id: "e9", role: "button", name: "Submit Application", states: {}, fieldKind: null, sensitive: false },
  ],
};

const voice = (text: string) => ({
  text,
  lang: "en" as const,
  source: "voice" as const,
  timestamp: 1,
});

function build(outcomes: AgentOutcome[]) {
  const spoken: string[] = [];
  const executed: string[] = [];
  const guarded: Array<{ target?: string; pageGeneration?: number }> = [];
  let current: TaskSnapshot | null = null;
  const queue = [...outcomes];
  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async () => queue.shift() ?? ({ type: "task_complete" } as AgentOutcome),
    enrich: async () => ({
      interpretation: "GitHub profile.",
      pageGeneration: GEN,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    executeFn: async (a) => {
      executed.push(`${a.action}:${a.target ?? "-"}`);
      return { status: "executed" as const, action: a.action, target: a.target, pageGeneration: GEN, timestamp: 1 };
    },
    verifyFn: async () => ({
      success: true,
      outcome: "VERIFIED_SUCCESS" as const,
      expected: {},
      observed: null,
      timedOut: false,
      pageGeneration: GEN,
    }),
    speak: async (t) => {
      spoken.push(t);
    },
    stopAudio: async () => undefined,
    setAgentActive: async () => undefined,
    loadSnapshot: async () => SNAPSHOT,
    loadLayerB: async () => ({
      interpretation: "cached",
      pageGeneration: GEN,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    saveLayerB: async () => undefined,
    store: {
      load: async () => current,
      save: async (s) => {
        current = { ...s };
      },
      clear: async () => {
        current = null;
      },
    },
  });
  return {
    controller,
    spoken,
    executed,
    guarded,
    status: () => current?.status ?? null,
  };
}

const clickRepo = (claimedGeneration: number): AgentOutcome => ({
  type: "action",
  action: { action: "click", target: REPO, pageGeneration: claimedGeneration },
});

describe("model-fabricated pageGeneration no longer blocks a valid target", () => {
  it("executes the repo click even when the model invents the generation", async () => {
    // Exactly what llama3.2:3b emitted: correct target, bogus generation 42.
    const b = build([clickRepo(42), { type: "task_complete" }]);
    await b.controller.routeVoice(voice("open the thinking-orbs repository"), 7);
    expect(b.executed).toContain(`click:${REPO}`);
    expect(b.spoken.join(" ")).not.toContain("blocked for safety");
    expect(b.status()).not.toBe("BLOCKED");
  });

  it("still works when the model omits pageGeneration entirely", async () => {
    const b = build([
      { type: "action", action: { action: "click", target: REPO } },
      { type: "task_complete" },
    ]);
    await b.controller.routeVoice(voice("open the thinking-orbs repository"), 7);
    expect(b.executed).toContain(`click:${REPO}`);
  });

  it("accepts a correct generation unchanged", async () => {
    const b = build([clickRepo(GEN), { type: "task_complete" }]);
    await b.controller.routeVoice(voice("open the thinking-orbs repository"), 7);
    expect(b.executed).toContain(`click:${REPO}`);
    expect(b.spoken.join(" ")).not.toContain("blocked for safety");
  });
});

describe("guard rails are NOT weakened", () => {
  it("still BLOCKS an unknown target, whatever generation it claims", async () => {
    const b = build([
      { type: "action", action: { action: "click", target: "e37", pageGeneration: GEN } },
    ]);
    await b.controller.routeVoice(voice("open something"), 7);
    // Nothing executes — that is the guard rail that matters.
    expect(b.executed).toHaveLength(0);
    expect(b.status()).toBe("BLOCKED");
    // The guard reason ("not in current registry") is mapped to an honest
    // element-not-found message rather than a scary "blocked for safety".
    expect(b.spoken.join(" ")).toContain("couldn't find that element");
  });

  it("still BLOCKS an unknown target even when it claims the current generation", async () => {
    const b = build([
      { type: "action", action: { action: "click", target: "e99", pageGeneration: GEN } },
    ]);
    await b.controller.routeVoice(voice("open something"), 7);
    expect(b.executed).toHaveLength(0);
    expect(b.status()).toBe("BLOCKED");
  });

  it("still requires confirmation for a submit control", async () => {
    const b = build([
      { type: "action", action: { action: "click", target: "e9", pageGeneration: 42 } },
    ]);
    await b.controller.routeVoice(voice("submit the application"), 7);
    expect(b.executed).toHaveLength(0);
    expect(b.status()).toBe("WAITING_FOR_CONFIRMATION");
  });
});
