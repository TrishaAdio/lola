/**
 * Castling regression tests.
 *
 * These drive the exact functions the UI calls for drag, click and typed moves, so a
 * green run means castling works through the real input paths, not just in chess.js.
 */
import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import type { Square } from "chess.js";
import {
  boardTargets,
  normalizeTypedMove,
  resolveBoardMove,
  resolveTypedMove,
  sanitizeCastlingRights,
} from "./moves";
import { validateFen } from "./positions";

/** Plays a move through the board-gesture path and returns its SAN. */
function gesture(chess: Chess, from: Square, to: Square): string {
  const resolved = resolveBoardMove(chess, from, to);
  if (!resolved) throw new Error(`${from}-${to} was rejected in ${chess.fen()}`);
  return chess.move(resolved).san;
}

function play(sans: string[]): Chess {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess;
}

describe("castling from a fresh game, both colours", () => {
  it("1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O  - White castles kingside by dragging the king", () => {
    const chess = play(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
    expect(chess.moves({ square: "e1", verbose: true }).map((m) => m.san)).toContain("O-O");
    expect(gesture(chess, "e1", "g1")).toBe("O-O");
    expect(chess.get("g1")).toEqual({ type: "k", color: "w" });
    expect(chess.get("f1")).toEqual({ type: "r", color: "w" });
  });

  it("...4...Nf6 5.d3 O-O - Black castles kingside once g8 is clear", () => {
    const chess = play(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3"]);
    expect(gesture(chess, "e8", "g8")).toBe("O-O");
    expect(chess.get("g8")).toEqual({ type: "k", color: "b" });
    expect(chess.get("f8")).toEqual({ type: "r", color: "b" });
  });

  it("queenside for both colours: 1.d4 d5 2.Nc3 Nc6 3.Bf4 Bf5 4.Qd2 Qd7 5.O-O-O O-O-O", () => {
    const chess = play(["d4", "d5", "Nc3", "Nc6", "Bf4", "Bf5", "Qd2", "Qd7"]);
    expect(gesture(chess, "e1", "c1")).toBe("O-O-O");
    expect(gesture(chess, "e8", "c8")).toBe("O-O-O");
    expect(chess.get("c1")?.type).toBe("k");
    expect(chess.get("d1")?.type).toBe("r");
    expect(chess.get("c8")?.type).toBe("k");
    expect(chess.get("d8")?.type).toBe("r");
  });

  it("accepts Chess.com's gesture of dropping the king on its own rook", () => {
    const k = play(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
    expect(gesture(k, "e1", "h1")).toBe("O-O");

    const q = play(["d4", "d5", "Nc3", "Nc6", "Bf4", "Bf5", "Qd2", "Qd7"]);
    expect(gesture(q, "e1", "a1")).toBe("O-O-O");
    expect(gesture(q, "e8", "a8")).toBe("O-O-O");
  });

  it("offers the rook squares as castling targets for click-to-move", () => {
    const chess = play(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
    expect(boardTargets(chess, "e1")).toEqual(expect.arrayContaining(["g1", "h1"]));
  });

  it("does not treat the king-onto-rook gesture as castling when castling is illegal", () => {
    // f1 bishop still blocks the kingside.
    const chess = play(["e4", "e5", "Nf3", "Nc6"]);
    expect(resolveBoardMove(chess, "e1", "h1")).toBeNull();
    expect(boardTargets(chess, "e1")).not.toContain("h1");
  });
});

describe("typed castling notation", () => {
  it.each([
    ["O-O", "O-O"],
    ["0-0", "O-O"],
    ["o-o", "O-O"],
    ["OO", "O-O"],
    ["O-O+", "O-O"],
    ["0-0-0", "O-O-O"],
    ["o-o-o", "O-O-O"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalizeTypedMove(input)).toBe(expected);
  });

  it("plays typed castling for both colours through the text-input path", () => {
    const chess = play(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
    for (const text of ["o-o", "Nf6", "d3", "0-0"]) {
      const result = resolveTypedMove(chess, text);
      expect(result.kind, `typed "${text}"`).toBe("move");
      if (result.kind === "move") chess.move(result.move);
    }
    expect(chess.history()).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "O-O"]);
  });
});

describe("castling rights survive every position load", () => {
  const BOTH_WAYS = "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 0 1";

  it("keeps KQkq through custom-FEN validation", () => {
    const v = validateFen(BOTH_WAYS);
    expect(v.ok).toBe(true);
    expect(v.fen!.split(" ")[2]).toBe("KQkq");
  });

  it("castles all four ways from a custom FEN start", () => {
    const white = new Chess(validateFen(BOTH_WAYS).fen!);
    expect(gesture(white, "e1", "g1")).toBe("O-O");
    expect(gesture(white, "e8", "c8")).toBe("O-O-O");

    const white2 = new Chess(validateFen(BOTH_WAYS).fen!);
    expect(gesture(white2, "e1", "c1")).toBe("O-O-O");
    expect(gesture(white2, "e8", "g8")).toBe("O-O");
  });

  it("strips rights the board cannot support, so no phantom castling is offered", () => {
    // Claims KQ but White has no rooks: chess.js alone would still offer O-O and O-O-O.
    // (Pawns keep it from being an insufficient-material draw.)
    const bogus = "4k3/4p3/8/8/8/8/4P3/4K3 w KQ - 0 1";
    expect(new Chess(bogus).moves({ square: "e1" })).toContain("O-O");

    const cleaned = sanitizeCastlingRights(bogus);
    expect(cleaned.removed).toEqual(["K", "Q"]);
    expect(cleaned.fen.split(" ")[2]).toBe("-");

    const v = validateFen(bogus);
    expect(v.ok).toBe(true);
    expect(new Chess(v.fen!).moves({ square: "e1" })).not.toContain("O-O");
    expect(v.removedCastling).toEqual(["K", "Q"]);
  });

  it("leaves valid rights untouched and only removes the broken one", () => {
    // h8 rook missing: only `k` is impossible.
    const partial = "r3k3/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    expect(sanitizeCastlingRights(partial)).toEqual({
      fen: "r3k3/8/8/8/8/8/8/R3K2R w KQq - 0 1",
      removed: ["k"],
    });
  });
});
