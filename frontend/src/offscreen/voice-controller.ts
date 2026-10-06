/**
 * Voice turn manager (PRD 6.3 §3.4–3.5).
 * One turn: gate check → listening beep → capture → captured beep →
 * transcribe → tag → VOICE_TRANSCRIPT to the service worker.
 * Failures speak honest EN/HI errors (VOICE_CAPTURE_FAILED /
 * CAPTURE_EMPTY / RATE_LIMITED / TRANSCRIPTION_FAILED); sub-0.5s audio is
 * never sent, but is now announced so silence isn't mistaken for a dead mic.
 */
import { getErrorSpeech, type ErrorCode, type SpeechLang } from "../../../shared/messages.js";
import { logger } from "../../../shared/logger.js";
import type { AudioPriority } from "../../../shared/types.js";
import { toTranscript, type Transcript } from "../ai/transcript.js";
import { VoiceCaptureError, type CaptureEvents, type CaptureResult } from "./voice-capture.js";
import { TranscriptionError } from "../ai/whisper-client.js";

export type TurnOutcome =
  | { status: "transcribed"; transcript: Transcript }
  | { status: "refused-speaking" }
  | { status: "empty" }
  | { status: "busy" }
  | { status: "failed"; code: ErrorCode };

export interface TurnAudio {
  isSpeaking(): boolean;
  enqueue(req: {
    text: string;
    lang: "en" | "hi" | "mixed";
    priority: AudioPriority;
    interruptible: boolean;
    requestId: string;
  }): unknown;
  beep(kind: "listening" | "captured" | "error"): void;
  /** Halts all system speech for barge-in. Absent = refuse while speaking. */
  stopAll?: () => void;
}

export interface TurnDeps {
  audio: TurnAudio;
  capture: {
    start(events?: CaptureEvents): Promise<CaptureResult>;
    stopManual(): void;
  };
  /** Turn id travels with the call so the transcription log proves which
   *  voice turn produced which single backend request. */
  transcribe: (blob: Blob, turnId: string) => Promise<{ text: string }>;
  /** `tabId` is the tab this turn was started against. The service worker
   *  cannot infer it (an offscreen document has no tab), so it is echoed here. */
  sendTranscript: (t: Transcript, tabId: number | undefined) => Promise<void>;
  speechLang: SpeechLang;
  /** Diagnostic hook: failure code + real error detail for the console. */
  onError?: (code: ErrorCode, detail: string) => void;
  /** Live mic level fan-out (overlay). Receives the turn's tab for routing. */
  onLevel?: (level: number, tabId: number | undefined) => void;
}

let turnCounter = 0;

/** Builds a unique turn id. The service worker supplies one per shortcut
 *  press; this fallback covers direct/test callers. Uniqueness is what makes
 *  overlapping-press detection and transcript idempotency possible. */
export function newTurnId(): string {
  turnCounter += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `turn_${crypto.randomUUID()}`;
  }
  return `turn_${turnCounter}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

export class VoiceTurnManager {
  /** Tab the in-flight turn belongs to; undefined when the starter could not
   *  resolve one. Carried on VOICE_TRANSCRIPT so the worker can route it. */
  private targetTabId: number | undefined;
  /**
   * Voice-turn mutex (the concurrency guard). startTurn() sets it for the
   * whole capture → transcribe → forward pipeline and clears it in `finally`,
   * so a second Ctrl+Shift+V while a turn is active is refused with `busy`
   * instead of opening a second overlapping capture/transcription that would
   * double free-tier provider spend. No arbitrary timeouts involved.
   */
  private activeTurnId: string | null = null;

  constructor(private readonly deps: TurnDeps) {}

  /** Records which tab this turn is for. Called before each startTurn(). */
  setTargetTab(tabId: number | undefined): void {
    this.targetTabId = tabId;
  }

  /** True while a turn owns the microphone/transcription pipeline. */
  isTurnActive(): boolean {
    return this.activeTurnId !== null;
  }

  stopCapture(): void {
    this.deps.capture.stopManual();
  }

  async startTurn(turnId?: string): Promise<TurnOutcome> {
    if (this.activeTurnId !== null) {
      // Overlapping press: refuse BEFORE touching mic, network, or speech so
      // one shortcut can never fan out into two provider request chains.
      logger.warn("voice: turn refused while another turn is active", {
        turnId: turnId ?? "no-turn",
        requestType: "voice-turn",
        timestampMs: Date.now(),
        outcome: "busy",
        activeTurnId: this.activeTurnId,
      });
      return { status: "busy" };
    }
    if (this.deps.audio.isSpeaking()) {
      // Barge-in: the user pressed the shortcut while narration was playing
      // (the normal case on real tabs — extension pages are silent, which is
      // why capture "only worked there"). Halt speech, let the echo decay,
      // then capture. The 450ms capture warmup covers residual speaker sound.
      if (this.deps.audio.stopAll === undefined) {
        return { status: "refused-speaking" };
      }
      this.deps.audio.stopAll();
      await new Promise((r) => setTimeout(r, 250));
    }
    const requestId = turnId ?? newTurnId();
    this.activeTurnId = requestId;
    logger.info("voice: turn started", {
      turnId: requestId,
      requestType: "voice-turn",
      timestampMs: Date.now(),
    });
    try {
      this.deps.audio.beep("listening");
      let captured: CaptureResult;
      try {
        captured = await this.deps.capture.start({
          onLevel: (level) => this.deps.onLevel?.(level, this.targetTabId),
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.deps.audio.beep("error");
        if (err instanceof VoiceCaptureError && err.code === "empty") {
          // Nothing above the energy threshold — tell the user instead of
          // silence, so "mic not working" is distinguishable from "no audio".
          this.deps.onError?.("CAPTURE_EMPTY", detail);
          this.speakError("CAPTURE_EMPTY", requestId);
          logger.info("voice: turn finished", {
            turnId: requestId,
            requestType: "voice-turn",
            timestampMs: Date.now(),
            outcome: "empty",
          });
          return { status: "empty" };
        }
        this.deps.onError?.("VOICE_CAPTURE_FAILED", detail);
        return this.fail("VOICE_CAPTURE_FAILED", requestId);
      }
      this.deps.audio.beep("captured");
      let text: string;
      try {
        const result = await this.deps.transcribe(captured.blob, requestId);
        text = result.text;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const rateLimited = err instanceof TranscriptionError && err.status === 429;
        // A 429 ends the turn with ONE honest spoken message. It is never
        // retried here: the quota is spent, and the error speech itself costs
        // a TTS call against the same shared budget.
        const code: ErrorCode = rateLimited ? "RATE_LIMITED" : "TRANSCRIPTION_FAILED";
        this.deps.onError?.(code, detail);
        return this.fail(code, requestId);
      }
      const transcript = toTranscript(text);
      // The turn id travels with the transcript: the worker drops a second
      // delivery of the same turn instead of routing (and reasoning over) it
      // twice.
      transcript.turnId = requestId;
      await this.deps.sendTranscript(transcript, this.targetTabId);
      logger.info("voice: turn finished", {
        turnId: requestId,
        requestType: "voice-turn",
        timestampMs: Date.now(),
        outcome: "transcribed",
        audioBytes: captured.blob.size,
      });
      return { status: "transcribed", transcript };
    } finally {
      this.activeTurnId = null;
    }
  }

  private speakError(code: ErrorCode, requestId: string): void {
    this.deps.audio.enqueue({
      text: getErrorSpeech(code, this.deps.speechLang),
      lang: this.deps.speechLang === "hi" ? "hi" : "en",
      priority: 3,
      interruptible: true,
      requestId,
    });
  }

  private fail(code: ErrorCode, requestId: string): TurnOutcome {
    logger.info("voice: turn finished", {
      turnId: requestId,
      requestType: "voice-turn",
      timestampMs: Date.now(),
      outcome: "failed",
      errorCode: code,
    });
    this.speakError(code, requestId);
    return { status: "failed", code };
  }
}
