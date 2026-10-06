/**
 * Architecture boundary test: the frontend must NEVER contain provider keys,
 * provider endpoints, or provider SDK calls. All AI traffic goes through the
 * backend /v1/* contract (shared/api.ts). One match = release-blocking defect.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "groq-key", re: /\bgsk_[A-Za-z0-9]{8,}/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{20,}/ },
  { name: "groq-endpoint", re: /api\.groq\.com/ },
  { name: "generativelanguage-endpoint", re: /generativelanguage\.googleapis\.com/ },
  { name: "text-to-speech-endpoint", re: /texttospeech\.googleapis\.com/ },
  // Provider KEY names must never appear (labels, logs, or code). Note:
  // BACKEND_TOKEN is deliberately absent — it is the extension's own auth
  // label, shown in Options UI by design, and useless without the value.
  { name: "provider-key-names", re: /\b(GROQ_API_KEYS?|GEMINI_API_KEY)\b/ },
  // The retired Gemini provider must not creep back in: no model id, no
  // voice name, no field. All speech now runs through Groq.
  { name: "retired-gemini-tts", re: /\bgemini[-_.0-9a-z]*\b/i },
];

// This file itself contains the forbidden patterns as regex literals.
const SELF = "architecture-boundary.test.ts";

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (full.endsWith(".ts")) {
      yield full;
    }
  }
}

describe("frontend/backend boundary", () => {
  it("contains zero provider keys, endpoints, or credential names", () => {
    const hits: string[] = [];
    for (const file of walk(ROOT)) {
      if (path.basename(file) === SELF) continue;
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (/canary/i.test(line)) return; // test canaries are allowlisted fixtures
        for (const pattern of FORBIDDEN) {
          if (pattern.re.test(line)) {
            hits.push(`${path.relative(ROOT, file)}:${i + 1} [${pattern.name}]`);
          }
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("talks to AI only through the shared /v1/* contract", () => {
    const hits: string[] = [];
    for (const file of walk(ROOT)) {
      const text = fs.readFileSync(file, "utf8");
      // Direct fetch() to non-contract URLs is forbidden; the backend clients
      // build URLs exclusively from shared ENDPOINTS.
      const fetches = [...text.matchAll(/fetch\(\s*[`'"]([^`'"]+)[`'"]/g)];
      for (const m of fetches) {
        const url = m[1] ?? "";
        if (url.startsWith("http") && !url.includes("127.0.0.1") && !url.includes("localhost")) {
          hits.push(`${path.relative(ROOT, file)}: absolute fetch to ${url}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
