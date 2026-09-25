import type { EngineTier, EngineTierId } from "./types";

/** Matches `buildVersion` in the stockfish npm package / scripts/sync-engine.mjs. */
export const ENGINE_BUILD = "19";

export const ENGINE_TIERS: Record<EngineTierId, EngineTier> = {
  full: {
    id: "full",
    label: "Full NNUE · multi-threaded",
    base: `stockfish-${ENGINE_BUILD}`,
    sizeLabel: "~94 MB",
    threaded: true,
    fullNet: true,
    note: "Strongest possible. Huge download; needs cross-origin isolation.",
  },
  "full-single": {
    id: "full-single",
    label: "Full NNUE · single-threaded",
    base: `stockfish-${ENGINE_BUILD}-single`,
    sizeLabel: "~94 MB",
    threaded: false,
    fullNet: true,
    note: "Full-size net on one core. Huge download.",
  },
  lite: {
    id: "lite",
    label: "Lite NNUE · multi-threaded",
    base: `stockfish-${ENGINE_BUILD}-lite`,
    sizeLabel: "~1.6 MB",
    threaded: true,
    fullNet: false,
    note: "Smaller net across all cores. Loads instantly, still far above human strength.",
  },
  "lite-single": {
    id: "lite-single",
    label: "Lite NNUE · single-threaded",
    base: `stockfish-${ENGINE_BUILD}-lite-single`,
    sizeLabel: "~1.8 MB",
    threaded: false,
    fullNet: false,
    note: "Maximum compatibility. Runs anywhere, no special headers needed.",
  },
};

export const ENGINE_ASSET_DIR = "engine";

export function engineScriptUrl(tier: EngineTier): string {
  return new URL(
    `${import.meta.env.BASE_URL}${ENGINE_ASSET_DIR}/${tier.base}.js`,
    location.href,
  ).href;
}

export function engineWasmUrl(tier: EngineTier): string {
  return new URL(
    `${import.meta.env.BASE_URL}${ENGINE_ASSET_DIR}/${tier.base}.wasm`,
    location.href,
  ).href;
}

/**
 * The worker script reads the wasm location from its own URL hash, so we can point a
 * single build at an explicit wasm file.
 */
export function engineWorkerUrl(tier: EngineTier): string {
  return `${engineScriptUrl(tier)}#${encodeURIComponent(engineWasmUrl(tier))}`;
}

/** SharedArrayBuffer is only exposed to cross-origin isolated pages. */
export function supportsThreads(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated === true;
}

/** The big builds are opt-in (see scripts/sync-engine.mjs), so probe before offering them. */
export async function isTierAvailable(tier: EngineTier): Promise<boolean> {
  if (tier.threaded && !supportsThreads()) return false;
  try {
    const res = await fetch(engineWasmUrl(tier), { method: "HEAD" });
    if (!res.ok) return false;
    // A dev server or SPA fallback can answer HEAD with an HTML page; require real wasm.
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/html")) return false;
    return true;
  } catch {
    return false;
  }
}

/** Best tier we can actually run, preferring small-and-instant over a 94 MB download. */
export async function detectBestTier(): Promise<EngineTierId> {
  const order: EngineTierId[] = ["lite", "lite-single"];
  for (const id of order) {
    if (await isTierAvailable(ENGINE_TIERS[id])) return id;
  }
  return "lite-single";
}
