/**
 * TaskState store — REAL (PRD 6.5; PRD 3 §14–15).
 * Task-scoped: survives navigation, dies on completion/cancel. Persisted in
 * chrome.storage.session (survives SW suspension, dies on browser close).
 * Restart rule (fail closed): any non-terminal task found at startup is
 * marked CANCELLED, never resumed — pending confirmations especially.
 */
import { STORAGE_KEY_TASK } from "../../../../shared/constants.js";
import { logger } from "../../../../shared/logger.js";
import type { StructuredAction } from "../../../../shared/types.js";

export type TaskStatus =
  | "ACTIVE"
  | "WAITING_FOR_USER_ANSWER"
  | "WAITING_FOR_CONFIRMATION"
  | "PAUSED_USER_OVERRIDE"
  | "COMPLETE"
  | "CANCELLED"
  | "BLOCKED"
  | "FAILED"
  | "LIMIT_REACHED";

export interface PendingQuestion {
  field: string;
  question: string;
  sensitivity: "ordinary" | "high";
  askedAt: number;
}

export interface PendingConfirmation {
  summary: string;
  actionIndex: number;
  askedAt: number;
  /** The approved-once action. Re-validated against fresh state on YES. */
  action: StructuredAction | null;
}

export interface TaskSnapshot {
  taskId: string;
  goal: string;
  goalLang: "en" | "hi" | "mixed";
  tabId: number;
  status: TaskStatus;
  currentStep: number;
  completedActions: number;
  recoveryAttempts: number;
  qwenCalls: number;
  startedAt: number;
  updatedAt: number;
  pendingQuestion: PendingQuestion | null;
  pendingConfirmation: PendingConfirmation | null;
  lastVerifiedResult: string | null;
  /** Ordinary user-provided values (never secrets — memory-only rule). */
  providedValues: Record<string, string>;
  /** Values are NEVER stored here (memory-only rule, PRD 6 §6). */
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "COMPLETE",
  "CANCELLED",
  "BLOCKED",
  "FAILED",
  "LIMIT_REACHED",
]);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

export async function saveTask(snapshot: TaskSnapshot): Promise<void> {
  const persist = {
    ...snapshot,
    updatedAt: Date.now(),
  };
  await chrome.storage.session.set({ [STORAGE_KEY_TASK]: persist });
}

export async function loadTask(): Promise<TaskSnapshot | null> {
  const stored = await chrome.storage.session.get(STORAGE_KEY_TASK);
  const snapshot = stored[STORAGE_KEY_TASK] as TaskSnapshot | undefined;
  return snapshot ?? null;
}

export async function clearTask(): Promise<void> {
  await chrome.storage.session.remove(STORAGE_KEY_TASK);
}

/**
 * Fail-closed restart: a task that was mid-flight when the worker died is
 * cancelled, with its partial progress preserved for reporting — never resumed,
 * never auto-executed (a stale YES must never become a future execution).
 */
export async function failClosedOnRestart(): Promise<TaskSnapshot | null> {
  const snapshot = await loadTask();
  if (snapshot === null || isTerminal(snapshot.status)) return null;
  const cancelled: TaskSnapshot = {
    ...snapshot,
    status: "CANCELLED",
    updatedAt: Date.now(),
    pendingQuestion: null,
    pendingConfirmation: null,
  };
  await saveTask(cancelled);
  logger.warn("task fail-closed on restart", {
    taskId: snapshot.taskId,
    was: snapshot.status,
  });
  return cancelled;
}

let taskCounter = 0;

export function newTaskId(): string {
  taskCounter += 1;
  return `task_${Date.now()}_${taskCounter}`;
}
