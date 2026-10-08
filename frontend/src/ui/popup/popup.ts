/**
 * Popup: status + VoiceLens toggle (PRD 6.0 §1.3).
 * Fully keyboard-operable, labeled controls (PRD 1 §20).
 * Missing credentials → explicit setup message, never a dead UI.
 */
import {
  STORAGE_KEY_CONFIG,
  STORAGE_KEY_CREDENTIALS,
} from "../../../../shared/constants.js";

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const toggleEl = document.getElementById("toggle") as HTMLButtonElement;
const captureEl = document.getElementById("capture") as HTMLButtonElement;
const optionsLink = document.getElementById("options-link") as HTMLAnchorElement;

const isHindi = (navigator.language || "en").toLowerCase().startsWith("hi");

const STR = {
  loading: isHindi ? "लोड हो रहा है…" : "Loading…",
  setupNeeded: isHindi
    ? "AI कुंजियाँ सेट नहीं हैं। Options में जाकर कुंजियाँ जोड़ें।"
    : "API keys are not set. Open Options to add your keys.",
  ready: isHindi ? "तैयार। VoiceLens बंद है।" : "Ready. VoiceLens is off.",
  on: isHindi ? "तैयार। VoiceLens चालू है।" : "Ready. VoiceLens is on.",
  enable: isHindi ? "VoiceLens चालू करें" : "Enable VoiceLens",
  disable: isHindi ? "VoiceLens बंद करें" : "Disable VoiceLens",
  capture: isHindi ? "आवाज़ से कमांड दें" : "Start voice capture",
  capturing: isHindi ? "सुन रहा हूँ…" : "Listening…",
  captureFailed: isHindi
    ? "आवाज़ रिकॉर्ड नहीं हो पाई। पुनः प्रयास करें।"
    : "Voice capture failed. Please try again.",
};

/**
 * Runs one voice turn. The worker owns the whole flow (tab resolution,
 * offscreen capture, transcription, agent routing); the popup only reports
 * the outcome, so the button behaves identically to the keyboard shortcut.
 */
async function startVoiceCapture(): Promise<void> {
  captureEl.disabled = true;
  captureEl.textContent = STR.capturing;
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
    captureEl.textContent = STR.capture;
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
  const [credsOk, cfg] = await Promise.all([
    credentialsPresent(),
    chrome.storage.local.get(STORAGE_KEY_CONFIG),
  ]);
  const enabled =
    ((cfg[STORAGE_KEY_CONFIG] as { voicelensEnabled?: boolean } | undefined)
      ?.voicelensEnabled) === true;
  if (!credsOk) {
    statusEl.textContent = STR.setupNeeded;
  } else {
    statusEl.textContent = enabled ? STR.on : STR.ready;
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
        statusEl.textContent += isHindi
          ? " इस पेज तक पहुँच नहीं है।"
          : " This page can't be accessed.";
      }
    }
  } catch {
    // tabs permission edge: status without support line is still truthful.
  }
  toggleEl.textContent = enabled ? STR.disable : STR.enable;
  captureEl.textContent = STR.capture;
  // Voice capture needs the backend; without it the turn cannot transcribe.
  captureEl.disabled = false;
}

captureEl.addEventListener("click", () => {
  void startVoiceCapture();
});

toggleEl.addEventListener("click", () => {
  void (async () => {
    const cfg = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
    const current =
      ((cfg[STORAGE_KEY_CONFIG] as { voicelensEnabled?: boolean } | undefined)
        ?.voicelensEnabled) === true;
    await chrome.storage.local.set({
      [STORAGE_KEY_CONFIG]: { voicelensEnabled: !current },
    });
    await render();
  })();
});

optionsLink.addEventListener("click", (e: Event) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void render();
