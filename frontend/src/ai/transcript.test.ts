/**
 * Transcript normalization + tagging tests (PRD 6 §3.1).
 * Pure string processing — no network, no audio. Run: npm test
 */
import { describe, expect, it } from "vitest";
import { normalizeTranscript, tagTranscript, toTranscript } from "./transcript.js";

describe("normalizeTranscript", () => {
  it("trims and collapses whitespace, preserves scripts and negations", () => {
    expect(normalizeTranscript("  open   the first\nresult ")).toBe("open the first result");
    expect(normalizeTranscript("रद्द मत करो")).toBe("रद्द मत करो");
    expect(normalizeTranscript("don't submit it")).toBe("don't submit it");
  });
});

describe("tagTranscript", () => {
  it("tags Devanagari as hi", () => {
    expect(tagTranscript("आवेदन कहाँ है")).toBe("hi");
    expect(tagTranscript("Search रद्द करो")).toBe("hi");
  });

  it("tags roman Hindi as mixed", () => {
    expect(tagTranscript("haan, kar do")).toBe("mixed");
    expect(tagTranscript("nahi ruko")).toBe("mixed");
    expect(tagTranscript("mera email batao")).toBe("mixed");
  });

  it("tags plain English as en (no false mixed)", () => {
    expect(tagTranscript("open the first result")).toBe("en");
    expect(tagTranscript("find the application button")).toBe("en");
    expect(tagTranscript("stop")).toBe("en");
    expect(tagTranscript("yes")).toBe("en");
    expect(tagTranscript("no")).toBe("en");
  });

  it("never mistags English loanword collisions as mixed", () => {
    // Regression: these English sentences contain tokens that look Hindi-adjacent.
    expect(tagTranscript("what is my phone number")).toBe("en");
    expect(tagTranscript("go to main content")).toBe("en");
    expect(tagTranscript("book a train ticket")).toBe("en");
    expect(tagTranscript("find the school website")).toBe("en");
  });

  it("defaults empty text to en", () => {
    expect(tagTranscript("")).toBe("en");
  });
});

describe("toTranscript", () => {
  it("normalizes, tags, and stamps voice source", () => {
    const t = toTranscript("  haan   karo ", 123);
    expect(t).toEqual({ text: "haan karo", lang: "mixed", source: "voice", timestamp: 123 });
  });
});
