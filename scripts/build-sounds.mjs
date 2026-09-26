/**
 * Renders the app's sound set by modal synthesis, then normalises its loudness.
 *
 * One material model throughout: a boxwood piece, a felt-topped board, and a wooden bar
 * struck with a felt mallet. Every sound is an excitation (a contact pulse whose length
 * sets hardness) driving damped resonant modes, and every mode decays by the same
 * frequency-dependent law, so the whole set reads as one instrument:
 *
 *   move     felt-damped knock of the piece landing
 *   capture  hard wood-on-wood click, then the landing knock
 *   castle   two knocks: king, then rook
 *   check    single struck bar, D4
 *   mate     two bars a fifth apart, G3 + D4, long decay, over a landing knock
 *   end      single soft bar, C4 - draws, resignation, time
 *   aura     soft-mallet bar pair, B3 + F#4, for Tactics Aura lines
 *   illegal  a muted, heavily damped tap
 *
 * Mix pass: each sound is brought to the same maximum momentary loudness (BS.1770-4
 * K-weighted, 400 ms) and passed through a lookahead peak limiter, iterating until the
 * loudness lands on target with every peak under the ceiling. The limiter only shaves the
 * first milliseconds of the sharpest transients; the result is capped at MAX_LIMIT_DB so
 * no sound is squashed. Deterministic: re-running produces byte-identical files.
 *
 *   node scripts/build-sounds.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SAMPLE_RATE as FS,
  attackCentroid,
  bandEnergyFraction,
  dominantFrequency,
  encodeWav,
  momentaryMaxLufs,
  samplePeakDb,
} from "./lib/loudness.mjs";

const OUT = path.resolve(import.meta.dirname, "..", "public", "sounds");
const TARGET_LUFS = -23;
const PEAK_CEILING_DB = -1.5;
/** Never take more than this off a transient; lower the target instead. */
const MAX_LIMIT_DB = 6;

// ---- deterministic randomness ---------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- the material ---------------------------------------------------------------------

/**
 * One damping law for every mode of every sound: higher modes die faster (T60 ~ f^-0.8),
 * which is characteristic of wood. `support` scales it - felt under a piece damps hard,
 * a freely struck bar rings.
 */
const woodT60 = (freq, support) => support * 0.55 * (200 / freq) ** 0.8;

/**
 * Board-and-piece body modes (Hz, amplitude). The low board mode gives weight; the
 * energy sits in the 400 Hz - 1.5 kHz "tock" band, which small speakers reproduce.
 */
const BODY_MODES = [
  [138, 0.08], [251, 0.22], [392, 0.6], [617, 1.0], [938, 0.95], [1470, 0.7], [2260, 0.45], [3390, 0.25],
];

/** Wooden bar partial ratios (tuned bar, roughly 1 : 3.9 : 9.2). */
const BAR_PARTIALS = [[1, 1.0], [3.93, 0.55], [9.2, 0.18]];

// ---- building blocks ------------------------------------------------------------------

const buffer = (seconds) => new Float64Array(Math.round(seconds * FS));

/**
 * Contact force: a half-sine pulse (the body of the impact) plus a sliver of lowpassed
 * noise (surface texture). Shorter contact = harder material = brighter sound.
 */
function contact({ ms, texture = 0.15, brightness = 3000, seed }) {
  const rand = mulberry32(seed);
  const n = Math.max(2, Math.round((ms / 1000) * FS));
  const out = new Float64Array(n + Math.round(0.006 * FS));
  const alpha = 1 - Math.exp((-2 * Math.PI * brightness) / FS);
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const pulse = i < n ? Math.sin((Math.PI * i) / n) : 0;
    lp += alpha * (rand() * 2 - 1 - lp);
    const env = Math.exp(-i / (0.0018 * FS));
    out[i] = pulse + texture * lp * env;
  }
  return out;
}

/** Drives a bank of two-pole resonators with `force`, mixing into `out` at `atSec`. */
function resonate(out, force, modes, { atSec = 0, gain = 1, support }) {
  const offset = Math.round(atSec * FS);
  for (const [freq, g] of modes) {
    if (freq >= FS / 2.2) continue;
    const t60 = woodT60(freq, support);
    const r = Math.exp(-6.9078 / (t60 * FS));
    const w = (2 * Math.PI * freq) / FS;
    const c1 = 2 * r * Math.cos(w);
    const c2 = -r * r;
    // A two-pole resonator's impulse response is r^n sin((n+1)w) / sin(w). Scaling the
    // input by sin(w) makes every mode ring at amplitude `g` per unit impulse, so low
    // modes are not boosted just for being low.
    const norm = Math.sin(w) * g * gain * 0.02;
    let y1 = 0, y2 = 0;
    const len = Math.min(out.length - offset, Math.round(t60 * 1.6 * FS) + force.length);
    for (let i = 0; i < len; i++) {
      const x = i < force.length ? force[i] : 0;
      const y = c1 * y1 + c2 * y2 + norm * x;
      out[offset + i] += y;
      y2 = y1; y1 = y;
    }
  }
}

function mixDirect(out, force, atSec, gain) {
  const offset = Math.round(atSec * FS);
  for (let i = 0; i < force.length && offset + i < out.length; i++) out[offset + i] += force[i] * gain;
}

/** A piece landing on the felt board. */
function knock(out, { atSec = 0, gain = 1, ms = 0.55, seed, support = 0.5, pieceModes = 1 }) {
  const f = contact({ ms, texture: 0.12, brightness: 2400, seed });
  const modes = BODY_MODES.map(([fr, g], i) => [fr * (1 + (i % 3) * 0.004), i >= 5 ? g * pieceModes : g]);
  resonate(out, f, modes, { atSec, gain, support });
  mixDirect(out, f, atSec, 0.01 * gain);
}

/** A struck wooden bar, fundamental `freq`. */
function bar(out, { freq, atSec = 0, gain = 1, ms = 0.7, seed, support = 2.2 }) {
  const f = contact({ ms, texture: 0.05, brightness: 1800, seed });
  resonate(out, f, BAR_PARTIALS.map(([ratio, g]) => [freq * ratio, g]), { atSec, gain, support });
}

// ---- the set --------------------------------------------------------------------------

const SOUNDS = {
  move: { seconds: 0.35, render: (o) => knock(o, { seed: 11 }) },
  capture: {
    seconds: 0.4,
    render: (o) => {
      // Wood on wood: very short contact, the pieces' own modes dominate.
      const click = contact({ ms: 0.22, texture: 0.3, brightness: 8000, seed: 21 });
      resonate(o, click, BODY_MODES.slice(4), { gain: 1.4, support: 0.22 });
      knock(o, { atSec: 0.028, seed: 22, gain: 0.9 });
    },
  },
  castle: {
    seconds: 0.45,
    render: (o) => {
      knock(o, { seed: 31 });
      knock(o, { atSec: 0.085, seed: 32, gain: 0.8, ms: 0.65 });
    },
  },
  check: { seconds: 1.4, render: (o) => bar(o, { freq: 293.66, seed: 41 }) },
  mate: {
    seconds: 2.6,
    render: (o) => {
      knock(o, { seed: 51, gain: 0.8 });
      bar(o, { freq: 196.0, atSec: 0.02, seed: 52, support: 3.4, ms: 0.9 });
      bar(o, { freq: 293.66, atSec: 0.02, seed: 53, support: 3.4, gain: 0.8, ms: 0.9 });
    },
  },
  end: { seconds: 2.0, render: (o) => bar(o, { freq: 261.63, seed: 61, support: 2.6, ms: 1.1 }) },
  aura: {
    seconds: 2.2,
    render: (o) => {
      // Soft mallet: long contact, so it swells rather than strikes.
      bar(o, { freq: 246.94, seed: 71, support: 2.8, ms: 2.4 });
      bar(o, { freq: 369.99, atSec: 0.06, seed: 72, support: 2.8, ms: 2.4, gain: 0.6 });
    },
  },
  illegal: { seconds: 0.25, render: (o) => knock(o, { seed: 81, ms: 1.1, support: 0.24, pieceModes: 0 }) },
};

// ---- finishing: DC removal, silence trim, fades, loudness -----------------------------

function dcBlock(x) {
  const out = new Float64Array(x.length);
  const R = Math.exp((-2 * Math.PI * 30) / FS);
  let px = 0, py = 0;
  for (let i = 0; i < x.length; i++) {
    const y = x[i] - px + R * py;
    out[i] = y;
    px = x[i]; py = y;
  }
  return out;
}

function trimAndFade(x) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const floor = peak * 10 ** (-66 / 20);
  let end = x.length - 1;
  while (end > 0 && Math.abs(x[end]) < floor) end--;
  const len = Math.min(x.length, end + Math.round(0.02 * FS));
  const out = x.slice(0, len);
  const fade = Math.min(Math.round(0.03 * FS), len);
  for (let i = 0; i < fade; i++) out[len - fade + i] *= 0.5 * (1 + Math.cos((Math.PI * i) / fade));
  const fadeIn = Math.round(0.0005 * FS);
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
  return out;
}

const scale = (x, db) => x.map((v) => v * 10 ** (db / 20));

/**
 * Lookahead peak limiter: gain reduction ramps in over `lookMs` before a peak and
 * releases over `releaseMs`, so peaks are caught without clicks. Returns the output and
 * the deepest reduction applied (dB).
 */
function limit(x, ceilingDb, lookMs = 1.5, releaseMs = 40) {
  const ceiling = 10 ** (ceilingDb / 20);
  const look = Math.max(1, Math.round((lookMs / 1000) * FS));
  const rel = Math.exp(-1 / ((releaseMs / 1000) * FS));
  const need = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    need[i] = a > ceiling ? ceiling / a : 1;
  }
  // Backward pass spreads each reduction `look` samples early (attack).
  const gain = new Float64Array(x.length).fill(1);
  for (let i = x.length - 1; i >= 0; i--) {
    const ahead = i + 1 < x.length ? gain[i + 1] : 1;
    const ramp = 1 - (1 - ahead) * (1 - 1 / look);
    gain[i] = Math.min(need[i], ramp);
  }
  // Forward pass: smooth release.
  let g = 1;
  let deepest = 1;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    g = gain[i] < g ? gain[i] : g * rel + gain[i] * (1 - rel);
    deepest = Math.min(deepest, g);
    out[i] = x[i] * g;
  }
  return { out, reductionDb: -20 * Math.log10(deepest) };
}

/** Loudness to `target` with peaks under the ceiling; returns null if it would over-limit. */
function master(x, target) {
  let gainDb = target - momentaryMaxLufs(x);
  for (let pass = 0; pass < 8; pass++) {
    const { out, reductionDb } = limit(scale(x, gainDb), PEAK_CEILING_DB);
    const miss = target - momentaryMaxLufs(out);
    if (Math.abs(miss) < 0.05) return reductionDb <= MAX_LIMIT_DB ? { out, reductionDb } : null;
    gainDb += miss;
  }
  return null;
}

// Render and measure.
const rendered = Object.fromEntries(
  Object.entries(SOUNDS).map(([name, spec]) => {
    const raw = buffer(spec.seconds);
    spec.render(raw);
    return [name, trimAndFade(dcBlock(raw))];
  }),
);

// Common target: TARGET_LUFS, lowered in 0.5 LU steps until every sound masters cleanly.
let target = TARGET_LUFS;
let mastered;
for (;;) {
  mastered = Object.fromEntries(Object.entries(rendered).map(([n, x]) => [n, master(x, target)]));
  if (Object.values(mastered).every(Boolean)) break;
  target -= 0.5;
  if (target < -40) throw new Error("could not master the set");
}

// TPDF dither for the 16-bit encode.
const ditherRand = mulberry32(99);
const lsb = 1 / 32767;

mkdirSync(OUT, { recursive: true });
const manifest = { generatedBy: "scripts/build-sounds.mjs", sampleRate: FS, targetLufs: Number(target.toFixed(2)), sounds: {} };

for (const name of Object.keys(rendered)) {
  const { out: normalised, reductionDb } = mastered[name];
  const dithered = normalised.map((v, i) =>
    i < 24 || i > normalised.length - 24 ? v : v + (ditherRand() - ditherRand()) * lsb,
  );
  writeFileSync(path.join(OUT, `${name}.wav`), encodeWav(dithered));
  manifest.sounds[name] = {
    file: `${name}.wav`,
    durationMs: Math.round((dithered.length / FS) * 1000),
    momentaryMaxLufs: Number(momentaryMaxLufs(dithered).toFixed(2)),
    samplePeakDb: Number(samplePeakDb(dithered).toFixed(2)),
    dominantHz: Math.round(dominantFrequency(dithered)),
    attackCentroidHz: Math.round(attackCentroid(dithered)),
    above250Hz: Number(bandEnergyFraction(dithered, 250).toFixed(3)),
    limiterDb: Number(reductionDb.toFixed(2)),
  };
}
writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`common target ${target.toFixed(2)} LUFS (momentary max), ceiling ${PEAK_CEILING_DB} dBFS`);
console.log("sound      ms   LUFS-M  peak dB  limiter dB  dominant Hz  attack centroid Hz  energy >250Hz");
for (const [name, m] of Object.entries(manifest.sounds)) {
  console.log(
    `${name.padEnd(8)} ${String(m.durationMs).padStart(5)}  ${m.momentaryMaxLufs.toFixed(2).padStart(7)}  ${m.samplePeakDb.toFixed(2).padStart(7)}  ${m.limiterDb.toFixed(2).padStart(10)}  ${String(m.dominantHz).padStart(11)}  ${String(m.attackCentroidHz).padStart(18)}  ${(m.above250Hz * 100).toFixed(0).padStart(12)}%`,
  );
}
