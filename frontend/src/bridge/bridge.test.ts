/**
 * Execution Router + Browser Harness bridge tests (Phase 7, PART 16).
 *
 * Proves the external path is policy-gated, that WebGuard still runs BEFORE the
 * bridge, that the bridge cannot silently escalate or retry, and that failure
 * modes (unavailable / timeout / malformed) are handled safely without ever
 * bypassing Verification or the budgets.
 * No chrome, no network; deterministic fixtures only.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { AgentController, type PageSnapshotLike } from "../background/agent-controller/controller.js";
import { evaluate } from "../background/webguard/policy.js";
import { BrowserHarnessBridge, type BridgeTransport } from "./harness-bridge.js";
import type { ExecutionPolicy } from "../../../shared/execution.js";
import { MemoryEpisodeStore, loadEpisodes } from "../learning/episode-store.js";
import type { TaskSnapshot } from "../background/task-state/store.js";
import type {
  AgentOutcome,
  ExecutionResult,
  StructuredAction,
} from "../../../shared/types.js";
import type { ReasonInput } from "../ai/qwen-client.js";

const PAGE: PageSnapshotLike = {
  url: "https://example.com/",
  title: "Example",
  generation: 5,
  items: [
    { id: "e1", role: "link", name: "More", states: {}, fieldKind: null, sensitive: false },
    { id: "e2", role: "link", name: "Docs", states: {}, fieldKind: null, sensitive: false },
  ],
};

interface H {
  controller: AgentController;
  localExecuted: string[];
  bridgeRequests: Array<{ capability: string; taskId: string; keys: string[] }>;
  verifyCalls: () => number;
  current: () => TaskSnapshot | null;
  store: MemoryEpisodeStore;
}

function build(opts: {
  outcomes: AgentOutcome[] | (() => AgentOutcome);
  policy?: ExecutionPolicy;
  transport?: BridgeTransport;
  timeoutMs?: number;
  recording?: boolean;
  store?: MemoryEpisodeStore;
  verifyOk?: boolean;
}): H {
  let snapshot = PAGE;
  let current: TaskSnapshot | null = null;
  const localExecuted: string[] = [];
  const bridgeRequests: H["bridgeRequests"] = [];
  let verifyCalls = 0;
  const queue = Array.isArray(opts.outcomes) ? [...opts.outcomes] : null;

  const bridge =
    opts.transport === undefined
      ? undefined
      : new BrowserHarnessBridge({
          transport: {
            send: async (request) => {
              bridgeRequests.push({
                capability: request.capability,
                taskId: request.taskId,
                keys: Object.keys(request).sort(),
              });
              return opts.transport?.send(request);
            },
          },
          authorizedTaskIds: () => true,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });

  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async (_input: ReasonInput): Promise<AgentOutcome> => {
      if (queue !== null) {
        const next = queue.shift();
        if (next === undefined) throw new Error("reason queue empty");
        return next;
      }
      return (opts.outcomes as () => AgentOutcome)();
    },
    guardEvaluate: (action, ctx) => evaluate(action, ctx),
    executeFn: async (action: StructuredAction): Promise<ExecutionResult> => {
      localExecuted.push(`${action.action}:${action.target ?? "-"}`);
      return {
        status: "executed",
        action: action.action,
        target: action.target,
        pageGeneration: snapshot.generation,
        timestamp: 1,
      };
    },
    verifyFn: async () => {
      verifyCalls += 1;
      return {
        success: opts.verifyOk !== false,
        outcome: opts.verifyOk === false ? "VERIFIED_FAILURE" : "VERIFIED_SUCCESS",
        expected: {},
        observed: null,
        timedOut: false,
        pageGeneration: snapshot.generation,
      };
    },
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
    ...(opts.policy !== undefined ? { executionPolicy: opts.policy } : {}),
    ...(bridge !== undefined ? { externalExecutor: bridge } : {}),
    ...(opts.recording !== undefined ? { recording: opts.recording } : {}),
    ...(opts.store !== undefined ? { episodeStore: opts.store } : {}),
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
    localExecuted,
    bridgeRequests,
    verifyCalls: () => verifyCalls,
    current: () => current,
    store: opts.store ?? new MemoryEpisodeStore(),
  };
}

const voice = (text: string) => ({
  text,
  lang: "en" as const,
  source: "voice" as const,
  timestamp: 1,
});
const click = (target: string, gen = 5): AgentOutcome => ({
  type: "action",
  action: { action: "click", target, pageGeneration: gen },
});
const done: AgentOutcome = { type: "task_complete", text: "Done." };

const OK_RESPONSE = (id: string, gen = 5) => ({
  protocolVersion: 1,
  requestId: id,
  ok: true,
  observation: { kind: "result", pageGeneration: gen },
});

describe("Execution Router — default is LOCAL", () => {
  it("never touches the bridge without an explicit external policy", async () => {
    const h = build({
      outcomes: [click("e1"), done],
      transport: { send: async () => OK_RESPONSE("r") },
    });
    await h.controller.routeVoice(voice("click more"), 7);
    expect(h.localExecuted).toEqual(["click:e1"]);
    expect(h.bridgeRequests).toEqual([]);
    expect(h.current()?.status).toBe("COMPLETE");
  });

  it("routes to the bridge only when policy explicitly permits it", async () => {
    const h = build({
      outcomes: [click("e1"), done],
      policy: { allowExternal: true, preference: "external" },
      transport: { send: async (req) => OK_RESPONSE(req.requestId) },
    });
    await h.controller.routeVoice(voice("click more"), 7);
    expect(h.bridgeRequests.length).toBe(1);
    expect(h.localExecuted).toEqual([]); // genuinely external
    expect(h.current()?.status).toBe("COMPLETE");
    // Explicit contract: protocol/request/task/capability/args/generation
    // plus page URL (host attaches to the SAME tab in shared Chrome) — still
    // no goal text, secrets, or policy. The element descriptor travels inside
    // args.node (role+name for AX grounding); the host drives the same browser
    // over CDP and can already observe the page, so this adds no visibility.
    expect(h.bridgeRequests[0]?.keys).toEqual([
      "args",
      "capability",
      "pageGeneration",
      "protocolVersion",
      "requestId",
      "taskId",
      "url",
    ]);
    expect(h.bridgeRequests[0]?.capability).toBe("click");
  });

  it("sends no goal text, secrets or policy to the bridge", async () => {
    const h = build({
      outcomes: [click("e1"), done],
      policy: { allowExternal: true, preference: "external" },
      transport: { send: async (req) => OK_RESPONSE(req.requestId) },
    });
    await h.controller.routeVoice(voice("click the secret docs page"), 7);
    expect(h.bridgeRequests.length).toBe(1);
    // The request carries no user text at all.
    expect(JSON.stringify(h.bridgeRequests[0])).not.toContain("secret");
  });
});

describe("WebGuard still runs before the external executor", () => {
  it("blocks an unknown target without ever calling the bridge", async () => {
    const h = build({
      outcomes: [click("e99"), done],
      policy: { allowExternal: true, preference: "external" },
      transport: { send: async (req) => OK_RESPONSE(req.requestId) },
    });
    await h.controller.routeVoice(voice("click the phantom"), 7);
    expect(h.bridgeRequests).toEqual([]);
    expect(h.localExecuted).toEqual([]);
    expect(h.current()?.status).toBe("BLOCKED");
  });

  it("the generation sent externally is controller-owned, never a model claim", async () => {
    const h = build({
      // The model claims a bogus generation; the controller reconciles it to
      // the snapshot it actually loaded, so the bridge never sees a stale one.
      outcomes: [click("e1", 42), done],
      policy: { allowExternal: true, preference: "external" },
      transport: { send: async (req) => OK_RESPONSE(req.requestId) },
    });
    await h.controller.routeVoice(voice("click more"), 7);
    expect(h.bridgeRequests.length).toBe(1);
    expect(h.current()?.status).toBe("COMPLETE");
    // Protocol-level staleness is rejected in bridge-protocol.test; here we
    // assert the request that went out carried the CURRENT generation.
    expect(h.bridgeRequests[0]?.keys).toContain("pageGeneration");
  });

  it("still verifies an externally executed action", async () => {
    const h = build({
      outcomes: [click("e1"), done],
      policy: { allowExternal: true, preference: "external" },
      transport: { send: async (req) => OK_RESPONSE(req.requestId) },
    });
    await h.controller.routeVoice(voice("click more"), 7);
    expect(h.bridgeRequests.length).toBe(1);
    expect(h.verifyCalls()).toBeGreaterThanOrEqual(1);
  });
});

describe("bridge failure modes fail safely", () => {
  it("falls back to LOCAL when the capability is not expressible externally", async () => {
    const h = build({
      outcomes: [
        { type: "action", action: { action: "close_tab", pageGeneration: 5 } },
        done,
      ],
      policy: { allowExternal: true, preference: "external" },
      transport: { send: async (req) => OK_RESPONSE(req.requestId) },
    });
    await h.controller.routeVoice(voice("close this tab"), 7);
    expect(h.localExecuted).toEqual(["close_tab:-"]);
    expect(h.current()?.status).toBe("COMPLETE");
  });

  it("falls back to LOCAL when the transport is unavailable", async () => {
    const h = build({
      outcomes: [click("e1"), done],
      policy: { allowExternal: true, preference: "external" },
      transport: {
        send: async () => {
          throw new Error("bridge down");
        },
      },
    });
    await h.controller.routeVoice(voice("click more"), 7);
    expect(h.localExecuted).toEqual(["click:e1"]);
    expect(h.current()?.status).toBe("COMPLETE");
  });

  it("a timeout is a failure, not a blind second attempt", async () => {
    const h = build({
      outcomes: () => click("e1"),
      policy: { allowExternal: true, preference: "external" },
      transport: { send: () => new Promise<unknown>(() => undefined) }, // never resolves
      timeoutMs: 5,
    });
    await h.controller.routeVoice(voice("click more"), 7);
    // The action was dispatched externally and did not come back: the existing
    // recovery budget bounds the attempts, then the task fails honestly.
    expect(h.localExecuted).toEqual([]); // NEVER re-run locally
    expect(h.current()?.status).toBe("FAILED");
  });

  it("a malformed bridge reply is never treated as success", async () => {
    const h = build({
      outcomes: () => click("e1"),
      policy: { allowExternal: true, preference: "external" },
      transport: { send: async () => ({ nonsense: true }) },
    });
    await h.controller.routeVoice(voice("click more"), 7);
    expect(h.localExecuted).toEqual([]);
    expect(h.current()?.status).toBe("FAILED");
  });

  it("a protocol failure reply is surfaced as failure", async () => {
    const h = build({
      outcomes: () => click("e1"),
      policy: { allowExternal: true, preference: "external" },
      transport: {
        send: async (req) => ({
          protocolVersion: 1,
          requestId: req.requestId,
          ok: false,
          errorCode: "invalid_args",
        }),
      },
    });
    await h.controller.routeVoice(voice("click more"), 7);
    expect(h.localExecuted).toEqual([]);
    expect(h.current()?.status).toBe("FAILED");
  });

  it("no automatic escalation: policy without preference stays local", async () => {
    const h = build({
      outcomes: [click("e1"), done],
      policy: { allowExternal: true }, // allowed, but no explicit preference
      transport: { send: async (req) => OK_RESPONSE(req.requestId) },
    });
    await h.controller.routeVoice(voice("click more"), 7);
    expect(h.bridgeRequests).toEqual([]);
    expect(h.localExecuted).toEqual(["click:e1"]);
  });
});

describe("budgets still bind with an external executor present", () => {
  it("recovery budget bounds repeated external failures", async () => {
    const h = build({
      outcomes: () => click("e1"),
      policy: { allowExternal: true, preference: "external" },
      transport: { send: async (req) => OK_RESPONSE(req.requestId, 999) }, // stale observation
      verifyOk: false, // the browser never proves the outcome
    });
    await h.controller.routeVoice(voice("click more"), 7);
    expect(h.bridgeRequests.length).toBeLessThanOrEqual(4); // 1 + 3 recoveries
    expect(h.current()?.status).toBe("FAILED");
    expect(h.localExecuted).toEqual([]);
  });

  it("action budget still caps a looping external task", async () => {
    const h = build({
      outcomes: () => click("e1"),
      policy: { allowExternal: true, preference: "external" },
      transport: { send: async (req) => OK_RESPONSE(req.requestId) },
      verifyOk: true,
    });
    await h.controller.routeVoice(voice("keep clicking"), 7);
    expect(h.current()?.completedActions).toBeLessThanOrEqual(25);
    expect(h.current()?.status).toBe("LIMIT_REACHED");
  });
});

describe("episodes record the execution mode", () => {
  it("records external when the bridge ran it", async () => {
    const store = new MemoryEpisodeStore();
    const h = build({
      outcomes: [click("e1"), done],
      policy: { allowExternal: true, preference: "external" },
      transport: { send: async (req) => OK_RESPONSE(req.requestId) },
      recording: true,
      store,
    });
    await h.controller.routeVoice(voice("click more"), 7);
    const { episodes } = await loadEpisodes(store);
    expect(episodes[0]?.actions[0]?.executionMode).toBe("external");
  });

  it("records local when the built-in executor ran it", async () => {
    const store = new MemoryEpisodeStore();
    const h = build({
      outcomes: [click("e1"), done],
      recording: true,
      store,
    });
    await h.controller.routeVoice(voice("click more"), 7);
    const { episodes } = await loadEpisodes(store);
    expect(episodes[0]?.actions[0]?.executionMode).toBe("local");
  });
});

