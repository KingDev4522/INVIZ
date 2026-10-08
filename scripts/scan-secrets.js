/**
 * Secrets scan (release gate R2 groundwork, PRD 6.8).
 * Fails (exit 1) on credential-shaped material in tracked source.
 * Test canaries (*.test.ts, lines marked canary) are allowlisted by design:
 * they prove redaction works and are not real secrets.
 * Usage: npm run scan-secrets
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
// .env files are local-only by design (git-ignored): skipped here, but any
// provider key material in ANY other file is a release-blocking hit.
const SKIP_FILES = new Set([".env", ".env.local", ".env.development"]);
const SKIP_EXT = new Set([".png", ".jpg", ".mp3", ".wav", ".zip"]);

const PATTERNS = [
  { name: "groq-key", re: /\bgsk_[A-Za-z0-9]{8,}/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{20,}/ },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "password-literal",
    re: /\bpassword\s*[:=]\s*["'][^"']{3,}["']/i,
  },
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (
      !SKIP_EXT.has(path.extname(entry.name).toLowerCase()) &&
      !SKIP_FILES.has(entry.name)
    ) {
      yield path.join(dir, entry.name);
    }
  }
}

let hits = 0;
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue; // binary; skip
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/canary/i.test(line) || /REDACTED/.test(line) || file.endsWith(".test.ts")) {
      return; // allowlisted test material
    }
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        console.error(`HIT ${p.name} ${rel}:${i + 1}`);
        hits += 1;
      }
    }
  });
}

if (hits > 0) {
  console.error(`scan-secrets: ${hits} hit(s) — release blocked`);
  process.exit(1);
}
console.log("scan-secrets: clean");
