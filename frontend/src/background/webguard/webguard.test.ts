/**
 * WebGuard policy tests (PRD 6.5 §1.2; PRD 5 §8–15).
 * Deterministic matrix: no model, no network. Run: npm test
 */
import { describe, expect, it } from "vitest";
import { evaluate, type GuardContext, type TargetInfo } from "./policy.js";

const TARGETS = new Map<string, TargetInfo>([
  ["e1", { id: "e1", role: "link", name: "Open form", fieldKind: null, sensitive: false, isSubmit: false }],
  ["e2", { id: "e2", role: "button", name: "Submit Application", fieldKind: null, sensitive: false, isSubmit: true }],
  ["e3", { id: "e3", role: "button", name: "Buy now", fieldKind: null, sensitive: false, isSubmit: false }],
  ["e4", { id: "e4", role: "textbox", name: "Email", fieldKind: "email", sensitive: false, isSubmit: false }],
  ["e5", { id: "e5", role: "textbox", name: "Password", fieldKind: "password", sensitive: true, isSubmit: false }],
]);

function ctx(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    currentGeneration: 42,
    targets: TARGETS,
    provenance: "USER",
    sensitiveAuthorized: false,
    ...overrides,
  };
}

describe("WebGuard", () => {
  it("allows ordinary actions in the current generation", () => {
    expect(
      evaluate({ action: "click", target: "e1", pageGeneration: 42 }, ctx()),
    ).toEqual({ decision: "ALLOW", reason: "within policy" });
    expect(
      evaluate(
        { action: "type", target: "e4", pageGeneration: 42, value: "a@b.c", expect: { type: "field_value_present", target: "e4" } },
        ctx(),
      ),
    ).toEqual({ decision: "ALLOW", reason: "within policy" });
    expect(
      evaluate({ action: "navigate", parameters: { url: "https://example.com/" } }, ctx()).decision,
    ).toBe("ALLOW");
  });

  it("rejects stale generations and unknown targets", () => {
    expect(
      evaluate({ action: "click", target: "e1", pageGeneration: 41 }, ctx()).decision,
    ).toBe("BLOCK");
    expect(
      evaluate({ action: "click", target: "e99", pageGeneration: 42 }, ctx()).decision,
    ).toBe("BLOCK");
  });

  it("rejects non-user provenance (page/model-derived proposals)", () => {
    expect(
      evaluate(
        { action: "click", target: "e1", pageGeneration: 42 },
        ctx({ provenance: "PAGE" as unknown as GuardContext["provenance"] }),
      ).decision,
    ).toBe("BLOCK");
  });

  it("requires confirmation for submit and purchase buttons", () => {
    expect(
      evaluate({ action: "click", target: "e2", pageGeneration: 42 }, ctx()),
    ).toEqual({
      decision: "REQUIRE_CONFIRMATION",
      reason: "consequential action requires explicit approval",
    });
    expect(
      evaluate({ action: "click", target: "e3", pageGeneration: 42 }, ctx()).decision,
    ).toBe("REQUIRE_CONFIRMATION");
  });

  it("gates sensitive typing on the authorized slot-fill path", () => {
    const type = {
      action: "type" as const,
      target: "e5",
      pageGeneration: 42,
      value: "s3cr3t",
      expect: { type: "field_value_present" as const, target: "e5" },
    };
    expect(evaluate(type, ctx()).decision).toBe("BLOCK");
    expect(evaluate(type, ctx({ sensitiveAuthorized: true })).decision).toBe("ALLOW");
  });

  it("rejects malformed and dangerous actions at the schema gate", () => {
    expect(
      evaluate({ action: "click", target: "nope", pageGeneration: 42 }, ctx()).decision,
    ).toBe("BLOCK");
    expect(
      evaluate(
        { action: "execute_javascript" as unknown as "click", target: "e1" },
        ctx(),
      ).decision,
    ).toBe("BLOCK");
    expect(
      evaluate({ action: "navigate", parameters: { url: "javascript:alert(1)" } }, ctx()).decision,
    ).toBe("BLOCK");
  });
});
