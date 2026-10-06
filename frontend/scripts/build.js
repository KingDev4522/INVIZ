/**
 * Frontend build: tsc (build config) + flatten + copy static assets.
 * tsc compiles frontend/src/** + shared/** with the repo root as common root,
 * emitting dist/frontend/src/** and dist/shared/**. This script flattens to
 * the load-unpacked layout: dist/ = { manifest.json, <extension modules>,
 * shared/**, ui assets }. Relative imports (../../shared/...) resolve
 * identically before and after flattening.
 * Usage (from frontend/): npm run build
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, ".."); // frontend/
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

function removeTree(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

execSync("npx tsc -p tsconfig.build.json", { cwd: ROOT, stdio: "inherit" });

// Flatten: dist/frontend/src/* -> dist/* (shared/ already sits at dist/shared/).
const nested = path.join(DIST, "frontend", "src");
if (fs.existsSync(nested)) {
  for (const entry of fs.readdirSync(nested)) {
    fs.renameSync(path.join(nested, entry), path.join(DIST, entry));
  }
  removeTree(path.join(DIST, "frontend"));
}

// Manifest lives at frontend/ root; dist/ must contain it.
fs.copyFileSync(path.join(ROOT, "manifest.json"), path.join(DIST, "manifest.json"));

// Content scripts run as classic scripts (no import support): bundle to IIFE.
execSync(
  "npx esbuild src/content/content.ts --bundle --format=iife --platform=browser --target=es2022 --outfile=dist/content/content.js --allow-overwrite --sourcemap --log-level=warning",
  { cwd: ROOT, stdio: "inherit" },
);

// Copy .html / .css from src/ preserving relative paths.
for (const file of walk(SRC)) {
  if (!file.endsWith(".html") && !file.endsWith(".css")) continue;
  const rel = path.relative(SRC, file);
  const dest = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
}

console.log("build complete: frontend/dist/ ready for chrome://extensions Load unpacked");
