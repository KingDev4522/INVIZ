/**
 * Skill planning gate tests (Phase 2).
 * Proves the plan gate fails closed: unknown/disabled/candidate skills never
 * plan, and a resolver that emits anything outside the closed StructuredAction
 * schema is rejected wholesale. No chrome, no network.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { SkillRegistry } from "./registry.js";
import { createSkillCatalog, planSkill, type SkillResolver } from "./plan.js";
import type { Skill, StructuredAction } from "../../../shared/types.js";

function fakeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "test_skill",
    namespace: "test",
    name: "Test skill",
    version: "1.0.0",
    description: "A skill used by the planning-gate tests.",
    supportedIntents: ["test"],
    examples: ["test it"],
    status: "approved",
    testStatus: "passing",
    createdAt: 1_000_000,
    modifiedAt: 1_000_000,
    createdBy: "human",
    requiredInputs: [],
    requiredCapabilities: ["read_page"],
    procedure: [{ description: "read", action: "read", target: "r1" }],
    verificationCriteria: [{ description: "ok", type: "element_present", target: "e1" }],
    recoveryStrategies: [],
    testFilePaths: [],
    lastTestedAt: null,
    lastTestResult: null,
    canaryRolloutPercent: 0,
    canaryStartedAt: null,
    ...overrides,
  };
}

function snapshot(generation = 42) {
  return { url: "https://example.com/", title: "Example", generation, items: [] };
}

function registryWith(skill: Skill): SkillRegistry {
  const registry = new SkillRegistry();
  const result = registry.register(skill);
  if (!result.ok) throw new Error(`fixture did not register: ${result.errors.join("; ")}`);
  return registry;
}

describe("planSkill fail-closed gates", () => {
  it("rejects an unknown skill id", () => {
    const plan = planSkill({
      registry: registryWith(fakeSkill()),
      catalog: createSkillCatalog([]),
      skillId: "nope",
      snapshot: snapshot(),
    });
    expect(plan.status).toBe("unknown_skill");
    expect(plan.actions).toEqual([]);
  });

  it("rejects a catalog entry that is not registered", () => {
    const resolve: SkillResolver = () => ({ status: "ready", actions: [] });
    const plan = planSkill({
      registry: new SkillRegistry(),
      catalog: createSkillCatalog([{ skill: fakeSkill(), resolve }]),
      skillId: "test_skill",
      snapshot: snapshot(),
    });
    expect(plan.status).toBe("unknown_skill");
  });

  it("rejects a disabled skill (kill-switch)", () => {
    const resolve: SkillResolver = () => ({
      status: "ready",
      actions: [{ action: "read", target: "r1" }],
    });
    const plan = planSkill({
      registry: registryWith(fakeSkill({ status: "disabled" })),
      catalog: createSkillCatalog([{ skill: fakeSkill({ status: "disabled" }), resolve }]),
      skillId: "test_skill",
      snapshot: snapshot(),
    });
    expect(plan.status).toBe("not_executable");
    expect(plan.actions).toEqual([]);
  });

  it("rejects a candidate skill before approval", () => {
    const skill = fakeSkill({ status: "candidate", testStatus: "untested" });
    const resolve: SkillResolver = () => ({
      status: "ready",
      actions: [{ action: "read", target: "r1" }],
    });
    const plan = planSkill({
      registry: registryWith(skill),
      catalog: createSkillCatalog([{ skill, resolve }]),
      skillId: "test_skill",
      snapshot: snapshot(),
    });
    expect(plan.status).toBe("not_executable");
  });

  it("stamps the snapshot generation onto every generated action", () => {
    const resolve: SkillResolver = () => ({
      status: "ready",
      actions: [{ action: "read", target: "r1" }],
      verification: [{ description: "ok", type: "text_present", value: "hi" }],
    });
    const plan = planSkill({
      registry: registryWith(fakeSkill()),
      catalog: createSkillCatalog([{ skill: fakeSkill(), resolve }]),
      skillId: "test_skill",
      snapshot: snapshot(77),
    });
    expect(plan.status).toBe("ready");
    expect(plan.pageGeneration).toBe(77);
    expect(plan.actions[0]?.pageGeneration).toBe(77);
  });
});

describe("planSkill rejects unsafe generated actions (invalid_plan)", () => {
  function planWith(actions: StructuredAction[]) {
    const resolve: SkillResolver = () => ({ status: "ready", actions });
    return planSkill({
      registry: registryWith(fakeSkill()),
      catalog: createSkillCatalog([{ skill: fakeSkill(), resolve }]),
      skillId: "test_skill",
      snapshot: snapshot(),
    });
  }

  it("rejects an arbitrary JavaScript action verb", () => {
    const plan = planWith([
      { action: "execute_javascript" as unknown as StructuredAction["action"], target: "e1" },
    ]);
    expect(plan.status).toBe("invalid_plan");
    expect(plan.actions).toEqual([]);
  });

  it("rejects a click with no target", () => {
    expect(planWith([{ action: "click" }]).status).toBe("invalid_plan");
  });

  it("rejects a navigate to a non-http(s) URL", () => {
    const plan = planWith([
      { action: "navigate", parameters: { url: "javascript:alert(1)" } },
    ]);
    expect(plan.status).toBe("invalid_plan");
  });

  it("rejects an action carrying a smuggled field", () => {
    const plan = planWith([
      { action: "read", target: "r1", script: "alert(1)" } as unknown as StructuredAction,
    ]);
    expect(plan.status).toBe("invalid_plan");
  });

  it("rejects a resolver that throws", () => {
    const resolve: SkillResolver = () => {
      throw new Error("boom");
    };
    const plan = planSkill({
      registry: registryWith(fakeSkill()),
      catalog: createSkillCatalog([{ skill: fakeSkill(), resolve }]),
      skillId: "test_skill",
      snapshot: snapshot(),
    });
    expect(plan.status).toBe("invalid_plan");
  });
});

describe("planSkill version & snapshot integrity (Phase 4)", () => {
  it("fails closed when the active version does not match the skill's version", () => {
    const reg = new SkillRegistry();
    reg.register(fakeSkill({ version: "2.0.0", status: "approved" }));
    const resolve: SkillResolver = () => ({
      status: "ready",
      actions: [{ action: "read", target: "r1" }],
    });
    const plan = planSkill({
      registry: reg,
      catalog: createSkillCatalog([{ skill: fakeSkill({ version: "1.0.0" }), resolve }]),
      skillId: "test_skill",
      snapshot: snapshot(),
    });
    expect(plan.status).toBe("not_executable");
    expect(plan.actions).toEqual([]);
  });

  it("plans against a frozen snapshot, unaffected by later registry mutation", () => {
    const reg = new SkillRegistry();
    reg.register(fakeSkill({ version: "1.0.0", status: "approved" }));
    const resolve: SkillResolver = () => ({
      status: "ready",
      actions: [{ action: "read", target: "r1" }],
    });
    const catalog = createSkillCatalog([{ skill: fakeSkill({ version: "1.0.0" }), resolve }]);
    const snap = reg.snapshot();
    // Mutate the live registry after the snapshot was taken.
    reg.setStatus("test_skill", "disabled");

    const fromSnapshot = planSkill({
      registry: snap,
      catalog,
      skillId: "test_skill",
      snapshot: snapshot(),
    });
    expect(fromSnapshot.status).toBe("ready");

    const fromLive = planSkill({
      registry: reg,
      catalog,
      skillId: "test_skill",
      snapshot: snapshot(),
    });
    expect(fromLive.status).toBe("not_executable");
  });
});
