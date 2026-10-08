/**
 * Output-contract validator tests (PRD 6.4 §1.2).
 * Every outcome class accepted with full fields; every malformation rejected.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { ModelOutputError, validateModelOutput } from "./response-validator.js";

const ACTION = {
  action: "click",
  target: "e37",
  pageGeneration: 42,
  expect: { type: "element_present", target: "e52" },
  timeout_ms: 3000,
};

describe("validateModelOutput", () => {
  it("accepts all six outcome classes", () => {
    expect(validateModelOutput({ type: "answer", text: "The page is a form." })).toEqual({
      type: "answer",
      text: "The page is a form.",
    });
    expect(
      validateModelOutput({ type: "ask_user", question: "What email?", field: "email", sensitivity: "ordinary" }),
    ).toEqual({
      type: "ask_user",
      question: "What email?",
      field: "email",
      sensitivity: "ordinary",
    });
    expect(validateModelOutput({ type: "action", action: ACTION })).toEqual({
      type: "action",
      action: ACTION,
    });
    expect(
      validateModelOutput({ type: "confirmation_required", reason: "Submit?", action: ACTION }),
    ).toEqual({ type: "confirmation_required", reason: "Submit?", action: ACTION });
    expect(validateModelOutput({ type: "task_complete", summary: "Done." })).toEqual({
      type: "task_complete",
      text: "Done.",
    });
    expect(validateModelOutput({ type: "cannot_complete", reason: "Blocked." })).toEqual({
      type: "cannot_complete",
      reason: "Blocked.",
    });
  });

  it("parses JSON strings (Groq message content form)", () => {
    expect(
      validateModelOutput(JSON.stringify({ type: "answer", text: "Hi." })),
    ).toEqual({ type: "answer", text: "Hi." });
  });

  it("rejects non-objects, unknown types, and missing fields", () => {
    expect(() => validateModelOutput("not json{{")).toThrow(ModelOutputError);
    expect(() => validateModelOutput(null)).toThrow(ModelOutputError);
    expect(() => validateModelOutput({ type: "execute" })).toThrow(ModelOutputError);
    expect(() => validateModelOutput({ type: "answer" })).toThrow(ModelOutputError);
    expect(() => validateModelOutput({ type: "answer", text: "   " })).toThrow(ModelOutputError);
    expect(() => validateModelOutput({ type: "ask_user", question: "Q?", sensitivity: "maybe" })).toThrow(
      ModelOutputError,
    );
    expect(() => validateModelOutput({ type: "cannot_complete" })).toThrow(ModelOutputError);
  });

  it("rejects schema-invalid actions (never executed downstream)", () => {
    expect(() =>
      validateModelOutput({
        type: "action",
        action: { action: "click", target: "submit-btn" },
      }),
    ).toThrow(/invalid action/);
    expect(() =>
      validateModelOutput({
        type: "action",
        action: { action: "execute_javascript", target: "e1" },
      }),
    ).toThrow(/invalid action/);
    expect(() =>
      validateModelOutput({
        type: "confirmation_required",
        reason: "Go?",
        action: { action: "navigate", url: "javascript:alert(1)" },
      }),
    ).toThrow(/invalid action/);
  });

  it("rejects oversized text payloads", () => {
    expect(() =>
      validateModelOutput({ type: "answer", text: "x".repeat(4001) }),
    ).toThrow(ModelOutputError);
  });
});

// Live-proven failure modes: reasoning models intermittently answer with a
// fenced block, a prose preamble, a <think> preamble, or an action carrying a
// spoken "text" key. Each of these failed the whole voice turn.
describe("validateModelOutput — live model text recovery", () => {
  it("parses JSON wrapped in a markdown code fence", () => {
    const raw = '```json\n{"type":"answer","text":"Found it."}\n```';
    expect(validateModelOutput(raw)).toEqual({ type: "answer", text: "Found it." });
  });

  it("parses JSON surrounded by prose", () => {
    const raw = 'Sure! Here is the outcome:\n{"type":"answer","text":"Found it."}\nHope that helps.';
    expect(validateModelOutput(raw)).toEqual({ type: "answer", text: "Found it." });
  });

  it("parses JSON after a reasoning-model <think> preamble", () => {
    const raw =
      '<think>The user wants the search box, so I emit an action.</think>\n{"type":"answer","text":"Found it."}';
    expect(validateModelOutput(raw)).toEqual({ type: "answer", text: "Found it." });
  });

  it("is not fooled by braces inside string values", () => {
    const raw = 'noise { unbalanced\n{"type":"answer","text":"use {braces} here"} trailing';
    expect(validateModelOutput(raw)).toEqual({
      type: "answer",
      text: "use {braces} here",
    });
  });

  it("is not fooled by escaped quotes inside string values", () => {
    const raw = '{"type":"answer","text":"say \\"hi\\" now"} trailing prose';
    expect(validateModelOutput(raw)).toEqual({ type: "answer", text: 'say "hi" now' });
  });

  it("still rejects text with no JSON object at all", () => {
    expect(() => validateModelOutput("not json{{")).toThrow(ModelOutputError);
    expect(() => validateModelOutput("I cannot help with that.")).toThrow(ModelOutputError);
    expect(() => validateModelOutput("<think>only reasoning, no answer</think>")).toThrow(
      ModelOutputError,
    );
  });

  it("still rejects a non-object JSON payload", () => {
    expect(() => validateModelOutput('"just a string"')).toThrow(ModelOutputError);
    expect(() => validateModelOutput("[1,2,3]")).toThrow(ModelOutputError);
  });

  it("recovers a valid outcome even when prose precedes a fenced block", () => {
    const raw = 'Here you go:\n```json\n{"type":"task_complete","summary":"All done."}\n```';
    expect(validateModelOutput(raw)).toEqual({ type: "task_complete", text: "All done." });
  });
});

// The closed action schema is a security control (PRD 4 §79). Tolerating a
// spoken key must not reopen it.
describe("validateModelOutput — presentation-only action keys", () => {
  it("drops a stray spoken key from an otherwise valid action", () => {
    expect(
      validateModelOutput({
        type: "action",
        action: { ...ACTION, text: "Clicking the search button." },
      }),
    ).toEqual({ type: "action", action: ACTION });
  });

  it("drops presentation keys from confirmation_required actions too", () => {
    expect(
      validateModelOutput({
        type: "confirmation_required",
        reason: "Submits the form.",
        action: { ...ACTION, summary: "Submit", explanation: "sends data" },
      }),
    ).toEqual({ type: "confirmation_required", reason: "Submits the form.", action: ACTION });
  });

  it("keeps the execution-relevant fields intact", () => {
    const out = validateModelOutput({
      type: "action",
      action: { action: "type", target: "e4", value: "Ada", text: "typing the name" },
    });
    expect(out).toEqual({
      type: "action",
      action: { action: "type", target: "e4", value: "Ada" },
    });
  });

  it("still rejects a smuggled executable key", () => {
    for (const key of ["run", "script", "eval", "js", "url", "selector", "onclick"]) {
      expect(() =>
        validateModelOutput({ type: "action", action: { ...ACTION, [key]: "alert(1)" } }),
      ).toThrow(/invalid action/);
    }
  });

  it("does not mutate the caller's object", () => {
    const action = { ...ACTION, text: "hi" };
    validateModelOutput({ type: "action", action });
    expect(action.text).toBe("hi");
  });

  it("still rejects an action that is invalid for reasons other than the stray key", () => {
    expect(() =>
      validateModelOutput({
        type: "action",
        action: { action: "click", target: "submit-btn", text: "hi" },
      }),
    ).toThrow(/invalid action/);
  });
});

// Live-proven: the model emits `value_present` for "this field now holds
// something". Rejecting it failed the whole turn with "unknown expectation
// type", so the variant is accepted AND translated — accepting without
// translating would pass validation and then be unevaluable at verification.
describe("validateModelOutput — expectation vocabulary", () => {
  it("translates value_present into the implemented field_value_present", () => {
    expect(
      validateModelOutput({
        type: "action",
        action: { action: "type", target: "e1", value: "Ada" },
      }),
    ).toBeDefined();
    const out = validateModelOutput({
      type: "action",
      action: {
        action: "type",
        target: "e1",
        value: "Ada",
        expect: { type: "value_present", target: "e1" },
      },
    });
    expect((out as { action: { expect: { type: string } } }).action.expect.type).toBe(
      "field_value_present",
    );
  });

  it("translates other observed model variants", () => {
    const cases: Array<[string, string]> = [
      ["has_value", "field_value_present"],
      ["clicked", "element_present"],
      ["element_clicked", "element_present"],
      ["loaded", "navigation_completed"],
      ["content_changed", "url_changed"],
    ];
    for (const [emitted, expected] of cases) {
      const out = validateModelOutput({
        type: "action",
        action: { action: "click", target: "e1", expect: { type: emitted, target: "e1" } },
      });
      expect((out as { action: { expect: { type: string } } }).action.expect.type).toBe(expected);
    }
  });

  it("leaves a correctly-spelled expectation untouched", () => {
    const out = validateModelOutput({
      type: "action",
      action: { action: "click", target: "e1", expect: { type: "element_present", target: "e2" } },
    });
    expect((out as { action: { expect: unknown } }).action.expect).toEqual({
      type: "element_present",
      target: "e2",
    });
  });

  it("still rejects a genuinely unknown expectation type", () => {
    expect(() =>
      validateModelOutput({
        type: "action",
        action: { action: "click", target: "e1", expect: { type: "vibes", target: "e1" } },
      }),
    ).toThrow(/invalid action/);
  });

  it("still requires a target on the expectation", () => {
    expect(() =>
      validateModelOutput({
        type: "action",
        action: { action: "click", target: "e1", expect: { type: "element_present", target: "#css" } },
      }),
    ).toThrow(/invalid action/);
  });
});

// Skill selection (Phase 3): the model may only NAME a registered skill. The
// boundary enforces the id grammar and input shape; the registry separately
// decides whether the named skill may actually run.
describe("validateModelOutput — skill selection", () => {
  it("accepts a skill outcome with inputs", () => {
    expect(
      validateModelOutput({
        type: "skill",
        skill_id: "github_find_contributors",
        input: { repoUrl: "https://github.com/o/r", attempts: 2, strict: true },
      }),
    ).toEqual({
      type: "skill",
      skill: {
        skillId: "github_find_contributors",
        input: { repoUrl: "https://github.com/o/r", attempts: 2, strict: true },
      },
    });
  });

  it("defaults a missing input to an empty object", () => {
    expect(validateModelOutput({ type: "skill", skill_id: "generic_read_region" })).toEqual({
      type: "skill",
      skill: { skillId: "generic_read_region", input: {} },
    });
  });

  it("rejects a syntactically invalid skill id", () => {
    for (const skill_id of ["", "Bad", "has space", "1leading", "UPPER", "x".repeat(65), "a-b"]) {
      expect(() => validateModelOutput({ type: "skill", skill_id })).toThrow(ModelOutputError);
    }
  });

  it("rejects non-primitive or oversized inputs", () => {
    expect(() =>
      validateModelOutput({ type: "skill", skill_id: "s", input: { nested: { a: 1 } } }),
    ).toThrow(ModelOutputError);
    expect(() =>
      validateModelOutput({ type: "skill", skill_id: "s", input: { arr: [1] } }),
    ).toThrow(ModelOutputError);
    expect(() =>
      validateModelOutput({ type: "skill", skill_id: "s", input: { url: "x".repeat(501) } }),
    ).toThrow(ModelOutputError);
    expect(() => validateModelOutput({ type: "skill", skill_id: "s", input: "nope" })).toThrow(
      ModelOutputError,
    );
  });

  it("still rejects an unknown outcome type", () => {
    expect(() => validateModelOutput({ type: "skills" })).toThrow(ModelOutputError);
    expect(() => validateModelOutput({ type: "execute_skill" })).toThrow(ModelOutputError);
  });
});
