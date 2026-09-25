import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The multi-threaded Stockfish builds need SharedArrayBuffer, which browsers only expose
 * in a cross-origin isolated context. That requires COOP + COEP response headers.
 * Without them the app still works, but falls back to a single-threaded engine build.
 */
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  build: {
    // The engine .js/.wasm files live in public/ and are loaded by URL at runtime,
    // so they must not be bundled or hashed.
    target: "es2022",
  },
  worker: { format: "es" },
});
