/**
 * Loudness measurement per ITU-R BS.1770-4 (K-weighting), mono, 48 kHz.
 *
 * Short UI sounds are measured by their maximum *momentary* loudness (400 ms window),
 * which is what a listener hears as "how loud that click was". Sounds shorter than the
 * window are measured as if followed by silence, so every sound is judged the same way.
 */
export const SAMPLE_RATE = 48000;

/** K-weighting biquads for 48 kHz, straight from BS.1770-4. */
const STAGES = [
  // Stage 1: high-shelf (head acoustics)
  { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
  // Stage 2: RLB high-pass
  { b: [1.0, -2.0, 1.0], a: [-1.99004745483398, 0.99007225036621] },
];

function biquad(input, { b, a }) {
  const out = new Float64Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < input.length; n++) {
    const x0 = input[n];
    const y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    out[n] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

export function kWeight(samples) {
  return STAGES.reduce((sig, stage) => biquad(sig, stage), Float64Array.from(samples));
}

/** Max momentary loudness in LUFS (400 ms window, 10 ms hop). */
export function momentaryMaxLufs(samples, sampleRate = SAMPLE_RATE) {
  if (sampleRate !== SAMPLE_RATE) throw new Error("K-weighting coefficients are for 48 kHz");
  const win = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.01 * sampleRate);
  const padded = new Float64Array(Math.max(samples.length, win) + win);
  padded.set(samples);
  const k = kWeight(padded);

  const sq = new Float64Array(k.length + 1);
  for (let i = 0; i < k.length; i++) sq[i + 1] = sq[i] + k[i] * k[i];

  let best = -Infinity;
  for (let start = 0; start + win <= k.length; start += hop) {
    const ms = (sq[start + win] - sq[start]) / win;
    if (ms > 0) best = Math.max(best, -0.691 + 10 * Math.log10(ms));
  }
  return best;
}

export function samplePeakDb(samples) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  return 20 * Math.log10(peak || 1e-12);
}

/** In-place radix-2 FFT. `re`/`im` length must be a power of two. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
        const tr = ar * wr - ai * wi, ti = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k] - tr;
        im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }
}

/** Hann-windowed power spectrum of `size` samples starting at `start`. */
export function powerSpectrum(samples, { start = 0, size = 8192 } = {}) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const v = samples[start + i] ?? 0;
    re[i] = v * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  fft(re, im);
  const power = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  return power;
}

/** Strongest frequency (Hz) in the first ~170 ms, ignoring anything below `minHz`. */
export function dominantFrequency(samples, sampleRate = SAMPLE_RATE, minHz = 40) {
  const size = 8192;
  const p = powerSpectrum(samples, { size });
  const binHz = sampleRate / size;
  let best = 0;
  for (let k = Math.ceil(minHz / binHz); k < p.length - 1; k++) if (p[k] > p[best]) best = k;
  // Parabolic interpolation for sub-bin accuracy.
  const [a, b, c] = [p[best - 1] ?? 0, p[best], p[best + 1] ?? 0].map((v) => Math.log(v + 1e-30));
  const offset = (a - c) / (2 * (a - 2 * b + c) || 1);
  return (best + offset) * binHz;
}

/**
 * Spectral centroid (Hz) of the attack - the first `ms` milliseconds - which is what makes
 * one tap sound harder or brighter than another.
 */
export function attackCentroid(samples, sampleRate = SAMPLE_RATE, ms = 30) {
  const size = 2048;
  const n = Math.round((ms / 1000) * sampleRate);
  const head = Float64Array.from({ length: size }, (_, i) => (i < n ? samples[i] ?? 0 : 0));
  const p = powerSpectrum(head, { size });
  const binHz = sampleRate / size;
  let num = 0, den = 0;
  for (let k = 1; k < p.length; k++) {
    num += k * binHz * p[k];
    den += p[k];
  }
  return den ? num / den : 0;
}

/**
 * Share of the sound's energy above `loHz` - a proxy for how much survives laptop and
 * phone speakers, which reproduce little below ~250 Hz.
 */
export function bandEnergyFraction(samples, loHz = 250, sampleRate = SAMPLE_RATE) {
  const size = 1 << Math.min(15, Math.ceil(Math.log2(Math.max(2048, samples.length))));
  const p = powerSpectrum(samples, { size });
  const binHz = sampleRate / size;
  let above = 0, total = 0;
  for (let k = 1; k < p.length; k++) {
    total += p[k];
    if (k * binHz >= loHz) above += p[k];
  }
  return total ? above / total : 0;
}

// ---- WAV (PCM 16-bit mono) ------------------------------------------------------------

export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function decodeWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (channels !== 1 || bits !== 16) throw new Error("expected 16-bit mono");
  const len = buf.readUInt32LE(40) / 2;
  const samples = new Float64Array(len);
  for (let i = 0; i < len; i++) samples[i] = buf.readInt16LE(44 + i * 2) / 32767;
  return { sampleRate, samples };
}
