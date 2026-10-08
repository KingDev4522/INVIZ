/**
 * MCP interface tests (Phase 7, PART 7/8/16).
 * Proves MCP is an OPTIONAL typed capability surface that fails closed on
 * unknown tools/arguments/oversized input, exposes no unsafe capability, and
 * performs actions ONLY through the same trusted path (WebGuard → consent →
 * budgets → executor → verification).
 * No chrome, no network.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { handleMcpRequest, type McpContext } from "./mcp-server.js";
import { MCP_PROTOCOL_VERSION, MCP_TOOLS } from "../../../shared/mcp-protocol.js";
import { MAX_MCP_REQUEST_BYTES } from "../../../shared/execution.js";
import { AgentController, type PageSnapshotLike } from "../background/agent-controller/controller.js";
import { evaluate } from "../background/webguard/policy.js";
import { SkillRegistry } from "../skills/registry.js";
import { registerBuiltinSkills, createBuiltinCatalog } from "../skills/builtin/index.js";
import type { TaskSnapshot } from "../background/task-state/store.js";
import type { AgentOutcome, StructuredAction } from "../../../shared/types.js";
import type { ReasonInput } from "../ai/qwen-client.js";

const PAGE: PageSnapshotLike = {
  url: "https://example.com/",
  title: "Example",
  generation: 5,
  items: [
    { id: "e1", role: "link", name: "More", states: {}, fieldKind: null, sensitive: false },
    { id: "e2", role: "button", name: "Submit Application", states: {}, fieldKind: null, sensitive: false },
    { id: "e3", role: "link", name: "Docs", states: {}, fieldKind: null, sensitive: false },
  ],
  prose: [{ id: "r1", label: "Main", text: "Body text.", chars: 10 }],
};

interface H {
  ctx: McpContext;
  controller: AgentController;
  executed: string[];
  guardCalls: number;
  verifyCalls: () => number;
  task: () => TaskSnapshot | null;
  startTask: (over?: Partial<TaskSnapshot>) => void;
  seedProvided: (values: Record<string, string>) => void;
  setVerifyOk: (ok: boolean) => void;
}

function activeTask(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: "task_mcp_1",
    goal: "do the thing",
    goalLang: "en",
    tabId: 7,
    status: "ACTIVE",
    currentStep: 0,
    completedActions: 0,
    recoveryAttempts: 0,
    qwenCalls: 0,
    startedAt: 1_000_000,
    updatedAt: 1_000_000,
    pendingQuestion: null,
    pendingConfirmation: null,
    lastVerifiedResult: null,
    providedValues: {},
    ...over,
  };
}

function build(
  outcomes: AgentOutcome[] | (() => AgentOutcome) = () => ({ type: "task_complete" }),
): H {
  let snapshot = PAGE;
  let current: TaskSnapshot | null = null;
  const executed: string[] = [];
  let guardCalls = 0;
  let verifyCalls = 0;
  let verifyOk = true;
  const queue = Array.isArray(outcomes) ? [...outcomes] : null;

  const registry = new SkillRegistry();
  registerBuiltinSkills(registry);
  const catalog = createBuiltinCatalog();

  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async (_input: ReasonInput): Promise<AgentOutcome> => {
      if (queue === null) return (outcomes as () => AgentOutcome)();
      const next = queue.shift();
      if (next === undefined) throw new Error("reason queue empty");
      return next;
    },
    guardEvaluate: (action, ctx) => {
      guardCalls += 1;
      return evaluate(action, ctx);
    },
    executeFn: async (action: StructuredAction) => {
      executed.push(`${action.action}:${action.target ?? "-"}`);
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
        success: verifyOk,
        outcome: verifyOk ? "VERIFIED_SUCCESS" : "VERIFIED_FAILURE",
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
    readRegionText: async () => "Region body text.",
    readFocusedElement: async () => null,
    repeatAudio: async () => undefined,
    skillRegistry: registry,
    skillCatalog: catalog,
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

  const ctx: McpContext = {
    registry,
    catalog,
    getTaskState: async () => current,
    getPageState: async () => snapshot,
    readRegion: async () => "Region body text.",
    verify: async (req) => ({
      success: verifyOk,
      outcome: verifyOk ? "VERIFIED_SUCCESS" : "VERIFIED_FAILURE",
      expected: req.expect,
      observed: null,
      timedOut: false,
      pageGeneration: snapshot.generation,
    }),
    executeAllowedAction: (action) => controller.submitAction(action),
  };

  return {
    ctx,
    controller,
    executed,
    get guardCalls() {
      return guardCalls;
    },
    verifyCalls: () => verifyCalls,
    task: () => current,
    startTask: (over = {}) => {
      current = activeTask(over);
    },
    seedProvided: (values) => {
      if (current !== null) current = { ...current, providedValues: { ...values } };
    },
    setVerifyOk: (ok) => {
      verifyOk = ok;
    },
  };
}

/** Seeds TaskState directly: these tests target MCP, not the task lifecycle. */
async function withTask(over: Partial<TaskSnapshot> = {}): Promise<H> {
  const h = build();
  h.startTask(over);
  return h;
}

const req = (over: Record<string, unknown>): Record<string, unknown> => ({
  protocolVersion: MCP_PROTOCOL_VERSION,
  requestId: "m1",
  ...over,
});

describe("MCP — valid tools reuse existing components", () => {
  it("get_task_state returns TaskState but NEVER providedValues", async () => {
    const h = await withTask({ status: "COMPLETE" });
    h.seedProvided({ otp: "123456" });
    const res = await handleMcpRequest(
      req({ tool: "get_task_state" }),
      h.ctx,
    );
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res.result)).not.toContain("123456");
    expect(res.result).toMatchObject({ status: "COMPLETE" });
    expect((res.result as Record<string, unknown>)["providedValues"]).toBeUndefined();
  });

  it("get_page_state returns bounded, structured items", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({ tool: "get_page_state", args: { tabId: 7 } }),
      h.ctx,
    );
    expect(res.ok).toBe(true);
    const result = res.result as { generation: number; items: unknown[] };
    expect(result.generation).toBe(5);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("get_skill_metadata reports trust state, never a procedure body", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({ tool: "get_skill_metadata", args: { skillId: "generic_read_region" } }),
      h.ctx,
    );
    expect(res.ok).toBe(true);
    const result = res.result as Record<string, unknown>;
    expect(result["status"]).toBe("approved");
    expect(result["executable"]).toBe(true);
    expect(result["procedure"]).toBeUndefined();
  });

  it("read_region delegates to the existing region reader", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({ tool: "read_region", args: { tabId: 7, regionId: "r1", maxChars: 50000 } }),
      h.ctx,
    );
    expect(res.ok).toBe(true);
    const result = res.result as { text: string };
    expect(result.text.length).toBeLessThanOrEqual(4000); // bounded
  });
});

describe("MCP — fail closed", () => {
  it("rejects an unknown tool", async () => {
    const h = await withTask();
    for (const tool of ["execute_javascript", "run_shell", "raw_cdp", "fs_write"]) {
      const res = await handleMcpRequest(req({ tool }), h.ctx);
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe("unknown_tool");
    }
  });

  it("rejects malformed requests", async () => {
    const h = await withTask();
    for (const raw of [null, "x", 42, [], { protocolVersion: 999, requestId: "m", tool: "get_task_state" }]) {
      const res = await handleMcpRequest(raw, h.ctx);
      expect(res.ok).toBe(false);
    }
  });

  it("rejects an unexpected top-level field", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({ tool: "get_task_state", extra: "nope" }),
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("malformed");
  });

  it("rejects an unknown argument for a known tool", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({ tool: "get_task_state", args: { injected: true } }),
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("unknown_argument");
  });

  it("rejects oversized requests and oversized string arguments", async () => {
    const h = await withTask();
    const oversized = await handleMcpRequest(
      req({ tool: "read_region", args: { tabId: 7, regionId: "r1", pad: "x".repeat(MAX_MCP_REQUEST_BYTES) } }),
      h.ctx,
    );
    expect(oversized.ok).toBe(false);
    expect(oversized.errorCode).toBe("oversized");

    const longString = await handleMcpRequest(
      req({ tool: "find_element", args: { tabId: 7, name: "n".repeat(5000) } }),
      h.ctx,
    );
    expect(longString.ok).toBe(false);
    expect(longString.errorCode).toBe("oversized");
  });

  it("exposes only the documented safe tool set", () => {
    expect([...MCP_TOOLS].sort()).toEqual(
      [
        "execute_allowed_action",
        "find_element",
        "get_page_state",
        "get_skill_metadata",
        "get_task_state",
        "read_region",
        "verify_result",
      ].sort(),
    );
    for (const forbidden of [
      "execute_javascript",
      "eval",
      "shell",
      "filesystem",
      "raw_cdp",
      "get_credentials",
      "modify_webguard",
      "modify_verification",
    ]) {
      expect(MCP_TOOLS as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe("MCP — execute_allowed_action uses the trusted path", () => {
  it("rejects an invalid StructuredAction without executing anything", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({ tool: "execute_allowed_action", args: { action: { action: "click" } } }),
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("invalid_arguments");
    expect(h.executed).toEqual([]);
  });

  it("rejects an unsafe verb at the schema gate", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({
        tool: "execute_allowed_action",
        args: { action: { action: "eval", target: "e1" } },
      }),
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("invalid_arguments");
    expect(h.executed).toEqual([]);
  });

  it("WebGuard rejection is reported as policy_rejected, nothing runs", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({
        tool: "execute_allowed_action",
        args: { action: { action: "click", target: "e99", pageGeneration: 5 } },
      }),
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("policy_rejected");
    expect(res.detail).toContain("blocked_by_policy");
    expect(h.executed).toEqual([]);
    expect(h.guardCalls).toBeGreaterThanOrEqual(1);
  });

  it("consent is still required: a submit returns consent_required and does not run", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({
        tool: "execute_allowed_action",
        args: { action: { action: "click", target: "e2", pageGeneration: 5 } },
      }),
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("consent_required");
    expect(h.executed).toEqual([]);
    expect(h.task()?.status).toBe("WAITING_FOR_CONFIRMATION");
  });

  it("a valid action executes exactly once through WebGuard + verification", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({
        tool: "execute_allowed_action",
        args: { action: { action: "click", target: "e1", pageGeneration: 5 } },
      }),
      h.ctx,
    );
    expect(res.ok).toBe(true);
    expect(h.executed).toEqual(["click:e1"]);
    expect(h.guardCalls).toBeGreaterThanOrEqual(1);
    expect(h.verifyCalls()).toBeGreaterThanOrEqual(1);
  });

  it("refuses when no task is active", async () => {
    const h = build(); // no startTask → no active task
    const res = await handleMcpRequest(
      req({
        tool: "execute_allowed_action",
        args: { action: { action: "click", target: "e1", pageGeneration: 5 } },
      }),
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("policy_rejected");
    expect(res.detail).toContain("no_active_task");
    expect(h.executed).toEqual([]);
  });});

describe("MCP — verification remains the source of truth", () => {
  it("verify_result reports a failed observation honestly", async () => {
    const h = await withTask();
    h.setVerifyOk(false);
    const res = await handleMcpRequest(
      req({ tool: "verify_result", args: { tabId: 7, expect: { type: "element_present", target: "e1" } } }),
      h.ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ success: false, outcome: "VERIFIED_FAILURE" });
  });

  it("rejects an unknown expectation type", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({ tool: "verify_result", args: { tabId: 7, expect: { type: "always_pass" } } }),
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("invalid_arguments");
  });
});

describe("MCP — find_element reuses the skill plan gate", () => {
  it("finds an element through the registered built-in resolver", async () => {
    const h = await withTask();
    const res = await handleMcpRequest(
      req({ tool: "find_element", args: { tabId: 7, name: "Docs" } }),
      h.ctx,
    );
    expect(res.ok).toBe(true);
    expect((res.result as { targetId: string | null }).targetId).toBe("e3");
  });

  it("fails closed when the skill is disabled", async () => {
    const h = await withTask();
    h.ctx.registry.setStatus("generic_find_element", "disabled");
    const res = await handleMcpRequest(
      req({ tool: "find_element", args: { tabId: 7, name: "Docs" } }),
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("policy_rejected");
    h.ctx.registry.setStatus("generic_find_element", "candidate"); // restore path sanity
  });
});
