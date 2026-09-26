/** react-chessboard `pieces` option, rendering the app's own set. */
import type { CSSProperties } from "react";
import { PieceSvg } from "./PieceSet";

export const PIECE_CODES = ["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"];

/** react-chessboard `pieces` option. */
export const boardPieces = Object.fromEntries(
  PIECE_CODES.map((code) => [
    code,
    (props?: { svgStyle?: CSSProperties }) => <PieceSvg code={code} style={props?.svgStyle} />,
  ]),
);
