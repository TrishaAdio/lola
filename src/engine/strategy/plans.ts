/**
 * Plan continuity.
 *
 * Once the position reaches a recognisable structure, a plan is adopted and kept for as
 * long as that structure lasts. Candidate moves that advance the plan get a bonus over
 * equal-eval moves that abandon it. That is what makes the engine look like it is playing
 * a game plan rather than calculating one move at a time.
 */
import type { Color } from "chess.js";
import { activity, kingSafety } from "./features";
import {
  kingZone,
  material,
  other,
  pawnsOf,
  pieceMaterial,
  relRank,
  wingOf,
} from "./board";
import type { StrategicBoard, Wing } from "./board";

export type PlanId =
  | "simplify"
  | "consolidate"
  | "pawn-storm"
  | "king-hunt"
  | "minority-attack"
  | "central-break"
  | "improve-pieces";

export interface PlanState {
  id: PlanId;
  label: string;
  /** Wing the plan is aimed at, for pawn storms. */
  wing?: Wing;
  adoptedAtPly: number;
  /** Why it was adopted - shown in the dev log and the commentary panel. */
  because: string;
}

const LABEL: Record<PlanId, string> = {
  simplify: "Trade down into a won endgame",
  consolidate: "Consolidate and neutralise",
  "pawn-storm": "Pawn storm",
  "king-hunt": "Attack the exposed king",
  "minority-attack": "Queenside minority attack",
  "central-break": "Prepare a central pawn break",
  "improve-pieces": "Improve the worst-placed pieces",
};

/** Eval-driven plans outrank structural ones: when winning, convert; when losing, hold. */
const EVAL_PLANS: PlanId[] = ["simplify", "consolidate"];

function kingWing(board: StrategicBoard, color: Color): Wing | null {
  const k = board.king[color];
  if (!k || relRank(k.rank, color) > 1) return null;
  const wing = wingOf(k.file);
  return wing === "center" ? null : wing;
}

type Precondition = (board: StrategicBoard, us: Color, evalCp: number) => string | null;

/** Each plan's precondition returns why it applies, or null. */
const PRECONDITIONS: Record<PlanId, Precondition> = {
  simplify: (b, us, cp) => {
    const edge = material(b, us) - material(b, other(us));
    return cp >= 150 && edge >= 2 ? `up ${edge} in material at +${(cp / 100).toFixed(1)}` : null;
  },
  consolidate: (_b, _us, cp) => (cp <= -80 ? `worse at ${(cp / 100).toFixed(1)}` : null),
  "pawn-storm": (b, us) => {
    const ours = kingWing(b, us);
    const theirs = kingWing(b, other(us));
    return ours && theirs && ours !== theirs ? `kings castled on opposite wings` : null;
  },
  "king-hunt": (b, us, cp) =>
    cp >= 50 && kingSafety(b, other(us)) <= -30 ? "the enemy king is exposed" : null,
  "minority-attack": (b, us) => {
    const qs = (c: Color) => pawnsOf(b, c).filter((p) => p.file <= 2).length;
    const ours = qs(us);
    const theirs = qs(other(us));
    const centreFixed = [us, other(us)].every((c) => pawnsOf(b, c).some((p) => p.file === 3));
    return ours >= 1 && ours < theirs && centreFixed
      ? `${ours} v ${theirs} queenside pawns against a fixed centre`
      : null;
  },
  "central-break": (b, us) => {
    const blocked = pawnsOf(b, us).some((p) => {
      if (p.file !== 3 && p.file !== 4) return false;
      const ahead = b.at(p.file, p.rank + (us === "w" ? 1 : -1));
      return ahead?.type === "p" && ahead.color !== us;
    });
    return blocked ? "the central pawns are locked" : null;
  },
  "improve-pieces": () => "no structural plan applies",
};

const PRIORITY: PlanId[] = [
  "simplify",
  "consolidate",
  "pawn-storm",
  "king-hunt",
  "minority-attack",
  "central-break",
  "improve-pieces",
];

/**
 * Keeps the current plan while its structure holds; otherwise adopts the best one now
 * available. Eval-driven plans may interrupt a structural plan, never the reverse.
 */
export function choosePlan(
  current: PlanState | null,
  board: StrategicBoard,
  us: Color,
  evalCp: number,
  ply: number,
): PlanState {
  const make = (id: PlanId, because: string): PlanState => ({
    id,
    label:
      id === "pawn-storm" ? `${capitalise(kingWing(board, other(us)) ?? "kingside")} pawn storm` : LABEL[id],
    wing: id === "pawn-storm" ? (kingWing(board, other(us)) ?? undefined) : undefined,
    adoptedAtPly: ply,
    because,
  });

  for (const id of EVAL_PLANS) {
    const why = PRECONDITIONS[id](board, us, evalCp);
    if (why && current?.id !== id) return make(id, why);
  }

  if (current && current.id !== "improve-pieces") {
    if (PRECONDITIONS[current.id](board, us, evalCp)) return current;
  }

  for (const id of PRIORITY) {
    const why = PRECONDITIONS[id](board, us, evalCp);
    if (why) return current?.id === id ? current : make(id, why);
  }
  return make("improve-pieces", "no structural plan applies");
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const sumRel = (board: StrategicBoard, us: Color, files: (f: number) => boolean) =>
  pawnsOf(board, us)
    .filter((p) => files(p.file))
    .reduce((s, p) => s + relRank(p.rank, us), 0);

const zonePressure = (board: StrategicBoard, us: Color) =>
  kingZone(board, other(us)).reduce((s, i) => s + board.attacks[us][i], 0);

/**
 * How much a candidate line advances the plan, from `before` to the line's horizon.
 * Returned un-clamped; the policy caps it.
 */
export function planProgress(
  plan: PlanState,
  before: StrategicBoard,
  after: StrategicBoard,
  us: Color,
): number {
  const them = other(us);
  switch (plan.id) {
    case "simplify": {
      const traded =
        pieceMaterial(before, us) + pieceMaterial(before, them) -
        (pieceMaterial(after, us) + pieceMaterial(after, them));
      const edgeBefore = material(before, us) - material(before, them);
      const edgeAfter = material(after, us) - material(after, them);
      return edgeAfter >= edgeBefore ? traded * 3 : 0;
    }
    case "consolidate":
      return (
        (kingSafety(after, us) - kingSafety(before, us)) * 0.6 +
        (activity(before, them) - activity(after, them)) * 0.3
      );
    case "pawn-storm": {
      const inWing = (f: number) => (plan.wing === "queenside" ? f <= 2 : f >= 5);
      return (
        (sumRel(after, us, inWing) - sumRel(before, us, inWing)) * 5 +
        (zonePressure(after, us) - zonePressure(before, us)) * 3
      );
    }
    case "king-hunt":
      return (zonePressure(after, us) - zonePressure(before, us)) * 4;
    case "minority-attack": {
      const qs = (f: number) => f === 0 || f === 1;
      const rookOnFile = (b: StrategicBoard) =>
        b.pieces.filter((p) => p.color === us && p.type === "r" && (p.file === 1 || p.file === 2))
          .length;
      return (
        (sumRel(after, us, qs) - sumRel(before, us, qs)) * 5 +
        (rookOnFile(after) - rookOnFile(before)) * 6
      );
    }
    case "central-break": {
      const breakFiles = (f: number) => f === 2 || f === 5;
      return (sumRel(after, us, breakFiles) - sumRel(before, us, breakFiles)) * 5;
    }
    case "improve-pieces":
      return (activity(after, us) - activity(before, us)) * 0.4;
  }
}
