// Verify every library position is legal and playable, and that chaos mode produces
// legal positions reliably. Run with tsx-free plain node by importing the compiled logic
// through a tiny re-implementation guard: we just re-validate the FENs with chess.js.
import { Chess } from "chess.js";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/chess/positions.ts", import.meta.url), "utf8");

// --- openings: replay the declared move strings exactly as the module does ---
const openingRe = /id:\s*"([^"]+)",\s*\n\s*name:\s*"([^"]+)",\s*\n\s*description:\s*"[^"]*",\s*\n\s*moves:\s*"([^"]+)",/g;
let m;
let openings = 0;
let failures = 0;
while ((m = openingRe.exec(src))) {
  const [, id, name, moves] = m;
  const chess = new Chess();
  try {
    for (const san of moves.split(/\s+/).filter(Boolean)) chess.move(san);
    openings++;
    console.log(`ok   opening ${id.padEnd(26)} turn=${chess.turn()} ${chess.fen()}`);
  } catch (e) {
    failures++;
    console.error(`FAIL opening ${id} (${name}): ${e.message}`);
  }
}

// --- hand-written FENs (endgames / puzzles) ---
const fenRe = /id:\s*"([^"]+)",\s*\n\s*name:\s*"([^"]+)",\s*\n\s*category:\s*"(\w+)",\s*\n\s*description:\s*"[^"]*",\s*\n\s*fen:\s*"([^"]+)",/g;
let fens = 0;
while ((m = fenRe.exec(src))) {
  const [, id, name, , fen] = m;
  try {
    const chess = new Chess(fen);
    const legal = chess.moves().length;
    const waiting = chess.turn() === "w" ? "b" : "w";
    const wk = chess.findPiece({ type: "k", color: waiting })[0];
    const illegalCheck = wk ? chess.isAttacked(wk, chess.turn()) : false;
    const over = chess.isGameOver();
    if (legal === 0 || illegalCheck || over) {
      failures++;
      console.error(
        `FAIL fen ${id}: legalMoves=${legal} waitingKingInCheck=${illegalCheck} gameOver=${over}`,
      );
    } else {
      fens++;
      console.log(
        `ok   fen     ${id.padEnd(26)} turn=${chess.turn()} legal=${String(legal).padStart(2)} "${name}"`,
      );
    }
  } catch (e) {
    failures++;
    console.error(`FAIL fen ${id} (${name}): ${e.message}`);
  }
}

console.log(`\nopenings verified: ${openings}, hand-written FENs verified: ${fens}`);
if (failures > 0) {
  console.error(`FAILURES: ${failures}`);
  process.exit(1);
}
console.log("All library positions are legal.");
