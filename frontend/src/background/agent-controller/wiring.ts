/**
 * Production wiring: builds the AgentController with real chrome-backed
 * dependencies (PRD 6.5). Pure orchestration glue — no policy here.
 */
import { AgentController, type AgentProgressEvent } from "./controller.js";
import { clearTask, loadTask, saveTask } from "../task-state/store.js";
import { STORAGE_KEY_CREDENTIALS } from "../../../../shared/constants.js";
import type { AudioPriority } from "../../../../shared/types.js";
import type { BackendRef, LayerB } from "../../../../shared/api.js";
import type { PageSnapshotLike } from "./controller.js";
import type { SkillCatalog } from "../../skills/plan.js";
import { SkillRegistry } from "../../skills/registry.js";
import { createBuiltinCatalog, registerBuiltinSkills } from "../../skills/builtin/index.js";
import { attachPersistence, loadRegistryFromStore } from "../../skills/persistence.js";
import { ChromeLocalSkillStore } from "../skills/skill-store.js";
import { ChromeEpisodeStore } from "../learning/chrome-episode-store.js";
import { STORAGE_KEY_CONFIG } from "../../../../shared/constants.js";
import { logger } from "../../../../shared/logger.js";

/**
 * Phase 5 episode recording is EXPLICITLY opt-in. It reads the same
 * `config:user` object the existing voicelens toggle uses and defaults to OFF
 * — with the flag absent or false, no episode is ever buffered or persisted.
 */
async function readEpisodeRecording(): Promise<boolean> {
  try {
    const cfg = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
    const flag = cfg[STORAGE_KEY_CONFIG] as { episodeRecording?: boolean } | undefined;
    return flag?.episodeRecording === true;
  } catch {
    return false; // fail closed: never record unless explicitly enabled
  }
}

type SkillPersistenceHandle = { detach: () => void; lastError: () => string | null };

/**
 * Built-in skill runtime, built once per worker. The three first-party skills
 * are registered through the real Phase 1 SkillRegistry (never a parallel one)
 * and arrive as `approved` — executable but never auto-trusted.
 *
 * Phase 4: a persisted trust overlay is loaded from chrome.storage.local
 * (validated, fail-closed) and every later mutation is persisted. The runtime
 * is validated synchronously where possible; a load failure degrades to the
 * built-in defaults rather than blocking the agent.
 */
let skillRuntimeCache: {
  registry: SkillRegistry;
  catalog: SkillCatalog;
  persistence: SkillPersistenceHandle | null;
} | null = null;

async function skillRuntime(): Promise<{
  registry: SkillRegistry;
  catalog: SkillCatalog;
  persistence: SkillPersistenceHandle | null;
}> {
  if (skillRuntimeCache !== null) return skillRuntimeCache;
  const registry = new SkillRegistry();
  registerBuiltinSkills(registry);
  const store = new ChromeLocalSkillStore();
  const loaded = await loadRegistryFromStore(store, registry).catch(() => ({
    applied: 0,
    registered: 0,
    rejected: ["load failed"],
  }));
  if (loaded.rejected.length > 0) {
    logger.warn("skills: rejected persisted records", {
      rejected: loaded.rejected.length,
      applied: loaded.applied,
      registered: loaded.registered,
    });
  }
  const persistence = attachPersistence(store, registry);
  skillRuntimeCache = { registry, catalog: createBuiltinCatalog(), persistence };
  return skillRuntimeCache;
}

/**
 * Resolves the configured backend from extension storage. The offscreen
 * document receives this by value — it has no dependable chrome.storage access,
 * so resolving the URL over there would fail every turn that needs it.
 */
export async function readBackendRef(): Promise<BackendRef | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_CREDENTIALS);
  const creds = stored[STORAGE_KEY_CREDENTIALS] as
    | { backendUrl?: string; backendToken?: string }
    | undefined;
  if (typeof creds?.backendUrl !== "string" || creds.backendUrl === "") {
    return null;
  }
  return {
    url: creds.backendUrl.replace(/\/+$/, ""),
    ...(typeof creds.backendToken === "string" && creds.backendToken !== ""
      ? { token: creds.backendToken }
      : {}),
  };
}

async function speakViaOffscreen(
  text: string,
  lang: "en" | "hi" | "mixed",
  priority: AudioPriority,
): Promise<void> {
  await ensureOffscreenReady();
  const backend = await readBackendRef().catch(() => null);
  await chrome.runtime
    .sendMessage({
      type: "TTS_SPEAK",
      requestId: `req_${Date.now()}`,
      payload: {
        text,
        lang,
        priority,
        target: "offscreen",
        ...(backend !== null ? { backend } : {}),
      },
    })
    .catch(() => undefined);
}

/** Keyless speech path (cancellation/override notices work without C1). */
export async function speakText(
  text: string,
  lang: "en" | "hi" | "mixed",
  priority: AudioPriority,
): Promise<void> {
  await speakViaOffscreen(text, lang, priority);
}

/** Keyless audio halt (cancellation works without C1). */
export async function stopAllAudio(): Promise<void> {
  await ensureOffscreenReady();
  await chrome.runtime
    .sendMessage({
      type: "TTS_STOP",
      requestId: `req_${Date.now()}`,
      payload: { all: true, target: "offscreen" },
    })
    .catch(() => undefined);
}

/** Keyless agent-active flag for override detection. */
export async function setTabAgentActive(tabId: number, active: boolean): Promise<void> {
  await chrome.tabs
    .sendMessage(tabId, {
      type: "AGENT_ACTIVE",
      requestId: `req_${Date.now()}`,
      tabId,
      payload: { active },
    })
    .catch(() => undefined);
}

export async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: [
      chrome.offscreen.Reason.USER_MEDIA,
      chrome.offscreen.Reason.AUDIO_PLAYBACK,
    ],
    justification:
      "VoiceLens audio capture, TTS playback, and half-duplex turn control",
  });
}

/**
 * Readiness handshake. createDocument resolves before the document's module
 * scripts register their message listener, so a message sent immediately
 * after creation can vanish silently (no listener → sendMessage resolves
 * undefined). GATE_OPEN is side-effect-free and answers { speaking }, so it
 * doubles as the readiness ping. Fail-open on timeout: the message may land
 * anyway once the document finishes loading.
 */
export async function ensureOffscreenReady(timeoutMs = 3000): Promise<void> {
  await ensureOffscreen();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = (await chrome.runtime
      .sendMessage({
        type: "GATE_OPEN",
        requestId: `ping_${Date.now()}`,
        payload: {},
      })
      .catch(() => undefined)) as { speaking?: unknown } | undefined;
    if (res !== undefined && typeof res.speaking === "boolean") return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Builds a controller wired to live extension APIs. Throws when the backend is unconfigured. */
export async function buildController(
  fetchImpl?: typeof fetch,
  opts: { onProgress?: (event: AgentProgressEvent) => void } = {},
): Promise<AgentController> {
  const backend = await readBackendRef();
  if (backend === null) {
    throw new Error("Backend not configured — set the backend URL in Options");
  }

  const skills = await skillRuntime();
  const recording = await readEpisodeRecording();
  return new AgentController({
    backend,
    fetchImpl,
    skillRegistry: skills.registry,
    skillCatalog: skills.catalog,
    // Phase 5 learning layer: off unless the user opted in.
    recording,
    ...(recording ? { episodeStore: new ChromeEpisodeStore() } : {}),
    ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
    speak: (text, lang, priority) => speakViaOffscreen(text, lang, priority),
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
    setAgentActive: (tabId: number, active: boolean) =>
      setTabAgentActive(tabId, active),
    loadSnapshot: async (tabId: number) => {
      const key = `page:tab:${tabId}`;
      const storedState = await chrome.storage.session.get(key);
      const state = storedState[key] as
        | {
            url?: unknown;
            title?: unknown;
            generation?: unknown;
            items?: unknown;
            structure?: unknown;
            prose?: unknown;
          }
        | undefined;
      if (
        state === undefined ||
        typeof state.url !== "string" ||
        typeof state.title !== "string" ||
        typeof state.generation !== "number" ||
        !Array.isArray(state.items)
      ) {
        return null;
      }
      const structure = state.structure as PageSnapshotLike["structure"] | undefined;
      const prose = Array.isArray(state.prose)
        ? (state.prose as NonNullable<PageSnapshotLike["prose"]>)
        : undefined;
      return {
        url: state.url,
        title: state.title,
        generation: state.generation,
        items: state.items as Array<{
          id: string;
          role: string;
          name: string;
          states: Record<string, string | boolean | number>;
          fieldKind: string | null;
          sensitive: boolean;
        }>,
        ...(structure !== undefined &&
        Array.isArray(structure.headings) &&
        Array.isArray(structure.landmarks) &&
        Array.isArray(structure.forms)
          ? { structure }
          : {}),
        ...(prose !== undefined ? { prose } : {}),
      };
    },
    loadLayerB: async (tabId: number) => {
      const key = `layerb:${tabId}`;
      const storedLayer = await chrome.storage.session.get(key);
      const layer = storedLayer[key] as LayerB | undefined;
      return layer ?? null;
    },
    saveLayerB: async (tabId: number, layer: LayerB) => {
      await chrome.storage.session.set({ [`layerb:${tabId}`]: layer });
    },
    readFocusedElement: async (tabId: number) => {
      const res = (await chrome.tabs.sendMessage(tabId, {
        type: "FOCUS_CHANGED",
        requestId: `req_${Date.now()}`,
        tabId,
        payload: {},
      })) as { announcement?: { text?: unknown; name?: unknown; role?: unknown } } | null;
      const a = res?.announcement;
      if (typeof a?.text !== "string" || a.text === "") return null;
      return {
        text: a.text,
        name: typeof a.name === "string" ? a.name : "",
        role: typeof a.role === "string" ? a.role : "",
      };
    },
    readRegionText: async (tabId: number, targetId: string | undefined, maxChars: number) => {
      const res = (await chrome.tabs.sendMessage(tabId, {
        type: "READ_TEXT",
        requestId: `req_${Date.now()}`,
        tabId,
        payload: { target: targetId, maxChars },
      })) as { payload?: { text?: unknown } } | null;
      const text = res?.payload?.text;
      if (typeof text !== "string") throw new Error("READ_TEXT failed");
      return text;
    },
    repeatAudio: async () => {
      await ensureOffscreenReady();
      await chrome.runtime
        .sendMessage({
          type: "TTS_REPEAT",
          requestId: `req_${Date.now()}`,
          payload: { target: "offscreen" },
        })
        .catch(() => undefined);
    },
    store: { load: loadTask, save: saveTask, clear: clearTask },
  });
}
