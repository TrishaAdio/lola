import { describe, expect, it } from "vitest";
import { GLOBAL_COOLDOWN, TRIGGERS, evaluateAura, initialAuraState } from "./aura";
import type { AuraInput, AuraState } from "./aura";

/** A quiet, balanced position: nothing should fire. */
const calm = (over: Partial<AuraInput> = {}): AuraInput => ({
  engineMove: 10,
  winBeforeHuman: 50,
  winAfterHuman: 50,
  winAfterEngine: 50,
  mateIn: null,
  humanReplies: 30,
  check: false,
  kingZoneAttacks: 0,
  target: null,
  winningLines: 0,
  passedPawnRank: 0,
  ...over,
});

const first = () => 0;

describe("aura triggers fire only on real conditions", () => {
  it("stays silent in a balanced position", () => {
    expect(evaluateAura(calm(), initialAuraState(), first).message).toBeNull();
  });

  it("mate-net requires a proven forced mate", () => {
    expect(evaluateAura(calm({ mateIn: 4, winAfterEngine: 100 }), initialAuraState(), first).message?.trigger).toBe(
      "mate-net",
    );
    // Crushing, but no mate on the board: no "no square saves you".
    const noMate = evaluateAura(calm({ winAfterEngine: 99, humanReplies: 20 }), initialAuraState(), first);
    expect(noMate.message?.trigger).not.toBe("mate-net");
    // Zero moves remaining means the move already mated: nothing left to threaten.
    expect(evaluateAura(calm({ mateIn: 0, winAfterEngine: 100 }), initialAuraState(), first).message?.trigger).not.toBe(
      "mate-net",
    );
    // A mate that is far away is not a net yet.
    expect(evaluateAura(calm({ mateIn: 14, winAfterEngine: 100 }), initialAuraState(), first).message?.trigger).not.toBe(
      "mate-net",
    );
  });

  it("blunder fires on a 20-point swing caused by the human's move, not on a slow drift", () => {
    expect(
      evaluateAura(calm({ winBeforeHuman: 50, winAfterHuman: 75, winAfterEngine: 75 }), initialAuraState(), first).message
        ?.trigger,
    ).toBe("blunder");
    expect(
      evaluateAura(calm({ winBeforeHuman: 50, winAfterHuman: 62, winAfterEngine: 62 }), initialAuraState(), first).message,
    ).toBeNull();
  });

  it("names the actual piece and square that are under attack", () => {
    const r = evaluateAura(
      calm({ winAfterEngine: 60, target: { piece: "knight", square: "f6", value: 3 } }),
      initialAuraState(),
      first,
    );
    expect(r.message?.trigger).toBe("material-target");
    expect(r.message?.text).toContain("knight on f6");
  });

  it("counts real winning lines rather than always saying three", () => {
    const r = evaluateAura(calm({ winningLines: 4, winAfterEngine: 90 }), initialAuraState(), first);
    expect(r.message?.text).toBe("I see four ways this ends badly for you.");
  });

  it("momentum announces each threshold once as the advantage grows", () => {
    let state = initialAuraState();
    const said: (string | null)[] = [];
    for (const [move, win] of [[10, 72], [14, 74], [18, 88], [22, 89], [26, 96]] as const) {
      const r = evaluateAura(calm({ engineMove: move, winAfterEngine: win, winBeforeHuman: win, winAfterHuman: win }), state, first);
      state = r.state;
      said.push(r.message?.trigger ?? null);
    }
    expect(said).toEqual(["momentum", null, "momentum", null, "momentum"]);
  });
});

describe("aura frequency", () => {
  it(`waits ${GLOBAL_COOLDOWN} engine moves between lines`, () => {
    const hot = (engineMove: number) =>
      calm({ engineMove, winAfterEngine: 70, target: { piece: "rook", square: "a8", value: 5 }, check: true, kingZoneAttacks: 5 });
    let state: AuraState = initialAuraState();
    const fired: number[] = [];
    for (let m = 1; m <= 12; m++) {
      const r = evaluateAura(hot(m), state, first);
      state = r.state;
      if (r.message) fired.push(m);
    }
    for (let i = 1; i < fired.length; i++) expect(fired[i] - fired[i - 1]).toBeGreaterThanOrEqual(GLOBAL_COOLDOWN);
    expect(fired.length).toBeGreaterThan(1);
    expect(fired.length).toBeLessThanOrEqual(Math.ceil(12 / GLOBAL_COOLDOWN));
  });

  it("lets a proven mate speak through the global cooldown", () => {
    const afterLine = evaluateAura(calm({ engineMove: 5, winBeforeHuman: 40, winAfterHuman: 70, winAfterEngine: 70 }), initialAuraState(), first);
    expect(afterLine.message?.trigger).toBe("blunder");
    const mate = evaluateAura(calm({ engineMove: 6, mateIn: 3, winAfterEngine: 100 }), afterLine.state, first);
    expect(mate.message?.trigger).toBe("mate-net");
  });

  it("does not repeat the same line twice in a row from one pool", () => {
    let state = initialAuraState();
    let last = "";
    for (let m = 0; m < 40; m += 4) {
      const r = evaluateAura(calm({ engineMove: m, mateIn: 2, winAfterEngine: 100 }), state, () => 0.99);
      state = r.state;
      expect(r.message!.text).not.toBe(last);
      last = r.message!.text;
    }
  });
});

describe("tone", () => {
  it("contains no insults or hostile language", () => {
    const banned = /\b(idiot|stupid|moron|dumb|loser|pathetic|trash|garbage|noob|shut up|hate)\b/i;
    const sample = calm({ winningLines: 3, target: { piece: "queen", square: "d1", value: 9 } });
    for (const t of TRIGGERS) for (const line of t.lines(sample)) expect(line).not.toMatch(banned);
  });

  it("keeps every line to a single short sentence", () => {
    const sample = calm({ winningLines: 3, target: { piece: "queen", square: "d1", value: 9 } });
    for (const t of TRIGGERS) {
      for (const line of t.lines(sample)) {
        expect(line.length).toBeLessThanOrEqual(64);
        expect(line).not.toContain("\n");
      }
    }
  });
});
