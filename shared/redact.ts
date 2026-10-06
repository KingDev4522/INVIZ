/**
 * Redaction: the single choke point for every log / persist / transmit path
 * (PRD 5 §37–40; PRD 6 §2 standard 4).
 * Category C values must never reach logs, storage, cache, telemetry, or TTS.
 */

const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

// Whole-word key matching on camel/snake/kebab segments: "groqKeys" and
// "providerApiKey" must redact, while "authMode", "author", "discard", and
// "monkey" must not. Substring matching fails both directions, so keys are
// split into segments first.
const SECRET_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "otp",
  "cvv",
  "card",
  "cardnumber",
  "secret",
  "token",
  "tokens",
  "key",
  "keys",
  "apikey",
  "authtoken",
  "authorization",
  "credential",
  "credentials",
]);

// Metadata suffixes that are never secrets, even when the stem is sensitive
// ("groqKeysConfigured" is a count, not a key — proven by live log output).
const SAFE_SUFFIXES = [
  "configured",
  "count",
  "present",
  "enabled",
  "status",
  "ok",
  "mode",
  "length",
  "size",
  "expiry",
  "time",
  "at",
  "date",
];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SAFE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter((s) => s !== "");
  return segments.some((s) => SECRET_WORDS.has(s.toLowerCase()));
}

/** Values that are exactly a redaction marker (used by tests/canaries). */
export const REDACTED = "[REDACTED]";

export function redactString(input: string): string {
  return input.replace(CARD_RE, (m) => {
    const digits = m.replace(/[ -]/g, "");
    // Only redact runs that look like real card-length numbers.
    if (digits.length >= 13 && digits.length <= 19 && /^\d+$/.test(digits)) {
      return REDACTED;
    }
    return m;
  });
}

// --- Value-level secret masking for FREE TEXT (learning/episode paths) ------
// Key-based redaction cannot help a sentence like `login password=hunter2`.
// These patterns are deterministic and applied before ANY string reaches
// persistent storage — never handed to a model to decide.
const SECRET_ASSIGNMENT_RE =
  /\b(password|passwd|pwd|secret|secrets|token|tokens|credential|credentials|authorization|auth_?token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|session[_-]?id|sessionid|cookie|cookies|otp|cvv|cvc|bearer)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/gi;
const BEARER_RE = /\b(bearer)\s+\S+/gi;

/**
 * Masks secret-shaped VALUES inside free text (goals, titles, action values,
 * notes). First line is always the card-number rule from `redactString`.
 * Built to be conservative: when it looks like a credential, it is redacted.
 */
export function redactSecretText(input: string): string {
  if (typeof input !== "string" || input === "") return input;
  let out = redactString(input);
  out = out.replace(SECRET_ASSIGNMENT_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  out = out.replace(BEARER_RE, (_m, word: string) => `${word} ${REDACTED}`);
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(LONG_HEX_RE, REDACTED);
  return out;
}

/**
 * Deep-redacts an unknown value: secret-named keys are replaced wholesale,
 * long digit runs inside strings are masked. Returns a JSON-safe clone.
 */
export function redactObject<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactObject(v)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactObject(v);
    }
    return out as unknown as T;
  }
  return value;
}
