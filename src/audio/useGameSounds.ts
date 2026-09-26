import { useEffect, useRef } from "react";
import { playSound } from "./sound";
import type { SoundName } from "./sound";
import { MOVE_ANIMATION_MS } from "../config";
import type { MoveVisual } from "../hooks/useGame";
import type { GameOverInfo } from "../chess/rules";

/** The one sound a move makes. Checks outrank captures, as on every major site. */
export function soundForMove(m: MoveVisual): SoundName {
  if (m.mate) return "mate";
  if (m.check) return "check";
  if (m.captured) return "capture";
  if (m.castle) return "castle";
  return "move";
}

interface Options {
  lastMove: MoveVisual | null;
  gameOver: GameOverInfo | null;
  auraId: number | null;
  reducedMotion: boolean;
}

/**
 * Voices the game. Animated moves sound as the piece lands, not when it lifts, so the
 * thud and the motion line up.
 */
export function useGameSounds({ lastMove, gameOver, auraId, reducedMotion }: Options) {
  const lastMoveId = useRef<number | null>(null);
  const endedFor = useRef<GameOverInfo | null>(null);
  const lastAura = useRef<number | null>(null);

  useEffect(() => {
    if (!lastMove || lastMove.id === lastMoveId.current) return;
    lastMoveId.current = lastMove.id;
    const land = lastMove.via === "animated" && !reducedMotion ? Math.round(MOVE_ANIMATION_MS * 0.85) : 0;
    playSound(soundForMove(lastMove), land);
  }, [lastMove, reducedMotion]);

  useEffect(() => {
    if (!gameOver || endedFor.current === gameOver) return;
    endedFor.current = gameOver;
    // Checkmate already sounded with the mating move.
    if (gameOver.reason !== "checkmate") playSound("end", 120);
  }, [gameOver]);

  useEffect(() => {
    if (auraId === null || auraId === lastAura.current) return;
    lastAura.current = auraId;
    // Let the move land first; the line follows it.
    playSound("aura", MOVE_ANIMATION_MS + 260);
  }, [auraId]);
}
