/**
 * AgentController tests with fully fake dependencies (PRD 6.5).
 * State transitions, budgets, ask-user (ordinary + sensitive), confirmation,
 * cancellation, recovery, TTLs, read routing. No chrome, no network.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { AgentController, resolveOpenSiteDestination, type PageSnapshotLike } from "./controller.js";

import type { ReasonInput } from "../../ai/qwen-client.js";
import type { AgentOutcome, ExecutionResult } from "../../../../shared/types.js";
import type { VerifyRequest } from "../../verification/verification-engine.js";
import type { TaskSnapshot } from "../task-state/store.js";

const ITEMS: PageSnapshotLike["items"] = [
  { id: "e1", role: "link", name: "Open form", states: {}, fieldKind: null, sensitive: false },
  { id: "e2", role: "button", name: "Submit Application", states: {}, fieldKind: null, sensitive: false },
  { id: "e3", role: "textbox", name: "Email", states: {}, fieldKind: "email", sensitive: false },
  { id: "e4", role: "textbox", name: "One-time code", states: {}, fieldKind: "text", sensitive: true },
];

const SNAPSHOT: PageSnapshotLike = {
  url: "https://example.com/apply",
  title: "Apply",
  generation: 42,
  items: ITEMS,
};

function okExec(): ExecutionResult {
  return { status: "executed", action: "click", target: "e1", pageGeneration: 42, timestamp: 1 };
}

function okVerify(): {
  success: true;
  outcome: "VERIFIED_SUCCESS";
  expected: unknown;
  observed: null;
  timedOut: false;
  pageGeneration: number;
} {
  return { success: true, outcome: "VERIFIED_SUCCESS", expected: {}, observed: null, timedOut: false, pageGeneration: 42 };
}

interface Harness {
  controller: AgentController;
  spoken: Array<{ text: string; lang: string; priority: number }>;
  saved: TaskSnapshot[];
  current: () => TaskSnapshot | null;
  executed: Array<{ action: string; target?: string; value?: string; url?: string }>;
  reasonCalls: () => number;
  advance: (ms: number) => void;
}

function makeHarness(opts: {
  outcomes?: AgentOutcome[] | ((call: number) => AgentOutcome);
  execute?: (action: { action: string; target?: string; value?: string }) => ExecutionResult | Promise<ExecutionResult>;
  verify?: () => {
    success: boolean;
    outcome: "VERIFIED_SUCCESS" | "VERIFIED_FAILURE" | "STALE_STATE" | "UNKNOWN";
    expected: unknown;
    observed: unknown;
    timedOut: boolean;
    pageGeneration: number;
  };
  nowStart?: number;
  focused?: { text: string; name: string; role: string } | null;
} = {}): Harness {
  let now = opts.nowStart ?? 1_000_000;
  const spoken: Harness["spoken"] = [];
  const saved: TaskSnapshot[] = [];
  let current: TaskSnapshot | null = null;
  const executed: Harness["executed"] = [];
  let reasonCalls = 0;
  const queue = Array.isArray(opts.outcomes) ? [...opts.outcomes] : null;

  const reason = async (_input: ReasonInput): Promise<AgentOutcome> => {
    void _input;
    reasonCalls += 1;
    if (queue !== null) {
      const next = queue.shift();
      if (next === undefined) throw new Error("reason queue empty");
      return next;
    }
    return (opts.outcomes as (call: number) => AgentOutcome)(reasonCalls);
  };

  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason,
    executeFn: async (action) => {
      const params = action.parameters as { url?: unknown } | undefined;
      const url = typeof params?.url === "string" ? params.url : undefined;
      executed.push({
        action: action.action,
        target: action.target,
        value: action.value,
        ...(url !== undefined ? { url } : {}),
      });
      return opts.execute !== undefined
        ? opts.execute({ action: action.action, target: action.target, value: action.value })
        : okExec();
    },
    verifyFn: async (_req: VerifyRequest) => {
      void _req;
      return opts.verify !== undefined ? opts.verify() : okVerify();
    },
    speak: async (text, lang, priority) => {
      spoken.push({ text, lang: String(lang), priority });
    },
    stopAudio: async () => undefined,
    setAgentActive: async () => undefined,
    loadSnapshot: async () => SNAPSHOT,
    loadLayerB: async () => ({
      interpretation: "An application page.",
      pageGeneration: 42,
      producedAt: now,
      provenance: "MODEL_INFERENCE" as const,
    }),
    saveLayerB: async () => undefined,
    readRegionText: async () => "Region text for reading aloud.",
    readFocusedElement: async () => opts.focused ?? null,
    repeatAudio: async () => undefined,
    store: {
      load: async () => current,
      save: async (s) => {
        current = { ...s };
        saved.push({ ...s });
      },
      clear: async () => {
        current = null;
      },
    },
    now: () => now,
  });

  return {
    controller,
    spoken,
    saved,
    current: () => current,
    executed,
    reasonCalls: () => reasonCalls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const voice = (text: string, lang: "en" | "hi" | "mixed" = "en") => ({
  text,
  lang,
  source: "voice" as const,
  timestamp: 1,
});

describe("Q&A and simple action flows", () => {
  it("answers a question and completes", async () => {
    const h = makeHarness({
      outcomes: [{ type: "answer", text: "This page is a form." }],
    });
    await h.controller.routeVoice(voice("What is this page about?"), 7);
    expect(h.spoken[0]?.text).toBe("This page is a form.");
    expect(h.current()?.status).toBe("COMPLETE");
  });

  it("executes a verified action then completes", async () => {
    const h = makeHarness({
      outcomes: [
        {
          type: "action",
          action: { action: "click", target: "e1", pageGeneration: 42 },
        },
        { type: "task_complete", text: "Done." },
      ],
    });
    await h.controller.routeVoice(voice("Open the form."), 7);
    expect(h.executed).toEqual([{ action: "click", target: "e1", value: undefined }]);
    expect(h.current()?.status).toBe("COMPLETE");
    expect(h.current()?.completedActions).toBe(1);
  });

  describe("deterministic open-site navigation", () => {
    it("resolves allowlisted destinations without reasoning", () => {
      expect(resolveOpenSiteDestination("open YouTube")).toBe("https://www.youtube.com/");
      expect(resolveOpenSiteDestination("Go to github.com please")).toBe("https://github.com/");
      expect(resolveOpenSiteDestination("please open www.youtube.com")).toBe(
        "https://www.youtube.com/",
      );
    });

    it("leaves everything else to the model", () => {
      expect(resolveOpenSiteDestination("open the thinking-orbs repository")).toBeNull();
      expect(resolveOpenSiteDestination("search YouTube for cats")).toBeNull();
      expect(resolveOpenSiteDestination("don't open youtube")).toBeNull();
      expect(resolveOpenSiteDestination("open YouTube and find music")).toBeNull();
    });

    it("opens YouTube directly: no reasoning call, no search, no question", async () => {
      const h = makeHarness({
        outcomes: [{ type: "task_complete", text: "Done." }],
      });
      await h.controller.routeVoice(voice("open YouTube"), 7);
      const nav = h.executed.find((e) => e.action === "navigate");
      expect(nav?.url).toBe("https://www.youtube.com/");
      // The only reasoning call is the completion step after navigation.
      expect(h.reasonCalls()).toBe(1);
      expect(h.spoken.some((s) => /which.*url|results/i.test(s.text))).toBe(false);
      expect(h.current()?.status).toBe("COMPLETE");
      expect(h.current()?.completedActions).toBe(1);
    });

    it("opens GitHub directly and never triggers the contributors skill", async () => {
      const h = makeHarness({
        outcomes: [{ type: "task_complete", text: "Done." }],
      });
      await h.controller.routeVoice(voice("open GitHub"), 7);
      const nav = h.executed.find((e) => e.action === "navigate");
      expect(nav?.url).toBe("https://github.com/");
      expect(h.reasonCalls()).toBe(1);
      expect(h.current()?.status).toBe("COMPLETE");
    });

    it("still routes named repositories through the model", async () => {
      const h = makeHarness({
        outcomes: [{ type: "answer", text: "Two great options." }],
      });
      await h.controller.routeVoice(voice("open the thinking-orbs repository"), 7);
      expect(h.executed).toEqual([]);
      expect(h.reasonCalls()).toBe(1);
      expect(h.spoken[0]?.text).toBe("Two great options.");
    });
  });

  it("blocks unsafe verdicts without executing", async () => {
    const h = makeHarness({
      outcomes: [
        {
          type: "action",
          // e2 is a submit control but raw Qwen output lacks confirmation;
          // use an unknown target to force the BLOCK path deterministically.
          action: { action: "click", target: "e99", pageGeneration: 42 },
        },
      ],
    });
    await h.controller.routeVoice(voice("Click it."), 7);
    expect(h.executed.length).toBe(0);
    expect(h.current()?.status).toBe("BLOCKED");
    // An unknown target maps to an honest element-not-found message rather
    // than the alarming generic "blocked for safety" wording.
    expect(h.spoken[0]?.text).toContain("couldn't find that element");
  });
});

describe("ask-user loop", () => {
  it("asks, records an ordinary answer, and continues", async () => {
    const h = makeHarness({
      outcomes: [
        { type: "ask_user", question: "What email?", field: "email", sensitivity: "ordinary" },
        { type: "task_complete", text: "All set." },
      ],
    });
    await h.controller.routeVoice(voice("Fill the form."), 7);
    expect(h.current()?.status).toBe("WAITING_FOR_USER_ANSWER");
    expect(h.spoken[0]?.text).toBe("What email?");
    await h.controller.routeVoice(voice("mehul@example.com"), 7);
    expect(h.current()?.providedValues).toEqual({ email: "mehul@example.com" });
    expect(h.current()?.status).toBe("COMPLETE");
  });

  it("fills secrets without Qwen and never persists them", async () => {
    const h = makeHarness({
      outcomes: [
        { type: "ask_user", question: "What is the code?", field: "One-time code", sensitivity: "high" },
        { type: "task_complete" },
      ],
    });
    await h.controller.routeVoice(voice("Fill the login."), 7);
    expect(h.current()?.status).toBe("WAITING_FOR_USER_ANSWER");
    const reasonBefore = h.reasonCalls();
    await h.controller.routeVoice(voice("483921"), 7);
    // The fill itself used zero model calls (deterministic slot-fill); only the
    // follow-up completion step reasons.
    expect(h.reasonCalls()).toBe(reasonBefore + 1);
    expect(h.executed).toEqual([{ action: "type", target: "e4", value: "483921" }]);
    const allSaved = JSON.stringify(h.saved);
    expect(allSaved).not.toContain("483921");
    expect(h.spoken.map((s) => s.text).join(" ")).not.toContain("483921");
    expect(h.current()?.status).toBe("COMPLETE");
  });

  it("expires stale questions instead of answering them late", async () => {
    const h = makeHarness({
      outcomes: [
        { type: "ask_user", question: "What email?", field: "email", sensitivity: "ordinary" },
        { type: "task_complete" },
      ],
    });
    await h.controller.routeVoice(voice("Fill the form."), 7);
    expect(h.current()?.status).toBe("WAITING_FOR_USER_ANSWER");
    h.advance(91_000); // past the 90s TTL
    await h.controller.routeVoice(voice("mehul@example.com"), 7);
    // Expired: not recorded as the answer; task re-ran to completion.
    expect(h.current()?.providedValues).toEqual({});
    expect(h.current()?.status).toBe("COMPLETE");
  });
});

describe("confirmation flow", () => {
  const submitAction = {
    type: "action" as const,
    action: {
      action: "click" as const,
      target: "e2",
      pageGeneration: 42,
    },
  };

  it("asks, executes on yes, skips on no", async () => {
    const h = makeHarness({ outcomes: [submitAction, { type: "task_complete" }] });
    await h.controller.routeVoice(voice("Submit it."), 7);
    expect(h.current()?.status).toBe("WAITING_FOR_CONFIRMATION");
    expect(h.executed.length).toBe(0);
    await h.controller.routeVoice(voice("yes"), 7);
    expect(h.executed.length).toBe(1);
    expect(h.current()?.status).toBe("COMPLETE");

    const h2 = makeHarness({ outcomes: [submitAction, { type: "task_complete" }] });
    await h2.controller.routeVoice(voice("Submit it."), 7);
    await h2.controller.routeVoice(voice("no"), 7);
    expect(h2.executed.length).toBe(0);
    expect(h2.current()?.status).toBe("COMPLETE");
  });

  it("re-asks once on unclear, then moves on", async () => {
    const h = makeHarness({ outcomes: [submitAction, { type: "task_complete" }] });
    await h.controller.routeVoice(voice("Submit it."), 7);
    await h.controller.routeVoice(voice("maybe"), 7);
    expect(h.current()?.status).toBe("WAITING_FOR_CONFIRMATION");
    expect(h.executed.length).toBe(0);
    await h.controller.routeVoice(voice("erm"), 7);
    expect(h.current()?.status).toBe("COMPLETE");
    expect(h.executed.length).toBe(0);
  });
});

describe("budgets and recovery", () => {
  it("stops at the action budget with LIMIT_REACHED", async () => {
    const h = makeHarness({
      outcomes: () => ({
        type: "action",
        action: { action: "click", target: "e1", pageGeneration: 42 },
      }),
    });
    await h.controller.routeVoice(voice("Keep clicking."), 7);
    expect(h.current()?.completedActions).toBe(25);
    expect(h.current()?.status).toBe("LIMIT_REACHED");
    expect(h.spoken.map((s) => s.text).join(" ")).toContain("limit");
  });

  it("recovers from failures and resets the counter on success", async () => {
    let verifies = 0;
    const h = makeHarness({
      outcomes: [
        { type: "action", action: { action: "click", target: "e1", pageGeneration: 42 } },
        { type: "action", action: { action: "click", target: "e1", pageGeneration: 42 } },
        { type: "action", action: { action: "click", target: "e1", pageGeneration: 42 } },
        { type: "task_complete" },
      ],
      verify: () => {
        verifies += 1;
        if (verifies <= 2) {
          return {
            success: false,
            outcome: "VERIFIED_FAILURE" as const,
            expected: {},
            observed: null,
            timedOut: false,
            pageGeneration: 42,
          };
        }
        return okVerify();
      },
    });
    await h.controller.routeVoice(voice("Open it."), 7);
    expect(h.executed.length).toBe(3);
    expect(h.current()?.status).toBe("COMPLETE");
  });

  it("fails honestly after exhausting recovery", async () => {
    const h = makeHarness({
      outcomes: () => ({
        type: "action",
        action: { action: "click", target: "e1", pageGeneration: 42 },
      }),
      verify: () => ({
        success: false,
        outcome: "VERIFIED_FAILURE" as const,
        expected: {},
        observed: null,
        timedOut: false,
        pageGeneration: 42,
      }),
    });
    await h.controller.routeVoice(voice("Open it."), 7);
    expect(h.executed.length).toBe(4); // 1 + 3 recoveries, never a 5th
    expect(h.current()?.status).toBe("FAILED");
  });
});

describe("cancellation and routing", () => {
  it("cancels mid-run: halts audio, preserves state, runs nothing further", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let executions = 0;
    const h = makeHarness({
      outcomes: [
        { type: "action", action: { action: "click", target: "e1", pageGeneration: 42 } },
      ],
      execute: () => {
        executions += 1;
        return gate.then(() => okExec()) as unknown as ExecutionResult;
      },
    });
    const running = h.controller.routeVoice(voice("Open it."), 7);
    await new Promise((r) => setTimeout(r, 20));
    expect(executions).toBe(1);
    await h.controller.routeVoice(voice("stop"), 7);
    release();
    await running;
    expect(executions).toBe(1);
    expect(h.current()?.status).toBe("CANCELLED");
  });

  it("routes read commands without starting tasks", async () => {
    const h = makeHarness({ outcomes: [] });
    await h.controller.routeVoice(voice("continue"), 7);
    expect(h.current()).toBeNull(); // swallowed: nothing to continue, no task
    expect(h.spoken[0]?.text).toContain("nothing to continue");
  });

  it("answers 'what is this' from the cursor without starting a task", async () => {
    const h = makeHarness({
      outcomes: [],
      focused: { text: "Email", name: "Email", role: "textbox" },
    });
    await h.controller.routeVoice(voice("what is this"), 7);
    expect(h.spoken.map((s) => s.text)).toContain("Email");
    expect(h.reasonCalls()).toBe(0); // no model round-trip
    expect(h.current()).toBeNull(); // no agent task started
  });

  it("answers a repeated 'what is this what is this' from the cursor", async () => {
    const h = makeHarness({
      outcomes: [],
      focused: { text: "Search", name: "Search", role: "searchbox" },
    });
    await h.controller.routeVoice(voice("what is this what is this"), 7);
    expect(h.spoken.map((s) => s.text)).toContain("Search");
    expect(h.reasonCalls()).toBe(0);
  });

  it("says honestly when nothing is in focus", async () => {
    const h = makeHarness({ outcomes: [], focused: null });
    await h.controller.routeVoice(voice("yeh kya hai", "hi"), 7);
    expect(h.spoken[0]?.text).toContain("फ़ोकस");
    expect(h.spoken[0]?.lang).toBe("hi");
    expect(h.reasonCalls()).toBe(0);
  });

  it("types an ordinary answer directly when the field is unambiguous", async () => {
    const h = makeHarness({
      outcomes: [
        { type: "ask_user", question: "What email?", field: "email", sensitivity: "ordinary" },
        { type: "task_complete", text: "Done." },
      ],
    });
    await h.controller.routeVoice(voice("Fill the form."), 7);
    const callsAfterAsk = h.reasonCalls();
    await h.controller.routeVoice(voice("mehul@example.com"), 7);
    // The fill itself spent zero model calls; only the completion step reasoned.
    expect(h.executed).toEqual([{ action: "type", target: "e3", value: "mehul@example.com" }]);
    expect(h.reasonCalls()).toBe(callsAfterAsk + 1);
    expect(h.current()?.status).toBe("COMPLETE");
  });
});
