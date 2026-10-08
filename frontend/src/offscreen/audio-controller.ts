/**
 * Audio Controller: priority queue, preemption, dedupe, half-duplex gate
 * (PRD 3 §47–50; PRD 4 §37, §92–93; PRD 6 §4.3).
 * Backend-agnostic: synthesis/playback are injected, so every scheduling rule
 * is unit-testable without audio hardware. Priority 1 = highest.
 */

import type { AudioPriority, AudioRequest } from "../../../shared/types.js";
import {
  TTS_AUDIO_CACHE_MAX_BYTES,
  TTS_MAX_BYTES_PER_REQUEST,
} from "../../../shared/constants.js";
import {
  cacheKey,
  chunkText,
  splitMixedSegments,
} from "../tts/text-shaping.js";
import {
  BackendError,
  type BackendRef,
  type SpeechLang,
} from "../../../shared/api.js";

/** Primary synthesis backend (INVIZ backend /v1/tts). Narrow interface for testability. */
export interface SynthBackend {
  readonly name: string;
  synthesize(
    text: string,
    lang: SpeechLang,
    backend: BackendRef,
    requestId?: string,
  ): Promise<Blob>;
}

/** Audio playback backend (HTMLAudio in the offscreen document). */
export interface PlayBackend {
  readonly name: string;
  play(blob: Blob): Promise<void>;
  stop(): void;
}

/** Local-speech fallback backend (speechSynthesis). */
export interface FallbackBackend {
  readonly name: string;
  speak(text: string, lang: SpeechLang): Promise<void>;
  stop(): void;
}

export interface Beeper {
  beep(kind: "listening" | "captured" | "error"): void;
}

export interface ControllerEvents {
  onAuthExpired?: () => void;
  onPrimaryLatchedFallback?: () => void;
  /**
   * Fires when audible speech starts/stops (priority included so callers can
   * ignore focus chatter). Drives the on-screen speaking state; advisory only.
   */
  onSpeakingChange?: (speaking: boolean, priority: AudioPriority) => void;
}

interface QueueEntry {
  req: AudioRequest;
  segments: Array<{ text: string; lang: SpeechLang }>;
  signature: string;
  order: number;
}

export class AudioController {
  private queue: QueueEntry[] = [];
  private order = 0;
  private generation = 0;
  private current: { entry: QueueEntry; stop: () => void } | null = null;
  private lastSignature: string | null = null;
  private consecutivePrimaryFailures = 0;
  private primaryLatchedOff = false;
  private draining = false;

  private cache = new Map<string, { blob: Blob; size: number }>();
  private cacheBytes = 0;
  private lastSpoken: { text: string; lang: "en" | "hi" | "mixed" } | null = null;

  constructor(
    private readonly synth: SynthBackend,
    private readonly player: PlayBackend,
    private readonly fallback: FallbackBackend,
    private readonly beeper: Beeper,
    private readonly readCredentials: () => Promise<BackendRef | null>,
    private readonly events: ControllerEvents = {},
  ) {}

  /** True while system speech is audible — capture stays paused (half-duplex). */
  isSpeaking(): boolean {
    return this.current !== null;
  }

  queueDepth(): number {
    return this.queue.length + (this.current !== null ? 1 : 0);
  }

  /**
   * Enqueues one announcement. Returns the disposition for observability.
   * Priority-5 (focus) duplicates of the last utterance are dropped.
   * Higher-priority requests preempt interruptible lower-priority speech.
   */
  enqueue(req: AudioRequest): { disposition: "queued" | "preempted" | "deduped" } {
    const signature = `${req.lang}|${req.text}`;
    // Focus-announcement dedupe: drop repeats of what just played, is playing,
    // or is already queued — rapid Tab must never stack identical speech.
    if (req.priority === 5) {
      if (
        signature === this.lastSignature ||
        this.current?.entry.signature === signature ||
        this.queue.some((e) => e.signature === signature)
      ) {
        return { disposition: "deduped" };
      }
    }
    const segments = splitMixedSegments(req.text, req.lang === "hi" ? "hi" : "en").map(
      (s) => ({ text: s.text, lang: (s.lang === "hi" ? "hi" : "en") as SpeechLang }),
    );
    const entry: QueueEntry = { req, segments, signature, order: this.order++ };
    // Focus takeover: a new focus announcement interrupts a *playing* focus
    // announcement, and replaces focus announcements already waiting in the
    // queue — Tab/hover must only ever speak the element you are on now.
    const focusTakeover =
      req.priority === 5 && this.current?.entry.req.priority === 5;
    if (req.priority === 5) {
      this.queue = this.queue.filter((e) => e.req.priority !== 5);
    }
    if (
      this.current !== null &&
      (req.priority < this.current.entry.req.priority || focusTakeover) &&
      this.current.entry.req.interruptible
    ) {
      this.current.stop();
      this.current = null;
      this.queue.unshift(entry);
      void this.drain();
      return { disposition: "preempted" };
    }
    // Stable priority insert: lower number first, FIFO within a level.
    const index = this.queue.findIndex(
      (e) => e.req.priority > req.priority,
    );
    if (index === -1) this.queue.push(entry);
    else this.queue.splice(index, 0, entry);
    void this.drain();
    return { disposition: "queued" };
  }

  /** Halts current speech and drops interruptible queued items. */
  stop(interruptAll: boolean): void {
    this.generation += 1;
    const wasSpeaking = this.current !== null;
    const priority = this.current?.entry.req.priority;
    this.current?.stop();
    this.current = null;
    if (wasSpeaking) {
      try {
        this.events.onSpeakingChange?.(false, priority ?? 3);
      } catch {
        // Advisory only.
      }
    }
    if (interruptAll) {
      this.queue.length = 0;
    } else {
      this.queue = this.queue.filter((e) => !e.req.interruptible);
    }
    this.draining = false;
  }

  beep(kind: "listening" | "captured" | "error"): void {
    this.beeper.beep(kind);
  }

  /** Re-enqueues the last fully spoken utterance (repeat command). */
  repeatLast(): boolean {
    if (this.lastSpoken === null) return false;
    this.enqueue({
      text: this.lastSpoken.text,
      lang: this.lastSpoken.lang,
      priority: 4,
      interruptible: true,
      requestId: `repeat_${Date.now()}`,
    });
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.current !== null) return;
    const entry = this.queue.shift();
    if (entry === undefined) return;
    this.draining = true;
    const gen = this.generation;
    let stopped = false;
    this.current = {
      entry,
      stop: () => {
        stopped = true;
        try {
          this.player.stop();
        } catch {
          // Backend already silent.
        }
        try {
          this.fallback.stop();
        } catch {
          // Backend already silent.
        }
      },
    };
    try {
      this.events.onSpeakingChange?.(true, entry.req.priority);
    } catch {
      // Advisory only.
    }
    try {
      await this.playEntry(entry, () => stopped || gen !== this.generation);
      this.lastSignature = entry.signature;
      this.lastSpoken = { text: entry.req.text, lang: entry.req.lang };
    } catch {
      // Utterance-level failure already handled per-segment; continue queue.
    } finally {
      if (this.current?.entry === entry) this.current = null;
      this.draining = false;
      try {
        this.events.onSpeakingChange?.(false, entry.req.priority);
      } catch {
        // Advisory only.
      }
      if (this.queue.length > 0) void this.drain();
    }
  }

  private async playEntry(
    entry: QueueEntry,
    cancelled: () => boolean,
  ): Promise<void> {
    for (const segment of entry.segments) {
      if (cancelled()) return;
      const text = segment.text;
      if (text.trim() === "") continue;
      // Long segments are chunked at sentence boundaries (backend byte caps).
      const chunks =
        chunkText(text).length > 1 || needsChunking(text)
          ? chunkText(text, TTS_MAX_BYTES_PER_REQUEST)
          : [text];
      for (const chunk of chunks) {
        if (cancelled()) return;
        await this.playChunk(
          chunk,
          segment.lang,
          entry.req.priority,
          cancelled,
          entry.req.requestId,
        );
      }
    }
    void entry;
  }

  private async playChunk(
    text: string,
    lang: SpeechLang,
    _priority: AudioPriority,
    cancelled: () => boolean,
    requestId?: string,
  ): Promise<void> {
    void _priority;
    if (!this.primaryLatchedOff) {
      let blob: Blob;
      try {
        blob = await this.synthOrCache(text, lang, requestId);
      } catch (err) {
        if (cancelled()) return; // interrupted mid-request: stay silent
        if (err instanceof BackendError && (err.status === 401 || err.status === 403)) {
          this.events.onAuthExpired?.();
        }
        this.consecutivePrimaryFailures += 1;
        if (this.consecutivePrimaryFailures >= 3 && !this.primaryLatchedOff) {
          this.primaryLatchedOff = true;
          this.events.onPrimaryLatchedFallback?.();
        }
        // Fall through to local speech for this utterance.
        await this.fallback.speak(text, lang);
        return;
      }
      this.consecutivePrimaryFailures = 0;
      if (cancelled()) return; // preempted while synthesizing: stay silent
      try {
        await this.player.play(blob);
      } catch {
        // Preemption stops the player too — never "recover" by speaking the
        // interrupted text locally. Only real playback faults fall back.
        if (cancelled()) return;
        await this.fallback.speak(text, lang);
      }
      return;
    }
    if (cancelled()) return;
    await this.fallback.speak(text, lang);
  }

  private async synthOrCache(
    text: string,
    lang: SpeechLang,
    requestId?: string,
  ): Promise<Blob> {
    const key = cacheKey(text, lang);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // LRU touch.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.blob;
    }
    const creds = await this.readCredentials();
    if (creds === null) {
      throw new Error("Backend not configured (URL missing)");
    }
    const blob = await this.synth.synthesize(text, lang, creds, requestId);
    const size = blob.size;
    while (this.cacheBytes + size > TTS_AUDIO_CACHE_MAX_BYTES && this.cache.size > 0) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      const victim = this.cache.get(oldest.value);
      this.cache.delete(oldest.value);
      this.cacheBytes -= victim?.size ?? 0;
    }
    this.cache.set(key, { blob, size });
    this.cacheBytes += size;
    return blob;
  }

  /** Clears a session latch (e.g. after backend validation passes again). */
  resetPrimary(): void {
    this.primaryLatchedOff = false;
    this.consecutivePrimaryFailures = 0;
  }

  /** Test introspection: cached entry count. */
  cacheSize(): number {
    return this.cache.size;
  }

  /** Test introspection: primary latched to fallback. */
  isPrimaryLatchedOff(): boolean {
    return this.primaryLatchedOff;
  }
}

function needsChunking(text: string): boolean {
  return new TextEncoder().encode(text).length > TTS_MAX_BYTES_PER_REQUEST;
}
