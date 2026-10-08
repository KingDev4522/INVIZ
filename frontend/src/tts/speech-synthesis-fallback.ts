/**
 * speechSynthesis fallback (PRD 6.2 §1.3). Genuine local synthesis behind the
 * same call shape as the backend path — a real fallback, not a stand-in.
 * Runs in the offscreen document (has window.speechSynthesis).
 *
 * Voice quality matters: the first-listed system voice is often the old
 * robotic one. Voices are scored (natural/neural/online first, compact last),
 * async-loaded (Chrome fills getVoices() late), and awaited before speaking.
 */
import { TTS_LANG_EN, TTS_LANG_HI } from "../../../shared/constants.js";
import type { SpeechLang, TtsLang } from "../../../shared/api.js";

const LOCALE_FOR: Record<SpeechLang, string> = { en: TTS_LANG_EN, hi: TTS_LANG_HI };

/** Mixed utterances are pre-split upstream; the fallback defaults them to en. */
function narrow(lang: TtsLang): SpeechLang {
  return lang === "hi" ? "hi" : "en";
}

/**
 * Feminine-voice heuristic. VoiceLens speaks with a feminine browser voice by
 * design: known feminine assistant voices across platforms (Microsoft Zira /
 * Aria / Jenny, Apple Samantha, Google's female English voices) plus generic
 * feminine markers. Name-based gendering is a heuristic, not a guarantee —
 * the language match below always wins over it, and any same-language voice
 * still beats none.
 */
const FEMININE_NAME_RE =
  /(zira|aria|jenny|sonia|neerja|ava|emma|libby|samantha|hannah|diana|autumn|natalie|olivia|sophia|female|woman|girl|lady)/i;

/** Minimal voice shape so selection is unit-testable without speechSynthesis. */
export interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
}

/** Name-based quality score. Natural/online voices beat legacy robot voices. */
function voiceScore(v: VoiceLike): number {
  let score = 0;
  const name = v.name;
  // Feminine identity first: within one language, the feminine voice always
  // beats a masculine "natural" one (+80 > natural's +60).
  if (FEMININE_NAME_RE.test(name)) score += 80;
  if (/(natural|neural|premium)/i.test(name)) score += 60;
  else if (/online/i.test(name)) score += 30;
  else if (/google/i.test(name)) score += 20;
  if (/compact/i.test(name)) score -= 80;
  if (!v.localService) score += 5;
  return score;
}

/** Pure selection: best same-language voice, feminine preferred. Testable. */
export function pickVoice<T extends VoiceLike>(voices: T[], lang: SpeechLang): T | null {
  if (voices.length === 0) return null;
  const prefix = LOCALE_FOR[lang].toLowerCase();
  const prefix2 = prefix.slice(0, 2);
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const v of voices) {
    const vl = v.lang.toLowerCase().replace("_", "-");
    let score = voiceScore(v);
    if (vl === prefix) score += 100;
    else if (vl.startsWith(prefix2)) score += 50;
    else continue; // wrong language entirely
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

function bestVoice(voices: SpeechSynthesisVoice[], lang: SpeechLang): SpeechSynthesisVoice | null {
  return pickVoice(voices, lang);
}

/**
 * Chrome populates getVoices() asynchronously in fresh documents (offscreen
 * starts empty). Wait briefly for voiceschanged instead of silently falling
 * back to whatever default the engine picks.
 */
function readyVoices(): Promise<SpeechSynthesisVoice[]> {
  const immediate = speechSynthesis.getVoices();
  if (immediate.length > 0) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      speechSynthesis.removeEventListener("voiceschanged", finish);
      resolve(speechSynthesis.getVoices());
    };
    speechSynthesis.addEventListener("voiceschanged", finish);
    setTimeout(finish, 500);
  });
}

export async function speakLocal(text: string, lang: TtsLang): Promise<void> {
  const speechLang = narrow(lang);
  const voices = await readyVoices();
  return new Promise((resolve, reject) => {
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = LOCALE_FOR[speechLang];
      utterance.rate = 1.05;
      utterance.pitch = 1;
      const voice = bestVoice(voices, speechLang);
      if (voice !== null) utterance.voice = voice;
      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error("speechSynthesis utterance failed"));
      speechSynthesis.speak(utterance);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("speechSynthesis unavailable"));
    }
  });
}

/** Warm the voice list at document startup so the first utterance isn't default. */
export function warmVoices(): void {
  try {
    speechSynthesis.addEventListener("voiceschanged", () => {
      speechSynthesis.getVoices();
    });
    speechSynthesis.getVoices();
  } catch {
    // speechSynthesis unavailable: fallback will fail honestly at speak time.
  }
}

export function stopLocal(): void {
  try {
    speechSynthesis.cancel();
  } catch {
    // Already silent or unavailable: nothing to stop.
  }
}
