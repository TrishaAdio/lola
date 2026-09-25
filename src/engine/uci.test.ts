import { describe, expect, it } from "vitest";
import { parseInfoLine } from "./uci";

describe("parseInfoLine", () => {
  it("parses a standard centipawn info line", () => {
    const info = parseInfoLine(
      "info depth 20 seldepth 27 multipv 1 score cp 34 nodes 1234567 nps 890123 hashfull 120 tbhits 0 time 1400 pv e2e4 e7e5 g1f3",
    );
    expect(info).not.toBeNull();
    expect(info).toMatchObject({
      depth: 20,
      seldepth: 27,
      multipv: 1,
      cp: 34,
      nodes: 1234567,
      nps: 890123,
      hashfull: 120,
      timeMs: 1400,
      pv: ["e2e4", "e7e5", "g1f3"],
    });
    expect(info!.mate).toBeUndefined();
  });

  it("parses mate scores, including negative ones", () => {
    expect(parseInfoLine("info depth 5 multipv 1 score mate 3 pv a1a8")!.mate).toBe(3);
    expect(parseInfoLine("info depth 5 multipv 1 score mate -2 pv a1a8")!.mate).toBe(-2);
  });

  it("parses WDL triples", () => {
    const info = parseInfoLine("info depth 12 multipv 1 score cp 25 wdl 120 800 80 pv e2e4");
    expect(info!.wdl).toEqual([120, 800, 80]);
  });

  it("flags bound scores so provisional evals can be discarded", () => {
    expect(parseInfoLine("info depth 9 multipv 1 score cp 50 lowerbound pv e2e4")!.bound).toBe(
      "lower",
    );
    expect(parseInfoLine("info depth 9 multipv 1 score cp 50 upperbound pv e2e4")!.bound).toBe(
      "upper",
    );
  });

  it("tracks the MultiPV rank", () => {
    expect(parseInfoLine("info depth 18 multipv 3 score cp -12 pv d2d4")!.multipv).toBe(3);
  });

  it("rejects lines that carry no principal variation", () => {
    expect(parseInfoLine("info depth 1 currmove e2e4 currmovenumber 1")).toBeNull();
    expect(parseInfoLine("info string NNUE evaluation using nn-61e7af4bb97d.nnue")).toBeNull();
    expect(parseInfoLine("bestmove e2e4 ponder e7e5")).toBeNull();
    expect(parseInfoLine("readyok")).toBeNull();
  });

  it("rejects a pv line with no score", () => {
    expect(parseInfoLine("info depth 4 multipv 1 pv e2e4")).toBeNull();
  });

  it("captures the whole pv, not just the first move", () => {
    const pv = "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6";
    const info = parseInfoLine(`info depth 22 multipv 1 score cp 18 pv ${pv}`);
    expect(info!.pv).toEqual(pv.split(" "));
  });
});
