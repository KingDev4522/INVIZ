// Packs frontend/dist into site/public/extension/inviz-extension.zip.
// Pure Node (zlib for DEFLATE, hand-rolled ZIP writer) so no extra dependency
// is needed. Runs automatically as the site's `prebuild` step.
import { execSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = dirname(here);
const repoDir = dirname(siteDir);
const distDir = join(repoDir, "frontend", "dist");
const outDir = join(siteDir, "public", "extension");
const outFile = join(outDir, "inviz-extension.zip");
const TOP = "inviz-extension/";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    date: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  };
}

function walk(dir, base, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".map")) continue;
      out.push(relative(base, full).split("\\").join("/"));
    }
  }
  return out;
}

function buildZip(files, read) {
  const { time, date } = dosDateTime();
  const chunks = [];
  const central = [];
  let offset = 0;

  const addEntry = (name, raw, isDir) => {
    const nameBuf = Buffer.from(name, "utf8");
    const method = isDir ? 0 : 8;
    const data = isDir ? Buffer.alloc(0) : raw;
    const comp = isDir ? data : zlib.deflateRawSync(data, { level: 9 });
    const crc = isDir ? 0 : crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(comp.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    central.push({ nameBuf, method, crc, compLen: comp.length, rawLen: data.length, offset, isDir });
    chunks.push(header, nameBuf, comp);
    offset += header.length + nameBuf.length + comp.length;
  };

  addEntry(TOP, Buffer.alloc(0), true);
  const dirs = new Set();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(`${TOP}${parts.slice(0, i).join("/")}/`);
    }
  }
  for (const dir of [...dirs].sort()) {
    addEntry(dir, Buffer.alloc(0), true);
  }
  for (const file of files) {
    addEntry(`${TOP}${file}`, read(file), false);
  }

  const centralStart = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compLen, 20);
    header.writeUInt32LE(entry.rawLen, 24);
    header.writeUInt16LE(entry.nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(entry.isDir ? 0x10 : 0x20, 38);
    header.writeUInt32LE(entry.offset, 42);
    chunks.push(header, entry.nameBuf);
    offset += header.length + entry.nameBuf.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);

  return Buffer.concat(chunks);
}

const manifestPath = join(distDir, "manifest.json");
const truthy = (value) => ["1", "true"].includes(String(value ?? "").toLowerCase());
const onCI = truthy(process.env.CI) || truthy(process.env.VERCEL);

// When the extension cannot be built (e.g. a site-only install on Vercel has
// no repo-root toolchain), fall back to the committed zip on CI so the deploy
// still succeeds. Locally this throws so a broken toolchain is never silent.
function keepCommittedZip(reason) {
  const usable = existsSync(outFile) && statSync(outFile).size > 1024;
  if (onCI && usable) {
    console.warn(`[pack-extension] ${reason} keeping the committed public/extension/inviz-extension.zip.`);
    process.exit(0);
  }
  throw new Error(`[pack-extension] ${reason} and no usable public/extension/inviz-extension.zip exists.`);
}

if (!existsSync(manifestPath)) {
  if (!existsSync(join(repoDir, "node_modules"))) {
    keepCommittedZip("frontend/dist is missing and repo dependencies are not installed (site-only build);");
  }
  console.log("[pack-extension] frontend/dist is missing, building the extension first…");
  try {
    execSync("npm run build --workspace=frontend", { cwd: repoDir, stdio: "inherit" });
  } catch {
    keepCommittedZip("frontend build failed;");
  }
}

if (!existsSync(manifestPath)) {
  keepCommittedZip("frontend build did not produce frontend/dist;");
}

const files = walk(distDir, distDir).sort();
if (files.length === 0) {
  throw new Error("[pack-extension] frontend/dist contains no files to pack.");
}

const zip = buildZip(files, (rel) => readFileSync(join(distDir, ...rel.split("/"))));
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, zip);

console.log(
  `[pack-extension] packed ${files.length} files → public/extension/inviz-extension.zip (${Math.round(zip.length / 1024)} KB)`,
);
