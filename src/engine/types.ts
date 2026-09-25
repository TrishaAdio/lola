/** Which compiled Stockfish build to load. */
export type EngineTierId = "full" | "full-single" | "lite" | "lite-single";

export interface EngineTier {
  id: EngineTierId;
  label: string;
  /** Base filename in /public/engine (without extension). */
  base: string;
  /** Approximate wasm download size, for the UI. */
  sizeLabel: string;
  /** Multi-threaded builds need SharedArrayBuffer + cross-origin isolation. */
  threaded: boolean;
  /** Embeds the large NNUE net (strongest evaluation). */
  fullNet: boolean;
  note: string;
}

/** A single parsed `info` line from the engine. */
export interface EngineInfo {
  depth: number;
  seldepth?: number;
  /** 1-based MultiPV rank. */
  multipv: number;
  /** Centipawn score from the searching side's point of view. */
  cp?: number;
  /** Mate distance in moves, from the searching side's point of view. */
  mate?: number;
  /** Win/draw/loss permille, present when UCI_ShowWDL is enabled. */
  wdl?: [number, number, number];
  nodes?: number;
  nps?: number;
  timeMs?: number;
  hashfull?: number;
  /** Principal variation as UCI move strings. */
  pv: string[];
  /** True when the score is a fail-high/fail-low bound rather than exact. */
  bound?: "lower" | "upper";
}

export interface SearchResult {
  /** UCI move string, or "(none)" when there is no legal move. */
  bestmove: string;
  ponder?: string;
  /** Final candidate lines, one per MultiPV rank, sorted by rank. */
  lines: EngineInfo[];
}

export interface SearchLimits {
  depth?: number;
  movetimeMs?: number;
  nodes?: number;
}

export interface EngineConfig {
  tier: EngineTierId;
  threads: number;
  hashMb: number;
  multiPv: number;
  /** Full strength: false. Practice mode: true, paired with uciElo. */
  limitStrength: boolean;
  /** 0-20. 20 = no weakening. Below 20 Stockfish deliberately plays worse moves. */
  skillLevel: number;
  uciElo: number;
  limits: SearchLimits;
}
