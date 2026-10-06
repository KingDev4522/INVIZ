// @vitest-environment happy-dom
/**
 * VoiceOverlay state-machine tests (DOM only — canvas pixels are the
 * thinking-orbs engine's own tested surface).
 * Run: npm test
 */
import { afterEach, describe, expect, it } from "vitest";
import { VoiceOverlay } from "./voice-overlay.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function shown(): HTMLElement | null {
  return document.getElementById("inviz-voice-overlay");
}

describe("voice overlay", () => {
  it("shows listening state with headline and mic meter", () => {
    const overlay = new VoiceOverlay(document);
    overlay.show("listening");
    expect(overlay.currentPhase()).toBe("listening");
    expect(shown()).not.toBeNull();
    expect(shown()?.style.display).toBe("");
    expect(overlay.currentHeadline()).toContain("Listening");
    overlay.hide();
  });

  it("advances through transcribing → thinking → speaking → done", () => {
    const overlay = new VoiceOverlay(document);
    overlay.show("transcribing");
    expect(overlay.currentHeadline()).toContain("transcribing");
    overlay.show("thinking", { detail: "Reasoning…" });
    expect(overlay.currentPhase()).toBe("thinking");
    expect(overlay.currentDetail()).toBe("Reasoning…");
    overlay.show("speaking");
    expect(overlay.currentPhase()).toBe("speaking");
    overlay.show("done");
    expect(overlay.currentPhase()).toBe("done");
    overlay.hide();
    expect(overlay.currentPhase()).toBeNull();
    expect(shown()?.style.display).toBe("none");
  });

  it("shows transcript detail text and clears it when absent", () => {
    const overlay = new VoiceOverlay(document);
    overlay.show("transcript", { detail: "open the first result" });
    expect(overlay.currentDetail()).toBe("open the first result");
    overlay.show("thinking");
    expect(overlay.currentDetail()).toBe("");
    overlay.hide();
  });

  it("accepts mic levels only while listening", () => {
    const overlay = new VoiceOverlay(document);
    overlay.show("listening");
    expect(() => overlay.setLevel(0.2)).not.toThrow();
    overlay.show("thinking");
    expect(() => overlay.setLevel(0.2)).not.toThrow();
    overlay.hide();
  });

  it("shows error and busy states without throwing", () => {
    const overlay = new VoiceOverlay(document);
    overlay.show("error", { detail: "API rate limit reached. Please wait and try again." });
    expect(overlay.currentPhase()).toBe("error");
    expect(overlay.currentDetail()).toContain("rate limit");
    overlay.show("busy", { detail: "Already listening…" });
    expect(overlay.currentHeadline()).toContain("Already listening");
    overlay.hide();
  });

  it("never throws when the host document has no element root", () => {
    const overlay = new VoiceOverlay(document);
    expect(() => overlay.show("listening")).not.toThrow();
    expect(() => overlay.setLevel(0.5)).not.toThrow();
    expect(() => overlay.hide()).not.toThrow();
  });
});
