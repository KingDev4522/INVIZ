/**
 * Shared stub guard (PRD 4 §67 no-simulation rule).
 * Unimplemented components throw — they never return fabricated data.
 * A stub that returns a fake transcript, action, or verdict is a defect.
 */

/** Throws unconditionally. Used by every Phase-N stub until its phase. */
export function unimplemented(component: string, phase: string): never {
  throw new Error(`NOT_IMPLEMENTED (${phase}): ${component}`);
}
