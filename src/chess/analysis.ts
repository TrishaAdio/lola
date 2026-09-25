import type { Color } from "chess.js";
import { formatSanLine, pvToSan } from "./moves";

/**
 * Engine assessment of a position, normalised to White's point of view.
 * `mate` is mate distance for White (positive) or against White (negative).
 */
export interface Assessment {
  whiteCp?: number;
  whiteMate?: number;
  depth: number;
  /** Best line from this position, as UCI moves. */
  bestLine: string[];
}

export interface MoveRecord {
  ply: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  byEngine: boolean;
  capturedPiece?: string;
  /** Engine assessment of the position before this move was played. */
  before?: Assessment;
  /** Engine assessment of the position after this move was played. */
  after?: Assessment;
}

/** Win percentage (0-100) for White, given a White-POV assessment. */
export function assessmentToWhiteWinPercent(
  a: Assessment | null | undefined,
): number | undefined {
  if (!a) return undefined;
  if (a.whiteMate !== undefined && a.whiteMate !== 0) return a.whiteMate > 0 ? 100 : 0;
  if (a.whiteCp === undefined) return undefined;
  return 100 / (1 + Math.exp(-0.00368208 * a.whiteCp));
}

/**
 * Per-move accuracy using Lichess's published win-percentage model.
 * https://lichess.org/page/accuracy
 */
export function moveAccuracy(winPercentBefore: number, winPercentAfter: number): number {
  const drop = Math.max(0, winPercentBefore - winPercentAfter);
  const raw = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, raw));
}

export interface MoveQuality {
  record: MoveRecord;
  /** Win% for the mover before and after their move. */
  moverWinBefore: number;
  moverWinAfter: number;
  /** Win% surrendered by this move (0 = perfect). */
  winLoss: number;
  /** Centipawn loss from the mover's perspective, when both evals are centipawn scores. */
  cpLoss?: number;
  accuracy: number;
  classification: "best" | "good" | "inaccuracy" | "mistake" | "blunder";
}

function classify(winLoss: number): MoveQuality["classification"] {
  if (winLoss < 2) return "best";
  if (winLoss < 5) return "good";
  if (winLoss < 10) return "inaccuracy";
  if (winLoss < 20) return "mistake";
  return "blunder";
}

/** Computes quality for a single move, or null when we lack evals on both sides of it. */
export function evaluateMove(record: MoveRecord): MoveQuality | null {
  const whiteBefore = assessmentToWhiteWinPercent(record.before);
  const whiteAfter = assessmentToWhiteWinPercent(record.after);
  if (whiteBefore === undefined || whiteAfter === undefined) return null;

  const moverWinBefore = record.color === "w" ? whiteBefore : 100 - whiteBefore;
  const moverWinAfter = record.color === "w" ? whiteAfter : 100 - whiteAfter;
  const winLoss = Math.max(0, moverWinBefore - moverWinAfter);

  let cpLoss: number | undefined;
  const cpBefore = record.before?.whiteCp;
  const cpAfter = record.after?.whiteCp;
  if (cpBefore !== undefined && cpAfter !== undefined) {
    const signed = record.color === "w" ? cpBefore - cpAfter : cpAfter - cpBefore;
    cpLoss = Math.max(0, signed);
  }

  return {
    record,
    moverWinBefore,
    moverWinAfter,
    winLoss,
    cpLoss,
    accuracy: moveAccuracy(moverWinBefore, moverWinAfter),
    classification: classify(winLoss),
  };
}

export interface PlayerReport {
  color: Color;
  moves: number;
  /** Average per-move accuracy, 0-100. */
  accuracy: number;
  averageCpLoss?: number;
  counts: Record<MoveQuality["classification"], number>;
  worst?: MoveQuality;
  /** Engine's recommended line at the worst moment, in SAN with move numbers. */
  worstBetterLine?: string;
}

export interface GameSummary {
  user: PlayerReport;
  engine: PlayerReport;
  qualities: MoveQuality[];
}

function buildReport(color: Color, qualities: MoveQuality[]): PlayerReport {
  const counts: PlayerReport["counts"] = {
    best: 0,
    good: 0,
    inaccuracy: 0,
    mistake: 0,
    blunder: 0,
  };
  for (const q of qualities) counts[q.classification]++;

  const accuracy =
    qualities.length > 0 ? qualities.reduce((s, q) => s + q.accuracy, 0) / qualities.length : 0;

  const cpLosses = qualities.map((q) => q.cpLoss).filter((v): v is number => v !== undefined);
  const averageCpLoss =
    cpLosses.length > 0 ? cpLosses.reduce((s, v) => s + v, 0) / cpLosses.length : undefined;

  const worst = qualities.reduce<MoveQuality | undefined>(
    (acc, q) => (!acc || q.winLoss > acc.winLoss ? q : acc),
    undefined,
  );

  let worstBetterLine: string | undefined;
  if (worst?.record.before?.bestLine?.length) {
    const san = pvToSan(worst.record.fenBefore, worst.record.before.bestLine, 8);
    if (san.length > 0) worstBetterLine = formatSanLine(worst.record.fenBefore, san);
  }

  return {
    color,
    moves: qualities.length,
    accuracy,
    averageCpLoss,
    counts,
    worst: worst && worst.winLoss > 0 ? worst : undefined,
    worstBetterLine,
  };
}

export function summariseGame(records: MoveRecord[], userColor: Color): GameSummary {
  const qualities = records
    .map(evaluateMove)
    .filter((q): q is MoveQuality => q !== null);

  return {
    user: buildReport(userColor, qualities.filter((q) => !q.record.byEngine)),
    engine: buildReport(
      userColor === "w" ? "b" : "w",
      qualities.filter((q) => q.record.byEngine),
    ),
    qualities,
  };
}
