import { PieceSvg } from "../pieces/PieceSet";

/** A single piece outside the board (captured tray, promotion dialog), in the app's set. */
export function PieceIcon({ type, color, size }: { type: string; color: "w" | "b"; size: number }) {
  return (
    <span className="piece-icon" style={{ width: size, height: size }} aria-hidden="true">
      <PieceSvg code={`${color}${type.toUpperCase()}`} />
    </span>
  );
}
