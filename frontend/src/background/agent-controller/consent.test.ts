/**
 * Confirmation-consent regression (live-reported bug).
 *
 * Reported: "I explicitly said yes, and it kept asking me to say yes to
 * continue" — the user was trapped answering yes to the SAME submit/save
 * question until the recovery budget ran out, and the action never ran.
 *
 * Cause: the user's "yes" was applied to exactly ONE doAction call and then
 * forgotten. The agent's next step re-proposed the same submit click (which it
 * does whenever verification is inconclusive), WebGuard demanded confirmation
 * again, and the loop repeated.
 *
 * These tests pin the fix: consent is remembered per task for the exact action
 * signature, and it is forgotten when it should be.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { AgentController, approvalSignature, type PageSnapshotLike } from "./controller.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";

const SUBMIT_ID = "e9";

const SNAPSHOT: PageSnapshotLike = {
  url: "https://devfolio.co/apply",
  title: "Hackathon Application",
  generation: 42,
  items: [
    { id: "e1", role: "textbox", name: "Referral Code", states: {}, fieldKind: "text", sensitive: false },
    {
      id: SUBMIT_ID,
      role: "button",
      name: "Submit Application",
      states: {},
      fieldKind: null,
      sensitive: false,
    },
  ],
};

const voice = (text: string) => ({
  text,
  lang: "en" as const,
  source: "voice" as const,
  timestamp: 1,
});

interface Built {
  controller: AgentController;
  spoken: string[];
  executed: string[];
  confirmPrompts: number;
  status: () => TaskSnapshot["status"] | null;
}

function build(opts: {
  outcomes: AgentOutcome[];
  /** Verification result for every executed action. */
  verifySuccess?: boolean;
}): Built {
  const spoken: string[] = [];
  const executed: string[] = [];
  let current: TaskSnapshot | null = null;
  let confirmPrompts = 0;
  const queue = [...opts.outcomes];
  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async () => {
      const next = queue.shift();
      // Once the queue drains, stop re-proposing: the test asserts on the
      // number of confirmations asked, not on infinite model output.
      return next ?? ({ type: "task_complete" } as AgentOutcome);
    },
    enrich: async () => ({
      interpretation: "An application form.",
      pageGeneration: 42,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    executeFn: async (action) => {
      executed.push(action.target ?? action.action);
      return { status: "executed" as const, action: action.action, target: action.target, pageGeneration: 42, timestamp: 1 };
    },
    verifyFn: async () => ({
      success: opts.verifySuccess ?? true,
      outcome: (opts.verifySuccess ?? true ? "VERIFIED_SUCCESS" : "VERIFIED_FAILURE") as
        | "VERIFIED_SUCCESS"
        | "VERIFIED_FAILURE",
      expected: {},
      observed: null,
      timedOut: false,
      pageGeneration: 42,
    }),
    speak: async (text) => {
      spoken.push(text);
      if (/approval|say yes|हाँ कहें/i.test(text)) confirmPrompts += 1;
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
  return {
    controller,
    spoken,
    executed,
    get confirmPrompts() {
      return confirmPrompts;
    },
    status: () => current?.status ?? null,
  };
}

const submitClick = (): AgentOutcome => ({
  type: "action",
  action: { action: "click", target: SUBMIT_ID, pageGeneration: 42 },
});

describe("approvalSignature", () => {
  it("ignores volatile fields but pins target/value/url", () => {
    const a = approvalSignature({ action: "click", target: "e9", pageGeneration: 1, timeout_ms: 3000 });
    const b = approvalSignature({ action: "click", target: "e9", pageGeneration: 99, timeout_ms: 9000 });
    expect(a).toBe(b); // re-render must not look like a new action
    expect(approvalSignature({ action: "click", target: "e8" })).not.toBe(a);
    expect(
      approvalSignature({ action: "type", target: "e1", value: "A" }) !==
        approvalSignature({ action: "type", target: "e1", value: "B" }),
    ).toBe(true);
    expect(
      approvalSignature({ action: "navigate", parameters: { url: "https://a.example" } }) !==
        approvalSignature({ action: "navigate", parameters: { url: "https://b.example" } }),
    ).toBe(true);
  });
});

describe("confirmation consent is remembered (the reported bug)", () => {
  it("asks once, then completes after a single yes", async () => {
    const b = build({ outcomes: [submitClick(), { type: "task_complete" }] });
    await b.controller.routeVoice(voice("submit the application"), 7);
    expect(b.status()).toBe("WAITING_FOR_CONFIRMATION");
    expect(b.confirmPrompts).toBe(1);

    await b.controller.routeVoice(voice("yes"), 7);
    expect(b.executed).toEqual([SUBMIT_ID]);
  });

  it("does NOT re-ask when the same submit is re-proposed after a failed verification", async () => {
    // Two guarantees meet here:
    //  (a) the approval ledger — the user is asked exactly ONCE, even though the
    //      agent re-proposes the same submit click;
    //  (b) the submit-safety rule — an unprovable non-idempotent side effect is
    //      never re-executed, so consent is never even consumed a second time.
    // Previously this test asserted repeated execution; the side-effect guard
    // intentionally tightened that to a single click.
    const b = build({
      outcomes: [submitClick(), submitClick(), submitClick(), submitClick()],
      verifySuccess: false,
    });
    await b.controller.routeVoice(voice("submit the application"), 7);
    expect(b.confirmPrompts).toBe(1);

    await b.controller.routeVoice(voice("yes"), 7);
    expect(b.confirmPrompts).toBe(1); // never re-asked
    expect(b.executed).toEqual([SUBMIT_ID]); // and never clicked again
  });

  it("honours consent when the model itself re-wraps the action in confirmation_required", async () => {
    const b = build({
      outcomes: [
        submitClick(),
        { type: "confirmation_required", reason: "consequential", action: { action: "click", target: SUBMIT_ID, pageGeneration: 42 } },
        { type: "task_complete" },
      ],
    });
    await b.controller.routeVoice(voice("submit the application"), 7);
    await b.controller.routeVoice(voice("yes"), 7);
    expect(b.confirmPrompts).toBe(1);
    expect(b.executed.filter((t) => t === SUBMIT_ID).length).toBe(2);
  });

  it("still asks for a DIFFERENT submit target (consent is not blanket)", async () => {
    const other = "e10";
    const b = build({
      outcomes: [
        submitClick(),
        {
          type: "action",
          action: { action: "click", target: other, pageGeneration: 42 },
        },
        { type: "task_complete" },
      ],
    });
    // Registry does not contain e10, so this is a BLOCK (not a re-ask) — the
    // point of the test is that consent did not silently extend to it.
    await b.controller.routeVoice(voice("submit the application"), 7);
    await b.controller.routeVoice(voice("yes"), 7);
    expect(b.executed).not.toContain(other);
  });
});
