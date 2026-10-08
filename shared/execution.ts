/**
 * Execution Router — REAL (Phase 7).
 *
 * Chooses LOCAL (the built-in Browser Executor) or OPTIONAL EXTERNAL (the
 * Browser Harness bridge) based on POLICY. The model may express a preference,
 * but it can never make this decision by itself, and there is no automatic
 * escalation: local only ever becomes external when policy explicitly permits
 * it AND an explicit external preference was recorded for the task.
 *
 * Security invariants:
 *  - Default is LOCAL. With no policy supplied, external is impossible.
 *  - The router runs AFTER WebGuard, consent and budget checks. It chooses
 *    WHERE an already-authorized action executes, never WHETHER it may.
 *  - An unavailable/failed external path falls back to LOCAL where the action
 *    is supported locally; it never blocks the task or retries indefinitely.
 */

export type ExecutionMode = "local" | "external";

/** Model-expressed preference. Never authoritative. */
export type ExecutionPreference = "local" | "external";

export interface ExecutionPolicy {
  /** Explicit opt-in. False means external execution can never be chosen. */
  allowExternal?: boolean;
  /**
   * Optional task allow-list. When present, only these tasks may execute
   * externally even if allowExternal is true.
   */
  externalTaskIds?: ReadonlySet<string>;
  /** Recorded preference for this task (set by explicit user/policy consent). */
  preference?: ExecutionPreference;
}

/** Secure default: local execution only. */
export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {};

export interface ExecutionDecision {
  mode: ExecutionMode;
  /** Why the choice was made — for logs and episode provenance. */
  reason:
    | "default_local"
    | "external_not_permitted"
    | "task_not_allowed"
    | "no_external_preference"
    | "explicit_external";
}

/**
 * Selects the execution mode. Deterministic and side-effect free.
 *
 * Order of gates (fail closed to LOCAL):
 *  1. policy allows external?          else local
 *  2. task on the allow-list?          else local
 *  3. an explicit external preference? else local  (no automatic escalation)
 */
export function chooseExecutionMode(
  policy: ExecutionPolicy,
  ctx: { taskId: string },
): ExecutionDecision {
  if (policy.allowExternal !== true) {
    return { mode: "local", reason: "external_not_permitted" };
  }
  if (policy.externalTaskIds !== undefined && !policy.externalTaskIds.has(ctx.taskId)) {
    return { mode: "local", reason: "task_not_allowed" };
  }
  if (policy.preference !== "external") {
    return { mode: "local", reason: "no_external_preference" };
  }
  return { mode: "external", reason: "explicit_external" };
}

// --- Resource bounds (PART 18) ------------------------------------------------

/** Serialized bridge message cap — refuse larger rather than buffer them. */
export const MAX_BRIDGE_MESSAGE_BYTES = 64 * 1024;
/** MCP request cap. */
export const MAX_MCP_REQUEST_BYTES = 8 * 1024;
/** Bridge single-attempt timeout; never an indefinite wait. */
export const BRIDGE_TIMEOUT_MS = 10_000;
/** Free text the bridge may return in one observation. */
export const MAX_BRIDGE_TEXT_CHARS = 4_000;
/** Items a bridge page-state observation may carry. */
export const MAX_BRIDGE_ITEMS = 60;
/** Fields an MCP response may carry for state queries. */
export const MAX_MCP_RESULT_ITEMS = 60;
