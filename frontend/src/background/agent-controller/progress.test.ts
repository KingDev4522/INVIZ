/**
 * Agent progress narration tests: the overlay's thinking/awaiting/done states
 * are driven by onProgress events. Advisory-only — task behavior unchanged.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  AgentController,
  type AgentProgressEvent,
  type PageSnapshotLike,
} from "./controller.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";

const SNAPSHOT: PageSnapshotLike = {
  url: "https://example.com/",
  title: "Example",
  generation: 7,
  items: [{ id: "e1", role: "link", name: "More", states: {}, fieldKind: null, sensitive: false }],
};

const voice = (text: string) => ({
  text,
  lang: "en" as const,
  source: "voice" as const,
  timestamp: 1,
  turnId: "turn_test_1",
});

function harness(outcomes: AgentOutcome[]): {
  controller: AgentController;
  events: AgentProgressEvent[];
} {
  const events: AgentProgressEvent[] = [];
  let current: TaskSnapshot | null = null;
  const queue = [...outcomes];
  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async () => {
      const next = queue.shift();
      if (next === undefined) return { type: "task_complete" } as AgentOutcome;
      return next;
    },
    enrich: async () => ({
      interpretation: "An example page.",
      pageGeneration: 7,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    speak: async () => undefined,
    stopAudio: async () => undefined,
    setAgentActive: async () => undefined,
    loadSnapshot: async () => SNAPSHOT,
    loadLayerB: async () => null,
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
    onProgress: (event) => {
      events.push(event);
    },
  });
  return { controller, events };
}

describe("agent progress narration", () => {
  it("emits started → step → done for an answered task", async () => {
    const { controller, events } = harness([{ type: "answer", text: "Here you go." }]);
    await controller.routeVoice(voice("what is this page"), 11);
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("started");
    expect(kinds).toContain("step");
    expect(kinds[kinds.length - 1]).toBe("done");
    expect(events[0]?.turnId).toBe("turn_test_1");
    const done = events[events.length - 1];
    expect(done?.status).toBe("COMPLETE");
  });

  it("emits waiting-answer with the spoken question", async () => {
    const { controller, events } = harness([
      { type: "ask_user", question: "Which size?", field: "size", sensitivity: "ordinary" },
    ]);
    await controller.routeVoice(voice("order a shirt"), 11);
    const waiting = events.find((e) => e.kind === "waiting-answer");
    expect(waiting?.prompt).toBe("Which size?");
    expect(waiting?.turnId).toBe("turn_test_1");
  });

  it("emits waiting-confirm with the confirmation summary", async () => {
    const { controller, events } = harness([
      {
        type: "confirmation_required",
        reason: "needs approval",
        action: { action: "click", target: "e1", pageGeneration: 7 },
      },
    ]);
    await controller.routeVoice(voice("click more"), 11);
    const waiting = events.find((e) => e.kind === "waiting-confirm");
    expect(waiting?.prompt).toContain("click");
  });

  it("stays silent without a listener (optional dep)", async () => {
    let current: TaskSnapshot | null = null;
    const controller = new AgentController({
      backend: { url: "http://127.0.0.1:8787" },
      // Hermetic: inject every outbound dependency. Without these the test
      // would call the REAL backend, so its runtime would depend on whichever
      // reasoning provider is configured (local Ollama inference alone can
      // exceed vitest's 5s default).
      reason: async () => ({ type: "answer", text: "ok" }) as AgentOutcome,
      enrich: async () => ({
        interpretation: "Example page.",
        pageGeneration: 7,
        producedAt: 1,
        provenance: "MODEL_INFERENCE" as const,
      }),
      fetchImpl: (async () => {
        throw new Error("no network in unit tests");
      }) as unknown as typeof fetch,
      speak: async () => undefined,
      loadSnapshot: async () => SNAPSHOT,
      loadLayerB: async () => ({
        interpretation: "cached",
        pageGeneration: 7,
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
    await expect(controller.routeVoice(voice("hi"), 11)).resolves.toBeUndefined();
  });
});
