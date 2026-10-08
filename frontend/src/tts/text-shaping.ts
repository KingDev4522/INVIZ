/**
 * Request-shaping utilities for speech synthesis (frontend side).
 * Chunking (request sizing), mixed-language segmentation, and cache keys are
 * UI-pipeline concerns: they decide WHAT to send, never HOW to synthesize.
 * Synthesis itself lives in the backend. Pure functions — unit-tested.
 */
import {
  TTS_MAX_BYTES_PER_REQUEST,
  TTS_MODEL,
  TTS_VOICE,
} from "../../../shared/constants.js";
import type { TtsLang } from "../../../shared/api.js";

export interface TextSegment {
  text: string;
  lang: TtsLang;
}

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Byte-aware sentence-boundary chunker. Keeps each chunk small enough for the
 * backend /v1/tts contract (TTS_MAX_CHARS). Never splits inside a character
 * (code-point iteration). A single overlong sentence hard-splits on word
 * boundaries as a last resort.
 */
export function chunkText(text: string, maxBytes: number = TTS_MAX_BYTES_PER_REQUEST): string[] {
  if (byteLength(text) <= maxBytes) return [text];
  const sentences = text.split(/(?<=[.!?…।])\s+/u);
  const chunks: string[] = [];
  let current = "";
  const push = (s: string): void => {
    if (s !== "") chunks.push(s);
  };
  for (const sentence of sentences) {
    const candidate = current === "" ? sentence : `${current} ${sentence}`;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }
    push(current);
    if (byteLength(sentence) <= maxBytes) {
      current = sentence;
    } else {
      current = "";
      for (const word of sentence.split(/\s+/u)) {
        const next = current === "" ? word : `${current} ${word}`;
        if (byteLength(next) <= maxBytes) {
          current = next;
        } else {
          push(current);
          current = word;
          // A single word exceeding the cap is emitted alone and will fail
          // loudly at the backend rather than being silently cut.
        }
      }
    }
  }
  push(current);
  return chunks.filter((c) => c !== "");
}

/**
 * Splits mixed-language text into per-language segments (PRD 6 §3.2).
 * Devanagari runs route to the hi voice path; everything else keeps the
 * utterance default lang. Whitespace attaches to the surrounding run.
 */
export function splitMixedSegments(text: string, defaultLang: TtsLang): TextSegment[] {
  const runs: TextSegment[] = [];
  let current = "";
  let currentLang: TtsLang | null = null;
  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed !== "" && currentLang !== null) {
      runs.push({ text: trimmed, lang: currentLang });
    }
    current = "";
    currentLang = null;
  };
  for (const ch of text) {
    if (/\s/u.test(ch)) {
      current += ch; // whitespace joins the surrounding run
      continue;
    }
    const lang: TtsLang = /[\u0900-\u097F]/u.test(ch) ? "hi" : defaultLang;
    if (currentLang === null) {
      currentLang = lang;
    } else if (lang !== currentLang) {
      flush();
      currentLang = lang;
    }
    current += ch;
  }
  flush();
  const merged: TextSegment[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.lang === run.lang) {
      last.text += ` ${run.text}`;
    } else {
      merged.push({ ...run });
    }
  }
  if (merged.length === 0) merged.push({ text, lang: defaultLang });
  return merged;
}

/** djb2 hex digest for cache keys (deterministic, dependency-free). */
export function cacheKey(text: string, lang: TtsLang): string {
  // One voice serves both languages (romanized input for the English-only
  // voice), so `lang` alone separates the two cached forms.
  let hash = 5381;
  const input = `${TTS_MODEL}|${TTS_VOICE}|${lang}|${text}`;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return `tts-${lang}-${(hash >>> 0).toString(16)}`;
}
