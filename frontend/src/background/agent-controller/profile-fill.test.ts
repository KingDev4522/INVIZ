/**
 * Saved-details ("My details") fill tests: new tasks pre-seed providedValues
 * from the saved profile so "fill in my details" works without asking.
 * Secrets stay memory-only (unchanged); absent dep keeps previous behavior.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { AgentController, type PageSnapshotLike } from "./controller.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";

const SNAPSHOT: PageSnapshotLike = {
  url: "https://example.com/apply",
  title: "Apply",
  generation: 42,
  items: [
    { id: "e3", role: "textbox", name: "Email", states: {}, fieldKind: "email", sensitive: false },
    { id: "e5", role: "textbox", name: "Full name", states: {}, fieldKind: "text", sensitive: false },
  ],
};

const voice = (text: string) => ({
  text,
  lang: "en" as const,
  source: "voice" as const,
  timestamp: 1,
  turnId: "turn_profile_1",
});

interface Built {
  controller: AgentController;
  typed: Array<{ target?: string; value?: string }>;
  saved: TaskSnapshot[];
}

function build(
  outcomes: AgentOutcome[],
  profile?: Record<string, string>,
): Built {
  const typed: Built["typed"] = [];
  const saved: TaskSnapshot[] = [];
  let current: TaskSnapshot | null = null;
  const queue = [...outcomes];
  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    ...(profile !== undefined ? { loadProfile: async () => profile } : {}),
    reason: async () => {
      const next = queue.shift();
      if (next === undefined) return { type: "task_complete" } as AgentOutcome;
      return next;
    },
    enrich: async () => ({
      interpretation: "An apply page.",
      pageGeneration: 42,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    executeFn: async (action) => {
      typed.push({ target: action.target, value: action.value });
      return { status: "executed", action: action.action, pageGeneration: 42, timestamp: 1 };
    },
    verifyFn: async () => ({
      success: true,
      outcome: "VERIFIED_SUCCESS" as const,
      expected: {},
      observed: null,
      timedOut: false,
      pageGeneration: 42,
    }),
    speak: async () => undefined,
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
        saved.push({ ...s });
      },
      clear: async () => {
        current = null;
      },
    },
  });
  return { controller, typed, saved };
}

describe("saved-details pre-seed", () => {
  it("new tasks start with the saved profile in providedValues", async () => {
    const built = build([{ type: "task_complete" }], {
      name: "Ada",
      email: "ada@example.com",
    });
    await built.controller.routeVoice(voice("fill in my details"), 3);
    expect(built.saved[0]?.providedValues).toEqual({
      name: "Ada",
      email: "ada@example.com",
    });
  });

  it("model types the saved email into the matching field without asking", async () => {
    const built = build(
      [
        {
          type: "action",
          action: {
            action: "type",
            target: "e3",
            pageGeneration: 42,
            value: "ada@example.com",
          },
        },
        { type: "task_complete" },
      ],
      { email: "ada@example.com" },
    );
    await built.controller.routeVoice(voice("enter my email"), 3);
    expect(built.typed.some((t) => t.target === "e3" && t.value === "ada@example.com")).toBe(
      true,
    );
  });

  it("absent profile dep keeps previous behavior (empty providedValues)", async () => {
    const built = build([{ type: "task_complete" }]);
    await built.controller.routeVoice(voice("fill in my details"), 3);
    expect(built.saved[0]?.providedValues).toEqual({});
  });
});
