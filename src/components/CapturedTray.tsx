import { PieceIcon } from "./PieceIcon";

const ORDER = ["q", "r", "b", "n", "p"];

interface Props {
  /** Piece types captured by this player (so they belong to the opponent). */
  captured: string[];
  /** Colour of the pieces shown, i.e. the opponent's colour. */
  piecesColor: "w" | "b";
  label: string;
  /** Material advantage to display, if positive. */
  advantage: number;
}

export function CapturedTray({ captured, piecesColor, label, advantage }: Props) {
  const counts = captured.reduce<Record<string, number>>((acc, type) => {
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="tray">
      <span className="tray__label">{label}</span>
      <span className="tray__pieces">
        {ORDER.flatMap((type) =>
          Array.from({ length: counts[type] ?? 0 }, (_, i) => (
            <PieceIcon key={`${type}-${i}`} type={type} color={piecesColor} size={21} />
          )),
        )}
        {captured.length === 0 && <span className="tray__none">nothing yet</span>}
      </span>
      {advantage > 0 && <span className="tray__adv">+{advantage}</span>}
    </div>
  );
}
