/**
 * Options page: backend connection setup + LIVE validation.
 * The extension holds NO provider keys. It stores only the backend URL and an
 * optional backend token (both non-secret routing info, user-owned device).
 * Validation calls the backend's own /v1/health + /v1/validation contracts.
 * Provider keys live exclusively in the backend .env (never here, never logged).
 */
import { STORAGE_KEY_CREDENTIALS, STORAGE_KEY_PROFILE } from "../../../../shared/constants.js";
import { sanitizeProfile, type UserProfile } from "../../../../shared/profile.js";
import { ENDPOINTS, type ValidationResponse } from "../../../../shared/api.js";
import {
  DIAG_KEY,
  formatDiagEntry,
  type DiagEntry,
} from "../../../../shared/diag.js";
import { transcribeAudio } from "../../ai/whisper-client.js";

const backendUrlEl = document.getElementById("backend-url") as HTMLInputElement;
const backendTokenEl = document.getElementById("backend-token") as HTMLInputElement;
const backendResult = document.getElementById("backend-result") as HTMLSpanElement;
const saveResult = document.getElementById("save-result") as HTMLSpanElement;
const micResult = document.getElementById("mic-result") as HTMLSpanElement;
const diagResultEl = document.getElementById("diag-result") as HTMLPreElement;
const diagLogEl = document.getElementById("diag-log") as HTMLPreElement;
const profileNameEl = document.getElementById("profile-name") as HTMLInputElement;
const profileEmailEl = document.getElementById("profile-email") as HTMLInputElement;
const profilePhoneEl = document.getElementById("profile-phone") as HTMLInputElement;
const profileAddressEl = document.getElementById("profile-address") as HTMLInputElement;
const profileResult = document.getElementById("profile-result") as HTMLSpanElement;

/** Renders the on-device voice activity ring (newest first). */
async function loadDiagLog(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(DIAG_KEY);
    const raw = stored[DIAG_KEY];
    const log: DiagEntry[] = Array.isArray(raw) ? (raw as DiagEntry[]) : [];
    diagLogEl.textContent =
      log.length === 0
        ? "No voice turns recorded yet — press Ctrl+Shift+V on any tab, then Refresh."
        : [...log].reverse().map(formatDiagEntry).join("\n");
  } catch {
    diagLogEl.textContent = "Could not read the activity log.";
  }
}

async function clearDiagLog(): Promise<void> {
  try {
    await chrome.storage.local.remove(DIAG_KEY);
  } catch {
    // Already gone.
  }
  await loadDiagLog();
}

export interface SavedCredentials {
  backendUrl?: string;
  backendToken?: string;
}

function readBackend(): { url: string; token: string } {
  return {
    url: backendUrlEl.value.trim().replace(/\/+$/, ""),
    token: backendTokenEl.value.trim(),
  };
}

function authHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== "") headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function loadSaved(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_CREDENTIALS);
  const creds = stored[STORAGE_KEY_CREDENTIALS] as SavedCredentials | undefined;
  // Presence shown, values never re-rendered into the page.
  backendResult.textContent =
    typeof creds?.backendUrl === "string" && creds.backendUrl !== ""
      ? `Backend configured: ${creds.backendUrl}`
      : "No backend configured yet.";
  if (
    typeof creds?.backendUrl === "string" &&
    backendUrlEl.value.trim() === ""
  ) {
    backendUrlEl.value = creds.backendUrl;
  }
}

/** Live validation: backend health + provider smoke checks (server-side). */
async function onValidateBackend(): Promise<void> {
  const { url, token } = readBackend();
  if (url === "") {
    backendResult.textContent = "Enter the backend URL first (default http://127.0.0.1:8787).";
    return;
  }
  backendResult.textContent = "Contacting backend…";
  try {
    const healthRes = await fetch(`${url}${ENDPOINTS.health}`);
    if (!healthRes.ok) {
      backendResult.textContent = `Backend unreachable (HTTP ${healthRes.status}). Is it running?`;
      return;
    }
    const health = (await healthRes.json()) as {
      groqKeysConfigured?: number;
    };
    const validationRes = await fetch(`${url}${ENDPOINTS.validation}`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({}),
    });
    if (validationRes.status === 401) {
      backendResult.textContent =
        "Backend requires a token — paste it above (must match BACKEND_TOKEN).";
      return;
    }
    if (!validationRes.ok) {
      backendResult.textContent = `Validation failed (HTTP ${validationRes.status}).`;
      return;
    }
    const validation = (await validationRes.json()) as ValidationResponse;
    // Persist the validated URL/token immediately — validation without saving
    // left the extension speaking "backend not configured" forever.
    const storedNow = await chrome.storage.local.get(STORAGE_KEY_CREDENTIALS);
    const prevNow = (storedNow[STORAGE_KEY_CREDENTIALS] as SavedCredentials | undefined) ?? {};
    const nextNow: SavedCredentials = { backendUrl: url };
    if (token !== "") nextNow.backendToken = token;
    else if (prevNow.backendToken !== undefined) nextNow.backendToken = prevNow.backendToken;
    await chrome.storage.local.set({ [STORAGE_KEY_CREDENTIALS]: nextNow });
    // Clear any stale backend-TTS latch now that the backend answers again.
    void chrome.runtime
      .sendMessage({
        type: "TTS_PRIMARY_RESET",
        requestId: `req_${Date.now()}`,
        payload: { target: "offscreen" },
      })
      .catch(() => undefined);
    const groq = validation.groq.ok
      ? "Groq OK"
      : `Groq FAIL: ${validation.groq.detail}`;
    const tts = validation.tts.ok
      ? "Speech OK"
      : `Speech FAIL: ${validation.tts.detail}`;
    const openrouter =
      validation.openrouter === undefined || validation.openrouter.ok
        ? validation.openrouter === undefined
          ? "OpenRouter n/a"
          : "OpenRouter OK"
        : `OpenRouter FAIL: ${validation.openrouter.detail}`;
    const tavily = validation.tavily.ok
      ? "Search OK"
      : `Search FAIL: ${validation.tavily.detail}`;
    backendResult.textContent =
      `Backend OK (Groq keys: ${health.groqKeysConfigured ?? "?"}). ${groq} | ${tts} | ${openrouter} | ${tavily}`;
  } catch {
    backendResult.textContent =
      "Network error — is the backend running at that URL?";
  }
}

async function onSave(): Promise<void> {
  const { url, token } = readBackend();
  if (url === "") {
    saveResult.textContent = "Nothing to save.";
    return;
  }
  const stored = await chrome.storage.local.get(STORAGE_KEY_CREDENTIALS);
  const prev = (stored[STORAGE_KEY_CREDENTIALS] as SavedCredentials | undefined) ?? {};
  const next: SavedCredentials = { backendUrl: url };
  if (token !== "") next.backendToken = token;
  else if (prev.backendToken !== undefined) next.backendToken = prev.backendToken;
  await chrome.storage.local.set({ [STORAGE_KEY_CREDENTIALS]: next });
  backendTokenEl.value = "";
  saveResult.textContent = "Saved on this machine. Token field cleared.";
  await loadSaved();
}

/** First-run mic grant (PRD 6 §4.2): explicit user gesture in this document.
 * The grant is extension-level (chrome-extension origin): one grant covers
 * voice capture on every tab via the offscreen USER_MEDIA document. */
async function onEnableMic(): Promise<void> {
  micResult.textContent = "Requesting microphone permission…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    micResult.textContent = "Microphone granted for the extension (works on all tabs). Speak with Ctrl+Shift+V.";
  } catch {
    micResult.textContent =
      "Microphone denied. Allow it in the browser site settings for this extension, then try again.";
  }
}

/** 3-second self-test: proves the mic delivers real audio levels in-extension. */
async function onTestMic(): Promise<void> {
  micResult.textContent = "Listening for 3 seconds — speak now…";
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    context = new AudioContext();
    await context.resume().catch(() => undefined);
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const v = samples[i] ?? 0;
        sum += v * v;
      }
      const level = Math.sqrt(sum / samples.length);
      if (level > peak) peak = level;
      await new Promise((r) => setTimeout(r, 100));
    }
    const pct = (peak * 100).toFixed(1);
    const device = track?.label !== undefined && track.label !== "" ? track.label : "(unlabeled device)";
    if (peak >= 0.02) {
      micResult.textContent = `Heard you (peak ${pct}%) on "${device}". Voice capture should work.`;
    } else {
      micResult.textContent =
        `Silent (peak ${pct}%) on "${device}". Check Windows sound settings: default input device, mute, and that no other app holds the mic exclusively.`;
    }
  } catch {
    micResult.textContent =
      "Microphone denied or unavailable. Click Enable microphone first.";
  } finally {
    try {
      stream?.getTracks().forEach((t) => t.stop());
    } catch {
      // Already stopped.
    }
    stream = null;
    try {
      await context?.close();
    } catch {
      // Already closed.
    }
    context = null;
  }
}

/** Ensures the offscreen audio document exists before DIAG_CAPTURE.
 * The voice path creates it via the worker (ensureOffscreenReady), but this
 * page used to send DIAG_CAPTURE directly — first run after a reload always
 * got "no answer". Same document URL and reasons as production wiring. */
async function ensureOffscreenFromOptions(timeoutMs = 3000): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (contexts.length === 0) {
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
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = (await chrome.runtime
      .sendMessage({
        type: "GATE_OPEN",
        requestId: `ping_${Date.now()}`,
        payload: {},
      })
      .catch(() => undefined)) as { speaking?: unknown } | undefined;
    if (res !== undefined && typeof res.speaking === "boolean") return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Layer-by-layer voice check with plain-word results (no DevTools needed).
 * 1: offscreen capture = the exact mic path Ctrl+Shift+V uses (speak!).
 * 2: backend reachable from this extension origin.
 * 3: this page's mic level (comparison baseline).
 * 4: live transcription of the step-3 clip through the real client. */
async function onRunDiagnostics(): Promise<void> {
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
    diagResultEl.textContent = lines.join("\n");
  };
  const pct = (rms: number): string =>
    Number.isFinite(rms) ? `${(rms * 100).toFixed(1)}%` : "?";
  say("Voice diagnostics running — speak during steps 1 and 3.");

  // 1/4 — offscreen capture (the real voice path, no side effects).
  say("1/4 offscreen capture (speak now, up to 10s)…");
  let offscreenOk = false;
  try {
    const ready = await ensureOffscreenFromOptions();
    if (!ready) {
      say("1/4 FAIL: offscreen document did not become ready — reload the extension at chrome://extensions.");
    } else {
      const res = (await chrome.runtime.sendMessage({
        type: "DIAG_CAPTURE",
        requestId: `diag_${Date.now()}`,
        payload: { target: "offscreen" },
      })) as
        | {
            ok: boolean;
            detail?: unknown;
            stats?: {
              peakRms?: unknown;
              effectiveMs?: unknown;
              ended?: unknown;
              micMode?: unknown;
            } | null;
          }
        | undefined;
      if (res === undefined) {
        say("1/4 FAIL: offscreen gave no answer — reload the extension at chrome://extensions.");
      } else if (res.ok) {
        const peak = typeof res.stats?.peakRms === "number" ? res.stats.peakRms : NaN;
        say(
          `1/4 PASS: offscreen mic heard you (mode=${String(res.stats?.micMode ?? "?")}, peak=${pct(peak)}, effective=${String(res.stats?.effectiveMs ?? "?")}ms, ended=${String(res.stats?.ended ?? "?")}).`,
        );
        offscreenOk = true;
      } else {
        const peak = typeof res.stats?.peakRms === "number" ? res.stats.peakRms : NaN;
        const statsBit =
          res.stats === null || res.stats === undefined
            ? "no audio stats at all — the mic never opened"
            : `peak=${pct(peak)}, mode=${String(res.stats?.micMode ?? "?")}`;
        say(`1/4 FAIL: offscreen capture error: ${String(res.detail ?? "unknown")} (${statsBit}).`);
      }
    }
  } catch (err) {
    say(`1/4 FAIL: message send failed (${err instanceof Error ? err.message : "unknown"}).`);
  }

  // 2/4 — backend reachable from this extension origin.
  const { url, token } = readBackend();
  say("2/4 backend reachability…");
  let backendOk = false;
  if (url === "") {
    say("2/4 FAIL: no backend URL in the box above.");
  } else {
    try {
      const res = await fetch(`${url}${ENDPOINTS.health}`);
      if (!res.ok) {
        say(`2/4 FAIL: backend answered HTTP ${res.status}.`);
      } else {
        const health = (await res.json()) as {
          groqKeysConfigured?: number;
        };
        say(
          `2/4 PASS: backend answers (Groq keys: ${health.groqKeysConfigured ?? "?"}).`,
        );
        backendOk = true;
      }
    } catch (err) {
      say(
        `2/4 FAIL: backend unreachable from the extension (${err instanceof Error ? err.message : "network error"}). Is it running at that URL?`,
      );
    }
  }

  // 3/4 — this page's mic level + a real recorded clip.
  say("3/4 this page's mic (speak now, 2.5s)…");
  let clip: Blob | null = null;
  let pagePeak = 0;
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const context = new AudioContext();
    await context.resume().catch(() => undefined);
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start(250);
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const v = samples[i] ?? 0;
        sum += v * v;
      }
      const level = Math.sqrt(sum / samples.length);
      if (level > pagePeak) pagePeak = level;
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      // Already stopped.
    }
    await stopped;
    clip = new Blob(chunks, { type: recorder.mimeType !== "" ? recorder.mimeType : "audio/webm" });
    say(
      clip.size > 0 && pagePeak >= 0.02
        ? `3/4 PASS: heard you here too (peak=${pct(pagePeak)}, ${clip.size} bytes recorded).`
        : `3/4 FAIL: silent on this page as well (peak=${pct(pagePeak)}). Check Windows sound settings: default input, mute, exclusive-mode apps.`,
    );
    await context.close().catch(() => undefined);
  } catch {
    say("3/4 FAIL: mic denied or unavailable on this page — click Enable microphone first.");
  } finally {
    try {
      stream?.getTracks().forEach((t) => t.stop());
    } catch {
      // Already stopped.
    }
    stream = null;
  }

  // 4/4 — live transcription of the step-3 clip through the real client.
  say("4/4 live transcription of that clip…");
  let transcribed = false;
  if (clip === null || clip.size === 0) {
    say("4/4 SKIP: no clip recorded in step 3.");
  } else if (url === "") {
    say("4/4 SKIP: no backend URL.");
  } else {
    try {
      const result = await transcribeAudio(
        clip,
        token !== "" ? { backend: { url, token } } : { backend: { url } },
      );
      say(`4/4 PASS: Whisper heard "${result.text}".`);
      transcribed = true;
    } catch (err) {
      say(`4/4 FAIL: ${err instanceof Error ? err.message : "transcription failed"}.`);
    }
  }

  say(
    offscreenOk && backendOk && transcribed
      ? "Verdict: every layer works — retry Ctrl+Shift+V on a normal tab."
      : "Verdict: fix the FAILED step above; the other layers are proven by the PASS lines.",
  );
}

/**
 * My details: ordinary contact info for form fill. Values are sanitized
 * through the shared allowlist (name/email/phone/address only — secrets
 * unrepresentable) and stored device-local. Presence is shown; the email
 * box is refilled for convenience, never the other fields. Nothing logged.
 */
function readProfileForm(): UserProfile {
  return sanitizeProfile({
    name: profileNameEl.value,
    email: profileEmailEl.value,
    phone: profilePhoneEl.value,
    address: profileAddressEl.value,
  });
}

async function loadProfile(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_PROFILE);
    const profile = sanitizeProfile(stored[STORAGE_KEY_PROFILE]);
    if (profile.email !== undefined) profileEmailEl.value = profile.email;
    const count = Object.keys(profile).length;
    profileResult.textContent =
      count === 0
        ? "No details saved yet."
        : `Saved: ${Object.keys(profile).join(", ")}.`;
  } catch {
    profileResult.textContent = "Could not read saved details.";
  }
}

async function onSaveProfile(): Promise<void> {
  const profile = readProfileForm();
  if (Object.keys(profile).length === 0) {
    profileResult.textContent = "Nothing to save — fill at least one field.";
    return;
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_PROFILE]: profile });
    profileNameEl.value = "";
    profilePhoneEl.value = "";
    profileAddressEl.value = "";
    profileResult.textContent = `Saved on this machine: ${Object.keys(profile).join(", ")}.`;
  } catch {
    profileResult.textContent = "Could not save details.";
  }
}

async function onClearProfile(): Promise<void> {
  try {
    await chrome.storage.local.remove(STORAGE_KEY_PROFILE);
  } catch {
    // Already gone.
  }
  profileNameEl.value = "";
  profileEmailEl.value = "";
  profilePhoneEl.value = "";
  profileAddressEl.value = "";
  profileResult.textContent = "Details cleared from this machine.";
}

async function refreshMicStatus(): Promise<void> {
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (status.state === "granted") {
      micResult.textContent = "Microphone granted for this extension.";
    }
  } catch {
    // Permissions API unavailable: leave the button as the path.
  }
}

document
  .getElementById("validate-backend")
  ?.addEventListener("click", () => void onValidateBackend());
document
  .getElementById("save")
  ?.addEventListener("click", () => void onSave());
document
  .getElementById("enable-mic")
  ?.addEventListener("click", () => void onEnableMic());
document
  .getElementById("test-mic")
  ?.addEventListener("click", () => void onTestMic());
document
  .getElementById("run-diag")
  ?.addEventListener("click", () => void onRunDiagnostics());
document
  .getElementById("refresh-diag")
  ?.addEventListener("click", () => void loadDiagLog());
document
  .getElementById("clear-diag")
  ?.addEventListener("click", () => void clearDiagLog());
document
  .getElementById("save-profile")
  ?.addEventListener("click", () => void onSaveProfile());
document
  .getElementById("clear-profile")
  ?.addEventListener("click", () => void onClearProfile());

void loadSaved();
void refreshMicStatus();
void loadDiagLog();
void loadProfile();
