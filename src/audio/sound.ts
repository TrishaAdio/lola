/**
 * Sound playback: Web Audio, one decoded buffer per sound, two buses under a master.
 *
 *   board bus  move, capture, castle, check, mate, end, illegal
 *   aura bus   the Tactics Aura cue
 *
 * The files are loudness-matched offline (scripts/build-sounds.mjs), so every sound plays
 * at unity gain; the buses exist only so each can be muted independently.
 */
import { getPrefs } from "../settings/prefs";

export type SoundName = "move" | "capture" | "castle" | "check" | "mate" | "end" | "aura" | "illegal";
export type Bus = "board" | "aura";

const BUS_OF: Record<SoundName, Bus> = {
  move: "board",
  capture: "board",
  castle: "board",
  check: "board",
  mate: "board",
  end: "board",
  illegal: "board",
  aura: "aura",
};

const NAMES = Object.keys(BUS_OF) as SoundName[];

interface PlayedSound {
  name: SoundName;
  bus: Bus;
  at: number;
  /** Why it was not heard, if it wasn't. */
  suppressed?: "muted" | "bus-off" | "not-loaded";
}

declare global {
  interface Window {
    /** Recent playback decisions, for tests and debugging. */
    __sounds?: PlayedSound[];
  }
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buses: Partial<Record<Bus, GainNode>> = {};
const buffers: Partial<Record<SoundName, AudioBuffer>> = {};
let loading: Promise<void> | null = null;

function record(entry: PlayedSound) {
  const log = (window.__sounds ??= []);
  log.push(entry);
  if (log.length > 200) log.splice(0, log.length - 200);
}

async function load(context: AudioContext) {
  await Promise.all(
    NAMES.map(async (name) => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}sounds/${name}.wav`);
        if (!res.ok) return;
        buffers[name] = await context.decodeAudioData(await res.arrayBuffer());
      } catch {
        /* a missing sound must never break the game */
      }
    }),
  );
}

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor({ latencyHint: "interactive" });
  master = ctx.createGain();
  master.connect(ctx.destination);
  for (const bus of ["board", "aura"] as const) {
    const g = ctx.createGain();
    g.connect(master);
    buses[bus] = g;
  }
  loading = load(ctx);
  return ctx;
}

/**
 * Browsers only start audio after a user gesture. Called on the first pointer or key
 * press; buffers are fetched then, so nothing downloads for players who never interact.
 */
export function unlockAudio() {
  const c = ensureContext();
  if (c && c.state === "suspended") void c.resume();
}

export function installAudioUnlock() {
  const once = () => {
    unlockAudio();
    window.removeEventListener("pointerdown", once, true);
    window.removeEventListener("keydown", once, true);
  };
  window.addEventListener("pointerdown", once, true);
  window.addEventListener("keydown", once, true);
}

/** Plays `name` after `delayMs`, honouring the mute switches at the moment it sounds. */
export function playSound(name: SoundName, delayMs = 0) {
  const bus = BUS_OF[name];
  const prefs = getPrefs();
  const at = performance.now() + delayMs;

  if (!prefs.soundOn) return record({ name, bus, at, suppressed: "muted" });
  if ((bus === "board" && !prefs.boardSounds) || (bus === "aura" && !prefs.auraSounds)) {
    return record({ name, bus, at, suppressed: "bus-off" });
  }

  const c = ensureContext();
  const buffer = buffers[name];
  if (!c || !buffer) {
    record({ name, bus, at, suppressed: "not-loaded" });
    // First sound of a session can arrive before decoding finishes; play it late
    // rather than never, as long as it is still close to its moment.
    void loading?.then(() => {
      if (buffers[name] && performance.now() - at < 150) playSound(name);
    });
    return;
  }

  record({ name, bus, at });
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(buses[bus]!);
  src.start(c.currentTime + Math.max(0, delayMs) / 1000);
}
