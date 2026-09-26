/** Builds the aura's trigger inputs from an engine decision. Measured, never guessed. */
import { Chess } from "chess.js";
import type { Color } from "chess.js";
import { winProbability } from "../chess/evaluation";
import { buildBoard, kingZone, other, pawnsOf, PIECE_POINTS, relRank } from "../engine/strategy/board";
import type { PolicyDecision } from "../engine/policy";
import type { AuraInput } from "./aura";

const PIECE_NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" };

export function auraInputFrom(
  decision: PolicyDecision,
  engineMove: number,
  winBeforeHuman: number | null,
): AuraInput {
  const engine: Color = new Chess(decision.fen).turn();
  const after = new Chess(decision.fen);
  after.move({
    from: decision.uci.slice(0, 2),
    to: decision.uci.slice(2, 4),
    promotion: decision.uci[4],
  });
  const board = buildBoard(after);
  const human = other(engine);

  const kingZoneAttacks = kingZone(board, human).reduce((s, i) => s + board.attacks[engine][i], 0);

  const humanPawns = pawnsOf(board, human);
  const passedPawnRank = pawnsOf(board, engine)
    .filter(
      (p) =>
        !humanPawns.some(
          (q) => Math.abs(q.file - p.file) <= 1 && (engine === "w" ? q.rank > p.rank : q.rank < p.rank),
        ),
    )
    .reduce((max, p) => Math.max(max, relRank(p.rank, engine)), 0);

  const report = decision.chosen.report;
  const target = report.hanging
    .map((square) => {
      const piece = after.get(square);
      return piece ? { piece: PIECE_NAME[piece.type] ?? piece.type, square, value: PIECE_POINTS[piece.type] } : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null)
    .sort((a, b) => b.value - a.value)[0] ?? null;

  const mate = decision.chosen.info.mate;
  return {
    engineMove,
    winBeforeHuman,
    winAfterHuman: winProbability(decision.stockfishBest.info) * 100,
    winAfterEngine: winProbability(decision.chosen.info) * 100,
    // Stockfish's "mate N" counts the move being played; the aura wants what remains.
    mateIn: mate !== undefined && mate > 0 ? mate - 1 : null,
    humanReplies: report.replies,
    check: report.check,
    kingZoneAttacks,
    target,
    winningLines: decision.candidates.filter(
      (c) => (c.info.mate !== undefined && c.info.mate > 0) || (c.info.cp ?? -Infinity) >= 300,
    ).length,
    passedPawnRank,
  };
}
