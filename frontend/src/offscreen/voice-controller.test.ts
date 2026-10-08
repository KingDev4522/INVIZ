/**
 * VoiceTurnManager tests with fakes (PRD 6.3 §3.4–3.5).
 * Happy path, gate refusal, silent empty-discard, honest failures.
 * Run: npm test
 */
import { describe, expect, it, vi } from "vitest";
import { VoiceTurnManager } from "./voice-controller.js";
import { VoiceCaptureError, type CaptureResult } from "./voice-capture.js";
import type { Transcript } from "../ai/transcript.js";
import type { AudioRequest } from "../../../shared/types.js";

function makeDeps(overrides: {
  speaking?: boolean;
  stopAll?: () => void;
  capture?: (events?: { onLevel?: (level: number) => void }) => Promise<CaptureResult>;
  transcribe?: (blob: Blob, turnId: string) => Promise<{ text: string }>;
  onLevel?: (level: number, tabId: number | undefined) => void;
} = {}): {
  manager: VoiceTurnManager;
  calls: {
    beeps: string[];
    enqueued: AudioRequest[];
    transcripts: Transcript[];
    routedTabIds: Array<number | undefined>;
    captureCalls: number;
  };
} {
  const calls = {
    beeps: [] as string[],
    enqueued: [] as AudioRequest[],
    transcripts: [] as Transcript[],
    routedTabIds: [] as Array<number | undefined>,
    captureCalls: 0,
  };
  const blob = new Blob(["fake-opus"], { type: "audio/webm;codecs=opus" });
  const manager = new VoiceTurnManager({
    audio: {
      isSpeaking: () => overrides.speaking ?? false,
      enqueue: (req) => {
        calls.enqueued.push(req);
        return { disposition: "queued" as const };
      },
      beep: (kind) => {
        calls.beeps.push(kind);
      },
      ...(overrides.stopAll !== undefined ? { stopAll: overrides.stopAll } : {}),
    },
    capture: {
      start: async (events) => {
        calls.captureCalls += 1;
        if (overrides.capture !== undefined) return overrides.capture(events);
        return { blob, durationMs: 1200, effectiveMs: 1000, ended: "silence" as const };
      },
      stopManual: () => undefined,
    },
    transcribe: overrides.transcribe ?? (async () => ({ text: "open the first result" })),
    sendTranscript: async (t, tabId) => {
      calls.transcripts.push(t);
      calls.routedTabIds.push(tabId);
    },
    speechLang: "en",
    ...(overrides.onLevel !== undefined ? { onLevel: overrides.onLevel } : {}),
  });
  return { manager, calls };
}

describe("voice turn manager", () => {
  it("completes a turn: beeps, transcribes, tags, forwards", async () => {
    const { manager, calls } = makeDeps();
    const outcome = await manager.startTurn();
    expect(outcome.status).toBe("transcribed");
    if (outcome.status !== "transcribed") throw new Error("unreachable");
    expect(outcome.transcript.text).toBe("open the first result");
    expect(outcome.transcript.lang).toBe("en");
    expect(calls.beeps).toEqual(["listening", "captured"]);
    expect(calls.transcripts.length).toBe(1);
    expect(calls.enqueued.length).toBe(0); // no error speech on success
  });

  it("refuses to capture while the system is speaking (half-duplex)", async () => {
    const { manager, calls } = makeDeps({ speaking: true });
    expect(await manager.startTurn()).toEqual({ status: "refused-speaking" });
    expect(calls.captureCalls).toBe(0);
    expect(calls.transcripts.length).toBe(0);
  });

  it("barges in: stops narration, then captures on a noisy tab", async () => {
    let stopped = 0;
    const { manager, calls } = makeDeps({
      speaking: true,
      stopAll: () => {
        stopped += 1;
      },
    });
    const outcome = await manager.startTurn();
    expect(stopped).toBe(1);
    expect(outcome.status).toBe("transcribed");
    expect(calls.captureCalls).toBe(1);
    expect(calls.beeps).toEqual(["listening", "captured"]);
  });

  it("fans mic levels out with the turn's tab id", async () => {
    const levels: Array<{ level: number; tabId: number | undefined }> = [];
    const { manager } = makeDeps({
      capture: async (events) => {
        events?.onLevel?.(0.05);
        events?.onLevel?.(0.0);
        return {
          blob: new Blob(["fake-opus"], { type: "audio/webm;codecs=opus" }),
          durationMs: 1200,
          effectiveMs: 1000,
          ended: "silence" as const,
        };
      },
      onLevel: (level, tabId) => {
        levels.push({ level, tabId });
      },
    });
    manager.setTargetTab(9);
    expect(await manager.startTurn()).toEqual({
      status: "transcribed",
      transcript: expect.objectContaining({ text: "open the first result" }),
    });
    expect(levels).toEqual([
      { level: 0.05, tabId: 9 },
      { level: 0.0, tabId: 9 },
    ]);
  });

  it("announces empty audio instead of silence — never sent, but spoken", async () => {
    const { manager, calls } = makeDeps({
      capture: async () => {
        throw new VoiceCaptureError("empty", "no effective speech captured");
      },
    });
    expect(await manager.startTurn()).toEqual({ status: "empty" });
    expect(calls.transcripts.length).toBe(0);
    expect(calls.enqueued.length).toBe(1);
    expect(calls.enqueued[0]?.text).toContain("didn't hear anything");
  });

  it("speaks VOICE_CAPTURE_FAILED honestly on device denial", async () => {
    const { manager, calls } = makeDeps({
      capture: async () => {
        throw new VoiceCaptureError("denied", "microphone permission denied");
      },
    });
    const outcome = await manager.startTurn();
    expect(outcome).toEqual({ status: "failed", code: "VOICE_CAPTURE_FAILED" });
    expect(calls.enqueued.length).toBe(1);
    expect(calls.enqueued[0]?.priority).toBe(3);
    expect(calls.enqueued[0]?.text).toContain("Voice capture failed");
  });

  it("speaks TRANSCRIPTION_FAILED honestly on model failure", async () => {
    const { manager, calls } = makeDeps({
      transcribe: async () => {
        throw new Error("network down");
      },
    });
    const outcome = await manager.startTurn();
    expect(outcome).toEqual({ status: "failed", code: "TRANSCRIPTION_FAILED" });
    expect(calls.enqueued.length).toBe(1);
    expect(calls.enqueued[0]?.text).toContain("couldn't transcribe");
    expect(calls.transcripts.length).toBe(0); // never invents a transcript
  });

  it("forwards Hindi transcripts with the hi tag for language mirroring", async () => {
    const { manager, calls } = makeDeps({
      transcribe: async () => ({ text: "आवेदन कहाँ है" }),
    });
    const outcome = await manager.startTurn();
    expect(outcome.status).toBe("transcribed");
    expect(calls.transcripts[0]?.lang).toBe("hi");
    void outcome;
  });

  it("tags Hinglish as mixed", async () => {
    const { manager, calls } = makeDeps({
      transcribe: async () => ({ text: "haan kar do" }),
    });
    await manager.startTurn();
    expect(calls.transcripts[0]?.lang).toBe("mixed");
    void calls;
  });

  // Regression: the offscreen document has no `sender.tab`, so the worker
  // cannot attribute a transcript on its own. Without the tab travelling with
  // the message, every voice turn was dropped at the routing boundary while
  // still reporting "transcribed".
  it("forwards the target tab id with the transcript", async () => {
    const { manager, calls } = makeDeps();
    manager.setTargetTab(42);
    await manager.startTurn();
    expect(calls.routedTabIds).toEqual([42]);
  });

  it("carries an undefined tab id rather than inventing one", async () => {
    const { manager, calls } = makeDeps();
    manager.setTargetTab(undefined);
    await manager.startTurn();
    expect(calls.routedTabIds).toEqual([undefined]);
  });

  it("uses the most recent target tab when turns are started repeatedly", async () => {
    const { manager, calls } = makeDeps();
    manager.setTargetTab(1);
    await manager.startTurn();
    manager.setTargetTab(2);
    await manager.startTurn();
    expect(calls.routedTabIds).toEqual([1, 2]);
  });

  it("refuses an overlapping turn without a second capture/transcription", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<CaptureResult>((resolve) => {
      releaseGate = () =>
        resolve({
          blob: new Blob(["fake-opus"], { type: "audio/webm;codecs=opus" }),
          durationMs: 1200,
          effectiveMs: 1000,
          ended: "silence" as const,
        });
    });
    let transcribes = 0;
    const { manager, calls } = makeDeps({
      capture: () => gate,
      transcribe: async () => {
        transcribes += 1;
        return { text: "open the first result" };
      },
    });
    const first = manager.startTurn("turn_first");
    // Second press while the first turn still owns the pipeline.
    expect(await manager.startTurn("turn_second")).toEqual({ status: "busy" });
    releaseGate();
    expect(await first).toEqual({
      status: "transcribed",
      transcript: expect.objectContaining({ text: "open the first result" }),
    });
    expect(calls.captureCalls).toBe(1);
    expect(transcribes).toBe(1);
    expect(calls.transcripts.length).toBe(1);
    expect(calls.enqueued.length).toBe(0); // busy refusal speaks nothing
  });

  it("accepts a new turn after the previous one settles", async () => {
    const { manager, calls } = makeDeps();
    expect((await manager.startTurn("turn_1")).status).toBe("transcribed");
    expect((await manager.startTurn("turn_2")).status).toBe("transcribed");
    expect(calls.captureCalls).toBe(2);
    expect(calls.transcripts.length).toBe(2);
  });

  it("stamps the turn id on the transcript and hands it to transcription", async () => {
    const seenTurnIds: string[] = [];
    const { manager, calls } = makeDeps({
      transcribe: async (_blob: Blob, turnId: string) => {
        seenTurnIds.push(turnId);
        return { text: "open the first result" };
      },
    });
    const outcome = await manager.startTurn("turn_abc123");
    expect(seenTurnIds).toEqual(["turn_abc123"]);
    if (outcome.status !== "transcribed") throw new Error("unreachable");
    expect(outcome.transcript.turnId).toBe("turn_abc123");
    expect(calls.transcripts[0]?.turnId).toBe("turn_abc123");
  });
});
