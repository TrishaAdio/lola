import { useCallback, useMemo, useRef, useState } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import type { Square } from "chess.js";
import { useGame } from "../hooks/useGame";
import type { GameSetup } from "../hooks/useGame";
import { isPromotionMove, opposite } from "../chess/moves";
import { EvalBar } from "./EvalBar";
import { MoveHistory } from "./MoveHistory";
import { CapturedTray } from "./CapturedTray";
import { materialValue } from "../chess/threats";
import { CommentaryPanel } from "./CommentaryPanel";
import { MoveInput } from "./MoveInput";
import { PromotionDialog } from "./PromotionDialog";
import { GameSummaryPanel } from "./GameSummaryPanel";
import { ENGINE_TIERS } from "../engine/tiers";
import { boardTheme } from "./boardTheme";
import { formatClock } from "../hooks/useClock";
import type { Color } from "chess.js";

const CLAIM_TEXT = {
  "threefold-repetition": "threefold repetition",
  "fifty-move-rule": "the 50-move rule",
} as const;

interface Props {
  setup: GameSetup;
  onExit: () => void;
  onRematch: () => void;
}

const HL = {
  lastMove: "rgba(120, 160, 255, 0.34)",
  selected: "rgba(255, 214, 102, 0.45)",
  target: "radial-gradient(circle, rgba(255,214,102,0.55) 22%, transparent 24%)",
  threat: "rgba(214, 64, 64, 0.5)",
  attacked: "rgba(214, 64, 64, 0.18)",
  check: "radial-gradient(circle, rgba(255,72,72,0.85) 38%, transparent 62%)",
};

export function PlayScreen({ setup, onExit, onRematch }: Props) {
  const game = useGame(setup);
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  /**
   * Mirror of `selectedSquare` that is updated synchronously. Click handlers read this
   * so a fast second click can't be dropped while React is still re-rendering.
   */
  const selectedRef = useRef<Square | null>(null);
  const select = useCallback((square: Square | null) => {
    selectedRef.current = square;
    setSelectedSquare(square);
  }, []);

  /** Purely visual: which colour sits at the bottom of the board. */
  const [flipped, setFlipped] = useState(false);

  const engineTier = ENGINE_TIERS[setup.engineConfig.tier];
  const userIsWhite = setup.userColor === "w";
  /** Colour shown on the near side. Never used for move logic, only for the view. */
  const viewColor = flipped ? opposite(setup.userColor) : setup.userColor;
  const thinking = game.phase === "engine-thinking";
  const myTurn = game.phase === "user-turn";

  const startMeta = useMemo(() => {
    const chess = new Chess(setup.fen);
    return { turn: chess.turn(), moveNumber: chess.moveNumber() };
  }, [setup.fen]);

  const kingSquare = useMemo(() => {
    if (!game.inCheck) return null;
    const chess = new Chess(game.fen);
    return chess.findPiece({ type: "k", color: chess.turn() })[0] ?? null;
  }, [game.fen, game.inCheck]);

  const { lastMove, threats, legalTargets } = game;

  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};

    if (lastMove) {
      styles[lastMove.from] = { background: HL.lastMove };
      styles[lastMove.to] = { background: HL.lastMove };
    }

    // Threat highlighting: what the engine's reply is actually aiming at.
    if (threats) {
      for (const sq of threats.attacked) {
        styles[sq] = { ...styles[sq], boxShadow: `inset 0 0 0 9999px ${HL.attacked}` };
      }
      for (const sq of threats.hanging) {
        styles[sq] = { ...styles[sq], boxShadow: `inset 0 0 0 3px ${HL.threat}` };
      }
    }

    if (kingSquare) {
      styles[kingSquare] = { ...styles[kingSquare], background: HL.check };
    }

    if (selectedSquare) {
      styles[selectedSquare] = { ...styles[selectedSquare], background: HL.selected };
      for (const target of legalTargets(selectedSquare)) {
        styles[target] = { ...styles[target], backgroundImage: HL.target };
      }
    }

    return styles;
  }, [lastMove, threats, kingSquare, selectedSquare, legalTargets]);

  /** Shared entry point for both drag-drop and click-to-move. */
  const tryMove = useCallback(
    (from: Square, to: Square): boolean => {
      if (!myTurn) return false;
      if (isPromotionMove(game.fen, from, to)) {
        game.setPendingPromotion({ from, to });
        return false; // wait for the dialog; the board snaps back meanwhile
      }
      return game.applyUserMove(from, to);
    },
    [game, myTurn],
  );

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
      select(null);
      if (!targetSquare) return false;
      return tryMove(sourceSquare as Square, targetSquare as Square);
    },
    [select, tryMove],
  );

  const onSquareClick = useCallback(
    ({ square }: { square: string }) => {
      if (!myTurn) return;
      const sq = square as Square;
      const current = selectedRef.current;

      if (current) {
        if (sq === current) {
          select(null);
          return;
        }
        if (legalTargets(current).includes(sq)) {
          select(null);
          tryMove(current, sq);
          return;
        }
      }

      // Select only the user's own pieces.
      const chess = new Chess(game.fen);
      const piece = chess.get(sq);
      select(piece && piece.color === setup.userColor ? sq : null);
    },
    [game.fen, legalTargets, myTurn, select, setup.userColor, tryMove],
  );

  const engineMaterial = materialValue(game.capturedByEngine);
  const userMaterial = materialValue(game.capturedByUser);

  const clockFor = (color: Color) =>
    game.clock.enabled ? (
      <span
        className={[
          "clock",
          game.clock.display.running === color ? "clock--running" : "",
          game.clock.display[color] < 20_000 ? "clock--low" : "",
        ].join(" ")}
        data-testid={`clock-${color}`}
      >
        {formatClock(game.clock.display[color])}
      </span>
    ) : null;

  const engineTray = (
    <div className="player">
      <CapturedTray
        captured={game.capturedByEngine}
        piecesColor={setup.userColor}
        label="Engine has taken"
        advantage={engineMaterial - userMaterial}
      />
      {clockFor(game.engineColor)}
    </div>
  );
  const userTray = (
    <div className="player">
      <CapturedTray
        captured={game.capturedByUser}
        piecesColor={opposite(setup.userColor)}
        label="You have taken"
        advantage={userMaterial - engineMaterial}
      />
      {clockFor(setup.userColor)}
    </div>
  );

  const statusText = (() => {
    if (game.engineStatus.state === "error") return game.engineStatus.error ?? "Engine error";
    if (game.engineStatus.state === "loading") {
      const p = game.engineStatus.progress;
      return p && p.percent < 1
        ? `Loading engine — ${Math.round(p.percent * 100)}%${p.etaText ? ` · ${p.etaText} left` : ""}`
        : `Loading ${engineTier.label} (${engineTier.sizeLabel})…`;
    }
    if (game.phase === "over") return game.gameOver?.detail ?? "Game over";
    if (game.phase === "claim-pending") return "Your move allows a draw claim.";
    if (thinking) return `Engine thinking — depth ${game.searchDepth || "…"}`;
    if (myTurn) return `Your move (${userIsWhite ? "White" : "Black"})`;
    // Engine is ready but the turn driver hasn't handed control over yet. Saying
    // "your move" here would invite clicks that the board correctly ignores.
    return "Preparing position…";
  })();

  return (
    <div className="play">
      <header className="play__bar">
        <button type="button" className="btn btn--quiet" onClick={onExit}>
          New position
        </button>
        <div className="play__meta">
          <span className="play__position">{setup.positionName}</span>
          <span className="play__sep" aria-hidden="true" />
          <span>{engineTier.label}</span>
          {setup.engineConfig.skillLevel === 20 && !setup.engineConfig.limitStrength && (
            <span className="badge">no mercy</span>
          )}
          {setup.strategic && <span className="badge badge--quiet">strategic</span>}
        </div>
        <div className="play__actions">
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => setFlipped((f) => !f)}
            aria-pressed={flipped}
            title={`Flip the board — currently viewing from ${viewColor === "w" ? "White" : "Black"}`}
          >
            Flip board
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => game.setAuraEnabled(!game.auraEnabled)}
            aria-pressed={game.auraEnabled}
            title="Tactics Aura commentary"
          >
            Aura {game.auraEnabled ? "on" : "off"}
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={game.offerDraw}
            disabled={!game.canOfferDraw}
          >
            Offer draw
          </button>
          {game.canClaim && game.phase === "user-turn" && (
            <button type="button" className="btn btn--claim" onClick={game.claimDraw}>
              Claim draw
            </button>
          )}
          <button
            type="button"
            className="btn btn--quiet"
            onClick={game.resign}
            disabled={game.phase === "over"}
          >
            Resign
          </button>
        </div>
      </header>

      <div className={`status ${thinking ? "status--thinking" : ""}`}>
        {!myTurn && game.phase !== "over" && <span className="spinner" />}
        <span>{statusText}</span>
        {game.engineStatus.state === "loading" && game.engineStatus.progress && (
          <span className="progress">
            <span
              className="progress__fill"
              style={{ width: `${Math.round(game.engineStatus.progress.percent * 100)}%` }}
            />
          </span>
        )}
      </div>

      {game.phase === "claim-pending" && (
        <div className="claim" role="alert">
          <span>
            This position allows a draw by {CLAIM_TEXT[game.rules.claimable[0]]}.
          </span>
          <button type="button" className="btn btn--claim" onClick={game.claimDraw}>
            Claim draw
          </button>
          <button type="button" className="btn btn--ghost" onClick={game.playOn}>
            Play on
          </button>
        </div>
      )}

      {game.phase === "user-turn" && game.canClaim && (
        <p className="notice" data-testid="claimable">
          Draw claimable: {game.rules.claimable.map((k) => CLAIM_TEXT[k]).join(", ")}.
        </p>
      )}

      {game.drawOffer && game.phase !== "over" && (
        <p className="notice" data-testid="draw-offer">
          {game.drawOffer.status === "open"
            ? "Draw offered. The engine answers on its move."
            : "The engine declined your draw offer and played on."}
        </p>
      )}

      <div className="aura-slot" aria-live="polite">
        {game.auraMessage && (
          <p key={game.auraMessage.id} className="aura" data-trigger={game.auraMessage.trigger}>
            {game.auraMessage.text}
          </p>
        )}
      </div>

      <div className="play__grid">
        <div className="play__boardcol">
          {/* Each tray sits beside the player it belongs to, so they follow the flip. */}
          {flipped ? userTray : engineTray}

          <div className="boardwrap">
            <EvalBar assessment={game.assessment} orientation={viewColor} thinking={thinking} />
            <div className="board">
              <Chessboard
                options={{
                  position: game.fen,
                  boardOrientation: viewColor === "w" ? "white" : "black",
                  allowDragging: myTurn,
                  onPieceDrop,
                  onSquareClick,
                  squareStyles,
                  animationDurationInMs: 180,
                  ...boardTheme,
                  showNotation: true,
                }}
              />
            </div>
          </div>

          {flipped ? engineTray : userTray}

          <MoveInput disabled={!myTurn} onSubmit={game.playSan} />
        </div>

        <aside className="play__side">
          <CommentaryPanel
            liveInfo={game.liveInfo}
            liveFen={game.fen}
            decision={game.decision}
            thinking={thinking}
            searchTurn={game.turn}
          />
          <div className="panel panel--tight">
            <h3 className="panel__title">Moves</h3>
            <MoveHistory
              records={game.records}
              startingTurn={startMeta.turn}
              startingMoveNumber={startMeta.moveNumber}
            />
          </div>
        </aside>
      </div>

      {game.pendingPromotion && (
        <PromotionDialog
          color={setup.userColor}
          target={game.pendingPromotion.to}
          onChoose={(piece) => {
            const p = game.pendingPromotion!;
            game.applyUserMove(p.from, p.to, piece);
          }}
          onCancel={() => game.setPendingPromotion(null)}
        />
      )}

      {game.phase === "over" && game.gameOver && (
        <GameSummaryPanel
          over={game.gameOver}
          summary={game.summary}
          userColor={setup.userColor}
          onRematch={onRematch}
          onNewPosition={onExit}
        />
      )}
    </div>
  );
}
