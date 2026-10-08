/**
 * Skill persistence — REAL (Phase 4).
 *
 * A controlled, replaceable persistence layer. It keeps three concerns
 * separate — Skill DEFINITION (Skill), Skill REGISTRY (SkillRegistry) and Skill
 * PERSISTENCE (SkillStore) — so a skill definition never touches storage and
 * the storage backend can be swapped (in-memory for tests, chrome.storage.local
 * in the extension) without changing the registry or the skills.
 *
 * Fail-closed rules:
 *  - Every persisted record is VALIDATED with the same validateSkill() the
 *    registry uses. An invalid record is dropped and reported, never repaired.
 *  - Each record carries a content hash of its implementation; a mismatch is
 *    refused, so a persisted file cannot smuggle a different implementation
 *    under a trusted id+version.
 *  - The file is bounded (count + bytes) and schema-versioned.
 *  - Nothing here persists secrets: a Skill contains no credentials by contract.
 */
import type { Skill, SkillStatus } from "../../../shared/types.js";
import { validateSkill } from "../../../shared/skill-validation.js";
import {
  skillContentHash,
  stableStringify,
} from "../../../shared/skill-integrity.js";
import type { SkillRegistry } from "./registry.js";

export const SKILL_STORE_SCHEMA_VERSION = 1;
export const MAX_PERSISTED_SKILLS = 128;
export const MAX_PERSISTED_BYTES = 262_144; // 256 KiB

/**
 * The persistence port. Intentionally string-based so the same logic works over
 * chrome.storage, an in-memory map, or any future backend.
 */
export interface SkillStore {
  load(): Promise<string | null>;
  save(serialized: string): Promise<void>;
  clear?(): Promise<void>;
}

/** A replaceable, dependency-free store for tests and non-extension contexts. */
export class MemorySkillStore implements SkillStore {
  private value: string | null = null;

  async load(): Promise<string | null> {
    return this.value;
  }

  async save(serialized: string): Promise<void> {
    this.value = serialized;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

export interface PersistedSkillRecord {
  contentHash: string;
  status: SkillStatus;
  skill: Skill;
}

export interface PersistedSkillFile {
  schemaVersion: number;
  savedAt: number;
  records: PersistedSkillRecord[];
}

export interface PersistResult {
  ok: boolean;
  saved: number;
  skipped: string[];
  bytes: number;
  error?: string;
}

export interface LoadResult {
  applied: number;
  registered: number;
  rejected: string[];
}

function buildFile(skills: Skill[], now: number): PersistedSkillFile {
  const records: PersistedSkillRecord[] = [];
  for (const skill of skills) {
    records.push({
      contentHash: skillContentHash(skill),
      status: skill.status,
      skill: { ...skill },
    });
  }
  return { schemaVersion: SKILL_STORE_SCHEMA_VERSION, savedAt: now, records };
}

/**
 * Serializes a skill set, enforcing the count bound. Never throws on oversize —
 * it drops the surplus and reports it, so a runaway skill set cannot wedge the
 * extension by failing every save.
 */
export function serializeSkills(
  skills: readonly Skill[],
  now = Date.now(),
): { serialized: string; saved: number; skipped: string[] } {
  const skipped: string[] = [];
  const kept: Skill[] = [];
  for (const skill of skills) {
    if (kept.length >= MAX_PERSISTED_SKILLS) {
      skipped.push(`${skill.id}@${skill.version}: exceeds skill count bound`);
      continue;
    }
    kept.push(skill);
  }
  const serialized = stableStringify(buildFile(kept, now));
  return { serialized, saved: kept.length, skipped };
}

/** Serializes + persists the registry's full version set. */
export async function persistRegistry(
  store: SkillStore,
  registry: SkillRegistry,
  now = Date.now(),
): Promise<PersistResult> {
  const { serialized, saved, skipped } = serializeSkills(registry.exportSkills(), now);
  const bytes = serialized.length;
  if (bytes > MAX_PERSISTED_BYTES) {
    // Refuse to write an oversized blob rather than silently truncating it.
    return {
      ok: false,
      saved: 0,
      skipped,
      bytes,
      error: `serialized skills exceed ${MAX_PERSISTED_BYTES} byte bound`,
    };
  }
  try {
    await store.save(serialized);
  } catch (err) {
    return {
      ok: false,
      saved: 0,
      skipped,
      bytes,
      error: err instanceof Error ? err.message : "persistence write failed",
    };
  }
  return { ok: true, saved, skipped, bytes };
}

function parseFile(raw: string): { file?: PersistedSkillFile; error?: string } {
  if (raw.length > MAX_PERSISTED_BYTES) {
    return { error: `persisted skills exceed ${MAX_PERSISTED_BYTES} byte bound` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "persisted skills are not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "persisted skills must be an object" };
  }
  const file = parsed as Partial<PersistedSkillFile>;
  if (file.schemaVersion !== SKILL_STORE_SCHEMA_VERSION) {
    return { error: `unsupported persisted schema version ${String(file.schemaVersion)}` };
  }
  if (!Array.isArray(file.records)) {
    return { error: "persisted records must be an array" };
  }
  if (file.records.length > MAX_PERSISTED_SKILLS) {
    return { error: `persisted records exceed ${MAX_PERSISTED_SKILLS} entry bound` };
  }
  return { file: file as PersistedSkillFile };
}

/**
 * Loads a persisted skill set into a registry. Built-ins are registered first
 * by the caller, so a persisted record that matches an existing id+version
 * restores its TRUST STATE only (via applyPersistedState); a record for an
 * unknown id/version is registered as a full definition. Anything malformed,
 * hash-mismatched, or otherwise invalid is rejected and reported — never
 * repaired, never trusted implicitly.
 */
export async function loadRegistryFromStore(
  store: SkillStore,
  registry: SkillRegistry,
): Promise<LoadResult> {
  const rejected: string[] = [];
  let applied = 0;
  let registered = 0;

  let raw: string | null;
  try {
    raw = await store.load();
  } catch (err) {
    rejected.push(err instanceof Error ? err.message : "persistence read failed");
    return { applied, registered, rejected };
  }
  if (raw === null || raw === "") return { applied, registered, rejected };

  const { file, error } = parseFile(raw);
  if (file === undefined) {
    rejected.push(error ?? "invalid persisted skills");
    return { applied, registered, rejected };
  }

  for (const record of file.records) {
    if (typeof record !== "object" || record === null) {
      rejected.push("record: must be an object");
      continue;
    }
    const skill = record.skill as unknown;
    const validation = validateSkill(skill);
    if (!validation.valid) {
      rejected.push(`invalid record: ${validation.errors.join("; ")}`);
      continue;
    }
    const typed = skill as Skill;
    const expectedHash = record.contentHash;
    if (expectedHash !== skillContentHash(typed)) {
      rejected.push(`${typed.id}@${typed.version}: content hash mismatch`);
      continue;
    }
    const existing = registry.getVersion(typed.id, typed.version);
    if (existing !== null) {
      // Restore TRUST STATE only. applyPersistedState re-checks the content
      // hash against the registered implementation and never mutates the
      // definition, so a persisted file can change a skill's trust but never
      // its behaviour.
      const result = registry.applyPersistedState(typed);
      if (!result.ok) {
        rejected.push(`${typed.id}@${typed.version}: ${result.error ?? "rejected"}`);
        continue;
      }
      applied += 1;
    } else {
      const result = registry.register(typed, { approval: { approver: "persisted" } });
      if (!result.ok) {
        rejected.push(`${typed.id}@${typed.version}: ${result.errors.join("; ")}`);
        continue;
      }
      registered += 1;
    }
  }
  return { applied, registered, rejected };
}

/**
 * Persists the registry on every mutation. Returns a detach function. Write
 * failures are swallowed (a save must never break a running task) but the last
 * error is exposed for diagnostics.
 */
export function attachPersistence(
  store: SkillStore,
  registry: SkillRegistry,
  now: () => number = () => Date.now(),
): { detach: () => void; lastError: () => string | null } {
  let lastError: string | null = null;
  const persist = (): void => {
    void persistRegistry(store, registry, now()).then((result) => {
      lastError = result.ok ? null : (result.error ?? null);
    });
  };
  const detach = registry.onChange(persist);
  return { detach, lastError: () => lastError };
}
