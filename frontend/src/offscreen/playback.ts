/**
 * Real playback backends for the offscreen document (PRD 6.2).
 * HtmlAudioBackend: plays synthesized MP3 blobs. SpeechSynthesisBackend:
 * genuine local synthesis fallback. WebAudioBeeper: zero-network earcons.
 */
import type {
  Beeper,
  FallbackBackend,
  PlayBackend,
} from "./audio-controller.js";
import type { TtsLang } from "../../../shared/api.js";
import { speakLocal, stopLocal } from "../tts/speech-synthesis-fallback.js";

export class HtmlAudioBackend implements PlayBackend {
  readonly name = "html-audio";
  private audio: HTMLAudioElement | null = null;
  private rejectCurrent: ((err: Error) => void) | null = null;

  play(blob: Blob): Promise<void> {
    this.stop();
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      this.audio = audio;
      this.rejectCurrent = reject;
      const cleanup = (): void => {
        URL.revokeObjectURL(url);
        if (this.audio === audio) {
          this.audio = null;
          this.rejectCurrent = null;
        }
      };
      audio.onended = () => {
        cleanup();
        resolve();
      };
      audio.onerror = () => {
        cleanup();
        reject(new Error("audio element playback failed"));
      };
      audio.src = url;
      audio.play().catch((err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error("audio play() rejected"));
      });
    });
  }

  stop(): void {
    this.rejectCurrent?.(new Error("playback stopped"));
    this.rejectCurrent = null;
    if (this.audio !== null) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio = null;
    }
  }
}

export class SpeechSynthesisBackend implements FallbackBackend {
  readonly name = "speech-synthesis";

  speak(text: string, lang: TtsLang): Promise<void> {
    return speakLocal(text, lang);
  }

  stop(): void {
    stopLocal();
  }
}

const EARCON_FREQ = { listening: 660, captured: 440, error: 220 } as const;
const EARCON_MS = { listening: 80, captured: 120, error: 200 } as const;

export class WebAudioBeeper implements Beeper {
  private context: AudioContext | null = null;

  beep(kind: "listening" | "captured" | "error"): void {
    try {
      this.context ??= new AudioContext();
      const ctx = this.context;
      if (ctx.state === "suspended") {
        void ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = EARCON_FREQ[kind];
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + EARCON_MS[kind] / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + EARCON_MS[kind] / 1000);
    } catch {
      // Earcons are advisory; never break speech on audio-context failure.
    }
  }
}
