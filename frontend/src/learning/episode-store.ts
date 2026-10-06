/**
 * EpisodeStore — REAL (Phase 5).
 *
 * Same shape as Phase 4's SkillStore port (`load(): Promise<string|null>` /
 * `save(s: string): Promise<void>`), so episodes reuse the established
 * persistence architecture rather than introducing a second storage system.
 * The backend is swappable: `MemoryEpisodeStore` for tests, a chrome.storage
 * implementation in the background layer.
 *
 * Fail-closed rules:
 *  - Redaction happens HERE, immediately before persistence (defence in depth:
 *    the recorder redacts on construction, the store redacts again).
 *  - Every episode is validated with validateEpisode(); an invalid episode is
 *    refused, never repaired.
 *  - Storage is bounded by count (MAX_EPISODES) and by per-episode bytes
 *    (MAX_EPISODE_BYTES); oldest episodes are evicted first.
 */
import { MAX_EPISODES, MAX_EPISODE_BYTES } from "../../../shared/constants.js";
import {
  EPISODE_SCHEMA_VERSION,
  redactEpisode,
  validateEpisode,
  type Episode,
} from "../../../shared/episode.js";

/**
 * The persistence port. Structurally identical to SkillStore, deliberately kept
 * separate so episodes and skills cannot be confused or stored interchangeably.
 */
export interface EpisodeStore {
  load(): Promise<string | null>;
  save(serialized: string): Promise<void>;
  clear?(): Promise<void>;
}

/** Dependency-free store for tests and non-extension contexts. */
export class MemoryEpisodeStore implements EpisodeStore {
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

interface EpisodeFile {
  schemaVersion: number;
  savedAt: number;
  episodes: Episode[];
}

export interface EpisodeSaveResult {
  ok: boolean;
  saved: number;
  evicted: number;
  bytes: number;
  error?: string;
}

export interface EpisodeLoadResult {
  episodes: Episode[];
  rejected: string[];
}

function parseFile(raw: string): { file?: EpisodeFile; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "episodes are not valid JSON" };
  }
  if (!isRecord(parsed)) return { error: "episodes must be an object" };
  if (parsed["schemaVersion"] !== EPISODE_SCHEMA_VERSION) {
    return { error: `unsupported episode schema version ${String(parsed["schemaVersion"])}` };
  }
  if (!Array.isArray(parsed["episodes"])) return { error: "episodes must be an array" };
  return { file: parsed as unknown as EpisodeFile };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function serialize(episodes: readonly Episode[], now: number): string {
  const file: EpisodeFile = {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    savedAt: now,
    episodes: [...episodes],
  };
  return JSON.stringify(file);
}

/**
 * Loads every persisted episode, dropping (and reporting) anything invalid.
 * Never throws: a corrupt store degrades to an empty list so the agent keeps
 * running.
 */
export async function loadEpisodes(store: EpisodeStore): Promise<EpisodeLoadResult> {
  const rejected: string[] = [];
  let raw: string | null;
  try {
    raw = await store.load();
  } catch (err) {
    rejected.push(err instanceof Error ? err.message : "episode read failed");
    return { episodes: [], rejected };
  }
  if (raw === null || raw === "") return { episodes: [], rejected };

  const { file, error } = parseFile(raw);
  if (file === undefined) return { episodes: [], rejected: [error ?? "invalid episodes"] };

  const episodes: Episode[] = [];
  for (const candidate of file.episodes) {
    const validation = validateEpisode(candidate);
    if (!validation.valid) {
      rejected.push(`invalid episode: ${validation.errors.join("; ")}`);
      continue;
    }
    episodes.push(candidate);
  }
  return { episodes, rejected };
}

/**
 * Persists one episode: redact → validate → append → evict oldest beyond the
 * count bound → enforce the byte bound. Returns the surviving count.
 */
export async function saveEpisode(
  store: EpisodeStore,
  episode: Episode,
  now = Date.now(),
): Promise<EpisodeSaveResult> {
  const redacted = redactEpisode(episode);
  const validation = validateEpisode(redacted);
  if (!validation.valid) {
    return {
      ok: false,
      saved: 0,
      evicted: 0,
      bytes: 0,
      error: `invalid episode: ${validation.errors.join("; ")}`,
    };
  }
  // Per-episode byte bound: refuse to write one oversized episode rather than
  // truncating it into something that no longer validates.
  const singleBytes = JSON.stringify(redacted).length;
  if (singleBytes > MAX_EPISODE_BYTES) {
    return {
      ok: false,
      saved: 0,
      evicted: 0,
      bytes: singleBytes,
      error: `episode exceeds ${MAX_EPISODE_BYTES} byte bound`,
    };
  }

  const { episodes: existing, rejected } = await loadEpisodes(store);
  if (rejected.some((r) => r.includes("not valid JSON"))) {
    // A corrupt store is not silently trusted — but it also must not block
    // recording forever. Start a fresh file; the rejection is surfaced.
    existing.length = 0;
  }

  const withoutDupes = existing.filter((e) => e.episodeId !== redacted.episodeId);
  withoutDupes.push(redacted);
  const evicted = Math.max(0, withoutDupes.length - MAX_EPISODES);
  const kept = withoutDupes.slice(-MAX_EPISODES);

  const serialized = serialize(kept, now);
  if (serialized.length > MAX_EPISODES * MAX_EPISODE_BYTES) {
    return {
      ok: false,
      saved: 0,
      evicted: 0,
      bytes: serialized.length,
      error: "episode store exceeds byte bound",
    };
  }
  try {
    await store.save(serialized);
  } catch (err) {
    return {
      ok: false,
      saved: 0,
      evicted: 0,
      bytes: 0,
      error: err instanceof Error ? err.message : "episode write failed",
    };
  }
  return { ok: true, saved: kept.length, evicted, bytes: serialized.length };
}

/** Removes one episode by id. */
export async function deleteEpisode(store: EpisodeStore, episodeId: string): Promise<boolean> {
  const { episodes } = await loadEpisodes(store);
  const next = episodes.filter((e) => e.episodeId !== episodeId);
  if (next.length === episodes.length) return false;
  await store.save(serialize(next, Date.now()));
  return true;
}

/** Wipes all recorded episodes. */
export async function clearEpisodes(store: EpisodeStore): Promise<void> {
  if (store.clear !== undefined) {
    await store.clear();
    return;
  }
  await store.save(serialize([], Date.now()));
}
