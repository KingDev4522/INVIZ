/**
 * INVIZ on-screen voice overlay (PRD 6 UX: every-moment turn narration).
 * A non-interactive floating pill (Shadow DOM, pointer-events:none) with a
 * thinking-orbs canvas orb + status headline + detail line + mic meter.
 * Driven by VOICE_STATUS (worker → tab) and CAPTURE_LEVEL (5Hz mic feed).
 *
 * Degrades gracefully: no canvas 2D context (or reduced motion) still shows
 * text state; any failure hides silently and never breaks the host page.
 */

import {
  MODE_DRAWS,
  STATE_TO_MODE,
  resolvePreset,
  type OrbState,
} from "thinking-orbs/engine";
import type { VoicePhase } from "../../../shared/voice-status.js";

export type { VoicePhase };

/** Constructor options for the overlay (test seam for the Stop control). */
export interface VoiceOverlayOptions {
  /**
   * Invoked when the user presses the overlay Stop control. Defaults to
   * posting silent CANCEL_TASK + TTS_STOP + VOICE_CAPTURE_STOP.
   */
  onStop?: () => void;
}

interface PhaseLook {
  orb: OrbState;
  headline: string;
}

const PHASE_LOOK: Record<VoicePhase, PhaseLook> = {
  listening: { orb: "listening", headline: "Listening… speak now" },
  transcribing: { orb: "connecting", headline: "Heard you — transcribing…" },
  transcript: { orb: "connecting", headline: "Heard you — transcribing…" },
  thinking: { orb: "solving", headline: "Thinking…" },
  awaiting: { orb: "breathing", headline: "Waiting for you…" },
  speaking: { orb: "composing", headline: "Speaking…" },
  done: { orb: "breathing", headline: "Done" },
  error: { orb: "breathing", headline: "Something went wrong" },
  busy: { orb: "listening", headline: "Already listening…" },
};

/** Orb canvas size (CSS px): the engine's tuned chat-avatar preset. */
const ORB_SIZE = 64;
/** Hide delay after a terminal phase; absolute cap so a lost turn can't linger. */
const HIDE_AFTER_DONE_MS = 5000;
const ABSOLUTE_CAP_MS = 90000;

function prefersReducedMotion(win: Window): boolean {
  try {
    return (
      typeof win.matchMedia === "function" &&
      win.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

export class VoiceOverlay {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private headlineEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private levelFill: HTMLElement | null = null;
  private levelWrap: HTMLElement | null = null;
  private stopEl: HTMLElement | null = null;
  private confirmEl: HTMLElement | null = null;

  private phase: VoicePhase | null = null;
  /** Last custom headline shown (worker thinking text). Restored when a
   *  cancel-confirm "No" resumes the turn, so live thinking is never
   *  downgraded back to the generic phase headline. Null = default look. */
  private lastHeadline: string | null = null;
  private rafId = 0;
  private t0 = 0;
  private currentOrb: OrbState = "breathing";
  private hideTimer = 0;
  private capTimer = 0;
  private readonly doc: Document;
  private readonly win: Window;
  private readonly onStop: () => void;

  constructor(doc: Document = document, opts: VoiceOverlayOptions = {}) {
    this.doc = doc;
    this.win = doc.defaultView ?? window;
    this.onStop =
      opts.onStop ??
      (() => {
        // Explicit UI stop: cancel the task SILENTLY (no "Task cancelled"
        // narration), clear all speech, and halt any in-flight capture.
        // All three are existing keyless worker/offscreen paths.
        try {
          const rt = (globalThis as { chrome?: { runtime?: { sendMessage?: (m: unknown) => void } } }).chrome?.runtime;
          const send = rt?.sendMessage;
          if (typeof send !== "function") return;
          send({
            type: "CANCEL_TASK",
            requestId: `stop_${Date.now()}`,
            payload: { silent: true },
          });
          send({
            type: "TTS_STOP",
            requestId: `stop_${Date.now()}_tts`,
            payload: { all: true, target: "offscreen" },
          });
          send({
            type: "VOICE_CAPTURE_STOP",
            requestId: `stop_${Date.now()}_cap`,
            payload: { target: "offscreen" },
          });
        } catch {
          // Overlay must never break the page.
        }
      });
  }

  /** Current phase (null when hidden). Test introspection. */
  currentPhase(): VoicePhase | null {
    return this.phase;
  }

  /** Headline text currently shown. Test introspection. */
  currentHeadline(): string {
    return this.headlineEl?.textContent ?? "";
  }

  /** Detail text currently shown. Test introspection. */
  currentDetail(): string {
    return this.detailEl?.textContent ?? "";
  }

  /** Whether the Stop control is currently shown. Test introspection. */
  stopControlVisible(): boolean {
    return this.stopEl !== null && this.stopEl.style.display !== "none";
  }

  /** Whether the cancel-confirm prompt is showing. Test introspection. */
  confirmVisible(): boolean {
    return this.confirmEl !== null && this.confirmEl.style.display !== "none";
  }

  /**
   * Requests cancellation (Stop hover or click path — both converge here).
   * Shows an inline "Cancel this turn? Yes / No" prompt instead of acting
   * immediately, so a stray cursor pass can never kill a turn unasked.
   */
  requestStop(): void {
    try {
      this.ensureHost();
      if (this.host === null || this.confirmEl === null || this.headlineEl === null) return;
      if (this.confirmEl.style.display !== "none") return; // already asking
      this.confirmEl.style.display = "flex";
      if (this.stopEl !== null) this.stopEl.style.display = "none";
      this.headlineEl.textContent = "Cancel this turn?";
    } catch {
      // Overlay must never break the page.
    }
  }

  /** Confirm-choice handler (Yes executes the stop, No resumes display). */
  private resolveStop(confirm: boolean): void {
    try {
      if (this.confirmEl !== null) this.confirmEl.style.display = "none";
      if (this.stopEl !== null) this.stopEl.style.display = "";
      if (confirm) {
        // Instant feedback FIRST: the pill vanishes the moment Yes is
        // pressed, so cancellation never looks laggy even while the worker
        // fans the stop out to capture/TTS/task. Then fire the real stop.
        this.hide();
        this.onStop();
      } else if (this.phase !== null && this.headlineEl !== null) {
        // Resume whatever the turn was showing (restore the live headline
        // when one was set, so the confirm question does not linger and
        // thinking text is not downgraded to the generic phase headline).
        const look = PHASE_LOOK[this.phase];
        this.headlineEl.textContent = this.lastHeadline ?? look.headline;
      }
    } catch {
      // Overlay must never break the page.
    }
  }

  /** Activates the Stop control (same path as a pointer click). Test + a11y. */
  pressStop(): void {
    try {
      this.requestStop();
    } catch {
      // Overlay must never break the page.
    }
  }

  /** Test seam: answer the confirm prompt directly. */
  pressConfirm(confirm: boolean): void {
    try {
      this.resolveStop(confirm);
    } catch {
      // Overlay must never break the page.
    }
  }

  /**
   * Worker-driven status update. Agent thinking ("Reasoning… (step 3)",
   * "Searching the web…") is the turn's HEADLINE — prominent — while
   * transcripts and questions stay detail text under their phase headline.
   */
  showStatus(phase: VoicePhase, text?: string): void {
    const clean = typeof text === "string" ? text : "";
    if (phase === "thinking" && clean !== "") {
      this.show(phase, { headline: clean });
    } else {
      this.show(phase, { ...(clean !== "" ? { detail: clean } : {}) });
    }
  }

  show(phase: VoicePhase, opts: { headline?: string; detail?: string } = {}): void {
    try {
      this.ensureHost();
      if (this.host === null || this.root === null) return;
      this.phase = phase;
      this.lastHeadline = opts.headline ?? null;
      const look = PHASE_LOOK[phase];
      this.currentOrb = look.orb;
      if (this.headlineEl !== null) {
        this.headlineEl.textContent = opts.headline ?? look.headline;
      }
      if (this.detailEl !== null) {
        const detail = opts.detail ?? "";
        this.detailEl.textContent = detail;
        this.detailEl.style.display = detail === "" ? "none" : "";
      }
      // Mic meter only means something while capturing.
      if (this.levelWrap !== null) {
        this.levelWrap.style.display = phase === "listening" ? "" : "none";
      }
      this.host.style.display = "";
      this.restartPainter();
      this.win.clearTimeout(this.hideTimer);
      this.hideTimer = 0;
      if (phase === "done" || phase === "error") {
        // Terminal phase settles any pending cancel question with the turn.
        if (this.confirmEl !== null) this.confirmEl.style.display = "none";
        if (this.stopEl !== null) this.stopEl.style.display = "";
        this.hideTimer = this.win.setTimeout(() => this.hide(), HIDE_AFTER_DONE_MS);
      } else if (this.confirmEl !== null && this.confirmEl.style.display !== "none") {
        // Turn activity while the user is deciding must not clobber the
        // cancel question (or silently answer it).
        if (this.headlineEl !== null) this.headlineEl.textContent = "Cancel this turn?";
      } else {
        // Absolute cap: a turn that never settles must not linger forever.
        if (this.capTimer === 0) {
          this.capTimer = this.win.setTimeout(() => this.hide(), ABSOLUTE_CAP_MS);
        }
      }
    } catch {
      // Overlay must never break the page.
    }
  }

  /** Live mic RMS (0..~0.3 speech). Only visible during listening. */
  setLevel(level: number): void {
    try {
      if (this.phase !== "listening" || this.levelFill === null) return;
      const pct = Number.isFinite(level) ? level * 100 : 0;
      const width = Math.max(0, Math.min(100, pct * 5));
      this.levelFill.style.width = `${width.toFixed(0)}%`;
      this.levelFill.style.background = pct >= 2 ? "#4ade80" : "#f59e0b";
    } catch {
      // Advisory only.
    }
  }

  hide(): void {
    try {
      this.phase = null;
      this.lastHeadline = null;
      this.stopPainter();
      this.win.clearTimeout(this.hideTimer);
      this.win.clearTimeout(this.capTimer);
      this.hideTimer = 0;
      this.capTimer = 0;
      if (this.host !== null) this.host.style.display = "none";
    } catch {
      // Never break the page.
    }
  }

  // -- DOM ---------------------------------------------------------------------

  private ensureHost(): void {
    if (this.host !== null && this.root !== null) return;
    const docEl = this.doc.documentElement;
    if (docEl === null) return;
    const host = this.doc.createElement("div");
    host.setAttribute("id", "inviz-voice-overlay");
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    host.setAttribute("aria-label", "INVIZ voice status");
    host.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);" +
      "z-index:2147483647;pointer-events:none;display:none;";
    let root: ShadowRoot;
    try {
      // Closed: page scripts can't snoop on transcript text shown here.
      root = host.attachShadow({ mode: "closed" });
    } catch {
      return;
    }
    const style = this.doc.createElement("style");
    style.textContent =
      ".pill{display:flex;align-items:center;gap:12px;max-width:min(480px,90vw);" +
      "background:rgba(17,17,20,.92);color:#f5f5f5;border:1px solid rgba(255,255,255,.12);" +
      "border-radius:16px;padding:10px 16px 10px 10px;" +
      "font:13px/1.45 system-ui,-apple-system,sans-serif;" +
      "box-shadow:0 8px 32px rgba(0,0,0,.45);backdrop-filter:blur(8px)}" +
      "canvas{width:64px;height:64px;flex:none}" +
      ".txt{min-width:0}.head{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".detail{opacity:.8;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}" +
      ".meter{height:6px;background:rgba(255,255,255,.15);border-radius:3px;margin-top:6px;overflow:hidden}" +
      ".meter>i{display:block;height:100%;width:0%;background:#f59e0b;border-radius:3px;" +
      "transition:width 120ms linear}";
    const pill = this.doc.createElement("div");
    pill.setAttribute("class", "pill");
    const canvas = this.doc.createElement("canvas");
    canvas.setAttribute("width", String(ORB_SIZE * 2));
    canvas.setAttribute("height", String(ORB_SIZE * 2));
    canvas.setAttribute("aria-hidden", "true");
    const txt = this.doc.createElement("div");
    txt.setAttribute("class", "txt");
    const head = this.doc.createElement("div");
    head.setAttribute("class", "head");
    const detail = this.doc.createElement("div");
    detail.setAttribute("class", "detail");
    detail.style.display = "none";
    const meter = this.doc.createElement("div");
    meter.setAttribute("class", "meter");
    const fill = this.doc.createElement("i");
    meter.appendChild(fill);
    txt.append(head, detail, meter);
    // Explicit Stop control (Phase 2): voice cannot reliably cancel speech
    // while INVIZ is speaking, so the pill carries its own X. pointer-events
    // stays none on the host — only this button is clickable, so hover
    // narration and page clicks pass through everywhere else.
    const stop = this.doc.createElement("button");
    stop.setAttribute("type", "button");
    stop.setAttribute("aria-label", "Stop INVIZ voice");
    stop.textContent = "✕";
    stop.style.cssText =
      "pointer-events:auto;flex:none;width:36px;height:36px;border-radius:50%;" +
      "border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);" +
      "color:#f5f5f5;font-size:15px;line-height:1;cursor:pointer;";
    stop.addEventListener("click", (e) => {
      e.stopPropagation();
      this.requestStop();
    });
    // Cursor arrival arms the same confirm prompt as a press: the user asked
    // for hover-to-cancel, but acting on hover alone would let a stray pass
    // kill a turn — the Yes/No question is the safety (and the requirement).
    stop.addEventListener("mouseenter", () => {
      this.requestStop();
    });
    // Inline confirm prompt (hidden until requestStop). Yes/No are real
    // buttons so keyboard/AT users get the same choice.
    const confirm = this.doc.createElement("div");
    confirm.style.cssText = "display:none;align-items:center;gap:8px;pointer-events:auto;";
    const yes = this.doc.createElement("button");
    yes.setAttribute("type", "button");
    yes.textContent = "Yes, stop";
    const no = this.doc.createElement("button");
    no.setAttribute("type", "button");
    no.textContent = "No";
    for (const b of [yes, no]) {
      b.style.cssText =
        "pointer-events:auto;border-radius:8px;border:1px solid rgba(255,255,255,.25);" +
        "background:rgba(255,255,255,.08);color:#f5f5f5;font-size:13px;" +
        "padding:6px 12px;cursor:pointer;";
    }
    yes.addEventListener("click", (e) => {
      e.stopPropagation();
      this.resolveStop(true);
    });
    no.addEventListener("click", (e) => {
      e.stopPropagation();
      this.resolveStop(false);
    });
    confirm.append(yes, no);
    pill.append(canvas, txt, stop, confirm);
    root.append(style, pill);
    docEl.appendChild(host);
    this.host = host;
    this.root = root;
    this.canvas = canvas;
    this.headlineEl = head;
    this.detailEl = detail;
    this.levelFill = fill;
    this.levelWrap = meter;
    this.stopEl = stop;
    this.confirmEl = confirm;
    try {
      this.ctx =
        typeof canvas.getContext === "function"
          ? canvas.getContext("2d")
          : null;
    } catch {
      this.ctx = null;
    }
  }

  // -- Orb painter ---------------------------------------------------------------

  private restartPainter(): void {
    this.stopPainter();
    if (this.ctx === null || this.canvas === null) return; // text-only degradation
    if (prefersReducedMotion(this.win)) {
      this.paintFrame(1.0); // single representative frame, no animation
      return;
    }
    this.t0 = this.win.performance.now();
    const tick = (now: number): void => {
      this.rafId = this.win.requestAnimationFrame(tick);
      try {
        const { speed, opts, mode } = resolvePreset(this.currentOrb, ORB_SIZE);
        const t = ((now - this.t0) / 1000) * speed;
        const ctx = this.ctx;
        const canvas = this.canvas;
        if (ctx === null || canvas === null) return;
        // Backing store is fixed at 2x (capped like the library); the scale
        // maps CSS px → backing px regardless of the monitor's dpr.
        const k = (canvas.width || ORB_SIZE * 2) / ORB_SIZE;
        ctx.save();
        ctx.scale(k, k);
        ctx.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
        // Dark glass pill → light ink.
        MODE_DRAWS[mode](ctx, ORB_SIZE, t, true, opts);
        ctx.restore();
      } catch {
        this.stopPainter(); // a sick painter hides; text state survives
      }
    };
    this.rafId = this.win.requestAnimationFrame(tick);
  }

  private paintFrame(t: number): void {
    try {
      if (this.ctx === null || this.canvas === null) return;
      const { speed, opts, mode } = resolvePreset(this.currentOrb, ORB_SIZE);
      const k = (this.canvas.width || ORB_SIZE * 2) / ORB_SIZE;
      this.ctx.save();
      this.ctx.scale(k, k);
      this.ctx.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
      MODE_DRAWS[mode](this.ctx, ORB_SIZE, t * speed, true, opts);
      this.ctx.restore();
    } catch {
      // Text state survives.
    }
  }

  private stopPainter(): void {
    if (this.rafId !== 0) {
      try {
        this.win.cancelAnimationFrame(this.rafId);
      } catch {
        // Already gone.
      }
      this.rafId = 0;
    }
  }
}
