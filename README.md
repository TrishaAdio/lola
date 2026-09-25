# RuthlessChess

Pick a starting position, then play move-by-move against a full-strength Stockfish NNUE
engine running entirely in your browser. It does not offer draws, does not resign, and
takes the shortest mate available.

Fully client-side — no backend. The engine runs as WebAssembly in a dedicated Web Worker
and is driven over the UCI protocol.

## Quick start

```bash
npm install     # also copies the engine binaries into public/engine/
npm run dev
npm run verify  # unit tests + position validation + browser smoke test
```

## Engine builds

`npm install` copies the Stockfish 19 WASM builds out of `node_modules` into
`public/engine/` (see `scripts/sync-engine.mjs`). Four tiers are selectable at runtime:

| Tier | wasm size | Needs COOP/COEP | Notes |
| --- | --- | --- | --- |
| Full NNUE, multi-threaded | ~94 MB | yes | Strongest. Huge download. |
| Full NNUE, single-threaded | ~94 MB | no | Full net, one core. |
| Lite NNUE, multi-threaded | ~1.6 MB | yes | **Default when available.** |
| Lite NNUE, single-threaded | ~1.8 MB | no | Runs anywhere. |

All four builds ship in this repo — no extra download. The full builds are only assembled
into `public/engine/` on request, so normal installs and builds stay small:

```bash
npm run engine:full     # assemble the full NNUE builds (local, no network)
```

The app probes which builds are actually present (and whether the page is cross-origin
isolated) and only offers tiers it can really run.

### How the 94 MiB builds are stored

Each full build is ~94.5 MiB. That fits under GitHub's 100 MiB hard limit, but GitHub warns
above 50 MiB and a future NNUE net could cross the limit outright. So the full builds are
committed as **40 MiB chunks** in `engine-parts/`, alongside a `manifest.json` recording the
sha256 and byte length of every chunk and of each complete file.

`npm run engine:full` concatenates the chunks, verifies each chunk's hash and then the
assembled file's hash, and writes a single ordinary `.wasm` into `public/engine/`. The
reassembled files are byte-identical to the originals shipped by the `stockfish` package.

Reassembly happens at **install time, not in the browser** — the app loads one plain
`.wasm` file and knows nothing about chunking, so there is no runtime complexity or new
failure mode.

```bash
npm run engine:verify   # re-hash the assembled builds against the manifest
npm run engine:chunk    # maintainers only: re-split after an engine upgrade
```

`engine-parts/` is ~189 MiB total, which is the cost of having the strongest engine
available straight from a clone. If you only ever need the lite engine, nothing forces you
to assemble the full one.

**Important:** every tier plays at `Skill Level 20` with `UCI_LimitStrength false`. The
difference between tiers is network size and threading — never an artificial handicap.

### Cross-origin isolation

Multi-threaded builds need `SharedArrayBuffer`, which browsers only expose to
cross-origin isolated pages. The required headers are configured for `vite dev` and
`vite preview` in `vite.config.ts`, and in `public/_headers` for static hosts:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them the app still works and falls back to a single-threaded build.

## What makes it ruthless

Stockfish's own search is **not** modified. The engine is asked for its top 3 lines
(MultiPV 3) and `src/engine/policy.ts` chooses between them:

1. **Fastest mate.** Mate scores are ranked so a shorter mate always beats a longer one,
   and a longer *survival* always beats a quicker loss. It plays to actual mate rather
   than shuffling in a won endgame.
2. **No voluntary draws.** A candidate that hands the opponent a threefold-repetition or
   fifty-move claim is rejected outright — unless the engine is genuinely losing, where a
   draw is a good result and the penalty is dropped.
3. **Pressure tie-break.** Among moves Stockfish rates within `TIE_BREAK_WINDOW_CP`
   (25 cp) of its best, it prefers the one that keeps the most pressure: checks, fewer
   legal replies for the opponent, and undefended enemy material. Outside that window
   evaluation always wins — aggression never costs real eval.

The commentary panel shows each candidate's evaluation, the opponent's reply count and
its pressure score, plus which move was chosen and why.

Turn the layer off with the "Kill-instinct tie-break" checkbox to get plain Stockfish
best-move play. "Practice" mode is the only place strength is actually reduced, via real
`Skill Level` weakening and an optional `UCI_Elo` cap.

## Starting positions

- Standard position as White or Black.
- 20 opening structures (Najdorf, Dragon, King's Indian, Grünfeld, Nimzo-Indian, QGD/QGA,
  Slav, Ruy López, Italian, Scotch, King's Gambit, Vienna, French, Caro-Kann, Benoni,
  Dutch, English, Alekhine, Sveshnikov). These are declared as move sequences and their
  FENs are derived with chess.js, so a typo fails loudly instead of producing an illegal
  board.
- Endgame technique tests (Lucena, queen vs rook, two bishops, K+R vs K) and sharp
  tactical positions.
- Any position via FEN paste, with validation.
- Chaos mode: a randomly generated legal position.

`npm run verify:positions` asserts every library position is legal, playable and not
already finished.

## Project layout

```
src/engine/    UCI client, engine tiers/capability detection, ruthless move policy
src/chess/     chess.js helpers: positions, threat analysis, eval conversion,
               post-game analysis, PV-to-English gloss
src/hooks/     useGame - the engine/turn loop and all game state
src/components/ setup screen, board, eval bar, commentary, history, summary
scripts/       engine sync/chunking, position validation, browser smoke test
engine-parts/  the full NNUE engine, committed as 40 MiB chunks + sha256 manifest
```

## Verification

- `npm run test` — 19 unit tests. The policy tests assert the fastest-mate override, that
  a real threefold repetition is refused when level but accepted when losing, that the
  pressure tie-break prefers forcing moves, and critically that it **never** trades
  evaluation for aggression. The UCI parser is tested against real `info` lines including
  mate scores, WDL and bound flags.
- `npm run verify:positions` — validates the whole position library.
- `npm run smoke` — builds, serves `dist/` in-process with the isolation headers, and
  drives a real headless browser: boots the engine, seeds the eval bar, plays a typed
  algebraic move and a click move, checks the engine's reply is legal via chess.js,
  verifies underpromotion (`bxc8=N`), the insufficient-material draw, the board flip, and
  that the engine finds a forced mate (`Ra8#`). When the full NNUE build has been
  assembled, it also boots that 94 MiB engine and checks it plays a legal move — which is
  what proves the chunk reassembly produced a working binary.

## Notes on accuracy scoring

Win probability uses the logistic centipawn mapping published by
[Lichess](https://lichess.org/page/accuracy), preferring the engine's own `UCI_ShowWDL`
output when available. Per-move accuracy uses Lichess's win-percentage model. The
"biggest blunder" is the user move with the largest drop in win probability, reported
alongside the engine's main line at that point.

Engine evaluations are self-reported, so only the human player's accuracy is shown.

## Licensing

Stockfish is **GPLv3**. This project ships the Stockfish WASM binaries as static assets
via the [`stockfish`](https://github.com/nmrugg/stockfish.js) npm package (Stockfish.js by
Nathan Rugg / Chess.com). If you distribute a build of this app, review your GPL
obligations for the bundled engine.

Built with [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause) and
[react-chessboard](https://github.com/Clariity/react-chessboard) (MIT).
