import type { Color } from "chess.js";
import type { EngineInfo } from "../engine/types";

/** Scores at or beyond this magnitude represent a forced mate rather than a centipawn eval. */
const MATE_BAND = 50_000;

/**
 * Collapses an engine score into a single comparable number (higher = better for the
 * searching side), so mate lines and centipawn lines can be ranked together.
 *
 * - Mating: prefer the *shortest* mate.
 * - Getting mated: prefer the *longest* survival.
 */
export function comparableScore(info: Pick<EngineInfo, "cp" | "mate">): number {
  if (info.mate !== undefined && info.mate !== 0) {
    return info.mate > 0 ? 100_000 - info.mate : -100_000 - info.mate;
  }
  return info.cp ?? 0;
}

export function isMateScore(score: number): boolean {
  return Math.abs(score) > MATE_BAND;
}

/** Converts a side-to-move score into White's point of view. */
export function toWhitePov(score: number, turn: Color): number {
  return turn === "w" ? score : -score;
}

/**
 * Win probability for the side the score belongs to.
 *
 * Prefers the engine's own WDL output (UCI_ShowWDL) when available; otherwise uses the
 * logistic centipawn->win% mapping popularised by Lichess:
 *   https://lichess.org/page/accuracy
 */
export function winProbability(info: Pick<EngineInfo, "cp" | "mate" | "wdl">): number {
  if (info.mate !== undefined && info.mate !== 0) return info.mate > 0 ? 1 : 0;
  if (info.wdl) {
    const [w, d, l] = info.wdl;
    const total = w + d + l;
    if (total > 0) return (w + d / 2) / total;
  }
  const cp = info.cp ?? 0;
  return 1 / (1 + Math.exp(-0.00368208 * cp));
}

/** Win probability expressed on White's side, 0..1. */
export function whiteWinProbability(info: Pick<EngineInfo, "cp" | "mate" | "wdl">, turn: Color) {
  const p = winProbability(info);
  return turn === "w" ? p : 1 - p;
}

/** Formats a score for display, always from White's point of view (`+1.24`, `M4`). */
export function formatScore(
  info: Pick<EngineInfo, "cp" | "mate">,
  turn: Color,
): { text: string; mate: boolean } {
  if (info.mate !== undefined && info.mate !== 0) {
    const whiteMates = turn === "w" ? info.mate > 0 : info.mate < 0;
    return { text: `${whiteMates ? "+" : "-"}M${Math.abs(info.mate)}`, mate: true };
  }
  const cp = toWhitePov(info.cp ?? 0, turn);
  const pawns = cp / 100;
  const sign = pawns > 0 ? "+" : pawns < 0 ? "\u2212" : "";
  return { text: `${sign}${Math.abs(pawns).toFixed(2)}`, mate: false };
}
