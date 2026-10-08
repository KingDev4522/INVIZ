/**
 * Candidate Skill generation & validation tests (Phase 6).
 * Proves a successful episode yields a DATA-ONLY proposal that can never
 * execute, never inherits trust, never shadows a built-in, and only enters the
 * EXISTING Phase 4 trust lifecycle through explicit gated transitions.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  markCandidateTests,
  proposeCandidateFromEpisode,
  registerCandidate,
  slugifyGoal,
  validateCandidate,
  type SkillCandidate,
} from "./candidate.js";
import {
  EPISODE_SCHEMA_VERSION,
  type Episode,
  type EpisodeActionRecord,
} from "../../../shared/episode.js";
import { SkillRegistry } from "../skills/registry.js";
import { planSkill, createSkillCatalog } from "../skills/plan.js";
import { registerBuiltinSkills } from "../skills/builtin/index.js";
import type { Skill } from "../../../shared/types.js";

// --- Fixtures ----------------------------------------------------------------

function record(overrides: Partial<EpisodeActionRecord> = {}): EpisodeActionRecord {
  return {
    index: 0,
    action: {
      action: "click",
      target: "e2",
      pageGeneration: 5,
      expect: { type: "element_present", target: "e2" },
    },
    pageGeneration: 5,
    status: "executed",
    verification: {
      success: true,
      outcome: "VERIFIED_SUCCESS",
      timedOut: false,
      pageGeneration: 5,
    },
    ...overrides,
  };
}

function successEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: "ep_task_1",
    taskId: "task_1",
    createdAt: 1_000_000,
    recordedAt: 1_001_000,
    goal: "Find the contributors of this repository",
    goalLang: "en",
    pageUrl: "https://github.com/example/project",
    pageTitle: "example/project",
    pageGenerations: [5],
    selectedSkill: null,
    actions: [record()],
    recoveryEvents: 0,
    finalOutcomeType: "task_complete",
    finalOutcomeText: "Done.",
    finalStatus: "COMPLETE",
    success: true,
    completedActions: 1,
    registrySnapshot: [],
    ...overrides,
  };
}

function candidate(): SkillCandidate {
  const proposed = proposeCandidateFromEpisode(successEpisode());
  if (proposed.candidate === undefined) {
    throw new Error(`fixture did not propose: ${proposed.errors.join("; ")}`);
  }
  return proposed.candidate;
}

function skill(overrides: Partial<Skill> = {}): Skill {
  return { ...candidate().skill, ...overrides };
}

// --- 12–14: proposal from a successful episode -------------------------------

describe("proposal from a successful episode", () => {
  it("12: a successful episode produces a candidate proposal", () => {
    const { candidate: proposed, errors } = proposeCandidateFromEpisode(successEpisode());
    expect(errors).toEqual([]);
    expect(proposed).toBeDefined();
    expect(proposed?.skill.status).toBe("candidate");
    expect(proposed?.skill.namespace).toBe("learned");
    expect(proposed?.skill.version).toBe("1.0.0");
    expect(proposed?.skill.procedure.length).toBe(1);
    expect(proposed?.skill.verificationCriteria.length).toBeGreaterThan(0);
  });

  it("12: a failed episode produces no proposal", () => {
    const { candidate: proposed, errors } = proposeCandidateFromEpisode(
      successEpisode({ success: false, finalStatus: "FAILED" }),
    );
    expect(proposed).toBeUndefined();
    expect(errors.join(" ")).toContain("not a success");
  });

  it("13: the candidate retains provenance to its source episode", () => {
    expect(candidate().sourceEpisodeIds).toEqual(["ep_task_1"]);
    expect(candidate().evidence.successfulActions).toBe(1);
    expect(candidate().skill.createdBy).toBe("episode_miner");
  });

  it("14: the candidate is never executable", () => {
    const registry = new SkillRegistry();
    const result = registerCandidate(candidate(), registry);
    expect(result.ok).toBe(true);
    // Trust gate: a candidate is not executable.
    expect(registry.isExecutable(candidate().skill.id)).toBe(false);
    expect(registry.isEnabled(candidate().skill.id)).toBe(true);
    // Resolver gate: nothing puts a generated proposal in the trusted catalog,
    // so the plan gate refuses it before any action exists.
    const plan = planSkill({
      registry,
      catalog: createSkillCatalog([]),
      skillId: candidate().skill.id,
      snapshot: { url: "https://example.com/", title: "E", generation: 1, items: [] },
    });
    expect(plan.status).toBe("unknown_skill");
    expect(plan.actions).toEqual([]);
  });

  it("derives a stable, well-formed id from the goal", () => {
    expect(slugifyGoal("Find the contributors!")).toBe("find_the_contributors");
    expect(slugifyGoal("   ")).toBe("unnamed");
    expect(slugifyGoal("नमस्ते")).toBe("unnamed");
  });
});

// --- 15–20: deterministic candidate validation --------------------------------

describe("candidate validation fails closed", () => {
  it("15: a candidate without provenance is invalid", () => {
    const bad = { ...candidate(), sourceEpisodeIds: [] };
    const result = validateCandidate(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("provenance");
  });

  it("15: a structurally invalid candidate is invalid", () => {
    const result = validateCandidate({ ...candidate(), skill: {} as Skill });
    expect(result.valid).toBe(false);
  });

  it("16: an unknown ActionType is rejected", () => {
    const result = validateCandidate({
      ...candidate(),
      skill: skill({
        procedure: [
          { description: "run it", action: "run_command" as unknown as "click" },
        ],
      }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("ActionType");
  });

  it("17: JavaScript / eval is rejected, including a smuggled field", () => {
    const evalAction = validateCandidate({
      ...candidate(),
      skill: skill({
        procedure: [{ description: "x", action: "eval" as unknown as "click" }],
      }),
    });
    expect(evalAction.valid).toBe(false);
    expect(evalAction.errors.join(" ")).toContain("ActionType");

    const smuggled = validateCandidate({
      ...candidate(),
      skill: skill({
        procedure: [
          {
            description: "x",
            action: "read",
            target: "r1",
            script: "alert(1)",
          } as unknown as Skill["procedure"][number],
        ],
      }),
    });
    expect(smuggled.valid).toBe(false);
    expect(smuggled.errors.join(" ")).toContain("forbidden field");
  });

  it("18: CDP is rejected", () => {
    const result = validateCandidate({
      ...candidate(),
      skill: skill({
        procedure: [
          { description: "x", action: "cdp_evaluate" as unknown as "click" },
        ],
      }),
    });
    expect(result.valid).toBe(false);
  });

  it("19: shell is rejected", () => {
    const result = validateCandidate({
      ...candidate(),
      skill: skill({
        procedure: [
          { description: "x", action: "shell_exec" as unknown as "click" },
        ],
      }),
    });
    expect(result.valid).toBe(false);
  });

  it("20: malformed required inputs are rejected", () => {
    const result = validateCandidate({
      ...candidate(),
      skill: skill({
        requiredInputs: [
          { name: "regionId", description: "a region" } as unknown as Skill["requiredInputs"][number],
        ],
      }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("requiredInputs");
  });

  it("a candidate with no verification criteria is rejected", () => {
    const result = validateCandidate({
      ...candidate(),
      skill: skill({ verificationCriteria: [] }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("verificationCriteria");
  });

  it("rejects an action whose StructuredAction schema fails", () => {
    const result = validateCandidate({
      ...candidate(),
      skill: skill({
        procedure: [{ description: "x", action: "click" }], // click needs a target
      }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("target");
  });
});

// --- 21–22: built-in protection & no trust inheritance ------------------------

describe("built-in protection and trust inheritance", () => {
  it("21: a candidate cannot shadow or overwrite a trusted built-in", () => {
    const registry = new SkillRegistry();
    registerBuiltinSkills(registry);
    const before = registry.get("github_find_contributors");

    const result = registerCandidate(
      { ...candidate(), skill: skill({ id: "github_find_contributors" }) },
      registry,
    );
    expect(result.ok).toBe(false);
    expect(result.validation.errors.join(" ")).toContain("already exists");
    expect(registry.get("github_find_contributors")).toEqual(before);
  });

  it("21: a candidate id colliding with any registered skill is refused", () => {
    const registry = new SkillRegistry();
    registry.register(skill());
    const result = registerCandidate(candidate(), registry);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("already exists");
    // The registry's own duplicate guard is also still in force.
    expect(registry.register(candidate().skill).errors.join(" ")).toContain(
      "already registered",
    );
  });

  it("22: a candidate cannot claim trust through metadata", () => {
    const proposed = proposeCandidateFromEpisode(successEpisode());
    expect(proposed.candidate?.skill.status).toBe("candidate");
    const approved = validateCandidate({
      ...candidate(),
      skill: skill({ status: "approved" }),
    });
    expect(approved.valid).toBe(false);
    expect(approved.errors.join(" ")).toContain('"approved"');
    const trusted = validateCandidate({
      ...candidate(),
      skill: skill({ status: "trusted" }),
    });
    expect(trusted.valid).toBe(false);
  });

  it("22: registration confers no execution rights", () => {
    const registry = new SkillRegistry();
    registerCandidate(candidate(), registry);
    expect(registry.isExecutable(candidate().skill.id)).toBe(false);
  });
});

// --- 23–25: the EXISTING Phase 4 trust lifecycle ------------------------------

describe("candidate promotion uses the Phase 4 trust system", () => {
  function registered(): SkillRegistry {
    const registry = new SkillRegistry();
    const result = registerCandidate(candidate(), registry);
    if (!result.ok) throw new Error(result.errors.join("; "));
    return registry;
  }

  it("23: a candidate cannot skip to tested without passing tests", () => {
    const registry = registered();
    const id = candidate().skill.id;
    expect(registry.setStatus(id, "tested").ok).toBe(false);
    expect(registry.setStatus(id, "approved", { approver: "policy" }).ok).toBe(false);
    expect(registry.setStatus(id, "trusted", { canaryComplete: true }).ok).toBe(false);
    expect(registry.get(id)?.status).toBe("candidate");
  });

  it("23+24: an approved candidate enters the existing registry lifecycle", () => {
    const registry = registered();
    const id = candidate().skill.id;
    const tested = markCandidateTests(registry.get(id) as Skill, {
      passing: true,
      summary: "all green",
    });
    expect(registry.register(tested, { replace: true }).ok).toBe(true);
    expect(registry.setStatus(id, "tested").ok).toBe(true);
    expect(registry.setStatus(id, "approved", { approver: "human reviewer" }).ok).toBe(true);
    expect(registry.get(id)?.status).toBe("approved");
    expect(registry.isExecutable(id)).toBe(true);
  });

  it("25: canary and trusted use Phase 4 mechanisms", () => {
    const registry = registered();
    const id = candidate().skill.id;
    registry.register(
      markCandidateTests(registry.get(id) as Skill, { passing: true, summary: "ok" }),
      { replace: true },
    );
    registry.setStatus(id, "tested");
    registry.setStatus(id, "approved", { approver: "human reviewer" });
    // Canary still demands an explicit opt-in to be executable.
    expect(registry.setStatus(id, "canary", { canaryRolloutPercent: 10 }).ok).toBe(true);
    expect(registry.isExecutable(id)).toBe(false);
    expect(registry.setStatus(id, "trusted").ok).toBe(false);
    expect(registry.setStatus(id, "trusted", { canaryComplete: true }).ok).toBe(true);
    expect(registry.get(id)?.status).toBe("trusted");
  });

  it("26: rollback remains functional after promotion", () => {
    const registry = new SkillRegistry();
    registry.register(skill({ version: "1.0.0", status: "trusted" }));
    registry.register(
      skill({ version: "2.0.0", status: "candidate", testStatus: "untested" }),
    );
    expect(registry.get(candidate().skill.id)?.version).toBe("2.0.0");
    expect(registry.rollback(candidate().skill.id, "1.0.0").ok).toBe(true);
    expect(registry.get(candidate().skill.id)?.version).toBe("1.0.0");
    expect(registry.isExecutable(candidate().skill.id)).toBe(true);
  });
});

// --- Generated candidates contain no arbitrary execution surface --------------

describe("generated procedures use only the existing action vocabulary", () => {
  it("every derived procedure action is an existing ActionType", () => {
    const proposed = proposeCandidateFromEpisode(
      successEpisode({
        actions: [
          record({
            action: {
              action: "click",
              target: "e2",
              pageGeneration: 5,
              expect: { type: "element_present", target: "e2" },
            },
          }),
          record({
            index: 1,
            action: {
              action: "navigate",
              pageGeneration: 6,
              parameters: { url: "https://x.example/" },
              expect: { type: "navigation_completed" },
            },
          }),
          record({ index: 2, action: { action: "read", target: "r1", pageGeneration: 7 } }),
        ],
      }),
    );
    const steps = proposed.candidate?.skill.procedure ?? [];
    expect(steps.length).toBe(3);
    for (const step of steps) {
      expect(["click", "navigate", "read"]).toContain(step.action);
    }
    expect(validateCandidate(proposed.candidate as SkillCandidate).valid).toBe(true);
  });
});
