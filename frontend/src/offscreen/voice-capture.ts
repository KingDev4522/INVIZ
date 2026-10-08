/**
 * Voice capture pipeline (PRD 6.3 §3.1; PRD 6 §4.2).
 * MediaRecorder Opus in the USER_MEDIA offscreen document, WebAudio energy
 * VAD with 1.5s silence auto-stop, 60s hard cap, sub-0.5s discard.
 * Buffers are released immediately after handoff — never retained (PRD 5 §30).
 */

export type CaptureEndReason = "silence" | "manual" | "timeout";

export interface CaptureResult {
  blob: Blob;
  durationMs: number;
  /** Milliseconds above the energy threshold (content-bearing audio). */
  effectiveMs: number;
  ended: CaptureEndReason;
}

export class VoiceCaptureError extends Error {
  readonly code: "empty" | "denied" | "device" | "timeout";
  constructor(code: "empty" | "denied" | "device" | "timeout", message: string) {
    super(message);
    this.name = "VoiceCaptureError";
    this.code = code;
  }
}

/** RMS energy of a time-domain sample window. Pure — unit-tested. */
export function rms(samples: Float32Array | number[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Energy VAD: speech latches on first above-threshold window; silence-stop
 * fires only after latched speech + sustained sub-threshold audio.
 * Never stops on leading silence (user thinking before speaking).
 */
export class SilenceDetector {
  private hasSpeech = false;
  private lastSpeechAt = 0;

  constructor(
    private readonly silenceMs: number = 1500,
    private readonly threshold: number = 0.02,
  ) {}

  reset(nowMs: number): void {
    this.hasSpeech = false;
    this.lastSpeechAt = nowMs;
  }

  /** Returns "silence-stop" exactly once when the stop condition trips. */
  push(energy: number, nowMs: number): "speech" | "listening" | "silence-stop" {
    if (energy >= this.threshold) {
      this.hasSpeech = true;
      this.lastSpeechAt = nowMs;
      return "speech";
    }
    if (this.hasSpeech && nowMs - this.lastSpeechAt >= this.silenceMs) {
      this.hasSpeech = false; // fire once
      return "silence-stop";
    }
    return "listening";
  }

  get heardSpeech(): boolean {
    return this.hasSpeech;
  }
}

/**
 * Per-tick decision, split out from the capture loop so the VAD/warmup
 * interaction is unit-testable without a microphone (same rationale as
 * `rms` and `SilenceDetector`).
 */
export interface TickInput {
  energy: number;
  nowMs: number;
  startedAtMs: number;
  warmupMs: number;
  onsetTimeoutMs: number;
  threshold: number;
  lastTickMs: number;
  detector: SilenceDetector;
  /** True once energy above threshold landed OUTSIDE the warmup window. */
  heardAfterWarmup: boolean;
}

export interface TickResult {
  verdict: "speech" | "listening" | "silence-stop";
  /** Milliseconds to add to effectiveMs (0 during warmup). */
  effectiveDeltaMs: number;
  heardAfterWarmup: boolean;
  /** True when the turn should stop because nothing was ever heard. */
  onsetTimedOut: boolean;
}

export function decideTick(input: TickInput): TickResult {
  const inWarmup = input.nowMs - input.startedAtMs < input.warmupMs;
  // The VAD is fed even during warmup: the listening earcon must not count as
  // speech, but a user who starts talking over it must still latch. Otherwise
  // short answers ("yes") never latch, never stop the turn, and the whole
  // capture is later discarded as empty.
  const verdict = input.detector.push(input.energy, input.nowMs);
  const above = input.energy >= input.threshold;
  const effectiveDeltaMs = !inWarmup && above ? input.nowMs - input.lastTickMs : 0;
  const heardAfterWarmup = input.heardAfterWarmup || (!inWarmup && above);
  // Onset failsafe: nothing was ever heard outside the warmup, so stop
  // promptly instead of sitting open for the full maxSeconds hard cap.
  const onsetTimedOut =
    !heardAfterWarmup &&
    input.nowMs - input.startedAtMs >= input.warmupMs + input.onsetTimeoutMs;
  return { verdict, effectiveDeltaMs, heardAfterWarmup, onsetTimedOut };
}

export interface CaptureOptions {
  maxSeconds?: number;
  silenceMs?: number;
  threshold?: number;
  sampleIntervalMs?: number;
  minEffectiveMs?: number;  /** Leading window (ms) whose energy never counts as effective speech — the
   *  listening earcon is still in the air when capture starts. Energy here
   *  still latches the VAD, so a user who starts talking immediately is heard. */
  warmupMs?: number;
  /** After the warmup, how long to wait for the FIRST sound before giving up.
   *  Without this, a turn that never latches would run to the full hard cap. */
  onsetTimeoutMs?: number;
}

/** Post-capture diagnostics: proves (or disproves) the mic delivered audio. */
export interface CaptureStats {
  ended: CaptureEndReason;
  durationMs: number;
  effectiveMs: number;
  peakRms: number;
  ticks: number;
  trackLabel: string;
  trackState: string;
  audioContextState: string;
  /** Which getUserMedia constraint set opened the mic. */
  micMode: "ideal" | "basic";
}

export interface CaptureEvents {
  onStats?: (stats: CaptureStats) => void;
  /** Live mic RMS energy (0..~0.3 speech) for the on-screen level overlay. */
  onLevel?: (rms: number) => void;
}

/** Level pushes per second to the overlay (5Hz: smooth, not chatty). */
const LEVEL_INTERVAL_MS = 200;

/** Maps a getUserMedia rejection to a precise capture error (never generic). */
function toCaptureError(err: unknown): VoiceCaptureError {
  const name =
    typeof DOMException !== "undefined" && err instanceof DOMException
      ? err.name
      : err instanceof Error
        ? err.name
        : "";
  if (
    name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "NotReadableError"
  ) {
    return new VoiceCaptureError(
      "device",
      `no usable microphone (${name || "unknown error"})`,
    );
  }
  return new VoiceCaptureError(
    "denied",
    `microphone permission denied or unavailable (${name !== "" ? name : "unknown error"} — grant it in extension Options → Enable microphone)`,
  );
}

export class VoiceCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private manualStop = false;
  private onManualStop: (() => void) | null = null;

  /** Resolves on silence/timeout; rejects on empty/denied/device failure. */
  async start(options: CaptureOptions = {}, events: CaptureEvents = {}): Promise<CaptureResult> {
    const maxSeconds = options.maxSeconds ?? 60;
    const minEffectiveMs = options.minEffectiveMs ?? 500;
    const warmupMs = options.warmupMs ?? 450;
    const onsetTimeoutMs = options.onsetTimeoutMs ?? 3000;
    const detector = new SilenceDetector(
      options.silenceMs ?? 1500,
      options.threshold ?? 0.02,
    );
    const startedAt = Date.now();
    detector.reset(startedAt);

    let micMode: "ideal" | "basic" = "ideal";
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (err) {
      // Strict processing constraints (AEC/NS/channelCount) are not
      // satisfiable on every Windows driver or USB mic: the call throws
      // OverconstrainedError even though the mic itself works (the Options
      // page proves it with a plain {audio:true} request). Retry
      // unconstrained before reporting failure.
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micMode = "basic";
      } catch {
        throw toCaptureError(err);
      }
    }
    const track = this.stream.getAudioTracks()[0];
    if (track === undefined || track.readyState !== "live") {
      this.cleanup();
      throw new VoiceCaptureError("device", "microphone track is not live");
    }

    const chunks: Blob[] = [];
    let effectiveMs = 0;
    let peakRms = 0;
    let ticks = 0;
    let lastLevelSent = 0;
    let lastTick = startedAt;
    let ended: CaptureEndReason = "timeout";
    // Latched only by energy OUTSIDE the warmup window, so the listening
    // earcon bleeding into the microphone can neither hold the turn open nor
    // satisfy the onset failsafe below.
    let heardAfterWarmup = false;
    this.manualStop = false;

    const context = new AudioContext();
    this.audioContext = context;
    try {
      // Offscreen documents may start suspended (no local user gesture);
      // a suspended context hands the analyser zeros, which VAD would read
      // as permanent silence.
      await context.resume();
    } catch {
      // Read-only context: the stats below will expose it (zeros).
    }
    const source = context.createMediaStreamSource(this.stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    const preferredType = "audio/webm;codecs=opus";
    const mimeType =
      typeof MediaRecorder !== "undefined" &&
      typeof MediaRecorder.isTypeSupported === "function" &&
      MediaRecorder.isTypeSupported(preferredType)
        ? preferredType
        : "";
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        this.stream,
        mimeType !== ""
          ? { mimeType, audioBitsPerSecond: 32000 }
          : { audioBitsPerSecond: 32000 },
      );
    } catch (err) {
      this.cleanup();
      throw new VoiceCaptureError(
        "device",
        `recorder cannot start (${err instanceof Error ? err.message : "unknown"})`,
      );
    }
    this.recorder = recorder;
    // finish() is the single resolver: recorder.onstop alone cannot be
    // trusted (an errored recorder goes inactive WITHOUT firing stop, which
    // used to hang the turn forever with no outcome and no speech).
    let stopResolve: (() => void) | null = null;
    const stopped = new Promise<void>((resolve) => {
      stopResolve = resolve;
    });
    recorder.onstop = () => {
      stopResolve?.();
    };
    recorder.start(250);

    let finished = false;
    const finish = (reason: CaptureEndReason): void => {
      if (finished) return;
      finished = true;
      ended = reason;
      try {
        recorder.state !== "inactive" && recorder.stop();
      } catch {
        // Already stopped.
      }
      stopResolve?.();
      if (this.onManualStop !== null && reason === "manual") {
        this.onManualStop();
      }
    };
    this.onManualStop = null;
    const manualPromise = new Promise<void>((resolve) => {
      this.onManualStop = () => resolve();
    });

    const tick = (): void => {
      if (this.manualStop) {
        finish("manual");
        return;
      }
      const now = Date.now();
      if (now - startedAt >= maxSeconds * 1000) {
        finish("timeout");
        return;
      }
      analyser.getFloatTimeDomainData(samples);
      const energy = rms(samples);
      ticks += 1;
      // Overlay feed (throttled): sent even during warmup so the listening
      // earcon's spike is visible rather than mysterious.
      if (now - lastLevelSent >= LEVEL_INTERVAL_MS) {
        lastLevelSent = now;
        try {
          events.onLevel?.(energy);
        } catch {
          // Overlay is advisory; never break capture on a listener failure.
        }
      }
      if (energy > peakRms) peakRms = energy;
      const decision = decideTick({
        energy,
        nowMs: now,
        startedAtMs: startedAt,
        warmupMs,
        onsetTimeoutMs,
        threshold: options.threshold ?? 0.02,
        lastTickMs: lastTick,
        detector,
        heardAfterWarmup,
      });
      effectiveMs += decision.effectiveDeltaMs;
      heardAfterWarmup = decision.heardAfterWarmup;
      lastTick = now;
      if (decision.verdict === "silence-stop") {
        finish("silence");
        return;
      }
      if (decision.onsetTimedOut) {
        finish("silence");
        return;
      }
      // A recorder that died without onstop (track ended, device error)
      // would otherwise stall the turn forever: close it out as a timeout.
      if (recorder.state === "inactive") {
        finish("timeout");
        return;
      }
      if (!this.manualStop) {
        setTimeout(tick, options.sampleIntervalMs ?? 100);
      }
    };
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    setTimeout(tick, options.sampleIntervalMs ?? 100);
    await Promise.race([
      stopped,
      manualPromise.then(() => {
        finish("manual");
        return stopped;
      }),
    ]);

    const ctxStateAtCapture = context.state;
    this.cleanup();
    const durationMs = Date.now() - startedAt;
    try {
      events.onStats?.({
        ended,
        durationMs,
        effectiveMs,
        peakRms,
        ticks,
        trackLabel: track.label,
        trackState: track.readyState,
        audioContextState: ctxStateAtCapture,
        micMode,
      });
    } catch {
      // Diagnostics must never break the turn.
    }
    if (effectiveMs < minEffectiveMs) {
      throw new VoiceCaptureError("empty", "no effective speech captured");
    }
    const blob = new Blob(chunks, {
      type: mimeType !== "" ? mimeType : "audio/webm",
    });
    if (blob.size === 0) {
      throw new VoiceCaptureError(
        "empty",
        `recorder produced no audio bytes (chunks=${chunks.length}, mime=${mimeType !== "" ? mimeType : "default"})`,
      );
    }
    return {
      blob,
      durationMs,
      effectiveMs,
      ended,
    };
  }

  stopManual(): void {
    this.manualStop = true;
    if (this.onManualStop !== null) {
      const cb = this.onManualStop;
      this.onManualStop = null;
      cb();
    }
    try {
      if (this.recorder !== null && this.recorder.state !== "inactive") {
        this.recorder.stop();
      }
    } catch {
      // Already stopped.
    }
  }

  private cleanup(): void {
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {
      // Tracks already stopped.
    }
    this.stream = null;
    this.recorder = null;
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.onManualStop = null;
  }
}
