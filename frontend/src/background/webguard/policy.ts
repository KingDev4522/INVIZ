/**
 * WebGuard policy engine — REAL, deterministic, no model inside (PRD 6.5 §1.2;
 * PRD 4 §40–42; PRD 5 §8–15; PRD 6 §5). Fixed evaluation order:
 * schema → type → target+generation → provenance → sensitivity gate →
 * confirmation classification → parameter rules. First failure decides.
 */
import { validateStructuredAction } from "../../../../shared/types.js";
import type {
  SecurityDecision,
  StructuredAction,
} from "../../../../shared/types.js";

export interface GuardVerdict {
  decision: SecurityDecision;
  reason: string;
}

/** Registry facts for the action's target, supplied by the controller. */
export interface TargetInfo {
  id: string;
  role: string;
  name: string;
  fieldKind: string | null;
  sensitive: boolean;
  /** True for submit buttons / commit controls. */
  isSubmit: boolean;
}

export type Provenance = "USER" | "SYSTEM";

export interface GuardContext {
  currentGeneration: number;
  /** Targets known-good in the current generation. */
  targets: Map<string, TargetInfo>;
  /** Who proposed this action. Page/model-derived proposals are rejected. */
  provenance: Provenance;
  /**
   * True only when a sensitive value arrived via the ask-user memory-only
   * path for THIS action (PRD 6 §6). Typing into a sensitive field without
   * it is blocked — the value must never be typed from page/model context.
   */
  sensitiveAuthorized: boolean;
  /**
   * Trusted-operator mode (explicit user opt-in, "Power mode" in the popup).
   * Skips the SAFETY gates below (sensitivity + confirmation) — correctness
   * BLOCKs (schema, provenance, unknown/stale targets) still apply, and the
   * verdict reason says power mode so the audit trail stays honest.
   */
  powerMode?: boolean;
}

const CONFIRM_SUBMIT_RE = /submit|place order|buy|pay|purchase|send|delete|remove|upload|confirm/i;

function needsConfirmation(action: StructuredAction, target: TargetInfo | null): boolean {
  if (target !== null && target.isSubmit) return true;
  if (target !== null && CONFIRM_SUBMIT_RE.test(target.name) && target.role === "button") {
    return true;
  }
  if (action.action === "close_tab") return false;
  return false;
}

export function evaluate(
  action: StructuredAction,
  ctx: GuardContext,
): GuardVerdict {
  // 1. Schema: malformed proposals die here, never downstream.
  const checked = validateStructuredAction(action);
  if (!checked.ok) {
    return { decision: "BLOCK", reason: `schema: ${checked.errors.join("; ")}` };
  }

  // 2. Provenance: only the user (via controller) or system policy authorize.
  if (ctx.provenance !== "USER" && ctx.provenance !== "SYSTEM") {
    return { decision: "BLOCK", reason: "provenance: not user-authorized" };
  }

  // 3. Target + generation for target-bearing actions. web_search is
  // read-only and targetless (like navigation): ALLOW, never confirm.
  const needsTarget = !["navigate", "go_back", "go_forward", "close_tab", "web_search"].includes(
    action.action,
  );
  let target: TargetInfo | null = null;
  if (needsTarget) {
    if (action.target === undefined) {
      return { decision: "BLOCK", reason: "target: required for this action" };
    }
    const known = ctx.targets.get(action.target);
    if (known === undefined) {
      return { decision: "BLOCK", reason: `target: ${action.target} not in current registry` };
    }
    if (action.pageGeneration !== undefined && action.pageGeneration !== ctx.currentGeneration) {
      return { decision: "BLOCK", reason: `stale: action generation ${action.pageGeneration} != current ${ctx.currentGeneration}` };
    }
    target = known;
  } else if (action.action === "close_tab" && action.target !== undefined) {
    const known = ctx.targets.get(action.target);
    if (known === undefined) {
      return { decision: "BLOCK", reason: `target: ${action.target} not in current registry` };
    }
  }

  const power = ctx.powerMode === true;
  // 4. Sensitivity gate: secrets are typed only via the authorized slot-fill.
  // Power mode: the operator explicitly accepted typing anywhere.
  if (
    !power &&
    target !== null &&
    target.sensitive &&
    action.action === "type" &&
    !ctx.sensitiveAuthorized
  ) {
    return {
      decision: "BLOCK",
      reason: "sensitive: value must arrive via the ask-user memory-only path",
    };
  }

  // 5. Confirmation classification for consequential actions.
  // Power mode: no REQUIRE_CONFIRMATION is ever emitted.
  if (!power && needsConfirmation(action, target)) {
    return { decision: "REQUIRE_CONFIRMATION", reason: "consequential action requires explicit approval" };
  }

  return { decision: "ALLOW", reason: power ? "within policy (power mode: safety gates bypassed)" : "within policy" };
}
