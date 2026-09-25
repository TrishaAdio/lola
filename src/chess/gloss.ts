import { Chess } from "chess.js";
import type { Move, Square } from "chess.js";
import { parseUciMove } from "./moves";
import { analyseThreats, PIECE_VALUE } from "./threats";
import type { EngineInfo } from "../engine/types";

const PIECE_NAME: Record<string, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

/** Replays a PV, returning the moves that were legal. */
function replay(fen: string, pv: string[]): { moves: Move[]; final: Chess } {
  const chess = new Chess(fen);
  const moves: Move[] = [];
  for (const uci of pv) {
    const parts = parseUciMove(uci);
    if (!parts) break;
    try {
      moves.push(chess.move(parts));
    } catch {
      break;
    }
  }
  return { moves, final: chess };
}

/** Recognises the classic back-rank pattern in a finished mating line. */
function isBackRankMate(final: Chess, lastMove: Move | undefined): boolean {
  if (!lastMove || !final.isCheckmate()) return false;
  if (!["r", "q"].includes(lastMove.piece)) return false;

  const matedColor = final.turn();
  const kingSquare = final.findPiece({ type: "k", color: matedColor })[0];
  if (!kingSquare) return false;

  const homeRank = matedColor === "w" ? "1" : "8";
  return kingSquare[1] === homeRank && lastMove.to[1] === homeRank;
}

/**
 * Produces a one-line human gloss describing what the engine is actually threatening,
 * derived entirely from the principal variation it reported.
 */
export function glossFromPv(fen: string, info: EngineInfo): string {
  if (info.pv.length === 0) return "";

  const { moves, final } = replay(fen, info.pv);
  if (moves.length === 0) return "";

  const first = moves[0];
  const last = moves[moves.length - 1];

  // Mating lines get the most specific description we can give.
  if (info.mate !== undefined && info.mate !== 0) {
    const n = Math.abs(info.mate);
    if (info.mate < 0) {
      return `Defending: your side is mating in ${n}, engine plays the longest resistance.`;
    }
    const pattern = isBackRankMate(final, last) ? "back-rank mate" : "forced mate";
    return `Threatens ${pattern} in ${n}, starting with ${first.san}.`;
  }

  // Otherwise describe the concrete consequences of the first move.
  const afterFirst = new Chess(fen);
  afterFirst.move({ from: first.from, to: first.to, promotion: first.promotion as never });
  const report = analyseThreats(afterFirst.fen(), first.from, first.to);

  const clauses: string[] = [];

  if (first.isPromotion()) {
    clauses.push(`promotes to a ${PIECE_NAME[first.promotion ?? "q"]}`);
  }
  if (first.isCapture()) {
    const taken = first.captured ? PIECE_NAME[first.captured] : "material";
    clauses.push(`takes the ${taken} on ${first.to}`);
  }
  if (report.check) {
    clauses.push(afterFirst.isCheckmate() ? "delivers mate" : "checks the king");
  }

  // Name the single biggest hanging target, which is what a human would actually notice.
  const biggest = report.hanging
    .map((sq) => ({ sq, value: PIECE_VALUE[afterFirst.get(sq as Square)?.type ?? "p"] ?? 0 }))
    .sort((a, b) => b.value - a.value)[0];

  if (biggest && biggest.value > 0) {
    const type = afterFirst.get(biggest.sq as Square)?.type ?? "p";
    clauses.push(`hits the ${PIECE_NAME[type]} on ${biggest.sq}`);
  }

  if (report.replies <= 3) {
    clauses.push(`leaves only ${report.replies} legal repl${report.replies === 1 ? "y" : "ies"}`);
  }

  if (clauses.length === 0) {
    const gain = info.cp ?? 0;
    if (Math.abs(gain) < 40) return `${first.san} keeps the position balanced and waits.`;
    return gain > 0
      ? `${first.san} builds a lasting positional edge.`
      : `${first.san} is the toughest defence available.`;
  }

  const sentence =
    clauses.length === 1
      ? clauses[0]
      : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;

  return `${first.san} ${sentence}.`;
}
