/**
 * Dev-console trace of every engine decision, so it is verifiable that the strategic layer
 * really re-ranks Stockfish's lines instead of passing its #1 straight through.
 *
 * In the browser console:
 *   __strategy.summary()      divergence count and rate
 *   __strategy.log            every decision, with each candidate's breakdown
 */
import { describeDecision } from "./policy";
import type { PolicyDecision } from "./policy";

export interface StrategyLogEntry {
  ply: number;
  stockfishBest: string;
  played: string;
  diverged: boolean;
  reason: PolicyDecision["reason"];
  costCp: number;
  plan: string | null;
  threat: string | null;
  candidates: {
    move: string;
    rank: number;
    evalCp: number | string;
    costCp: number;
    kingSafety?: number;
    activity?: number;
    structure?: number;
    plan?: number;
    prophylaxis?: number;
    initiative?: number;
    strategic?: number;
    final?: number;
    excluded?: string;
  }[];
}

interface StrategyDebug {
  log: StrategyLogEntry[];
  summary: () => { decisions: number; diverged: number; rate: string };
}

declare global {
  interface Window {
    __strategy?: StrategyDebug;
  }
}

const round = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);

function store(): StrategyDebug {
  if (!window.__strategy) {
    const log: StrategyLogEntry[] = [];
    window.__strategy = {
      log,
      summary: () => {
        const diverged = log.filter((e) => e.diverged).length;
        return {
          decisions: log.length,
          diverged,
          rate: log.length ? `${((diverged / log.length) * 100).toFixed(0)}%` : "0%",
        };
      },
    };
  }
  return window.__strategy;
}

export function resetStrategyLog() {
  if (typeof window !== "undefined" && window.__strategy) window.__strategy.log.length = 0;
}

export function logDecision(decision: PolicyDecision, ply: number) {
  if (typeof window === "undefined") return;

  const entry: StrategyLogEntry = {
    ply,
    stockfishBest: decision.stockfishBest.san,
    played: decision.san,
    diverged: decision.diverged,
    reason: decision.reason,
    costCp: decision.chosen.costCp,
    plan: decision.plan ? `${decision.plan.label} (${decision.plan.because})` : null,
    threat: decision.threat ? `${decision.threat.san} (+${decision.threat.gainCp}cp)` : null,
    candidates: decision.candidates.map((c) => ({
      move: c.san,
      rank: c.rank,
      evalCp: c.info.mate !== undefined ? `M${c.info.mate}` : (c.info.cp ?? 0),
      costCp: c.costCp,
      kingSafety: round(c.strategic?.kingSafety),
      activity: round(c.strategic?.activity),
      structure: round(c.strategic?.structure),
      plan: round(c.strategic?.plan),
      prophylaxis: round(c.strategic?.prophylaxis),
      initiative: round(c.strategic?.initiative),
      strategic: round(c.strategic?.total),
      final: round(c.final),
      excluded: c.excluded,
    })),
  };
  store().log.push(entry);

  const title = `[strategy] ply ${ply}: ${describeDecision(decision)}`;
  console.groupCollapsed(decision.diverged ? `%c${title}` : title, decision.diverged ? "color:#d64545" : "");
  if (entry.plan) console.log("plan:", entry.plan);
  if (entry.threat) console.log("opponent's idea (null-move search):", entry.threat);
  console.table(entry.candidates);
  console.groupEnd();
}
