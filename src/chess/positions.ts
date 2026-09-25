import { Chess, DEFAULT_POSITION } from "chess.js";
import type { Color, PieceSymbol } from "chess.js";

export type PositionCategory = "opening" | "endgame" | "puzzle";

export interface StartingPosition {
  id: string;
  name: string;
  category: PositionCategory;
  description: string;
  fen: string;
  /** SAN moves that produced `fen`, when it was reached from the initial position. */
  history: string[];
  /** Side the user is suggested to take. */
  suggestedSide: Color;
}

interface OpeningSpec {
  id: string;
  name: string;
  description: string;
  moves: string;
}

/**
 * Openings are declared as move sequences and the FEN is derived with chess.js, so a typo
 * fails loudly at startup instead of silently producing an illegal board.
 */
const OPENING_SPECS: OpeningSpec[] = [
  {
    id: "sicilian-najdorf",
    name: "Sicilian Defence · Najdorf",
    description: "The sharpest mainline Sicilian. Razor-thin margins for both sides.",
    moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6",
  },
  {
    id: "sicilian-dragon",
    name: "Sicilian Defence · Dragon",
    description: "Opposite-side attacks. Whoever arrives first wins.",
    moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6",
  },
  {
    id: "sicilian-sveshnikov",
    name: "Sicilian Defence · Sveshnikov",
    description: "Black accepts a structural hole on d5 for piece activity.",
    moves: "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5",
  },
  {
    id: "kings-indian",
    name: "King's Indian Defence",
    description: "Black cedes the centre, then detonates it. Classic counter-attack.",
    moves: "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6",
  },
  {
    id: "gruenfeld",
    name: "Grünfeld Defence",
    description: "Hypermodern: let White build a big centre, then shoot at it.",
    moves: "d4 Nf6 c4 g6 Nc3 d5",
  },
  {
    id: "nimzo-indian",
    name: "Nimzo-Indian Defence",
    description: "Pin, double the c-pawns, play against the weakness.",
    moves: "d4 Nf6 c4 e6 Nc3 Bb4",
  },
  {
    id: "queens-gambit-declined",
    name: "Queen's Gambit Declined",
    description: "Solid, dense, strategically demanding.",
    moves: "d4 d5 c4 e6 Nc3 Nf6",
  },
  {
    id: "queens-gambit-accepted",
    name: "Queen's Gambit Accepted",
    description: "Black grabs the pawn and must then survive the centre.",
    moves: "d4 d5 c4 dxc4",
  },
  {
    id: "slav",
    name: "Slav Defence",
    description: "Rock-solid defence of the d5 point.",
    moves: "d4 d5 c4 c6",
  },
  {
    id: "ruy-lopez",
    name: "Ruy López",
    description: "The oldest mainline battleground in chess.",
    moves: "e4 e5 Nf3 Nc6 Bb5",
  },
  {
    id: "italian",
    name: "Italian Game",
    description: "Fast development, early pressure on f7.",
    moves: "e4 e5 Nf3 Nc6 Bc4",
  },
  {
    id: "scotch",
    name: "Scotch Game",
    description: "Immediate central liquidation and open lines.",
    moves: "e4 e5 Nf3 Nc6 d4",
  },
  {
    id: "kings-gambit",
    name: "King's Gambit",
    description: "Romantic, reckless, and genuinely dangerous to face.",
    moves: "e4 e5 f4",
  },
  {
    id: "vienna",
    name: "Vienna Game",
    description: "A delayed King's Gambit with extra venom.",
    moves: "e4 e5 Nc3",
  },
  {
    id: "french",
    name: "French Defence",
    description: "Locked centre, long-term structural fight.",
    moves: "e4 e6 d4 d5",
  },
  {
    id: "caro-kann",
    name: "Caro-Kann Defence",
    description: "Sound structure, few weaknesses, slow squeeze.",
    moves: "e4 c6 d4 d5",
  },
  {
    id: "modern-benoni",
    name: "Modern Benoni",
    description: "Unbalanced pawn structure, maximum tension.",
    moves: "d4 c5 d5 e6 c4 exd5 cxd5 d6",
  },
  {
    id: "dutch",
    name: "Dutch Defence",
    description: "Black stakes a claim on the kingside from move one.",
    moves: "d4 f5",
  },
  {
    id: "english",
    name: "English Opening",
    description: "Flexible flank opening that can transpose anywhere.",
    moves: "c4",
  },
  {
    id: "alekhine",
    name: "Alekhine's Defence",
    description: "Provoke the pawns forward, then attack the overextension.",
    moves: "e4 Nf6",
  },
];

function buildOpening(spec: OpeningSpec): StartingPosition {
  const chess = new Chess();
  const moves = spec.moves.split(/\s+/).filter(Boolean);
  for (const san of moves) {
    // Throws on an invalid move, which is what we want during module init.
    chess.move(san);
  }
  return {
    id: spec.id,
    name: spec.name,
    category: "opening",
    description: spec.description,
    fen: chess.fen(),
    history: chess.history(),
    suggestedSide: chess.turn(),
  };
}

/** Technique tests: positions where a win exists but must actually be converted. */
const TECHNICAL_POSITIONS: StartingPosition[] = [
  {
    id: "lucena",
    name: "Lucena position",
    category: "endgame",
    description: "Rook and pawn vs rook. Win requires building a bridge - no shuffling.",
    fen: "1K6/1P1k4/8/8/8/8/2R5/7r w - - 0 1",
    history: [],
    suggestedSide: "w",
  },
  {
    id: "queen-vs-rook",
    name: "Queen vs rook",
    category: "endgame",
    description: "A textbook win that is notoriously hard to actually execute.",
    fen: "8/8/4r3/4k3/8/8/8/1Q2K3 w - - 0 1",
    history: [],
    suggestedSide: "w",
  },
  {
    id: "two-bishops",
    name: "Two bishops mate",
    category: "endgame",
    description: "Forced mate with bishop pair. Precision or the 50-move rule saves them.",
    fen: "8/8/8/4k3/8/8/8/K1BB4 w - - 0 1",
    history: [],
    suggestedSide: "w",
  },
  {
    id: "rook-endgame-conversion",
    name: "King and rook vs king",
    category: "endgame",
    description: "The most basic conversion. Watch the engine mate in minimum moves.",
    fen: "8/8/8/4k3/8/8/8/K6R w - - 0 1",
    history: [],
    suggestedSide: "w",
  },
  {
    id: "back-rank-mate-in-1",
    name: "Back-rank mate in 1",
    category: "puzzle",
    description: "Warm-up. One move ends it.",
    fen: "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1",
    history: [],
    suggestedSide: "w",
  },
  {
    id: "greek-gift",
    name: "Greek gift structure",
    category: "puzzle",
    description: "A classic Bxh7+ sacrificial pattern waiting to happen.",
    fen: "r1bq1rk1/pppn1ppp/3bp3/3pP3/3P4/2NB1N2/PPP2PPP/R1BQ1RK1 w - - 0 1",
    history: [],
    suggestedSide: "w",
  },
];

export const OPENING_POSITIONS: StartingPosition[] = OPENING_SPECS.map(buildOpening);

export const LIBRARY_POSITIONS: StartingPosition[] = [
  ...OPENING_POSITIONS,
  ...TECHNICAL_POSITIONS,
];

export const STANDARD_FEN = DEFAULT_POSITION;

export interface FenValidation {
  ok: boolean;
  error?: string;
  fen?: string;
  turn?: Color;
}

/** Validates a pasted FEN and reports a usable error message. */
export function validateFen(input: string): FenValidation {
  const fen = input.trim();
  if (!fen) return { ok: false, error: "Paste a FEN string." };
  try {
    const chess = new Chess(fen);
    if (chess.isGameOver()) {
      const why = chess.isCheckmate()
        ? "already checkmate"
        : chess.isStalemate()
          ? "already stalemate"
          : "already a draw";
      return { ok: false, error: `That position is ${why}.` };
    }
    return { ok: true, fen: chess.fen(), turn: chess.turn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid FEN." };
  }
}

const RANDOM_PIECES: PieceSymbol[] = ["q", "r", "r", "b", "b", "n", "n", "p", "p", "p", "p"];

function randomInt(n: number) {
  return Math.floor(Math.random() * n);
}

/**
 * Chaos mode: generates a random *legal* position.
 *
 * Builds a board directly, then leans on chess.js validation plus an explicit check that
 * the side not to move isn't left in check. Retries until a playable position appears.
 */
export function randomLegalPosition(attempts = 500): StartingPosition {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const board: (string | null)[][] = Array.from({ length: 8 }, () => Array(8).fill(null));
    const used = new Set<string>();

    const place = (piece: string): boolean => {
      for (let tries = 0; tries < 64; tries++) {
        const file = randomInt(8);
        const rank = randomInt(8);
        const key = `${file},${rank}`;
        if (used.has(key)) continue;
        // Pawns may never sit on the first or last rank.
        if (piece.toLowerCase() === "p" && (rank === 0 || rank === 7)) continue;
        used.add(key);
        board[rank][file] = piece;
        return true;
      }
      return false;
    };

    // Kings first, and never adjacent.
    const wkFile = randomInt(8);
    const wkRank = randomInt(8);
    board[wkRank][wkFile] = "K";
    used.add(`${wkFile},${wkRank}`);

    let placedBlackKing = false;
    for (let tries = 0; tries < 200 && !placedBlackKing; tries++) {
      const file = randomInt(8);
      const rank = randomInt(8);
      if (Math.abs(file - wkFile) <= 1 && Math.abs(rank - wkRank) <= 1) continue;
      if (used.has(`${file},${rank}`)) continue;
      board[rank][file] = "k";
      used.add(`${file},${rank}`);
      placedBlackKing = true;
    }
    if (!placedBlackKing) continue;

    const count = 3 + randomInt(6);
    for (let i = 0; i < count; i++) {
      place(RANDOM_PIECES[randomInt(RANDOM_PIECES.length)].toUpperCase());
      place(RANDOM_PIECES[randomInt(RANDOM_PIECES.length)]);
    }

    // Serialise ranks 8..1 into FEN piece placement.
    const placement = Array.from({ length: 8 }, (_, i) => {
      const rank = 7 - i;
      let row = "";
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const piece = board[rank][file];
        if (!piece) {
          empty++;
          continue;
        }
        if (empty) {
          row += String(empty);
          empty = 0;
        }
        row += piece;
      }
      if (empty) row += String(empty);
      return row;
    }).join("/");

    const turn: Color = randomInt(2) === 0 ? "w" : "b";
    const fen = `${placement} ${turn} - - 0 1`;

    try {
      const chess = new Chess(fen);
      const waiting: Color = turn === "w" ? "b" : "w";
      const waitingKing = chess.findPiece({ type: "k", color: waiting })[0];
      // The side that just "moved" cannot still be in check.
      if (waitingKing && chess.isAttacked(waitingKing, turn)) continue;
      if (chess.isGameOver()) continue;
      if (chess.moves().length === 0) continue;

      return {
        id: `random-${Date.now()}`,
        name: "Chaos position",
        category: "puzzle",
        description: "Randomly generated legal position. Good luck.",
        fen: chess.fen(),
        history: [],
        suggestedSide: turn,
      };
    } catch {
      continue;
    }
  }

  // Extremely unlikely; fall back to the standard game.
  return {
    id: "standard-fallback",
    name: "Standard position",
    category: "opening",
    description: "Could not generate a random position, using the standard start.",
    fen: STANDARD_FEN,
    history: [],
    suggestedSide: "w",
  };
}
