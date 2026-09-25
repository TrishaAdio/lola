import { Chess } from "chess.js";
import type { Color, Square } from "chess.js";
import { opposite } from "./moves";

export const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Total pawn-equivalent value of a list of piece types. */
export function materialValue(pieces: string[]): number {
  return pieces.reduce((sum, type) => sum + (PIECE_VALUE[type] ?? 0), 0);
}

export interface ThreatReport {
  /** Whether the side that just moved is giving check. */
  check: boolean;
  /** Legal replies available to the side now on move. Fewer = more forcing. */
  replies: number;
  /** Enemy-occupied squares currently attacked by the side that just moved. */
  attacked: Square[];
  /** Attacked enemy pieces that are insufficiently defended. */
  hanging: Square[];
  /** Total value (in pawns) of insufficiently defended enemy material. */
  materialAtRisk: number;
  /** Squares the mover's last move came from / went to, for highlighting. */
  from?: Square;
  to?: Square;
}

/**
 * Analyses the pressure the side that just moved is exerting.
 *
 * `fen` must be the position *after* that move, so the side to move is the one under
 * pressure and `mover` is its opponent.
 */
export function analyseThreats(fen: string, from?: Square, to?: Square): ThreatReport {
  const chess = new Chess(fen);
  const defender: Color = chess.turn();
  const mover: Color = opposite(defender);

  const attacked: Square[] = [];
  const hanging: Square[] = [];
  let materialAtRisk = 0;

  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== defender) continue;

      const attackers = chess.attackers(cell.square, mover);
      if (attackers.length === 0) continue;
      attacked.push(cell.square);

      if (cell.type === "k") continue; // the king is handled by `check`

      const defenders = chess.attackers(cell.square, defender);
      const victimValue = PIECE_VALUE[cell.type] ?? 0;
      const cheapestAttacker = Math.min(
        ...attackers.map((sq) => PIECE_VALUE[chess.get(sq)?.type ?? "p"] ?? 1),
      );

      // Undefended, outnumbered, or winnable by a cheaper piece => real material threat.
      const insufficient =
        defenders.length === 0 ||
        attackers.length > defenders.length ||
        cheapestAttacker < victimValue;

      if (insufficient) {
        hanging.push(cell.square);
        materialAtRisk += victimValue;
      }
    }
  }

  return {
    check: chess.inCheck(),
    replies: chess.moves().length,
    attacked,
    hanging,
    materialAtRisk,
    from,
    to,
  };
}

export interface PressureBreakdown {
  check: number;
  restriction: number;
  material: number;
  hanging: number;
  forcing: number;
  repetition: number;
  total: number;
}

export interface PressureInput {
  report: ThreatReport;
  /** The move was a capture. */
  capture: boolean;
  /** The move was a promotion. */
  promotion: boolean;
  /** Playing this move allows a draw claim (repetition / 50-move). */
  allowsDrawClaim: boolean;
  /** Engine's current evaluation in centipawns, from the engine's point of view. */
  engineCp: number;
}

/**
 * Scores how much pressure a candidate move keeps. This is only ever used to break ties
 * between moves Stockfish already considers near-equal - it never overrides evaluation.
 */
export function pressureScore(input: PressureInput): PressureBreakdown {
  const { report } = input;

  const check = report.check ? 55 : 0;
  // Cutting the opponent's options is the core "keep them on the ropes" term.
  const restriction = Math.max(0, 40 - report.replies) * 2.5;
  const material = report.materialAtRisk * 8;
  const hanging = report.hanging.length * 10;
  const forcing = (input.capture ? 12 : 0) + (input.promotion ? 25 : 0);

  // Refuse to steer into a draw while winning or equal. When genuinely losing, a
  // repetition is a resource rather than a concession, so don't punish it.
  const losing = input.engineCp < -120;
  const repetition = input.allowsDrawClaim && !losing ? -100_000 : 0;

  const total = check + restriction + material + hanging + forcing + repetition;
  return { check, restriction, material, hanging, forcing, repetition, total };
}
