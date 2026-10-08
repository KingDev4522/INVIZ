/**
 * Local voice selection tests: VoiceLens speaks with a feminine browser voice.
 * Pure selection logic — no speechSynthesis needed.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { pickVoice, type VoiceLike } from "./speech-synthesis-fallback.js";

const v = (name: string, lang: string, localService = true): VoiceLike => ({
  name,
  lang,
  localService,
});

describe("pickVoice", () => {
  it("prefers a feminine voice over a masculine natural one in the same language", () => {
    const voices = [
      v("Microsoft Ryan Online (Natural) - English (India)", "en-IN"),
      v("Microsoft Zira Online - English (India)", "en-IN"),
    ];
    expect(pickVoice(voices, "en")?.name).toContain("Zira");
  });

  it("prefers Google's female English voice over the default masculine one", () => {
    const voices = [
      v("Google UK English Male", "en-GB"),
      v("Google US English Female", "en-US"),
    ];
    expect(pickVoice(voices, "en")?.name).toContain("Female");
  });

  it("still returns a masculine voice when no feminine voice exists", () => {
    const voices = [v("Microsoft Ryan Online - English (India)", "en-IN")];
    expect(pickVoice(voices, "en")?.name).toContain("Ryan");
  });

  it("never picks a wrong-language voice, however feminine", () => {
    const voices = [
      v("Microsoft Zira Online - French (France)", "fr-FR"),
      v("Microsoft Ryan Online - English (India)", "en-IN"),
    ];
    expect(pickVoice(voices, "en")?.name).toContain("Ryan");
  });

  it("prefers a feminine Hindi voice for Hindi", () => {
    const voices = [
      v("Microsoft Guy Online - Hindi (India)", "hi-IN"),
      v("Microsoft Sonia Online - Hindi (India)", "hi-IN"),
    ];
    expect(pickVoice(voices, "hi")?.name).toContain("Sonia");
  });

  it("returns null when no voice matches the language or the list is empty", () => {
    expect(pickVoice([v("Microsoft Zira - French", "fr-FR")], "en")).toBeNull();
    expect(pickVoice([], "en")).toBeNull();
  });
});
