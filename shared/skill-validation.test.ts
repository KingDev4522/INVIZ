/**
 * Skill contract validation tests (Phase 1).
 * Proves skills can only describe existing INVIZ actions and that malformed
 * skills are rejected before they ever reach the registry.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  validateSkill,
  validateSkillActionType,
  isSkillExecutable,
  isSkillCandidate,
} from "./skill-validation.js";
import type { Skill } from "./types.js";

function validSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "github_find_contributors",
    namespace: "github",
    name: "Find contributors",
    version: "1.0.0",
    description: "Find the contributor list on a GitHub repository page.",
    supportedIntents: ["find contributors", "who contributed"],
    examples: ["Check the collaborators of this GitHub repository."],
    status: "tested",
    testStatus: "passing",
    createdAt: 1_000_000,
    modifiedAt: 1_000_000,
    createdBy: "human",
    requiredInputs: [],
    requiredCapabilities: ["read_page"],
    procedure: [
      {
        description: "Read the contributors region",
        action: "read",
        target: "r1",
      },
    ],
    verificationCriteria: [
      { description: "Contributors region visible", type: "element_present", target: "e1" },
    ],
    recoveryStrategies: [
      {
        trigger: "element_not_found",
        action: "scroll down and retry",
        maxAttempts: 2,
        escalateOnExhaustion: true,
      },
    ],
    testFilePaths: ["tests/find-contributors.test.ts"],
    lastTestedAt: null,
    lastTestResult: null,
    canaryRolloutPercent: 0,
    canaryStartedAt: null,
    ...overrides,
  };
}

describe("validateSkill", () => {
  it("accepts a well-formed skill", () => {
    const result = validateSkill(validSkill());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a skill whose procedure uses a non-existent action", () => {
    const skill = validSkill({
      procedure: [
        {
          description: "execute arbitrary javascript",
          action: "eval" as unknown as Skill["procedure"][number]["action"],
        },
      ],
    });
    const result = validateSkill(skill);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("not a valid ActionType");
  });

  it("rejects a skill with an unknown outcome/expectation type", () => {
    const skill = validSkill({
      verificationCriteria: [
        {
          description: "bad criterion",
          type: "anything_goes" as unknown as Skill["verificationCriteria"][number]["type"],
        },
      ],
    });
    const result = validateSkill(skill);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("not a valid ExpectationType");
  });

  it("rejects a non-SemVer version", () => {
    const result = validateSkill(validSkill({ version: "v1" }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("not valid SemVer");
  });

  it("rejects a candidate-unapproved status value", () => {
    const result = validateSkill(
      validSkill({ status: "totally_trusted" as unknown as Skill["status"] }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("status");
  });

  it("rejects an unknown required capability", () => {
    const result = validateSkill(
      validSkill({
        requiredCapabilities: ["rm_rf"] as unknown as Skill["requiredCapabilities"],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("not a valid capability");
  });

  it("rejects a procedure step with a bad target handle", () => {
    const skill = validSkill({
      procedure: [{ description: "click it", action: "click", target: "css:#submit" }],
    });
    const result = validateSkill(skill);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("must match eNN");
  });

  it("rejects an empty procedure", () => {
    const result = validateSkill(validSkill({ procedure: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("at least one step");
  });

  it("rejects a non-object input", () => {
    const result = validateSkill("not a skill");
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("must be an object");
  });
});

describe("validateSkill — Phase 4 status & malformed contracts", () => {
  it("accepts the canary status", () => {
    expect(validateSkill(validSkill({ status: "canary" })).valid).toBe(true);
  });

  it("fails closed on malformed metadata", () => {
    expect(validateSkill(validSkill({ namespace: "  " })).valid).toBe(false);
    expect(validateSkill(validSkill({ name: "" })).valid).toBe(false);
    expect(
      validateSkill(validSkill({ createdBy: "" as unknown as Skill["createdBy"] })).valid,
    ).toBe(false);
  });

  it("fails closed on a malformed input schema", () => {
    const result = validateSkill(
      validSkill({
        requiredInputs: [
          { name: "regionId", description: "a region" } as unknown as Skill["requiredInputs"][number],
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("requiredInputs[0].required");
  });

  it("fails closed on a malformed procedure step", () => {
    const missingAction = validateSkill(
      validSkill({
        procedure: [
          { description: "do a thing" } as unknown as Skill["procedure"][number],
        ],
      }),
    );
    expect(missingAction.valid).toBe(false);
    expect(missingAction.errors.join(" ")).toContain("action");

    const missingDescription = validateSkill(
      validSkill({
        procedure: [
          { action: "read", target: "r1" } as unknown as Skill["procedure"][number],
        ],
      }),
    );
    expect(missingDescription.valid).toBe(false);
    expect(missingDescription.errors.join(" ")).toContain("description");
  });
});

describe("validateSkillActionType (ActionType compatibility)", () => {
  it("accepts every existing INVIZ action", () => {
    for (const action of [
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
      "browser_search",
    ]) {
      expect(validateSkillActionType(action)).toBe(true);
    }
  });

  it("rejects arbitrary/unsafe verbs", () => {
    for (const action of ["eval", "execute_javascript", "cdp", "shell", "run"]) {
      expect(validateSkillActionType(action)).toBe(false);
    }
    expect(validateSkillActionType(42)).toBe(false);
    expect(validateSkillActionType(undefined)).toBe(false);
  });
});

describe("trust gating helpers", () => {
  it("marks tested/approved/canary/trusted as trust-qualified", () => {
    expect(isSkillExecutable("candidate")).toBe(false);
    expect(isSkillExecutable("tested")).toBe(true);
    expect(isSkillExecutable("approved")).toBe(true);
    expect(isSkillExecutable("canary")).toBe(true);
    expect(isSkillExecutable("trusted")).toBe(true);
    expect(isSkillExecutable("disabled")).toBe(false);
  });

  it("candidate is a distinct state", () => {
    expect(isSkillCandidate("candidate")).toBe(true);
    expect(isSkillCandidate("trusted")).toBe(false);
  });
});
