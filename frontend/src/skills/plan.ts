/**
 * Skill planning — REAL (Phase 2).
 *
 * A skill does not execute anything. Given the CURRENT verified page state and
 * resolved inputs, a skill's resolver PRODUCES a plan: an ordered list of
 * concrete StructuredActions plus verification criteria and a result summary.
 *
 * The plan is then executed by the EXISTING INVIZ pipeline (WebGuard →
 * Browser Executor → Verification) in a later phase. Nothing here bypasses
 * that pipeline — this module only builds the actions that will flow through it.
 *
 * Security invariants enforced here:
 *  - Unknown skill ids fail closed (unknown_skill).
 *  - Disabled/candidate skills fail closed (not_executable) — the registry's
 *    trust gate is consulted before any resolver runs.
 *  - Every generated action is re-validated with the SAME closed schema
 *    WebGuard uses (validateStructuredAction); a plan producing anything else
 *    is rejected wholesale (invalid_plan). This is what makes "no arbitrary
 *    JavaScript / no CDP / no shell" structural rather than aspirational.
 *  - The page generation of every action is stamped from the snapshot the plan
 *    was derived from, so a plan can never claim a generation it did not see.
 */
import {
  validateStructuredAction,
  type ActionType,
  type StructuredAction,
  type Skill,
  type SkillVerificationCriterion,
} from "../../../shared/types.js";
import type { SkillRegistry, SkillRegistryView } from "./registry.js";

/**
 * The subset of PageState a skill consumes. Structurally identical to the
 * controller's `PageSnapshotLike`, so a live snapshot is assignable with no
 * adapter. It is deliberately small: skills reason over the SAME compact
 * semantic PageState the model receives — never raw HTML or screenshots.
 */
export interface SkillPageSnapshot {
  url: string;
  title: string;
  generation: number;
  items: Array<{
    id: string;
    role: string;
    name: string;
    states: Record<string, string | boolean | number>;
    fieldKind: string | null;
    sensitive: boolean;
  }>;
  structure?: {
    headings: Array<{ level: number; text: string }>;
    landmarks: Array<{ role: string; name: string }>;
    forms: Array<{ name: string; fieldCount: number }>;
    openDialogs?: number;
  };
  prose?: Array<{ id: string; label: string; text: string; chars: number }>;
}

/** Inputs resolved from PageState, user context, or explicit user provision. */
export type SkillInputs = Record<string, string | number | boolean | undefined>;

export type SkillPlanStatus =
  | "ready" // actions produced and schema-valid, ready for the pipeline
  | "missing_input" // a required input was absent or malformed
  | "not_found" // the requested target/region does not exist on the page
  | "ambiguous" // several matches; the skill refuses to choose blindly
  | "unsupported_page" // the current page is outside the skill's scope
  | "unknown_skill" // no such skill is registered (fail closed)
  | "not_executable" // disabled/candidate/unapproved skill (fail closed)
  | "invalid_plan"; // a resolver produced an action that failed the closed schema

export interface SkillPlanResult {
  /** Generation-scoped element id the skill resolved, when applicable. */
  targetId?: string;
  /** Prose region handle (rNN) the skill resolved, when applicable. */
  regionId?: string;
  /** URL the skill will navigate to, when applicable. */
  url?: string;
  /** Candidate element ids when the resolution is ambiguous. */
  candidates?: string[];
  /** Human-readable note (e.g. which concept was matched). */
  note?: string;
}

export interface SkillPlan {
  skillId: string;
  skillVersion: string;
  pageGeneration: number;
  status: SkillPlanStatus;
  reason?: string;
  actions: StructuredAction[];
  verification: SkillVerificationCriterion[];
  result: SkillPlanResult;
}

/** What a resolver returns; planSkill() fills in identity + generation. */
export interface SkillResolutionDraft {
  status: SkillPlanStatus;
  reason?: string;
  actions?: StructuredAction[];
  verification?: SkillVerificationCriterion[];
  result?: SkillPlanResult;
}

/**
 * Pure resolution: (page state, inputs) → draft plan. A resolver may ONLY
 * emit actions built from existing ActionType values. It never performs a
 * browser operation itself.
 */
export type SkillResolver = (
  snapshot: SkillPageSnapshot,
  inputs: SkillInputs,
) => SkillResolutionDraft;

/** A skill plus its trusted, built-in resolver. */
export interface SkillCatalogEntry {
  skill: Skill;
  resolve: SkillResolver;
}

export interface SkillCatalog {
  get(id: string): SkillCatalogEntry | null;
  list(): SkillCatalogEntry[];
}

export function createSkillCatalog(entries: readonly SkillCatalogEntry[]): SkillCatalog {
  const byId = new Map<string, SkillCatalogEntry>();
  for (const entry of entries) byId.set(entry.skill.id, entry);
  return {
    get: (id) => byId.get(id) ?? null,
    list: () => [...byId.values()],
  };
}

/**
 * Actions after which a skill is considered finished for the current step, so
 * the controller hands control back to the model. `read` yields the observation
 * the user asked for; `focus` completes a locate-and-surface skill. Everything
 * else (click/navigate/type/…) is a transition and the skill is re-resolved
 * against the FRESH page state on the next step — never executed blindly as a
 * batch.
 */
const TERMINAL_SKILL_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "read",
  "focus",
  "web_search",
  "close_tab",
]);

export function isTerminalSkillAction(action: ActionType): boolean {
  return TERMINAL_SKILL_ACTIONS.has(action);
}

/**
 * Compact capability advertisement for the model's [AVAILABLE SKILLS] section.
 * Lists ONLY executable (tested/approved/trusted, enabled) skills. Returns ""
 * when none exist, so the section is omitted entirely.
 *
 * This is capability metadata, never a procedure: the model names an id and
 * supplies inputs; the trusted registry holds the actual steps.
 */
export function describeAvailableSkills(registry: SkillRegistry): string {
  const lines: string[] = [];
  for (const summary of registry.discover()) {
    // The registry's execution policy is authoritative: candidates, disabled,
    // and any withheld `tested`/`canary` skills are not advertised.
    if (!registry.isExecutable(summary.id)) continue;
    const inputs = registry.get(summary.id)?.requiredInputs ?? [];
    const inputText =
      inputs.length === 0
        ? "none"
        : inputs.map((i) => `${i.name}${i.required ? " (required)" : "?"}`).join(", ");
    lines.push(`- ${summary.id}: ${summary.description} inputs: ${inputText}`);
  }
  if (lines.length === 0) return "";
  lines.push(
    'Emit {"type":"skill","skill_id":"<id>","input":{...}} to run one of these instead of low-level steps.',
  );
  return lines.join("\n");
}

// --- Shared resolution helpers (pure, reused by every built-in skill) --------

const ELEMENT_HANDLE_RE = /^e\d+$/;
const REGION_HANDLE_RE = /^r\d+$/;

export function isElementHandle(id: string): boolean {
  return ELEMENT_HANDLE_RE.test(id);
}

export function isRegionHandle(id: string): boolean {
  return REGION_HANDLE_RE.test(id);
}

/** Case/space-insensitive name comparison key. Never a selector. */
export function normalizedName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** First `max` characters of readable text, single-spaced — never HTML. */
export function excerpt(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max).trimEnd();
}

// --- The fail-closed plan gate ----------------------------------------------

function denied(
  skillId: string,
  version: string,
  pageGeneration: number,
  status: SkillPlanStatus,
  reason: string,
): SkillPlan {
  return {
    skillId,
    skillVersion: version,
    pageGeneration,
    status,
    reason,
    actions: [],
    verification: [],
    result: {},
  };
}

/**
 * Builds a plan for one skill against the current page state.
 *
 * Order of gates:
 *  1. catalog entry present? else unknown_skill.
 *  2. registry has it? else unknown_skill.
 *  3. registry says executable? else not_executable (disabled/candidate).
 *  4. run the resolver.
 *  5. re-validate EVERY generated action against the closed schema; any
 *     failure rejects the whole plan (invalid_plan). pageGeneration is stamped
 *     from the snapshot.
 *
 * Never throws — a resolver that throws becomes invalid_plan, so a faulty
 * skill cannot crash the agent.
 */
export function planSkill(args: {
  /** A registry or a frozen registry snapshot; snapshots pin the active version. */
  registry: SkillRegistryView;
  catalog: SkillCatalog;
  skillId: string;
  snapshot: SkillPageSnapshot;
  inputs?: SkillInputs;
}): SkillPlan {
  const { registry, catalog, skillId, snapshot } = args;
  const inputs = args.inputs ?? {};
  const generation = snapshot.generation;

  const entry = catalog.get(skillId);
  if (entry === null) {
    return denied(skillId, "0.0.0", generation, "unknown_skill", `unknown skill "${skillId}"`);
  }
  const version = entry.skill.version;

  const registered = registry.get(skillId);
  if (registered === null) {
    return denied(skillId, version, generation, "unknown_skill", `skill "${skillId}" is not registered`);
  }
  // A plan may only run the implementation the trusted catalog defines. If the
  // active version differs from the catalog's, the code and metadata disagree —
  // fail closed rather than run an unknown implementation.
  if (registered.version !== version) {
    return denied(
      skillId,
      version,
      generation,
      "not_executable",
      `active version ${registered.version} does not match skill version ${version}`,
    );
  }
  if (!registry.isExecutable(skillId)) {
    return denied(
      skillId,
      version,
      generation,
      "not_executable",
      `skill "${skillId}" is ${registered.status} and cannot execute`,
    );
  }

  let draft: SkillResolutionDraft;
  try {
    draft = entry.resolve(snapshot, inputs);
  } catch (err) {
    return denied(
      skillId,
      version,
      generation,
      "invalid_plan",
      `resolver failed: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  // Stamp the generation from the snapshot this plan was derived from.
  const actions: StructuredAction[] = (draft.actions ?? []).map((action) => ({
    ...action,
    pageGeneration: generation,
  }));

  // Fail closed: every generated action must satisfy the SAME closed schema
  // WebGuard enforces. Unknown action types, smuggled fields, bad targets, and
  // non-http(s) URLs are all rejected here.
  for (const action of actions) {
    const checked = validateStructuredAction(action);
    if (!checked.ok) {
      return denied(
        skillId,
        version,
        generation,
        "invalid_plan",
        `generated action rejected: ${checked.errors.join("; ")}`,
      );
    }
  }

  return {
    skillId,
    skillVersion: version,
    pageGeneration: generation,
    status: draft.status,
    ...(draft.reason !== undefined ? { reason: draft.reason } : {}),
    actions,
    verification: draft.verification ?? [],
    result: draft.result ?? {},
  };
}
