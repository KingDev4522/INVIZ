/**
 * Episode recording integration tests (Phase 5).
 *
 * Exercises the REAL AgentController → EpisodeRecorder → EpisodeStore path so
 * the wiring (not just the recorder in isolation) is proven: recording is off
 * unless opted in, and an opted-in task produces a redacted episode with its
 * action history and verification results.
 * No chrome, no network; PageState comes from deterministic fixtures.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { AgentController, type PageSnapshotLike } from "../agent-controller/controller.js";
import { evaluate } from "../webguard/policy.js";
import { MemoryEpisodeStore, loadEpisodes } from "../../learning/episode-store.js";
import type { TaskSnapshot } from "../task-state/store.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { ReasonInput } from "../../ai/qwen-client.js";

const PAGE: PageSnapshotLike = {
  url: "https://example.com/form?session_token=abcdef123456",
  title: "Form",
  generation: 3,
  items: [
    { id: "e1", role: "link", name: "More", states: {}, fieldKind: null, sensitive: false },
    {
      id: "e2",
      role: "textbox",
      name: "Nickname",
      states: {},
      fieldKind: "text",
      sensitive: false,
    },
  ],
};

interface H {
  controller: AgentController;
  executed: string[];
  store: MemoryEpisodeStore;
  current: () => TaskSnapshot | null;
}

function build(opts: {
  outcomes: AgentOutcome[];
  store: MemoryEpisodeStore;
  recording?: boolean;
}): H {
  let snapshot = PAGE;
  let current: TaskSnapshot | null = null;
  const executed: string[] = [];
  const queue = [...opts.outcomes];

  const reason = async (_input: ReasonInput): Promise<AgentOutcome> => {
    const next = queue.shift();
    if (next === undefined) throw new Error("reason queue empty");
    return next;
  };

  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason,
    guardEvaluate: (action, ctx) => evaluate(action, ctx),
    executeFn: async (action) => {
      executed.push(`${action.action}:${action.target ?? "-"}`);
      return {
        status: "executed",
        action: action.action,
        target: action.target,
        pageGeneration: snapshot.generation,
        timestamp: 1,
      };
    },
    verifyFn: async () => ({
      success: true,
      outcome: "VERIFIED_SUCCESS",
      expected: {},
      observed: null,
      timedOut: false,
      pageGeneration: snapshot.generation,
    }),
    speak: async () => undefined,
    stopAudio: async () => undefined,
    setAgentActive: async () => undefined,
    loadSnapshot: async () => snapshot,
    loadLayerB: async () => ({
      interpretation: "x",
      pageGeneration: snapshot.generation,
      producedAt: Date.now(),
      provenance: "MODEL_INFERENCE" as const,
    }),
    saveLayerB: async () => undefined,
    readRegionText: async () => "Region text.",
    readFocusedElement: async () => null,
    repeatAudio: async () => undefined,
    ...(opts.recording !== undefined ? { recording: opts.recording } : {}),
    episodeStore: opts.store,
    store: {
      load: async () => current,
      save: async (s) => {
        current = { ...s };
      },
      clear: async () => {
        current = null;
      },
    },
    now: () => Date.now(),
  });

  return {
    controller,
    executed,
    store: opts.store,
    current: () => current,
  };
}

const voice = (text: string) => ({
  text,
  lang: "en" as const,
  source: "voice" as const,
  timestamp: 1,
});

describe("controller episode recording", () => {
  it("1: records nothing when recording is not enabled", async () => {
    const store = new MemoryEpisodeStore();
    const h = build({
      store,
      outcomes: [
        { type: "action", action: { action: "click", target: "e1", pageGeneration: 3 } },
        { type: "task_complete", text: "Done." },
      ],
    });
    await h.controller.routeVoice(voice("click more"), 7);
    expect(h.executed).toEqual(["click:e1"]);
    expect(h.current()?.status).toBe("COMPLETE");
    expect(await store.load()).toBeNull();
  });

  it("3+4+5+6: an opted-in successful task records a full episode", async () => {
    const store = new MemoryEpisodeStore();
    const h = build({
      store,
      recording: true,
      outcomes: [
        { type: "action", action: { action: "click", target: "e1", pageGeneration: 3 } },
        { type: "task_complete", text: "Done." },
      ],
    });
    await h.controller.routeVoice(voice("click more"), 7);
    expect(h.current()?.status).toBe("COMPLETE");

    const { episodes, rejected } = await loadEpisodes(store);
    expect(rejected).toEqual([]);
    expect(episodes.length).toBe(1);
    const episode = episodes[0];
    expect(episode?.success).toBe(true);
    expect(episode?.finalStatus).toBe("COMPLETE");
    expect(episode?.goal).toBe("click more");
    expect(episode?.pageUrl).toBe("https://example.com/form"); // query stripped
    expect(episode?.finalOutcomeType).toBe("task_complete");
    expect(episode?.completedActions).toBeGreaterThanOrEqual(1);
    // Action history with verification info.
    expect(episode?.actions.length).toBeGreaterThanOrEqual(1);
    expect(episode?.actions[0]?.action.action).toBe("click");
    expect(episode?.actions[0]?.status).toBe("executed");
    expect(episode?.actions[0]?.verification?.outcome).toBe("VERIFIED_SUCCESS");
    expect(episode?.pageGenerations).toContain(3);
  });

  it("7+8: a typed value never reaches persistent storage", async () => {
    const store = new MemoryEpisodeStore();
    const h = build({
      store,
      recording: true,
      outcomes: [
        { type: "action", action: { action: "type", target: "e2", value: "hunter2", pageGeneration: 3 } },
        { type: "task_complete", text: "Done." },
      ],
    });
    await h.controller.routeVoice(voice("set the nickname"), 7);
    const raw = (await store.load()) ?? "";
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("[REDACTED]");
    const { episodes } = await loadEpisodes(store);
    expect(episodes[0]?.actions[0]?.action.value).toBe("[REDACTED]");
    expect(episodes[0]?.actions[0]?.action.target).toBe("e2"); // structure kept
  });

  it("records a blocked task without leaking the blocked action value", async () => {
    const store = new MemoryEpisodeStore();
    const h = build({
      store,
      recording: true,
      outcomes: [
        // target e99 is not in the current generation → WebGuard blocks
        { type: "action", action: { action: "click", target: "e99", pageGeneration: 3 } },
        { type: "task_complete" },
      ],
    });
    await h.controller.routeVoice(voice("click the phantom"), 7);
    expect(h.current()?.status).toBe("BLOCKED");
    const { episodes } = await loadEpisodes(store);
    expect(episodes.length).toBe(1);
    expect(episodes[0]?.success).toBe(false);
    expect(episodes[0]?.actions[0]?.status).toBe("blocked");
  });
});
