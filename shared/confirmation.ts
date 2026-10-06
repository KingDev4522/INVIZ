/**
 * Deterministic confirmation grammar (PRD 6 §3.3, §7).
 * YES/NO word sets in English + roman Hindi + Devanagari. Matching is
 * case-insensitive whole-word: "yes" inside "eyes" must not match.
 *
 * Security posture (fail closed):
 * - Negations ("mat", "nahi", "don't", "not", "मत"…) mark refusal AND absorb
 *   the following affirmative ("mat karo" = no, not yes+no). Uncertainty
 *   ("not sure") therefore refuses rather than executes — documented.
 * - Affirmations must be short (≤3 substantive tokens): "yes please" passes,
 *   but "yes, but delete everything" is re-asked, blocking scope-expansion
 *   riders from riding a YES into execution.
 * Anything else is "unclear" → clarification re-ask, never a guess.
 */

const YES_WORDS: ReadonlySet<string> = new Set(
  (
    "yes yeah yep yup sure ok okay correct confirm confirmed proceed continue " +
    "haan hanji haanji ji theek sahi kar karo kardo " +
    "हाँ हां हांजी हाँजी जी ठीक सही कर करो"
  ).split(/\s+/u).filter((w) => w !== ""),
);

const NO_WORDS: ReadonlySet<string> = new Set(
  (
    "no nope nah stop cancel wrong reject never incorrect " +
    "nahin nahi ruko rukho galat radd " +
    "नहीं नही रुको रूको ग़लत गलत रद्द"
  ).split(/\s+/u).filter((w) => w !== ""),
);

// Negators: mark refusal and absorb a following affirmative token.
const NEGATORS: ReadonlySet<string> = new Set(
  "mat nahi nahin dont don't never not no मत न ना नहीं नही".split(/\s+/u),
);

// Politeness particles: ignored for length, never votes.
const POLITENESS: ReadonlySet<string> = new Set(
  "please kindly thanks thank kripya shukriya dhanyavaad कृपया शुक्रिया धन्यवाद".split(
    /\s+/u,
  ),
);

export type ConfirmationVote = "yes" | "no" | "unclear";

/**
 * Tokenizes on anything that is not a letter (any script), mark, or
 * apostrophe. Marks (\\p{M}) are essential: Devanagari vowel signs (matras)
 * and bindis are Marks, not Letters — splitting on \\p{L} alone chops every
 * Hindi word into consonants ("हाँ" → "ह").
 */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/-/gu, " ")
    .split(/[^\p{L}\p{M}']+/u)
    .filter((t) => t !== "");
}

export function matchConfirmation(text: string): ConfirmationVote {
  const toks = tokens(text);
  let yes = false;
  let no = false;
  let substantive = 0;
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i] ?? "";
    if (NEGATORS.has(t)) {
      no = true;
      const next = toks[i + 1];
      if (next !== undefined && YES_WORDS.has(next)) i += 1; // absorb "mat karo"
      continue;
    }
    if (YES_WORDS.has(t)) {
      yes = true;
      substantive += 1;
      continue;
    }
    if (NO_WORDS.has(t)) {
      no = true;
      substantive += 1;
      continue;
    }
    if (POLITENESS.has(t)) continue;
    substantive += 1;
  }
  if (no && !yes) return "no";
  if (yes && !no && substantive <= 3) return "yes";
  return "unclear";
}
