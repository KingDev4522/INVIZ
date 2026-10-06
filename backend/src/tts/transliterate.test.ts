/**
 * Transliteration tests (documented product workaround for the model's
 * Devanagari input block — verified live). Deterministic mapping checks +
 * the guarantee the synthesizer depends on: no Devanagari survives.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { needsRomanization, transliterateHi } from "./transliterate.js";

const DEVANAGARI_RE = /[\u0900-\u097F]/u;

describe("transliterateHi", () => {
  it("romanizes common words readably", () => {
    expect(transliterateHi("नमस्ते")).toBe("namaste");
    expect(transliterateHi("हां")).toBe("haan");
    expect(transliterateHi("रुको")).toBe("ruko");
    expect(transliterateHi("नहीं")).toBe("naheen");
  });

  it("handles digits, nukta consonants, and halant clusters", () => {
    expect(transliterateHi("१२३")).toBe("123");
    expect(transliterateHi("क़दम")).toContain("q");
    // Explicit halant drops the inherent vowel: सप्त → sapt-like rendering.
    expect(transliterateHi("सप्त")).toBe("sapt");
  });

  it("applies Hindi final-schwa deletion without touching explicit vowels", () => {
    expect(transliterateHi("राम")).toBe("raam");
    expect(transliterateHi("कमल")).toBe("kamal");
    expect(transliterateHi("खा")).toBe("khaa"); // explicit sign kept
    expect(transliterateHi("क")).toBe("ka"); // single letter name kept
  });

  it("passes non-Devanagari through untouched", () => {
    expect(transliterateHi("Hello, world! 123")).toBe("Hello, world! 123");
    expect(transliterateHi("")).toBe("");
  });

  it("leaves zero Devanagari in mixed output (the synthesizer guarantee)", () => {
    const samples = [
      "वॉइसलेंस ऑडियो जांच सफल रही।",
      "आवेदन कहाँ है? Search results: ५",
      "कृपया जारी रखने के लिए हाँ कहें।",
    ];
    for (const s of samples) {
      expect(needsRomanization(s)).toBe(true);
      const roman = transliterateHi(s);
      expect(DEVANAGARI_RE.test(roman)).toBe(false);
      expect(roman.length).toBeGreaterThan(0);
    }
    expect(needsRomanization("Search. Button.")).toBe(false);
  });
});
