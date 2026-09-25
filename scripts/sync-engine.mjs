/**
 * Copies Stockfish WASM builds out of node_modules into public/engine/ so they can be
 * served as static assets and loaded by a Web Worker.
 *
 * The "lite" builds (~1.6 MB) are always synced. The full builds embed the big NNUE net
 * and are ~94 MB each, so they are opt-in:
 *
 *   node scripts/sync-engine.mjs          # lite builds only (default)
 *   node scripts/sync-engine.mjs --full   # also copy the full 94 MB NNUE builds
 */
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const BUILD_VERSION = require("stockfish/package.json").buildVersion;
const ENGINE_BIN = path.join(path.dirname(require.resolve("stockfish/package.json")), "bin");
const OUT_DIR = path.resolve(import.meta.dirname, "..", "public", "engine");

const wantFull = process.argv.includes("--full");

/** Base filenames (without extension) for each engine build we may ship. */
const LITE = [`stockfish-${BUILD_VERSION}-lite-single`, `stockfish-${BUILD_VERSION}-lite`];
const FULL = [`stockfish-${BUILD_VERSION}-single`, `stockfish-${BUILD_VERSION}`];

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function sync(base) {
  let copied = 0;
  for (const ext of [".js", ".wasm"]) {
    const from = path.join(ENGINE_BIN, base + ext);
    const to = path.join(OUT_DIR, base + ext);

    if (!existsSync(from)) {
      console.warn(`  skip ${base + ext} (not present in the stockfish package)`);
      continue;
    }
    // Skip re-copying a 94 MB file when it is already in place and the same size.
    if (existsSync(to) && statSync(to).size === statSync(from).size) {
      console.log(`  ok   ${base + ext} (already synced, ${mb(statSync(to).size)})`);
      copied++;
      continue;
    }
    copyFileSync(from, to);
    console.log(`  copy ${base + ext} (${mb(statSync(to).size)})`);
    copied++;
  }
  return copied === 2;
}

mkdirSync(OUT_DIR, { recursive: true });

console.log(`Syncing Stockfish ${BUILD_VERSION} engine assets -> public/engine/`);
for (const base of LITE) sync(base);

if (wantFull) {
  console.log("Syncing full NNUE builds (large):");
  for (const base of FULL) sync(base);
} else {
  console.log("Full NNUE builds not synced. Run `npm run engine:full` to enable that tier.");
}
