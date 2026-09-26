import { describe, expect, it } from "vitest";
import { Chess, DEFAULT_POSITION } from "chess.js";
import {
  MAX_STRATEGIC_BONUS,
  PROPHYLAXIS_WINDOW_CP,
  STRATEGIC_WINDOW_CP,
  selectMove,
} from "./policy";
import type { PolicyContext } from "./policy";
import type { EngineInfo, SearchResult } from "./types";

function info(partial: Partial<EngineInfo> & { multipv: number; pv: string[] }): EngineInfo {
  return { depth: 20, ...partial };
}

function result(lines: EngineInfo[]): SearchResult {
  return { bestmove: lines[0].pv[0], lines };
}

function fenAfter(sans: string[]): string {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return c.fen();
}

/** Sanity guard: every UCI move used in a test must actually be legal. */
function assertLegal(fen: string, ucis: string[]) {
  for (const uci of ucis) {
    expect(
      () => new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4) }),
      `${uci} should be legal in ${fen}`,
    ).not.toThrow();
  }
}

/** Two candidates: Stockfish's #1, and an alternative `cost` centipawns worse. */
function pair(fen: string, first: string, second: string, cp: number, cost: number, ctx: PolicyContext = {}) {
  assertLegal(fen, [first, second]);
  return selectMove(
    fen,
    result([
      info({ multipv: 1, cp, pv: [first] }),
      info({ multipv: 2, cp: cp - cost, pv: [second] }),
    ]),
    ctx,
  )!;
}

// ------------------------------------------------------------------------------------
// Tactical ground truth: these must hold no matter what the strategic layer thinks.
// ------------------------------------------------------------------------------------

describe("tactical safety net", () => {
  const mateFen = "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1";

  it("plays the shortest mate even when Stockfish ranked a slower one first", () => {
    assertLegal(mateFen, ["a1a7", "a1a8", "a1a6"]);
    const d = selectMove(
      mateFen,
      result([
        info({ multipv: 1, mate: 3, pv: ["a1a7"] }),
        info({ multipv: 2, mate: 1, pv: ["a1a8"] }),
        info({ multipv: 3, mate: 5, pv: ["a1a6"] }),
      ]),
    )!;
    expect(d.san).toBe("Ra8#");
    expect(d.reason).toBe("fastest-mate");
  });

  it("prefers the longest resistance when it is the one being mated", () => {
    const d = selectMove(
      mateFen,
      result([
        info({ multipv: 1, mate: -1, pv: ["h1g1"] }),
        info({ multipv: 2, mate: -4, pv: ["a1a8"] }),
      ]),
    )!;
    expect(d.uci).toBe("a1a8");
  });

  it(`never plays a non-prophylactic move more than ${STRATEGIC_WINDOW_CP}cp worse`, () => {
    // Rg8+ is forcing and scores well strategically, but it is 31cp worse.
    const fen = "4k3/8/8/8/8/8/4P3/4K1R1 w - - 0 1";
    for (const cost of [STRATEGIC_WINDOW_CP + 1, 45, 80, 300]) {
      const d = pair(fen, "e2e3", "g1g8", 300, cost);
      expect(d.uci, `cost ${cost}`).toBe("e2e3");
      expect(d.diverged).toBe(false);
    }
  });

  it(`never plays anything more than ${PROPHYLAXIS_WINDOW_CP}cp worse, even to stop a threat`, () => {
    const fen = fenAfter(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "d6", "c3", "O-O"]);
    const d = pair(fen, "a2a4", "h2h3", 20, PROPHYLAXIS_WINDOW_CP + 1, {
      threat: { uci: "f6g4", san: "Ng4", gainCp: 400 },
    });
    expect(d.uci).toBe("a2a4");
  });

  it("vetoes a deviation that leaves a piece en prise", () => {
    // Ba6 drops the bishop to b7xa6. Even at equal eval it must not be chosen.
    const fen = fenAfter(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "d6"]);
    const d = pair(fen, "h2h3", "c4a6", 20, 0);
    expect(d.uci).toBe("h2h3");
    expect(d.candidates.find((c) => c.uci === "c4a6")?.excluded).toBe("drops-material");
  });

  it("caps the strategic bonus", () => {
    const fen = "4k3/8/8/8/8/8/4P3/4K1R1 w - - 0 1";
    const d = pair(fen, "e2e3", "g1g8", 300, 0);
    for (const c of d.candidates) {
      expect(Math.abs(c.strategic?.total ?? 0)).toBeLessThanOrEqual(MAX_STRATEGIC_BONUS);
    }
  });

  it("passes Stockfish's #1 straight through when the strategic layer is off", () => {
    const fen = fenAfter(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "d6"]);
    const d = pair(fen, "g2g4", "b1c3", 20, 0, { strategic: false });
    expect(d.uci).toBe("g2g4");
    expect(d.diverged).toBe(false);
  });
});

// ------------------------------------------------------------------------------------
// Strategic re-ranking among near-equal candidates.
// ------------------------------------------------------------------------------------

describe("strategic re-rank", () => {
  const italian = fenAfter(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "d6"]);

  it("king safety: declines g4, which tears open its own castled king, for Nc3", () => {
    const d = pair(italian, "g2g4", "b1c3", 20, 5);
    expect(d.stockfishBest.san).toBe("g4");
    expect(d.san).toBe("Nc3");
    expect(d.diverged).toBe(true);
    expect(d.reason).toBe("strategic");
    const g4 = d.candidates.find((c) => c.san === "g4")!;
    const nc3 = d.candidates.find((c) => c.san === "Nc3")!;
    expect(g4.strategic!.kingSafety).toBeLessThan(nc3.strategic!.kingSafety);
    expect(g4.strategic!.structure).toBeLessThan(nc3.strategic!.structure);
  });

  it("pawn structure: recaptures dxc6 rather than bxc6, which isolates the a-pawn", () => {
    const fen = fenAfter(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Bxc6"]);
    const d = pair(fen, "b7c6", "d7c6", -30, 2);
    const bxc6 = d.candidates.find((c) => c.san === "bxc6")!;
    const dxc6 = d.candidates.find((c) => c.san === "dxc6")!;
    expect(bxc6.strategic!.structure).toBeLessThan(dxc6.strategic!.structure);
    expect(d.san).toBe("dxc6");
  });

  it("plan continuity: with opposite-side castling it adopts a pawn storm and plays h4", () => {
    const fen = "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/4P3/2NPBN2/PPPQBPPP/2KR3R w - - 0 9";
    const d = pair(fen, "a2a3", "h2h4", 30, 3);
    expect(d.plan?.id).toBe("pawn-storm");
    expect(d.plan?.wing).toBe("kingside");
    expect(d.san).toBe("h4");
    expect(d.chosen.strategic!.plan).toBeGreaterThan(0);
  });

  it("plan continuity: keeps an adopted plan while its structure holds", () => {
    const fen = "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/4P3/2NPBN2/PPPQBPPP/2KR3R w - - 0 9";
    const first = pair(fen, "a2a3", "h2h4", 30, 3, { ply: 16 });
    const again = pair(fen, "a2a3", "h2h4", 30, 3, { plan: first.plan, ply: 18 });
    expect(again.plan).toBe(first.plan);
    expect(again.plan?.adoptedAtPly).toBe(16);
  });

  it("plan continuity: switches to trading down once clearly winning", () => {
    // White is a rook up; the storm gives way to simplification.
    const fen = "r1bq2k1/ppp2ppp/2np1n2/2b1p3/4P3/2NPBN2/PPPQBPPP/2KR3R w - - 0 9";
    const storm = { id: "pawn-storm", label: "Kingside pawn storm", wing: "kingside", adoptedAtPly: 10, because: "" } as const;
    const d = pair(fen, "a2a3", "h2h4", 500, 3, { plan: storm, ply: 20 });
    expect(d.plan?.id).toBe("simplify");
  });

  describe("prophylaxis", () => {
    // After 6.c3 O-O, Black would like ...Ng4. h3 makes that knight jump lose a piece.
    const fen = fenAfter(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "d6", "c3", "O-O"]);
    const threat = { uci: "f6g4", san: "Ng4", gainCp: 90 };

    it("plays h3 to stop ...Ng4, at a small eval cost", () => {
      const d = pair(fen, "a2a4", "h2h3", 20, 15, { threat });
      expect(d.stockfishBest.san).toBe("a4");
      expect(d.san).toBe("h3");
      expect(d.reason).toBe("prophylaxis");
      expect(d.chosen.prophylaxis?.how).toBe("refuted");
    });

    it("control: without the threat, the same numbers keep Stockfish's #1", () => {
      const d = pair(fen, "a2a4", "h2h3", 20, 15);
      expect(d.san).toBe("a4");
      expect(d.chosen.strategic!.prophylaxis).toBe(0);
    });

    it("does not credit a check as prophylaxis", () => {
      const d = pair(fen, "a2a4", "c4f7", 20, 0, { threat });
      const bxf7 = d.candidates.find((c) => c.uci === "c4f7")!;
      expect(bxf7.prophylaxis?.prevented ?? 0).toBe(0);
    });
  });
});

// ------------------------------------------------------------------------------------
// Draws.
// ------------------------------------------------------------------------------------

describe("draw avoidance", () => {
  const history = ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1"];
  const fen = fenAfter(history);
  const ctx = { history, startFen: DEFAULT_POSITION };

  it("refuses to repeat when level", () => {
    const d = pair(fen, "f6g8", "e7e6", 0, 0, ctx);
    expect(d.uci).toBe("e7e6");
    expect(d.reason).toBe("avoid-draw");
  });

  it("takes the repetition when losing, because a draw is then a good result", () => {
    const d = pair(fen, "e7e6", "f6g8", -400, 0, ctx);
    expect(d.uci).toBe("f6g8");
    expect(d.reason).toBe("seek-draw");
  });

  it("detects repetitions in games that started from a custom FEN", () => {
    const start = "r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1";
    const moves = ["Ra2", "Ra7", "Ra1", "Ra8", "Ra2", "Ra7", "Ra1"];
    const c = new Chess(start);
    for (const m of moves) c.move(m);
    const d = pair(c.fen(), "a7a8", "h8h7", 0, 0, { history: moves, startFen: start });
    expect(d.candidates.find((x) => x.uci === "a7a8")?.allowsDrawClaim).toBe(true);
    expect(d.uci).toBe("h8h7");
  });
});

describe("degenerate input", () => {
  const fen = "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1";

  it("falls back to bestmove when no info lines were captured", () => {
    expect(selectMove(fen, { bestmove: "a1a8", lines: [] })!.uci).toBe("a1a8");
  });

  it("returns null when there is no move at all", () => {
    expect(selectMove(fen, { bestmove: "(none)", lines: [] })).toBeNull();
  });

  it("ignores illegal candidate moves", () => {
    const d = selectMove(
      fen,
      // a1b3 is not a rook move; the candidate must be dropped, not crash the policy.
      result([info({ multipv: 1, cp: 50, pv: ["a1b3"] }), info({ multipv: 2, cp: 40, pv: ["a1a8"] })]),
    );
    expect(d!.uci).toBe("a1a8");
  });
});
