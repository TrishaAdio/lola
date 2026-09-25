import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import type { Color, Move, Square } from "chess.js";
import { UciEngine } from "../engine/uci";
import type { DownloadProgress } from "../engine/uci";
import { selectRuthlessMove } from "../engine/policy";
import type { PolicyDecision } from "../engine/policy";
import type { EngineConfig, EngineInfo } from "../engine/types";
import { opposite, parseUciMove } from "../chess/moves";
import type { ThreatReport } from "../chess/threats";
import { summariseGame } from "../chess/analysis";
import type { Assessment, GameSummary, MoveRecord } from "../chess/analysis";

export interface GameSetup {
  fen: string;
  /** SAN moves that led to `fen`, so repetition detection has real history. */
  history: string[];
  userColor: Color;
  positionName: string;
  engineConfig: EngineConfig;
  /** Apply the pressure/anti-draw tie-break layer on top of Stockfish's choice. */
  ruthless: boolean;
}

export type GamePhase = "loading" | "user-turn" | "engine-thinking" | "over";

export interface GameOverInfo {
  reason:
    | "checkmate"
    | "stalemate"
    | "insufficient-material"
    | "threefold-repetition"
    | "fifty-move-rule"
    | "resignation";
  /** Winner, or null for a draw. */
  winner: Color | null;
  detail: string;
}

export interface EngineStatus {
  state: "idle" | "loading" | "ready" | "error";
  error?: string;
  progress?: DownloadProgress;
}

/** Converts a side-to-move engine score into a White-POV assessment. */
function toAssessment(info: EngineInfo, searchingColor: Color, bestLine: string[]): Assessment {
  const flip = searchingColor === "w" ? 1 : -1;
  return {
    whiteCp: info.cp !== undefined ? info.cp * flip : undefined,
    whiteMate: info.mate !== undefined && info.mate !== 0 ? info.mate * flip : undefined,
    depth: info.depth,
    bestLine,
  };
}

/**
 * Real move number for a position, taken from the FEN. Deriving it from the ply count
 * would be wrong whenever a game starts mid-position or on Black's move.
 */
function moveNumberOf(fen: string): number {
  const n = Number(fen.split(" ")[5]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function describeGameOver(chess: Chess): GameOverInfo | null {
  if (!chess.isGameOver()) return null;
  const loser = chess.turn();

  if (chess.isCheckmate()) {
    return {
      reason: "checkmate",
      winner: opposite(loser),
      detail: `Checkmate. ${opposite(loser) === "w" ? "White" : "Black"} wins.`,
    };
  }
  if (chess.isStalemate()) {
    return { reason: "stalemate", winner: null, detail: "Stalemate. Draw by rule." };
  }
  if (chess.isInsufficientMaterial()) {
    return {
      reason: "insufficient-material",
      winner: null,
      detail: "Insufficient material. Draw by rule.",
    };
  }
  if (chess.isThreefoldRepetition()) {
    return {
      reason: "threefold-repetition",
      winner: null,
      detail: "Threefold repetition. Draw by rule.",
    };
  }
  if (chess.isDrawByFiftyMoves()) {
    return { reason: "fifty-move-rule", winner: null, detail: "Fifty-move rule. Draw by rule." };
  }
  return { reason: "stalemate", winner: null, detail: "Draw." };
}

export function useGame(setup: GameSetup) {
  const engineRef = useRef<UciEngine | null>(null);
  const chessRef = useRef<Chess>(new Chess());
  const abortRef = useRef<AbortController | null>(null);
  /** Bumped whenever the game is reset, to invalidate in-flight searches. */
  const generationRef = useRef(0);
  /** Assessment of the current position while the user is on move. */
  const baselineRef = useRef<Assessment | null>(null);

  const [engineStatus, setEngineStatus] = useState<EngineStatus>({ state: "idle" });
  const [phase, setPhase] = useState<GamePhase>("loading");
  const [fen, setFen] = useState(setup.fen);
  const [records, setRecords] = useState<MoveRecord[]>([]);
  const [gameOver, setGameOver] = useState<GameOverInfo | null>(null);
  const [liveInfo, setLiveInfo] = useState<EngineInfo | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [decision, setDecision] = useState<PolicyDecision | null>(null);
  const [threats, setThreats] = useState<ThreatReport | null>(null);
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(
    null,
  );
  const [searchDepth, setSearchDepth] = useState(0);

  const engineColor = useMemo(() => opposite(setup.userColor), [setup.userColor]);

  // Throttle the flood of `info` lines into React state.
  const pendingInfoRef = useRef<EngineInfo | null>(null);
  const rafRef = useRef<number | null>(null);
  const pushInfo = useCallback((info: EngineInfo) => {
    pendingInfoRef.current = info;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const next = pendingInfoRef.current;
      if (next && next.multipv === 1) {
        setLiveInfo(next);
        setSearchDepth(next.depth);
      }
    });
  }, []);

  /** Rebuilds the chess instance from the setup, replaying history when possible. */
  const buildChess = useCallback(() => {
    const chess = new Chess(setup.fen);
    if (setup.history.length > 0) {
      const replay = new Chess();
      try {
        for (const san of setup.history) replay.move(san);
        if (replay.fen() === chess.fen()) return replay;
      } catch {
        /* fall through to the plain FEN */
      }
    }
    return chess;
  }, [setup.fen, setup.history]);

  // ---- engine lifecycle -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const engine = new UciEngine();
    engineRef.current = engine;
    setEngineStatus({ state: "loading" });

    (async () => {
      try {
        await engine.start(setup.engineConfig.tier, (progress) => {
          if (!cancelled) setEngineStatus({ state: "loading", progress });
        });
        if (cancelled) return;
        await engine.configure(setup.engineConfig);
        if (cancelled) return;
        await engine.newGame();
        if (cancelled) return;
        setEngineStatus({ state: "ready" });
      } catch (err) {
        if (cancelled) return;
        setEngineStatus({
          state: "error",
          error: err instanceof Error ? err.message : "Failed to start the engine.",
        });
      }
    })();

    return () => {
      cancelled = true;
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup.engineConfig.tier]);

  // Engine options are applied once during start(), above. They are deliberately not
  // re-sent here: `setoption` is illegal while a search is running, and the setup screen
  // is the only place configuration is chosen (starting a game remounts this hook).

  // ---- position bootstrap ----------------------------------------------------------
  useEffect(() => {
    generationRef.current++;
    abortRef.current?.abort();
    const chess = buildChess();
    chessRef.current = chess;
    baselineRef.current = null;
    setFen(chess.fen());
    setRecords([]);
    setGameOver(describeGameOver(chess));
    setLiveInfo(null);
    setAssessment(null);
    setDecision(null);
    setThreats(null);
    setLastMove(null);
    setPendingPromotion(null);
    setSearchDepth(0);
  }, [buildChess]);

  /** Clears threat highlights a few seconds after they appear. */
  useEffect(() => {
    if (!threats) return;
    const timer = setTimeout(() => setThreats(null), 4500);
    return () => clearTimeout(timer);
  }, [threats]);

  const finishIfOver = useCallback((chess: Chess) => {
    const over = describeGameOver(chess);
    if (over) {
      setGameOver(over);
      setPhase("over");
      return true;
    }
    return false;
  }, []);

  // ---- the engine's turn ------------------------------------------------------------
  const runEngineMove = useCallback(async () => {
    const engine = engineRef.current;
    const chess = chessRef.current;
    if (!engine || !engine.isReady) return;

    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase("engine-thinking");
    setLiveInfo(null);
    setSearchDepth(0);

    const fenBefore = chess.fen();
    const history = chess.history();

    try {
      const result = await engine.search(
        fenBefore,
        setup.engineConfig.limits,
        pushInfo,
        controller.signal,
      );
      if (generation !== generationRef.current) return;

      const chosen = selectRuthlessMove(fenBefore, result, {
        history,
        ruthless: setup.ruthless,
      });
      if (!chosen) {
        finishIfOver(chess);
        return;
      }

      // Assessment of the position the engine was handed (i.e. after the user's move).
      const topInfo = chosen.candidates[0]?.info;
      const assessmentBefore = topInfo
        ? toAssessment(topInfo, engineColor, chosen.chosen.info.pv)
        : undefined;

      const parts = parseUciMove(chosen.uci);
      if (!parts) return;
      let move: Move;
      try {
        move = chess.move(parts);
      } catch {
        return;
      }

      const fenAfter = chess.fen();

      setRecords((prev) => {
        const next = [...prev];
        // Attach the "after" assessment to the user's move that created this position.
        if (next.length > 0 && assessmentBefore) {
          const lastIdx = next.length - 1;
          if (!next[lastIdx].byEngine) {
            next[lastIdx] = { ...next[lastIdx], after: assessmentBefore };
          }
        }
        next.push({
          ply: next.length + 1,
          moveNumber: moveNumberOf(fenBefore),
          color: move.color,
          san: move.san,
          uci: chosen.uci,
          fenBefore,
          fenAfter,
          byEngine: true,
          capturedPiece: move.captured,
          before: assessmentBefore,
          after: assessmentBefore,
        });
        return next;
      });

      if (assessmentBefore) {
        setAssessment(assessmentBefore);
        // The engine's line, minus its own move, is the user's best continuation.
        baselineRef.current = {
          ...assessmentBefore,
          bestLine: chosen.chosen.info.pv.slice(1),
        };
      }

      setDecision(chosen);
      setThreats(chosen.chosen.report);
      setLastMove({ from: move.from, to: move.to });
      setFen(fenAfter);

      if (!finishIfOver(chess)) setPhase("user-turn");
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setEngineStatus({
        state: "error",
        error: err instanceof Error ? err.message : "Engine search failed.",
      });
    }
  }, [engineColor, finishIfOver, pushInfo, setup.engineConfig.limits, setup.ruthless]);

  /** Seeds an evaluation for the position the user is about to move in. */
  const runSeedAnalysis = useCallback(async () => {
    const engine = engineRef.current;
    const chess = chessRef.current;
    if (!engine || !engine.isReady) return;

    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;

    const fenBefore = chess.fen();
    const userColor = chess.turn();

    // Keep the seed search short - the user should not wait to make their first move.
    const limits = {
      depth: Math.min(setup.engineConfig.limits.depth ?? 18, 16),
      movetimeMs: Math.min(setup.engineConfig.limits.movetimeMs ?? 1200, 1200),
    };

    try {
      const result = await engine.search(fenBefore, limits, pushInfo, controller.signal);
      if (generation !== generationRef.current) return;
      const top = result.lines[0];
      if (!top) return;
      const seeded = toAssessment(top, userColor, top.pv);
      setAssessment(seeded);
      baselineRef.current = seeded;
    } catch {
      /* aborted or failed: the first move simply won't be scored */
    }
  }, [pushInfo, setup.engineConfig.limits]);

  // ---- turn driver ------------------------------------------------------------------
  useEffect(() => {
    if (engineStatus.state !== "ready") return;
    if (gameOver) {
      setPhase("over");
      return;
    }
    const chess = chessRef.current;
    if (chess.turn() === engineColor) {
      setPhase("engine-thinking");
      void runEngineMove();
    } else {
      setPhase("user-turn");
      if (!baselineRef.current) void runSeedAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineStatus.state, fen, gameOver, engineColor]);

  // ---- user actions -----------------------------------------------------------------
  const applyUserMove = useCallback(
    (from: Square, to: Square, promotion?: string): boolean => {
      const chess = chessRef.current;
      if (chess.turn() !== setup.userColor) return false;
      if (gameOver) return false;

      const fenBefore = chess.fen();
      let move: Move;
      try {
        move = chess.move({ from, to, promotion: promotion as never });
      } catch {
        return false;
      }

      // Capture the pre-move assessment before clearing it.
      const before = baselineRef.current ?? assessment ?? undefined;

      // The user has committed; any seed analysis in flight is stale.
      abortRef.current?.abort();
      baselineRef.current = null;
      setThreats(null);
      setDecision(null);
      setRecords((prev) => [
        ...prev,
        {
          ply: prev.length + 1,
          moveNumber: moveNumberOf(fenBefore),
          color: move.color,
          san: move.san,
          uci: `${move.from}${move.to}${move.promotion ?? ""}`,
          fenBefore,
          fenAfter: chess.fen(),
          byEngine: false,
          capturedPiece: move.captured,
          before,
        },
      ]);

      setLastMove({ from: move.from, to: move.to });
      setFen(chess.fen());
      setPendingPromotion(null);
      finishIfOver(chess);
      return true;
    },
    [assessment, finishIfOver, gameOver, setup.userColor],
  );

  /** Plays a move written in algebraic notation. Returns an error message on failure. */
  const playSan = useCallback(
    (input: string): string | null => {
      const chess = chessRef.current;
      if (gameOver) return "The game is over.";
      if (chess.turn() !== setup.userColor) return "It is not your turn.";

      const cleaned = input.trim().replace(/[!?]+$/, "");
      if (!cleaned) return "Type a move, e.g. Nf3.";

      const probe = new Chess(chess.fen());
      let move: Move;
      try {
        move = probe.move(cleaned);
      } catch {
        return `"${input.trim()}" is not a legal move here.`;
      }
      const ok = applyUserMove(move.from, move.to, move.promotion);
      return ok ? null : "Could not play that move.";
    },
    [applyUserMove, gameOver, setup.userColor],
  );

  const resign = useCallback(() => {
    abortRef.current?.abort();
    setGameOver({
      reason: "resignation",
      winner: engineColor,
      detail: "You resigned. The engine does not acknowledge it.",
    });
    setPhase("over");
  }, [engineColor]);

  const summary: GameSummary | null = useMemo(() => {
    if (!gameOver) return null;
    return summariseGame(records, setup.userColor);
  }, [gameOver, records, setup.userColor]);

  const capturedByUser = useMemo(
    () => records.filter((r) => !r.byEngine && r.capturedPiece).map((r) => r.capturedPiece!),
    [records],
  );
  const capturedByEngine = useMemo(
    () => records.filter((r) => r.byEngine && r.capturedPiece).map((r) => r.capturedPiece!),
    [records],
  );

  const turn: Color = useMemo(() => new Chess(fen).turn(), [fen]);

  const legalTargets = useCallback(
    (square: Square): Square[] =>
      chessRef.current
        .moves({ square, verbose: true })
        .map((m) => m.to as Square),
    [],
  );

  return {
    fen,
    turn,
    phase,
    engineStatus,
    engineColor,
    records,
    gameOver,
    summary,
    liveInfo,
    assessment,
    decision,
    threats,
    lastMove,
    searchDepth,
    pendingPromotion,
    capturedByUser,
    capturedByEngine,
    inCheck: useMemo(() => new Chess(fen).inCheck(), [fen]),
    setPendingPromotion,
    applyUserMove,
    playSan,
    resign,
    legalTargets,
  };
}
