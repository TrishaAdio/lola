/**
 * Legibility guards for every theme: pieces must read on both square colours, and dark
 * piece detail must read against its own body. These catch a pretty-but-unplayable palette.
 */
import { describe, expect, it } from "vitest";
import { THEMES, contrast } from "./themes";

describe.each(Object.values(THEMES))("$name theme", (t) => {
  it("light pieces stand out from dark squares", () => {
    expect(contrast(t.light.body, t.squareDark)).toBeGreaterThanOrEqual(3);
  });

  it("dark pieces stand out from light squares", () => {
    expect(contrast(t.dark.body, t.squareLight)).toBeGreaterThanOrEqual(4.5);
  });

  it("dark pieces still separate from dark squares", () => {
    expect(contrast(t.dark.body, t.squareDark)).toBeGreaterThanOrEqual(2);
  });

  it("light pieces keep a visible outline on light squares", () => {
    expect(contrast(t.light.ink, t.squareLight)).toBeGreaterThanOrEqual(4.5);
  });

  it("dark-piece detail lines read against the body", () => {
    expect(contrast(t.dark.detail, t.dark.body)).toBeGreaterThanOrEqual(4.5);
  });

  it("squares are distinguishable from each other", () => {
    expect(contrast(t.squareLight, t.squareDark)).toBeGreaterThanOrEqual(1.8);
  });

  it("is not the stock green/cream or brown/tan board", () => {
    const stock = [
      ["#eeeed2", "#769656"], // chess.com green
      ["#f0d9b5", "#b58863"], // lichess brown
    ];
    for (const [light, dark] of stock) {
      expect(contrast(t.squareLight, light) > 1.05 || contrast(t.squareDark, dark) > 1.05).toBe(true);
    }
  });
});
