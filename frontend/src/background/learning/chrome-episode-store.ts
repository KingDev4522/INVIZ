/**
 * chrome.storage.local-backed EpisodeStore (Phase 5).
 *
 * Lives in the background layer so the learning module stays storage-agnostic,
 * mirroring how ChromeLocalSkillStore sits beside skills/persistence.ts.
 * chrome.storage.local survives browser restarts and has a 10 MB quota, which
 * the MAX_EPISODES × MAX_EPISODE_BYTES bound sits well inside.
 */
import { STORAGE_KEY_EPISODES } from "../../../../shared/constants.js";
import type { EpisodeStore } from "../../learning/episode-store.js";

export class ChromeEpisodeStore implements EpisodeStore {
  async load(): Promise<string | null> {
    const stored = await chrome.storage.local.get(STORAGE_KEY_EPISODES);
    const value = stored[STORAGE_KEY_EPISODES];
    return typeof value === "string" ? value : null;
  }

  async save(serialized: string): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY_EPISODES]: serialized });
  }

  async clear(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEY_EPISODES);
  }
}
