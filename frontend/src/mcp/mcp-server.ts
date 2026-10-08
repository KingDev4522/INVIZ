/**
 * MCP-style typed interface — REAL (Phase 7, OPTIONAL).
 *
 * A thin, fail-closed adapter over capabilities INVIZ already owns. It exposes
 * SAFE typed tools only, and every tool reuses an existing trusted component:
 *
 *   get_page_state       → the same compact PageState skills/model consume
 *   get_task_state       → TaskState (memory-only `providedValues` stripped)
 *   read_region          → the existing content-script region reader
 *   find_element         → planSkill() with the built-in generic_find_element
 *   execute_allowed_action → AgentController.submitAction(): the SAME
 *                            StructuredAction → WebGuard → consent → budgets →
 *                            executor → verification path the model uses
 *   verify_result        → the existing Verification Engine
 *   get_skill_metadata   → the Skill Registry
 *
 * Explicitly NOT exposed: raw CDP, execute_javascript, shell, filesystem,
 * credentials, arbitrary network requests, or any mutation of WebGuard,
 * Verification or trust policy.
 */
import {
  MCP_PROTOCOL_VERSION,
  MCP_TOOL_ARGS,
  mcpError,
  validateMcpRequest,
  type McpResponse,
  type McpTool,
} from "../../../shared/mcp-protocol.js";
import { MAX_MCP_RESULT_ITEMS } from "../../../shared/execution.js";
import {
  EXPECTATION_TYPES,
  validateStructuredAction,
  type Expectation,
  type StructuredAction,
  type VerificationResult,
} from "../../../shared/types.js";
import type { SkillSummary } from "../../../shared/types.js";
import type { TaskSnapshot } from "../background/task-state/store.js";
import type { SkillPageSnapshot } from "../skills/plan.js";
import { planSkill } from "../skills/plan.js";
import type { SkillCatalog } from "../skills/plan.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { VerifyRequest } from "../verification/verification-engine.js";

const DEFAULT_REGION_CHARS = 4000;
const MIN_REGION_CHARS = 100;
const MAX_REGION_CHARS = 4000;
const MAX_VERIFY_TIMEOUT_MS = 6000;

export interface McpContext {
  registry: SkillRegistry;
  catalog: SkillCatalog;
  getTaskState: () => Promise<TaskSnapshot | null>;
  getPageState: (tabId: number) => Promise<SkillPageSnapshot | null>;
  readRegion: (tabId: number, regionId: string | undefined, maxChars: number) => Promise<string>;
  verify: (req: VerifyRequest) => Promise<VerificationResult>;
  /**
   * Delegates to the AgentController's trusted dispatch: WebGuard, consent,
   * action/recovery budgets and verification all still apply.
   */
  executeAllowedAction: (
    action: StructuredAction,
  ) => Promise<{ ok: boolean; reason?: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function ok(requestId: string, result: unknown): McpResponse {
  return { protocolVersion: MCP_PROTOCOL_VERSION, requestId, ok: true, result };
}

/** Each tool: bounded validation + reuse of one existing trusted component. */
const HANDLERS: Record<McpTool, (req: { requestId: string; args: Record<string, unknown>; ctx: McpContext }) => Promise<McpResponse>> = {
  get_page_state: async ({ requestId, args, ctx }) => {
    const tabId = numArg(args, "tabId", -1);
    if (!Number.isInteger(tabId) || tabId < 0) {
      return mcpError(requestId, "invalid_arguments", "tabId must be a non-negative integer");
    }
    const snapshot = await ctx.getPageState(tabId);
    if (snapshot === null) {
      return mcpError(requestId, "unavailable", "no page state for tab");
    }
    return ok(requestId, {
      url: snapshot.url,
      title: snapshot.title,
      generation: snapshot.generation,
      items: (snapshot.items ?? [])
        .slice(0, MAX_MCP_RESULT_ITEMS)
        .map((item) => ({
          id: item.id,
          role: item.role,
          name: item.name,
          fieldKind: item.fieldKind ?? null,
        })),
      prose: (snapshot.prose ?? [])
        .slice(0, MAX_MCP_RESULT_ITEMS)
        .map((p) => ({ id: p.id, label: p.label, chars: p.chars })),
      structure:
        snapshot.structure === undefined
          ? null
          : {
              headings: snapshot.structure.headings.slice(0, MAX_MCP_RESULT_ITEMS),
              landmarks: snapshot.structure.landmarks.slice(0, MAX_MCP_RESULT_ITEMS),
              forms: snapshot.structure.forms.slice(0, MAX_MCP_RESULT_ITEMS),
              openDialogs: snapshot.structure.openDialogs ?? 0,
            },
    });
  },

  get_task_state: async ({ requestId, ctx }) => {
    const task = await ctx.getTaskState();
    if (task === null) return mcpError(requestId, "unavailable", "no active task");
    // memory-only rule (PRD 6 §6): providedValues NEVER leaves the controller.
    return ok(requestId, {
      taskId: task.taskId,
      goal: task.goal,
      goalLang: task.goalLang,
      status: task.status,
      currentStep: task.currentStep,
      completedActions: task.completedActions,
      recoveryAttempts: task.recoveryAttempts,
      qwenCalls: task.qwenCalls,
      lastVerifiedResult: task.lastVerifiedResult,
      startedAt: task.startedAt,
      updatedAt: task.updatedAt,
    });
  },

  read_region: async ({ requestId, args, ctx }) => {
    const tabId = numArg(args, "tabId", -1);
    const regionId = strArg(args, "regionId");
    if (!Number.isInteger(tabId) || tabId < 0 || regionId === undefined) {
      return mcpError(requestId, "invalid_arguments", "tabId and regionId are required");
    }
    if (!/^r\d+$/.test(regionId)) {
      return mcpError(requestId, "invalid_arguments", "regionId must be a prose region handle");
    }
    const bounded = Math.min(
      MAX_REGION_CHARS,
      Math.max(MIN_REGION_CHARS, Math.floor(numArg(args, "maxChars", DEFAULT_REGION_CHARS))),
    );
    try {
      const text = await ctx.readRegion(tabId, regionId, bounded);
      return ok(requestId, { regionId, chars: text.length, text: text.slice(0, bounded) });
    } catch {
      return mcpError(requestId, "unavailable", "region read failed");
    }
  },

  find_element: async ({ requestId, args, ctx }) => {
    const tabId = numArg(args, "tabId", -1);
    const name = strArg(args, "name");
    if (!Number.isInteger(tabId) || tabId < 0 || name === undefined || name.trim() === "") {
      return mcpError(requestId, "invalid_arguments", "tabId and name are required");
    }
    const snapshot = await ctx.getPageState(tabId);
    if (snapshot === null) return mcpError(requestId, "unavailable", "no page state for tab");
    // Reuses the built-in resolver through the SAME fail-closed plan gate.
    const plan = planSkill({
      registry: ctx.registry,
      catalog: ctx.catalog,
      skillId: "generic_find_element",
      snapshot,
      inputs: {
        name,
        ...(strArg(args, "role") !== undefined ? { role: strArg(args, "role") as string } : {}),
      },
    });
    if (plan.status !== "ready") {
      return mcpError(
        requestId,
        plan.status === "not_executable" || plan.status === "unknown_skill"
          ? "policy_rejected"
          : "unavailable",
        plan.reason ?? plan.status,
      );
    }
    return ok(requestId, {
      targetId: plan.result.targetId ?? null,
      candidates: (plan.result.candidates ?? []).slice(0, MAX_MCP_RESULT_ITEMS),
      note: plan.result.note ?? null,
      pageGeneration: plan.pageGeneration,
    });
  },

  execute_allowed_action: async ({ requestId, args, ctx }) => {
    const raw = args["action"];
    if (!isRecord(raw)) {
      return mcpError(requestId, "invalid_arguments", "action must be an object");
    }
    const checked = validateStructuredAction(raw);
    if (!checked.ok) {
      return mcpError(requestId, "invalid_arguments", checked.errors.join("; "));
    }
    const outcome = await ctx.executeAllowedAction(raw as unknown as StructuredAction);
    if (!outcome.ok) {
      return mcpError(requestId, "policy_rejected", outcome.reason ?? "rejected by policy");
    }
    return ok(requestId, { accepted: true });
  },

  verify_result: async ({ requestId, args, ctx }) => {
    const tabId = numArg(args, "tabId", -1);
    const expect = args["expect"];
    if (!Number.isInteger(tabId) || tabId < 0 || !isRecord(expect)) {
      return mcpError(requestId, "invalid_arguments", "tabId and expect are required");
    }
    const type = expect["type"];
    if (typeof type !== "string" || !EXPECTATION_TYPES.includes(type as Expectation["type"])) {
      return mcpError(requestId, "invalid_arguments", "unknown expectation type");
    }
    const snapshot = await ctx.getPageState(tabId);
    if (snapshot === null) return mcpError(requestId, "unavailable", "no page state for tab");
    const req: VerifyRequest = {
      tabId,
      expect: expect as unknown as Expectation,
      identity: null,
      urlBefore: snapshot.url,
      actionGeneration: snapshot.generation,
      timeoutMs: Math.min(MAX_VERIFY_TIMEOUT_MS, Math.max(250, numArg(args, "timeoutMs", 3000))),
    };
    try {
      const result = await ctx.verify(req);
      return ok(requestId, {
        success: result.success,
        outcome: result.outcome,
        timedOut: result.timedOut,
        pageGeneration: result.pageGeneration,
      });
    } catch {
      return mcpError(requestId, "unavailable", "verification unavailable");
    }
  },

  get_skill_metadata: async ({ requestId, args, ctx }) => {
    const skillId = strArg(args, "skillId");
    if (skillId === undefined) {
      return ok(requestId, {
        skills: ctx.registry
          .discover()
          .slice(0, MAX_MCP_RESULT_ITEMS)
          .map((s: SkillSummary) => toSummary(ctx, s)),
      });
    }
    const skill = ctx.registry.get(skillId);
    if (skill === null) return mcpError(requestId, "unavailable", "unknown skill");
    return ok(requestId, {
      id: skill.id,
      namespace: skill.namespace,
      name: skill.name,
      version: skill.version,
      description: skill.description,
      status: skill.status,
      testStatus: skill.testStatus,
      supportedIntents: skill.supportedIntents.slice(0, 20),
      requiredCapabilities: skill.requiredCapabilities,
      requiredInputs: skill.requiredInputs.map((i) => ({
        name: i.name,
        description: i.description.slice(0, 200),
        required: i.required,
        ...(i.type !== undefined ? { type: i.type } : {}),
      })),
      executable: ctx.registry.isExecutable(skill.id),
    });
  },
};

function toSummary(ctx: McpContext, s: SkillSummary): Record<string, unknown> {
  const full = ctx.registry.get(s.id);
  return {
    id: s.id,
    version: s.version,
    status: s.status,
    description: s.description,
    executable: ctx.registry.isExecutable(s.id),
    requiredInputs: (full?.requiredInputs ?? []).map((i) => ({
      name: i.name,
      required: i.required,
    })),
  };
}

/**
 * Handles one MCP request. ALWAYS returns a well-formed McpResponse — never
 * throws, never partially applies. Unknown tools, unknown arguments, oversized
 * or malformed requests fail closed before any component is touched.
 */
export async function handleMcpRequest(raw: unknown, ctx: McpContext): Promise<McpResponse> {
  const validated = validateMcpRequest(raw, { protocolVersion: MCP_PROTOCOL_VERSION });
  if (!validated.ok || validated.request === undefined) {
    const requestId =
      isRecord(raw) && typeof raw["requestId"] === "string"
        ? raw["requestId"].slice(0, 64)
        : "";
    return mcpError(requestId, validated.errorCode ?? "malformed", validated.errors.join("; "));
  }
  const request = validated.request;
  // Defence in depth: the allowed arg keys are re-asserted here so a future
  // handler cannot accidentally accept a key the catalog forbids.
  for (const key of Object.keys(request.args)) {
    if (!MCP_TOOL_ARGS[request.tool].includes(key)) {
      return mcpError(request.requestId, "unknown_argument", `unexpected argument ${key}`);
    }
  }
  try {
    const handler = HANDLERS[request.tool];
    return await handler({ requestId: request.requestId, args: request.args, ctx });
  } catch (err) {
    return mcpError(
      request.requestId,
      "internal",
      err instanceof Error ? err.message : "handler failed",
    );
  }
}
