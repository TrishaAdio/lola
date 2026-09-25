/**
 * Shared board palette.
 *
 * Coordinate labels must be set explicitly: react-chessboard's defaults are tuned for its
 * default brown board and become illegible against these squares.
 */
export const BOARD_DARK = "#2d3440";
export const BOARD_LIGHT = "#8b93a1";

export const boardTheme = {
  darkSquareStyle: { backgroundColor: BOARD_DARK },
  lightSquareStyle: { backgroundColor: BOARD_LIGHT },
  // Notation is drawn in the opposing square colour, so every label stays readable.
  darkSquareNotationStyle: { color: BOARD_LIGHT },
  lightSquareNotationStyle: { color: BOARD_DARK },
} as const;
