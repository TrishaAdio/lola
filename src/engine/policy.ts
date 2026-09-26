/**
 * Move selection: a hybrid strategic layer on top of Stockfish.
 *
 * STOCKFISH PROVIDES TACTICAL GROUND-TRUTH; THE STRATEGIC LAYER RE-RANKS NEAR-EQUAL
 * OPTIONS TO PRODUCE HUMAN-LIKE, PLAN-DRIVEN PLAY RATHER THAN PURE ENGINE-OPTIMAL PLAY.
 *
 * Stockfish's own search is never modified. It proposes its top MultiPV lines with exact
 * evaluations, and this module decides between them:
 *
 *  1. Tactics first. A forced mate is always converted by the shortest line. A move
 *     Stockfish rates meaningfully worse than its best is never chosen - candidates must
 *     sit inside a small eval window (centipawns *and* win probability). A deviation from
 *     Stockfish's #1 may never leave material en prise that #1 did not.
 *  2. Among the moves that survive, a strategic score re-ranks:
 *       - king safety trajectory      (now vs. the end of the candidate's line)
 *       - piece activity & space      (safe mobility, centre, outposts, open files)
 *       - pawn structure health       (isolated / doubled / backward pawns, king holes)
 *       - plan continuity             (does this move execute the adopted plan?)
 *       - prophylaxis                 (does it stop the opponent's best idea?)
 *       - initiative                  (checks, fewer replies, material under attack)
 *  3. Draws are never volunteered while the engine is not losing.
 *
 * The strategic bonus is capped, so the most it can ever cost is the width of the window.
 */
import { Chess } from "chess.js";
import type { Color, Square } from "chess.js";
import { applyUci, parseUciMove } from "../chess/moves";
import { comparableScore, isMateScore, winProbability } from "../chess/evaluation";
import { analyseThreats, pressureScore } from "../chess/threats";
import type { PressureBreakdown, ThreatReport } from "../chess/threats";
import { evaluateRules } from "../chess/rules";
import { buildBoard, PIECE_POINTS } from "./strategy/board";
import type { StrategicBoard } from "./strategy/board";
import { activity, kingSafety, structure } from "./strategy/features";
import { choosePlan, planProgress } from "./strategy/plans";
import type { PlanState } from "./strategy/plans";
import { assessProphylaxis } from "./strategy/prophylaxis";
import type { ProphylaxisResult, ThreatInfo } from "./strategy/prophylaxis";
import type { EngineInfo, SearchResult } from "./types";

/** Ordinary strategic re-ranking may cost at most this much against Stockfish's best. */
export const STRATEGIC_WINDOW_CP = 30;
export const STRATEGIC_WINDOW_WIN = 3;
/** A move that specifically kills the opponent's idea may cost slightly more. */
export const PROPHYLAXIS_WINDOW_CP = 45;
export const PROPHYLAXIS_WINDOW_WIN = 4.5;
/** Cap on the combined strategic bonus, in centipawn-like units. */
export const MAX_STRATEGIC_BONUS = 35;
/** At or below this, a draw is a good result and repetition is allowed. */
export const LOSING_CP = -120;
/** How many plies of each candidate's line to read for "trajectory" features. */
const HORIZON_PLIES = 5;

export interface StrategicBreakdown {
  kingSafety: number;
  activity: number;
  structure: number;
  plan: number;
  prophylaxis: number;
  initiative: number;
  total: number;
}

export interface Candidate {
  uci: string;
  san: string;
  /** MultiPV rank as returned by Stockfish (1 = its own first choice). */
  rank: number;
  info: EngineInfo;
  /** Unified score, engine's point of view; mate-aware. */
  score: number;
  /** Centipawns and win-% points given up against Stockfish's best. */
  costCp: number;
  costWin: number;
  report: ThreatReport;
  pressure: PressureBreakdown;
  allowsDrawClaim: boolean;
  /** Leaves material en prise that Stockfish's #1 did not. */
  dropsMaterial: boolean;
  prophylaxis?: ProphylaxisResult;
  strategic?: StrategicBreakdown;
  /** Eval + strategic bonus; what the final ranking uses. */
  final?: number;
  /** Considered by the strategic re-rank. */
  contested: boolean;
  /** Why a candidate was left out of the re-rank, if it was. */
  excluded?: "outside-window" | "drops-material" | "draw" | "mate-line";
}

export type DecisionReason =
  | "only-move"
  | "fastest-mate"
  | "avoid-draw"
  | "seek-draw"
  | "strategic"
  | "prophylaxis"
  | "best-eval";

export interface PolicyDecision {
  /** Position the search ran on; every candidate PV is relative to this. */
  fen: string;
  uci: string;
  san: string;
  /** All evaluated candidates, best-eval first. */
  candidates: Candidate[];
  chosen: Candidate;
  /** Stockfish's own first choice. */
  stockfishBest: Candidate;
  /** True when the strategic layer played something other than Stockfish's #1. */
  diverged: boolean;
  reason: DecisionReason;
  /** Kept for callers that only care about the overridden move. */
  overrode?: Candidate;
  plan: PlanState | null;
  threat: ThreatInfo | null;
}

export interface PolicyContext {
  /** Position the game started from, and SAN moves since - for draw detection. */
  startFen?: string;
  history?: string[];
  /** Strategic layer on. Off = play Stockfish's #1, always. */
  strategic?: boolean;
  /** Plan carried over from the previous engine move. */
  plan?: PlanState | null;
  /** The opponent's best idea, from a null-move search. */
  threat?: ThreatInfo | null;
  ply?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Would playing `uci` end the game in a draw or hand the opponent a draw claim? */
function leadsToDraw(fen: string, uci: string, startFen: string | undefined, history: string[]) {
  let board = new Chess(fen);
  let start = fen;
  if (startFen) {
    try {
      const replay = new Chess(startFen);
      for (const san of history) replay.move(san);
      if (replay.fen() === board.fen()) {
        board = replay;
        start = startFen;
      }
    } catch {
      /* fall back to the bare position */
    }
  }
  const parts = parseUciMove(uci);
  if (!parts) return false;
  try {
    board.move(parts);
  } catch {
    return false;
  }
  const rules = evaluateRules(board, start, "claim");
  return (rules.terminal !== null && rules.terminal.winner === null) || rules.claimable.length > 0;
}

/** Value of `color`'s material that is attacked and insufficiently defended. */
function enPriseValue(chess: Chess, color: Color): number {
  const them: Color = color === "w" ? "b" : "w";
  let total = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== color || cell.type === "k" || cell.type === "p") continue;
      const attackers = chess.attackers(cell.square as Square, them);
      if (attackers.length === 0) continue;
      const defenders = chess.attackers(cell.square as Square, color);
      const cheapest = Math.min(...attackers.map((s) => PIECE_POINTS[chess.get(s)?.type ?? "q"]));
      if (defenders.length === 0 || cheapest < PIECE_POINTS[cell.type]) total += PIECE_POINTS[cell.type];
    }
  }
  return total;
}

/** Plays up to `plies` of a PV; returns the final position. */
function horizonOf(fen: string, pv: string[], plies: number): Chess {
  const chess = new Chess(fen);
  for (const uci of pv.slice(0, plies)) {
    const parts = parseUciMove(uci);
    if (!parts) break;
    try {
      chess.move(parts);
    } catch {
      break;
    }
  }
  return chess;
}

function scoreStrategy(
  candidate: Candidate,
  fen: string,
  before: StrategicBoard,
  us: Color,
  plan: PlanState | null,
  threat: ThreatInfo | null,
): StrategicBreakdown {
  const them: Color = us === "w" ? "b" : "w";
  const afterChess = new Chess(fen);
  const parts = parseUciMove(candidate.uci)!;
  const move = afterChess.move(parts);
  const after = buildBoard(afterChess);
  const horizon = buildBoard(horizonOf(fen, candidate.info.pv, HORIZON_PLIES));

  // King safety as a trajectory: where the line leaves our king, weighted over the move.
  const ks = 0.4 * kingSafety(after, us) + 0.6 * kingSafety(horizon, us) - kingSafety(before, us);

  // Activity relative to the opponent's: restricting them counts as much as freeing us.
  const rel = (b: StrategicBoard) => activity(b, us) - activity(b, them);
  const act = ((rel(after) + rel(horizon)) / 2 - rel(before)) * 0.3;

  // Creating our own weaknesses hurts; creating theirs helps, at half weight.
  const struct =
    structure(horizon, us) - structure(before, us) -
    0.5 * (structure(horizon, them) - structure(before, them));

  const planScore = plan ? planProgress(plan, before, horizon, us) : 0;

  let prophylaxis = 0;
  if (threat) {
    candidate.prophylaxis = assessProphylaxis(fen, afterChess.fen(), threat, move.san.includes("+"));
    prophylaxis = candidate.prophylaxis.prevented * Math.min(threat.gainCp, 150) * 0.3;
  }

  const initiative = candidate.pressure.total * 0.08;

  const parts6 = {
    kingSafety: clamp(ks, -20, 20),
    activity: clamp(act, -15, 15),
    structure: clamp(struct, -15, 15),
    plan: clamp(planScore, 0, 15),
    prophylaxis: clamp(prophylaxis, 0, 30),
    initiative: clamp(initiative, 0, 10),
  };
  const sum = Object.values(parts6).reduce((a, b) => a + b, 0);
  return { ...parts6, total: clamp(sum, -MAX_STRATEGIC_BONUS, MAX_STRATEGIC_BONUS) };
}

function baseCandidate(fen: string, info: EngineInfo, bestCp: number, ctx: PolicyContext): Candidate | null {
  const uci = info.pv[0];
  const applied = applyUci(fen, uci);
  if (!applied) return null;
  const allowsDrawClaim = leadsToDraw(fen, uci, ctx.startFen, ctx.history ?? []);
  const report = analyseThreats(applied.chess.fen(), applied.move.from, applied.move.to);
  return {
    uci,
    san: applied.move.san,
    rank: info.multipv,
    info,
    score: comparableScore(info),
    costCp: 0,
    costWin: 0,
    report,
    pressure: pressureScore({
      report,
      capture: applied.move.isCapture(),
      promotion: applied.move.isPromotion(),
      allowsDrawClaim,
      engineCp: bestCp,
    }),
    allowsDrawClaim,
    dropsMaterial: false,
    contested: false,
  };
}

/**
 * Chooses the move to play from Stockfish's MultiPV output. Pure: the plan to carry into
 * the next engine move is returned on the decision.
 */
export function selectMove(
  fen: string,
  result: SearchResult,
  ctx: PolicyContext = {},
): PolicyDecision | null {
  const strategic = ctx.strategic ?? true;
  const threat = ctx.threat ?? null;
  const chess = new Chess(fen);
  const us = chess.turn();

  const decide = (
    candidates: Candidate[],
    chosen: Candidate,
    reason: DecisionReason,
    plan: PlanState | null,
  ): PolicyDecision => {
    const best = candidates[0];
    const diverged = chosen.uci !== best.uci;
    return {
      fen,
      uci: chosen.uci,
      san: chosen.san,
      candidates,
      chosen,
      stockfishBest: best,
      diverged,
      reason,
      overrode: diverged ? best : undefined,
      plan,
      threat,
    };
  };

  const usable = result.lines.filter((l) => l.pv.length > 0);
  if (usable.length === 0) {
    if (!result.bestmove || result.bestmove === "(none)") return null;
    const c = baseCandidate(fen, { depth: 0, multipv: 1, pv: [result.bestmove] }, 0, ctx);
    return c ? decide([c], c, "best-eval", ctx.plan ?? null) : null;
  }

  const bestCp = usable[0].cp ?? 0;
  const candidates = usable
    .map((info) => baseCandidate(fen, info, bestCp, ctx))
    .filter((c): c is Candidate => c !== null);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score || a.rank - b.rank);
  const top = candidates[0];
  const topWin = winProbability(top.info) * 100;
  for (const c of candidates) {
    c.costCp = isMateScore(top.score) || isMateScore(c.score) ? 0 : Math.max(0, top.score - c.score);
    c.costWin = Math.max(0, topWin - winProbability(c.info) * 100);
  }

  if (candidates.length === 1) return decide(candidates, top, "only-move", ctx.plan ?? null);
  if (!strategic) return decide(candidates, top, "best-eval", ctx.plan ?? null);

  // --- 1. tactics: forced mates are converted by the shortest line, no strategy ---------
  if (isMateScore(top.score)) {
    const fastest = candidates.filter((c) => c.score === top.score);
    fastest.sort((a, b) => b.pressure.total - a.pressure.total || a.rank - b.rank);
    for (const c of fastest) c.contested = true;
    return decide(candidates, fastest[0], "fastest-mate", ctx.plan ?? null);
  }

  // --- 2. strategic re-rank of the near-equal candidates ---------------------------------
  const before = buildBoard(chess);
  const plan = choosePlan(ctx.plan ?? null, before, us, bestCp, ctx.ply ?? 0);
  const losing = bestCp <= LOSING_CP;

  const baseline = enPriseValue(chess, us);
  const topAfter = applyUci(fen, top.uci)!;
  const topDrop = enPriseValue(topAfter.chess, us) - baseline - PIECE_POINTS[topAfter.move.captured ?? "k"];

  for (const c of candidates) {
    if (c === top) continue;
    if (isMateScore(c.score)) {
      c.excluded = "mate-line";
      continue;
    }
    if (c.costCp > PROPHYLAXIS_WINDOW_CP || c.costWin > PROPHYLAXIS_WINDOW_WIN) {
      c.excluded = "outside-window";
      continue;
    }
    const applied = applyUci(fen, c.uci)!;
    const drop = enPriseValue(applied.chess, us) - baseline - PIECE_POINTS[applied.move.captured ?? "k"];
    if (drop >= 3 && drop > topDrop) {
      c.dropsMaterial = true;
      c.excluded = "drops-material";
    }
  }

  const pool: Candidate[] = [];
  for (const c of candidates) {
    if (c.excluded) continue;
    if (c.allowsDrawClaim && !losing) {
      c.excluded = "draw";
      continue;
    }
    c.strategic = scoreStrategy(c, fen, before, us, plan, threat);
    const inWindow = c.costCp <= STRATEGIC_WINDOW_CP && c.costWin <= STRATEGIC_WINDOW_WIN;
    // The wider window is only for moves that actually stop the opponent's idea.
    if (!inWindow && c.strategic.prophylaxis <= 0) {
      c.excluded = "outside-window";
      continue;
    }
    c.contested = true;
    // When losing, a draw the engine can claim is worth 0 - better than any losing line.
    c.final = c.allowsDrawClaim && losing ? Math.max(c.score, 0) + 1 : c.score + c.strategic.total;
    pool.push(c);
  }

  if (pool.length === 0) {
    // Every near-equal move draws: take the best non-drawing one, else Stockfish's #1.
    const fallback = candidates.find((c) => !c.allowsDrawClaim && !isMateScore(c.score) && c.score > -99_000);
    const chosen = fallback ?? top;
    return decide(candidates, chosen, chosen === top ? "best-eval" : "avoid-draw", plan);
  }

  pool.sort((a, b) => (b.final ?? 0) - (a.final ?? 0) || a.rank - b.rank);
  const chosen = pool[0];

  let reason: DecisionReason = chosen.allowsDrawClaim && losing ? "seek-draw" : "best-eval";
  if (chosen !== top) {
    const s = chosen.strategic!;
    const strongestOther = Math.max(s.kingSafety, s.activity, s.structure, s.plan, s.initiative);
    if (top.excluded === "draw") reason = "avoid-draw";
    else if (chosen.allowsDrawClaim && losing) reason = "seek-draw";
    else if (s.prophylaxis > 0 && (chosen.costCp > STRATEGIC_WINDOW_CP || s.prophylaxis >= strongestOther)) {
      reason = "prophylaxis";
    } else reason = "strategic";
  }
  return decide(candidates, chosen, reason, plan);
}

/** Human-readable summary of a decision, for the dev console. */
export function describeDecision(d: PolicyDecision): string {
  const cost = d.chosen.costCp;
  if (!d.diverged) return `played Stockfish #1 ${d.san} (${d.reason})`;
  return `DIVERGED: Stockfish #1 ${d.stockfishBest.san} -> played ${d.san} (${d.reason}, costs ${cost}cp, strategic ${(d.chosen.strategic?.total ?? 0).toFixed(1)} vs ${(d.stockfishBest.strategic?.total ?? 0).toFixed(1)})`;
}
