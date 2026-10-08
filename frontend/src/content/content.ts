/**
 * Content-script entry (PRD 4 §7; PRD 6.1 + 6.5).
 * Phase 1 wiring (extract → registry → focus → observe → snapshot) plus
 * Phase 5 execution surface:
 * - ACTION_EXECUTE: resolve + perform one approved DOM action (TOCTOU guard).
 * - OBSERVE_VERIFY: poll evaluateExpectation() until decisive or timed out.
 * - READ_TEXT: bounded region text for the read-aloud flow.
 * - AGENT_ACTIVE: arms/disarms trusted-input override detection (human-wins).
 * Live DOM references never leave this context.
 */
import { logger } from "../../../shared/logger.js";
import { isExtensionMessage } from "../../../shared/types.js";
import type {
  Announcement,
  AnnounceLang,
} from "./focus-monitor.js";
import { FocusMonitor, HoverCoalescer, isDescendantComposed } from "./focus-monitor.js";
import { extractStates, getOpenDialogs, resolveRole } from "./dom-extractor.js";
import { computeAccessibleName, fieldHasValue } from "./aria-extractor.js";
import { STORAGE_KEY_CONFIG } from "../../../shared/constants.js";
import { ContextLens } from "./contextlens/index.js";
import { performDomAction } from "./actions.js";
import { PageObserver, type ChangeTrigger } from "./page-observer.js";
import {
  evaluateExpectation,
  type VerifyFacts,
} from "../verification/verification-engine.js";
import { collectCompletionSignals } from "../verification/submit-verification.js";
import type { Expectation } from "../../../shared/types.js";
import { VoiceOverlay } from "./voice-overlay.js";
import type { VoicePhase } from "../../../shared/voice-status.js";

/**
 * Frame guard: with `all_frames: true` this script runs in every iframe, but
 * exactly ONE instance per tab may own the snapshot, the overlay, and message
 * handling — the top frame. Subframes stay inert so snapshots never get
 * clobbered by iframe content and actions never execute twice.
 */
function isTopFrame(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

const lens = new ContextLens();
const pendingAnnouncements: Announcement[] = [];
const MAX_PENDING = 20;
// Last hovered/focused element, in spoken form — answers "what is this?"
// without a model round-trip. Updated on every announcement.
let lastAnnouncement: Announcement | null = null;

function pageLang(): AnnounceLang {
  const tag = (document.documentElement.lang || "en").toLowerCase();
  return tag.startsWith("hi") ? "hi" : "en";
}

const monitor = new FocusMonitor((el) => {
  const { elementId, generation } = lens.identify(el);
  const role = resolveRole(el);
  const { name } = computeAccessibleName(el, document);
  const states = extractStates(el, role);
  void generation;
  return { elementId, name, role, states };
});
monitor.setLang(pageLang());
async function voicelensOn(): Promise<boolean> {
  try {
    const cfg = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
    const flag = cfg[STORAGE_KEY_CONFIG] as { voicelensEnabled?: boolean } | undefined;
    return flag?.voicelensEnabled === true;
  } catch {
    return false;
  }
}
function speakLive(text: string, lang: AnnounceLang): void {
  if (text.trim() === "") return;
  void voicelensOn().then((on) => {
    if (!on || !contextAlive()) return;
    try {
      chrome.runtime
        .sendMessage({
          type: "TTS_SPEAK",
          requestId: `speak_${Date.now()}`,
          payload: { text, lang, priority: 5 },
        })
        .catch(() => undefined);
    } catch {
      contextDead = true;
    }
  });
}
monitor.onAnnouncement((a) => {
  lastAnnouncement = a;
  pendingAnnouncements.push(a);
  if (pendingAnnouncements.length > MAX_PENDING) {
    pendingAnnouncements.shift();
  }
  speakLive(a.text, a.lang);
});
// Hover narration (cursor-aware, coalesced): the cursor settling over content
// speaks the element under it via the hover eligibility path (headings, text
// blocks, images with alt — focusability NOT required). Rapid movement
// coalesces: intermediate targets may be skipped, but the latest target is
// always flushed on the trailing edge. TTS spam is prevented downstream
// (priority-5 focus-takeover + signature dedupe), never by dropping here.
function deepHoverTarget(e: MouseEvent): Element | null {
  const t = e.target;
  if (!(t instanceof Element)) return null;
  // elementFromPoint pierces OPEN shadow roots, so VoiceLens reads the actual
  // inner target instead of an unannounceable shadow host. Closed roots
  // terminate at their host (same as assistive technology — never penetrated).
  // The composed-descendant guard means we only ever descend within the event
  // target's own subtree: never jump to an unrelated overlay, and never touch
  // another document (a cross-origin iframe yields the iframe element itself,
  // which is unannounceable and stays silent).
  try {
    const deep = document.elementFromPoint(e.clientX, e.clientY);
    if (deep instanceof Element && deep !== t && isDescendantComposed(t, deep)) {
      return deep;
    }
  } catch {
    // Hit-testing unavailable (or a hostile page): fall through to the event
    // target, exactly the old behavior.
  }
  return t;
}

const hoverCoalescer = new HoverCoalescer((el) => {
  const announcement = monitor.handleHover(el);
  // Stale-state fix: the cursor is on a non-readable target, so "what is
  // this?" must not describe an unrelated previous element.
  if (announcement === null) lastAnnouncement = null;
});
document.addEventListener(
  "mouseover",
  (e: Event) => {
    if (!isTopFrame()) return;
    if (!(e instanceof MouseEvent)) return;
    const target = deepHoverTarget(e);
    if (target === null) return;
    hoverCoalescer.push(target);
  },
  true,
);

/**
 * MV3 reality: reloading/updating the extension kills this script's extension
 * context, but the script keeps running in the page. Every chrome.* call then
 * throws "Extension context invalidated" SYNCHRONOUSLY — a `.catch()` on the
 * returned promise never sees it, hence the uncaught-error spam. Guard once
 * here: dead context → park the observers and go silent instead of throwing.
 */
let contextDead = false;
function contextAlive(): boolean {
  if (contextDead) return false;
  try {
    if (chrome?.runtime?.id === undefined) {
      contextDead = true;
      try {
        observer.stop();
      } catch {
        // Already down.
      }
      try {
        monitor.stop();
      } catch {
        // Already down.
      }
      return false;
    }
    return true;
  } catch {
    contextDead = true;
    return false;
  }
}

function pushSnapshot(): void {
  if (!isTopFrame() || !contextAlive()) return;
  const state = lens.extract(document);
  const snapshot = {
    url: state.url,
    title: state.title,
    generation: state.generation,
    items: lens.registry.snapshot(),
    // Structure and prose travel with the snapshot: without them the model
    // receives a list of widgets and nothing about what the page says.
    structure: state.structure,
    prose: state.prose,
    skipped: state.skipped,
    savedAt: Date.now(),
  };
  try {
    chrome.runtime
      .sendMessage({
        type: "PAGE_STATE_UPDATED",
        requestId: `req_${Date.now()}`,
        payload: { state: snapshot },
      })
      .catch(() => {
        logger.debug("snapshot: service worker unavailable (extension reloading?)");
      });
  } catch {
    contextDead = true;
    logger.debug("snapshot: extension context invalidated — parked until reload");
  }
}

const observer = new PageObserver(document, {
  onTrigger: (trigger: ChangeTrigger, detail: string) => {
    logger.debug("page trigger", { trigger, detail });
    if (trigger === "minor") return; // handled locally; no rebuild
    pushSnapshot();
    // Generic SPA late-render follow-up: the route push happens before
    // shadow-DOM/async content renders. Re-extract twice so the stored
    // snapshot for the CURRENT url contains the late targets by the time the
    // next voice command reads it. No site-specific logic.
    if (trigger === "route") {
      const urlAtRoute = location.href;
      for (const delayMs of [1200, 3200]) {
        setTimeout(() => {
          if (location.href !== urlAtRoute) return;
          pushSnapshot();
        }, delayMs);
      }
    }
  },
});

// --- Human-wins override detection (PRD 6 §8) --------------------------------
// Armed only while the agent is executing in this tab. Trusted user input
// (isTrusted) pauses autonomous execution; synthetic page events never do.
let agentActive = false;
let lastOverrideSent = 0;

function onTrustedUserInput(kind: string): void {
  if (!agentActive) return;
  const now = Date.now();
  if (now - lastOverrideSent < 1000) return; // debounce 1s
  lastOverrideSent = now;
  agentActive = false; // local halt until the worker re-arms or stands down
  if (!contextAlive()) return;
  try {
    chrome.runtime
      .sendMessage({
        type: "USER_OVERRIDE",
        requestId: `ovr_${now}`,
        payload: { kind },
      })
      .catch(() => undefined);
  } catch {
    contextDead = true;
  }
}

for (const event of ["keydown", "click", "wheel"] as const) {
  document.addEventListener(
    event,
    (e: Event) => {
      if (!isTopFrame()) return;
      if (e.isTrusted) onTrustedUserInput(event);
    },
    true,
  );
}

// --- Verification observation ------------------------------------------------

interface ObservePayload {
  expect: Expectation;
  identity: { role: string; name: string } | null;
  urlBefore: string;
  actionGeneration: number;
  timeoutMs: number;
}

function identityPresent(identity: { role: string; name: string } | null): boolean | null {
  if (identity === null) return null;
  const fresh = lens.extract(document);
  void fresh;
  for (const item of lens.registry.snapshot()) {
    if (item.role === identity.role && item.name === identity.name) return true;
  }
  return false;
}

function collectFacts(
  payload: ObservePayload,
  actionGeneration: number,
): VerifyFacts {
  const urlNow = location.href;
  const currentGen = lens.registry.currentGeneration;
  let activeMatches: boolean | null = null;
  let fieldFilled: boolean | null = null;
  let stateMatches: boolean | null = null;
  const expect = payload.expect;

  if (
    (expect.type === "focused_element" ||
      expect.type === "field_value_present" ||
      expect.type === "element_state") &&
    expect.target !== undefined
  ) {
    const resolved = lens.registry.resolve(expect.target, currentGen);
    if (resolved.ok) {
      const el = resolved.entry.element;
      if (expect.type === "focused_element") {
        activeMatches = document.activeElement === el;
      }
      if (expect.type === "field_value_present") {
        fieldFilled = fieldHasValue(el);
      }
      if (expect.type === "element_state" && expect.state !== undefined) {
        // Live DOM truth: registry states are snapshot-stale for toggles. Read the element directly.
        const live = (() => {
          if (expect.state === "checked") {
            if (el instanceof HTMLInputElement) return el.checked;
            const aria = el.getAttribute("aria-checked");
            if (aria === "true") return true;
            if (aria === "false") return false;
          }
          if (expect.state === "expanded") {
            const aria = el.getAttribute("aria-expanded");
            if (aria === "true") return true;
            if (aria === "false") return false;
          }
          if (expect.state === "selected") {
            const aria = el.getAttribute("aria-selected");
            if (aria === "true") return true;
            if (aria === "false") return false;
            if (el instanceof HTMLOptionElement) return el.selected;
          }
          if (expect.state === "pressed") {
            const aria = el.getAttribute("aria-pressed");
            if (aria === "true") return true;
            if (aria === "false") return false;
          }
          return null;
        })();
        if (live !== null) stateMatches = live === expect.stateValue;
        else {
          const states = resolved.entry.states;
          stateMatches = states[expect.state] === expect.stateValue;
        }
      }
    } else if (resolved.code === "STALE_TARGET" && payload.identity !== null) {
      // Generation moved on: fall back to semantic-identity matching.
      const present = identityPresent(payload.identity);
      if (expect.type === "field_value_present") {
        fieldFilled = present === true ? null : false;
      }
      if (expect.type === "element_state") {
        stateMatches = present === true ? null : false;
      }
      if (expect.type === "focused_element") {
        activeMatches = false;
      }
    } else {
      if (expect.type === "field_value_present") fieldFilled = false;
      if (expect.type === "element_state") stateMatches = false;
      if (expect.type === "focused_element") activeMatches = false;
    }
  }

  let textFound: boolean | null = null;
  if (expect.type === "text_present") {
    if (typeof expect.value === "string" && expect.value !== "") {
      textFound = (document.body?.innerText ?? "").includes(expect.value);
    }
  }

  // Generic completion signals for submit-style side effects: navigation,
  // confirmation dialog, success toast, form removed, control disabled. Always
  // collected (cheap, guarded) so the pure evaluator has them when asked.
  const submit = collectCompletionSignals(document, expect.target, {
    urlBefore: payload.urlBefore,
    resolveTarget: (id) => {
      const resolved = lens.registry.resolve(id, currentGen);
      return resolved.ok ? resolved.entry.element : null;
    },
    targetMissingFromRegistry:
      expect.target !== undefined && !lens.registry.resolve(expect.target, currentGen).ok,
    identityMissing:
      expect.target === undefined && payload.identity !== null
        ? identityPresent(payload.identity) === false
        : false,
  });

  return {
    urlBefore: payload.urlBefore,
    urlNow,
    targetPresent: payload.identity !== null ? identityPresent(payload.identity) : null,
    activeMatches,
    dialogOpen: getOpenDialogs(document).length > 0,
    textFound,
    fieldFilled,
    stateMatches,
    generationChanged: currentGen !== actionGeneration,
    submit,
  };
}

function handleObserveVerify(
  payload: ObservePayload,
  sendResponse: (response: unknown) => void,
): void {
  const startedAt = Date.now();
  const timeout = Math.min(Math.max(payload.timeoutMs, 100), 10000);
  const tick = (): void => {
    const facts = collectFacts(payload, payload.actionGeneration);
    const verdict = evaluateExpectation(payload.expect, facts);
    if (verdict !== "PENDING") {
      sendResponse({
        ok: true,
        payload: {
          outcome: verdict,
          observed: {
            url: facts.urlNow,
            generation: lens.registry.currentGeneration,
          },
          timedOut: false,
        },
      });
      return;
    }
    if (Date.now() - startedAt >= timeout) {
      sendResponse({
        ok: true,
        payload: {
          outcome: "VERIFIED_FAILURE",
          observed: {
            url: facts.urlNow,
            generation: lens.registry.currentGeneration,
          },
          timedOut: true,
        },
      });
      return;
    }
    setTimeout(tick, 250);
  };
  tick();
}

// --- Read-aloud text ----------------------------------------------------------

/**
 * Readable text for a region id, an element id, or (absent a target) the
 * page's main prose.
 *
 * When the target resolves to a heading or a thin wrapper, the containing
 * prose region is read instead. Previously the target element's own
 * textContent was returned, so "read this article" against an <h1> spoke only
 * the headline.
 */
function readRegionText(targetId: string | undefined, maxChars: number): string {
  const cap = Math.min(Math.max(maxChars, 100), 20000);
  let source: Element | null = null;

  if (targetId !== undefined) {
    // Prose region handle (r1, r2, …) as advertised in the page state.
    const prose = lens.proseRegions();
    const regionMatch = /^r\d+$/.exec(targetId);
    if (regionMatch !== null) {
      const index = Number(targetId.slice(1)) - 1;
      const region = prose[index];
      if (region !== undefined) return region.text.slice(0, cap);
    }
    const resolved = lens.registry.resolve(targetId, lens.registry.currentGeneration);
    if (resolved.ok) source = lens.proseFor(resolved.entry.element);
  }

  if (source === null) {
    // No usable target: read the primary prose region rather than the whole
    // body, so nav/footer chrome is not spoken as part of the article.
    const prose = lens.proseRegions();
    const primary = prose[0];
    if (primary !== undefined) return primary.text.slice(0, cap);
    source = document.querySelector("main, article, [role='main']") ?? document.body;
  }
  if (source === null) return "";
  const text = (source.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, cap);
}

// --- Voice overlay (every-moment turn narration) ---------------------------------
// Replaces the old mic-meter box: orb animation + status headline + transcript
// detail + live mic meter, all in one non-interactive pill. Driven by
// VOICE_STATUS (worker → tab) and CAPTURE_LEVEL (5Hz mic feed).
// Numbers and status text only — no audio ever touches this context.
const voiceOverlay = new VoiceOverlay();

function showMicLevel(level: number): void {
  voiceOverlay.setLevel(level);
}

function showVoiceStatus(payload: Record<string, unknown>): void {
  const phase = payload["phase"];
  if (
    phase !== "listening" &&
    phase !== "transcribing" &&
    phase !== "transcript" &&
    phase !== "thinking" &&
    phase !== "awaiting" &&
    phase !== "speaking" &&
    phase !== "done" &&
    phase !== "error" &&
    phase !== "busy"
  ) {
    return;
  }
  const text = payload["text"];
  // showStatus routes agent thinking to the prominent headline and keeps
  // transcripts/questions as detail under their phase headline.
  voiceOverlay.showStatus(
    phase as VoicePhase,
    typeof text === "string" ? text : undefined,
  );
}

// --- Wiring -------------------------------------------------------------------

if (isTopFrame()) {
  pushSnapshot();
  monitor.start();
  observer.start();
  logger.info("content script wired (Phase 1+5)", { url: location.href });
} else {
  logger.debug("content script parked (subframe; top frame owns the tab)");
}

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    // Subframes never handle messages: with all_frames the top frame alone
    // owns execution/observation, so actions can never run twice per tab.
    if (!isTopFrame()) return false;
    if (!isExtensionMessage(message)) {
      sendResponse({ ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" });
      return false;
    }
    switch (message.type) {
      case "CAPTURE_LEVEL": {
        const level = message.payload["level"];
        if (typeof level === "number") showMicLevel(level);
        return false;
      }
      case "VOICE_STATUS": {
        showVoiceStatus(message.payload);
        return false;
      }
      case "FOCUS_CHANGED": {
        // Cursor query for "what is this?": the last hovered/focused element.
        sendResponse({
          ok: true,
          pending: pendingAnnouncements.length,
          announcement:
            lastAnnouncement === null
              ? null
              : {
                  text: lastAnnouncement.text,
                  name: lastAnnouncement.name,
                  role: lastAnnouncement.role,
                },
        });
        return false;
      }
      case "ACTION_EXECUTE": {
        const action = message.payload["action"] as unknown;
        if (typeof action !== "object" || action === null) {
          sendResponse({ ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" });
          return false;
        }
        // performDomAction is async (awaits animation frame for toggle clicks)
        // so keep the message channel open with `return true`.
        void performDomAction(
          action as Parameters<typeof performDomAction>[0],
          lens.registry,
          lens.registry.currentGeneration,
        ).then((result) => {
          sendResponse({
            ok: result.ok,
            payload: result.ok
              ? { ok: true }
              : { ok: false, errorCode: result.errorCode ?? "ACTION_FAILED" },
          });
        });
        return true;
      }
      case "OBSERVE_VERIFY": {
        const payload = message.payload as unknown as ObservePayload;
        if (
          typeof payload !== "object" ||
          payload === null ||
          typeof (payload as ObservePayload).timeoutMs !== "number"
        ) {
          sendResponse({ ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" });
          return false;
        }
        handleObserveVerify(payload as ObservePayload, sendResponse);
        return true;
      }
      case "READ_TEXT": {
        const target = message.payload["target"];
        const maxChars = message.payload["maxChars"];
        const text = readRegionText(
          typeof target === "string" ? target : undefined,
          typeof maxChars === "number" ? maxChars : 4000,
        );
        sendResponse({ ok: true, payload: { ok: true, text } });
        return false;
      }
      case "REQUEST_SNAPSHOT": {
        // On-demand current-page pull: the worker asks for a FRESH extraction
        // instead of trusting storage. Covers the "already-open page" case —
        // a new voice command must reason over the CURRENT tab even when no
        // recent push happened (SPA minor-swallow, worker restart, eviction).
        // Responds directly (no storage race) AND pushes for future turns.
        try {
          const state = lens.extract(document);
          const snapshot = {
            url: state.url,
            title: state.title,
            generation: state.generation,
            items: lens.registry.snapshot(),
            structure: state.structure,
            prose: state.prose,
            skipped: state.skipped,
            savedAt: Date.now(),
          };
          pushSnapshot();
          sendResponse({ ok: true, payload: { state: snapshot } });
        } catch {
          sendResponse({ ok: false, errorCode: "ACTION_FAILED" });
        }
        return false;
      }
      case "AGENT_ACTIVE": {
        agentActive = message.payload["active"] === true;
        sendResponse({ ok: true, agentActive });
        return false;
      }
      default:
        sendResponse({ ok: true, phase: 5, url: location.href });
        return false;
    }
  },
);

export { pendingAnnouncements };
