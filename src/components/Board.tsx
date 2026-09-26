/**
 * The playing board: react-chessboard for movement and drag handling, with every square
 * rendered by us so highlights and effects are layered deliberately:
 *
 *   square colour -> last-move / threat tint -> capture ghost -> piece -> glow / target
 *
 * Motion is tuned in src/config.ts and dropped entirely under prefers-reduced-motion.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Chessboard } from "react-chessboard";
import type { Color, Square } from "chess.js";
import { PieceSvg } from "../pieces/PieceSet";
import { boardPieces } from "../pieces/boardPieces";
import { CAPTURE_FADE_MS, MOVE_ANIMATION_MS, MOVE_EASING } from "../config";
import { useReducedMotion } from "../hooks/useReducedMotion";
import type { MoveVisual } from "../hooks/useGame";
import type { ThreatReport } from "../chess/threats";

export interface BoardProps {
  id?: string;
  fen: string;
  orientation: Color;
  interactive?: boolean;
  lastMove?: MoveVisual | null;
  selected?: Square | null;
  /** Legal destinations of the selected piece; occupied ones get a capture ring. */
  targets?: Square[];
  threats?: ThreatReport | null;
  /** King square currently in check, and whether it is mate. */
  check?: { square: Square; mate: boolean } | null;
  onPieceDrop?: (args: { sourceSquare: string; targetSquare: string | null }) => boolean;
  onSquareClick?: (args: { square: string }) => void;
  /** Set when a drop was refused: the piece settles back onto `square`. */
  settle?: { square: Square; id: number } | null;
}

const NOTATION: CSSProperties = { fontSize: "10.5px", fontWeight: 600, letterSpacing: "0.02em", zIndex: 3 };

const boardStyleVars = {
  darkSquareStyle: { backgroundColor: "var(--sq-dark)" },
  lightSquareStyle: { backgroundColor: "var(--sq-light)" },
  darkSquareNotationStyle: { color: "var(--sq-light)" },
  lightSquareNotationStyle: { color: "var(--sq-dark)" },
  alphaNotationStyle: { ...NOTATION, bottom: 1, right: 4 },
  numericNotationStyle: { ...NOTATION, top: 2, left: 3 },
};

export function Board({
  id = "board",
  fen,
  orientation,
  interactive = false,
  lastMove,
  selected,
  targets = [],
  threats,
  check,
  onPieceDrop,
  onSquareClick,
  settle,
}: BoardProps) {
  const reducedMotion = useReducedMotion();
  const frameRef = useRef<HTMLDivElement>(null);

  // A refused piece is set back down with a small, weighted settle rather than a snap.
  useEffect(() => {
    if (!settle || reducedMotion) return;
    const el = frameRef.current?.querySelector<HTMLElement>(`[data-sq="${settle.square}"] .sq-piece`);
    el?.animate(
      [{ transform: "scale(1.07) translateY(-2%)" }, { transform: "scale(1) translateY(0)" }],
      { duration: 170, easing: MOVE_EASING },
    );
  }, [settle, reducedMotion]);
  const occupied = useMemo(() => occupiedSquares(fen), [fen]);
  const targetSet = useMemo(() => new Set(targets), [targets]);
  const attacked = useMemo(() => new Set(threats?.attacked ?? []), [threats]);
  const hanging = useMemo(() => new Set(threats?.hanging ?? []), [threats]);

  const squareRenderer = useCallback(
    ({ square, children }: { square: string; children?: ReactNode }) => {
      const layers: ReactNode[] = [];
      const sq = square as Square;

      if (lastMove && (lastMove.from === sq || lastMove.to === sq)) {
        layers.push(<span key="last" className="sq-layer sq-layer--last" />);
      }
      if (selected === sq) layers.push(<span key="sel" className="sq-layer sq-layer--selected" />);
      if (attacked.has(sq)) {
        layers.push(
          <span key="atk" className={`sq-layer ${hanging.has(sq) ? "sq-threat--hanging" : "sq-threat"}`} />,
        );
      }

      // The piece that was just taken shrinks and fades beneath the piece that took it.
      const captured = lastMove?.captured;
      if (captured && captured.square === sq && !reducedMotion) {
        const delay = lastMove.via === "animated" ? MOVE_ANIMATION_MS : 0;
        layers.push(
          <span
            key={`ghost-${lastMove.id}`}
            className="capture-ghost"
            style={{ animationDuration: `${CAPTURE_FADE_MS}ms`, animationDelay: `${delay}ms` } as CSSProperties}
          >
            <PieceSvg code={`${captured.color}${captured.type.toUpperCase()}`} />
          </span>,
        );
      }

      if (check?.square === sq) {
        layers.push(<span key="glow" className={`king-glow ${check.mate ? "king-glow--mate" : ""}`} />);
      }

      const isTarget = targetSet.has(sq);
      return (
        <div className="sq" data-sq={sq}>
          {layers}
          <div className="sq-piece">{children}</div>
          {isTarget && (
            <span className={occupied.has(sq) ? "sq-target sq-target--capture" : "sq-target"} />
          )}
        </div>
      );
    },
    [attacked, check, hanging, lastMove, occupied, reducedMotion, selected, targetSet],
  );

  return (
    <div
      ref={frameRef}
      className={`board-frame ${reducedMotion ? "board-frame--still" : ""}`}
      style={{ "--move-ease": MOVE_EASING } as CSSProperties}
    >
      <Chessboard
        options={{
          id,
          position: fen,
          boardOrientation: orientation === "w" ? "white" : "black",
          pieces: boardPieces,
          allowDragging: interactive,
          onPieceDrop,
          onSquareClick,
          squareRenderer,
          showAnimations: !reducedMotion,
          animationDurationInMs: reducedMotion ? 0 : MOVE_ANIMATION_MS,
          draggingPieceStyle: { transform: "scale(1.1)", filter: "drop-shadow(0 10px 8px rgba(0,0,0,0.35))" },
          draggingPieceGhostStyle: { opacity: 0.28 },
          allowDrawingArrows: true,
          showNotation: true,
          ...boardStyleVars,
        }}
      />
    </div>
  );
}

function occupiedSquares(fen: string): Set<Square> {
  const set = new Set<Square>();
  const rows = fen.split(" ")[0].split("/");
  rows.forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch);
      else {
        set.add(`${"abcdefgh"[file]}${8 - i}` as Square);
        file++;
      }
    }
  });
  return set;
}
