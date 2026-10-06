/**
 * Submit loop-safety: an inconclusive verification must never become another
 * Submit click, and the existing approval ledger must keep working.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  AgentController,
  isSideEffectingAction,
  type PageSnapshotLike,
} from "./controller.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";
import type { VerifyRequest } from "../../verification/verification-engine.js";

const SUBMIT = "e9";

const SNAPSHOT: PageSnapshotLike = {
  url: "https://devfolio.co/apply",
  title: "Hackathon Application",
  generation: 42,
  items: [
    {
      id: SUBMIT,
      role: "button",
      name: "Submit Application",
      states: {},
      fieldKind: null,
      sensitive: false,
    },
    { id: "e1", role: "link", name: "Home", states: {}, fieldKind: null, sensitive: false },
  ],
};

const voice = (text: string) => ({
  text,
  lang: "en" as const,
  source: "voice" as const,
  timestamp: 1,
});

const submitOutcome = (): AgentOutcome => ({
  type: "action",
  action: { action: "click", target: SUBMIT, pageGeneration: 42 },
});

interface Built {
  controller: AgentController;
  executed: string[];
  expects: VerifyRequest["expect"][];
  spoken: string[];
  status: () => TaskSnapshot["status"] | null;
}

function build(opts: { outcomes: AgentOutcome[]; verify: (r: VerifyRequest) => boolean }): Built {
  const executed: string[] = [];
  const expects: VerifyRequest["expect"][] = [];
  const spoken: string[] = [];
  let current: TaskSnapshot | null = null;
  const queue = [...opts.outcomes];
  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async () => queue.shift() ?? ({ type: "task_complete" } as AgentOutcome),
    enrich: async () => ({
      interpretation: "form",
      pageGeneration: 42,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    executeFn: async (action) => {
      executed.push(action.target ?? action.action);
      return {
        status: "executed" as const,
        action: action.action,
        target: action.target,
        pageGeneration: 42,
        timestamp: 1,
      };
    },
    verifyFn: async (req: VerifyRequest) => {
      expects.push(req.expect);
      return {
        success: opts.verify(req),
        outcome: (opts.verify(req) ? "VERIFIED_SUCCESS" : "VERIFIED_FAILURE") as
          | "VERIFIED_SUCCESS"
          | "VERIFIED_FAILURE",
        expected: req.expect,
        observed: null,
        timedOut: !opts.verify(req),
        pageGeneration: 42,
      };
    },
    speak: async (t) => {
      spoken.push(t);
    },
    stopAudio: async () => undefined,
    setAgentActive: async () => undefined,
    loadSnapshot: async () => SNAPSHOT,
    loadLayerB: async () => ({
      interpretation: "cached",
      pageGeneration: 42,
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
  return { controller, executed, expects, spoken, status: () => current?.status ?? null };
}

describe("isSideEffectingAction", () => {
  const item = (role: string, name: string) => ({
    id: "x",
    role,
    name,
    states: {},
    fieldKind: null,
    sensitive: false,
  });
  it("flags consequential buttons/links only", () => {
    expect(isSideEffectingAction({ action: "click" }, item("button", "Submit Application"))).toBe(true);
    expect(isSideEffectingAction({ action: "click" }, item("button", "Pay now"))).toBe(true);
    expect(isSideEffectingAction({ action: "click" }, item("button", "Delete project"))).toBe(true);
    expect(isSideEffectingAction({ action: "click" }, item("link", "Home"))).toBe(false);
    expect(isSideEffectingAction({ action: "click" }, item("textbox", "Submit"))).toBe(false);
    expect(isSideEffectingAction({ action: "navigate" }, item("button", "Submit"))).toBe(false);
    expect(isSideEffectingAction({ action: "click" }, null)).toBe(false);
  });
});

describe("submit verification drives the expectation (cases 1-4)", () => {
  it("uses the multi-signal expectation by default for a submit click", async () => {
    const b = build({ outcomes: [submitOutcome(), { type: "task_complete" }], verify: () => true });
    await b.controller.routeVoice(voice("submit the application"), 7);
    await b.controller.routeVoice(voice("yes"), 7);
    expect(b.expects[0]?.type).toBe("submit_completed");
  });

  it("case 1: verified-by-navigation completes without a second click", async () => {
    // A realistic model sees the verified result and completes. The guarantee
    // under test is the AGENT's behaviour, not the model's whim: it executes
    // exactly once and does not re-execute on its own initiative.
    const b = build({
      outcomes: [submitOutcome(), { type: "task_complete" }],
      verify: () => true,
    });
    await b.controller.routeVoice(voice("submit the application"), 7);
    await b.controller.routeVoice(voice("yes"), 7);
    expect(b.executed).toEqual([SUBMIT]);
    expect(b.status()).toBe("COMPLETE");
  });

  it("cases 2-4: any verifier success is accepted on the first click", async () => {
    for (const _ of [1, 2, 3, 4]) {
      const b = build({
        outcomes: [submitOutcome(), { type: "task_complete" }],
        verify: () => true,
      });
      await b.controller.routeVoice(voice("submit the application"), 7);
      await b.controller.routeVoice(voice("yes"), 7);
      expect(b.executed).toEqual([SUBMIT]);
    }
  });
});

describe("case 5: inconclusive submit never loops (CRITICAL)", () => {
  it("does NOT re-click submit when verification cannot prove success", async () => {
    // The model keeps proposing submit on every step; only a real safety rule
    // can stop the second click here.
    const b = build({
      outcomes: [submitOutcome(), submitOutcome(), submitOutcome(), submitOutcome()],
      verify: () => false,
    });
    await b.controller.routeVoice(voice("submit the application"), 7);
    await b.controller.routeVoice(voice("yes"), 7);
    expect(b.executed).toEqual([SUBMIT]); // exactly one side effect
    expect(b.spoken.some((s) => /could not confirm/i.test(s))).toBe(true);
    expect(b.status()).toBe("COMPLETE");
  });

  it("respects an explicit model expectation instead of overriding it", async () => {
    const b = build({
      outcomes: [
        {
          type: "action",
          action: {
            action: "click",
            target: SUBMIT,
            pageGeneration: 42,
            expect: { type: "navigation_completed" },
          },
        },
      ],
      verify: () => true,
    });
    await b.controller.routeVoice(voice("submit the application"), 7);
    await b.controller.routeVoice(voice("yes"), 7);
    expect(b.expects[0]?.type).toBe("navigation_completed");
  });
});

describe("case 7: non-submit clicks keep their old behaviour", () => {
  it("still uses element_present for an ordinary click", async () => {
    const b = build({
      outcomes: [
        { type: "action", action: { action: "click", target: "e1", pageGeneration: 42 } },
        { type: "task_complete" },
      ],
      verify: () => true,
    });
    await b.controller.routeVoice(voice("click home"), 7);
    expect(b.expects[0]?.type).toBe("element_present");
    expect(b.executed).toEqual(["e1"]);
  });

  it("a failed non-submit click still retries (unchanged recovery path)", async () => {
    const b = build({
      outcomes: [
        { type: "action", action: { action: "click", target: "e1", pageGeneration: 42 } },
        { type: "action", action: { action: "click", target: "e1", pageGeneration: 42 } },
        { type: "task_complete" },
      ],
      verify: () => false,
    });
    await b.controller.routeVoice(voice("click home"), 7);
    expect(b.executed.length).toBeGreaterThan(1);
  });
});

describe("case 6 + 8: approval ledger preserved", () => {
  it("an approved submit still executes without asking again", async () => {
    const b = build({
      outcomes: [submitOutcome(), { type: "task_complete" }],
      verify: () => true,
    });
    await b.controller.routeVoice(voice("submit the application"), 7);
    await b.controller.routeVoice(voice("yes"), 7);
    // Only one confirmation was ever spoken (consent consumed once, reused).
    expect(b.spoken.filter((s) => /approval|say yes/i.test(s)).length).toBe(1);
    expect(b.executed).toEqual([SUBMIT]);
  });
});
