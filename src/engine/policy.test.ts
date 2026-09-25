import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { selectRuthlessMove, TIE_BREAK_WINDOW_CP } from "./policy";
import type { EngineInfo, SearchResult } from "./types";

function info(partial: Partial<EngineInfo> & { multipv: number; pv: string[] }): EngineInfo {
  return { depth: 20, ...partial };
}

function result(lines: EngineInfo[]): SearchResult {
  return { bestmove: lines[0].pv[0], lines };
}

/** Sanity guard: every UCI move used in a test must actually be legal. */
function assertLegal(fen: string, ucis: string[], history: string[] = []) {
  const chess = new Chess(fen);
  if (history.length) {
    const replay = new Chess();
    for (const san of history) replay.move(san);
    expect(replay.fen()).toBe(chess.fen());
  }
  for (const uci of ucis) {
    const probe = new Chess(chess.fen());
    expect(() =>
      probe.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) }),
      `${uci} should be legal in ${fen}`,
    ).not.toThrow();
  }
}

describe("fastest mate", () => {
  // White: Kh1, Ra1. Black: Kg8 with pawns f7 g7 h7. Ra8 is mate in 1.
  const fen = "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1";

  it("plays the shortest mate even when the engine ranked a slower one first", () => {
    assertLegal(fen, ["a1a7", "a1a8", "a1a6"]);

    const decision = selectRuthlessMove(
      fen,
      result([
        info({ multipv: 1, mate: 3, pv: ["a1a7"] }),
        info({ multipv: 2, mate: 1, pv: ["a1a8"] }),
        info({ multipv: 3, mate: 5, pv: ["a1a6"] }),
      ]),
    );

    expect(decision).not.toBeNull();
    expect(decision!.uci).toBe("a1a8");
    expect(decision!.san).toBe("Ra8#");
    expect(decision!.reason).toBe("fastest-mate");
  });

  it("prefers the longest resistance when it is the one being mated", () => {
    const decision = selectRuthlessMove(
      fen,
      result([
        info({ multipv: 1, mate: -1, pv: ["h1g1"] }),
        info({ multipv: 2, mate: -4, pv: ["a1a8"] }),
      ]),
    );

    // mate -4 survives longer than mate -1, so it must be preferred.
    expect(decision!.uci).toBe("a1a8");
  });
});

describe("draw avoidance", () => {
  // Knight shuffle that makes the initial position occur for the third time.
  const history = ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1"];
  const fen = (() => {
    const chess = new Chess();
    for (const san of history) chess.move(san);
    return chess.fen();
  })();

  it("the repetition move really is a threefold repetition", () => {
    const chess = new Chess();
    for (const san of history) chess.move(san);
    chess.move({ from: "f6", to: "g8" });
    expect(chess.isThreefoldRepetition()).toBe(true);
  });

  it("refuses a repetition when the evaluation is level", () => {
    assertLegal(fen, ["f6g8", "e7e6"], history);

    const decision = selectRuthlessMove(
      fen,
      result([
        info({ multipv: 1, cp: 0, pv: ["f6g8"] }),
        info({ multipv: 2, cp: 0, pv: ["e7e6"] }),
      ]),
      { history },
    );

    expect(decision!.uci).toBe("e7e6");
    expect(decision!.reason).toBe("avoid-draw");
    expect(decision!.overrode?.uci).toBe("f6g8");
  });

  it("takes the repetition when it is losing badly, because a draw is a good result", () => {
    const decision = selectRuthlessMove(
      fen,
      result([
        info({ multipv: 1, cp: -400, pv: ["f6g8"] }),
        info({ multipv: 2, cp: -400, pv: ["e7e6"] }),
      ]),
      { history },
    );

    expect(decision!.uci).toBe("f6g8");
    expect(decision!.reason).toBe("best-eval");
  });
});

describe("pressure tie-break", () => {
  // White: Ke1, Rg1, Pe2. Black: Ke8. Rg8+ is a check; e3 is quiet.
  const fen = "4k3/8/8/8/8/8/4P3/4K1R1 w - - 0 1";

  it("prefers the forcing move when the evaluation is equal", () => {
    assertLegal(fen, ["g1g8", "e2e3"]);

    const decision = selectRuthlessMove(
      fen,
      result([
        info({ multipv: 1, cp: 300, pv: ["e2e3"] }),
        info({ multipv: 2, cp: 300, pv: ["g1g8"] }),
      ]),
    );

    expect(decision!.uci).toBe("g1g8");
    expect(decision!.san).toBe("Rg8+");
    expect(decision!.reason).toBe("pressure-tiebreak");
  });

  it("never trades real evaluation for aggression", () => {
    const decision = selectRuthlessMove(
      fen,
      result([
        info({ multipv: 1, cp: 300, pv: ["e2e3"] }),
        // The forcing move is clearly worse than the tie-break window allows.
        info({ multipv: 2, cp: 300 - (TIE_BREAK_WINDOW_CP + 40), pv: ["g1g8"] }),
      ]),
    );

    expect(decision!.uci).toBe("e2e3");
    expect(decision!.reason).toBe("best-eval");
  });

  it("leaves Stockfish's choice untouched when the ruthless layer is off", () => {
    const decision = selectRuthlessMove(
      fen,
      result([
        info({ multipv: 1, cp: 300, pv: ["e2e3"] }),
        info({ multipv: 2, cp: 300, pv: ["g1g8"] }),
      ]),
      { ruthless: false },
    );

    expect(decision!.uci).toBe("e2e3");
    expect(decision!.reason).toBe("best-eval");
  });
});

describe("degenerate input", () => {
  const fen = "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1";

  it("falls back to bestmove when no info lines were captured", () => {
    const decision = selectRuthlessMove(fen, { bestmove: "a1a8", lines: [] });
    expect(decision!.uci).toBe("a1a8");
  });

  it("returns null when there is no move at all", () => {
    expect(selectRuthlessMove(fen, { bestmove: "(none)", lines: [] })).toBeNull();
  });

  it("ignores illegal candidate moves", () => {
    const decision = selectRuthlessMove(
      fen,
      result([
        info({ multipv: 1, cp: 50, pv: ["a1a4a"] }),
        info({ multipv: 2, cp: 40, pv: ["a1a8"] }),
      ]),
    );
    expect(decision!.uci).toBe("a1a8");
  });
});
