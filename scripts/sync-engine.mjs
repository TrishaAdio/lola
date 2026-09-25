/**
 * Puts the Stockfish engine assets into public/engine/ so they can be served as static
 * files and loaded by a Web Worker.
 *
 * Two sources:
 *  - The lite builds (~1.6 MiB) are copied straight out of node_modules.
 *  - The full NNUE builds (~94.5 MiB each) are committed to this repo as 40 MiB chunks
 *    under engine-parts/, and are reassembled here with a sha256 integrity check. This
 *    keeps every committed file well under GitHub's large-file warning while letting the
 *    browser load one ordinary .wasm file that knows nothing about chunking.
 *
 *   node scripts/sync-engine.mjs            # lite builds only (default)
 *   node scripts/sync-engine.mjs --full     # also reassemble the full NNUE builds
 *   node scripts/sync-engine.mjs --full --verify   # re-hash even if already present
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const BUILD_VERSION = require("stockfish/package.json").buildVersion;
const ENGINE_BIN = path.join(path.dirname(require.resolve("stockfish/package.json")), "bin");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "engine");
const PARTS_DIR = path.join(ROOT, "engine-parts");

const wantFull = process.argv.includes("--full");
const forceVerify = process.argv.includes("--verify");

const LITE = [`stockfish-${BUILD_VERSION}-lite-single`, `stockfish-${BUILD_VERSION}-lite`];

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

let failed = false;
const fail = (msg) => {
  console.error(`  ERROR ${msg}`);
  failed = true;
};

/** Copies one build's .js/.wasm pair out of node_modules. */
function copyBuild(base) {
  for (const ext of [".js", ".wasm"]) {
    const from = path.join(ENGINE_BIN, base + ext);
    const to = path.join(OUT_DIR, base + ext);

    if (!existsSync(from)) {
      console.warn(`  skip ${base + ext} (not in the stockfish package)`);
      continue;
    }
    if (existsSync(to) && statSync(to).size === statSync(from).size) {
      console.log(`  ok   ${base + ext} (already present, ${mib(statSync(to).size)})`);
      continue;
    }
    copyFileSync(from, to);
    console.log(`  copy ${base + ext} (${mib(statSync(to).size)})`);
  }
}

/** Reassembles one chunked build from engine-parts/, verifying integrity. */
function assembleBuild(build) {
  const jsTo = path.join(OUT_DIR, build.js.name);
  const jsFrom = path.join(PARTS_DIR, build.js.name);
  if (!existsSync(jsFrom)) return fail(`${build.js.name} missing from engine-parts/`);
  copyFileSync(jsFrom, jsTo);

  const target = path.join(OUT_DIR, build.wasm.name);

  // Cheap skip: right size already on disk. `--verify` forces the full hash check.
  if (existsSync(target) && statSync(target).size === build.wasm.bytes && !forceVerify) {
    console.log(`  ok   ${build.wasm.name} (already assembled, ${mib(build.wasm.bytes)})`);
    return;
  }

  const buffers = [];
  for (const part of build.wasm.parts) {
    const partPath = path.join(PARTS_DIR, part.name);
    if (!existsSync(partPath)) return fail(`${part.name} missing from engine-parts/`);

    const buf = readFileSync(partPath);
    if (buf.length !== part.bytes) {
      return fail(`${part.name} is ${buf.length} bytes, manifest says ${part.bytes}`);
    }
    const digest = sha256(buf);
    if (digest !== part.sha256) {
      return fail(`${part.name} sha256 mismatch (got ${digest.slice(0, 12)}…)`);
    }
    buffers.push(buf);
  }

  const joined = Buffer.concat(buffers);
  if (joined.length !== build.wasm.bytes) {
    return fail(`${build.wasm.name} assembled to ${joined.length} bytes, expected ${build.wasm.bytes}`);
  }
  const digest = sha256(joined);
  if (digest !== build.wasm.sha256) {
    return fail(`${build.wasm.name} sha256 mismatch after assembly`);
  }

  writeFileSync(target, joined);
  console.log(`  join ${build.wasm.name} (${build.wasm.parts.length} parts, ${mib(joined.length)}, sha256 ok)`);
}

function syncFull() {
  const manifestPath = path.join(PARTS_DIR, "manifest.json");

  if (!existsSync(manifestPath)) {
    // No committed chunks: fall back to copying straight from node_modules.
    console.log("engine-parts/ not found, copying full builds from node_modules:");
    copyBuild(`stockfish-${BUILD_VERSION}`);
    copyBuild(`stockfish-${BUILD_VERSION}-single`);
    return;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.engineBuild !== BUILD_VERSION) {
    return fail(
      `engine-parts/ holds Stockfish ${manifest.engineBuild} but the installed package is ${BUILD_VERSION}. Re-run: node scripts/chunk-engine.mjs`,
    );
  }

  console.log(`Reassembling full NNUE builds from engine-parts/ (Stockfish ${manifest.engineBuild}):`);
  for (const build of manifest.builds) assembleBuild(build);
}

mkdirSync(OUT_DIR, { recursive: true });

console.log(`Syncing Stockfish ${BUILD_VERSION} engine assets -> public/engine/`);
for (const base of LITE) copyBuild(base);

if (wantFull) {
  syncFull();
} else {
  console.log("Full NNUE builds not assembled. Run `npm run engine:full` to enable that tier.");
}

if (failed) process.exit(1);
