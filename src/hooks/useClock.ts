import { useCallback, useEffect, useRef, useState } from "react";
import type { Color } from "chess.js";

export interface TimeControl {
  id: string;
  label: string;
  baseMs: number;
  incMs: number;
}

export const TIME_CONTROLS: TimeControl[] = [
  { id: "3+2", label: "3 | 2", baseMs: 3 * 60_000, incMs: 2_000 },
  { id: "5+0", label: "5 | 0", baseMs: 5 * 60_000, incMs: 0 },
  { id: "10+0", label: "10 | 0", baseMs: 10 * 60_000, incMs: 0 },
  { id: "15+10", label: "15 | 10", baseMs: 15 * 60_000, incMs: 10_000 },
  { id: "30+0", label: "30 | 0", baseMs: 30 * 60_000, incMs: 0 },
];

export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  // Tenths in the last ten seconds, like Chess.com.
  if (clamped < 10_000) return `0:${String(s).padStart(2, "0")}.${Math.floor((clamped % 1000) / 100)}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Two-sided game clock. Imperative on purpose: moves settle time at the exact moment they
 * are made, not whenever React next renders.
 */
export function useClock(control: TimeControl | null, onFlag: (color: Color) => void) {
  const bank = useRef<Record<Color, number>>({
    w: control?.baseMs ?? 0,
    b: control?.baseMs ?? 0,
  });
  const running = useRef<Color | null>(null);
  const startedAt = useRef(0);
  const flagged = useRef(false);
  const onFlagRef = useRef(onFlag);
  useEffect(() => {
    onFlagRef.current = onFlag;
  }, [onFlag]);

  const live = useCallback((color: Color) => {
    const base = bank.current[color];
    return running.current === color ? base - (performance.now() - startedAt.current) : base;
  }, []);

  /** What the UI renders. Refreshed on every tick and every clock event. */
  const [display, setDisplay] = useState<{ w: number; b: number; running: Color | null }>({
    w: control?.baseMs ?? 0,
    b: control?.baseMs ?? 0,
    running: null,
  });
  const publish = useCallback(
    () => setDisplay({ w: live("w"), b: live("b"), running: running.current }),
    [live],
  );

  const settle = useCallback(() => {
    const side = running.current;
    if (side) bank.current[side] = live(side);
    running.current = null;
  }, [live]);

  const resume = useCallback(
    (color: Color) => {
      if (!control || flagged.current || running.current === color) return;
      settle();
      running.current = color;
      startedAt.current = performance.now();
      publish();
    },
    [control, publish, settle],
  );

  /** `color` just completed a move: stop its clock, add the increment, start the other. */
  const moveMade = useCallback(
    (color: Color) => {
      if (!control || flagged.current) return;
      if (running.current === color) settle();
      bank.current[color] += control.incMs;
      running.current = color === "w" ? "b" : "w";
      startedAt.current = performance.now();
      publish();
    },
    [control, publish, settle],
  );

  const pause = useCallback(() => {
    settle();
    publish();
  }, [publish, settle]);

  useEffect(() => {
    if (!control) return;
    const timer = setInterval(() => {
      const side = running.current;
      if (side && !flagged.current && live(side) <= 0) {
        flagged.current = true;
        bank.current[side] = 0;
        running.current = null;
        onFlagRef.current(side);
      }
      publish();
    }, 100);
    return () => clearInterval(timer);
  }, [control, live, publish]);

  return {
    enabled: control !== null,
    control,
    /** Live remaining time; for logic that needs the exact value right now. */
    remaining: live,
    /** Render-safe snapshot, refreshed every 100 ms. */
    display,
    resume,
    pause,
    moveMade,
  };
}

export type GameClock = ReturnType<typeof useClock>;
