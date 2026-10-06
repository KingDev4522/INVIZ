/**
 * On-screen voice status contract (worker → tab content overlay).
 * One-way live narration of a voice turn: listening → transcribing →
 * transcript → thinking → speaking → done/error. Internal Chrome messages
 * only — never provider traffic, never logged verbatim (transcript text is
 * the user's own speech shown on their own screen, truncated for display).
 */

/** Every moment of a turn the overlay can be in. */
export type VoicePhase =
  | "listening"
  | "transcribing"
  | "transcript"
  | "thinking"
  | "awaiting"
  | "speaking"
  | "done"
  | "error"
  | "busy";

/** Payload carried on a VOICE_STATUS message. */
export interface VoiceStatusPayload {
  phase: VoicePhase;
  /** Voice-turn correlation id (absent only for pre-turn failures). */
  turnId?: string;
  /** Short display text (headline or transcript excerpt). Truncated by sender. */
  text?: string;
}

/** Max display characters for user speech excerpts on the overlay. */
export const VOICE_STATUS_TEXT_MAX = 180;

/** Truncates display text with an ellipsis; never throws on bad input. */
export function truncateStatusText(text: string, max = VOICE_STATUS_TEXT_MAX): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
