import { useCallback, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import type { Color, Square } from "chess.js";
import { ArrowLeft, Flag, FlipVertical2, Handshake, Scale, Volume2, VolumeX } from "lucide-react";
import { useGame } from "../hooks/useGame";
import type { GameSetup } from "../hooks/useGame";
import { isPromotionMove, opposite } from "../chess/moves";
import { materialValue } from "../chess/threats";
import { ENGINE_TIERS } from "../engine/tiers";
import { formatClock } from "../hooks/useClock";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { setPrefs, usePrefs } from "../settings/prefs";
import { playSound } from "../audio/sound";
import { useGameSounds } from "../audio/useGameSounds";
import { Board } from "./Board";
import { EvalBar } from "./EvalBar";
import { MoveHistory } from "./MoveHistory";
import { CapturedTray } from "./CapturedTray";
import { CommentaryPanel } from "./CommentaryPanel";
import { MoveInput } from "./MoveInput";
import { PromotionDialog } from "./PromotionDialog";
import { GameSummaryPanel } from "./GameSummaryPanel";
import { AuraHud } from "./AuraHud";
import { SettingsMenu } from "./SettingsMenu";
import { ReviewStrip } from "./GameOverReview";
import { useGameOverReview } from "../hooks/useGameOverReview";

const CLAIM_TEXT = {
  "threefold-repetition": "threefold repetition",
  "fifty-move-rule": "the 50-move rule",
} as const;

const ICON = { size: 17, strokeWidth: 1.75, "aria-hidden": true } as const;

interface Props {
  setup: GameSetup;
  onExit: () => void;
  onRematch: () => void;
}

export function PlayScreen({ setup, onExit, onRematch }: Props) {
  const game = useGame(setup);
  const prefs = usePrefs();
  const reducedMotion = useReducedMotion();
  const review = useGameOverReview(game.gameOver);

  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  /** Synchronous mirror of the selection, so a fast second click is never dropped. */
  const selectedRef = useRef<Square | null>(null);
  const select = useCallback((square: Square | null) => {
    selectedRef.current = square;
    setSelectedSquare(square);
  }, []);
  const [settle, setSettle] = useState<{ square: Square; id: number } | null>(null);

  /** Purely visual: which colour sits at the bottom of the board. */
  const [flipped, setFlipped] = useState(false);

  const auraMessage = prefs.auraMessages ? game.auraMessage : null;
  useGameSounds({
    lastMove: game.lastMove,
    gameOver: game.gameOver,
    auraId: prefs.auraMessages ? (game.auraMessage?.id ?? null) : null,
    reducedMotion,
  });

  const engineTier = ENGINE_TIERS[setup.engineConfig.tier];
  const userIsWhite = setup.userColor === "w";
  const viewColor = flipped ? opposite(setup.userColor) : setup.userColor;
  const thinking = game.phase === "engine-thinking";
  const myTurn = game.phase === "user-turn";
  const over = game.phase === "over";

  const startMeta = useMemo(() => {
    const chess = new Chess(setup.fen);
    return { turn: chess.turn(), moveNumber: chess.moveNumber() };
  }, [setup.fen]);

  const check = useMemo(() => {
    if (!game.inCheck) return null;
    const chess = new Chess(game.fen);
    const square = chess.findPiece({ type: "k", color: chess.turn() })[0];
    return square ? { square, mate: game.gameOver?.reason === "checkmate" } : null;
  }, [game.fen, game.inCheck, game.gameOver]);

  const { legalTargets } = game;
  const targets = useMemo(
    () => (selectedSquare ? legalTargets(selectedSquare) : []),
    [legalTargets, selectedSquare],
  );

  /** Shared entry point for drag-drop and click-to-move. */
  const tryMove = useCallback(
    (from: Square, to: Square, via: "drop" | "animated"): boolean => {
      if (!myTurn) return false;
      if (isPromotionMove(game.fen, from, to)) {
        game.setPendingPromotion({ from, to });
        return false; // the dialog finishes the move
      }
      const ok = game.applyUserMove(from, to, undefined, via);
      if (!ok && from !== to) {
        playSound("illegal");
        setSettle({ square: from, id: Date.now() });
      }
      return ok;
    },
    [game, myTurn],
  );

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
      select(null);
      if (!targetSquare) return false;
      return tryMove(sourceSquare as Square, targetSquare as Square, "drop");
    },
    [select, tryMove],
  );

  const onSquareClick = useCallback(
    ({ square }: { square: string }) => {
      if (!myTurn) return;
      const sq = square as Square;
      const current = selectedRef.current;
      if (current) {
        if (sq === current) return select(null);
        if (legalTargets(current).includes(sq)) {
          select(null);
          tryMove(current, sq, "animated");
          return;
        }
      }
      const piece = new Chess(game.fen).get(sq);
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
        ? `Loading engine \u2014 ${Math.round(p.percent * 100)}%${p.etaText ? ` \u00b7 ${p.etaText} left` : ""}`
        : `Loading ${engineTier.label} (${engineTier.sizeLabel})\u2026`;
    }
    if (over) return game.gameOver?.detail ?? "Game over";
    if (game.phase === "claim-pending") return "Your move allows a draw claim.";
    if (thinking) return `Engine thinking \u2014 depth ${game.searchDepth || "\u2026"}`;
    if (myTurn) return `Your move (${userIsWhite ? "White" : "Black"})`;
    return "Preparing position\u2026";
  })();

  const soundOn = prefs.soundOn;

  return (
    <div className="play">
      <header className="play__bar">
        <button type="button" className="btn btn--quiet btn--icon" onClick={onExit}>
          <ArrowLeft {...ICON} />
          <span>New position</span>
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
            className="icon-btn"
            onClick={() => setFlipped((f) => !f)}
            aria-pressed={flipped}
            aria-label="Flip board"
            title="Flip board"
          >
            <FlipVertical2 {...ICON} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setPrefs({ soundOn: !soundOn })}
            aria-pressed={!soundOn}
            aria-label={soundOn ? "Mute" : "Unmute"}
            title={soundOn ? "Mute" : "Unmute"}
          >
            {soundOn ? <Volume2 {...ICON} /> : <VolumeX {...ICON} />}
          </button>
          <SettingsMenu />
          <span className="play__divider" aria-hidden="true" />
          {game.canClaim && myTurn && (
            <button type="button" className="btn btn--claim btn--icon" onClick={game.claimDraw}>
              <Scale {...ICON} />
              <span>Claim draw</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn--quiet btn--icon"
            onClick={game.offerDraw}
            disabled={!game.canOfferDraw}
          >
            <Handshake {...ICON} />
            <span>Offer draw</span>
          </button>
          <button type="button" className="btn btn--quiet btn--icon" onClick={game.resign} disabled={over}>
            <Flag {...ICON} />
            <span>Resign</span>
          </button>
        </div>
      </header>

      {review.stage === "review" || review.stage === "summary" ? (
        game.gameOver && (
          <ReviewStrip over={game.gameOver} secondsLeft={review.secondsLeft} onContinue={review.skip} />
        )
      ) : (
        <div className={`status ${thinking ? "status--thinking" : ""}`}>
          {!myTurn && !over && <span className="spinner" />}
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
      )}

      {game.phase === "claim-pending" && (
        <div className="claim" role="alert">
          <span>This position allows a draw by {CLAIM_TEXT[game.rules.claimable[0]]}.</span>
          <button type="button" className="btn btn--claim btn--icon" onClick={game.claimDraw}>
            <Scale {...ICON} />
            <span>Claim draw</span>
          </button>
          <button type="button" className="btn btn--ghost" onClick={game.playOn}>
            Play on
          </button>
        </div>
      )}

      {myTurn && game.canClaim && (
        <p className="notice" data-testid="claimable">
          Draw claimable: {game.rules.claimable.map((k) => CLAIM_TEXT[k]).join(", ")}.
        </p>
      )}

      {game.drawOffer && !over && (
        <p className="notice" data-testid="draw-offer">
          {game.drawOffer.status === "open"
            ? "Draw offered. The engine answers on its move."
            : "The engine declined your draw offer and played on."}
        </p>
      )}

      <div className="play__grid">
        <div className="play__boardcol">
          <AuraHud message={auraMessage} />
          {flipped ? userTray : engineTray}

          <div className="boardwrap">
            <EvalBar assessment={game.assessment} orientation={viewColor} thinking={thinking} />
            <div className="board">
              <Board
                fen={game.fen}
                orientation={viewColor}
                interactive={myTurn}
                lastMove={game.lastMove}
                selected={selectedSquare}
                targets={targets}
                threats={game.threats}
                check={check}
                settle={settle}
                onPieceDrop={onPieceDrop}
                onSquareClick={onSquareClick}
              />
            </div>
          </div>

          {flipped ? engineTray : userTray}

          <MoveInput
            disabled={!myTurn}
            disabledText={over ? "Game over" : thinking ? "Engine is thinking\u2026" : "Waiting\u2026"}
            onSubmit={game.playSan}
          />
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
            game.applyUserMove(p.from, p.to, piece, "animated");
          }}
          onCancel={() => game.setPendingPromotion(null)}
        />
      )}

      {review.stage === "summary" && game.gameOver && (
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
