/**
 * Frontend shaping tests: byte-aware chunking, mixed-language splitting,
 * cache-key determinism. Pure functions, no network. Run: npm test
 */
import { describe, expect, it } from "vitest";
import { cacheKey, chunkText, splitMixedSegments } from "./text-shaping.js";
import { TTS_MAX_BYTES_PER_REQUEST } from "../../../shared/constants.js";

const encoder = new TextEncoder();
const byteLen = (s: string): number => encoder.encode(s).length;

describe("byte-aware chunking", () => {
  it("passes short text through untouched", () => {
    expect(chunkText("Search. Button.")).toEqual(["Search. Button."]);
  });

  it("splits long text into byte-bounded chunks that reassemble", () => {
    const sentence = "The quick brown fox jumps over the lazy dog near the river bank. ";
    const long = sentence.repeat(200); // ~12KB
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(byteLen(c)).toBeLessThanOrEqual(TTS_MAX_BYTES_PER_REQUEST);
    }
    const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
    expect(collapse(chunks.join(" "))).toBe(collapse(long));
  });

  it("never splits inside multibyte characters", () => {
    // Devanagari ≈3 bytes/char: force splits inside a dense Hindi passage.
    const passage = "वॉइसलेंस ऑडियो जांच सफल रही। ".repeat(300);
    const chunks = chunkText(passage);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(byteLen(c)).toBeLessThanOrEqual(TTS_MAX_BYTES_PER_REQUEST);
      // Lone surrogates / broken sequences would show as U+FFFD.
      expect(c).not.toContain("�");
    }
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(
      passage.replace(/\s+/g, " ").trim(),
    );
  });

  it("hard-splits a single overlong sentence on word boundaries", () => {
    const sentence = `${"word ".repeat(1500).trim()}.`;
    expect(byteLen(sentence)).toBeGreaterThan(TTS_MAX_BYTES_PER_REQUEST);
    const chunks = chunkText(sentence);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(byteLen(c)).toBeLessThanOrEqual(TTS_MAX_BYTES_PER_REQUEST);
    }
  });
});

describe("mixed-language splitting (PRD 6 §3.2)", () => {
  it("routes Devanagari runs to hi and the rest to the default", () => {
    const segs = splitMixedSegments("Hello दुनिया test", "en");
    expect(segs).toEqual([
      { text: "Hello", lang: "en" },
      { text: "दुनिया", lang: "hi" },
      { text: "test", lang: "en" },
    ]);
  });

  it("keeps pure utterances in one segment", () => {
    expect(splitMixedSegments("Just English.", "en")).toEqual([
      { text: "Just English.", lang: "en" },
    ]);
    expect(splitMixedSegments("सिर्फ हिंदी।", "en")).toEqual([
      { text: "सिर्फ हिंदी।", lang: "hi" },
    ]);
  });
});

describe("cache keys", () => {
  it("is deterministic and language-scoped", () => {
    expect(cacheKey("Hello.", "en")).toBe(cacheKey("Hello.", "en"));
    expect(cacheKey("Hello.", "en")).not.toBe(cacheKey("Hello.", "hi"));
    expect(cacheKey("Hello.", "en")).not.toBe(cacheKey("Hello?", "en"));
  });
});
