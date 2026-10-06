/**
 * Skill Registry tests (Phase 1).
 * Covers registration, lookup, discovery, version comparison, trust-state
 * gating (candidate can never become trusted), disabled rejection, and
 * rollback. No chrome, no network.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  SkillRegistry,
  canTransition,
  compareVersions,
  parseVersion,
} from "./registry.js";
import type { Skill } from "../../../shared/types.js";
import { skillContentHash } from "../../../shared/skill-integrity.js";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "generic_read_region",
    namespace: "generic",
    name: "Read a region",
    version: "1.0.0",
    description: "Read a named region of a page aloud.",
    supportedIntents: ["read this", "read the article"],
    examples: ["Read the main content."],
    status: "tested",
    testStatus: "passing",
    createdAt: 1_000_000,
    modifiedAt: 1_000_000,
    createdBy: "human",
    requiredInputs: [],
    requiredCapabilities: ["read_page"],
    procedure: [{ description: "read region", action: "read", target: "r1" }],
    verificationCriteria: [
      { description: "region present", type: "element_present", target: "e1" },
    ],
    recoveryStrategies: [],
    testFilePaths: [],
    lastTestedAt: null,
    lastTestResult: null,
    canaryRolloutPercent: 0,
    canaryStartedAt: null,
    ...overrides,
  };
}

describe("version parsing/comparison", () => {
  it("parses SemVer triples", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("v1.2.3")).toBeNull();
  });

  it("orders versions correctly", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("refuses to compare non-SemVer", () => {
    expect(() => compareVersions("latest", "1.0.0")).toThrow();
  });
});

describe("SkillRegistry registration & lookup", () => {
  it("registers a valid skill and returns it by id", () => {
    const reg = new SkillRegistry();
    const result = reg.register(skill());
    expect(result.ok).toBe(true);
    expect(reg.get("generic_read_region")?.name).toBe("Read a region");
    expect(reg.size).toBe(1);
  });

  it("rejects an invalid skill", () => {
    const reg = new SkillRegistry();
    const result = reg.register(skill({ id: "Bad Id" }));
    expect(result.ok).toBe(false);
    expect(reg.size).toBe(0);
  });

  it("rejects duplicate id+version registration by default", () => {
    const reg = new SkillRegistry();
    reg.register(skill());
    const again = reg.register(skill({ description: "a different desc" }));
    expect(again.ok).toBe(false);
    expect(again.errors.join(" ")).toContain("already registered");
  });

  it("never silently replaces a trusted skill", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "trusted" }));
    const replace = reg.register(skill({ description: "sneaky new body" }), {
      replace: true,
    });
    expect(replace.ok).toBe(false);
    expect(replace.errors.join(" ")).toContain("refusing to silently replace");
    // Original untouched.
    expect(reg.get("generic_read_region")?.description).toBe(
      "Read a named region of a page aloud.",
    );
  });

  it("resolves the highest version by default and specific versions on request", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ version: "1.0.0" }));
    reg.register(skill({ version: "1.2.0" }));
    reg.register(skill({ version: "1.1.0" }));
    expect(reg.get("generic_read_region")?.version).toBe("1.2.0");
    expect(reg.getVersion("generic_read_region", "1.0.0")?.version).toBe("1.0.0");
    expect(reg.versions("generic_read_region")).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
  });

  it("returns null for unknown skills", () => {
    const reg = new SkillRegistry();
    expect(reg.get("nope")).toBeNull();
    expect(reg.getVersion("nope", "1.0.0")).toBeNull();
    expect(reg.versions("nope")).toEqual([]);
  });
});

describe("trust-state handling", () => {
  it("forbids candidate → trusted directly", () => {
    expect(canTransition("candidate", "trusted")).toBe(false);
    const reg = new SkillRegistry();
    reg.register(skill({ status: "candidate", testStatus: "untested" }));
    const promoted = reg.setStatus("generic_read_region", "trusted");
    expect(promoted.ok).toBe(false);
    expect(promoted.error).toContain("illegal transition");
    expect(reg.get("generic_read_region")?.status).toBe("candidate");
  });

  it("requires passing tests before candidate → tested", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "candidate", testStatus: "untested" }));
    const tested = reg.setStatus("generic_read_region", "tested");
    expect(tested.ok).toBe(false);
    expect(tested.error).toContain("cannot become tested");
  });

  it("requires an approver for tested → approved", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "tested", testStatus: "passing" }));
    expect(reg.setStatus("generic_read_region", "approved").ok).toBe(false);
    expect(reg.setStatus("generic_read_region", "approved", { approver: "reviewer" }).ok).toBe(true);
    expect(reg.get("generic_read_region")?.status).toBe("approved");
  });

  it("requires completed canary for approved → trusted", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "approved" }));
    expect(reg.setStatus("generic_read_region", "trusted").ok).toBe(false);
    expect(
      reg.setStatus("generic_read_region", "trusted", { canaryComplete: true }).ok,
    ).toBe(true);
    expect(reg.get("generic_read_region")?.status).toBe("trusted");
  });

  it("walks the full legal lifecycle", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "candidate", testStatus: "untested" }));
    expect(reg.setStatus("generic_read_region", "tested", { version: "1.0.0" }).ok).toBe(false);
    // Mark tests passing, then promote step by step.
    const v = reg.getVersion("generic_read_region", "1.0.0");
    expect(v).not.toBeNull();
    reg.register({ ...(v as Skill), testStatus: "passing" }, {
      replace: true,
    });
    expect(reg.setStatus("generic_read_region", "tested").ok).toBe(true);
    expect(reg.setStatus("generic_read_region", "approved", { approver: "policy" }).ok).toBe(true);
    expect(reg.setStatus("generic_read_region", "trusted", { canaryComplete: true }).ok).toBe(true);
    expect(reg.get("generic_read_region")?.status).toBe("trusted");
  });
});

describe("disabled & candidate rejection", () => {
  it("rejects a disabled skill for execution and as enabled", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "disabled" }));
    expect(reg.isEnabled("generic_read_region")).toBe(false);
    expect(reg.isExecutable("generic_read_region")).toBe(false);
  });

  it("does not treat a candidate as executable", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "candidate", testStatus: "untested" }));
    // A candidate is present (not disabled) but must never execute.
    expect(reg.isEnabled("generic_read_region")).toBe(true);
    expect(reg.isExecutable("generic_read_region")).toBe(false);
  });

  it("treats a trusted skill as executable", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "trusted" }));
    expect(reg.isEnabled("generic_read_region")).toBe(true);
    expect(reg.isExecutable("generic_read_region")).toBe(true);
  });
});

describe("discovery & filtering", () => {
  it("lists skills by namespace, status, capability, and search text", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ id: "generic_read_region", namespace: "generic", status: "trusted" }));
    reg.register(
      skill({
        id: "github_find_contributors",
        namespace: "github",
        status: "tested",
        description: "Find contributors on a repo page",
        supportedIntents: ["find contributors"],
        requiredCapabilities: ["read_page", "click"],
      }),
    );
    expect(reg.discover({ namespace: "github" }).map((s) => s.id)).toEqual([
      "github_find_contributors",
    ]);
    expect(reg.discover({ status: "trusted" }).map((s) => s.id)).toEqual([
      "generic_read_region",
    ]);
    expect(
      reg.discover({ status: ["tested", "approved"] }).map((s) => s.id),
    ).toEqual(["github_find_contributors"]);
    expect(reg.discover({ requiresCapability: "click" }).map((s) => s.id)).toEqual([
      "github_find_contributors",
    ]);
    expect(reg.discover({ search: "contributors" }).map((s) => s.id)).toEqual([
      "github_find_contributors",
    ]);
  });
});

describe("rollback", () => {
  it("rolls back to a previously registered version", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ version: "1.0.0", status: "trusted" }));
    reg.register(skill({ version: "2.0.0", status: "approved" }));
    const rollback = reg.rollback("generic_read_region", "1.0.0");
    expect(rollback.ok).toBe(true);
    expect(rollback.skill?.version).toBe("1.0.0");
  });

  it("refuses to roll back to a disabled version", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ version: "1.0.0", status: "disabled" }));
    const rollback = reg.rollback("generic_read_region", "1.0.0");
    expect(rollback.ok).toBe(false);
    expect(rollback.error).toContain("disabled");
  });

  it("reports an unknown rollback target", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ version: "1.0.0" }));
    expect(reg.rollback("generic_read_region", "9.9.9").ok).toBe(false);
  });
});

// --- Phase 4: execution policy ----------------------------------------------

describe("Phase 4 execution policy", () => {
  it("never executes a candidate and never treats it as executable", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "candidate", testStatus: "untested" }));
    expect(reg.isExecutable("generic_read_region")).toBe(false);
  });

  it("withholds a tested skill unless policy allows it", () => {
    const strict = new SkillRegistry();
    strict.register(skill({ status: "tested" }));
    expect(strict.isExecutable("generic_read_region")).toBe(false);

    const permissive = new SkillRegistry({
      executionPolicy: {
        executableStatuses: ["tested", "approved", "trusted"],
        allowCanary: false,
      },
    });
    permissive.register(skill({ status: "tested" }));
    expect(permissive.isExecutable("generic_read_region")).toBe(true);
  });

  it("executes approved and trusted skills by default", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ id: "a_approved", status: "approved" }));
    reg.register(skill({ id: "a_trusted", status: "trusted" }));
    expect(reg.isExecutable("a_approved")).toBe(true);
    expect(reg.isExecutable("a_trusted")).toBe(true);
  });

  it("gates a canary skill on explicit policy opt-in", () => {
    const off = new SkillRegistry();
    off.register(skill({ status: "canary" }));
    expect(off.isExecutable("generic_read_region")).toBe(false);

    const on = new SkillRegistry({
      executionPolicy: { executableStatuses: ["approved", "trusted"], allowCanary: true },
    });
    on.register(skill({ status: "canary" }));
    expect(on.isExecutable("generic_read_region")).toBe(true);
  });
});

// --- Phase 4: canary lifecycle -----------------------------------------------

describe("Phase 4 canary lifecycle", () => {
  it("walks approved → canary → trusted, requiring canary completion", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "approved" }));
    const toCanary = reg.setStatus("generic_read_region", "canary", {
      canaryRolloutPercent: 25,
    });
    expect(toCanary.ok).toBe(true);
    expect(reg.get("generic_read_region")?.status).toBe("canary");
    expect(reg.get("generic_read_region")?.canaryRolloutPercent).toBe(25);
    expect(reg.setStatus("generic_read_region", "trusted").ok).toBe(false);
    expect(
      reg.setStatus("generic_read_region", "trusted", { canaryComplete: true }).ok,
    ).toBe(true);
  });

  it("allows canary → approved (back out of a rollout)", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "approved" }));
    reg.setStatus("generic_read_region", "canary", { canaryRolloutPercent: 50 });
    expect(reg.setStatus("generic_read_region", "approved", { approver: "policy" }).ok).toBe(
      true,
    );
  });
});

// --- Phase 4: version integrity ----------------------------------------------

describe("Phase 4 version integrity", () => {
  it("refuses a different implementation under the same trusted version", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "trusted" }));
    const swapped = reg.register(
      skill({
        status: "trusted",
        procedure: [{ description: "exfiltrate", action: "read", target: "r9" }],
      }),
      { replace: true, allowTrustedReplacement: true },
    );
    expect(swapped.ok).toBe(false);
    expect(swapped.errors.join(" ")).toContain("different implementation");
    expect(reg.get("generic_read_region")?.procedure[0]?.target).toBe("r1");
  });

  it("permits refreshing the same implementation's trust state", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "approved" }));
    const promoted = reg.register(skill({ status: "trusted" }), {
      replace: true,
      allowTrustedReplacement: true,
    });
    expect(promoted.ok).toBe(true);
    expect(reg.get("generic_read_region")?.status).toBe("trusted");
  });
});

// --- Phase 4: new versions never inherit trust -------------------------------

describe("Phase 4 new-version trust", () => {
  it("refuses a new version registered as approved without a warrant", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ version: "1.0.0", status: "trusted" }));
    const next = reg.register(skill({ version: "1.1.0", status: "approved" }));
    expect(next.ok).toBe(false);
    expect(next.errors.join(" ")).toContain("must not inherit trust");
    expect(reg.getVersion("generic_read_region", "1.1.0")).toBeNull();
  });

  it("refuses a new version registered as trusted without a warrant", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ version: "1.0.0", status: "trusted" }));
    expect(reg.register(skill({ version: "2.0.0", status: "trusted" })).ok).toBe(false);
  });

  it("accepts a new version as candidate, or with an explicit warrant", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ version: "1.0.0", status: "trusted" }));
    expect(
      reg.register(skill({ version: "2.0.0", status: "candidate", testStatus: "untested" })).ok,
    ).toBe(true);
    expect(
      reg.register(skill({ version: "3.0.0", status: "approved" }), {
        approval: { approver: "policy" },
      }).ok,
    ).toBe(true);
    expect(reg.get("generic_read_region")?.version).toBe("3.0.0");
  });
});

// --- Phase 4: rollback at the version-selection layer ------------------------

describe("Phase 4 rollback", () => {
  it("makes the rolled-back version active and executable again", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ version: "1.0.0", status: "trusted" }));
    reg.register(skill({ version: "2.0.0", status: "candidate", testStatus: "untested" }));
    expect(reg.get("generic_read_region")?.version).toBe("2.0.0");
    expect(reg.rollback("generic_read_region", "1.0.0").ok).toBe(true);
    expect(reg.get("generic_read_region")?.version).toBe("1.0.0");
    expect(reg.isExecutable("generic_read_region")).toBe(true);
  });

  it("does not mutate the rolled-back skill definition", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ version: "1.0.0", status: "trusted" }));
    reg.register(skill({ version: "2.0.0", status: "candidate", testStatus: "untested" }));
    const before = skillContentHash(reg.getVersion("generic_read_region", "1.0.0") as Skill);
    reg.rollback("generic_read_region", "1.0.0");
    const after = skillContentHash(reg.getVersion("generic_read_region", "1.0.0") as Skill);
    expect(after).toBe(before);
  });
});

// --- Phase 4: registry snapshot ----------------------------------------------

describe("Phase 4 registry snapshot", () => {
  it("freezes the active version so a live mutation cannot change a plan's view", () => {
    const reg = new SkillRegistry();
    reg.register(skill({ version: "1.0.0", status: "approved" }));
    const snap = reg.snapshot();
    reg.register(skill({ version: "2.0.0", status: "candidate", testStatus: "untested" }));
    reg.rollback("generic_read_region", "1.0.0");
    reg.setStatus("generic_read_region", "disabled");
    expect(snap.get("generic_read_region")?.version).toBe("1.0.0");
    expect(snap.isExecutable("generic_read_region")).toBe(true);
    expect(reg.isExecutable("generic_read_region")).toBe(false);
  });
});
