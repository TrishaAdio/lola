import { Chess } from "chess.js";
import type { Color, Move, PieceSymbol, Square } from "chess.js";

export interface UciMoveParts {
  from: Square;
  to: Square;
  promotion?: Exclude<PieceSymbol, "p" | "k">;
}

export function parseUciMove(uci: string): UciMoveParts | null {
  if (uci.length < 4) return null;
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promo = uci[4]?.toLowerCase();
  const promotion =
    promo && "qrbn".includes(promo) ? (promo as UciMoveParts["promotion"]) : undefined;
  return { from, to, promotion };
}

export function moveToUci(move: Pick<Move, "from" | "to" | "promotion">): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

/** Applies a UCI move to a copy of `fen`. Returns null when illegal. */
export function applyUci(fen: string, uci: string): { chess: Chess; move: Move } | null {
  const parts = parseUciMove(uci);
  if (!parts) return null;
  const chess = new Chess(fen);
  try {
    const move = chess.move(parts);
    return { chess, move };
  } catch {
    return null;
  }
}

/** Converts a PV of UCI moves into SAN, stopping at the first illegal move. */
export function pvToSan(fen: string, pv: string[], maxPlies = Infinity): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const uci of pv.slice(0, maxPlies)) {
    const parts = parseUciMove(uci);
    if (!parts) break;
    try {
      out.push(chess.move(parts).san);
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Renders a SAN sequence with move numbers, e.g. `14...Nxe4 15.Qh5 Rf8`.
 */
export function formatSanLine(fen: string, sanMoves: string[]): string {
  const probe = new Chess(fen);
  let moveNumber = probe.moveNumber();
  let turn: Color = probe.turn();
  const parts: string[] = [];

  sanMoves.forEach((san, i) => {
    if (turn === "w") {
      parts.push(`${moveNumber}.${san}`);
    } else {
      parts.push(i === 0 ? `${moveNumber}...${san}` : san);
      moveNumber++;
    }
    turn = turn === "w" ? "b" : "w";
  });

  return parts.join(" ");
}

export function opposite(color: Color): Color {
  return color === "w" ? "b" : "w";
}

/** Does this move send a pawn to the last rank? */
export function isPromotionMove(fen: string, from: Square, to: Square): boolean {
  const chess = new Chess(fen);
  const piece = chess.get(from);
  if (!piece || piece.type !== "p") return false;
  const lastRank = piece.color === "w" ? "8" : "1";
  if (to[1] !== lastRank) return false;
  // Confirm at least one legal promotion exists from here.
  return chess
    .moves({ square: from, verbose: true })
    .some((m) => m.to === to && Boolean(m.promotion));
}


// ---------------------------------------------------------------------------------------
// User move resolution
//
// Every way a human can express a move - drag, click, typed text - resolves through
// here, so the board and the text box can never disagree about what is legal.
// ---------------------------------------------------------------------------------------

export interface ResolvedMove {
  from: Square;
  to: Square;
  promotion?: Exclude<PieceSymbol, "p" | "k">;
}

/**
 * Maps a board gesture onto a legal move, or null.
 *
 * Accepts the standard castling gesture (king two squares) and Chess.com's alternative of
 * dropping the king onto its own rook.
 */
export function resolveBoardMove(
  chess: Chess,
  from: Square,
  to: Square,
  promotion?: string,
): ResolvedMove | null {
  const legal = chess.moves({ square: from, verbose: true });

  const exact = legal.find(
    (m) => m.to === to && (m.promotion === undefined || m.promotion === promotion),
  );
  if (exact) return { from: exact.from, to: exact.to, promotion: exact.promotion as ResolvedMove["promotion"] };

  // King dropped on its own rook: treat as castling towards that rook.
  const mover = chess.get(from);
  const target = chess.get(to);
  if (
    mover?.type === "k" &&
    target?.type === "r" &&
    target.color === mover.color &&
    from[1] === to[1]
  ) {
    const flag = to.charCodeAt(0) > from.charCodeAt(0) ? "k" : "q";
    const castle = legal.find((m) => m.flags.includes(flag));
    if (castle) return { from: castle.from, to: castle.to };
  }

  return null;
}

/** Board squares that complete a legal move from `from`, including rook squares for castling. */
export function boardTargets(chess: Chess, from: Square): Square[] {
  const legal = chess.moves({ square: from, verbose: true });
  const targets = new Set<Square>(legal.map((m) => m.to));
  const rank = from[1];
  for (const m of legal) {
    if (m.flags.includes("k")) targets.add(`h${rank}` as Square);
    if (m.flags.includes("q")) targets.add(`a${rank}` as Square);
  }
  return [...targets];
}

/**
 * Normalises typed notation into something chess.js parses: castling written with zeros,
 * lower case or no hyphen, and trailing annotation marks.
 */
export function normalizeTypedMove(input: string): string {
  const text = input.trim().replace(/[!?]+$/, "");
  const castle = text.replace(/[+#]$/, "").toLowerCase().replace(/[\s-]/g, "").replace(/0/g, "o");
  if (castle === "ooo") return "O-O-O";
  if (castle === "oo") return "O-O";
  return text;
}

export type TypedMoveResult =
  | { kind: "move"; move: ResolvedMove }
  | { kind: "needs-promotion"; from: Square; to: Square }
  | { kind: "illegal" };

/**
 * Parses typed notation. A pawn move to the last rank written without a piece (`b8`,
 * `bxc8`) is reported as needing a choice rather than silently promoted to a queen.
 */
export function resolveTypedMove(chess: Chess, input: string): TypedMoveResult {
  const text = normalizeTypedMove(input);
  if (!text) return { kind: "illegal" };

  const probe = new Chess(chess.fen());
  try {
    const m = probe.move(text);
    return { kind: "move", move: { from: m.from, to: m.to, promotion: m.promotion as ResolvedMove["promotion"] } };
  } catch {
    /* maybe a promotion typed without its piece */
  }

  for (const piece of ["q", "r", "b", "n"]) {
    try {
      const m = new Chess(chess.fen()).move(`${text.replace(/[+#]$/, "")}=${piece.toUpperCase()}`);
      return { kind: "needs-promotion", from: m.from, to: m.to };
    } catch {
      /* try the next piece */
    }
  }
  return { kind: "illegal" };
}

const CASTLING_HOMES: Record<string, { king: Square; rook: Square; color: Color }> = {
  K: { king: "e1", rook: "h1", color: "w" },
  Q: { king: "e1", rook: "a1", color: "w" },
  k: { king: "e8", rook: "h8", color: "b" },
  q: { king: "e8", rook: "a8", color: "b" },
};

/**
 * Removes castling rights a FEN claims but the board cannot support.
 *
 * chess.js keeps whatever rights the FEN states and will generate O-O for a king with no
 * rook, and Stockfish can crash on such a position. So every externally supplied FEN is
 * sanitised; valid rights pass through untouched.
 */
export function sanitizeCastlingRights(fen: string): { fen: string; removed: string[] } {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4 || parts[2] === "-") return { fen: parts.join(" "), removed: [] };

  const board = new Chess();
  board.load(`${parts[0]} w - - 0 1`, { skipValidation: true });

  const kept: string[] = [];
  const removed: string[] = [];
  for (const right of parts[2]) {
    const home = CASTLING_HOMES[right];
    const king = home && board.get(home.king);
    const rook = home && board.get(home.rook);
    const ok =
      home &&
      king?.type === "k" &&
      king.color === home.color &&
      rook?.type === "r" &&
      rook.color === home.color;
    (ok ? kept : removed).push(right);
  }

  parts[2] = kept.length ? kept.join("") : "-";
  return { fen: parts.join(" "), removed };
}
