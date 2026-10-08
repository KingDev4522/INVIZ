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

  it("shows agent thinking as the prominent headline, not footnote detail", () => {
    const overlay = new VoiceOverlay(document);
    overlay.showStatus("thinking", "Reasoning… (step 3)");
    expect(overlay.currentPhase()).toBe("thinking");
    expect(overlay.currentHeadline()).toBe("Reasoning… (step 3)");
    expect(overlay.currentDetail()).toBe("");
    overlay.showStatus("thinking", "Searching the web…");
    expect(overlay.currentHeadline()).toBe("Searching the web…");
    overlay.hide();
  });

  it("keeps transcripts and questions as detail under their phase headline", () => {
    const overlay = new VoiceOverlay(document);
    overlay.showStatus("transcript", "open the first result");
    expect(overlay.currentHeadline()).toContain("transcribing");
    expect(overlay.currentDetail()).toBe("open the first result");
    overlay.showStatus("awaiting", "Which size?");
    expect(overlay.currentHeadline()).toContain("Waiting");
    expect(overlay.currentDetail()).toBe("Which size?");
    overlay.hide();
  });

  it("falls back to the generic headline when thinking text is absent", () => {
    const overlay = new VoiceOverlay(document);
    overlay.showStatus("thinking");
    expect(overlay.currentHeadline()).toContain("Thinking");
    overlay.hide();
  });

  it("confirm No restores live thinking headline instead of the generic one", () => {
    const overlay = new VoiceOverlay(document, { onStop: () => undefined });
    overlay.showStatus("thinking", "Reasoning… (step 3)");
    overlay.requestStop();
    expect(overlay.currentHeadline()).toBe("Cancel this turn?");
    overlay.pressConfirm(false);
    expect(overlay.currentHeadline()).toBe("Reasoning… (step 3)");
    overlay.hide();
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

  it("exposes a visible Stop control during active phases that fires onStop", () => {
    let stops = 0;
    const overlay = new VoiceOverlay(document, { onStop: () => { stops += 1; } });
    for (const phase of ["listening", "transcribing", "thinking", "speaking", "awaiting"] as const) {
      overlay.show(phase);
      expect(overlay.stopControlVisible()).toBe(true);
    }
    overlay.hide();
  });

  it("Stop press/hover asks 'Cancel this turn?' instead of acting immediately", () => {
    const overlay = new VoiceOverlay(document, { onStop: () => undefined });
    overlay.show("speaking");
    expect(overlay.confirmVisible()).toBe(false);
    overlay.pressStop(); // click path
    expect(overlay.confirmVisible()).toBe(true);
    expect(overlay.currentHeadline()).toBe("Cancel this turn?");
    overlay.hide();
  });

  it("confirm Yes fires onStop and hides instantly; No resumes display", () => {
    let stops = 0;
    const overlay = new VoiceOverlay(document, { onStop: () => { stops += 1; } });
    overlay.show("speaking");
    overlay.requestStop(); // hover path (same convergence as click)
    expect(overlay.confirmVisible()).toBe(true);
    overlay.pressConfirm(false);
    expect(stops).toBe(0);
    expect(overlay.confirmVisible()).toBe(false);
    expect(overlay.currentHeadline()).toContain("Speaking");
    overlay.requestStop();
    overlay.pressConfirm(true);
    expect(stops).toBe(1);
    expect(overlay.currentPhase()).toBeNull(); // hidden at once — never looks laggy
  });

  it("terminal phases settle a pending cancel question", () => {
    const overlay = new VoiceOverlay(document, { onStop: () => undefined });
    overlay.show("thinking");
    overlay.requestStop();
    expect(overlay.confirmVisible()).toBe(true);
    overlay.show("done");
    expect(overlay.confirmVisible()).toBe(false);
    overlay.hide();
  });

  it("pressStop never throws, even with a throwing handler", () => {
    const overlay = new VoiceOverlay(document, { onStop: () => { throw new Error("x"); } });
    overlay.show("speaking");
    expect(() => overlay.pressStop()).not.toThrow();
    overlay.hide();
  });

  it("never throws when the host document has no element root", () => {
    const overlay = new VoiceOverlay(document);
    expect(() => overlay.show("listening")).not.toThrow();
    expect(() => overlay.setLevel(0.5)).not.toThrow();
    expect(() => overlay.hide()).not.toThrow();
  });
});
