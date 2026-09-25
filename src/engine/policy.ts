import { Chess } from "chess.js";
import { applyUci } from "../chess/moves";
import { comparableScore, isMateScore } from "../chess/evaluation";
import { analyseThreats, pressureScore } from "../chess/threats";
import type { PressureBreakdown, ThreatReport } from "../chess/threats";
import type { EngineInfo, SearchResult } from "./types";

/**
 * Candidate moves within this many centipawns of the best move are treated as equal, and
 * the pressure heuristic picks between them. Deliberately tight: we never trade real
 * evaluation for aggression.
 */
export const TIE_BREAK_WINDOW_CP = 25;

export interface Candidate {
  uci: string;
  san: string;
  /** MultiPV rank as returned by the engine (1 = engine's own first choice). */
  rank: number;
  info: EngineInfo;
  /** Unified score, engine's point of view; mate-aware. */
  score: number;
  report: ThreatReport;
  pressure: PressureBreakdown;
  allowsDrawClaim: boolean;
  /** Included in the tie-break pool. */
  contested: boolean;
}

export interface PolicyDecision {
  /** Position the search ran on; every candidate PV is relative to this. */
  fen: string;
  /** The move to play. */
  uci: string;
  san: string;
  /** All evaluated candidates, best-eval first. */
  candidates: Candidate[];
  chosen: Candidate;
  /** Why this move was played, for the commentary panel. */
  reason: "only-move" | "fastest-mate" | "avoid-draw" | "pressure-tiebreak" | "best-eval";
  /** The engine's own top choice, when the tie-break picked something else. */
  overrode?: Candidate;
}

/** Would playing `uci` hand the opponent a draw claim? */
function detectDrawClaim(fen: string, uci: string, history: string[]): boolean {
  // Replay known history so chess.js can see repetitions, then apply the candidate.
  const chess = new Chess(fen);
  const probe = new Chess();
  let usable = false;

  if (history.length > 0) {
    try {
      probe.reset();
      for (const san of history) probe.move(san);
      usable = probe.fen() === chess.fen();
    } catch {
      usable = false;
    }
  }

  const board = usable ? probe : chess;
  const parts = uci.length >= 4 ? uci : null;
  if (!parts) return false;
  try {
    board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] as never,
    });
  } catch {
    return false;
  }
  return board.isThreefoldRepetition() || board.isDrawByFiftyMoves() || board.isStalemate();
}

/**
 * Chooses the move to play from Stockfish's MultiPV output.
 *
 * Priority, in order:
 *  1. A forced mate - always the shortest one.
 *  2. Never volunteer a draw when not losing.
 *  3. Among moves Stockfish rates as near-equal, the one that keeps the most pressure.
 *
 * Stockfish's own search is untouched; this only picks between lines it already proposed.
 */
export function selectRuthlessMove(
  fen: string,
  result: SearchResult,
  options: { history?: string[]; ruthless?: boolean } = {},
): PolicyDecision | null {
  const { history = [], ruthless = true } = options;

  const usable = result.lines.filter((l) => l.pv.length > 0);
  if (usable.length === 0) {
    if (!result.bestmove || result.bestmove === "(none)") return null;
    const applied = applyUci(fen, result.bestmove);
    if (!applied) return null;
    const report = analyseThreats(applied.chess.fen(), applied.move.from, applied.move.to);
    const candidate: Candidate = {
      uci: result.bestmove,
      san: applied.move.san,
      rank: 1,
      info: { depth: 0, multipv: 1, pv: [result.bestmove] },
      score: 0,
      report,
      pressure: pressureScore({
        report,
        capture: applied.move.isCapture(),
        promotion: applied.move.isPromotion(),
        allowsDrawClaim: false,
        engineCp: 0,
      }),
      allowsDrawClaim: false,
      contested: false,
    };
    return {
      fen,
      uci: candidate.uci,
      san: candidate.san,
      candidates: [candidate],
      chosen: candidate,
      reason: "best-eval",
    };
  }

  const bestCp = usable[0].cp ?? 0;

  const candidates: Candidate[] = [];
  for (const info of usable) {
    const uci = info.pv[0];
    const applied = applyUci(fen, uci);
    if (!applied) continue;

    const afterFen = applied.chess.fen();
    const allowsDrawClaim = detectDrawClaim(fen, uci, history);
    const report = analyseThreats(afterFen, applied.move.from, applied.move.to);
    const pressure = pressureScore({
      report,
      capture: applied.move.isCapture(),
      promotion: applied.move.isPromotion(),
      allowsDrawClaim,
      engineCp: bestCp,
    });

    candidates.push({
      uci,
      san: applied.move.san,
      rank: info.multipv,
      info,
      score: comparableScore(info),
      report,
      pressure,
      allowsDrawClaim,
      contested: false,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score || a.rank - b.rank);
  const top = candidates[0];

  if (candidates.length === 1) {
    return {
      fen,
      uci: top.uci,
      san: top.san,
      candidates,
      chosen: top,
      reason: "only-move",
    };
  }

  if (!ruthless) {
    return { fen, uci: top.uci, san: top.san, candidates, chosen: top, reason: "best-eval" };
  }

  // 1. Forced mate: take the fastest. `score` already ranks shorter mates higher.
  if (isMateScore(top.score)) {
    const fastest = candidates.filter((c) => c.score === top.score);
    fastest.sort((a, b) => b.pressure.total - a.pressure.total || a.rank - b.rank);
    for (const c of fastest) c.contested = true;
    const chosen = fastest[0];
    return {
      fen,
      uci: chosen.uci,
      san: chosen.san,
      candidates,
      chosen,
      reason: "fastest-mate",
      overrode: chosen.rank !== top.rank ? top : undefined,
    };
  }

  // 2. Tie-break pool: only moves Stockfish rates within the window of its best.
  const pool = candidates.filter(
    (c) => !isMateScore(c.score) && top.score - c.score <= TIE_BREAK_WINDOW_CP,
  );
  for (const c of pool) c.contested = true;

  if (pool.length <= 1) {
    return { fen, uci: top.uci, san: top.san, candidates, chosen: top, reason: "best-eval" };
  }

  const ranked = [...pool].sort((a, b) => b.pressure.total - a.pressure.total || a.rank - b.rank);
  const chosen = ranked[0];

  let reason: PolicyDecision["reason"] = "best-eval";
  if (chosen.uci !== top.uci) {
    reason = top.allowsDrawClaim && !chosen.allowsDrawClaim ? "avoid-draw" : "pressure-tiebreak";
  }

  return {
    fen,
    uci: chosen.uci,
    san: chosen.san,
    candidates,
    chosen,
    reason,
    overrode: chosen.uci !== top.uci ? top : undefined,
  };
}
