/**
 * Static strategic features of a position, from one side's point of view.
 *
 * Scores are in rough centipawn-like units so they can sit next to Stockfish's eval, but
 * they are only ever compared *between candidate moves Stockfish already rates as close*.
 * They never override tactics.
 */
import type { Color } from "chess.js";
import {
  forward,
  kingZone,
  onBoard,
  other,
  pawnsOf,
  pieceMaterial,
  relRank,
  sqIndex,
  wingOf,
} from "./board";
import type { StrategicBoard } from "./board";

export interface Features {
  kingSafety: number;
  activity: number;
  structure: number;
}

// ---------- king safety ------------------------------------------------------------------

/**
 * Pawn shield, attackers on the king zone, and a king stuck in the centre. Scaled by how
 * much attacking material the opponent still has - a bare king in an endgame is fine.
 */
export function kingSafety(board: StrategicBoard, color: Color): number {
  const king = board.king[color];
  if (!king) return 0;
  const opp = other(color);

  const oppQueens = board.pieces.filter((p) => p.color === opp && p.type === "q").length;
  const threat = Math.min(1, Math.max(0.15, (pieceMaterial(board, opp) + oppQueens * 6) / 31));

  let score = 0;
  const kRel = relRank(king.rank, color);
  const step = forward(color);
  const ownPawns = pawnsOf(board, color);

  // A king that can still castle will not live on its current file, so its present
  // pawn cover says little. Only the shield of a king that has committed is scored.
  const uncommitted = kRel === 0 && king.file === 4 && board.canCastle[color];

  if (kRel <= 1 && !uncommitted) {
    for (let df = -1; df <= 1; df++) {
      const file = king.file + df;
      if (file < 0 || file > 7) continue;
      const near = board.at(file, king.rank + step);
      const far = board.at(file, king.rank + 2 * step);
      if (near?.type === "p" && near.color === color) score += 10;
      else if (far?.type === "p" && far.color === color) score += 6;
      else {
        score -= 12;
        // A file with no pawn of ours in front of the king is a highway for rooks.
        if (!ownPawns.some((p) => p.file === file)) score -= 8;
      }
    }
  } else if (oppQueens > 0) {
    score -= 20 * (kRel - 1);
  }

  const zone = kingZone(board, color);
  score -= zone.reduce((sum, i) => sum + board.attacks[opp][i], 0) * 7;

  if (wingOf(king.file) === "center" && kRel === 0 && oppQueens > 0) score -= 18;
  if (wingOf(king.file) !== "center" && kRel === 0) score += 12;

  return score * threat;
}

// ---------- activity & space ------------------------------------------------------------

const CENTER = [sqIndex(3, 3), sqIndex(4, 3), sqIndex(3, 4), sqIndex(4, 4)];

/** Mobility on safe squares, central control, outposts, open files and space. */
export function activity(board: StrategicBoard, color: Color): number {
  const opp = other(color);
  let score = 0;

  // Squares our pieces reach that an enemy pawn doesn't cover.
  for (let i = 0; i < 64; i++) {
    if (board.pieceAttacks[color][i] > 0 && board.pawnAttacks[opp][i] === 0) score += 1.5;
  }

  for (const i of CENTER) {
    score += board.attacks[color][i] * 4;
    const p = board.pieces.find((x) => x.file + x.rank * 8 === i);
    if (p?.type === "p" && p.color === color) score += 6;
  }
  for (let f = 2; f <= 5; f++) {
    for (let r = 2; r <= 5; r++) score += board.attacks[color][sqIndex(f, r)] > 0 ? 1 : 0;
  }

  const ownPawnFiles = new Set(pawnsOf(board, color).map((p) => p.file));
  const oppPawns = pawnsOf(board, opp);
  const oppPawnFiles = new Set(oppPawns.map((p) => p.file));

  for (const piece of board.pieces) {
    if (piece.color !== color) continue;

    if (piece.type === "n" || piece.type === "b") {
      const rr = relRank(piece.rank, color);
      const supported = board.pawnAttacks[color][sqIndex(piece.file, piece.rank)] > 0;
      // An outpost: forward, pawn-supported, and no enemy pawn can ever challenge it.
      const challengeable = oppPawns.some(
        (p) =>
          Math.abs(p.file - piece.file) === 1 &&
          (color === "w" ? p.rank > piece.rank : p.rank < piece.rank),
      );
      if (rr >= 3 && rr <= 5 && supported && !challengeable) {
        score += piece.type === "n" ? 14 : 8;
      }
    }

    if (piece.type === "r" && !ownPawnFiles.has(piece.file)) {
      score += oppPawnFiles.has(piece.file) ? 5 : 10;
    }
  }

  // Space: advanced central pawns.
  for (const p of pawnsOf(board, color)) {
    if (p.file >= 2 && p.file <= 5) score += Math.max(0, relRank(p.rank, color) - 2) * 2;
  }

  return score;
}

// ---------- pawn structure --------------------------------------------------------------

/**
 * Pawn health: isolated, doubled and backward pawns, holes in front of a castled king,
 * and passed pawns as the one structural asset.
 */
export function structure(board: StrategicBoard, color: Color): number {
  const opp = other(color);
  const own = pawnsOf(board, color);
  const theirs = pawnsOf(board, opp);
  const step = forward(color);
  let score = 0;

  const byFile = new Map<number, number>();
  for (const p of own) byFile.set(p.file, (byFile.get(p.file) ?? 0) + 1);
  for (const count of byFile.values()) if (count > 1) score -= 10 * (count - 1);

  for (const p of own) {
    const neighbours = own.filter((q) => Math.abs(q.file - p.file) === 1);
    const rr = relRank(p.rank, color);

    if (neighbours.length === 0) {
      score -= 12;
      if (!theirs.some((q) => q.file === p.file)) score -= 4;
    } else if (neighbours.every((q) => relRank(q.rank, color) > rr)) {
      // Backward: its neighbours have left it behind and its advance square is covered.
      const stopRank = p.rank + step;
      if (onBoard(p.file, stopRank) && board.pawnAttacks[opp][sqIndex(p.file, stopRank)] > 0) {
        score -= 9;
      }
    }

    const passed = !theirs.some(
      (q) =>
        Math.abs(q.file - p.file) <= 1 && (color === "w" ? q.rank > p.rank : q.rank < p.rank),
    );
    if (passed) score += 6 + 4 * rr;
  }

  // Holes in front of a castled king: squares no pawn of ours can ever cover again.
  const king = board.king[color];
  const oppAttackers = board.pieces.some(
    (p) => p.color === opp && (p.type === "q" || p.type === "n" || p.type === "b"),
  );
  if (king && oppAttackers && relRank(king.rank, color) === 0 && wingOf(king.file) !== "center") {
    const holeRank = color === "w" ? 2 : 5;
    for (let df = -1; df <= 1; df++) {
      const file = king.file + df;
      if (file < 0 || file > 7) continue;
      const coverable = own.some(
        (p) => Math.abs(p.file - file) === 1 && relRank(p.rank, color) < relRank(holeRank, color),
      );
      if (!coverable) score -= 7;
    }
  }

  return score;
}

export function features(board: StrategicBoard, color: Color): Features {
  return {
    kingSafety: kingSafety(board, color),
    activity: activity(board, color),
    structure: structure(board, color),
  };
}
