/**
 * Prophylaxis: preventing the opponent's idea before it happens.
 *
 * The opponent's "most dangerous plan" is found with a null-move search: hand the
 * opponent the move in the current position and ask Stockfish what they would do with it.
 * That threat move, and how much it would gain, are passed in here. A candidate that makes
 * the threat illegal or turns it into a losing move earns a bonus proportional to the
 * threat's size - so the engine will spend a *little* eval to kill a big idea, the way a
 * grandmaster plays prophylactically.
 */
import { Chess } from "chess.js";
import type { Color, Square } from "chess.js";
import { PIECE_POINTS } from "./board";

export interface ThreatInfo {
  /** The opponent's best move if they could move now. */
  uci: string;
  san: string;
  /** Centipawns the free move would gain the opponent. */
  gainCp: number;
}

/** Below this, the opponent has no idea worth spending eval to stop. */
export const THREAT_THRESHOLD_CP = 60;

/**
 * Builds the null-move position: same board, opponent to move. Returns null when that
 * position would be illegal (we are in check) - Stockfish must never receive one.
 */
export function nullMoveFen(fen: string): string | null {
  const chess = new Chess(fen);
  if (chess.inCheck()) return null;
  const parts = fen.split(" ");
  parts[1] = parts[1] === "w" ? "b" : "w";
  parts[3] = "-";
  const flipped = parts.join(" ");
  try {
    new Chess(flipped);
    return flipped;
  } catch {
    return null;
  }
}

/** Is the piece on `square` en prise to `attackerColor` - undefended, or hit by something cheaper? */
function enPrise(chess: Chess, square: Square, attackerColor: Color): boolean {
  const piece = chess.get(square);
  if (!piece) return false;
  const attackers = chess.attackers(square, attackerColor);
  if (attackers.length === 0) return false;
  const defenders = chess.attackers(square, piece.color);
  const cheapest = Math.min(...attackers.map((s) => PIECE_POINTS[chess.get(s)?.type ?? "q"]));
  return defenders.length === 0 || cheapest < PIECE_POINTS[piece.type];
}

export interface ProphylaxisResult {
  /** 0 = threat untouched, 1 = threat made impossible. */
  prevented: number;
  how: "none" | "illegal" | "refuted" | "defused-check";
}

/**
 * Does playing the candidate (already applied: `afterFen`, opponent to move) stop the
 * threat? Checks do not count - forcing a reply delays an idea, it does not prevent it.
 */
export function assessProphylaxis(
  beforeFen: string,
  afterFen: string,
  threat: ThreatInfo,
  candidateGivesCheck: boolean,
): ProphylaxisResult {
  if (candidateGivesCheck) return { prevented: 0, how: "none" };

  const from = threat.uci.slice(0, 2) as Square;
  const to = threat.uci.slice(2, 4) as Square;
  const promotion = threat.uci[4];

  const after = new Chess(afterFen);
  const us: Color = after.turn() === "w" ? "b" : "w";

  let reply;
  try {
    reply = after.move({ from, to, promotion });
  } catch {
    return { prevented: 1, how: "illegal" };
  }

  // The threat is still playable. Does it now just lose the piece that makes it?
  if (enPrise(after, reply.to, us)) {
    const nullPos = nullMoveFen(beforeFen);
    if (nullPos) {
      const baseline = new Chess(nullPos);
      try {
        const r = baseline.move({ from, to, promotion });
        if (!enPrise(baseline, r.to, us)) return { prevented: 0.7, how: "refuted" };
      } catch {
        /* fall through */
      }
    }
  }

  // It was a check before; now it isn't.
  if (threat.san.includes("+") && !reply.san.includes("+")) {
    return { prevented: 0.5, how: "defused-check" };
  }

  return { prevented: 0, how: "none" };
}
