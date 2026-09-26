import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, DEFAULT_POSITION } from "chess.js";
import type { Color, Move, Square } from "chess.js";
import { UciEngine } from "../engine/uci";
import type { DownloadProgress } from "../engine/uci";
import { PROPHYLAXIS_WINDOW_CP, selectMove } from "../engine/policy";
import type { PolicyDecision } from "../engine/policy";
import type { PlanState } from "../engine/strategy/plans";
import { nullMoveFen, THREAT_THRESHOLD_CP } from "../engine/strategy/prophylaxis";
import type { ThreatInfo } from "../engine/strategy/prophylaxis";
import { logDecision, resetStrategyLog } from "../engine/strategyLog";
import type { EngineConfig, EngineInfo, SearchLimits, SearchResult } from "../engine/types";
import {
  boardTargets,
  opposite,
  parseUciMove,
  resolveBoardMove,
  resolveTypedMove,
  sanitizeCastlingRights,
} from "../chess/moves";
import type { ThreatReport } from "../chess/threats";
import { summariseGame } from "../chess/analysis";
import type { Assessment, GameSummary, MoveRecord } from "../chess/analysis";
import { adjudicateTimeout, claimedDraw, evaluateRules } from "../chess/rules";
import type { DrawClaimMode, GameOverInfo, RulesState } from "../chess/rules";
import { evaluateAura, initialAuraState } from "../aura/aura";
import type { AuraMessage } from "../aura/aura";
import { auraInputFrom } from "../aura/inputs";
import { useClock } from "./useClock";
import type { TimeControl } from "./useClock";

export type { GameOverInfo } from "../chess/rules";

export interface GameSetup {
  fen: string;
  /** SAN moves that led to `fen`, so repetition detection has real history. */
  history: string[];
  userColor: Color;
  positionName: string;
  engineConfig: EngineConfig;
  /** Strategic layer on top of Stockfish. Off = Stockfish's #1 move, always. */
  strategic: boolean;
  drawClaims: DrawClaimMode;
  /** Tactics Aura commentary. */
  aura: boolean;
  /** Let the engine resign hopeless technical endgames. Off by default. */
  engineMayResign: boolean;
  timeControl: TimeControl | null;
}

export type GamePhase = "loading" | "user-turn" | "engine-thinking" | "claim-pending" | "over";

export interface DrawOffer {
  status: "open" | "declined";
  /** Ply count when the offer was made. */
  ply: number;
}

export interface EngineStatus {
  state: "idle" | "loading" | "ready" | "error";
  error?: string;
  progress?: DownloadProgress;
}

// ---- engine judgement thresholds (engine's point of view) ---------------------------------

/** Accept a draw offer / claim a draw only when genuinely losing: WDL loss >= 60%. */
const LOSING_WDL_LOSS = 600;
const LOSING_CP = -150;
/** ...or in a well-founded dead draw: Stockfish sees >= 97% draw and <= 1% win. */
const DEAD_DRAW_WDL_DRAW = 970;
const DEAD_DRAW_WDL_WIN = 10;
const DEAD_DRAW_MIN_DEPTH = 12;
/** Resignation (opt-in): mated within this many moves, or this bad three turns running. */
const RESIGN_MATE_WITHIN = 10;
const RESIGN_CP = -900;
const RESIGN_STREAK = 3;

function isLosing(info: EngineInfo): boolean {
  if (info.mate !== undefined && info.mate < 0) return true;
  if (info.wdl) return info.wdl[2] >= LOSING_WDL_LOSS;
  return (info.cp ?? 0) <= LOSING_CP;
}

function isDeadDraw(info: EngineInfo): boolean {
  return (
    info.mate === undefined &&
    info.depth >= DEAD_DRAW_MIN_DEPTH &&
    !!info.wdl &&
    info.wdl[1] >= DEAD_DRAW_WDL_DRAW &&
    info.wdl[0] <= DEAD_DRAW_WDL_WIN
  );
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

/** Real move number for a position, taken from the FEN. */
function moveNumberOf(fen: string): number {
  const n = Number(fen.split(" ")[5]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const AURA_STORAGE_KEY = "ruthless-chess:aura";

export function useGame(setup: GameSetup) {
  const engineRef = useRef<UciEngine | null>(null);
  const chessRef = useRef<Chess>(new Chess());
  /** FEN the game's move history starts from - needed to count repetitions. */
  const startFenRef = useRef(DEFAULT_POSITION);
  const abortRef = useRef<AbortController | null>(null);
  /** Bumped on reset and game over, to invalidate in-flight searches. */
  const generationRef = useRef(0);
  /** Assessment of the current position while the user is on move. */
  const baselineRef = useRef<Assessment | null>(null);
  const planRef = useRef<PlanState | null>(null);
  const auraStateRef = useRef(initialAuraState());
  const engineMovesRef = useRef(0);
  /** Engine's win probability after its previous move, for blunder detection. */
  const lastEngineWinRef = useRef<number | null>(null);
  const hopelessStreakRef = useRef(0);
  const offerRef = useRef<DrawOffer | null>(null);

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
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [searchDepth, setSearchDepth] = useState(0);
  const [drawOffer, setDrawOfferState] = useState<DrawOffer | null>(null);
  const [auraMessage, setAuraMessage] = useState<(AuraMessage & { id: number }) | null>(null);
  const [auraEnabled, setAuraEnabledState] = useState(setup.aura);

  const engineColor = useMemo(() => opposite(setup.userColor), [setup.userColor]);

  const setDrawOffer = useCallback((offer: DrawOffer | null) => {
    offerRef.current = offer;
    setDrawOfferState(offer);
  }, []);

  const setAuraEnabled = useCallback((on: boolean) => {
    setAuraEnabledState(on);
    try {
      localStorage.setItem(AURA_STORAGE_KEY, on ? "on" : "off");
    } catch {
      /* storage unavailable */
    }
  }, []);

  const finish = useCallback((info: GameOverInfo) => {
    generationRef.current++;
    abortRef.current?.abort();
    setGameOver(info);
    setPhase("over");
  }, []);

  const clock = useClock(setup.timeControl, (flagged) => {
    finish(adjudicateTimeout(chessRef.current, flagged));
  });
  const clockRef = useRef(clock);
  useEffect(() => {
    clockRef.current = clock;
  }, [clock]);

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

  /**
   * Rebuilds the game from the setup. Always a real `new Chess(...)` from a FEN or by
   * replaying SAN - never a copied object - so castling rights and history are intact.
   */
  const buildChess = useCallback(() => {
    const { fen: startFen } = sanitizeCastlingRights(setup.fen);
    const chess = new Chess(startFen);
    if (setup.history.length > 0) {
      const replay = new Chess();
      try {
        for (const san of setup.history) replay.move(san);
        if (replay.fen() === chess.fen()) return { chess: replay, startFen: DEFAULT_POSITION };
      } catch {
        /* fall through to the plain FEN */
      }
    }
    return { chess, startFen: chess.fen() };
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

  // ---- position bootstrap ----------------------------------------------------------
  useEffect(() => {
    generationRef.current++;
    abortRef.current?.abort();
    const { chess, startFen } = buildChess();
    chessRef.current = chess;
    startFenRef.current = startFen;
    baselineRef.current = null;
    planRef.current = null;
    auraStateRef.current = initialAuraState();
    engineMovesRef.current = 0;
    lastEngineWinRef.current = null;
    hopelessStreakRef.current = 0;
    resetStrategyLog();
    setDrawOffer(null);
    setFen(chess.fen());
    setRecords([]);
    setGameOver(evaluateRules(chess, startFen, setup.drawClaims).terminal);
    setLiveInfo(null);
    setAssessment(null);
    setDecision(null);
    setThreats(null);
    setLastMove(null);
    setPendingPromotion(null);
    setSearchDepth(0);
    setAuraMessage(null);
  }, [buildChess, setDrawOffer, setup.drawClaims]);

  /** Clears threat highlights a few seconds after they appear. */
  useEffect(() => {
    if (!threats) return;
    const timer = setTimeout(() => setThreats(null), 4500);
    return () => clearTimeout(timer);
  }, [threats]);

  /** Aura lines fade out on their own. */
  useEffect(() => {
    if (!auraMessage) return;
    const timer = setTimeout(() => setAuraMessage(null), 7000);
    return () => clearTimeout(timer);
  }, [auraMessage]);

  /** Rule state of the current position: endings and claimable draws. */
  const rules: RulesState = useMemo(
    () => evaluateRules(chessRef.current, startFenRef.current, setup.drawClaims),
    // `fen` changes on every move; the ref holds the matching game.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fen, setup.drawClaims],
  );

  // The clock runs only while someone is actually on move.
  useEffect(() => {
    const c = clockRef.current;
    if (phase === "user-turn") c.resume(setup.userColor);
    else if (phase === "engine-thinking") c.resume(engineColor);
    else c.pause();
  }, [phase, setup.userColor, engineColor]);

  /** Per-move search limits; with a clock on, never spend more than it can afford. */
  const limitsFor = useCallback(
    (color: Color): SearchLimits => {
      const base = setup.engineConfig.limits;
      const c = clockRef.current;
      if (!c.enabled || !c.control) return base;
      const left = c.remaining(color);
      const affordable = left / 25 + c.control.incMs * 0.75;
      return {
        depth: base.depth,
        movetimeMs: Math.round(Math.max(100, Math.min(base.movetimeMs ?? 5000, affordable))),
      };
    },
    [setup.engineConfig.limits],
  );

  /**
   * Null-move search: what would the opponent do if they could move right now? That move
   * is their most dangerous idea - what prophylaxis tries to prevent.
   */
  const probeThreat = useCallback(
    async (engine: UciEngine, fenBefore: string, result: SearchResult, signal: AbortSignal) => {
      const top = result.lines[0];
      if (!top || top.mate !== undefined) return null;
      // Only worth the time if some alternative is close enough for prophylaxis to matter.
      const close = result.lines.some(
        (l, i) => i > 0 && l.mate === undefined && (top.cp ?? 0) - (l.cp ?? 0) <= PROPHYLAXIS_WINDOW_CP,
      );
      if (!close) return null;
      const c = clockRef.current;
      if (c.enabled && c.remaining(engineColor) < 15_000) return null;

      const nullFen = nullMoveFen(fenBefore);
      if (!nullFen) return null;
      const probe = await engine.search(nullFen, { depth: 10, movetimeMs: 250 }, undefined, signal, {
        multiPv: 1,
      });
      const reply = probe.lines[0];
      if (!reply || reply.pv.length === 0) return null;
      const oppScore = reply.mate !== undefined ? (reply.mate > 0 ? 1000 : -1000) : (reply.cp ?? 0);
      const gainCp = (top.cp ?? 0) + oppScore;
      if (gainCp < THREAT_THRESHOLD_CP) return null;

      const parts = parseUciMove(reply.pv[0]);
      if (!parts) return null;
      try {
        const san = new Chess(nullFen).move(parts).san;
        return { uci: reply.pv[0], san, gainCp: Math.round(gainCp) } satisfies ThreatInfo;
      } catch {
        return null;
      }
    },
    [engineColor],
  );

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
    const ply = history.length;

    try {
      const result = await engine.search(fenBefore, limitsFor(engineColor), pushInfo, controller.signal);
      if (generation !== generationRef.current) return;
      const top = result.lines[0];

      // 1. An open draw offer is decided by the engine's actual evaluation.
      if (offerRef.current?.status === "open") {
        if (top && (isLosing(top) || isDeadDraw(top))) {
          finish({
            reason: "agreement",
            winner: null,
            detail: isLosing(top)
              ? "Draw agreed. The engine accepted: it is losing."
              : "Draw agreed. The engine accepted: the position is a dead draw.",
          });
          return;
        }
        // Playing a move without accepting declines the offer (Chess.com rule).
        setDrawOffer({ status: "declined", ply: offerRef.current.ply });
      }

      // 2. A claimable draw is taken only when it is losing.
      const before = evaluateRules(chess, startFenRef.current, setup.drawClaims);
      if (before.claimable.length > 0 && top && isLosing(top)) {
        finish(claimedDraw(before.claimable[0], "engine"));
        return;
      }

      // 3. Optional resignation, only in genuinely hopeless positions.
      if (setup.engineMayResign && top) {
        const mated = top.mate !== undefined && top.mate < 0 && -top.mate <= RESIGN_MATE_WITHIN;
        hopelessStreakRef.current = (top.cp ?? 0) <= RESIGN_CP || mated ? hopelessStreakRef.current + 1 : 0;
        if (mated || hopelessStreakRef.current >= RESIGN_STREAK) {
          finish({
            reason: "engine-resignation",
            winner: setup.userColor,
            detail: `The engine resigned. ${setup.userColor === "w" ? "White" : "Black"} wins.`,
          });
          return;
        }
      }

      // 4. The opponent's best idea, for prophylaxis.
      const threat = setup.strategic
        ? await probeThreat(engine, fenBefore, result, controller.signal).catch(() => null)
        : null;
      if (generation !== generationRef.current) return;

      // 5. Stockfish proposes, the strategic layer disposes.
      const chosen = selectMove(fenBefore, result, {
        startFen: startFenRef.current,
        history,
        strategic: setup.strategic,
        plan: planRef.current,
        threat,
        ply,
      });
      if (!chosen) return;
      planRef.current = chosen.plan;
      logDecision(chosen, ply + 1);

      const topInfo = chosen.stockfishBest.info;
      const assessmentBefore = toAssessment(topInfo, engineColor, chosen.chosen.info.pv);

      const parts = parseUciMove(chosen.uci);
      if (!parts) return;
      let move: Move;
      try {
        move = chess.move(parts);
      } catch {
        return;
      }
      clockRef.current.moveMade(engineColor);
      const fenAfter = chess.fen();

      setRecords((prev) => {
        const next = [...prev];
        if (next.length > 0 && !next[next.length - 1].byEngine) {
          next[next.length - 1] = { ...next[next.length - 1], after: assessmentBefore };
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

      setAssessment(assessmentBefore);
      baselineRef.current = { ...assessmentBefore, bestLine: chosen.chosen.info.pv.slice(1) };

      // 6. Tactics Aura - only on measured triggers.
      engineMovesRef.current++;
      const auraIn = auraInputFrom(chosen, engineMovesRef.current, lastEngineWinRef.current);
      const aura = evaluateAura(auraIn, auraStateRef.current);
      auraStateRef.current = aura.state;
      lastEngineWinRef.current = auraIn.winAfterEngine;
      if (aura.message) setAuraMessage({ ...aura.message, id: Date.now() });

      setDecision(chosen);
      setThreats(chosen.chosen.report);
      setLastMove({ from: move.from, to: move.to });
      setFen(fenAfter);

      // 7. Rules after the move. If it steered into a draw on purpose, it claims it.
      const after = evaluateRules(chess, startFenRef.current, setup.drawClaims);
      if (after.terminal) finish(after.terminal);
      else if (after.claimable.length > 0 && chosen.reason === "seek-draw") {
        finish(claimedDraw(after.claimable[0], "engine"));
      } else setPhase("user-turn");
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setEngineStatus({
        state: "error",
        error: err instanceof Error ? err.message : "Engine search failed.",
      });
    }
  }, [
    engineColor,
    finish,
    limitsFor,
    probeThreat,
    pushInfo,
    setDrawOffer,
    setup.drawClaims,
    setup.engineMayResign,
    setup.strategic,
    setup.userColor,
  ]);

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
    if (phase === "claim-pending") return;
    const chess = chessRef.current;
    if (chess.turn() === engineColor) {
      setPhase("engine-thinking");
      void runEngineMove();
    } else {
      setPhase("user-turn");
      if (!baselineRef.current) void runSeedAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineStatus.state, fen, gameOver, engineColor, phase === "claim-pending"]);

  // ---- user actions -----------------------------------------------------------------
  const applyUserMove = useCallback(
    (from: Square, to: Square, promotion?: string): boolean => {
      const chess = chessRef.current;
      if (chess.turn() !== setup.userColor || gameOver) return false;

      const resolved = resolveBoardMove(chess, from, to, promotion);
      if (!resolved) {
        if (import.meta.env.DEV && chess.get(from)?.type === "k") {
          console.debug("[moves] king move rejected", { from, to, legal: chess.moves({ square: from, verbose: true }) });
        }
        return false;
      }

      const fenBefore = chess.fen();
      const claimableBefore = evaluateRules(chess, startFenRef.current, setup.drawClaims).claimable;
      const move = chess.move(resolved);
      clockRef.current.moveMade(setup.userColor);

      const before = baselineRef.current ?? assessment ?? undefined;
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
      setPendingPromotion(null);
      // A declined offer is history once the user moves again.
      if (offerRef.current?.status === "declined") setDrawOffer(null);

      const rulesAfter = evaluateRules(chess, startFenRef.current, setup.drawClaims);
      setFen(chess.fen());
      if (rulesAfter.terminal) {
        finish(rulesAfter.terminal);
      } else if (rulesAfter.claimable.some((k) => !claimableBefore.includes(k))) {
        // The user's move just made a draw claimable: let them decide before the engine moves.
        setPhase("claim-pending");
      }
      return true;
    },
    [assessment, finish, gameOver, setDrawOffer, setup.drawClaims, setup.userColor],
  );

  /** Plays typed notation. Returns an error message, or null on success. */
  const playSan = useCallback(
    (input: string): string | null => {
      const chess = chessRef.current;
      if (gameOver) return "The game is over.";
      if (chess.turn() !== setup.userColor || phase !== "user-turn") return "It is not your turn.";
      if (!input.trim()) return "Type a move, e.g. Nf3.";

      const r = resolveTypedMove(chess, input);
      if (r.kind === "illegal") return `"${input.trim()}" is not a legal move here.`;
      if (r.kind === "needs-promotion") {
        setPendingPromotion({ from: r.from, to: r.to });
        return null;
      }
      return applyUserMove(r.move.from, r.move.to, r.move.promotion) ? null : "Could not play that move.";
    },
    [applyUserMove, gameOver, phase, setup.userColor],
  );

  const resign = useCallback(() => {
    finish({
      reason: "resignation",
      winner: engineColor,
      detail: `You resigned. ${engineColor === "w" ? "White" : "Black"} wins.`,
    });
  }, [engineColor, finish]);

  const canClaim = !gameOver && (phase === "user-turn" || phase === "claim-pending") && rules.claimable.length > 0;

  const claimDraw = useCallback(() => {
    if (!canClaim) return;
    finish(claimedDraw(rules.claimable[0], "you"));
  }, [canClaim, finish, rules.claimable]);

  /** Declines to claim the draw the user's own move made available; the engine moves. */
  const playOn = useCallback(() => {
    if (phase === "claim-pending") setPhase("engine-thinking");
  }, [phase]);

  // One offer per user move; an open offer stays open until answered or the engine moves.
  const lastOfferPly = drawOffer?.ply ?? -1;
  const canOfferDraw =
    !gameOver &&
    (phase === "user-turn" || phase === "engine-thinking") &&
    drawOffer?.status !== "open" &&
    records.length > lastOfferPly;

  const offerDraw = useCallback(() => {
    if (!canOfferDraw) return;
    setDrawOffer({ status: "open", ply: records.length });
  }, [canOfferDraw, records.length, setDrawOffer]);

  const summary: GameSummary | null = useMemo(
    () => (gameOver ? summariseGame(records, setup.userColor) : null),
    [gameOver, records, setup.userColor],
  );

  const capturedByUser = useMemo(
    () => records.filter((r) => !r.byEngine && r.capturedPiece).map((r) => r.capturedPiece!),
    [records],
  );
  const capturedByEngine = useMemo(
    () => records.filter((r) => r.byEngine && r.capturedPiece).map((r) => r.capturedPiece!),
    [records],
  );

  const turn: Color = useMemo(() => new Chess(fen).turn(), [fen]);

  const legalTargets = useCallback((square: Square): Square[] => boardTargets(chessRef.current, square), []);

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
    rules,
    canClaim,
    claimDraw,
    playOn,
    drawOffer,
    canOfferDraw,
    offerDraw,
    clock,
    auraMessage: auraEnabled ? auraMessage : null,
    auraEnabled,
    setAuraEnabled,
    setPendingPromotion,
    applyUserMove,
    playSan,
    resign,
    legalTargets,
  };
}

/** Reads the remembered aura preference, defaulting to on. */
export function storedAuraPreference(): boolean {
  try {
    return localStorage.getItem(AURA_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

