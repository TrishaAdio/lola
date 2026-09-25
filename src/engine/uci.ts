import { ENGINE_TIERS, engineWorkerUrl } from "./tiers";
import type { EngineConfig, EngineInfo, SearchLimits, SearchResult } from "./types";

export function parseInfoLine(line: string): EngineInfo | null {
  if (!line.startsWith("info ")) return null;
  // `info string ...` and `info currmove ...` carry no principal variation.
  if (line.startsWith("info string")) return null;

  const tokens = line.split(/\s+/);
  const info: EngineInfo = { depth: 0, multipv: 1, pv: [] };
  let sawScore = false;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case "depth":
        info.depth = Number(tokens[++i]);
        break;
      case "seldepth":
        info.seldepth = Number(tokens[++i]);
        break;
      case "multipv":
        info.multipv = Number(tokens[++i]);
        break;
      case "nodes":
        info.nodes = Number(tokens[++i]);
        break;
      case "nps":
        info.nps = Number(tokens[++i]);
        break;
      case "time":
        info.timeMs = Number(tokens[++i]);
        break;
      case "hashfull":
        info.hashfull = Number(tokens[++i]);
        break;
      case "score": {
        const kind = tokens[++i];
        const value = Number(tokens[++i]);
        if (kind === "cp") info.cp = value;
        else if (kind === "mate") info.mate = value;
        sawScore = true;
        break;
      }
      case "lowerbound":
        info.bound = "lower";
        break;
      case "upperbound":
        info.bound = "upper";
        break;
      case "wdl": {
        const w = Number(tokens[++i]);
        const d = Number(tokens[++i]);
        const l = Number(tokens[++i]);
        if ([w, d, l].every(Number.isFinite)) info.wdl = [w, d, l];
        break;
      }
      case "pv":
        info.pv = tokens.slice(i + 1).filter(Boolean);
        i = tokens.length;
        break;
      default:
        break;
    }
  }

  if (!sawScore || info.pv.length === 0) return null;
  return info;
}

type Listener = (line: string) => void;

export interface DownloadProgress {
  /** 0..1 */
  percent: number;
  loaded: number;
  total: number;
  speedText: string;
  etaText: string;
}

/**
 * Typed wrapper around a Stockfish WASM build running in a Web Worker, speaking UCI.
 *
 * Searches are serialised: a new search waits for the previous `bestmove` so the engine
 * and this client can never disagree about which search is in flight.
 */
export class UciEngine {
  private worker: Worker | null = null;
  private listeners = new Set<Listener>();
  private searchChain: Promise<unknown> = Promise.resolve();
  private searching = false;
  private disposed = false;

  /** Raw engine output, newest last. Useful for debugging and the commentary panel. */
  readonly log: string[] = [];

  get isReady(): boolean {
    return this.worker !== null && !this.disposed;
  }

  get isSearching(): boolean {
    return this.searching;
  }

  private post(cmd: string) {
    if (!this.worker) throw new Error("Engine is not running");
    this.worker.postMessage(cmd);
  }

  private onLine = (line: string) => {
    this.log.push(line);
    if (this.log.length > 4000) this.log.splice(0, 2000);
    for (const l of [...this.listeners]) l(line);
  };

  addListener(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Resolves once a line satisfying `match` arrives. */
  private waitFor(match: (line: string) => boolean, timeoutMs = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("Engine timed out"));
      }, timeoutMs);
      const off = this.addListener((line) => {
        if (!match(line)) return;
        clearTimeout(timer);
        off();
        resolve(line);
      });
    });
  }

  async start(tier: EngineConfig["tier"], onProgress?: (p: DownloadProgress) => void) {
    this.dispose();
    this.disposed = false;

    const worker = new Worker(engineWorkerUrl(ENGINE_TIERS[tier]));
    this.worker = worker;

    worker.onmessage = (e: MessageEvent) => {
      if (typeof e.data === "string") this.onLine(e.data);
    };
    worker.onerror = (e) => this.onLine(`info string worker error ${e.message ?? ""}`);

    // Best-effort download progress: the worker streams wasm-fetch stats over a
    // MessagePort. The fetch starts as soon as the worker boots, so we hand over the
    // port immediately and simply report whatever we catch.
    if (onProgress) {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e: MessageEvent) => {
        const d = e.data;
        if (d && typeof d === "object" && typeof d.percent === "number") {
          onProgress({
            percent: d.percent,
            loaded: Number(d.loaded) || 0,
            total: Number(d.total) || 0,
            speedText: typeof d.speedText === "string" ? d.speedText : "",
            etaText: typeof d.etaText === "string" ? d.etaText : "",
          });
        }
      };
      worker.postMessage("setoption name CanOutputEngineDownloadProgress");
      worker.postMessage({ progressPort: channel.port2 }, [channel.port2]);
    }

    const uciok = this.waitFor((l) => l.trim() === "uciok", 600_000);
    this.post("uci");
    await uciok;
  }

  async setOption(name: string, value: string | number | boolean) {
    this.post(`setoption name ${name} value ${String(value)}`);
  }

  async isready() {
    const p = this.waitFor((l) => l.trim() === "readyok");
    this.post("isready");
    await p;
  }

  async configure(cfg: EngineConfig) {
    // Threads/Hash are rejected by single-threaded builds; guard so we don't spam errors.
    if (ENGINE_TIERS[cfg.tier].threaded) {
      await this.setOption("Threads", Math.max(1, cfg.threads));
    }
    await this.setOption("Hash", Math.max(16, cfg.hashMb));
    await this.setOption("MultiPV", Math.max(1, cfg.multiPv));
    await this.setOption("UCI_ShowWDL", true);

    // Full strength must explicitly disable both weakening mechanisms.
    await this.setOption("UCI_LimitStrength", cfg.limitStrength);
    if (cfg.limitStrength) await this.setOption("UCI_Elo", cfg.uciElo);
    await this.setOption("Skill Level", cfg.skillLevel);

    await this.isready();
  }

  async newGame() {
    this.post("ucinewgame");
    await this.isready();
  }

  /**
   * Runs a search on `fen` and resolves with the final candidate lines.
   * `onInfo` fires for every parsed info line, for live UI updates.
   */
  search(
    fen: string,
    limits: SearchLimits,
    onInfo?: (info: EngineInfo) => void,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const run = async (): Promise<SearchResult> => {
      if (!this.isReady) throw new Error("Engine is not running");
      if (signal?.aborted) throw new DOMException("Search aborted", "AbortError");

      // Keep the newest info for each MultiPV rank at each depth.
      const byDepth = new Map<number, Map<number, EngineInfo>>();
      const latest = new Map<number, EngineInfo>();

      this.searching = true;

      const onAbort = () => this.post("stop");
      signal?.addEventListener("abort", onAbort, { once: true });

      const collector = this.addListener((line) => {
        const info = parseInfoLine(line);
        if (!info) return;
        // Bound scores are provisional; they make the eval bar jump misleadingly.
        if (info.bound) return;
        latest.set(info.multipv, info);
        let depthMap = byDepth.get(info.depth);
        if (!depthMap) {
          depthMap = new Map();
          byDepth.set(info.depth, depthMap);
        }
        depthMap.set(info.multipv, info);
        onInfo?.(info);
      });

      try {
        const done = this.waitFor((l) => l.startsWith("bestmove"));
        this.post(`position fen ${fen}`);
        const parts = ["go"];
        if (limits.depth) parts.push(`depth ${limits.depth}`);
        if (limits.movetimeMs) parts.push(`movetime ${limits.movetimeMs}`);
        if (limits.nodes) parts.push(`nodes ${limits.nodes}`);
        if (parts.length === 1) parts.push("depth 18");
        this.post(parts.join(" "));

        const bestLine = await done;
        const m = bestLine.match(/^bestmove\s+(\S+)(?:\s+ponder\s+(\S+))?/);
        const bestmove = m?.[1] ?? "(none)";
        const ponder = m?.[2];

        // Report the deepest fully-searched iteration; fall back per rank if the last
        // iteration was cut short by `stop`.
        let chosenDepth = -1;
        for (const [depth, map] of byDepth) {
          if (map.has(1) && depth > chosenDepth) chosenDepth = depth;
        }
        const finalMap = new Map(latest);
        if (chosenDepth >= 0) {
          for (const [pvIndex, info] of byDepth.get(chosenDepth)!) finalMap.set(pvIndex, info);
        }

        const lines = [...finalMap.values()].sort((a, b) => a.multipv - b.multipv);

        if (signal?.aborted) throw new DOMException("Search aborted", "AbortError");
        return { bestmove, ponder, lines };
      } finally {
        collector();
        signal?.removeEventListener("abort", onAbort);
        this.searching = false;
      }
    };

    // Serialise: never start a search before the previous one has returned `bestmove`.
    const next = this.searchChain.then(run, run);
    this.searchChain = next.catch(() => undefined);
    return next;
  }

  stop() {
    if (this.worker && this.searching) this.post("stop");
  }

  dispose() {
    this.disposed = true;
    this.searching = false;
    if (this.worker) {
      try {
        this.worker.postMessage("quit");
      } catch {
        /* worker may already be dead */
      }
      this.worker.terminate();
      this.worker = null;
    }
    this.listeners.clear();
  }
}
