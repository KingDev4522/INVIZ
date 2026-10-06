// @vitest-environment happy-dom
/**
 * Submit-side-effect verification (PRD: stop re-clicking Submit).
 *
 * A Submit/Send/Pay click is non-idempotent. Two things had to be true:
 *  1. success must be RECOGNIZABLE from generic signals (navigation, dialog,
 *     toast, form removed, control disabled) — not one hardcoded message;
 *  2. an inconclusive verdict must NEVER be treated as "click again".
 *
 * Pure evaluator + DOM signal collection are unit-tested here; the loop-safety
 * half lives in submit-verification-loop.test.ts.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { evaluateExpectation, type VerifyFacts } from "./verification-engine.js";
import {
  collectCompletionSignals,
  looksLikeCompletionText,
} from "./submit-verification.js";

const SUBMIT_EXPECT = { type: "submit_completed", target: "e9" } as const;

function facts(overrides: Partial<VerifyFacts> = {}): VerifyFacts {
  return {
    urlBefore: "https://devfolio.co/apply",
    urlNow: "https://devfolio.co/apply",
    targetPresent: true,
    activeMatches: null,
    dialogOpen: false,
    textFound: null,
    fieldFilled: null,
    stateMatches: null,
    generationChanged: false,
    submit: {
      successDialogOpen: false,
      successTextFound: false,
      submittedTargetGone: false,
      targetDisabled: false,
      navigated: false,
    },
    ...overrides,
  };
}

const submit = (o: Partial<NonNullable<VerifyFacts["submit"]>>): VerifyFacts =>
  facts({ submit: { ...facts().submit!, ...o } });

describe("looksLikeCompletionText", () => {
  it("accepts completion-tense wording", () => {
    for (const t of [
      "Your application was submitted",
      "Successfully applied",
      "Thank you! We have received your entry",
      "Application received",
      "Submission complete",
      "Registration confirmed",
    ]) {
      expect(looksLikeCompletionText(t)).toBe(true);
    }
  });

  it("never matches the bare action verb (would false-positive pre-submit)", () => {
    // The whole design rests on this: the button's own label must not read as
    // proof of success, or verification would pass without doing anything.
    for (const t of ["Submit Application", "Send message", "Save changes", "Apply now"]) {
      expect(looksLikeCompletionText(t)).toBe(false);
    }
  });

  it("handles empty/ordinary copy safely", () => {
    expect(looksLikeCompletionText("")).toBe(false);
    expect(looksLikeCompletionText("   ")).toBe(false);
    expect(looksLikeCompletionText("Fill in your details and continue")).toBe(false);
  });
});

describe("evaluateExpectation — submit_completed (cases 1-4)", () => {
  it("case 1: navigation after submit → SUCCESS", () => {
    expect(
      evaluateExpectation(
        SUBMIT_EXPECT,
        submit({ navigated: true }),
      ),
    ).toBe("VERIFIED_SUCCESS");
  });

  it("case 2: confirmation modal → SUCCESS", () => {
    expect(evaluateExpectation(SUBMIT_EXPECT, submit({ successDialogOpen: true }))).toBe(
      "VERIFIED_SUCCESS",
    );
  });

  it("case 3: success toast/status region → SUCCESS", () => {
    expect(evaluateExpectation(SUBMIT_EXPECT, submit({ successTextFound: true }))).toBe(
      "VERIFIED_SUCCESS",
    );
  });

  it("case 4: form transitions to completed state → SUCCESS", () => {
    expect(evaluateExpectation(SUBMIT_EXPECT, submit({ submittedTargetGone: true }))).toBe(
      "VERIFIED_SUCCESS",
    );
    expect(evaluateExpectation(SUBMIT_EXPECT, submit({ targetDisabled: true }))).toBe(
      "VERIFIED_SUCCESS",
    );
  });

  it("stays PENDING when nothing changed (poller keeps waiting)", () => {
    expect(evaluateExpectation(SUBMIT_EXPECT, submit({}))).toBe("PENDING");
    // Missing signal block entirely is also inconclusive, never a false success.
    expect(
      evaluateExpectation(SUBMIT_EXPECT, facts({ submit: undefined })),
    ).toBe("PENDING");
  });

  it("case 7: non-submit expectations are completely unchanged", () => {
    expect(evaluateExpectation({ type: "element_present", target: "e1" }, facts({ targetPresent: true }))).toBe(
      "VERIFIED_SUCCESS",
    );
    expect(evaluateExpectation({ type: "element_present", target: "e1" }, facts({ targetPresent: null }))).toBe(
      "PENDING",
    );
    expect(
      evaluateExpectation(
        { type: "navigation_completed" },
        facts({ urlNow: "https://devfolio.co/done" }),
      ),
    ).toBe("VERIFIED_SUCCESS");
    expect(
      evaluateExpectation({ type: "dialog_present" }, facts({ dialogOpen: true })),
    ).toBe("VERIFIED_SUCCESS");
  });
});

describe("collectCompletionSignals — real DOM", () => {
  it("reads a success toast from a status region", () => {
    document.body.innerHTML = `
      <button id="s">Submit Application</button>
      <div role="status">Your application was submitted successfully.</div>
    `;
    const signals = collectCompletionSignals(document, "e9", {
      urlBefore: location.href,
      resolveTarget: () => document.getElementById("s"),
    });
    expect(signals.successTextFound).toBe(true);
    expect(signals.targetDisabled).toBe(false);
    expect(signals.submittedTargetGone).toBe(false);
  });

  it("does not treat the button label itself as success", () => {
    document.body.innerHTML = `<button id="s">Submit Application</button>`;
    const signals = collectCompletionSignals(document, "e9", {
      urlBefore: location.href,
      resolveTarget: () => document.getElementById("s"),
    });
    expect(signals.successTextFound).toBe(false);
    expect(signals.successDialogOpen).toBe(false);
  });

  it("detects a confirmation dialog", () => {
    document.body.innerHTML = `<div role="dialog">Application received. Thank you!</div>`;
    const signals = collectCompletionSignals(document, "e9", { urlBefore: location.href });
    expect(signals.successDialogOpen).toBe(true);
  });

  it("detects a disabled submit control", () => {
    document.body.innerHTML = `<button id="s" disabled>Submit</button>`;
    const signals = collectCompletionSignals(document, "e9", {
      urlBefore: location.href,
      resolveTarget: () => document.getElementById("s"),
    });
    expect(signals.targetDisabled).toBe(true);
  });

  it("detects a removed submit control", () => {
    document.body.innerHTML = `<p>All done</p>`;
    const signals = collectCompletionSignals(document, "e9", {
      urlBefore: location.href,
      resolveTarget: () => null,
    });
    expect(signals.submittedTargetGone).toBe(true);
  });

  it("never throws on an empty document", () => {
    document.body.innerHTML = "";
    const signals = collectCompletionSignals(document, undefined, {
      urlBefore: location.href,
    });
    expect(signals.successDialogOpen).toBe(false);
    expect(signals.navigated).toBe(false);
  });
});
