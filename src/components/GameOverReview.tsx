/** The slim result strip shown while the player studies the final position. */
import { useEffect } from "react";
import { ChevronRight } from "lucide-react";
import { GAME_OVER_REVIEW_SECONDS } from "../config";
import { resultHeadline } from "../hooks/useGameOverReview";
import type { GameOverInfo } from "../chess/rules";

/** Clicks on these never count as "continue". */
const INTERACTIVE = "button, a, input, select, textarea, label, [role='dialog'], .board-frame, .settings-menu";

export function ReviewStrip({
  over,
  secondsLeft,
  onContinue,
}: {
  over: GameOverInfo;
  secondsLeft: number;
  onContinue: () => void;
}) {
  // Continue on Enter/Escape/Space, or a click anywhere that isn't a control or the board
  // (the board stays usable for drawing arrows while studying).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select")) return;
      if (e.key === "Enter" || e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        onContinue();
      }
    };
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest(INTERACTIVE)) return;
      onContinue();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [onContinue]);

  const fraction = secondsLeft / GAME_OVER_REVIEW_SECONDS;
  return (
    <div className="review" role="status" data-testid="review-strip">
      <span className="review__result">{resultHeadline(over)}</span>
      <span className="review__timer" data-testid="review-countdown">
        Summary in {secondsLeft}s
      </span>
      <button type="button" className="btn btn--review" onClick={onContinue}>
        Continue
        <ChevronRight size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <span className="review__bar" style={{ transform: `scaleX(${fraction})` }} aria-hidden="true" />
    </div>
  );
}
