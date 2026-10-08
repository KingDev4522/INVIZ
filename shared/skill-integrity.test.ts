/**
 * Skill integrity tests (Phase 4).
 * Proves the implementation fingerprint is deterministic, sensitive to any
 * behavioural change, and independent of mutable trust/rollout state — the
 * property that lets a trusted version refuse a silent swap.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  canonicalSkillContent,
  fingerprint64,
  skillContentHash,
} from "./skill-integrity.js";
import type { Skill } from "./types.js";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "github_find_contributors",
    namespace: "github",
    name: "Find contributors",
    version: "1.0.0",
    description: "Find the contributor list on a GitHub repository page.",
    supportedIntents: ["find contributors", "who contributed"],
    examples: ["Check the collaborators of this GitHub repository."],
    status: "approved",
    testStatus: "passing",
    createdAt: 1_000_000,
    modifiedAt: 1_000_000,
    createdBy: "human",
    requiredInputs: [],
    requiredCapabilities: ["read_page"],
    procedure: [
      { description: "Read the contributors region", action: "read", target: "r1" },
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

describe("skillContentHash", () => {
  it("is deterministic for identical content", () => {
    expect(skillContentHash(skill())).toBe(skillContentHash(skill()));
    expect(skillContentHash(skill())).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is independent of property insertion order", () => {
    const a = skill();
    const b = { ...skill() } as Skill;
    // Reassign in a different order — canonicalization must ignore it.
    const reordered: Skill = {
      canaryStartedAt: b.canaryStartedAt,
      canaryRolloutPercent: b.canaryRolloutPercent,
      testStatus: b.testStatus,
      status: b.status,
      id: b.id,
      name: b.name,
      namespace: b.namespace,
      version: b.version,
      description: b.description,
      supportedIntents: b.supportedIntents,
      examples: b.examples,
      createdAt: b.createdAt,
      modifiedAt: b.modifiedAt,
      createdBy: b.createdBy,
      requiredInputs: b.requiredInputs,
      requiredCapabilities: b.requiredCapabilities,
      procedure: b.procedure,
      verificationCriteria: b.verificationCriteria,
      recoveryStrategies: b.recoveryStrategies,
      testFilePaths: b.testFilePaths,
      lastTestedAt: b.lastTestedAt,
      lastTestResult: b.lastTestResult,
    };
    expect(skillContentHash(reordered)).toBe(skillContentHash(a));
  });

  it("changes when the procedure changes", () => {
    const changed = skill({
      procedure: [{ description: "Navigate instead", action: "navigate" }],
    });
    expect(skillContentHash(changed)).not.toBe(skillContentHash(skill()));
  });

  it("changes when a description or capability changes", () => {
    expect(skillContentHash(skill({ description: "different" }))).not.toBe(
      skillContentHash(skill()),
    );
    expect(
      skillContentHash(skill({ requiredCapabilities: ["read_page", "click"] })),
    ).not.toBe(skillContentHash(skill()));
  });

  it("ignores mutable trust and rollout state", () => {
    const base = skill();
    const promoted = skill({
      status: "trusted",
      testStatus: "passing",
      modifiedAt: 9_999_999,
      canaryRolloutPercent: 100,
      canaryStartedAt: 5_000,
      lastTestedAt: 6_000,
      lastTestResult: "all green",
    });
    expect(skillContentHash(promoted)).toBe(skillContentHash(base));
  });

  it("canonicalizes parameter key order", () => {
    const a = skill({
      procedure: [
        {
          description: "type",
          action: "type",
          value: "x",
          parameters: { b: 2, a: 1 },
        },
      ],
    });
    const b = skill({
      procedure: [
        {
          description: "type",
          action: "type",
          value: "x",
          parameters: { a: 1, b: 2 },
        },
      ],
    });
    expect(skillContentHash(a)).toBe(skillContentHash(b));
  });
});

describe("fingerprint primitives", () => {
  it("produces a stable 16-char hex digest", () => {
    expect(fingerprint64("")).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint64("hello")).toBe(fingerprint64("hello"));
    expect(fingerprint64("hello")).not.toBe(fingerprint64("hellp"));
  });

  it("canonical content is valid JSON", () => {
    expect(() => JSON.parse(canonicalSkillContent(skill()))).not.toThrow();
  });
});
