/**
 * TaskState store tests with a mocked chrome.storage.session (PRD 6.5).
 * Persistence round-trip + fail-closed restart rule. Run: npm test
 */
import { describe, expect, it, vi } from "vitest";
import {
  clearTask,
  failClosedOnRestart,
  loadTask,
  saveTask,
  type TaskSnapshot,
} from "./store.js";

function installStorageMock(): Map<string, unknown> {
  const mem = new Map<string, unknown>();
  const session = {
    get: vi.fn(async (k: string | string[]) => {
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(k) ? k : [k]) {
        if (mem.has(key)) out[key] = mem.get(key);
      }
      return out;
    }),
    set: vi.fn(async (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) mem.set(k, v);
    }),
    remove: vi.fn(async (k: string | string[]) => {
      for (const key of Array.isArray(k) ? k : [k]) mem.delete(key);
    }),
  };
  (globalThis as Record<string, unknown>)["chrome"] = { storage: { session } };
  return mem;
}

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: "task_1",
    goal: "Test goal",
    goalLang: "en",
    tabId: 7,
    status: "ACTIVE",
    currentStep: 0,
    completedActions: 0,
    recoveryAttempts: 0,
    qwenCalls: 0,
    startedAt: 1000,
    updatedAt: 1000,
    pendingQuestion: null,
    pendingConfirmation: null,
    lastVerifiedResult: null,
    providedValues: {},
    ...overrides,
  };
}

describe("task store", () => {
  it("round-trips snapshots and clears", async () => {
    installStorageMock();
    expect(await loadTask()).toBeNull();
    await saveTask(snapshot());
    expect((await loadTask())?.goal).toBe("Test goal");
    await clearTask();
    expect(await loadTask()).toBeNull();
  });

  it("fail-closes non-terminal tasks on restart, never resumes", async () => {
    installStorageMock();
    await saveTask(snapshot({ status: "WAITING_FOR_CONFIRMATION" }));
    const cancelled = await failClosedOnRestart();
    expect(cancelled?.status).toBe("CANCELLED");
    expect(cancelled?.pendingConfirmation).toBeNull();
    expect((await loadTask())?.status).toBe("CANCELLED");
  });

  it("leaves terminal tasks and empty storage alone", async () => {
    installStorageMock();
    expect(await failClosedOnRestart()).toBeNull();
    await saveTask(snapshot({ status: "COMPLETE" }));
    expect(await failClosedOnRestart()).toBeNull();
    expect((await loadTask())?.status).toBe("COMPLETE");
  });
});
