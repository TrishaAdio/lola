/**
 * Tactics Aura: short, in-character lines that react to the position.
 *
 * Flavour only - completely separate from move selection. Every line is gated by a
 * concrete trigger measured from the position (Stockfish's mate score, win-probability
 * swings, the human's legal-move count, material actually under attack), so the menace is
 * earned by the board, never random bluster.
 *
 * Tone is confident and ominous, never abusive.
 */

export interface AuraInput {
  /** Engine moves made so far this game, including this one. */
  engineMove: number;
  /** Engine's win probability (0-100) after its previous move, if any. */
  winBeforeHuman: number | null;
  /** Engine's win probability after the human's reply - i.e. before this engine move. */
  winAfterHuman: number;
  /** Engine's win probability after this engine move. */
  winAfterEngine: number;
  /**
   * Engine moves still needed to mate *after* this one, when Stockfish has proven a mate.
   * 0 means this move delivered mate.
   */
  mateIn: number | null;
  /** Legal replies the human has now. */
  humanReplies: number;
  /** The engine's move gives check. */
  check: boolean;
  /** Engine attacks on squares around the human's king. */
  kingZoneAttacks: number;
  /** The biggest piece of the human's the engine now attacks with real effect. */
  target: { piece: string; square: string; value: number } | null;
  /** Candidate lines Stockfish rates as winning for the engine. */
  winningLines: number;
  /** Relative rank (0-7) of the engine's most advanced passed pawn. */
  passedPawnRank: number;
}

export type TriggerId =
  | "mate-delivered"
  | "mate-net"
  | "constriction"
  | "blunder"
  | "many-ways"
  | "king-target"
  | "material-target"
  | "passed-pawn"
  | "momentum";

interface Trigger {
  id: TriggerId;
  /** May fire even inside the global cooldown - reserved for real forced sequences. */
  urgent?: boolean;
  /** Engine moves before this trigger may fire again. */
  cooldown: number;
  when: (i: AuraInput, s: AuraState) => boolean;
  lines: (i: AuraInput) => string[];
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five"];

/**
 * The trigger table. Order is priority: the first matching trigger that is off cooldown
 * speaks; at most one line per engine move.
 */
export const TRIGGERS: Trigger[] = [
  {
    id: "mate-delivered",
    urgent: true,
    cooldown: 0,
    // The move just played is checkmate.
    when: (i) => i.mateIn === 0,
    lines: () => ["It was over a few moves ago.", "Nowhere left to go.", "That's the one."],
  },
  {
    id: "mate-net",
    urgent: true,
    cooldown: 4,
    // Only a mate Stockfish has actually proven, and only while it is still to come.
    when: (i) => i.mateIn !== null && i.mateIn >= 1 && i.mateIn <= 6,
    lines: () => [
      "There's no square that saves you here.",
      "Every road from here ends the same way.",
      "I've already counted the moves.",
      "Look for the exit. There isn't one.",
    ],
  },
  {
    id: "constriction",
    cooldown: 5,
    // Replies must remain: with none left the game is over, not closing in.
    when: (i) => i.humanReplies >= 1 && i.humanReplies <= 3 && i.winAfterEngine >= 85,
    lines: () => [
      "You're running out of moves.",
      "Fewer choices every turn.",
      "The board is getting smaller for you.",
    ],
  },
  {
    id: "blunder",
    cooldown: 3,
    // The human's own move handed over at least 20 points of winning chances.
    when: (i) => i.winBeforeHuman !== null && i.winAfterHuman - i.winBeforeHuman >= 20,
    lines: () => [
      "Interesting choice. I won't need to ask twice.",
      "That's the one I was waiting for.",
      "I'll take that.",
      "You'll want that one back.",
    ],
  },
  {
    id: "many-ways",
    cooldown: 8,
    when: (i) => i.winningLines >= 3 && i.winAfterEngine >= 80,
    lines: (i) => [`I see ${NUMBER_WORDS[Math.min(i.winningLines, 5)]} ways this ends badly for you.`],
  },
  {
    id: "king-target",
    cooldown: 6,
    when: (i) => (i.check || i.kingZoneAttacks >= 4) && i.winAfterEngine >= 65,
    lines: () => [
      "Your king just became a target.",
      "Your king is starting to feel exposed.",
      "Watch your king. I am.",
    ],
  },
  {
    id: "material-target",
    cooldown: 5,
    when: (i) => i.target !== null && i.target.value >= 3 && i.winAfterEngine >= 55,
    lines: (i) => [
      `That ${i.target!.piece} on ${i.target!.square} is living on borrowed time.`,
      `Your ${i.target!.piece} on ${i.target!.square} has nowhere good to go.`,
    ],
  },
  {
    id: "passed-pawn",
    cooldown: 8,
    when: (i) => i.passedPawnRank >= 5 && i.winAfterEngine >= 60,
    lines: () => ["That pawn is now a countdown.", "Keep an eye on that pawn. It won't stop."],
  },
  {
    id: "momentum",
    cooldown: 6,
    // Fires once per threshold crossed, so confidence grows with the advantage.
    when: (i, s) => nextMomentumLevel(i.winAfterEngine, s.momentumLevel) > s.momentumLevel,
    lines: (i) =>
      i.winAfterEngine >= 95
        ? ["This was decided a while ago.", "Only the formalities remain."]
        : i.winAfterEngine >= 85
          ? ["The walls are moving in.", "It's slipping away from you now."]
          : ["The position is starting to close around you.", "I like where this is going."],
  },
];

const MOMENTUM_LEVELS = [70, 85, 95];

function nextMomentumLevel(win: number, current: number): number {
  let level = current;
  for (let i = 0; i < MOMENTUM_LEVELS.length; i++) if (win >= MOMENTUM_LEVELS[i]) level = Math.max(level, i + 1);
  return level;
}

/** At least this many engine moves between two lines, unless a trigger is urgent. */
export const GLOBAL_COOLDOWN = 3;

export interface AuraState {
  lastSpokeAt: number;
  lastFired: Partial<Record<TriggerId, number>>;
  lastLine: Partial<Record<TriggerId, string>>;
  momentumLevel: number;
}

export const initialAuraState = (): AuraState => ({
  lastSpokeAt: -Infinity,
  lastFired: {},
  lastLine: {},
  momentumLevel: 0,
});

export interface AuraMessage {
  trigger: TriggerId;
  text: string;
}

/**
 * Decides whether the engine says anything after its move. Pure: returns the next state.
 * `random` is injectable so tests are deterministic.
 */
export function evaluateAura(
  input: AuraInput,
  state: AuraState,
  random: () => number = Math.random,
): { message: AuraMessage | null; state: AuraState } {
  const next: AuraState = {
    ...state,
    lastFired: { ...state.lastFired },
    lastLine: { ...state.lastLine },
  };
  // Track momentum even while silent, so a crossed threshold is not announced late.
  const level = nextMomentumLevel(input.winAfterEngine, state.momentumLevel);

  const sinceAny = input.engineMove - state.lastSpokeAt;

  for (const trigger of TRIGGERS) {
    if (!trigger.when(input, state)) continue;
    const sinceThis = input.engineMove - (state.lastFired[trigger.id] ?? -Infinity);
    if (sinceThis < trigger.cooldown) continue;
    if (sinceAny < GLOBAL_COOLDOWN && !trigger.urgent) continue;

    const pool = trigger.lines(input);
    const fresh = pool.length > 1 ? pool.filter((l) => l !== state.lastLine[trigger.id]) : pool;
    const text = fresh[Math.floor(random() * fresh.length) % fresh.length];

    next.lastSpokeAt = input.engineMove;
    next.lastFired[trigger.id] = input.engineMove;
    next.lastLine[trigger.id] = text;
    next.momentumLevel = level;
    return { message: { trigger: trigger.id, text }, state: next };
  }

  next.momentumLevel = sinceAny < GLOBAL_COOLDOWN ? state.momentumLevel : level;
  return { message: null, state: next };
}
