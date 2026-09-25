/**
 * Splits the large Stockfish builds into git-friendly chunks under engine-parts/.
 *
 * The full NNUE builds are ~94.5 MiB each. That squeezes under GitHub's 100 MiB hard
 * limit, but GitHub warns above 50 MiB and a future net could cross the limit entirely.
 * Splitting into 40 MiB parts keeps every committed file comfortably small.
 *
 * Reassembly happens at install time (scripts/sync-engine.mjs), so the browser always
 * loads a single ordinary .wasm file and needs no knowledge of chunking.
 *
 * Maintainers run this once per engine upgrade:
 *   node scripts/chunk-engine.mjs
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const BUILD_VERSION = require("stockfish/package.json").buildVersion;
const ENGINE_BIN = path.join(path.dirname(require.resolve("stockfish/package.json")), "bin");
const PARTS_DIR = path.resolve(import.meta.dirname, "..", "engine-parts");

export const CHUNK_BYTES = 40 * 1024 * 1024;

/** Builds that are too large to commit whole. */
const FULL_BUILDS = [`stockfish-${BUILD_VERSION}`, `stockfish-${BUILD_VERSION}-single`];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const mib = (b) => `${(b / 1024 / 1024).toFixed(2)} MiB`;

function main() {
  // Start clean so stale parts from a previous engine version can't linger.
  rmSync(PARTS_DIR, { recursive: true, force: true });
  mkdirSync(PARTS_DIR, { recursive: true });

  const manifest = {
    engineBuild: BUILD_VERSION,
    chunkBytes: CHUNK_BYTES,
    generatedBy: "scripts/chunk-engine.mjs",
    builds: [],
  };

  for (const base of FULL_BUILDS) {
    const wasmPath = path.join(ENGINE_BIN, `${base}.wasm`);
    const jsPath = path.join(ENGINE_BIN, `${base}.js`);

    const wasm = readFileSync(wasmPath);
    const js = readFileSync(jsPath);

    // The small loader is committed verbatim; only the wasm needs splitting.
    writeFileSync(path.join(PARTS_DIR, `${base}.js`), js);

    const parts = [];
    for (let offset = 0, index = 0; offset < wasm.length; offset += CHUNK_BYTES, index++) {
      const slice = wasm.subarray(offset, Math.min(offset + CHUNK_BYTES, wasm.length));
      const name = `${base}.wasm.part-${String(index).padStart(3, "0")}`;
      writeFileSync(path.join(PARTS_DIR, name), slice);
      parts.push({ name, bytes: slice.length, sha256: sha256(slice) });
      console.log(`  part ${name} (${mib(slice.length)})`);
    }

    manifest.builds.push({
      base,
      js: { name: `${base}.js`, bytes: js.length, sha256: sha256(js) },
      wasm: { name: `${base}.wasm`, bytes: wasm.length, sha256: sha256(wasm), parts },
    });

    console.log(`${base}.wasm -> ${parts.length} parts, ${mib(wasm.length)} total`);
  }

  writeFileSync(path.join(PARTS_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const total = readdirSync(PARTS_DIR).reduce(
    (sum, f) => sum + statSync(path.join(PARTS_DIR, f)).size,
    0,
  );
  const largest = readdirSync(PARTS_DIR).reduce(
    (max, f) => Math.max(max, statSync(path.join(PARTS_DIR, f)).size),
    0,
  );

  console.log(`\nengine-parts/: ${mib(total)} across ${readdirSync(PARTS_DIR).length} files`);
  console.log(`largest single file: ${mib(largest)} (GitHub warns above 50 MiB)`);
  if (largest > 50 * 1024 * 1024) {
    console.error("ERROR: a part exceeds 50 MiB; lower CHUNK_BYTES.");
    process.exit(1);
  }
}

main();
