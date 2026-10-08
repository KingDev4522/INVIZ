/**
 * Devanagari → roman transliterator (product workaround, documented).
 * The TTS voice (canopylabs/orpheus-v1-english) is English-only and refuses
 * Devanagari script, while romanized Hindi synthesizes correctly. Hindi
 * utterances are therefore romanized before synthesis.
 * Deterministic code-point mapping (ITRANS-inspired); goal is comprehensible
 * pronunciation, not scholarly transliteration. Pure — unit-tested.
 */

const CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
  "ष": "sh", "स": "s", "ह": "h", "ळ": "l",
  // Nukta consonants, decomposed (base + U+093C) and precomposed forms.
  "क़": "q", "ख़": "kh", "ग़": "gh", "ज़": "z", "झ़": "jh",
  "फ़": "f", "ड़": "r", "ढ़": "rh", "य़": "y", "व़": "w",
  "क़": "q", "ख़": "kh", "ग़": "gh", "ज़": "z", "ड़": "r",
  "ढ़": "rh", "फ़": "f", "य़": "y",
  "क्ष": "ksh", "त्र": "tr", "ज्ञ": "gy",
};

const VOWELS_INDEPENDENT: Record<string, string> = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo",
  "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
  "ऑ": "o", "ऒ": "o", "ऍ": "e",
};

const VOWEL_SIGNS: Record<string, string> = {
  "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo",
  "ृ": "ri", "ॄ": "rri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
  "ॉ": "o", "ॊ": "o", "ॅ": "e",
};

const SIGNS: Record<string, string> = {
  "ं": "n", "ः": "h", "ँ": "n",
  // Punctuation / symbols: romanized, never left as Devanagari (the model
  // blocks the script, so every codepoint must resolve to Latin or nothing).
  "।": ". ", "॥": ". ", "ॐ": "om", "ऽ": "'", "॰": ".",
};

const VEDIC_DROP = new Set(["॑", "॒", "॓", "॔", "ॎ", "ॏ", "ॗ"]);

const DIGITS: Record<string, string> = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
  "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
};

const HALANT = "्";
const NUKTA = "़";

const DEVANAGARI_RE = /[\u0900-\u097F]/u;

/** True when the text needs romanization before model synthesis. */
export function needsRomanization(text: string): boolean {
  return DEVANAGARI_RE.test(text);
}

export function transliterateHi(text: string): string {
  const chars = [...text];
  let out = "";
  // Tracks whether the output currently ends with an inherent (unwritten) 'a',
  // for Hindi final-schwa deletion (कमल → kamal, not kamala).
  let trailingInherentA = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    // Nukta combos are handled with their base consonant below.
    if (ch === NUKTA) {
      trailingInherentA = false;
      continue;
    }

    const independent = VOWELS_INDEPENDENT[ch];
    if (independent !== undefined) {
      out += independent;
      trailingInherentA = false;
      continue;
    }
    const sign = VOWEL_SIGNS[ch];
    if (sign !== undefined) {
      out += sign; // vowel sign replaces the inherent 'a' by position
      trailingInherentA = false;
      continue;
    }
    const mark = SIGNS[ch];
    if (mark !== undefined) {
      out += mark;
      trailingInherentA = false;
      continue;
    }
    const digit = DIGITS[ch];
    if (digit !== undefined) {
      out += digit;
      trailingInherentA = false;
      continue;
    }
    // Consonant (+ optional nukta): nukta combo first — a plain base lookup
    // would shadow it. Inherent 'a' unless halant or vowel sign follows.
    const withNukta = chars[i + 1] === NUKTA ? ch + NUKTA : ch;
    const base = CONSONANTS[withNukta] ?? CONSONANTS[ch];
    if (base !== undefined) {
      if (chars[i + 1] === NUKTA) i += 1; // consumed with the base
      const next = chars[i + 1];
      const inherentA =
        next !== HALANT && (next === undefined || VOWEL_SIGNS[next] === undefined);
      out += inherentA ? `${base}a` : base;
      trailingInherentA = inherentA;
      if (next === HALANT) i += 1; // halant consumed: no inherent vowel
      continue;
    }
    if (ch === HALANT) {
      trailingInherentA = false;
      continue; // stray halant: drop
    }
    if (VEDIC_DROP.has(ch)) {
      trailingInherentA = false;
      continue; // tone marks carry no phonemes for TTS
    }
    if (/[\u0900-\u097F]/u.test(ch)) continue; // backstop: an unmapped Devanagari
    // codepoint must never reach the model (whole-request block) — dropping one
    // phoneme degrades gracefully where a block would fail totally.
    trailingInherentA = false;
    out += ch; // non-Devanagari passes through untouched
  }
  if (trailingInherentA && out.length > 2 && out.endsWith("a")) {
    out = out.slice(0, -1); // Hindi final-schwa deletion (राम → raam)
  }
  // Fix-up for sign+independent sequences producing runaway vowels.
  return out.replace(/aa(a+)/gu, "aa").replace(/\s+/gu, " ");
}
