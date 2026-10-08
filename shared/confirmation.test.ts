/**
 * Confirmation grammar tests (PRD 6 §3.3, §7). Deterministic matching in
 * English, roman Hindi, and Devanagari. Run: npm test
 */
import { describe, expect, it } from "vitest";
import { matchConfirmation } from "./confirmation.js";

describe("matchConfirmation", () => {
  it("accepts English affirmations", () => {
    for (const t of ["yes", "Yes!", "yeah", "sure", "okay", "proceed", "correct"]) {
      expect(matchConfirmation(t)).toBe("yes");
    }
  });

  it("accepts roman Hindi and Devanagari affirmations", () => {
    for (const t of ["haan", "haanji", "kar do", "theek hai", "हाँ", "जी", "करो"]) {
      expect(matchConfirmation(t)).toBe("yes");
    }
  });

  it("accepts English and Hindi rejections", () => {
    for (const t of ["no", "nope", "don't", "stop", "nahin", "mat karo", "नहीं", "रुको"]) {
      expect(matchConfirmation(t)).toBe("no");
    }
  });

  it("never matches substrings (eyes is not yes)", () => {
    expect(matchConfirmation("eyes")).toBe("unclear");
    expect(matchConfirmation("yesterday")).toBe("unclear");
    expect(matchConfirmation("maybe")).toBe("unclear");
    expect(matchConfirmation("")).toBe("unclear");
  });

  it("treats conflicting signals as unclear (never executes)", () => {
    expect(matchConfirmation("yes, but delete everything")).toBe("unclear");
    expect(matchConfirmation("haan, no ruko")).toBe("unclear");
    expect(matchConfirmation("yes and also email everyone")).toBe("unclear");
  });

  it("tolerates politeness but fails closed on uncertainty", () => {
    expect(matchConfirmation("yes please")).toBe("yes");
    expect(matchConfirmation("haan ji")).toBe("yes");
    // "not sure" refuses rather than executes (documented fail-closed rule).
    expect(matchConfirmation("not sure")).toBe("no");
  });

  it("absorbs negated affirmatives (mat karo = refusal, not conflict)", () => {
    expect(matchConfirmation("mat karo")).toBe("no");
    expect(matchConfirmation("nahi karo")).toBe("no");
  });

  it("keeps Devanagari matras intact while tokenizing (regression)", () => {
    // Vowel signs/bidis are Unicode Marks (\\p{M}), not Letters: a tokenizer
    // splitting on letters alone chops "हाँ" into "ह" and breaks all Hindi.
    for (const t of ["हाँ", "नहीं", "रुको मत", "ठीक है"]) {
      expect(["yes", "no"].includes(matchConfirmation(t))).toBe(true);
    }
    expect(matchConfirmation("हाँ")).toBe("yes");
    expect(matchConfirmation("नहीं")).toBe("no");
  });
});
