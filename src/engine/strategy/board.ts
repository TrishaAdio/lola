/**
 * Small, fast board model shared by the strategic evaluators.
 *
 * Built once per position from chess.js, then queried many times, so each feature
 * doesn't re-walk the board or re-ask chess.js for attackers.
 */
import type { Chess, Color, PieceSymbol, Square } from "chess.js";

export const FILES = "abcdefgh";

export interface BoardPiece {
  type: PieceSymbol;
  color: Color;
  square: Square;
  file: number;
  rank: number;
}

export interface StrategicBoard {
  pieces: BoardPiece[];
  at: (file: number, rank: number) => BoardPiece | undefined;
  /** Attackers of each square (index file + rank * 8), split by colour. */
  attacks: Record<Color, number[]>;
  /** Pawn-only attacks - what makes a square permanently unsafe or an outpost. */
  pawnAttacks: Record<Color, number[]>;
  /** Non-pawn, non-king attacks - piece activity. */
  pieceAttacks: Record<Color, number[]>;
  king: Record<Color, BoardPiece | undefined>;
  /** Whether each side still has any castling right. */
  canCastle: Record<Color, boolean>;
}

export const sqIndex = (file: number, rank: number) => file + rank * 8;
export const sqName = (file: number, rank: number) => `${FILES[file]}${rank + 1}` as Square;
export const onBoard = (file: number, rank: number) =>
  file >= 0 && file < 8 && rank >= 0 && rank < 8;

/** Rank counted from `color`'s own back rank (0) to the far side (7). */
export const relRank = (rank: number, color: Color) => (color === "w" ? rank : 7 - rank);
/** One step towards the opponent for `color`. */
export const forward = (color: Color) => (color === "w" ? 1 : -1);
export const other = (c: Color): Color => (c === "w" ? "b" : "w");

export const PIECE_POINTS: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function buildBoard(chess: Chess): StrategicBoard {
  const pieces: BoardPiece[] = [];
  const grid: (BoardPiece | undefined)[] = new Array(64);
  const king: Record<Color, BoardPiece | undefined> = { w: undefined, b: undefined };

  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const file = cell.square.charCodeAt(0) - 97;
      const rank = Number(cell.square[1]) - 1;
      const piece: BoardPiece = { ...cell, file, rank };
      pieces.push(piece);
      grid[sqIndex(file, rank)] = piece;
      if (cell.type === "k") king[cell.color] = piece;
    }
  }

  const empty = () => new Array<number>(64).fill(0);
  const attacks = { w: empty(), b: empty() };
  const pawnAttacks = { w: empty(), b: empty() };
  const pieceAttacks = { w: empty(), b: empty() };

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const i = sqIndex(file, rank);
      const name = sqName(file, rank);
      for (const color of ["w", "b"] as const) {
        for (const from of chess.attackers(name, color)) {
          const f = from.charCodeAt(0) - 97;
          const r = Number(from[1]) - 1;
          const attacker = grid[sqIndex(f, r)];
          attacks[color][i]++;
          if (attacker?.type === "p") pawnAttacks[color][i]++;
          else if (attacker && attacker.type !== "k") pieceAttacks[color][i]++;
        }
      }
    }
  }

  const rights = chess.fen().split(" ")[2] ?? "-";
  return {
    pieces,
    canCastle: { w: /[KQ]/.test(rights), b: /[kq]/.test(rights) },
    at: (file, rank) => (onBoard(file, rank) ? grid[sqIndex(file, rank)] : undefined),
    attacks,
    pawnAttacks,
    pieceAttacks,
    king,
  };
}

export function pawnsOf(board: StrategicBoard, color: Color): BoardPiece[] {
  return board.pieces.filter((p) => p.type === "p" && p.color === color);
}

/** Total piece value (pawns included), kings excluded. */
export function material(board: StrategicBoard, color: Color): number {
  return board.pieces
    .filter((p) => p.color === color)
    .reduce((sum, p) => sum + PIECE_POINTS[p.type], 0);
}

/** Non-pawn material, used to judge game phase and trading. */
export function pieceMaterial(board: StrategicBoard, color: Color): number {
  return board.pieces
    .filter((p) => p.color === color && p.type !== "p")
    .reduce((sum, p) => sum + PIECE_POINTS[p.type], 0);
}

/** The king plus its neighbouring squares. */
export function kingZone(board: StrategicBoard, color: Color): number[] {
  const k = board.king[color];
  if (!k) return [];
  const zone: number[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (onBoard(k.file + df, k.rank + dr)) zone.push(sqIndex(k.file + df, k.rank + dr));
    }
  }
  return zone;
}

export type Wing = "queenside" | "center" | "kingside";

export function wingOf(file: number): Wing {
  if (file <= 2) return "queenside";
  if (file >= 5) return "kingside";
  return "center";
}
