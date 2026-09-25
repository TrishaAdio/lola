import type { Color } from "chess.js";
import { PieceIcon } from "./PieceIcon";

const CHOICES = [
  { type: "q", name: "Queen" },
  { type: "r", name: "Rook" },
  { type: "b", name: "Bishop" },
  { type: "n", name: "Knight" },
] as const;

interface Props {
  color: Color;
  target: string;
  onChoose: (piece: "q" | "r" | "b" | "n") => void;
  onCancel: () => void;
}

/** Full promotion choice, including underpromotion. */
export function PromotionDialog({ color, target, onChoose, onCancel }: Props) {
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Choose promotion piece">
      <div className="modal__card">
        <h3>Promote on {target}</h3>
        <p className="note">Underpromotion is allowed — sometimes a knight is the only move.</p>
        <div className="promo">
          {CHOICES.map((c) => (
            <button
              key={c.type}
              type="button"
              className="promo__btn"
              onClick={() => onChoose(c.type)}
            >
              <PieceIcon type={c.type} color={color} size={42} />
              <span className="promo__name">{c.name}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
