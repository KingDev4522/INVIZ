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
import { STORAGE_KEY_CONFIG, STORAGE_KEY_PROFILE, parseContextMode, CONTEXT_MODE_DEFAULT } from "../../../../shared/constants.js";
import { sanitizeProfile } from "../../../../shared/profile.js";
import { BrowserHarnessBridge } from "../../bridge/harness-bridge.js";
import { NativeMessagingTransport } from "../../bridge/native-transport.js";
import { logger } from "../../../../shared/logger.js";
import { captureViewportScreenshot } from "../hybrid/screenshot.js";

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

/**
 * Post-navigation settle: polls the content-script-posted snapshot until its
 * URL matches the navigation target (trailing-slash-insensitive) or the
 * budget expires. The posting script arrives 1–5 s after a navigation;
 * reasoning against the pre-navigation snapshot in between is what made
 * compound tasks click stale refs. False on timeout — the caller proceeds
 * cautiously instead of wedging. Never throws.
 */
export async function waitForPageSnapshot(
  tabId: number,
  url: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const want = url.replace(/\/+$/, "");
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    let observed = "";
    try {
      const key = `page:tab:${tabId}`;
      const stored = await chrome.storage.session.get(key);
      const state = stored[key] as { url?: unknown } | undefined;
      if (typeof state?.url === "string") observed = state.url;
    } catch {
      observed = "";
    }
    if (observed !== "" && observed.replace(/\/+$/, "") === want) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
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
  // Operator flags (popup toggles, STORAGE_KEY_CONFIG). powerMode bypasses
  // WebGuard safety gates (correctness BLOCKs stay); harnessEnabled routes
  // execution through the external browser-harness host with safe local
  // fallback. Both default off; both read fresh on every controller build.
  // contextMode is the EXPERIMENTAL vision prototype: absent/"dom" means the
  // existing DOM path exactly as before, so this stays off unless explicitly
  // written by an operator.
  const cfgStored = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
  const flags = (cfgStored[STORAGE_KEY_CONFIG] as
    | { powerMode?: boolean; harnessEnabled?: boolean; contextMode?: string }
    | undefined) ?? {};
  const powerMode = flags.powerMode === true;
  const harnessEnabled = flags.harnessEnabled === true;
  const contextMode = parseContextMode(flags.contextMode);
  return new AgentController({
    backend,
    fetchImpl,
    ...(powerMode ? { powerMode: true as const } : {}),
    // EXPERIMENTAL hybrid vision: BOTH absent when "dom", so the default build
    // passes exactly what it did before the prototype existed.
    ...(contextMode !== CONTEXT_MODE_DEFAULT
      ? { contextMode, captureScreenshot: captureViewportScreenshot }
      : {}),
    ...(harnessEnabled
      ? {
          executionPolicy: { allowExternal: true, preference: "external" as const },
          externalExecutor: new BrowserHarnessBridge({
            transport: new NativeMessagingTransport(),
            // Authorization already happened (WebGuard + consent + router
            // ran before execution); the bridge re-validates every request
            // against the closed schema regardless.
            authorizedTaskIds: () => true,
          }),
        }
      : {}),
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
            savedAt?: unknown;
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
        ...(typeof state.savedAt === "number" ? { savedAt: state.savedAt } : {}),
      };
    },
    waitForSettledSnapshot: (tabId: number, url: string, timeoutMs: number) =>
      waitForPageSnapshot(tabId, url, timeoutMs),
    // CURRENT-PAGE acquisition: live URL + on-demand pull. Both are
    // best-effort (null on closed/unreachable tabs) — the controller treats
    // absence as "skip the check", never as failure.
    getTabUrl: async (tabId: number) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        return typeof tab.url === "string" ? tab.url : null;
      } catch {
        return null;
      }
    },
    requestFreshSnapshot: async (tabId: number) => {
      // Direct pull wins (no storage race); storage poll is the fallback.
      try {
        const res = (await chrome.tabs.sendMessage(tabId, {
          type: "REQUEST_SNAPSHOT",
          requestId: `req_${Date.now()}`,
          tabId,
          payload: {},
        })) as
          | { ok?: unknown; payload?: { state?: unknown } }
          | null
          | undefined;
        const direct = res?.payload?.state as
          | {
              url?: unknown;
              title?: unknown;
              generation?: unknown;
              items?: unknown;
              structure?: unknown;
              prose?: unknown;
              savedAt?: unknown;
            }
          | undefined;
        if (
          direct !== undefined &&
          typeof direct.url === "string" &&
          typeof direct.title === "string" &&
          typeof direct.generation === "number" &&
          Array.isArray(direct.items)
        ) {
          const structure = direct.structure as PageSnapshotLike["structure"] | undefined;
          const prose = Array.isArray(direct.prose)
            ? (direct.prose as NonNullable<PageSnapshotLike["prose"]>)
            : undefined;
          return {
            url: direct.url,
            title: direct.title,
            generation: direct.generation,
            items: direct.items as PageSnapshotLike["items"],
            ...(structure !== undefined &&
            Array.isArray(structure.headings) &&
            Array.isArray(structure.landmarks) &&
            Array.isArray(structure.forms)
              ? { structure }
              : {}),
            ...(prose !== undefined ? { prose } : {}),
            ...(typeof direct.savedAt === "number" ? { savedAt: direct.savedAt } : {}),
          };
        }
      } catch {
        // Content script unreachable (restricted page, not yet injected):
        // fall through to the storage poll below.
      }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((r) => setTimeout(r, 200));
        const key = `page:tab:${tabId}`;
        try {
          const stored = await chrome.storage.session.get(key);
          const state = stored[key] as
            | {
                url?: unknown;
                title?: unknown;
                generation?: unknown;
                items?: unknown;
                structure?: unknown;
                prose?: unknown;
                savedAt?: unknown;
              }
            | undefined;
          if (
            state !== undefined &&
            typeof state.url === "string" &&
            typeof state.title === "string" &&
            typeof state.generation === "number" &&
            Array.isArray(state.items)
          ) {
            const structure = state.structure as PageSnapshotLike["structure"] | undefined;
            const prose = Array.isArray(state.prose)
              ? (state.prose as NonNullable<PageSnapshotLike["prose"]>)
              : undefined;
            return {
              url: state.url,
              title: state.title,
              generation: state.generation,
              items: state.items as PageSnapshotLike["items"],
              ...(structure !== undefined &&
              Array.isArray(structure.headings) &&
              Array.isArray(structure.landmarks) &&
              Array.isArray(structure.forms)
                ? { structure }
                : {}),
              ...(prose !== undefined ? { prose } : {}),
              ...(typeof state.savedAt === "number" ? { savedAt: state.savedAt } : {}),
            };
          }
        } catch {
          return null;
        }
      }
      return null;
    },
    // "My details" pre-seed: sanitized ordinary contact values for new
    // tasks' slot-fill. Fail-soft {} preserves previous behavior.
    loadProfile: async () => {
      try {
        const stored = await chrome.storage.local.get(STORAGE_KEY_PROFILE);
        return { ...sanitizeProfile(stored[STORAGE_KEY_PROFILE]) } as Record<string, string>;
      } catch {
        return {};
      }
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
