/**
 * EpisodeStore tests (Phase 5).
 * Proves persistence is redacted, validated, bounded and fail-closed.
 * No chrome — MemoryEpisodeStore only.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { MAX_EPISODES } from "../../../shared/constants.js";
import {
  EPISODE_SCHEMA_VERSION,
  type Episode,
} from "../../../shared/episode.js";
import {
  MemoryEpisodeStore,
  clearEpisodes,
  deleteEpisode,
  loadEpisodes,
  saveEpisode,
} from "./episode-store.js";

function episode(id: string, overrides: Partial<Episode> = {}): Episode {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: id,
    taskId: `task_${id}`,
    createdAt: 1_000_000,
    recordedAt: 1_001_000,
    goal: "Find the contributors of this repository",
    goalLang: "en",
    pageUrl: "https://github.com/example/project",
    pageTitle: "example/project",
    pageGenerations: [5],
    selectedSkill: null,
    actions: [
      {
        index: 0,
        action: { action: "click", target: "e2", pageGeneration: 5 },
        pageGeneration: 5,
        status: "executed",
        verification: {
          success: true,
          outcome: "VERIFIED_SUCCESS",
          timedOut: false,
          pageGeneration: 5,
        },
      },
    ],
    recoveryEvents: 0,
    finalOutcomeType: "task_complete",
    finalOutcomeText: "Done.",
    finalStatus: "COMPLETE",
    success: true,
    completedActions: 1,
    registrySnapshot: [],
    ...overrides,
  };
}

describe("saveEpisode / loadEpisodes", () => {
  it("persists and reloads a valid episode", async () => {
    const store = new MemoryEpisodeStore();
    const saved = await saveEpisode(store, episode("ep_a"));
    expect(saved.ok).toBe(true);
    const { episodes, rejected } = await loadEpisodes(store);
    expect(rejected).toEqual([]);
    expect(episodes.map((e) => e.episodeId)).toEqual(["ep_a"]);
  });

  it("redacts secrets before they reach persistent storage", async () => {
    const store = new MemoryEpisodeStore();
    await saveEpisode(
      store,
      episode("ep_secret", {
        goal: "submit with password=hunter2 and card 4111111111111111",
        pageUrl: "https://example.com/login?session_token=zzz",
      }),
    );
    const raw = (await store.load()) ?? "";
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("4111111111111111");
    expect(raw).not.toContain("zzz");
    expect(raw).toContain("[REDACTED]");
  });

  it("rejects an invalid episode and stores nothing", async () => {
    const store = new MemoryEpisodeStore();
    const broken = episode("ep_bad", { schemaVersion: 42 });
    const saved = await saveEpisode(store, broken);
    expect(saved.ok).toBe(false);
    expect(saved.error).toContain("schemaVersion");
    expect(await store.load()).toBeNull();
  });

  it("bounds storage to MAX_EPISODES, evicting oldest first", async () => {
    const store = new MemoryEpisodeStore();
    for (let i = 0; i < MAX_EPISODES + 5; i++) {
      await saveEpisode(store, episode(`ep_${i}`));
    }
    const { episodes, rejected } = await loadEpisodes(store);
    expect(rejected).toEqual([]);
    expect(episodes.length).toBe(MAX_EPISODES);
    expect(episodes[0]?.episodeId).toBe(`ep_5`);
    expect(episodes[episodes.length - 1]?.episodeId).toBe(`ep_${MAX_EPISODES + 4}`);
  });

  it("does not duplicate an episode saved twice", async () => {
    const store = new MemoryEpisodeStore();
    await saveEpisode(store, episode("ep_a"));
    await saveEpisode(store, episode("ep_a"));
    const { episodes } = await loadEpisodes(store);
    expect(episodes.length).toBe(1);
  });

  it("fails closed on corrupt storage instead of throwing", async () => {
    const store = new MemoryEpisodeStore();
    await store.save("{not json");
    const { episodes, rejected } = await loadEpisodes(store);
    expect(episodes).toEqual([]);
    expect(rejected.join(" ")).toContain("not valid JSON");
  });

  it("fails closed on an unsupported schema version", async () => {
    const store = new MemoryEpisodeStore();
    await store.save(JSON.stringify({ schemaVersion: 999, savedAt: 1, episodes: [] }));
    const { rejected } = await loadEpisodes(store);
    expect(rejected.join(" ")).toContain("schema version");
  });

  it("drops an invalid record inside an otherwise valid file", async () => {
    const store = new MemoryEpisodeStore();
    const good = episode("ep_good");
    await store.save(
      JSON.stringify({
        schemaVersion: EPISODE_SCHEMA_VERSION,
        savedAt: 1,
        episodes: [good, { episodeId: "ep_broken" }],
      }),
    );
    const { episodes, rejected } = await loadEpisodes(store);
    expect(episodes.map((e) => e.episodeId)).toEqual(["ep_good"]);
    expect(rejected.length).toBe(1);
  });

  it("supports delete and clear", async () => {
    const store = new MemoryEpisodeStore();
    await saveEpisode(store, episode("ep_a"));
    await saveEpisode(store, episode("ep_b"));
    expect(await deleteEpisode(store, "ep_a")).toBe(true);
    expect((await loadEpisodes(store)).episodes.map((e) => e.episodeId)).toEqual([
      "ep_b",
    ]);
    expect(await deleteEpisode(store, "nope")).toBe(false);
    await clearEpisodes(store);
    expect((await loadEpisodes(store)).episodes).toEqual([]);
  });
});
