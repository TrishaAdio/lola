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
