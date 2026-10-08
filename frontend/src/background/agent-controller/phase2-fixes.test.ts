/**
 * Phase 2 regression tests: type→submit continuation, goal-echo confirmation,
 * answer-path guard, ask-loop breaker, expect-target drop, late-AI cancel.
 *
 * Each test pins one confirmed failure mode from the runtime analysis. The
 * harness mirrors production wiring (persisting store, enrich, progress sink)
 * with fully fake dependencies — no chrome, no network.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { AgentController, isEchoApproval, type PageSnapshotLike } from "./controller.js";
import type { ReasonInput } from "../../ai/qwen-client.js";
import type { AgentOutcome, ExecutionResult } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";

const SNAPSHOT: PageSnapshotLike = {
  url: "https://example.com/apply",
  title: "Apply",
  generation: 42,
  items: [
    { id: "e1", role: "link", name: "Open form", states: {}, fieldKind: null, sensitive: false },
    { id: "e2", role: "button", name: "Search", states: {}, fieldKind: null, sensitive: false },
    { id: "e3", role: "textbox", name: "Query", states: {}, fieldKind: "text", sensitive: false },
  ],
};

function okExec(): ExecutionResult {
  return { status: "executed", action: "click", target: "e2", pageGeneration: 42, timestamp: 1 };
}

function okVerify(pageGeneration = 42) {
  return {
    success: true,
    outcome: "VERIFIED_SUCCESS" as const,
    expected: {},
    observed: null,
    timedOut: false,
    pageGeneration,
  };
}

interface H {
  controller: AgentController;
  spoken: string[];
  inputs: ReasonInput[];
  executed: string[];
  verified: unknown[];
  stopped: number;
  store: { current: () => TaskSnapshot | null };
}

function make(opts: {
  outcomes: AgentOutcome[] | ((call: number, input: ReasonInput) => AgentOutcome | Promise<AgentOutcome>);
  execute?: (target?: string) => ExecutionResult;
}): H {
  const spoken: string[] = [];
  const inputs: ReasonInput[] = [];
  const executed: string[] = [];
  const verified: unknown[] = [];
  let stopped = 0;
  let current: TaskSnapshot | null = null;
  let calls = 0;
  const queue = Array.isArray(opts.outcomes) ? [...opts.outcomes] : null;

  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async (input) => {
      calls += 1;
      inputs.push(input);
      if (queue !== null) {
        const next = queue.shift();
        if (next === undefined) throw new Error("reason queue empty");
        return next;
      }
      return (opts.outcomes as (call: number, input: ReasonInput) => AgentOutcome | Promise<AgentOutcome>)(calls, input);
    },
    executeFn: async (action) => {
      executed.push(`${action.action}:${action.target ?? "-"}`);
      return opts.execute !== undefined ? opts.execute(action.target) : okExec();
    },
    verifyFn: async (req) => {
      verified.push(req);
      return okVerify();
    },
    speak: async (text) => {
      spoken.push(text);
    },
    stopAudio: async () => {
      stopped += 1;
    },
    setAgentActive: async () => undefined,
    loadSnapshot: async () => SNAPSHOT,
    loadLayerB: async () => null,
    saveLayerB: async () => undefined,
    readRegionText: async () => "Region text.",
    readFocusedElement: async () => null,
    repeatAudio: async () => undefined,
    enrich: async () => ({
      interpretation: "An application page.",
      pageGeneration: 42,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    onProgress: () => undefined,
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
    inputs,
    executed,
    verified,
    get stopped() {
      return stopped;
    },
    store: { current: () => current },
  };
}

const voice = (text: string) => ({ text, lang: "en" as const, source: "voice" as const, timestamp: 1 });

const CONFIRM_SUBMIT = {
  type: "confirmation_required",
  reason: "consequential",
  action: { action: "click", target: "e2", pageGeneration: 42 },
} as AgentOutcome;

describe("isEchoApproval unit scope", () => {
  const click = { action: "click", target: "e2", pageGeneration: 42 } as const;
  it("accepts goal-echo replies for the pending action", () => {
    for (const t of ["submit", "do it", "yes submit", "go ahead", "confirm it", "Search"]) {
      expect(isEchoApproval(t, { ...click }, "Search")).toBe(true);
    }
  });
  it("rejects long or unrelated replies", () => {
    expect(isEchoApproval("submit the quarterly report for review", { ...click }, "Search")).toBe(false);
    expect(isEchoApproval("what is this page about", { ...click }, "Search")).toBe(false);
    expect(isEchoApproval("", { ...click }, "Search")).toBe(false);
  });
});

describe("goal-echo confirmation", () => {
  it("'submit' executes the pending submit click instead of re-asking", async () => {
    const h = make({ outcomes: [CONFIRM_SUBMIT, { type: "task_complete", text: "done" }] });
    await h.controller.routeVoice(voice("Type onion and submit."), 7);
    expect(h.store.current()?.status).toBe("WAITING_FOR_CONFIRMATION");
    await h.controller.routeVoice(voice("Submit"), 7);
    expect(h.executed).toEqual(["click:e2"]);
    expect(h.inputs.length).toBe(2); // confirmation consumed no reasoning; loop completion did
  });

  it("'do it' executes the pending action", async () => {
    const h = make({ outcomes: [CONFIRM_SUBMIT, { type: "task_complete", text: "done" }] });
    await h.controller.routeVoice(voice("Do the thing."), 7);
    await h.controller.routeVoice(voice("do it"), 7);
    expect(h.executed).toEqual(["click:e2"]);
  });

  it("'no' still refuses (grammar preserved)", async () => {
    const h = make({ outcomes: [CONFIRM_SUBMIT, { type: "task_complete", text: "done" }] });
    await h.controller.routeVoice(voice("Do the thing."), 7);
    await h.controller.routeVoice(voice("no"), 7);
    expect(h.executed).toEqual([]);
  });
});

describe("answer-path guard", () => {
  it("does not store an action-echo reply into providedValues.context", async () => {
    const h = make({
      outcomes: [
        { type: "ask_user", question: "What next?", field: "context", sensitivity: "ordinary" },
        { type: "task_complete", text: "done" },
      ],
    });
    await h.controller.routeVoice(voice("Type onion and submit."), 7);
    expect(h.store.current()?.status).toBe("WAITING_FOR_USER_ANSWER");
    await h.controller.routeVoice(voice("Submit"), 7);
    expect(h.store.current()?.providedValues ?? {}).not.toHaveProperty("context");
    expect(h.inputs.length).toBe(2); // continued reasoning, no pollution
    expect(h.inputs[1]?.userPayload ?? "").not.toContain("context: Submit");
  });
});

describe("continuation + ask-loop breaker", () => {
  it("tells the model to continue after a verified action", async () => {
    const h = make({
      outcomes: [
        { type: "action", action: { action: "type", target: "e3", value: "onion", pageGeneration: 42 } },
        { type: "task_complete", text: "done" },
      ],
      execute: () => ({ status: "executed", action: "type", target: "e3", pageGeneration: 42, timestamp: 1 }),
    });
    await h.controller.routeVoice(voice("Type onion and submit."), 7);
    expect(h.inputs.length).toBe(2);
    expect(h.inputs[1]?.userPayload ?? "").toContain("Do not ask the user what to do next");
  });

  it("adds the anti-stall directive after consecutive ordinary asks", async () => {
    const h = make({
      outcomes: (call) =>
        call === 1
          ? { type: "ask_user", question: "Which one?", field: "nickname", sensitivity: "ordinary" }
          : { type: "task_complete", text: "done" },
    });
    await h.controller.routeVoice(voice("Do stuff."), 7);
    await h.controller.routeVoice(voice("whatever"), 7);
    expect(h.inputs.length).toBe(2);
    expect(h.inputs[1]?.userPayload ?? "").toContain("Do not emit ask_user again");
  });

  it("exempts high-sensitivity asks from slot storage and reasoning", async () => {
    const h = make({
      outcomes: [
        { type: "ask_user", question: "Password?", field: "password", sensitivity: "high" },
      ],
    });
    await h.controller.routeVoice(voice("Log in."), 7);
    await h.controller.routeVoice(voice("s3cret"), 7);
    // Memory-only secret path: never stored in providedValues, never reasoned.
    expect(h.inputs.length).toBe(1);
    expect(h.store.current()?.providedValues ?? {}).not.toHaveProperty("password");
  });
});

describe("expect-target guard", () => {
  it("drops a model-invented expect target and verifies against the default", async () => {
    const h = make({
      outcomes: [
        {
          type: "action",
          action: {
            action: "click",
            target: "e2",
            pageGeneration: 42,
            expect: { type: "element_present", target: "e99" },
          },
        },
        { type: "task_complete", text: "done" },
      ],
    });
    await h.controller.routeVoice(voice("Click search."), 7);
    expect(h.executed).toEqual(["click:e2"]); // the legitimate action still ran
    const req = h.verified[0] as { expect: { type: string; target?: string } };
    expect(req.expect.type).toBe("element_present");
    expect(req.expect.target).toBeUndefined();
  });
});

describe("late-AI cancellation", () => {
  it("discards a reasoning result that resolves after silent cancel", async () => {
    let resolveReason!: (o: AgentOutcome) => void;
    const h = make({
      outcomes: () =>
        new Promise<AgentOutcome>((r) => {
          resolveReason = r;
        }),
    });
    const turn = h.controller.routeVoice(voice("Do something slow."), 7);
    // Let the turn reach the reasoning await.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.inputs.length).toBe(1);
    expect(h.inputs[0]?.signal).toBeInstanceOf(AbortSignal);
    const task = h.store.current();
    expect(task).not.toBeNull();
    await h.controller.cancelTask(task!.taskId, 7, {
      load: async () => h.store.current(),
      save: async () => undefined,
      clear: async () => undefined,
    }, true);
    expect(h.inputs[0]?.signal?.aborted).toBe(true);
    resolveReason({ type: "task_complete", text: "too late" });
    await turn;
    // Discarded completely: nothing executed, nothing spoken (silent cancel).
    expect(h.executed).toEqual([]);
    expect(h.spoken).toEqual([]);
    expect(h.stopped).toBeGreaterThanOrEqual(1);
  });
});
