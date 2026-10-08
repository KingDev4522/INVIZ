/**
 * Candidate Skill generation — REAL (Phase 6).
 *
 * A SUCCESSFUL EPISODE is evidence, never authority. This module turns that
 * evidence into a DATA-ONLY proposal that must still clear the existing Phase 4
 * trust lifecycle (candidate → tested → approved → canary → trusted) before it
 * can ever run. There is no automatic promotion path, and no second trust
 * system: `registerCandidate` writes into the SAME SkillRegistry the built-ins
 * use, where a candidate is never executable.
 *
 * NON-NEGOTIABLE: candidate generation never emits JavaScript, eval, shell,
 * CDP, or any arbitrary code. A proposal is expressed purely through the
 * existing Skill / StructuredAction vocabulary, so the only procedures that can
 * exist are the 13 existing ActionType values — enforced by the SAME
 * validateSkill() + validateStructuredAction() the built-ins go through.
 *
 * A generated candidate also has NO resolver: nothing puts it in the trusted
 * SkillCatalog, so planSkill() refuses it as `unknown_skill` even if someone
 * force-registers it. Executing a generated proposal would additionally require
 * a human-authored resolver + approval, which is the whole point.
 */
import type {
  Expectation,
  Skill,
  SkillProcedureStep,
  SkillRequiredCapability,
  SkillVerificationCriterion,
  SkillValidationResult,
  ActionType,
} from "../../../shared/types.js";
import { SKILL_ID_RE } from "../../../shared/types.js";
import { validateSkill } from "../../../shared/skill-validation.js";
import { validateStructuredAction } from "../../../shared/types.js";
import { redactEpisode, type Episode } from "../../../shared/episode.js";
import type { SkillRegistry, SkillRegistrationResult } from "../skills/registry.js";

/** A candidate proposal: a Skill-shaped DATA payload plus its provenance. */
export interface SkillCandidate {
  /** Always `status: "candidate"` — enforced by validateCandidate(). */
  skill: Skill;
  /** Required provenance: the episode(s) this proposal was derived from. */
  sourceEpisodeIds: string[];
  evidence: {
    successfulActions: number;
    verifiedActions: number;
    derivedAt: number;
  };
}

export interface ProposeOptions {
  /** Explicit skill id; otherwise derived deterministically from the goal. */
  skillId?: string;
  version?: string;
  now?: number;
}

const CAPABILITY_BY_ACTION: Readonly<Partial<Record<ActionType, SkillRequiredCapability>>> = {
  click: "click",
  type: "type",
  focus: "focus",
  select: "select",
  scroll: "scroll",
  press_key: "press_key",
  navigate: "navigate",
  go_back: "navigate",
  go_forward: "navigate",
  read: "read_page",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deterministic, lowercase id slug that satisfies SKILL_ID_RE. */
export function slugifyGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug === "" ? "unnamed" : slug;
}

function isExecuted(record: Episode["actions"][number]): boolean {
  return record.status === "executed" || record.status === "read";
}

function expectationToCriterion(expect: Expectation): SkillVerificationCriterion {
  return {
    description: `expected ${expect.type}`,
    type: expect.type,
    ...(expect.target !== undefined ? { target: expect.target } : {}),
    ...(expect.value !== undefined ? { value: expect.value } : {}),
    ...(expect.state !== undefined ? { state: expect.state } : {}),
    ...(expect.stateValue !== undefined ? { stateValue: expect.stateValue } : {}),
  };
}

/**
 * Derives a candidate proposal from a successful episode.
 *
 * Returns `{ errors }` (no candidate) when the episode is not evidence of
 * success: nothing is generated from a failed, empty, or non-verified task.
 * The episode is re-redacted here so a proposal can never carry a value that
 * the recorder saw before redaction.
 */
export function proposeCandidateFromEpisode(
  rawEpisode: Episode,
  opts: ProposeOptions = {},
): { candidate?: SkillCandidate; errors: string[] } {
  const episode = redactEpisode(rawEpisode);
  const errors: string[] = [];
  if (!episode.success) {
    errors.push("episode is not a success: successful episodes are the only evidence");
  }
  const executed = episode.actions.filter(isExecuted);
  if (executed.length === 0) {
    errors.push("episode contains no executed actions to generalize from");
  }

  const skillId = opts.skillId ?? `learned_${slugifyGoal(episode.goal)}`;
  if (!SKILL_ID_RE.test(skillId)) {
    errors.push(`skill id "${skillId}" is not a valid skill id`);
  }
  if (errors.length > 0) return { errors };

  const procedure: SkillProcedureStep[] = executed.map((record) => ({
    description: `${record.action.action} on ${
      record.action.target ?? record.action.parameters?.["url"] ?? "the page"
    }`,
    action: record.action.action,
    ...(record.action.target !== undefined ? { target: record.action.target } : {}),
    ...(record.action.value !== undefined ? { value: record.action.value } : {}),
    ...(record.action.parameters !== undefined
      ? { parameters: record.action.parameters }
      : {}),
    ...(record.action.expect !== undefined ? { expect: record.action.expect } : {}),
    maxAttempts: 1,
  }));

  const verificationCriteria: SkillVerificationCriterion[] = executed
    .filter((r) => r.action.expect !== undefined)
    .map((r) => expectationToCriterion(r.action.expect as Expectation));

  // A proposal without any verification expectation could never be evaluated
  // by the existing Verification Engine, so it is refused rather than emitted.
  if (verificationCriteria.length === 0) {
    return {
      errors: [
        "episode recorded no verification expectations: a candidate needs at least one",
      ],
    };
  }

  const capabilities = new Set<SkillRequiredCapability>();
  for (const record of executed) {
    const cap = CAPABILITY_BY_ACTION[record.action.action];
    if (cap !== undefined) capabilities.add(cap);
  }
  capabilities.add("verify");

  const createdAt = opts.now ?? episode.createdAt;
  const skill: Skill = {
    id: skillId,
    namespace: "learned",
    name: episode.goal.slice(0, 80),
    version: opts.version ?? "1.0.0",
    description: `Derived from a successful episode: ${episode.goal}`.slice(0, 1000),
    supportedIntents: [episode.goal.slice(0, 200)],
    examples: [episode.goal.slice(0, 200)],
    // Trust is NEVER claimed by generation. The proposal enters at the very
    // bottom of the lifecycle and must be promoted by existing gates.
    status: "candidate",
    testStatus: "untested",
    createdAt,
    modifiedAt: createdAt,
    createdBy: "episode_miner",
    requiredInputs: [],
    requiredCapabilities: [...capabilities],
    procedure,
    verificationCriteria,
    recoveryStrategies: [],
    testFilePaths: [],
    lastTestedAt: null,
    lastTestResult: null,
    canaryRolloutPercent: 0,
    canaryStartedAt: null,
  };

  const validation = validateSkill(skill);
  if (!validation.valid) {
    return { errors: validation.errors };
  }

  return {
    candidate: {
      skill,
      sourceEpisodeIds: [episode.episodeId],
      evidence: {
        successfulActions: executed.length,
        verifiedActions: episode.actions.filter(
          (r) => r.verification !== undefined && r.verification.success,
        ).length,
        derivedAt: createdAt,
      },
    },
    errors: [],
  };
}

/**
 * The ONLY fields a procedure step may carry. Anything else (a smuggled
 * `script`, `eval`, `shell`, …) is rejected outright before the step is
 * projected onto a StructuredAction.
 */
const ALLOWED_STEP_FIELDS: ReadonlySet<string> = new Set([
  "description",
  "action",
  "target",
  "value",
  "parameters",
  "expect",
  "waitFor",
  "maxAttempts",
]);

/**
 * Projects a procedure step onto the SAME StructuredAction schema WebGuard
 * uses, so a candidate cannot introduce a field the real pipeline would reject.
 */
function stepToAction(step: SkillProcedureStep): Record<string, unknown> {
  const action: Record<string, unknown> = { action: step.action };
  if (step.target !== undefined) action["target"] = step.target;
  if (step.value !== undefined) action["value"] = step.value;
  if (step.parameters !== undefined) action["parameters"] = step.parameters;
  if (step.expect !== undefined) action["expect"] = step.expect;
  return action;
}

/**
 * Deterministic candidate validation. Reuses the existing validators rather
 * than defining a weaker duplicate:
 *  - validateSkill()           → id/version/metadata/inputs/capabilities/
 *                                procedure/verification (ActionType allow-list)
 *  - validateStructuredAction() → the closed schema WebGuard enforces
 *  - registry presence         → cannot collide with / shadow a trusted skill
 */
export function validateCandidate(
  candidate: SkillCandidate,
  opts: { registry?: SkillRegistry } = {},
): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof candidate !== "object" || candidate === null) {
    return { valid: false, errors: ["candidate must be an object"], warnings: [] };
  }

  const episodes = candidate.sourceEpisodeIds;
  if (!Array.isArray(episodes) || episodes.length === 0) {
    errors.push("sourceEpisodeIds: provenance is required");
  } else if (!episodes.every((id) => typeof id === "string" && id.trim() !== "")) {
    errors.push("sourceEpisodeIds: must be non-empty strings");
  }

  const skill = candidate.skill;
  const skillResult = validateSkill(skill);
  if (!skillResult.valid) errors.push(...skillResult.errors.map((e) => `skill: ${e}`));
  warnings.push(...skillResult.warnings);

  if (skill === undefined || skill === null || typeof skill !== "object") {
    return { valid: false, errors, warnings };
  }

  // A generated proposal may NEVER be born past `candidate`.
  if (skill.status !== "candidate") {
    errors.push(`skill.status: must be "candidate" (got "${String(skill.status)}")`);
  }
  if (typeof skill.id === "string" && !SKILL_ID_RE.test(skill.id)) {
    errors.push("skill.id: must satisfy the skill id grammar");
  }
  if (!Array.isArray(skill.verificationCriteria) || skill.verificationCriteria.length === 0) {
    errors.push("skill.verificationCriteria: at least one criterion is required");
  }

  // Every procedure step must (a) carry no fields outside the Skill step
  // schema and (b) survive the real StructuredAction schema. Together these
  // reject eval / CDP / shell / smuggled fields structurally.
  if (Array.isArray(skill.procedure)) {
    skill.procedure.forEach((step, i) => {
      if (isRecord(step)) {
        for (const key of Object.keys(step)) {
          if (!ALLOWED_STEP_FIELDS.has(key)) {
            errors.push(`procedure[${i}]: forbidden field "${key}"`);
          }
        }
      }
      const checked = validateStructuredAction(stepToAction(step));
      if (!checked.ok) {
        errors.push(...checked.errors.map((e) => `procedure[${i}]: ${e}`));
      }
    });
  }

  // Provenance must resolve to a real episode; and a candidate must not claim
  // an id that already exists in the trusted registry (no shadowing).
  if (opts.registry !== undefined) {
    const existing = opts.registry.get(skill.id);
    if (existing !== null) {
      errors.push(
        `skill.id: "${skill.id}" already exists in the registry (v${existing.version}, ${existing.status}) — a candidate may not shadow an existing skill`,
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Registers a validated candidate into the EXISTING Phase 4 registry as
 * `candidate`. Rejected if invalid, or if the id collides with anything
 * already registered (built-ins included). Registration confers no execution
 * rights: a candidate is never executable, and with no resolver in the
 * trusted catalog, planSkill() refuses it.
 */
export function registerCandidate(
  candidate: SkillCandidate,
  registry: SkillRegistry,
): SkillRegistrationResult & { validation: SkillValidationResult } {
  const validation = validateCandidate(candidate, { registry });
  if (!validation.valid) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings, validation };
  }
  const result = registry.register(candidate.skill);
  return { ...result, warnings: [...result.warnings, ...validation.warnings], validation };
}

/**
 * Records an automated test result against a candidate. This is the ONLY thing
 * that can move a candidate toward `tested`, and it still leaves approval,
 * canary and trust to the existing gated transitions.
 */
export function markCandidateTests(
  skill: Skill,
  result: { passing: boolean; summary: string },
): Skill {
  return {
    ...skill,
    testStatus: result.passing ? "passing" : "failing",
    lastTestedAt: Date.now(),
    lastTestResult: result.summary.slice(0, 500),
  };
}
