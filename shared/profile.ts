/**
 * Saved user details ("My details") — shared contract between the Options
 * page (writes) and the agent controller (reads).
 *
 * Purpose: the user stores ordinary contact details once (name, email,
 * phone, address) so voice commands like "fill in my details" / "enter my
 * email" work without being asked every time. The controller pre-seeds new
 * tasks' `providedValues` from here, which flows into the existing slot-fill
 * path (prompt grounding + deterministic type) unchanged.
 *
 * Security (PRD 6 §6 memory-only rule preserved):
 * - Fixed field allowlist: name/email/phone/address ONLY. Passwords, OTPs,
 *   card numbers and any other secret are unrepresentable — sanitizeProfile
 *   drops everything else, and the Options UI offers no field for them.
 * - Device-local only (chrome.storage.local), same class as the backend
 *   URL/token. Never synced, never logged, never sent anywhere except as
 *   ordinary slot-fill values into pages the user asked to fill.
 * - `providedValues` stays stripped from MCP task-state output (existing).
 */
export const PROFILE_FIELDS = ["name", "email", "phone", "address"] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

export type UserProfile = Partial<Record<ProfileField, string>>;

/** Per-value bound: generous for addresses, far below any quota. */
export const PROFILE_VALUE_MAX_CHARS = 200;

/**
 * Keeps only allowlisted fields with non-empty trimmed values inside the
 * length bound. Unknown keys (including any secret smuggled under another
 * name) are dropped. Never throws.
 */
export function sanitizeProfile(raw: unknown): UserProfile {
  const out: UserProfile = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;
  for (const field of PROFILE_FIELDS) {
    const value = rec[field];
    if (typeof value !== "string") continue;
    const clean = value.trim();
    if (clean === "") continue;
    out[field] = clean.slice(0, PROFILE_VALUE_MAX_CHARS);
  }
  return out;
}

/** True when at least one detail is saved. */
export function hasProfile(profile: UserProfile): boolean {
  return PROFILE_FIELDS.some(
    (f) => typeof profile[f] === "string" && (profile[f] as string) !== "",
  );
}
