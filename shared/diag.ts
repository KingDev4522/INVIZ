/**
 * On-device voice activity log (supportability, no DevTools needed).
 * The offscreen document appends one line per voice event (turn started,
 * capture stats, turn failed, transcribed, TTS latch); the Options page
 * renders the ring buffer. Metadata only — never speech content, never audio.
 */

export interface DiagEntry {
  /** Date.now() milliseconds. */
  t: number;
  /** Short category: turn | capture | failed | done | tts. */
  kind: string;
  /** Human-readable detail (error messages, stats — never transcripts). */
  text: string;
}

/** chrome.storage.local key for the ring buffer. */
export const DIAG_KEY = "diag:voice-log";

/** Ring capacity: enough for several attempts, bounded for storage. */
export const DIAG_CAP = 25;

/** Appends one entry, dropping the oldest beyond capacity. Pure. */
export function pushDiag(
  log: DiagEntry[],
  entry: DiagEntry,
  cap: number = DIAG_CAP,
): DiagEntry[] {
  const next = [...log, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** One human-readable line for the Options activity view. Pure. */
export function formatDiagEntry(entry: DiagEntry): string {
  const time = new Date(entry.t).toLocaleTimeString();
  return `[${time}] ${entry.kind}: ${entry.text}`;
}
