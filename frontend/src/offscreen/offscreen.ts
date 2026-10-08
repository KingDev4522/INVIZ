/**
 * Offscreen audio runtime entry (PRD 4 §6; PRD 6.2).
 * Hosts the AudioController with the browser's own (feminine) voice over
 * HTMLAudio playback, speechSynthesis, and WebAudio earcons. VoiceLens never
 * touches provider speech APIs — capture audio goes out via /v1/transcribe,
 * and all speech is local. No provider keys exist in this context.
 */
import { logger } from "../../../shared/logger.js";
import { getErrorSpeech } from "../../../shared/messages.js";
import { isExtensionMessage } from "../../../shared/types.js";
import type { AudioPriority, AudioRequest } from "../../../shared/types.js";
import { BackendError, type BackendRef } from "../../../shared/api.js";
import { STORAGE_KEY_CREDENTIALS } from "../../../shared/constants.js";
import { AudioController } from "./audio-controller.js";
import {
  HtmlAudioBackend,
  SpeechSynthesisBackend,
  WebAudioBeeper,
} from "./playback.js";
import { VoiceCapture, type CaptureStats } from "./voice-capture.js";
import { VoiceTurnManager } from "./voice-controller.js";
import { transcribeAudio } from "../ai/whisper-client.js";
import { warmVoices } from "../tts/speech-synthesis-fallback.js";
import {
  DIAG_KEY,
  pushDiag,
  type DiagEntry,
} from "../../../shared/diag.js";

/** Set once, so a storage-less context is reported without spamming the console. */
let storageWarned = false;

/**
 * Id of the voice turn currently owning capture → transcribe → forward.
 * Null when idle. Cleared in a `finally` when the turn settles, so a refused
 * duplicate can never wedge the pipeline shut.
 */
let activeOffscreenTurn: string | null = null;
/** Tab the active turn belongs to (for status narration); undefined when unknown. */
let activeStatusTabId: number | undefined;
/** When the last turn settled (lets tail speech re-show the overlay briefly). */
let lastTurnEndAt = 0;
/**
 * Text of the error currently being spoken (set alongside error speech, read
 * when speech starts so the overlay can show the same message on screen).
 */
let pendingErrorSpeech: string | null = null;

/** Fire-and-forget turn narration for the tab overlay (worker relays to tab). */
function emitVoiceStatus(
  phase: string,
  opts: { turnId?: string; text?: string; tabId?: number } = {},
): void {
  try {
    void chrome.runtime
      .sendMessage({
        type: "VOICE_STATUS",
        requestId: opts.turnId ?? `vs_${Date.now()}`,
        payload: {
          phase,
          ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
          ...(opts.text !== undefined && opts.text !== "" ? { text: opts.text } : {}),
          ...((opts.tabId ?? activeStatusTabId) !== undefined
            ? { tabId: opts.tabId ?? activeStatusTabId }
            : {}),
        },
      })
      .catch(() => undefined);
  } catch {
    // Narration must never break audio.
  }
}

/** On-device voice activity log: the Options page renders it, so voice
 * failures are readable without DevTools. Metadata only, never speech. */
async function appendDiag(kind: string, text: string): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(DIAG_KEY);
    const raw = stored[DIAG_KEY];
    const log: DiagEntry[] = Array.isArray(raw) ? (raw as DiagEntry[]) : [];
    await chrome.storage.local.set({
      [DIAG_KEY]: pushDiag(log, { t: Date.now(), kind, text }),
    });
  } catch {
    // Diagnostics must never break audio.
    if (!storageWarned) {
      storageWarned = true;
      logger.warn("diag: chrome.storage unavailable in the offscreen context — voice log is not being written");
    }
  }
}

/**
 * The backend ref arrives with each request from the service worker. Resolving
 * it from storage inside this document is not dependable, and a failure there
 * looks identical to a transcription failure ("couldn't transcribe"), so the
 * worker is the single source of truth and this is only the first receipt.
 */
let cachedBackend: BackendRef | null = null;

function rememberBackend(payload: Record<string, unknown>): void {
  const raw = payload["backend"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const ref = raw as Record<string, unknown>;
  const url = ref["url"];
  if (typeof url !== "string" || url === "") return;
  const token = ref["token"];
  cachedBackend = {
    url: url.replace(/\/+$/, ""),
    ...(typeof token === "string" && token !== "" ? { token } : {}),
  };
}

async function readBackend(): Promise<BackendRef | null> {
  if (cachedBackend !== null) return cachedBackend;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_CREDENTIALS);
    const creds = stored[STORAGE_KEY_CREDENTIALS] as
      | { backendUrl?: string; backendToken?: string }
      | undefined;
    if (typeof creds?.backendUrl === "string" && creds.backendUrl !== "") {
      cachedBackend = {
        url: creds.backendUrl.replace(/\/+$/, ""),
        ...(typeof creds.backendToken === "string" && creds.backendToken !== ""
          ? { token: creds.backendToken }
          : {}),
      };
    }
  } catch {
    // Not available in this context: the worker-supplied ref is authoritative,
    // so a cold turn simply reports an unconfigured backend instead of throwing
    // a TypeError that would be misreported as a transcription failure.
  }
  return cachedBackend;
}

/**
 * VoiceLens speaks with the browser's own (feminine) voice ONLY.
 * The Groq voice API is deliberately unwired here: this stub throws before
 * any network traffic, so zero provider quota is ever spent on speech and
 * every utterance falls through to local speechSynthesis. The backend
 * /v1/tts route still exists (Options validation + back-compat) but VoiceLens
 * never calls it.
 */
const controller = new AudioController(
  {
    name: "local-voice-only",
    synthesize: async () => {
      throw new BackendError(0, "TTS_DISABLED", "backend voice removed from VoiceLens");
    },
  },
  new HtmlAudioBackend(),
  new SpeechSynthesisBackend(),
  new WebAudioBeeper(),
  readBackend,
  {
    onAuthExpired: () => {
      logger.warn("tts: backend rejected credentials — check Options", {
        errorCode: "AI_SERVICE_UNAVAILABLE",
      });
    },
    onPrimaryLatchedFallback: () => {
      logger.warn("tts: primary latched to local speech for this session");
      void appendDiag("tts", "backend voice failed 3x — using local speech this session");
    },
    onSpeakingChange: (speaking, priority) => {
      // Focus narration (priority 5) is constant chatter — never overlay it.
      if (priority >= 5) return;
      // Speech outside a recent turn (stale notifications, unrelated pages)
      // stays silent on screen.
      const inTurn =
        activeOffscreenTurn !== null || Date.now() - lastTurnEndAt < 30_000;
      if (!inTurn) return;
      if (speaking) {
        emitVoiceStatus("speaking", {
          ...(activeOffscreenTurn !== undefined && activeOffscreenTurn !== null
            ? { turnId: activeOffscreenTurn }
            : {}),
          ...(pendingErrorSpeech !== null ? { text: pendingErrorSpeech } : {}),
        });
        return;
      }
      // Speech ended: resurface an error still being explained, otherwise let
      // the agent's own progress/done statuses (or the auto-hide) take over.
      // Only emit "done" when no turn owns the pipeline anymore — mid-turn
      // pauses must not collapse the overlay back to Done.
      if (pendingErrorSpeech !== null) {
        emitVoiceStatus("error", {
          ...(activeOffscreenTurn !== undefined && activeOffscreenTurn !== null
            ? { turnId: activeOffscreenTurn }
            : {}),
          text: pendingErrorSpeech,
        });
        pendingErrorSpeech = null;
        return;
      }
      if (activeOffscreenTurn === null) {
        emitVoiceStatus("done", { text: "Done" });
      }
    },
  },
);

const capture = new VoiceCapture();
warmVoices();
const turns = new VoiceTurnManager({
  audio: {
    isSpeaking: () => controller.isSpeaking(),
    enqueue: (req) => controller.enqueue(req),
    beep: (kind) => controller.beep(kind),
    stopAll: () => controller.stop(true),
  },
  capture: {
    start: (events) =>
      capture.start({}, {
        onStats: (stats) => {
          logger.info("voice: capture stats", {
            ended: stats.ended,
            durationMs: stats.durationMs,
            effectiveMs: stats.effectiveMs,
            peakRms: Number(stats.peakRms.toFixed(4)),
            ticks: stats.ticks,
            track: stats.trackLabel !== "" ? stats.trackLabel : "(unlabeled)",
            trackState: stats.trackState,
            audioContextState: stats.audioContextState,
            micMode: stats.micMode,
          });
          void appendDiag(
            "capture",
            `ended=${stats.ended} effective=${stats.effectiveMs}ms peak=${(stats.peakRms * 100).toFixed(1)}% mode=${stats.micMode} track=${stats.trackLabel !== "" ? stats.trackLabel : "(unlabeled)"}`,
          );
        },
        // The turn manager's level fan-out (tab mic overlay). Dropping this
        // silently kills the overlay, so it is forwarded explicitly.
        onLevel: events?.onLevel,
      }),
    stopManual: () => capture.stopManual(),
  },
  transcribe: async (blob: Blob, turnId: string) => {
    const backend = await readBackend();
    if (backend === null) {
      throw new Error("Backend not configured (URL missing)");
    }
    // The worker showed "listening"; capture just ended, so the overlay
    // advances to "transcribing" for the network leg of the turn.
    emitVoiceStatus("transcribing", { turnId });
    return transcribeAudio(blob, { backend, turnId });
  },
  sendTranscript: async (transcript, tabId) => {
    // The turn id IS the idempotency key: the worker drops a second delivery
    // of the same turn instead of reasoning over one utterance twice.
    const turnId = transcript.turnId;
    await chrome.runtime.sendMessage({
      type: "VOICE_TRANSCRIPT",
      requestId: turnId ?? `req_${Date.now()}`,
      // The worker drops any transcript it cannot attribute to a tab, and an
      // offscreen document has no `sender.tab` — so the tab travels with it.
      ...(tabId !== undefined ? { tabId } : {}),
      payload: { transcript },
    });
    void appendDiag("done", `transcribed ok (lang=${transcript.lang})`);
  },
    speechLang: "en",
    onError: (code, detail) => {
      logger.warn("voice: turn failed", { code, detail });
      void appendDiag("failed", `${code}: ${detail}`);
      // Mirror the spoken error on screen when speech starts (same message,
      // text form). Cleared on the next turn or when surfaced.
      try {
        pendingErrorSpeech = getErrorSpeech(code, "en");
      } catch {
        pendingErrorSpeech = null;
      }
    },
    onLevel: (level, tabId) => {
      // Fire-and-forget 5Hz feed for the tab's mic overlay (no response).
      void chrome.runtime
        .sendMessage({
          type: "CAPTURE_LEVEL",
          requestId: `lvl_${Date.now()}`,
          payload: { level, ...(tabId !== undefined ? { tabId } : {}) },
        })
        .catch(() => undefined);
    },
  });

function toAudioRequest(payload: Record<string, unknown>, requestId: string): AudioRequest | null {
  const text = payload["text"];
  const langRaw = payload["lang"];
  const priorityRaw = payload["priority"];
  if (typeof text !== "string" || text === "") return null;
  const lang = langRaw === "hi" || langRaw === "mixed" ? langRaw : "en";
  const priority =
    priorityRaw === 1 || priorityRaw === 2 || priorityRaw === 3 || priorityRaw === 4 || priorityRaw === 5
      ? (priorityRaw as AudioPriority)
      : 5;
  return {
    text,
    lang,
    priority,
    interruptible: priority >= 3,
    requestId,
  };
}

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    void _sender;
    if (!isExtensionMessage(message)) {
      sendResponse({ ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" });
      return false;
    }
    // Every message may carry the backend ref; caching it here means
    // transcription and backend TTS work on the first request of a session.
    rememberBackend(message.payload);
    // START_VOICE_TURN is a worker-level control message (the popup asks the
    // worker to run a turn). runtime.sendMessage reaches every context, so
    // without this the default branch below would answer it synchronously and
    // win the race against the worker's real result. Staying silent lets the
    // worker be the sole responder.
    if (message.type === "START_VOICE_TURN") return false;
    switch (message.type) {
      case "TTS_SPEAK": {
        const req = toAudioRequest(message.payload, message.requestId);
        if (req === null) {
          sendResponse({ ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" });
          return false;
        }
        const disposition = controller.enqueue(req).disposition;
        sendResponse({ ok: true, disposition });
        return false;
      }
      case "TTS_STOP": {
        const all = message.payload["all"] === true;
        controller.stop(all);
        sendResponse({ ok: true, stopped: true });
        return false;
      }
      case "TTS_REPEAT": {
        const repeated = controller.repeatLast();
        sendResponse({ ok: true, repeated });
        return false;
      }
      case "TTS_PRIMARY_RESET": {
        controller.resetPrimary();
        sendResponse({ ok: true, reset: true });
        return false;
      }
      case "GATE_OPEN":
      case "GATE_CLOSED":
        // Capture consults controller.isSpeaking() directly; gate messages
        // report live state for diagnostics.
        sendResponse({ ok: true, speaking: controller.isSpeaking() });
        return false;
      case "VOICE_CAPTURE_START": {
        // The starter resolves which tab this turn is for; an offscreen
        // document cannot discover it on its own.
        const rawTabId = message.payload["tabId"];
        turns.setTargetTab(
          typeof rawTabId === "number" && Number.isInteger(rawTabId) ? rawTabId : undefined,
        );
        // Offscreen-level duplicate guard (second line of defense after the
        // worker's in-flight mutex and before the manager's own mutex): an
        // overlapping press is refused WITHOUT capture/transcription/speech.
        const rawTurnId = message.payload["turnId"];
        const incomingTurnId =
          typeof rawTurnId === "string" && rawTurnId !== ""
            ? rawTurnId
            : message.requestId;
        if (activeOffscreenTurn !== null) {
          logger.warn("voice: duplicate capture start refused", {
            turnId: incomingTurnId,
            requestType: "voice-turn",
            timestampMs: Date.now(),
            outcome: "busy",
            activeTurnId: activeOffscreenTurn,
          });
          sendResponse({
            ok: false,
            errorCode: "VOICE_CAPTURE_FAILED",
            busy: true,
            turnId: activeOffscreenTurn,
          });
          return false;
        }
        activeOffscreenTurn = incomingTurnId;
        const rawStatusTab = message.payload["tabId"];
        activeStatusTabId =
          typeof rawStatusTab === "number" && Number.isInteger(rawStatusTab)
            ? rawStatusTab
            : undefined;
        pendingErrorSpeech = null;
        void appendDiag("turn", "capture started");
        turns
          .startTurn(incomingTurnId)
          .then(
            (outcome) => {
              if (outcome.status === "busy") {
                sendResponse({
                  ok: false,
                  errorCode: "VOICE_CAPTURE_FAILED",
                  busy: true,
                  turnId: activeOffscreenTurn,
                });
                return;
              }
              sendResponse({ ok: true, outcome });
            },
            (err: unknown) =>
              sendResponse({
                ok: false,
                errorCode: "VOICE_CAPTURE_FAILED",
                detail: err instanceof Error ? err.message : "unknown",
              }),
          )
          .finally(() => {
            activeOffscreenTurn = null;
            lastTurnEndAt = Date.now();
          });
        return true;
      }
      case "VOICE_STATUS":
        // Our own narration echoes (and the worker's relay) are not for us.
        return false;
      case "VOICE_CAPTURE_STOP": {
        turns.stopCapture();
        sendResponse({ ok: true, stopping: true });
        return false;
      }
      case "DIAG_CAPTURE": {
        // One-click voice diagnostics (Options page): run the real capture
        // pipeline in THIS document — no transcribe, no beeps, no agent side
        // effects — and report what the mic delivered. Stats are returned even
        // on failure so silence is distinguishable from denial.
        let stats: CaptureStats | null = null;
        capture
          .start({ maxSeconds: 10 }, { onStats: (s) => { stats = s; } })
          .then(
            () => sendResponse({ ok: true, diag: "capture", stats }),
            (err: unknown) =>
              sendResponse({
                ok: false,
                errorCode: "VOICE_CAPTURE_FAILED",
                detail: err instanceof Error ? err.message : "unknown",
                stats,
              }),
          );
        return true;
      }
      default:
        sendResponse({ ok: true, offscreen: true, phase: 3 });
        return false;
    }
  },
);

logger.info("offscreen audio runtime ready (local voice only; backend TTS unwired)");
