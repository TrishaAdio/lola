import { defaultPieces } from "react-chessboard";

/**
 * Renders a piece using react-chessboard's own SVGs.
 *
 * Unicode chess glyphs (U+2654-265F) are missing from many minimal font stacks and fall
 * back to tofu boxes, so the board's vector pieces are used everywhere instead.
 */
export function PieceIcon({
  type,
  color,
  size,
}: {
  type: string;
  color: "w" | "b";
  size: number;
}) {
  const key = `${color}${type.toUpperCase()}`;
  const render = defaultPieces[key];
  if (!render) return null;
  return (
    <span className="piece-icon" style={{ width: size, height: size }} aria-hidden="true">
      {render({})}
    </span>
  );
}
