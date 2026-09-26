/// <reference types="node" />
/**
 * Mix-pass guards on the committed sound files. If someone re-renders or swaps a sound,
 * these fail when levels drift apart or a file clips.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeWav, momentaryMaxLufs, samplePeakDb } from "../../scripts/lib/loudness.mjs";
import { soundForMove } from "./useGameSounds";
import type { MoveVisual } from "../hooks/useGame";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "sounds");
const manifest = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8")) as {
  sampleRate: number;
  targetLufs: number;
  sounds: Record<string, { file: string }>;
};

const NAMES = ["move", "capture", "castle", "check", "mate", "end", "aura", "illegal"];
const decoded = Object.fromEntries(
  NAMES.map((n) => [n, decodeWav(readFileSync(path.join(DIR, `${n}.wav`)))]),
);

describe("sound set", () => {
  it("ships every sound the game uses", () => {
    expect(Object.keys(manifest.sounds).sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)("%s is 48 kHz 16-bit mono", (n) => {
    expect(decoded[n].sampleRate).toBe(48000);
  });

  it.each(NAMES)("%s sits on the common loudness target (+-0.25 LU)", (n) => {
    const lufs = momentaryMaxLufs(decoded[n].samples);
    expect(Math.abs(lufs - manifest.targetLufs)).toBeLessThanOrEqual(0.25);
  });

  it("no sound is louder than any other by more than 0.5 LU", () => {
    const levels = NAMES.map((n) => momentaryMaxLufs(decoded[n].samples));
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(0.5);
  });

  it.each(NAMES)("%s never clips (peak <= -1.4 dBFS)", (n) => {
    expect(samplePeakDb(decoded[n].samples)).toBeLessThanOrEqual(-1.4);
  });

  it("board sounds are short enough not to overlap fast play", () => {
    for (const n of ["move", "capture", "castle", "illegal"]) {
      expect(decoded[n].samples.length / 48000).toBeLessThan(0.4);
    }
  });
});

describe("sound choice", () => {
  const base: MoveVisual = {
    id: 1, from: "e2", to: "e4", san: "e4", color: "w", by: "user", via: "drop",
    castle: false, promotion: false, check: false, mate: false,
  };
  it.each([
    ["quiet move", {}, "move"],
    ["capture", { captured: { type: "p", color: "b" as const, square: "d5" as const } }, "capture"],
    ["castling", { castle: true }, "castle"],
    ["check", { check: true }, "check"],
    ["capture with check", { check: true, captured: { type: "p", color: "b" as const, square: "d5" as const } }, "check"],
    ["mate", { check: true, mate: true }, "mate"],
  ])("%s plays %s", (_l, over, want) => {
    expect(soundForMove({ ...base, ...over })).toBe(want);
  });
});
