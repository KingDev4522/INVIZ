/**
 * Episode model — REAL (Phase 5, opt-in learning layer).
 *
 * An Episode is LEARNING EVIDENCE about one completed task: what was observed,
 * which actions ran, what the browser reported. It is deliberately NOT a Skill
 * and NOT executable — it carries no `status`, no `procedure`, and cannot be
 * registered as a Skill. Candidate Skills (Phase 6) are DERIVED from episodes
 * and must still pass validation + the existing Phase 4 trust lifecycle.
 *
 * Reuse, not duplication: episodes reference the EXISTING StructuredAction,
 * VerificationOutcome, AgentOutcomeType, SkillStatus and TaskStatus types. No
 * parallel PageState/TaskState/VerificationResult is defined here.
 *
 * Privacy is enforced here, at construction, and again by the store before the
 * value reaches persistent storage (defence in depth). No model is consulted.
 */
import { MAX_EPISODE_ACTIONS } from "./constants.js";
import { REDACTED, redactObject, redactSecretText, redactString } from "./redact.js";
import type { SkillValidationResult } from "./types.js";
import {
  ACTION_TYPES,
  SKILL_ID_RE,
  type ActionType,
  type AgentOutcomeType,
  type SkillStatus,
  type StructuredAction,
  type VerificationOutcome,
} from "./types.js";

export const EPISODE_SCHEMA_VERSION = 1;

export { MAX_EPISODE_ACTIONS };

/** Terminal task statuses an episode can close with. */
export type EpisodeFinalStatus =
  | "COMPLETE"
  | "CANCELLED"
  | "BLOCKED"
  | "FAILED"
  | "LIMIT_REACHED";

export type EpisodeActionStatus =
  | "executed"   // ran and was verified
  | "failed"     // ran but verification failed
  | "blocked"    // WebGuard refused it
  | "awaiting_confirmation" // consent requested; not executed
  | "read"       // read-aloud observation
  | "not_run";   // declined before execution (e.g. unsupported page)

export interface EpisodeVerificationRecord {
  success: boolean;
  outcome: VerificationOutcome;
  timedOut: boolean;
  pageGeneration: number;
}

/**
 * Where the action actually ran. Recorded as provenance (Phase 7); it never
 * affects whether the action was authorized — WebGuard/consent already decided.
 */
export type EpisodeExecutionMode = "local" | "external";

export interface EpisodeActionRecord {
  /** 0-based order within the episode. */
  index: number;
  /** The existing action vocabulary — no episode-only action types. */
  action: StructuredAction;
  /** PageState generation this action was resolved against. */
  pageGeneration: number;
  status: EpisodeActionStatus;
  /** Executor used. Absent on episodes recorded before Phase 7. */
  executionMode?: EpisodeExecutionMode;
  verification?: EpisodeVerificationRecord;
}

export interface EpisodeSkillRecord {
  skillId: string;
  skillVersion: string;
  /** Trust state at recording time — provenance, never an authority claim. */
  skillStatus: SkillStatus;
  input: Record<string, string | number | boolean>;
  /** Registry version the plan was resolved against (snapshot pin). */
  plannedVersion?: string;
}

export interface EpisodeRegistryVersion {
  skillId: string;
  version: string;
  status: SkillStatus;
}

export interface Episode {
  schemaVersion: number;
  episodeId: string;
  taskId: string;
  /** Epoch ms when the task started. */
  createdAt: number;
  /** Epoch ms when the episode was finalized. */
  recordedAt: number;
  /** User goal, redacted (credentials typed into the command never persist). */
  goal: string;
  goalLang: "en" | "hi" | "mixed";
  /** Page URL with query/fragment stripped (session tokens live in queries). */
  pageUrl: string;
  pageTitle: string;
  /** Every PageState generation observed during the task. */
  pageGenerations: number[];
  /** The skill the model selected, if any. */
  selectedSkill: EpisodeSkillRecord | null;
  actions: EpisodeActionRecord[];
  /** Count of recovery attempts spent (failures that triggered re-planning). */
  recoveryEvents: number;
  finalOutcomeType: AgentOutcomeType | null;
  finalOutcomeText: string | null;
  finalStatus: EpisodeFinalStatus;
  /** Successful == the task reached COMPLETE. Evidence, not authority. */
  success: boolean;
  completedActions: number;
  /** Registry versions in force when the episode closed (provenance). */
  registrySnapshot: EpisodeRegistryVersion[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deterministic: strips query + fragment, never returns a raw token-bearing URL. */
export function safePageUrl(url: string): string {
  if (typeof url !== "string" || url === "") return "";
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

const FINAL_STATUSES: readonly EpisodeFinalStatus[] = [
  "COMPLETE",
  "CANCELLED",
  "BLOCKED",
  "FAILED",
  "LIMIT_REACHED",
];

const ACTION_STATUSES: readonly EpisodeActionStatus[] = [
  "executed",
  "failed",
  "blocked",
  "awaiting_confirmation",
  "read",
  "not_run",
];

/**
 * Validates an episode before it may be persisted. Fail-closed: an unknown
 * field set, a bad id, a non-ActionType action, or a malformed action record
 * rejects the whole episode. Never repairs.
 */
export function validateEpisode(episode: unknown): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(episode)) {
    return { valid: false, errors: ["episode must be an object"], warnings: [] };
  }
  if (episode["schemaVersion"] !== EPISODE_SCHEMA_VERSION) {
    errors.push(`schemaVersion: must be ${EPISODE_SCHEMA_VERSION}`);
  }
  const episodeId = episode["episodeId"];
  if (typeof episodeId !== "string" || episodeId.trim() === "") {
    errors.push("episodeId: required non-empty string");
  }
  const taskId = episode["taskId"];
  if (typeof taskId !== "string" || taskId.trim() === "") {
    errors.push("taskId: required non-empty string");
  }
  for (const field of ["createdAt", "recordedAt"] as const) {
    const value = episode[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      errors.push(`${field}: must be a non-negative integer`);
    }
  }
  const goal = episode["goal"];
  if (typeof goal !== "string" || goal.trim() === "") {
    errors.push("goal: required non-empty string");
  }
  const goalLang = episode["goalLang"];
  if (goalLang !== "en" && goalLang !== "hi" && goalLang !== "mixed") {
    errors.push("goalLang: must be en, hi or mixed");
  }
  if (typeof episode["pageUrl"] !== "string") errors.push("pageUrl: must be a string");
  if (typeof episode["pageTitle"] !== "string") errors.push("pageTitle: must be a string");

  const generations = episode["pageGenerations"];
  if (!Array.isArray(generations) || !generations.every((g) => Number.isInteger(g))) {
    errors.push("pageGenerations: must be an array of integers");
  }

  const selectedSkill = episode["selectedSkill"];
  if (selectedSkill !== null && selectedSkill !== undefined) {
    if (!isRecord(selectedSkill)) {
      errors.push("selectedSkill: must be null or an object");
    } else {
      if (typeof selectedSkill["skillId"] !== "string" || !SKILL_ID_RE.test(selectedSkill["skillId"])) {
        errors.push("selectedSkill.skillId: invalid skill id");
      }
      if (typeof selectedSkill["skillVersion"] !== "string" || selectedSkill["skillVersion"] === "") {
        errors.push("selectedSkill.skillVersion: required non-empty string");
      }
      if (!isRecord(selectedSkill["input"])) {
        errors.push("selectedSkill.input: must be an object");
      }
    }
  }

  const actions = episode["actions"];
  if (!Array.isArray(actions)) {
    errors.push("actions: must be an array");
  } else if (actions.length > MAX_EPISODE_ACTIONS) {
    errors.push(`actions: exceeds ${MAX_EPISODE_ACTIONS} entry bound`);
  } else {
    actions.forEach((record, i) => {
      const prefix = `actions[${i}]`;
      if (!isRecord(record)) {
        errors.push(`${prefix}: must be an object`);
        return;
      }
      if (!Number.isInteger(record["index"])) errors.push(`${prefix}.index: must be an integer`);
      if (
        typeof record["status"] !== "string" ||
        !ACTION_STATUSES.includes(record["status"] as EpisodeActionStatus)
      ) {
        errors.push(`${prefix}.status: invalid`);
      }
      if (!Number.isInteger(record["pageGeneration"])) {
        errors.push(`${prefix}.pageGeneration: must be an integer`);
      }
      const mode = record["executionMode"];
      if (mode !== undefined && mode !== "local" && mode !== "external") {
        errors.push(`${prefix}.executionMode: must be local or external`);
      }
      const action = record["action"];
      if (!isRecord(action)) {
        errors.push(`${prefix}.action: must be an object`);
        return;
      }
      if (
        typeof action["action"] !== "string" ||
        !ACTION_TYPES.includes(action["action"] as ActionType)
      ) {
        errors.push(`${prefix}.action: not an existing ActionType`);
      }
      const verif = record["verification"];
      if (verif !== undefined) {
        if (!isRecord(verif)) {
          errors.push(`${prefix}.verification: must be an object`);
        } else if (
          typeof verif["outcome"] !== "string" ||
          !["VERIFIED_SUCCESS", "VERIFIED_FAILURE", "STALE_STATE", "UNKNOWN"].includes(
            verif["outcome"],
          )
        ) {
          errors.push(`${prefix}.verification.outcome: invalid`);
        } else if (typeof verif["success"] !== "boolean") {
          errors.push(`${prefix}.verification.success: must be boolean`);
        }
      }
    });
  }

  if (typeof episode["recoveryEvents"] !== "number") errors.push("recoveryEvents: must be a number");
  const finalStatus = episode["finalStatus"];
  if (typeof finalStatus !== "string" || !FINAL_STATUSES.includes(finalStatus as EpisodeFinalStatus)) {
    errors.push("finalStatus: invalid");
  }
  if (typeof episode["success"] !== "boolean") errors.push("success: must be boolean");
  if (typeof episode["completedActions"] !== "number") errors.push("completedActions: must be a number");
  if (!Array.isArray(episode["registrySnapshot"])) errors.push("registrySnapshot: must be an array");
  if (
    episode["finalOutcomeType"] !== null &&
    episode["finalOutcomeType"] !== undefined &&
    typeof episode["finalOutcomeType"] !== "string"
  ) {
    errors.push("finalOutcomeType: must be null or a string");
  }

  // Privacy invariant, asserted on the way OUT of validation: no free-text
  // FIELD may carry an un-redacted card number. Only string values are scanned
  // — a 13-digit epoch timestamp is a number, not a credential, so scanning the
  // whole JSON would reject every legitimately-recorded episode.
  const strings: string[] = [];
  collectStrings(episode, strings);
  if (strings.some((s) => redactString(s) !== s)) {
    errors.push("episode contains what looks like an un-redacted card number");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Gathers every string value anywhere in a structure. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/**
 * Deterministic redaction — the single transformation every episode passes
 * through before persistence. Applied regardless of any model opinion.
 */
export function redactEpisode(episode: Episode): Episode {
  const goal = redactSecretText(episode.goal);
  const actions = episode.actions.map((record) => {
    const action: StructuredAction = { ...record.action };
    // A typed/selected VALUE is user-entered data: mask it outright rather
    // than trying to classify it. Structure (which field, which action) stays.
    if (action.action === "type" || action.action === "select") {
      if (action.value !== undefined && action.value !== "") {
        action.value = REDACTED;
      }
    } else if (typeof action.value === "string") {
      action.value = redactSecretText(action.value);
    }
    if (action.parameters !== undefined) {
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(action.parameters)) {
        params[k] = typeof v === "string" ? redactSecretText(v) : v;
      }
      action.parameters = params;
    }
    return { ...record, action };
  });
  const candidate: Episode = {
    ...episode,
    goal,
    pageUrl: safePageUrl(episode.pageUrl),
    pageTitle: redactSecretText(episode.pageTitle),
    finalOutcomeText:
      episode.finalOutcomeText === null
        ? null
        : redactSecretText(episode.finalOutcomeText),
    actions,
    registrySnapshot: episode.registrySnapshot.map((entry) => ({ ...entry })),
  };
  // Final layer: secret-NAME keys anywhere in the structure are replaced.
  return redactObject(candidate);
}
