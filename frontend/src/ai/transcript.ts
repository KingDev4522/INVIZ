/**
 * Transcript normalization + language tagging (PRD 6.3; PRD 6 §3.1).
 * Deterministic string processing only — meaning is never altered
 * (negations and proper nouns pass through untouched).
 */

export type TranscriptLang = "en" | "hi" | "mixed";

export interface Transcript {
  text: string;
  lang: TranscriptLang;
  source: "voice";
  timestamp: number;
  /** Voice-turn correlation id. Set by the turn that produced this transcript;
   *  used for concurrency guards, idempotency, and log correlation only. */
  turnId?: string;
}

/** Trim + whitespace collapse. Scripts and punctuation preserved verbatim. */
export function normalizeTranscript(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim();
}

const DEVANAGARI_RE = /[\u0900-\u097F]/u;

// Unambiguous roman-Hindi tokens (word-boundary matched). Deliberately excludes
// English-colliding tokens (the, phone, number, ticket, main, school, tab): a
// single hit tags `mixed`, so every entry must be implausible in plain English
// browser commands. Loanwords that double as English ("chai") are kept only
// where a browser-command collision is implausible.
const HINDI_LEXICON: ReadonlySet<string> = new Set(
  (
    "haan hanji haanji ji theek sahi galat kar karo kardo mat ruko rukho nahin nahi " +
    "kya kaise kyon kyun tum aap mujhe tumhe humein mera meri tumhara tumhari " +
    "aapka chahiye bolo suno dekho kholo band chalu bhi wahi yahi shukriya namaste arre achha " +
    "acha bahut thoda jaldi abhi aaj kal yahan wahan kaun kahan kitna batao " +
    "suna sunao padho likho bhejo kharido becho lao jaao jao aao aa raha rahi " +
    "rahe hoga hogi honge wala wali tha thi hai hoon hun aur lekin magar " +
    "kyunki isliye phir wapas dobara tez dheere seedha ulta upar neeche andar " +
    "bahar saath paas door nazdeek pehla pehli aakhri poora adhura naya purana " +
    "bada chhota lamba garam thanda meetha namkeen bhukha pyasa khush dukhi " +
    "sahi jawab sawal kaam ghar daftar dost pyaar madad samay waqt din raat " +
    "subah shaam paani khana chai roti kapde paise rupaye rail hawai jahaz " +
    "pata shahar gaon desh duniya log bacche aadmi aurat ladka ladki"
  ).split(" "),
);

export function tagTranscript(text: string): TranscriptLang {
  if (DEVANAGARI_RE.test(text)) return "hi";
  const tokens = text.toLowerCase().split(/[^a-z]+/u).filter((t) => t !== "");
  for (const token of tokens) {
    if (HINDI_LEXICON.has(token)) return "mixed";
  }
  return "en";
}

export function toTranscript(raw: string, timestamp: number = Date.now()): Transcript {
  const text = normalizeTranscript(raw);
  return { text, lang: tagTranscript(text), source: "voice", timestamp };
}
