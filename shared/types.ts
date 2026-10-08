/**
 * Shared cross-context contracts (PRD 4 §97–103, PRD 6 §5).
 * Every type used across extension contexts has a runtime validator beside it.
 * Compile-time types alone do NOT satisfy the schema-validation invariant (PRD 5).
 */

export type PageGeneration = number;

// ============================================================================
// SKILL SYSTEM TYPES (Phase 1 — INVIZ Skill Contract)
// ============================================================================
// Skills are reusable browser interaction knowledge expressed through existing
// INVIZ capabilities (ActionType, StructuredAction, Expectation).
// Skills do NOT introduce new action types or execute arbitrary code.
// ============================================================================

/**
 * Trust/status lifecycle for a skill.
 *
 * Lifecycle: candidate → tested → approved → canary → trusted
 * Any state can transition to disabled (manual override).
 * Candidate skills MUST NOT automatically become trusted, and a new version
 * NEVER inherits trust from an older version (Phase 4).
 *
 * `canary` is an explicit, policy-gated rollout state: a canary skill executes
 * only when the registry execution policy explicitly enables canary rollout.
 */
export type SkillStatus =
  | "candidate"   // Initial state; created but not yet validated
  | "tested"      // Passed static validation + automated tests
  | "approved"    // Human/policy approved for use
  | "canary"      // Explicit rollout state; executes only when policy enables it
  | "trusted"     // Full production use after successful canary
  | "disabled";   // Manually disabled (retains metadata, not executed)

/**
 * Test execution status for a skill.
 */
export type TestStatus = "untested" | "passing" | "failing";

/**
 * A single step in a skill procedure.
 *
 * Each step resolves to an existing INVIZ action type — no new browser
 * actions are introduced by skills.
 */
export interface SkillProcedureStep {
  /** Step description for logging/debugging (human-readable). */
  description: string;
  /** The action to perform — MUST be an existing ActionType. */
  action: ActionType;
  /** Target element ID (eNN) or prose region ID (rNN) when required. */
  target?: string;
  /** Value for type actions. */
  value?: string;
  /** Additional parameters (validated against StructuredAction schema). */
  parameters?: Record<string, unknown>;
  /** Expected outcome after this step (optional verification). */
  expect?: Expectation;
  /** What to wait for after the action (if any). */
  waitFor?: SkillWaitCondition;
  /** Max attempts for this step before triggering recovery. */
  maxAttempts?: number;
}

/**
 * Conditions a skill step can wait for.
 *
 * These map to existing verification expectations but expressed as wait
 * conditions rather than inline expectations.
 */
export type SkillWaitCondition =
  | "navigation"
  | "element_present"
  | "element_absent"
  | "text_present"
  | "field_filled"
  | "element_state"
  | "dialog_present"
  | "stable";  // No specific condition, just wait for page settle

/**
 * Verification criteria a skill uses to determine success.
 */
export interface SkillVerificationCriterion {
  /** Description of what success looks like. */
  description: string;
  /** The expectation type to verify. */
  type: ExpectationType;
  /** Target element or region when applicable. */
  target?: string;
  /** Expected value for text_present or field_value_present. */
  value?: string;
  /** Expected state for element_state. */
  state?: ElementStateKind;
  stateValue?: boolean;
}

/**
 * Recovery behavior when a skill step fails.
 */
export interface SkillRecoveryStrategy {
  /** Trigger condition that causes this recovery. */
  trigger: SkillRecoveryTrigger;
  /** Description of the recovery action. */
  action: string;
  /** Maximum number of recovery attempts. */
  maxAttempts: number;
  /** Whether to escalate to the LLM after recovery fails. */
  escalateOnExhaustion: boolean;
}

/**
 * Triggers that can initiate skill recovery.
 */
export type SkillRecoveryTrigger =
  | "element_not_found"
  | "action_failed"
  | "verification_failed"
  | "navigation_failed"
  | "timeout"
  | "unexpected_state";

/**
 * Required inputs for a skill to execute.
 *
 * These are conceptual inputs the skill needs — actual values come from
 * PageState, user context, or explicit user provision.
 */
export interface SkillRequiredInput {
  /** Input name (e.g., "repository_url", "login_status"). */
  name: string;
  /** Human-readable description of the input. */
  description: string;
  /** Whether this input is required or optional. */
  required: boolean;
  /** Expected type of the input value. */
  type?: "string" | "boolean" | "url" | "element_id" | "region_id";
}

/**
 * Capabilities a skill requires from the browser.
 *
 * These map to existing INVIZ capabilities — skills declare what they need
 * so the system can verify availability before execution.
 */
export type SkillRequiredCapability =
  | "read_page"
  | "find_element"
  | "click"
  | "type"
  | "focus"
  | "select"
  | "scroll"
  | "press_key"
  | "navigate"
  | "wait"
  | "verify";

/**
 * Complete skill metadata and contract.
 *
 * This is the authoritative skill type for INVIZ. Skills are:
 * - Versioned (SemVer)
 * - Status-tracked (candidate → trusted lifecycle)
 * - Procedure-based (steps resolve to existing ActionType)
 * - Verifyable (success criteria defined)
 * - Recoverable (failure strategies defined)
 * - Testable (test metadata included)
 */
export interface Skill {
  // --- Identity ---
  /** Unique skill identifier (e.g., "github_find_contributors"). */
  id: string;
  /** Namespace/category (e.g., "github", "generic"). */
  namespace: string;
  /** Human-readable display name. */
  name: string;
  /** SemVer version string (e.g., "1.0.0"). */
  version: string;

  // --- Description (for LLM selection) ---
  /** What the skill does — used by LLM to select appropriate skill. */
  description: string;
  /** Phrases/intents this skill supports (for LLM matching). */
  supportedIntents: string[];
  /** Human-readable examples of when to use this skill. */
  examples: string[];

  // --- Trust & Status ---
  /** Current trust/status state. */
  status: SkillStatus;
  /** Test execution status. */
  testStatus: TestStatus;
  /** When the skill was created (epoch ms). */
  createdAt: number;
  /** When the skill was last modified (epoch ms). */
  modifiedAt: number;
  /** Who/what created this skill ("human" or "candidate_generator"). */
  createdBy: string;

  // --- Inputs ---
  /** Inputs the skill requires to execute. */
  requiredInputs: SkillRequiredInput[];
  /** Capabilities the skill requires from the browser. */
  requiredCapabilities: SkillRequiredCapability[];

  // --- Procedure ---
  /** Ordered steps that execute the skill.
   *  Each step uses existing ActionType — no arbitrary code. */
  procedure: SkillProcedureStep[];

  // --- Verification ---
  /** Criteria to verify the skill executed successfully. */
  verificationCriteria: SkillVerificationCriterion[];

  // --- Recovery ---
  /** Recovery strategies for failure scenarios. */
  recoveryStrategies: SkillRecoveryStrategy[];

  // --- Testing ---
  /** Path to test file(s) for this skill (relative to skill root). */
  testFilePaths: string[];
  /** When the skill was last tested. */
  lastTestedAt: number | null;
  /** Last test result summary. */
  lastTestResult: string | null;

  // --- Rollout ---
  /** Canary rollout percentage (0-100). Only applies when status >= "approved". */
  canaryRolloutPercent: number;
  /** When canary rollout started (if applicable). */
  canaryStartedAt: number | null;
}

/**
 * Minimal skill info for discovery/listing (without full procedure).
 */
export interface SkillSummary {
  id: string;
  namespace: string;
  name: string;
  version: string;
  description: string;
  status: SkillStatus;
  testStatus: TestStatus;
  supportedIntents: string[];
  requiredCapabilities: SkillRequiredCapability[];
}

/**
 * Filter options for skill discovery/lookup.
 */
export interface SkillFilter {
  /** Filter by namespace (e.g., "github"). */
  namespace?: string;
  /** Filter by status (e.g., only "trusted" skills). */
  status?: SkillStatus | SkillStatus[];
  /** Filter by capability requirement. */
  requiresCapability?: SkillRequiredCapability;
  /** Search in skill IDs and descriptions. */
  search?: string;
}

/**
 * Validation result for skill metadata.
 */
export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================================================
// END SKILL SYSTEM TYPES
// ============================================================================


export interface ElementReference {
  id: string; // e.g. "e37"
  generation: PageGeneration;
}

export type ActionType =
  | "click"
  | "type"
  | "focus"
  | "select"
  | "scroll"
  | "press_key"
  | "navigate"
  | "go_back"
  | "go_forward"
  | "open_tab"
  | "close_tab"
  | "read"
  | "web_search";

export const ACTION_TYPES: readonly ActionType[] = [
  "click",
  "type",
  "focus",
  "select",
  "scroll",
  "press_key",
  "navigate",
  "go_back",
  "go_forward",
  "open_tab",
  "close_tab",
  "read",
  "web_search",
] as const;

export type ExpectationType =
  | "element_present"
  | "element_absent"
  | "focused_element"
  | "url_changed"
  | "dialog_present"
  | "text_present"
  | "field_value_present"
  | "navigation_completed"
  | "element_state"
  | "submit_completed";

export const EXPECTATION_TYPES: readonly ExpectationType[] = [
  "element_present",
  "element_absent",
  "focused_element",
  "url_changed",
  "dialog_present",
  "text_present",
  "field_value_present",
  "navigation_completed",
  "element_state",
  "submit_completed",
] as const;

export type ElementStateKind = "checked" | "expanded" | "selected" | "pressed";

export interface Expectation {
  type: ExpectationType;
  target?: string;
  value?: string;
  /** Required when type === "element_state". */
  state?: ElementStateKind;
  stateValue?: boolean;
}

export interface StructuredAction {
  action: ActionType;
  target?: string;
  pageGeneration?: number;
  value?: string;
  parameters?: Record<string, unknown>;
  expect?: Expectation;
  timeout_ms?: number;
}

export type ExecutionStatus = "executed" | "failed";

export interface ExecutionResult {
  status: ExecutionStatus;
  action: ActionType;
  target?: string;
  pageGeneration?: PageGeneration;
  timestamp: number;
  errorCode?: string;
}

export type VerificationOutcome =
  | "VERIFIED_SUCCESS"
  | "VERIFIED_FAILURE"
  | "STALE_STATE"
  | "UNKNOWN";

export interface VerificationResult {
  success: boolean;
  outcome: VerificationOutcome;
  expected: Expectation;
  observed: unknown;
  timedOut: boolean;
  pageGeneration: PageGeneration;
}

export type SecurityDecision = "ALLOW" | "BLOCK" | "REQUIRE_CONFIRMATION";

export type AgentOutcomeType =
  | "answer"
  | "ask_user"
  | "action"
  | "confirmation_required"
  | "task_complete"
  | "cannot_complete"
  | "skill";

/**
 * Skill selection (Phase 3). The model names a REGISTERED skill and supplies
 * validated inputs; the trusted registry procedure runs through the existing
 * action pipeline. The model never generates the procedure itself.
 */
export interface SkillSelection {
  skillId: string;
  /** Primitive-valued inputs only; validated at the model boundary. */
  input: Record<string, string | number | boolean>;
}

/**
 * Skill-id grammar and input bounds, enforced at the model boundary. The model
 * may only name a syntactically valid id; whether that id is registered,
 * executable, and resolvable is decided by the Skill Registry downstream.
 */
export const SKILL_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const SKILL_INPUT_MAX_KEYS = 16;
export const SKILL_INPUT_VALUE_MAX_CHARS = 500;

export interface AgentOutcome {
  type: AgentOutcomeType;
  text?: string;
  question?: string;
  field?: string;
  sensitivity?: "ordinary" | "high";
  action?: StructuredAction;
  reason?: string;
  /** Present when type === "skill". */
  skill?: SkillSelection;
}

export interface AIError {
  code: string;
  recoverable: boolean;
  source: "GATEWAY" | "QWEN" | "WHISPER" | "TTS";
}

export type AudioPriority = 1 | 2 | 3 | 4 | 5; // 1 = safety/confirmation … 5 = focus

export interface AudioRequest {
  text: string;
  lang: "en" | "hi" | "mixed";
  priority: AudioPriority;
  interruptible: boolean;
  requestId: string;
}

export interface ExtensionMessage {
  type: string;
  requestId: string;
  taskId?: string;
  tabId?: number;
  payload: Record<string, unknown>;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Runtime validators (PRD 6 §5 parameter rules, enforced again by WebGuard)
// ---------------------------------------------------------------------------

const ELEMENT_ID_RE = /^e\d+$/;

/**
 * Readable-prose region handle (r1, r2, …) as advertised in the serialized
 * page's PROSE section. Accepted ONLY by the read action: a region is body
 * text, not a control, so no side-effecting action may target one. Both forms
 * remain opaque handles minted by the frontend — never selectors or URLs.
 */
const PROSE_ID_RE = /^r\d+$/;

const PRESS_KEY_ALLOWLIST: readonly string[] = [
  "Enter",
  "Tab",
  "Escape",
  "Space",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;

const NAVIGATE_DENIED_SCHEMES = [
  "javascript:",
  "data:",
  "file:",
  "view-source:",
  "chrome:",
  "chrome-extension:",
  "about:",
];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isExtensionMessage(v: unknown): v is ExtensionMessage {
  if (!isRecord(v)) return false;
  return (
    typeof v["type"] === "string" &&
    (v["type"] as string).length > 0 &&
    typeof v["requestId"] === "string" &&
    (v["requestId"] as string).length > 0 &&
    (v["taskId"] === undefined || typeof v["taskId"] === "string") &&
    (v["tabId"] === undefined || Number.isInteger(v["tabId"])) &&
    isRecord(v["payload"]) &&
    (v["timestamp"] === undefined || typeof v["timestamp"] === "number")
  );
}

/**
 * Expectation vocabulary variants the model reaches for in practice.
 * Measured live: it emits `value_present` for "the field now holds something",
 * which is the `field_value_present` we already implement. Rejecting it failed
 * the whole turn with "unknown expectation type", so the variant is normalized
 * instead. Verification of a field's contents stays boolean-only — the engine
 * asks "is it non-empty", never "what is it" (PRD 5 §17).
 */
const EXPECTATION_ALIASES: Readonly<Record<string, string>> = {
  value_present: "field_value_present",
  has_value: "field_value_present",
  element_clicked: "element_present",
  clicked: "element_present",
  changed: "element_state",
  content_changed: "url_changed",
  loaded: "navigation_completed",
  // Submit-style side effects have no single observable element to wait for
  // (they navigate, toast, or swap the form), so the model reaching for a
  // generic "did it go through" maps onto the multi-signal expectation.
  submitted: "submit_completed",
  success: "submit_completed",
  done: "submit_completed",
};

function normalizeExpectationType(raw: string): string {
  return EXPECTATION_ALIASES[raw] ?? raw;
}

function validateExpectation(e: unknown, path: string, errors: string[]): void {
  if (!isRecord(e)) {
    errors.push(path + ": expect must be an object");
    return;
  }
  const rawType = typeof e["type"] === "string" ? e["type"] : null;
  const type = rawType === null ? null : normalizeExpectationType(rawType);
  if (
    type === null ||
    !(EXPECTATION_TYPES as readonly string[]).includes(type)
  ) {
    errors.push(
      path +
        ".type: unknown expectation type" +
        (rawType === null ? "" : ` ("${rawType}")`),
    );
  }
  if (e["target"] !== undefined) {
    if (typeof e["target"] !== "string" || !ELEMENT_ID_RE.test(e["target"])) {
      errors.push(path + ".target: must match eNN");
    }
  }
  if (type === "element_state") {
    const kinds = ["checked", "expanded", "selected", "pressed"];
    if (typeof e["state"] !== "string" || !kinds.includes(e["state"])) {
      errors.push(path + ".state: required for element_state");
    }
    if (typeof e["stateValue"] !== "boolean") {
      errors.push(path + ".stateValue: required boolean for element_state");
    }
  }
}

/**
 * Validates a proposed structured action (shared pre-check).
 * The schema is CLOSED: unknown top-level fields are rejected, so smuggled
 * payloads (run/script/eval/…) can never ride alongside a valid action
 * (PRD 4 §79). WebGuard re-validates with registry + policy context.
 */
export function validateStructuredAction(v: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(v)) return { ok: false, errors: ["action: must be an object"] };
  const KNOWN_FIELDS = [
    "action",
    "target",
    "pageGeneration",
    "value",
    "parameters",
    "expect",
    "timeout_ms",
  ];
  for (const key of Object.keys(v)) {
    if (!KNOWN_FIELDS.includes(key)) {
      errors.push(`unexpected field: ${key}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  if (
    typeof v["action"] !== "string" ||
    !(ACTION_TYPES as readonly string[]).includes(v["action"])
  ) {
    errors.push("action: unknown action type");
    return { ok: false, errors };
  }
  const action = v["action"] as ActionType;

  const needsTarget: ActionType[] = [
    "click",
    "type",
    "focus",
    "select",
    "scroll",
    "press_key",
    "read",
  ];
  if (needsTarget.includes(action)) {
    const target = v["target"];
    if (typeof target !== "string") {
      errors.push("target: required, must match eNN");
    } else if (action === "read" && PROSE_ID_RE.test(target)) {
      // Prose region handle — valid for reading body text only.
    } else if (!ELEMENT_ID_RE.test(target)) {
      errors.push(
        action === "read"
          ? "target: required, must match eNN or a prose region id (rNN)"
          : "target: required, must match eNN",
      );
    }
  }

  if (
    v["pageGeneration"] !== undefined &&
    (!Number.isInteger(v["pageGeneration"]) || (v["pageGeneration"] as number) < 0)
  ) {
    errors.push("pageGeneration: must be a non-negative integer");
  }

  if (
    v["timeout_ms"] !== undefined &&
    (!Number.isInteger(v["timeout_ms"]) ||
      (v["timeout_ms"] as number) < 100 ||
      (v["timeout_ms"] as number) > 10000)
  ) {
    errors.push("timeout_ms: must be an integer in [100, 10000]");
  }

  if (action === "type") {
    if (typeof v["value"] !== "string") {
      errors.push("value: required string for type");
    } else if ((v["value"] as string).length > 2000) {
      errors.push("value: exceeds 2000 characters");
    }
  }

  if (action === "select") {
    const p = v["parameters"];
    if (!isRecord(p) || !isRecord(p["option"])) {
      errors.push("parameters.option: required for select");
    } else {
      const by = (p["option"] as Record<string, unknown>)["by"];
      const ref = (p["option"] as Record<string, unknown>)["ref"];
      if (by !== "label" && by !== "value" && by !== "index") {
        errors.push("parameters.option.by: must be label|value|index");
      }
      if (typeof ref !== "string" && typeof ref !== "number") {
        errors.push("parameters.option.ref: must be string|number");
      }
    }
  }

  if (action === "press_key") {
    const p = v["parameters"];
    const key = isRecord(p) ? p["key"] : undefined;
    if (typeof key !== "string" || !PRESS_KEY_ALLOWLIST.includes(key)) {
      errors.push("parameters.key: not in the allowlist");
    }
    const modifiers = isRecord(p) ? p["modifiers"] : undefined;
    if (modifiers !== undefined) {
      errors.push("parameters.modifiers: denied by default policy");
    }
  }

  if (action === "navigate" || action === "open_tab") {
    // Destination lives in parameters.url (PRD 4 §100) — never top-level,
    // never a target ID: URLs are data, element references are identity.
    const params = isRecord(v["parameters"]) ? v["parameters"] : undefined;
    const url = params !== undefined ? params["url"] : undefined;
    if (typeof url !== "string") {
      errors.push("parameters.url: required string for " + action);
    } else {
      const lowered = url.trim().toLowerCase();
      if (
        !lowered.startsWith("http://") &&
        !lowered.startsWith("https://")
      ) {
        errors.push("url: only http/https navigation is permitted");
      }
      for (const scheme of NAVIGATE_DENIED_SCHEMES) {
        if (lowered.startsWith(scheme)) {
          errors.push("url: denied scheme " + scheme);
          break;
        }
      }
    }
  }

  if (action === "read") {
    const maxChars =
      isRecord(v["parameters"]) &&
      typeof v["parameters"]["max_chars"] === "number"
        ? (v["parameters"]["max_chars"] as number)
        : 4000;
    if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 20000) {
      errors.push("parameters.max_chars: must be an integer in [100, 20000]");
    }
  }

  if (action === "web_search") {
    // Query-only, targetless by design (URLs are data, never identity).
    // Results return as verified observations; the model then navigates with
    // the existing navigate/open_tab actions.
    const params = isRecord(v["parameters"]) ? v["parameters"] : undefined;
    const query = params !== undefined ? params["query"] : undefined;
    if (typeof query !== "string" || query.trim() === "") {
      errors.push("parameters.query: required non-empty string for web_search");
    } else if (query.length > 400) {
      errors.push("parameters.query: exceeds 400 characters");
    }
    if (v["target"] !== undefined) {
      errors.push("target: web_search takes no target");
    }
  }

  // read is verification-exempt (PRD 6 §5); close_tab verifies by tab-removal
  // event. When expect is present on any other action, it must be valid.
  if (action !== "read" && action !== "close_tab" && v["expect"] !== undefined) {
    validateExpectation(v["expect"], "expect", errors);
  }

  return { ok: errors.length === 0, errors };
}
