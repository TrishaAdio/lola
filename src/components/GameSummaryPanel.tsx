import type { GameSummary } from "../chess/analysis";
import type { GameOverInfo } from "../hooks/useGame";

interface Props {
  over: GameOverInfo;
  summary: GameSummary | null;
  userColor: "w" | "b";
  onRematch: () => void;
  onNewPosition: () => void;
}

const CLASSIFICATION_LABEL: Record<string, string> = {
  best: "best",
  good: "good",
  inaccuracy: "inaccuracies",
  mistake: "mistakes",
  blunder: "blunders",
};

export function GameSummaryPanel({ over, summary, userColor, onRematch, onNewPosition }: Props) {
  const user = summary?.user;
  const worst = user?.worst;
  const outcome =
    over.winner === null ? "Draw" : over.winner === userColor ? "You won" : "You lost";

  return (
    <div className="modal">
      <div className="modal__card modal__card--wide">
        <header className="summary__head">
          <h2>{outcome}</h2>
          <p className="summary__detail">{over.detail}</p>
        </header>

        {user && user.moves > 0 ? (
          <>
            <div className="summary__stats">
              <div className="stat">
                <span className="stat__value">{user.accuracy.toFixed(1)}%</span>
                <span className="stat__label">your accuracy</span>
              </div>
              <div className="stat">
                <span className="stat__value">
                  {user.averageCpLoss !== undefined ? Math.round(user.averageCpLoss) : "—"}
                </span>
                <span className="stat__label">avg centipawn loss</span>
              </div>
              <div className="stat">
                <span className="stat__value">{user.moves}</span>
                <span className="stat__label">moves scored</span>
              </div>
            </div>

            <div className="summary__counts">
              {(["best", "good", "inaccuracy", "mistake", "blunder"] as const).map((k) => (
                <span key={k} className={`tag tag--${k}`}>
                  {user.counts[k]} {CLASSIFICATION_LABEL[k]}
                </span>
              ))}
            </div>

            {worst ? (
              <div className="summary__blunder">
                <h3>Biggest blunder</h3>
                <p>
                  <strong>
                    {worst.record.moveNumber}
                    {worst.record.color === "w" ? "." : "..."}
                    {worst.record.san}
                  </strong>{" "}
                  gave up {worst.winLoss.toFixed(1)} percentage points of winning chances
                  {worst.cpLoss !== undefined ? ` (${Math.round(worst.cpLoss)} centipawns)` : ""}.
                </p>
                <p className="summary__winline">
                  {worst.moverWinBefore.toFixed(0)}% → {worst.moverWinAfter.toFixed(0)}% win
                  probability
                </p>
                {user.worstBetterLine && (
                  <>
                    <h4>Engine's main line instead</h4>
                    <p className="summary__pv">{user.worstBetterLine}</p>
                  </>
                )}
              </div>
            ) : (
              <p className="note">No scored mistakes — the engine never got a swing out of you.</p>
            )}
          </>
        ) : (
          <p className="note">
            Not enough analysed moves to score this game. Play a few more moves next time.
          </p>
        )}

        <div className="summary__actions">
          <button type="button" className="btn btn--primary" onClick={onRematch}>
            Rematch
          </button>
          <button type="button" className="btn btn--ghost" onClick={onNewPosition}>
            Choose another position
          </button>
        </div>
      </div>
    </div>
  );
}
