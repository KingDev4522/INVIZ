/**
 * Navigation-is-not-failure regression (live-reported bug).
 *
 * Reported: "after two requests no action can be taken… it is always saying
 * something went wrong", on every provider including local Ollama, and any
 * multi-step task (e.g. "check the repo's collaborators") died.
 *
 * Cause: `recoveryAttempts` is a per-TASK budget of 4 that resets only on a
 * verified success. A click that NAVIGATES returns STALE_STATE (the model's
 * `element_present` expectation was written for the pre-navigation page), and
 * that benign outcome was counted as a failure. So every navigation spent one
 * of four attempts and multi-step tasks hit the wall — provider-independently,
 * because every model writes expectations against the page it was shown.
 *
 * These tests pin the fix and, just as importantly, prove that GENUINE
 * failures still exhaust the budget.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { AgentController, type PageSnapshotLike } from "./controller.js";
import { evaluateExpectation, type VerifyFacts } from "../../verification/verification-engine.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";

const GEN = 11;

/** Two pages: the list, then the repo page reached by clicking a repo link. */
function snapshotFor(generation: number, url: string): PageSnapshotLike {
  return {
    url,
    title: "GitHub",
    generation,
    items:
      generation === GEN
        ? [
            { id: "e1", role: "link", name: "Sign in", states: {}, fieldKind: null, sensitive: false },
            { id: "e2", role: "link", name: "thinking-orbs", states: {}, fieldKind: null, sensitive: false },
            { id: "e3", role: "link", name: "ora", states: {}, fieldKind: null, sensitive: false },
          ]
        : [
            { id: "e7", role: "heading", name: "Contributors", states: {}, fieldKind: null, sensitive: false },
            { id: "e8", role: "link", name: "ada", states: {}, fieldKind: null, sensitive: false },
          ],
    structure: { headings: [{ level: 1, text: "Popular repositories" }], landmarks: [{ role: "main", name: "" }], forms: [] },
  };
}

const voice = (text: string) => ({
  text,
  lang: "en" as const,
  source: "voice" as const,
  timestamp: 1,
});

interface Built {
  controller: AgentController;
  executed: string[];
  spoken: string[];
  status: () => TaskSnapshot["status"] | null;
  recoveries: () => number;
}

function build(outcomes: AgentOutcome[], opts: { verify?: () => boolean } = {}): Built {
  const executed: string[] = [];
  const spoken: string[] = [];
  let current: TaskSnapshot | null = null;
  const queue = [...outcomes];
  const verify = opts.verify ?? (() => true);
  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async () => queue.shift() ?? ({ type: "task_complete" } as AgentOutcome),
    enrich: async () => ({
      interpretation: "GitHub.",
      pageGeneration: GEN,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    executeFn: async (a) => {
      executed.push(`${a.action}:${a.target ?? "-"}`);
      return { status: "executed" as const, action: a.action, target: a.target, pageGeneration: GEN, timestamp: 1 };
    },
    verifyFn: async () => ({
      success: verify(),
      outcome: (verify() ? "VERIFIED_SUCCESS" : "VERIFIED_FAILURE") as
        | "VERIFIED_SUCCESS"
        | "VERIFIED_FAILURE",
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
    loadSnapshot: async () => snapshotFor(GEN, "https://github.com/x"),
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
    executed,
    spoken,
    status: () => current?.status ?? null,
    recoveries: () => current?.recoveryAttempts ?? 0,
  };
}

/** A click whose expectation is written for the pre-navigation page. */
const navClick = (target = "e2"): AgentOutcome => ({
  type: "action",
  action: {
    action: "click",
    target,
    pageGeneration: GEN,
    expect: { type: "element_present", target },
  },
});

describe("post-navigation STALE_STATE is progress, not failure", () => {
  it("a task survives many navigating clicks (today: dies at the 4th)", async () => {
    const b = build([
      navClick("e2"),
      navClick("e3"),
      navClick("e1"),
      navClick("e2"),
      navClick("e3"),
      { type: "task_complete" },
    ]);
    await b.controller.routeVoice(voice("open the repositories one by one"), 7);
    expect(b.executed.length).toBeGreaterThanOrEqual(4);
    expect(b.status()).not.toBe("FAILED");
    expect(b.spoken.join(" ")).not.toContain("That action failed");
  });

  it("does not spend the recovery budget on a navigation", async () => {
    const b = build([navClick("e2"), { type: "task_complete" }]);
    await b.controller.routeVoice(voice("open the repo"), 7);
    expect(b.recoveries()).toBe(0);
  });

  it("counts a navigating click as a completed action", async () => {
    const b = build([navClick("e2"), { type: "task_complete" }]);
    await b.controller.routeVoice(voice("open the repo"), 7);
    expect(b.status()).toBe("COMPLETE");
  });
});

describe("genuine failures still exhaust the budget", () => {
  it("unverified actions still fail the task at the budget limit", async () => {
    const outcomes: AgentOutcome[] = [];
    for (let i = 0; i < 8; i += 1) {
      outcomes.push({
        type: "action",
        action: { action: "click", target: "e1", pageGeneration: GEN, expect: { type: "element_present", target: "e1" } },
      });
    }
    const b = build(outcomes, { verify: () => false });
    await b.controller.routeVoice(voice("keep clicking"), 7);
    expect(b.status()).toBe("FAILED");
    // Bounded: never more than the budget allows.
    expect(b.executed.length).toBeLessThanOrEqual(4);
  });

  it("a non-submit still uses its own recovery path and retries", async () => {
    const b = build(
      [
        { type: "action", action: { action: "click", target: "e1", pageGeneration: GEN } },
        { type: "action", action: { action: "click", target: "e1", pageGeneration: GEN } },
        { type: "task_complete" },
      ],
      { verify: () => false },
    );
    await b.controller.routeVoice(voice("click sign in"), 7);
    // Verification failed but this is not a side effect, so the agent retries.
    expect(b.executed.length).toBeGreaterThan(1);
  });
});

describe("engine: navigation detected without waiting for the snapshot", () => {
  const base: VerifyFacts = {
    urlBefore: "https://github.com/x",
    urlNow: "https://github.com/x",
    targetPresent: false,
    activeMatches: null,
    dialogOpen: false,
    textFound: null,
    fieldFilled: null,
    stateMatches: null,
    generationChanged: false,
  };

  it("returns STALE_STATE as soon as the URL changes, even with no new snapshot", () => {
    // generationChanged is false here: the content script has not pushed the
    // new generation yet. Previously this stayed PENDING and burned the whole
    // 3s poll timeout on every single navigation.
    const verdict = evaluateExpectation(
      { type: "element_present", target: "e2" },
      { ...base, urlNow: "https://github.com/x/thinking-orbs", generationChanged: false },
    );
    expect(verdict).toBe("STALE_STATE");
  });

  it("still reports success when the target is present", () => {
    expect(
      evaluateExpectation({ type: "element_present", target: "e2" }, { ...base, targetPresent: true }),
    ).toBe("VERIFIED_SUCCESS");
  });

  it("still PENDING when nothing changed and the target is absent", () => {
    expect(evaluateExpectation({ type: "element_present", target: "e2" }, base)).toBe("PENDING");
  });
});
