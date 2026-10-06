/**
 * Build script: tsc (build config) + copy static assets into dist/.
 * dist/ is the load-unpacked artifact. Usage: npm run build
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

execSync("npx tsc -p tsconfig.build.json", { cwd: ROOT, stdio: "inherit" });

// Manifest lives at repo root; dist/ must contain it.
fs.copyFileSync(path.join(ROOT, "manifest.json"), path.join(DIST, "manifest.json"));

// Copy .html / .css from src/ preserving relative paths.
for (const file of walk(SRC)) {
  if (!file.endsWith(".html") && !file.endsWith(".css")) continue;
  const rel = path.relative(SRC, file);
  const dest = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
}

console.log("build complete: dist/ ready for chrome://extensions Load unpacked");
