import type { Color } from "chess.js";
import type { Assessment } from "../chess/analysis";
import { assessmentToWhiteWinPercent } from "../chess/analysis";

interface Props {
  assessment: Assessment | null;
  /** Board orientation, so the bar matches the player's side. */
  orientation: Color;
  thinking: boolean;
}

function label(a: Assessment | null): string {
  if (!a) return "—";
  if (a.whiteMate !== undefined && a.whiteMate !== 0) {
    return `${a.whiteMate > 0 ? "+" : "\u2212"}M${Math.abs(a.whiteMate)}`;
  }
  if (a.whiteCp === undefined) return "—";
  const pawns = a.whiteCp / 100;
  const sign = pawns > 0 ? "+" : pawns < 0 ? "\u2212" : "";
  return `${sign}${Math.abs(pawns).toFixed(2)}`;
}

export function EvalBar({ assessment, orientation, thinking }: Props) {
  const whitePercent = assessmentToWhiteWinPercent(assessment) ?? 50;
  // The bar fills from the bottom with the near player's share.
  const nearShare = orientation === "w" ? whitePercent : 100 - whitePercent;

  return (
    <div className={`evalbar ${thinking ? "evalbar--thinking" : ""}`} title="Evaluation">
      <div className="evalbar__track">
        <div className="evalbar__fill" style={{ height: `${nearShare}%` }} />
        <div className="evalbar__mid" />
      </div>
      <span className="evalbar__label">{label(assessment)}</span>
    </div>
  );
}
