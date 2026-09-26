import { describe, expect, it } from "vitest";
import { Chess, DEFAULT_POSITION } from "chess.js";
import {
  adjudicateTimeout,
  evaluateRules,
  hasTimeoutMatingMaterial,
  isInsufficientMaterial,
  repetitionCount,
} from "./rules";

const board = (fen: string) => new Chess(fen);

describe("insufficient material (Chess.com / USCF)", () => {
  it.each([
    ["K v K", "8/8/4k3/8/8/4K3/8/8 w - - 0 1"],
    ["K+B v K", "8/8/4k3/8/8/4K3/8/5B2 w - - 0 1"],
    ["K+N v K", "8/8/4k3/8/8/4K3/8/5N2 w - - 0 1"],
    // d5 and f1 are both light squares.
    ["K+B v K+B, same-coloured bishops", "8/8/4k3/3b4/8/4K3/8/5B2 w - - 0 1"],
    // The USCF case: FIDE plays on because a helpmate exists; Chess.com draws because the
    // mate cannot be forced. chess.js's own check gets this wrong.
    ["K+N+N v K (USCF: mate cannot be forced)", "8/8/4k3/8/8/4K3/8/4NN2 w - - 0 1"],
  ])("draws %s", (_label, fen) => {
    expect(isInsufficientMaterial(board(fen))).toBe(true);
    expect(evaluateRules(board(fen), fen, "claim").terminal?.reason).toBe("insufficient-material");
  });

  it("confirms chess.js alone would not draw K+N+N v K", () => {
    expect(board("8/8/4k3/8/8/4K3/8/4NN2 w - - 0 1").isInsufficientMaterial()).toBe(false);
  });

  it.each([
    // A helpmate exists in every one of these, so the game continues.
    // c5 is dark, f1 is light.
    ["K+B v K+B, opposite-coloured bishops", "8/8/4k3/2b5/8/4K3/8/5B2 w - - 0 1"],
    ["K+N v K+N", "8/8/4k3/3n4/8/4K3/8/5N2 w - - 0 1"],
    ["K+B v K+N", "8/8/4k3/3n4/8/4K3/8/5B2 w - - 0 1"],
    // Two knights are only a draw against a *bare* king.
    ["K+N+N v K+P", "8/4p3/4k3/8/8/4K3/8/4NN2 w - - 0 1"],
    ["K+N v K+N+N split across sides", "8/8/4k3/3n4/8/4K3/8/4NN2 w - - 0 1"],
    ["K+B+N v K (a forced mate exists)", "8/8/4k3/8/8/4K3/8/4NB2 w - - 0 1"],
    ["K+P v K", "8/8/4k3/8/8/4K3/4P3/8 w - - 0 1"],
  ])("plays on in %s", (_label, fen) => {
    expect(isInsufficientMaterial(board(fen))).toBe(false);
    expect(evaluateRules(board(fen), fen, "claim").terminal).toBeNull();
  });
});

describe("timeout vs insufficient mating material", () => {
  it("draws when the side with time left has only a king", () => {
    // Black flags; White has only a king.
    const r = adjudicateTimeout(board("8/8/4k3/8/3q4/4K3/8/8 w - - 0 1"), "b");
    expect(r.reason).toBe("timeout-vs-insufficient-material");
    expect(r.winner).toBeNull();
  });

  it("draws K+B v K+P - USCF, where FIDE would award the win via a helpmate", () => {
    // White flags with a pawn; Black has K+B, which cannot force mate.
    const pos = board("8/8/4k3/8/8/4K3/4P3/5b2 w - - 0 1");
    expect(hasTimeoutMatingMaterial(pos, "b")).toBe(false);
    expect(adjudicateTimeout(pos, "w").reason).toBe("timeout-vs-insufficient-material");
  });

  it("awards the win against K+N+N - Chess.com's documented exception", () => {
    // White flags against two knights: a loss, not a draw, because mate is possible.
    const r = adjudicateTimeout(board("8/8/4k3/8/8/4K3/8/1nn5 w - - 0 1"), "w");
    expect(r.reason).toBe("timeout");
    expect(r.winner).toBe("b");
  });

  it("awards the win when the opponent has a rook", () => {
    const r = adjudicateTimeout(board("8/8/4k3/8/8/4K3/8/r7 w - - 0 1"), "w");
    expect(r).toMatchObject({ reason: "timeout", winner: "b" });
  });

  it("awards the win with just a pawn, since it can promote", () => {
    expect(hasTimeoutMatingMaterial(board("8/4p3/4k3/8/8/4K3/8/8 w - - 0 1"), "b")).toBe(true);
  });
});

describe("threefold repetition is claimable, not automatic", () => {
  const shuffle = ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"];
  const played = () => {
    const c = new Chess();
    for (const m of shuffle) c.move(m);
    return c;
  };

  it("counts the start position three times", () => {
    expect(repetitionCount(played(), DEFAULT_POSITION)).toBe(3);
  });

  it("offers a claim instead of ending the game", () => {
    const c = played();
    // chess.js would end the game here on its own.
    expect(c.isGameOver()).toBe(true);
    const rules = evaluateRules(c, DEFAULT_POSITION, "claim");
    expect(rules.terminal).toBeNull();
    expect(rules.claimable).toContain("threefold-repetition");
  });

  it("ends automatically in Chess.com mode", () => {
    expect(evaluateRules(played(), DEFAULT_POSITION, "automatic").terminal?.reason).toBe(
      "threefold-repetition",
    );
  });

  it("ends automatically on the fifth occurrence (FIDE 9.6.1), so games cannot run forever", () => {
    const c = played();
    for (const m of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]) c.move(m);
    expect(repetitionCount(c, DEFAULT_POSITION)).toBe(5);
    expect(evaluateRules(c, DEFAULT_POSITION, "claim").terminal?.reason).toBe("fivefold-repetition");
  });

  it("does not count a position as repeated when the castling rights differ", () => {
    // The king steps out and back: same squares, but castling rights are gone.
    const start = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    const c = new Chess(start);
    for (const m of ["Kf1", "Kf8", "Ke1", "Ke8", "Kf1", "Kf8", "Ke1", "Ke8"]) c.move(m);
    // Start position (with rights) occurred once; the rights-less copy only twice.
    expect(repetitionCount(c, start)).toBe(2);
    expect(evaluateRules(c, start, "claim").claimable).not.toContain("threefold-repetition");
  });

  it("distinguishes positions by en passant possibility", () => {
    // Same placement after 1...f5 as later, but only the first allows exf6 e.p.
    const start = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
    const c = new Chess(start);
    c.move("f5"); // e.p. now possible
    const withEp = c.fen();
    for (const m of ["Nf3", "Nf6", "Ng1", "Ng8"]) c.move(m);
    // Same pieces and side to move, but e.p. is no longer available.
    expect(c.fen().split(" ")[0]).toBe(withEp.split(" ")[0]);
    expect(repetitionCount(c, start)).toBe(1);
  });
});

describe("50-move rule is claimable, 75-move is automatic", () => {
  it("offers a claim at 50 moves without capture or pawn move", () => {
    const fen = "8/8/4k3/8/8/4K3/8/R7 w - - 100 80";
    const rules = evaluateRules(board(fen), fen, "claim");
    expect(rules.terminal).toBeNull();
    expect(rules.claimable).toEqual(["fifty-move-rule"]);
  });

  it("does not offer it one half-move early", () => {
    const fen = "8/8/4k3/8/8/4K3/8/R7 w - - 99 80";
    expect(evaluateRules(board(fen), fen, "claim").claimable).toEqual([]);
  });

  it("ends automatically at 75 moves", () => {
    const fen = "8/8/4k3/8/8/4K3/8/R7 w - - 150 105";
    expect(evaluateRules(board(fen), fen, "claim").terminal?.reason).toBe("seventy-five-move-rule");
  });

  it("lets checkmate stand even on the 75th move", () => {
    // Black is mated; the clock also says 150. Mate takes precedence (FIDE 9.6.2).
    const fen = "R5k1/5ppp/8/8/8/8/8/6K1 b - - 150 105";
    expect(evaluateRules(board(fen), fen, "claim").terminal?.reason).toBe("checkmate");
  });
});
