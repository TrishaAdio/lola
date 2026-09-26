/**
 * Game-ending rules, following Chess.com's published ruleset.
 *
 * chess.js provides the primitives, but its `isGameOver()` treats threefold repetition and
 * the 50-move rule as automatic endings and its insufficient-material check misses a
 * case Chess.com draws. So endings are decided here instead.
 *
 * Sources:
 *  - https://support.chess.com/en/articles/8572743-how-do-draws-work
 *  - https://support.chess.com/en/articles/8705277-what-does-insufficient-mating-material-mean
 *  - https://support.chess.com/en/articles/8557986-my-opponent-ran-out-of-time-why-was-it-a-draw
 */
import { Chess } from "chess.js";
import type { Color, PieceSymbol, Square } from "chess.js";

export type GameOverReason =
  | "checkmate"
  | "stalemate"
  | "insufficient-material"
  | "threefold-repetition"
  | "fivefold-repetition"
  | "fifty-move-rule"
  | "seventy-five-move-rule"
  | "agreement"
  | "resignation"
  | "engine-resignation"
  | "timeout"
  | "timeout-vs-insufficient-material";

export interface GameOverInfo {
  reason: GameOverReason;
  /** Winner, or null for a draw. */
  winner: Color | null;
  detail: string;
}

export type ClaimKind = "threefold-repetition" | "fifty-move-rule";

/**
 * - "claim": threefold and 50-move are draws the player must claim; fivefold and the
 *   75-move rule end the game automatically so it can never run forever (FIDE 9.6).
 * - "automatic": threefold and 50-move end the game immediately, which is what
 *   Chess.com itself does.
 */
export type DrawClaimMode = "claim" | "automatic";

export interface RulesState {
  /** Set when the game has ended on its own, without anyone claiming. */
  terminal: GameOverInfo | null;
  /** Draws the side that wants one may claim right now. */
  claimable: ClaimKind[];
  /** Times the current position has occurred, including now. */
  repetitions: number;
  /** Half-moves since the last capture or pawn move. */
  halfmoveClock: number;
}

const colorName = (c: Color) => (c === "w" ? "White" : "Black");

/**
 * Identity of a position for repetition purposes: same pieces on the same squares, same
 * side to move, same castling rights and same en passant possibility.
 *
 * chess.js only writes the en passant square into the FEN when an en passant capture is
 * actually legal (pins included), so the first four FEN fields are exactly that identity.
 */
export function positionKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/** How many times the current position of `chess` has occurred in its game. */
export function repetitionCount(chess: Chess, startFen: string): number {
  const target = positionKey(chess.fen());
  const replay = new Chess(startFen);
  let count = positionKey(replay.fen()) === target ? 1 : 0;
  for (const move of chess.history({ verbose: true })) {
    replay.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (positionKey(replay.fen()) === target) count++;
  }
  return count;
}

interface PieceOnBoard {
  type: PieceSymbol;
  color: Color;
  square: Square;
}

function nonKingPieces(chess: Chess): PieceOnBoard[] {
  const out: PieceOnBoard[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type !== "k") out.push(cell);
    }
  }
  return out;
}

function squareColor(square: Square): "light" | "dark" {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return (file + rank) % 2 === 0 ? "dark" : "light";
}

const allBishopsOneColor = (pieces: PieceOnBoard[]) =>
  pieces.length > 0 &&
  pieces.every((p) => p.type === "b") &&
  new Set(pieces.map((p) => squareColor(p.square))).size === 1;

/**
 * Chess.com's automatic insufficient-material draw.
 *
 * Covers FIDE's dead positions (K v K, K+minor v K, bishops all on one colour) plus the
 * USCF case Chess.com adopts: K+N+N v a lone king is a draw because the mate cannot be
 * *forced*, even though FIDE would play on because a helpmate is legally possible.
 * If the lone king's side has anything else at all, the game continues.
 */
export function isInsufficientMaterial(chess: Chess): boolean {
  const pieces = nonKingPieces(chess);

  if (pieces.length === 0) return true;
  if (pieces.length === 1 && (pieces[0].type === "b" || pieces[0].type === "n")) return true;
  if (allBishopsOneColor(pieces)) return true;

  // USCF: two knights cannot force mate against a bare king.
  if (pieces.length === 2 && pieces.every((p) => p.type === "n")) {
    return pieces[0].color === pieces[1].color;
  }
  return false;
}

/**
 * Whether `color` still has material to win on time.
 *
 * Chess.com follows USCF here: the player with time left must be able to *force* mate, so a
 * lone king, king + one minor piece, or same-coloured bishops cannot win on time no matter
 * what the flagged player has left. FIDE would instead award the win whenever any legal
 * sequence could mate - e.g. K+B against K+pawn, where the pawn can block its own king.
 *
 * Chess.com's one documented exception: K+N+N does win on time, because two knights can
 * technically mate even though they cannot force it.
 */
export function hasTimeoutMatingMaterial(chess: Chess, color: Color): boolean {
  const own = nonKingPieces(chess).filter((p) => p.color === color);
  if (own.length === 0) return false;
  if (own.length === 1 && (own[0].type === "b" || own[0].type === "n")) return false;
  if (allBishopsOneColor(own)) return false;
  return true;
}

/** Result when `flagged` runs out of time in the current position. */
export function adjudicateTimeout(chess: Chess, flagged: Color): GameOverInfo {
  const opponent: Color = flagged === "w" ? "b" : "w";
  if (!hasTimeoutMatingMaterial(chess, opponent)) {
    return {
      reason: "timeout-vs-insufficient-material",
      winner: null,
      detail: `${colorName(flagged)} ran out of time, but ${colorName(opponent)} has insufficient mating material. Draw.`,
    };
  }
  return {
    reason: "timeout",
    winner: opponent,
    detail: `${colorName(flagged)} ran out of time. ${colorName(opponent)} wins.`,
  };
}

const DRAW_TEXT: Record<ClaimKind, string> = {
  "threefold-repetition": "Draw by threefold repetition.",
  "fifty-move-rule": "Draw by the 50-move rule.",
};

export function claimedDraw(kind: ClaimKind, claimant: "you" | "engine"): GameOverInfo {
  const who = claimant === "you" ? "You claimed" : "The engine claimed";
  return { reason: kind, winner: null, detail: `${who} a draw. ${DRAW_TEXT[kind]}` };
}

/**
 * Decides whether the game has ended and which draws are claimable.
 * Checkmate takes precedence over every draw rule, as in FIDE 9.6.
 */
export function evaluateRules(chess: Chess, startFen: string, mode: DrawClaimMode): RulesState {
  const halfmoveClock = Number(chess.fen().split(" ")[4]) || 0;
  const repetitions = repetitionCount(chess, startFen);

  const state = (terminal: GameOverInfo | null, claimable: ClaimKind[] = []): RulesState => ({
    terminal,
    claimable,
    repetitions,
    halfmoveClock,
  });

  if (chess.isCheckmate()) {
    const winner: Color = chess.turn() === "w" ? "b" : "w";
    return state({ reason: "checkmate", winner, detail: `Checkmate. ${colorName(winner)} wins.` });
  }
  if (chess.isStalemate()) {
    return state({ reason: "stalemate", winner: null, detail: "Stalemate. Draw." });
  }
  if (isInsufficientMaterial(chess)) {
    return state({
      reason: "insufficient-material",
      winner: null,
      detail: "Insufficient mating material. Draw.",
    });
  }
  if (repetitions >= 5) {
    return state({
      reason: "fivefold-repetition",
      winner: null,
      detail: "The position occurred five times. Draw.",
    });
  }
  if (halfmoveClock >= 150) {
    return state({
      reason: "seventy-five-move-rule",
      winner: null,
      detail: "75 moves without a capture or pawn move. Draw.",
    });
  }

  const claimable: ClaimKind[] = [];
  if (repetitions >= 3) claimable.push("threefold-repetition");
  if (halfmoveClock >= 100) claimable.push("fifty-move-rule");

  if (mode === "automatic" && claimable.length > 0) {
    return state({ reason: claimable[0], winner: null, detail: DRAW_TEXT[claimable[0]] });
  }
  return state(null, claimable);
}
