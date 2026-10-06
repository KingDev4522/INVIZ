/**
 * Logger + telemetry skeleton (PRD 6.0 §1.5; PRD 5 §41–42).
 * - Every payload passes through redactObject at the single emission point.
 * - Telemetry is DISABLED by default (opt-in only) and accepts metadata events only.
 */

import { redactObject } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogMeta {
  taskId?: string;
  pageGeneration?: number;
  actionType?: string;
  targetId?: string;
  verificationStatus?: string;
  errorCode?: string;
  [k: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function emit(level: LogLevel, message: string, meta?: LogMeta): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const safeMeta = meta === undefined ? undefined : redactObject(meta);
  const line = { level, message, ...(safeMeta ? { meta: safeMeta } : {}) };
  if (level === "error") {
    console.error(JSON.stringify(line));
  } else if (level === "warn") {
    console.warn(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

export const logger = {
  debug: (message: string, meta?: LogMeta): void => emit("debug", message, meta),
  info: (message: string, meta?: LogMeta): void => emit("info", message, meta),
  warn: (message: string, meta?: LogMeta): void => emit("warn", message, meta),
  error: (message: string, meta?: LogMeta): void => emit("error", message, meta),
};

// --- Telemetry (opt-in only; metadata events per PRD 5 §42) ---

const ALLOWED_TELEMETRY_EVENTS = [
  "extension_started",
  "voicelens_enabled",
  "page_state_created",
  "ai_request_failed",
  "action_blocked",
  "confirmation_requested",
  "action_executed",
  "verification_failed",
  "task_cancelled",
] as const;

export type TelemetryEvent = (typeof ALLOWED_TELEMETRY_EVENTS)[number];

let telemetryEnabled = false;

export function setTelemetryEnabled(enabled: boolean): void {
  telemetryEnabled = enabled;
}

export function isTelemetryEnabled(): boolean {
  return telemetryEnabled;
}

/** No-op unless explicitly enabled. Payload is redacted metadata only. */
export function trackEvent(event: TelemetryEvent, meta?: LogMeta): void {
  if (!telemetryEnabled) return;
  logger.info("telemetry", { event, ...(meta ?? {}) });
}
