/**
 * The end of a game, in three stages:
 *
 *   effects  the final move lands, the mate glow and sound play, the last aura line shows
 *   review   the board stays frozen and fully visible; a slim strip names the result and
 *            counts down to the summary
 *   summary  the post-game modal
 *
 * Deliberately unlike Chess.com, which covers the board at once: the player gets to study
 * the final position first. Timing lives in src/config.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { END_EFFECTS_MS, GAME_OVER_REVIEW_SECONDS } from "../config";
import type { GameOverInfo } from "../chess/rules";

export type ReviewStage = "playing" | "effects" | "review" | "summary";

interface Progress {
  /** The ending this progress belongs to; a new ending restarts the sequence. */
  over: GameOverInfo;
  stage: "review" | "summary";
  deadline: number;
}

export function useGameOverReview(over: GameOverInfo | null) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(GAME_OVER_REVIEW_SECONDS);

  // Derived, so a new ending is in "effects" from its very first render.
  const stage: ReviewStage = !over ? "playing" : progress?.over === over ? progress.stage : "effects";

  useEffect(() => {
    if (!over) return;
    const t = setTimeout(() => {
      setSecondsLeft(GAME_OVER_REVIEW_SECONDS);
      setProgress({ over, stage: "review", deadline: performance.now() + GAME_OVER_REVIEW_SECONDS * 1000 });
    }, END_EFFECTS_MS);
    return () => clearTimeout(t);
  }, [over]);

  useEffect(() => {
    if (stage !== "review" || !progress) return;
    const tick = setInterval(() => {
      const left = Math.max(0, Math.ceil((progress.deadline - performance.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setProgress({ ...progress, stage: "summary" });
    }, 250);
    return () => clearInterval(tick);
  }, [stage, progress]);

  const skip = useCallback(() => {
    if (over) setProgress({ over, stage: "summary", deadline: 0 });
  }, [over]);

  return { stage, secondsLeft, skip };
}

/** Short headline for the strip, e.g. "Checkmate — White wins". */
export function resultHeadline(over: GameOverInfo): string {
  const side = over.winner === "w" ? "White" : over.winner === "b" ? "Black" : null;
  const outcome = side ? `${side} wins` : "Draw";
  const cause: Record<GameOverInfo["reason"], string> = {
    checkmate: "Checkmate",
    stalemate: "Stalemate",
    "insufficient-material": "Insufficient material",
    "threefold-repetition": "Threefold repetition",
    "fivefold-repetition": "Fivefold repetition",
    "fifty-move-rule": "50-move rule",
    "seventy-five-move-rule": "75-move rule",
    agreement: "Agreement",
    resignation: "Resignation",
    "engine-resignation": "Resignation",
    timeout: "Time",
    "timeout-vs-insufficient-material": "Time vs insufficient material",
  };
  return `${cause[over.reason]} \u2014 ${outcome}`;
}
