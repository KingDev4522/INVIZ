/**
 * Chrome-backed SkillStore (Phase 4).
 *
 * Lives in the background layer — NOT in the skills module — so skill
 * definitions and the registry stay storage-agnostic. Uses chrome.storage.local
 * (durable across browser restarts, unlike storage.session) under a single
 * bounded key. The persistence logic itself lives in skills/persistence.ts.
 */
import { STORAGE_KEY_SKILLS } from "../../../../shared/constants.js";
import type { SkillStore } from "../../skills/persistence.js";

export class ChromeLocalSkillStore implements SkillStore {
  async load(): Promise<string | null> {
    const stored = await chrome.storage.local.get(STORAGE_KEY_SKILLS);
    const value = stored[STORAGE_KEY_SKILLS];
    return typeof value === "string" ? value : null;
  }

  async save(serialized: string): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY_SKILLS]: serialized });
  }

  async clear(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEY_SKILLS);
  }
}
