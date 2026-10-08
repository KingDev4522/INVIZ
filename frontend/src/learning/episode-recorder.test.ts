/**
 * EpisodeRecorder tests (Phase 5).
 * Proves recording is opt-in (OFF by default), task-scoped, and captures the
 * metadata, action history and verification results of a completed task.
 * No chrome.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { EpisodeRecorder } from "../background/learning/episode-recorder.js";
import type { TaskSnapshot } from "../background/task-state/store.js";
import { MemoryEpisodeStore, loadEpisodes } from "./episode-store.js";

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: "task_1",
    goal: "Find the contributors of this repository",
    goalLang: "en",
    tabId: 7,
    status: "ACTIVE",
    currentStep: 1,
    completedActions: 2,
    recoveryAttempts: 1,
    qwenCalls: 3,
    startedAt: 1_000_000,
    updatedAt: 1_001_000,
    pendingQuestion: null,
    pendingConfirmation: null,
    lastVerifiedResult: "action click verified",
    providedValues: {},
    ...overrides,
  };
}

describe("recording is opt-in", () => {
  it("1: is disabled by default and persists nothing", async () => {
    const store = new MemoryEpisodeStore();
    const recorder = new EpisodeRecorder({ store }); // no `enabled`
    expect(recorder.isEnabled).toBe(false);
    recorder.begin(task());
    recorder.recordAction("task_1", {
      action: { action: "click", target: "e2", pageGeneration: 5 },
      pageGeneration: 5,
      status: "executed",
    });
    expect(recorder.pending).toBe(0);
    await recorder.finalize(task({ status: "COMPLETE" }));
    expect(await store.load()).toBeNull();
  });

  it("2: records only when explicitly enabled", async () => {
    const store = new MemoryEpisodeStore();
    const recorder = new EpisodeRecorder({ enabled: true, store });
    expect(recorder.isEnabled).toBe(true);
    recorder.begin(task());
    expect(recorder.pending).toBe(1);
    const written = await recorder.finalize(task({ status: "COMPLETE" }));
    expect(written).not.toBeNull();
    const { episodes } = await loadEpisodes(store);
    expect(episodes.length).toBe(1);
    expect(recorder.pending).toBe(0);
  });

  it("keeps buffers task-scoped and drops discarded tasks", async () => {
    const store = new MemoryEpisodeStore();
    const recorder = new EpisodeRecorder({ enabled: true, store });
    recorder.begin(task({ taskId: "task_a" }));
    recorder.begin(task({ taskId: "task_b" }));
    expect(recorder.pending).toBe(2);
    recorder.discard("task_a");
    expect(recorder.pending).toBe(1);
    await recorder.finalize(task({ taskId: "task_b", status: "COMPLETE" }));
    const { episodes } = await loadEpisodes(store);
    expect(episodes.map((e) => e.taskId)).toEqual(["task_b"]);
  });
});

describe("episode content", () => {
  it("3+4: creates an episode carrying task metadata for a successful task", async () => {
    const store = new MemoryEpisodeStore();
    const recorder = new EpisodeRecorder({ enabled: true, store });
    recorder.begin(task());
    const written = await recorder.finalize(
      task({ status: "COMPLETE", completedActions: 2, recoveryAttempts: 1 }),
      [{ skillId: "generic_read_region", version: "1.0.0", status: "approved" }],
    );
    expect(written).not.toBeNull();
    expect(written?.success).toBe(true);
    expect(written?.finalStatus).toBe("COMPLETE");
    expect(written?.goal).toBe("Find the contributors of this repository");
    expect(written?.goalLang).toBe("en");
    expect(written?.completedActions).toBe(2);
    expect(written?.recoveryEvents).toBe(1);
    expect(written?.registrySnapshot).toEqual([
      { skillId: "generic_read_region", version: "1.0.0", status: "approved" },
    ]);
  });

  it("5: records the action history in order", async () => {
    const store = new MemoryEpisodeStore();
    const recorder = new EpisodeRecorder({ enabled: true, store });
    recorder.begin(task());
    recorder.recordAction("task_1", {
      action: { action: "click", target: "e2", pageGeneration: 5 },
      pageGeneration: 5,
      status: "executed",
      pageUrl: "https://github.com/example/project",
      pageTitle: "example/project",
    });
    recorder.recordAction("task_1", {
      action: { action: "read", target: "r1", pageGeneration: 6 },
      pageGeneration: 6,
      status: "read",
      pageUrl: "https://github.com/example/project/graphs/contributors",
    });
    recorder.recordOutcome("task_1", { type: "task_complete", text: "Done." });
    const written = await recorder.finalize(task({ status: "COMPLETE" }));
    expect(written?.actions.map((a) => `${a.index}:${a.action.action}`)).toEqual([
      "0:click",
      "1:read",
    ]);
    expect(written?.pageGenerations).toEqual([5, 6]);
    expect(written?.pageUrl).toContain("graphs/contributors");
    expect(written?.finalOutcomeType).toBe("task_complete");
    expect(written?.finalOutcomeText).toBe("Done.");
  });

  it("6: records verification information per action", async () => {
    const store = new MemoryEpisodeStore();
    const recorder = new EpisodeRecorder({ enabled: true, store });
    recorder.begin(task());
    recorder.recordAction("task_1", {
      action: { action: "click", target: "e2", pageGeneration: 5 },
      pageGeneration: 5,
      status: "executed",
      verification: {
        success: true,
        outcome: "VERIFIED_SUCCESS",
        timedOut: false,
        pageGeneration: 5,
      },
    });
    const written = await recorder.finalize(task({ status: "COMPLETE" }));
    expect(written?.actions[0]?.verification).toEqual({
      success: true,
      outcome: "VERIFIED_SUCCESS",
      timedOut: false,
      pageGeneration: 5,
    });
  });

  it("records a failed task as unsuccessful evidence", async () => {
    const store = new MemoryEpisodeStore();
    const recorder = new EpisodeRecorder({ enabled: true, store });
    recorder.begin(task());
    const written = await recorder.finalize(task({ status: "FAILED" }));
    expect(written?.success).toBe(false);
    expect(written?.finalStatus).toBe("FAILED");
  });

  it("records the selected skill when the model chose one", async () => {
    const store = new MemoryEpisodeStore();
    const recorder = new EpisodeRecorder({ enabled: true, store });
    recorder.begin(task());
    recorder.recordSkill("task_1", {
      skillId: "generic_read_region",
      skillVersion: "1.0.0",
      skillStatus: "approved",
      input: { regionId: "r1" },
      plannedVersion: "1.0.0",
    });
    const written = await recorder.finalize(task({ status: "COMPLETE" }));
    expect(written?.selectedSkill?.skillId).toBe("generic_read_region");
    expect(written?.selectedSkill?.input).toEqual({ regionId: "r1" });
  });
});
