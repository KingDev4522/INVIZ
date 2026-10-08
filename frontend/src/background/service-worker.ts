/**
 * MV3 service worker: background coordination layer (PRD 4 §5).
 * Phase 0 scope: install, command handling, envelope-validated message routing,
 * credentials-presence boot state. Agent behavior arrives in Phase 5 (PRD 6.5).
 *
 * The worker is NOT treated as persistent: all durable state lives in
 * chrome.storage.session / .local (PRD 6 §4.6).
 */

import { COMMANDS, STORAGE_KEY_CONFIG, STORAGE_KEY_CREDENTIALS } from "../../../shared/constants.js";
import { getErrorSpeech, isKnownMessageType } from "../../../shared/messages.js";
import { isExtensionMessage } from "../../../shared/types.js";
import { logger } from "../../../shared/logger.js";
import { storePageState, type StoredPageState } from "./page-state-store.js";
import { supportOf } from "../../../shared/page-support.js";
import {
  buildController,
  ensureOffscreenReady,
  readBackendRef,
  setTabAgentActive,
  speakText,
  stopAllAudio,
} from "./agent-controller/wiring.js";
import { AgentController } from "./agent-controller/controller.js";
import {
  clearTask,
  isTerminal,
  loadTask,
  saveTask,
} from "./task-state/store.js";
import type { Transcript } from "../ai/transcript.js";
import type { ExtensionMessage } from "../../../shared/types.js";
import {
  truncateStatusText,
  type VoicePhase,
} from "../../../shared/voice-status.js";
import type { AgentProgressEvent } from "./agent-controller/controller.js";

const SETUP_BADGE_TEXT = "SETUP";

/** The tab a voice turn is about. `undefined` when none is focused. */
async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

const VOICE_PHASES: ReadonlySet<string> = new Set([
  "listening",
  "transcribing",
  "transcript",
  "thinking",
  "awaiting",
  "speaking",
  "done",
  "error",
  "busy",
]);

/**
 * One-way turn narration to the tab's on-screen overlay. Fire-and-forget:
 * tabs without a content script (restricted pages, closed tabs) simply have
 * no overlay. Display text is truncated here; transcript content is never logged.
 */
async function sendVoiceStatus(
  tabId: number,
  phase: VoicePhase,
  opts: { turnId?: string; text?: string } = {},
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "VOICE_STATUS",
      requestId: opts.turnId ?? `vs_${Date.now()}`,
      payload: {
        phase,
        ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
        ...(opts.text !== undefined && opts.text !== ""
          ? { text: truncateStatusText(opts.text) }
          : {}),
      },
    });
  } catch {
    // No overlay on this tab — narration stays audio-only.
  }
}

/** Maps an agent progress event onto overlay phase + headline text. */
function describeProgress(event: AgentProgressEvent): { phase: VoicePhase; text: string } {
  switch (event.kind) {
    case "started":
      return { phase: "thinking", text: "Working…" };
    case "step":
      return {
        phase: "thinking",
        text:
          event.qwenCalls !== undefined && event.qwenCalls > 1
            ? `Reasoning… (step ${event.qwenCalls})`
            : "Reasoning…",
      };
    case "waiting-answer":
    case "waiting-confirm":
      return { phase: "awaiting", text: event.prompt ?? "Your turn — I'm listening." };
    case "cancelled":
      return { phase: "done", text: "Task cancelled." };
    case "done":
      if (event.status === "COMPLETE") return { phase: "done", text: "Done" };
      if (event.status === "CANCELLED") return { phase: "done", text: "Task cancelled." };
      return { phase: "error", text: event.prompt ?? "That didn't work." };
    case "searching":
      return { phase: "thinking", text: "Searching the web…" };
    default:
      return { phase: "thinking", text: "Working…" };
  }
}

/**
 * Builds a unique voice-turn id. crypto.randomUUID is available in MV3
 * workers (Chrome 116+); the fallback keeps tests/older contexts working.
 */
function newVoiceTurnId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `turn_${crypto.randomUUID()}`;
  }
  return `turn_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Voice-turn mutex, worker side (first line of defense). Chrome fires
 * onCommand once per keypress, but key-repeat, an impatient double-press, or
 * popup-button + shortcut together can invoke startVoiceTurn() while a turn
 * is still capturing. Without this flag each invocation opens its own
 * capture → transcription → agent chain and multiplies free-tier provider
 * spend. A duplicate press is ignored (logged with both turn ids) instead of
 * opening a second overlapping turn. In-memory by design: an MV3 worker
 * restart clears it, and a fresh worker has no live turn to protect.
 */
let voiceTurnInFlight: { turnId: string; startedAtMs: number } | null = null;

/**
 * Turn ids the user explicitly cancelled (overlay X / Ctrl+Shift+X / "stop").
 * A transcript that arrives AFTER its turn was cancelled (e.g. X pressed
 * during transcription) must never spawn a task — otherwise cancelling looks
 * broken: speech stops, then the agent starts acting on the stopped request.
 * One-shot: entries are consumed on match and expire after 5 minutes, so a
 * reused id can never suppress a future turn.
 */
const cancelledTurnIds = new Map<string, number>();
const CANCELLED_TURN_TTL_MS = 300_000;

function rememberCancelledTurn(turnId: string | undefined): void {
  if (turnId === undefined || turnId === "") return;
  cancelledTurnIds.set(turnId, Date.now());
  if (cancelledTurnIds.size > 50) {
    const cutoff = Date.now() - CANCELLED_TURN_TTL_MS;
    for (const [key, at] of cancelledTurnIds) {
      if (at < cutoff) cancelledTurnIds.delete(key);
    }
  }
}

/** True when this transcript belongs to a user-cancelled turn (consumes the entry). */
function isTranscriptCancelled(key: string | undefined, turnId: string | undefined): boolean {
  for (const candidate of [key, turnId]) {
    if (candidate === undefined || candidate === "") continue;
    const at = cancelledTurnIds.get(candidate);
    if (at !== undefined && Date.now() - at < CANCELLED_TURN_TTL_MS) {
      cancelledTurnIds.delete(candidate);
      return true;
    }
  }
  return false;
}

/**
 * Runs one voice turn: resolve the target tab, start capture in the offscreen
 * document, and log the outcome. Shared by the keyboard command and the popup
 * button so both paths attribute transcripts identically.
 */
let lastVoiceTabId: number | undefined;

/**
 * Recently routed transcript ids (turn ids) with arrival timestamps.
 * Bounds the "same transcript processed twice" failure to a time window
 * instead of unbounded memory: entries expire after TRANSCRIPT_DEDUPE_MS.
 */
const seenTranscriptIds = new Map<string, number>();
const TRANSCRIPT_DEDUPE_MS = 60_000;
const MAX_TRANSCRIPT_IDS = 200;

function pruneTranscriptIds(): void {
  if (seenTranscriptIds.size < MAX_TRANSCRIPT_IDS) return;
  const cutoff = Date.now() - TRANSCRIPT_DEDUPE_MS;
  for (const [key, at] of seenTranscriptIds) {
    if (at < cutoff) seenTranscriptIds.delete(key);
  }
  while (seenTranscriptIds.size >= MAX_TRANSCRIPT_IDS) {
    const oldest = seenTranscriptIds.keys().next();
    if (oldest.done === true) break;
    seenTranscriptIds.delete(oldest.value);
  }
}

export async function startVoiceTurn(): Promise<void> {
  if (voiceTurnInFlight !== null) {
    const duplicateId = newVoiceTurnId();
    logger.warn("command: duplicate voice turn ignored", {
      turnId: duplicateId,
      requestType: "voice-turn",
      timestampMs: Date.now(),
      outcome: "busy",
      activeTurnId: voiceTurnInFlight.turnId,
    });
    const busyTab = await activeTabId().catch(() => undefined);
    if (busyTab !== undefined) {
      void sendVoiceStatus(busyTab, "busy", {
        turnId: duplicateId,
        text: "Already listening…",
      });
    }
    return;
  }
  const turnId = newVoiceTurnId();
  voiceTurnInFlight = { turnId, startedAtMs: Date.now() };
  try {
    const tabId = await activeTabId().catch(() => undefined);
    if (tabId !== undefined) {
      lastVoiceTabId = tabId;
      // Restricted surfaces (chrome://, Web Store, PDFs, …) cannot show the
      // overlay or provide a snapshot — but they must NOT kill the whole turn:
      // capture, transcription and page-independent actions (deterministic
      // open-site navigation, web search) need no page access at all. The turn
      // proceeds; page-bound steps fail honestly downstream (CANNOT_ACCESS_PAGE
      // on a missing snapshot, UNSUPPORTED_PAGE on a restricted scheme, or the
      // model's cannot_complete). Content scripts are still never injected
      // into restricted pages — nothing here bypasses that Chrome restriction.
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (!supportOf(tab?.url).supported) {
        logger.info("command: voice turn on restricted surface; page steps will fail honestly", {
          turnId,
          requestType: "voice-turn",
          timestampMs: Date.now(),
          reason: supportOf(tab?.url).reason,
        });
      }
      void sendVoiceStatus(tabId, "listening", { turnId });
    }
    await ensureOffscreenReady();
    // The offscreen document cannot resolve the backend on its own, so the ref
    // travels with the request. Resolving it here is also what keeps a missing
    // URL from surfacing as a bogus transcription failure.
    const backend = await readBackendRef().catch(() => null);
    const res = (await chrome.runtime
      .sendMessage({
        type: "VOICE_CAPTURE_START",
        requestId: turnId,
        ...(tabId !== undefined ? { tabId } : {}),
        payload: {
          target: "offscreen",
          turnId,
          ...(tabId !== undefined ? { tabId } : {}),
          ...(backend !== null ? { backend } : {}),
        },
      })
      .catch(() => undefined)) as
      | { outcome?: { status?: unknown; code?: unknown }; busy?: unknown }
      | undefined;
    if (res?.busy === true) {
      logger.warn("command: voice turn refused (offscreen busy)", {
        turnId,
        requestType: "voice-turn",
        timestampMs: Date.now(),
        outcome: "busy",
      });
      if (tabId !== undefined) {
        void sendVoiceStatus(tabId, "busy", { turnId, text: "Already listening…" });
      }
      return;
    }
    const status = res?.outcome?.status;
    logger.info("command: voice turn finished", {
      turnId,
      requestType: "voice-turn",
      timestampMs: Date.now(),
      status: typeof status === "string" ? status : "no-response",
    });
    // Terminal capture outcomes settle the overlay with the same honest text
    // the user hears spoken. "transcribed" needs nothing: the transcript +
    // agent progress statuses already narrate what follows.
    if (tabId !== undefined && typeof status === "string" && status !== "transcribed") {
      const code = res?.outcome?.code;
      if (status === "busy") {
        void sendVoiceStatus(tabId, "busy", { turnId, text: "Already listening…" });
      } else if (status === "empty") {
        void sendVoiceStatus(tabId, "error", {
          turnId,
          text: getErrorSpeech("CAPTURE_EMPTY", "en"),
        });
      } else if (status === "refused-speaking") {
        void sendVoiceStatus(tabId, "error", {
          turnId,
          text: "I was speaking — press again.",
        });
      } else if (status === "failed") {
        const text =
          code === "RATE_LIMITED" ||
          code === "TRANSCRIPTION_FAILED" ||
          code === "VOICE_CAPTURE_FAILED"
            ? getErrorSpeech(code, "en")
            : "Voice capture failed.";
        void sendVoiceStatus(tabId, "error", { turnId, text });
      }
    }
  } finally {
    if (voiceTurnInFlight?.turnId === turnId) voiceTurnInFlight = null;
  }
}

async function credentialsPresent(): Promise<boolean> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_CREDENTIALS);
  const creds = stored[STORAGE_KEY_CREDENTIALS] as
    | { backendUrl?: string; backendToken?: string }
    | undefined;
  return Boolean(
    creds !== undefined &&
      typeof creds.backendUrl === "string" &&
      creds.backendUrl !== "",
  );
}

async function refreshBootBadge(): Promise<void> {
  const ok = await credentialsPresent();
  await chrome.action.setBadgeText({ text: ok ? "" : SETUP_BADGE_TEXT });
  if (!ok) {
    logger.warn("boot: credentials missing; deterministic-only mode", {
      errorCode: "AI_SERVICE_UNAVAILABLE",
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void refreshBootBadge();
  // Pre-warm the offscreen document so the first Ctrl+Shift+V of a session
  // doesn't pay document creation + listener-registration latency.
  void ensureOffscreenReady().catch(() => undefined);
  logger.info("service worker installed");
});

chrome.runtime.onStartup.addListener(() => {
  void refreshBootBadge();
  void ensureOffscreenReady().catch(() => undefined);
});

chrome.commands.onCommand.addListener((command: string) => {
  switch (command) {
    case COMMANDS.TOGGLE_VOICELENS:
      // Real toggle: flip the persisted VoiceLens flag (popup reads the same key).
      void (async () => {
        // READ-MODIFY-WRITE. The config object holds independent operator flags
        // (voicelensEnabled, powerMode, harnessEnabled, episodeRecording, …).
        // Writing a fresh `{ voicelensEnabled }` here replaced the WHOLE object
        // and silently reset every unrelated flag to undefined — i.e. toggling
        // VoiceLens from the keyboard quietly cleared Power Mode / Harness Exec.
        // Spread the existing object and change only the one key.
        const stored = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
        const raw = stored[STORAGE_KEY_CONFIG];
        const existing: Record<string, unknown> =
          typeof raw === "object" && raw !== null && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
        const current = existing["voicelensEnabled"] === true;
        await chrome.storage.local.set({
          [STORAGE_KEY_CONFIG]: { ...existing, voicelensEnabled: !current },
        });
        logger.info("command: toggle-voicelens", { enabled: String(!current) });
      })().catch(() => undefined);
      break;
    case COMMANDS.START_VOICE_CAPTURE:
      // Real voice turn: offscreen captures mic (tab-independent once granted),
      // transcribes via backend Whisper, routes transcript to the agent.
      // The active tab is resolved HERE and travels with the request: the
      // offscreen document has no `sender.tab`, so without it the transcript
      // comes back unattributable and the worker cannot route it.
      // The outcome is logged (status only, never speech content) so a lost
      // turn is visible here instead of vanishing silently.
      void (async () => {
        await startVoiceTurn();
      })().catch(() => undefined);
      break;
    case COMMANDS.STOP_CANCEL_TASK: {
      // Keyless: stop audio + cancel the active task if one exists.
      void (async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        // Same late-transcript protection as the overlay X path.
        rememberCancelledTurn(voiceTurnInFlight?.turnId);
        const store = { load: loadTask, save: saveTask, clear: clearTask };
        const task = await store.load().catch(() => null);
        if (task !== null && tab?.id !== undefined && !isTerminal(task.status)) {
          const controller = new AgentController({
            // No backend ref: cancel/pause paths never reason.
            store,
            speak: speakText,
            stopAudio: async () => stopAllAudio(),
            setAgentActive: setTabAgentActive,
          });
          await controller.cancelTask(task.taskId, tab.id, store);
        } else {
          await stopAllAudio();
        }
      })().catch(() => undefined);
      break;
    }
    case COMMANDS.REPEAT_LAST:
      void (async () => {
        await ensureOffscreenReady();
        await chrome.runtime
          .sendMessage({
            type: "TTS_REPEAT",
            requestId: `req_${Date.now()}`,
            payload: { target: "offscreen" },
          })
          .catch(() => undefined);
      })().catch(() => undefined);
      break;
    default:
      logger.warn("command: unknown command ignored", { command });
      break;
  }
});

async function broadcast(partial: Partial<ExtensionMessage>): Promise<void> {
  const message: ExtensionMessage = {
    type: partial.type ?? "CANCEL_TASK",
    requestId: `req_${Date.now()}`,
    payload: partial.payload ?? {},
  };
  await chrome.runtime.sendMessage(message).catch(() => {
    // No listeners (e.g. no offscreen yet) is normal in Phase 0.
    logger.debug("broadcast: no listeners", { type: message.type });
  });
}

function forwardToOffscreen(
  message: ExtensionMessage,
  sendResponse: (response: unknown) => void,
): boolean {
  void (async () => {
    await ensureOffscreenReady();
    // Content scripts cannot supply the backend ref, and the offscreen cannot
    // read storage, so the worker attaches it to everything it forwards.
    const backend = await readBackendRef().catch(() => null);
    return chrome.runtime.sendMessage({
      ...message,
      payload: {
        ...message.payload,
        target: "offscreen",
        ...(backend !== null ? { backend } : {}),
      },
    });
  })().then(
    (res) => sendResponse(res),
    () => sendResponse({ ok: false, errorCode: "AI_SERVICE_UNAVAILABLE" }),
  );
  return true;
}

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (!isExtensionMessage(message)) {
      logger.warn("message rejected: envelope invalid", {
        errorCode: "SCHEMA_VALIDATION_FAILED",
      });
      sendResponse({ ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" });
      return false;
    }
    if (!isKnownMessageType(message.type)) {
      logger.warn("message rejected: unknown type", {
        errorCode: "SCHEMA_VALIDATION_FAILED",
      });
      sendResponse({ ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" });
      return false;
    }
    // Offscreen-targeted traffic is not ours to handle (prevents forward loops).
    if (message.payload["target"] === "offscreen") return false;
    if (message.type === "CAPTURE_LEVEL") {
      // 5Hz mic-meter relay to the capturing tab (fire-and-forget, no response).
      const level = message.payload["level"];
      const tabId = message.payload["tabId"] ?? sender.tab?.id ?? lastVoiceTabId;
      if (
        typeof level === "number" &&
        Number.isFinite(level) &&
        Number.isInteger(tabId) &&
        (tabId as number) >= 0
      ) {
        chrome.tabs
          .sendMessage(tabId as number, {
            type: "CAPTURE_LEVEL",
            requestId: message.requestId,
            tabId: tabId as number,
            payload: { level },
          })
          .catch(() => undefined);
      }
      return false;
    }
    if (message.type === "VOICE_STATUS") {
      // Offscreen narration relay: the offscreen document has no tab, so the
      // worker routes its phase updates to the turn's tab overlay.
      const payload = message.payload;
      const rawTab = message.tabId ?? payload["tabId"];
      const tabId =
        typeof rawTab === "number" && Number.isInteger(rawTab) && rawTab >= 0
          ? rawTab
          : lastVoiceTabId;
      const phase = payload["phase"];
      if (tabId === undefined || typeof phase !== "string" || !VOICE_PHASES.has(phase)) {
        return false;
      }
      const text = payload["text"];
      const turnId = payload["turnId"];
      void sendVoiceStatus(tabId, phase as VoicePhase, {
        ...(typeof turnId === "string" && turnId !== "" ? { turnId } : {}),
        ...(typeof text === "string" && text !== "" ? { text } : {}),
      });
      return false;
    }
    if (message.type === "START_VOICE_TURN") {
      // Popup entry point for a voice turn. The worker owns the flow so the
      // button and the keyboard shortcut attribute transcripts identically.
      void startVoiceTurn().then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false, errorCode: "VOICE_CAPTURE_FAILED" }),
      );
      return true;
    }
    if (message.type === "TTS_SPEAK" ||
      message.type === "TTS_STOP" ||
      message.type === "TTS_REPEAT" ||
      message.type === "TTS_PRIMARY_RESET"
    ) {
      return forwardToOffscreen(message, sendResponse);
    }
    if (message.type === "VOICE_TRANSCRIPT") {
      // Phase 5 agent routing: the transcript goes to the controller, which
      // owns answers, confirmations, commands, and new tasks.
      // Idempotency: the offscreen document uses the turn id as the message
      // requestId, so a re-delivered transcript of an already-routed turn is
      // acknowledged WITHOUT a second agent run (which would double Qwen/TTS
      // provider spend on the same utterance).
      const transcriptKey = message.requestId;
      const seenAt = seenTranscriptIds.get(transcriptKey);
      if (seenAt !== undefined && Date.now() - seenAt < TRANSCRIPT_DEDUPE_MS) {
        logger.warn("voice: duplicate transcript delivery dropped", {
          turnId: transcriptKey,
          requestType: "voice-transcript",
          timestampMs: Date.now(),
          outcome: "duplicate-dropped",
        });
        sendResponse({ ok: true, routed: false, duplicate: true });
        return false;
      }
      pruneTranscriptIds();
      seenTranscriptIds.set(transcriptKey, Date.now());
      const raw = message.payload["transcript"] as Partial<Transcript> | undefined;
      const text = typeof raw?.text === "string" ? raw.text : "";
      if (raw === undefined || text.trim() === "") {
        sendResponse({ ok: false, errorCode: "TRANSCRIPTION_FAILED" });
        return false;
      }
      // Cancelled-turn guard: X pressed during transcription. Drop the
      // transcript entirely — no overlay echo, no task, no speech.
      const rawTurnIdEarly = (raw as { turnId?: unknown }).turnId;
      if (
        isTranscriptCancelled(
          typeof transcriptKey === "string" ? transcriptKey : undefined,
          typeof rawTurnIdEarly === "string" ? rawTurnIdEarly : undefined,
        )
      ) {
        logger.info("voice: transcript of cancelled turn dropped", {
          turnId: typeof transcriptKey === "string" ? transcriptKey : "unknown",
          requestType: "voice-transcript",
          timestampMs: Date.now(),
          outcome: "cancelled-dropped",
        });
        sendResponse({ ok: true, routed: false, cancelled: true });
        return false;
      }
      // The offscreen document has no tab, so the starter supplies one. Fall
      // back to the focused tab rather than discarding a good transcript: a
      // dropped transcript is indistinguishable from a broken mic.
      void (async () => {
        // CURRENT-PAGE rule: the already-open active tab IS the context. The
        // capture-start tab (message.tabId) can be stale — the user may have
        // switched to YouTube during capture/transcription. Prefer the LIVE
        // active tab at transcript time; fall back to the capture tab only
        // when no active tab is resolvable. Never navigate, never require
        // "open YouTube" — the current page must suffice.
        const captureTabId =
          sender.tab?.id ?? (typeof message.tabId === "number" ? message.tabId : undefined);
        const liveTabId = await activeTabId().catch(() => undefined);
        let tabId = liveTabId ?? captureTabId;
        if (
          captureTabId !== undefined &&
          liveTabId !== undefined &&
          captureTabId !== liveTabId
        ) {
          logger.info("voice: transcript re-attributed to live active tab", {
            ...(typeof transcriptKey === "string" ? { turnId: transcriptKey } : {}),
            requestType: "voice-transcript",
            timestampMs: Date.now(),
            captureTabId,
            liveTabId,
          });
          tabId = liveTabId;
        }
        if (tabId === undefined) {
          // Nothing to act on. Say so instead of failing silently.
          await speakText(getErrorSpeech("UNSUPPORTED_PAGE", "en"), "en", 3).catch(
            () => undefined,
          );
          sendResponse({ ok: false, errorCode: "CANNOT_ACCESS_PAGE" });
          return;
        }
        const rawTurnId = (raw as { turnId?: unknown }).turnId;
        const transcript: Transcript = {
          text,
          lang: raw.lang === "hi" || raw.lang === "mixed" ? raw.lang : "en",
          source: "voice",
          timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
          ...(typeof rawTurnId === "string" && rawTurnId !== "" ? { turnId: rawTurnId } : {}),
        };
        logger.info("voice: transcript routed", {
          ...(transcript.turnId !== undefined ? { turnId: transcript.turnId } : {}),
          requestType: "voice-transcript",
          timestampMs: Date.now(),
          outcome: "routed",
          transcriptChars: text.length,
        });
        // The overlay shows what Whisper heard, then follows agent progress.
        void sendVoiceStatus(tabId, "transcript", {
          ...(transcript.turnId !== undefined ? { turnId: transcript.turnId } : {}),
          text,
        });
        buildController(undefined, {
          onProgress: (event) => {
            const described = describeProgress(event);
            void sendVoiceStatus(tabId, described.phase, {
              ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
              text: described.text,
            });
          },
        })
          .then((controller) => controller.routeVoice(transcript, tabId))
          .then(
            () => sendResponse({ ok: true, routed: true }),
            async () => {
              // C1 missing or routing failed: say so honestly instead of silence.
              const unavailable =
                "AI services are not configured. Open extension options to add your keys.";
              void sendVoiceStatus(tabId, "error", {
                ...(transcript.turnId !== undefined ? { turnId: transcript.turnId } : {}),
                text: unavailable,
              });
              await speakText(unavailable, "en", 3).catch(() => undefined);
              sendResponse({ ok: false, errorCode: "AI_SERVICE_UNAVAILABLE" });
            },
          );
      })();
      return true;
    }
    if (message.type === "PAGE_STATE_UPDATED") {
      const tabId = sender.tab?.id;
      const state = message.payload["state"] as StoredPageState | undefined;
      if (tabId === undefined || state === undefined || !Array.isArray(state.items)) {
        logger.warn("page snapshot rejected: malformed", {
          errorCode: "SCHEMA_VALIDATION_FAILED",
        });
        sendResponse({ ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" });
        return false;
      }
      void storePageState({ ...state, tabId })
        .then((result) => {
          sendResponse({ ok: true, truncated: result.truncated });
        })
        .catch((err: unknown) => {
          logger.error("page snapshot store failed", {
            errorCode: "ACTION_FAILED",
          });
          void err;
          sendResponse({ ok: false, errorCode: "ACTION_FAILED" });
        });
      void markTabSupported(tabId);
      return true;
    }
    if (message.type === "CANCEL_TASK") {
      // Keyless path: cancellation and audio halt must work without C1.
      // silent:true (overlay X button) stops everything WITHOUT speaking —
      // an explicit UI stop must never narrate "Task cancelled."
      const silent = message.payload["silent"] === true;
      const tabId = sender.tab?.id ?? message.tabId;
      // Remember the in-flight turn id (if any) BEFORE cancelling, so a
      // transcript that is already being transcribed still gets dropped on
      // arrival instead of spawning a task after the user pressed X.
      rememberCancelledTurn(voiceTurnInFlight?.turnId);
      const store = { load: loadTask, save: saveTask, clear: clearTask };
      const controller = new AgentController({
        // No backend ref: cancel/pause paths never reason.
        store,
        speak: speakText,
        stopAudio: async (all: boolean) => {
          if (all) {
            await stopAllAudio();
            return;
          }
          await ensureOffscreenReady();
          await chrome.runtime
            .sendMessage({
              type: "TTS_STOP",
              requestId: `req_${Date.now()}`,
              payload: { all, target: "offscreen" },
            })
            .catch(() => undefined);
        },
        setAgentActive: setTabAgentActive,
      });
      store
        .load()
        .then(async (task) => {
          if (task !== null && tabId !== undefined && !isTerminal(task.status)) {
            await controller.cancelTask(task.taskId, tabId, store, silent);
          } else {
            await stopAllAudio();
          }
          // A capture may be in flight with no task yet (user pressed X while
          // speaking the request): halt the mic too. TTS_STOP already cleared
          // queued speech inside cancelTask/stopAllAudio.
          await chrome.runtime
            .sendMessage({
              type: "VOICE_CAPTURE_STOP",
              requestId: `req_${Date.now()}`,
              payload: { target: "offscreen" },
            })
            .catch(() => undefined);
        })
        .then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false, errorCode: "ACTION_FAILED" }),
        );
      return true;
    }
    if (message.type === "USER_OVERRIDE") {
      // Trusted user input during agent execution: pause, never fight.
      const tabId = sender.tab?.id ?? message.tabId;
      if (tabId === undefined) {
        sendResponse({ ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" });
        return false;
      }
      const controller = new AgentController({
        // No backend ref: cancel/pause paths never reason.
        store: { load: loadTask, save: saveTask, clear: clearTask },
        speak: speakText,
        stopAudio: async () => undefined,
        setAgentActive: setTabAgentActive,
      });
      controller.pauseForOverride(tabId).then(
        () => sendResponse({ ok: true, paused: true }),
        () => sendResponse({ ok: false, errorCode: "ACTION_FAILED" }),
      );
      return true;
    }
    // All agent/audio behaviors are Phase 2+ work.
    logger.debug("message routed to future phase handler", {
      type: message.type,
    });
    sendResponse({ ok: false, errorCode: "NOT_IMPLEMENTED_PHASE" });
    return false;
  },
);

// --- Page support tracking (PRD 6.1 §1.5) -----------------------------------
// Content scripts cannot run on restricted surfaces (chrome://, Web Store,
// extension pages, PDF viewer, file://). The worker detects those tabs by URL
// and marks them honestly; badge + popup surface it until speech lands in
// Phase 2. Fail closed, never silent.

// Restricted-surface detection uses the shared policy (single owner:
// src/shared/page-support.ts). Tabs on non-injectable surfaces are marked
// honestly (badge + popup + spoken notice); never silent, never worked around.

async function markTabSupported(tabId: number): Promise<void> {
  const stored = await chrome.storage.session.get("support:tabs");
  const flags = (stored["support:tabs"] as Record<string, string> | undefined) ?? {};
  flags[String(tabId)] = "supported";
  await chrome.storage.session.set({ "support:tabs": flags });
  // Badge is best-effort UI: tab-less senders carry TAB_ID_NONE (-1) and a
  // closed tab rejects. Neither may surface as an uncaught rejection.
  if (Number.isInteger(tabId) && tabId >= 0) {
    await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  }
}

async function markTabUnsupported(tabId: number, reason: string): Promise<void> {
  const stored = await chrome.storage.session.get("support:tabs");
  const flags = (stored["support:tabs"] as Record<string, string> | undefined) ?? {};
  flags[String(tabId)] = `unsupported:${reason}`;
  await chrome.storage.session.set({ "support:tabs": flags });
  if (Number.isInteger(tabId) && tabId >= 0) {
    await chrome.action.setBadgeText({ tabId, text: "!" }).catch(() => undefined);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url ?? tab.url;
  // Only (re)evaluate when the URL is known.
  if (changeInfo.url === undefined && changeInfo.status !== "complete") return;
  if (url === undefined) return;
  const { supported, reason } = supportOf(url);
  if (supported) {
    // A supported URL clears a previous unsupported flag only via heartbeat
    // (markTabSupported on PAGE_STATE_UPDATED); do not clear here, because
    // the content script may not have injected yet.
    return;
  }
  void markTabUnsupported(tabId, reason);
  logger.info("tab marked unsupported", { tabId: String(tabId), reason });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const stored = await chrome.storage.session.get("support:tabs");
    const flags = (stored["support:tabs"] as Record<string, string> | undefined) ?? {};
    delete flags[String(tabId)];
    await chrome.storage.session.set({ "support:tabs": flags });
    await chrome.storage.session.remove(`page:tab:${tabId}`);
  })();
});

// Offscreen lifecycle lives in agent-controller/wiring.js (single owner).
// This worker uses the shared ensureOffscreenReady via the forward helper below.

void refreshBootBadge();
