/**
 * Verification matcher tests (PRD 6.5 §1.4; PRD 3 §23–24).
 * Pure function: every expectation type across success/pending/unknown/stale.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { evaluateExpectation, type VerifyFacts } from "./verification-engine.js";

function facts(overrides: Partial<VerifyFacts> = {}): VerifyFacts {
  return {
    urlBefore: "https://a.example/",
    urlNow: "https://a.example/",
    targetPresent: null,
    activeMatches: null,
    dialogOpen: false,
    textFound: null,
    fieldFilled: null,
    stateMatches: null,
    generationChanged: false,
    ...overrides,
  };
}

describe("evaluateExpectation", () => {
  it("element_present succeeds on presence, pends otherwise, stales on navigation", () => {
    const e = { type: "element_present" as const, target: "e52" };
    expect(evaluateExpectation(e, facts({ targetPresent: true }))).toBe("VERIFIED_SUCCESS");
    expect(evaluateExpectation(e, facts({ targetPresent: false }))).toBe("PENDING");
    expect(
      evaluateExpectation(
        e,
        facts({ targetPresent: false, generationChanged: true, urlNow: "https://b.example/" }),
      ),
    ).toBe("STALE_STATE");
  });

  it("element_absent inverts presence", () => {
    const e = { type: "element_absent" as const, target: "e52" };
    expect(evaluateExpectation(e, facts({ targetPresent: false }))).toBe("VERIFIED_SUCCESS");
    expect(evaluateExpectation(e, facts({ targetPresent: true }))).toBe("PENDING");
  });

  it("navigation expectations resolve on URL change", () => {
    expect(
      evaluateExpectation({ type: "url_changed" }, facts({ urlNow: "https://b.example/" })),
    ).toBe("VERIFIED_SUCCESS");
    expect(evaluateExpectation({ type: "url_changed" }, facts())).toBe("PENDING");
    expect(
      evaluateExpectation({ type: "navigation_completed" }, facts({ urlNow: "https://b.example/" })),
    ).toBe("VERIFIED_SUCCESS");
  });

  it("dialog_present follows the dialog flag", () => {
    expect(
      evaluateExpectation({ type: "dialog_present" }, facts({ dialogOpen: true })),
    ).toBe("VERIFIED_SUCCESS");
    expect(evaluateExpectation({ type: "dialog_present" }, facts())).toBe("PENDING");
  });

  it("text/field/state expectations go UNKNOWN when unevaluatable", () => {
    expect(evaluateExpectation({ type: "text_present", value: "x" }, facts())).toBe("UNKNOWN");
    expect(
      evaluateExpectation({ type: "text_present", value: "x" }, facts({ textFound: true })),
    ).toBe("VERIFIED_SUCCESS");
    expect(
      evaluateExpectation({ type: "field_value_present", target: "e4" }, facts()),
    ).toBe("UNKNOWN");
    expect(
      evaluateExpectation(
        { type: "field_value_present", target: "e4" },
        facts({ fieldFilled: true }),
      ),
    ).toBe("VERIFIED_SUCCESS");
    expect(
      evaluateExpectation(
        { type: "element_state", target: "e1", state: "checked", stateValue: true },
        facts({ stateMatches: null }),
      ),
    ).toBe("UNKNOWN");
  });

  it("focused_element follows the active match", () => {
    expect(
      evaluateExpectation({ type: "focused_element", target: "e1" }, facts({ activeMatches: true })),
    ).toBe("VERIFIED_SUCCESS");
    expect(
      evaluateExpectation({ type: "focused_element", target: "e1" }, facts({ activeMatches: false })),
    ).toBe("PENDING");
  });
});
