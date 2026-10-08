/**
 * EpisodeRecorder — REAL (Phase 5, opt-in learning layer).
 *
 * Captures one bounded, deterministic record of a completed task: the goal, the
 * page generations observed, the actions that ran, their verification results,
 * and how the task ended. This is LEARNING EVIDENCE only — it is never
 * executable and is never handed to the browser.
 *
 * Opt-in is enforced structurally: recording is OFF unless explicitly enabled.
 * With recording off the recorder holds no buffer and persists nothing, so no
 * episode can be created by accident.
 *
 * Recording is task-scoped (one buffer per taskId, cleared on finalize/discard)
 * and deliberately excludes microphone audio, full-page HTML, unrelated
 * browsing activity, and raw credentials.
 */
import { EPISODE_SCHEMA_VERSION, redactEpisode, type Episode, type EpisodeActionRecord, type EpisodeActionStatus, type EpisodeExecutionMode, type EpisodeFinalStatus, type EpisodeRegistryVersion, type EpisodeSkillRecord, type EpisodeVerificationRecord } from "../../../../shared/episode.js";
import { logger } from "../../../../shared/logger.js";
import type { AgentOutcome, StructuredAction } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";
import { saveEpisode, type EpisodeStore } from "../../learning/episode-store.js";

export interface EpisodeRecorderOptions {
  /** OFF by default. Nothing is buffered or persisted unless true. */
  enabled?: boolean;
  /** Persistence target. Required for an episode to survive the task. */
  store?: EpisodeStore;
  now?: () => number;
  /** Registry versions in force — captured as provenance at finalize time. */
  registryVersions?: () => EpisodeRegistryVersion[];
}

const FINAL_STATUSES: readonly TaskSnapshot["status"][] = [
  "COMPLETE",
  "CANCELLED",
  "BLOCKED",
  "FAILED",
  "LIMIT_REACHED",
];

function finalStatusOf(status: TaskSnapshot["status"]): EpisodeFinalStatus {
  return FINAL_STATUSES.includes(status) ? (status as EpisodeFinalStatus) : "FAILED";
}

export interface RecordActionInput {
  action: StructuredAction;
  pageGeneration: number;
  status: EpisodeActionStatus;
  /** Executor that ran (ran) it — "local" unless policy routed externally. */
  executionMode?: EpisodeExecutionMode;
  pageUrl?: string;
  pageTitle?: string;
  verification?: EpisodeVerificationRecord;
}

export class EpisodeRecorder {
  private readonly enabled: boolean;
  private readonly store?: EpisodeStore;
  private readonly now: () => number;
  private readonly registryVersions: () => EpisodeRegistryVersion[];
  private buffers = new Map<string, Episode>();

  constructor(opts: EpisodeRecorderOptions = {}) {
    this.enabled = opts.enabled === true;
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
    this.registryVersions = opts.registryVersions ?? (() => []);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Number of tasks currently buffered (always 0 when disabled). */
  get pending(): number {
    return this.buffers.size;
  }

  /** Opens a buffer for a newly started task. No-op when recording is off. */
  begin(task: TaskSnapshot): void {
    if (!this.enabled) return;
    this.buffers.set(task.taskId, {
      schemaVersion: EPISODE_SCHEMA_VERSION,
      episodeId: `ep_${task.taskId}`,
      taskId: task.taskId,
      createdAt: task.startedAt,
      recordedAt: this.now(),
      goal: task.goal,
      goalLang: task.goalLang,
      pageUrl: "",
      pageTitle: "",
      pageGenerations: [],
      selectedSkill: null,
      actions: [],
      recoveryEvents: 0,
      finalOutcomeType: null,
      finalOutcomeText: null,
      finalStatus: "FAILED",
      success: false,
      completedActions: 0,
      registrySnapshot: [],
    });
  }

  /** Captures the model's final typed outcome. Never stores raw model text. */
  recordOutcome(taskId: string, outcome: AgentOutcome): void {
    const episode = this.buffers.get(taskId);
    if (episode === undefined) return;
    episode.finalOutcomeType = outcome.type;
    episode.finalOutcomeText =
      outcome.type === "task_complete" || outcome.type === "answer"
        ? (outcome.text ?? null)
        : null;
  }

  /** Captures which registered skill the model selected. */
  recordSkill(taskId: string, skill: EpisodeSkillRecord): void {
    const episode = this.buffers.get(taskId);
    if (episode === undefined) return;
    episode.selectedSkill = skill;
  }

  /** Captures one action attempt and its verification (if any). */
  recordAction(taskId: string, input: RecordActionInput): void {
    const episode = this.buffers.get(taskId);
    if (episode === undefined) return;
    if (episode.actions.length >= 30) return; // hard per-episode bound
    if (input.pageUrl !== undefined && input.pageUrl !== "") episode.pageUrl = input.pageUrl;
    if (input.pageTitle !== undefined && input.pageTitle !== "") episode.pageTitle = input.pageTitle;
    if (!episode.pageGenerations.includes(input.pageGeneration)) {
      episode.pageGenerations.push(input.pageGeneration);
    }
    const record: EpisodeActionRecord = {
      index: episode.actions.length,
      action: { ...input.action },
      pageGeneration: input.pageGeneration,
      status: input.status,
      executionMode: input.executionMode ?? "local",
      ...(input.verification !== undefined ? { verification: input.verification } : {}),
    };
    episode.actions.push(record);
  }

  /** Drops a buffer without persisting (cancelled / superseded tasks). */
  discard(taskId: string): void {
    this.buffers.delete(taskId);
  }

  /**
   * Finalizes a terminal task: builds the episode, redacts it, persists it.
   * Returns the episode that was written, or null when nothing was recorded
   * (recording off, no buffer, or persistence failed).
   */
  async finalize(
    task: TaskSnapshot,
    registryVersions?: EpisodeRegistryVersion[],
  ): Promise<Episode | null> {
    const episode = this.buffers.get(task.taskId);
    this.buffers.delete(task.taskId);
    if (episode === undefined) return null;

    episode.recordedAt = this.now();
    episode.finalStatus = finalStatusOf(task.status);
    episode.success = task.status === "COMPLETE";
    episode.completedActions = task.completedActions;
    episode.recoveryEvents = task.recoveryAttempts;
    episode.registrySnapshot = registryVersions ?? this.registryVersions();

    const redacted = redactEpisode(episode);
    if (this.store === undefined) return null;
    const result = await saveEpisode(this.store, redacted, this.now());
    if (!result.ok) {
      logger.warn("learning: episode not persisted", {
        episodeId: redacted.episodeId,
        reason: result.error ?? "unknown",
      });
      return null;
    }
    logger.info("learning: episode recorded", {
      episodeId: redacted.episodeId,
      actions: redacted.actions.length,
      success: redacted.success,
    });
    return redacted;
  }
}
