/**
 * Popup: status + VoiceLens toggle (PRD 6.0 §1.3).
 * Fully keyboard-operable, labeled controls (PRD 1 §20).
 * Missing credentials → explicit setup message, never a dead UI.
 *
 * The three modes are switches, not Enable/Disable buttons: state is always
 * visible, so a row never has to be read twice to know whether it is on.
 */
import {
  STORAGE_KEY_CONFIG,
  STORAGE_KEY_CREDENTIALS,
} from "../../../../shared/constants.js";

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const chipEl = document.getElementById("state-chip") as HTMLSpanElement;
const stateEl = document.getElementById("state") as HTMLSpanElement;
const captureEl = document.getElementById("capture") as HTMLButtonElement;
const captureLabelEl = document.getElementById("capture-label") as HTMLSpanElement;
const captureKeysEl = document.getElementById("capture-keys") as HTMLElement;
const toggleEl = document.getElementById("toggle") as HTMLButtonElement;
const powerEl = document.getElementById("power") as HTMLButtonElement;
const harnessEl = document.getElementById("harness") as HTMLButtonElement;
const optionsLink = document.getElementById("options-link") as HTMLAnchorElement;

const isHindi = (navigator.language || "en").toLowerCase().startsWith("hi");
const isApple = /\b(mac|iphone|ipad|ipod)\b/i.test(navigator.platform || "");

interface OperatorFlags {
  voicelensEnabled?: boolean;
  /** Trusted-operator mode: WebGuard safety gates bypassed (correctness BLOCKs stay). */
  powerMode?: boolean;
  /** Route execution through the external browser-harness host (safe local fallback). */
  harnessEnabled?: boolean;
}

async function readFlags(): Promise<OperatorFlags> {
  try {
    const cfg = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
    return ((cfg[STORAGE_KEY_CONFIG] as OperatorFlags | undefined) ?? {});
  } catch {
    return {};
  }
}

async function writeFlags(patch: Partial<OperatorFlags>): Promise<void> {
  const current = await readFlags();
  await chrome.storage.local.set({
    [STORAGE_KEY_CONFIG]: { ...current, ...patch },
  });
}

const KEYS = {
  capture: isApple ? "⌘⇧V" : "Ctrl+Shift+V",
  toggle: isApple ? "⌘⇧Y" : "Ctrl+Shift+Y",
};
captureKeysEl.textContent = KEYS.capture;
(document.getElementById("toggle-keys") as HTMLElement).textContent =
  `${KEYS.toggle} toggles VoiceLens`;

const STR = {
  stateLoading: isHindi ? "लोड हो रहा है" : "Loading",
  stateReady: isHindi ? "तैयार" : "Ready",
  stateSetup: isHindi ? "सेटअप ज़रूरी" : "Setup needed",
  stateListening: isHindi ? "सुन रहा हूँ" : "Listening",
  loading: isHindi ? "लोड हो रहा है…" : "Loading…",
  setupNeeded: isHindi
    ? "AI कुंजियाँ सेट नहीं हैं। Options में जाकर कुंजियाँ जोड़ें।"
    : "API keys are not set. Open Options to add your keys.",
  ready: isHindi ? "VoiceLens बंद है।" : "VoiceLens is off.",
  on: isHindi ? "VoiceLens चालू है।" : "VoiceLens is on.",
  capture: isHindi ? "आवाज़ से कमांड दें" : "Start voice capture",
  capturing: isHindi ? "सुन रहा हूँ…" : "Listening…",
  captureFailed: isHindi
    ? "आवाज़ रिकॉर्ड नहीं हो पाई। पुनः प्रयास करें।"
    : "Voice capture failed. Please try again.",
  powerOn: isHindi
    ? " पावर मोड चालू: पुष्टि नहीं माँगी जाएगी।"
    : " Power mode on: no confirmations will be asked.",
  tabBlocked: isHindi
    ? " इस पेज तक पहुँच नहीं है।"
    : " This page can't be accessed.",
  voicelensLabel: "VoiceLens",
  voicelensNote: isHindi
    ? "सक्रिय टैब पर आवाज़ से काम करें।"
    : "Run voice commands on the active tab.",
  powerLabel: isHindi ? "पावर मोड" : "Power mode",
  powerNote: isHindi
    ? "कार्रवाई से पहले पुष्टि नहीं माँगी जाएगी।"
    : "Skip confirmation prompts before actions.",
  harnessLabel: isHindi ? "हार्नेस एक्सेक" : "Harness exec",
  harnessNote: isHindi
    ? "लोकल ब्राउज़र हैनेस में कार्रवाई चलाएँ।"
    : "Run actions in the local browser harness.",
};

(document.getElementById("toggle-label") as HTMLElement).textContent =
  STR.voicelensLabel;
(document.getElementById("toggle-note") as HTMLElement).textContent =
  STR.voicelensNote;
(document.getElementById("power-label") as HTMLElement).textContent =
  STR.powerLabel;
(document.getElementById("power-note") as HTMLElement).textContent =
  STR.powerNote;
(document.getElementById("harness-label") as HTMLElement).textContent =
  STR.harnessLabel;
(document.getElementById("harness-note") as HTMLElement).textContent =
  STR.harnessNote;

type Tone = "loading" | "ready" | "live" | "setup";

let tone: Tone = "loading";
let toneText = STR.stateLoading;

function setChip(next: Tone, text: string): void {
  tone = next;
  toneText = text;
  chipEl.dataset.tone = next;
  stateEl.textContent = text;
}

/**
 * Runs one voice turn. The worker owns the whole flow (tab resolution,
 * offscreen capture, transcription, agent routing); the popup only reports the
 * outcome, so the button behaves identically to the keyboard shortcut.
 */
async function startVoiceCapture(): Promise<void> {
  captureEl.disabled = true;
  captureEl.dataset.state = "listening";
  captureLabelEl.textContent = STR.capturing;
  captureKeysEl.hidden = true;
  setChip("live", STR.stateListening);
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "START_VOICE_TURN",
      requestId: `req_${Date.now()}`,
      payload: {},
    })) as { ok?: boolean } | undefined;
    if (res?.ok !== true) {
      statusEl.textContent = STR.captureFailed;
    }
  } catch {
    statusEl.textContent = STR.captureFailed;
  } finally {
    captureEl.disabled = false;
    captureEl.dataset.state = "idle";
    captureLabelEl.textContent = STR.capture;
    captureKeysEl.hidden = false;
    setChip(tone, toneText);
  }
}

interface BackendCreds {
  backendUrl?: string;
  backendToken?: string;
}

/** Backend reachability config present (provider keys live server-side only). */
async function credentialsPresent(): Promise<boolean> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_CREDENTIALS);
  const creds = stored[STORAGE_KEY_CREDENTIALS] as BackendCreds | undefined;
  return Boolean(
    typeof creds?.backendUrl === "string" && creds.backendUrl !== "",
  );
}

async function render(): Promise<void> {
  statusEl.textContent = STR.loading;
  setChip("loading", STR.stateLoading);
  const [credsOk, flags] = await Promise.all([credentialsPresent(), readFlags()]);
  const enabled = flags.voicelensEnabled === true;
  const power = flags.powerMode === true;
  const harness = flags.harnessEnabled === true;
  if (!credsOk) {
    statusEl.textContent = STR.setupNeeded;
    setChip("setup", STR.stateSetup);
  } else {
    statusEl.textContent = enabled ? STR.on : STR.ready;
    setChip("ready", STR.stateReady);
  }
  // Per-tab page support (PRD 6.1 §1.5): honest "can't access" surfacing.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) {
      const support = await chrome.storage.session.get("support:tabs");
      const flag = (support["support:tabs"] as Record<string, string> | undefined)?.[
        String(tab.id)
      ];
      if (flag !== undefined && flag.startsWith("unsupported")) {
        statusEl.textContent += STR.tabBlocked;
      }
    }
  } catch {
    // tabs permission edge: status without support line is still truthful.
  }
  toggleEl.setAttribute("aria-checked", String(enabled));
  powerEl.setAttribute("aria-checked", String(power));
  harnessEl.setAttribute("aria-checked", String(harness));
  if (power && !statusEl.textContent.includes(STR.powerLabel)) {
    statusEl.textContent += STR.powerOn;
  }
  captureLabelEl.textContent = STR.capture;
  // Voice capture needs the backend; without it the turn cannot transcribe.
  captureEl.disabled = false;
}

captureEl.addEventListener("click", () => {
  void startVoiceCapture();
});

toggleEl.addEventListener("click", () => {
  void (async () => {
    const current = await readFlags();
    await writeFlags({ voicelensEnabled: current.voicelensEnabled !== true });
    await render();
  })();
});

powerEl.addEventListener("click", () => {
  void (async () => {
    const current = await readFlags();
    await writeFlags({ powerMode: current.powerMode !== true });
    await render();
  })();
});

harnessEl.addEventListener("click", () => {
  void (async () => {
    const current = await readFlags();
    await writeFlags({ harnessEnabled: current.harnessEnabled !== true });
    await render();
  })();
});

optionsLink.addEventListener("click", (e: Event) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void render();