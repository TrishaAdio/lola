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
npm run verify  # unit tests, position validation, and three real-browser suites
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

## Move selection: Stockfish plus a strategic layer

Stockfish provides tactical ground-truth; the strategic layer re-ranks near-equal options
to produce human-like, plan-driven play rather than pure engine-optimal play. Stockfish's
search is never modified: it returns its top 5 lines (MultiPV 5) and
`src/engine/policy.ts` chooses between them.

Tactics always win:

- a forced mate is converted by the shortest line; when being mated, the longest defence
- a candidate more than **30 cp or 3 win-%** worse than Stockfish's best is never played,
  or **45 cp** when it stops the opponent's best idea
- no deviation may leave material en prise that Stockfish's #1 did not
- no voluntary draws unless genuinely losing, in which case it steers for them

Among the surviving candidates, a capped strategic score re-ranks
(`src/engine/strategy/`):

- **king safety trajectory**: pawn shield, attackers on the king zone, read at the end of
  each candidate's line rather than just after the move
- **piece activity and space**: safe mobility, central control, outposts, open files
- **pawn structure**: isolated, doubled and backward pawns, holes in front of the king
- **plan continuity**: a plan (pawn storm, minority attack, central break, simplify when
  winning, consolidate when worse) is adopted once a structure appears and kept while it
  holds; moves that advance it get a bonus
- **prophylaxis**: a null-move search asks what the opponent would do with a free move;
  a candidate that makes that idea illegal or losing is rewarded

Every decision is logged to the dev console, with a per-candidate breakdown, and to
`window.__strategy` (`__strategy.summary()` gives the divergence rate). The commentary
panel shows the plan, the opponent's idea, and when and why the move differs from
Stockfish's #1. Turn the layer off in setup for plain Stockfish best-move play. Practice
mode is the only place strength is actually reduced.

## Rules

Chess.com's ruleset, in `src/chess/rules.ts`:

- **Insufficient material** follows USCF, as Chess.com does: a draw only when mate cannot
  be *forced*. So K+N+N v K is a draw, even though FIDE plays on because a helpmate exists.
  chess.js's own check misses this case.
- **Timeout vs insufficient material**: if the side with time left cannot force mate, a
  flag is a draw, not a loss. Chess.com's one exception, K+N+N, still wins on time.
- **Threefold repetition and the 50-move rule** are claims by default: a Claim draw /
  Play on prompt appears, and the game continues if you play on. Fivefold repetition and
  the 75-move rule end the game on their own so it can never run forever. The Automatic
  setting instead ends the game the moment they occur, which is what Chess.com's own
  online games do.
- **Draw offers** stay open until the engine answers or moves (moving declines). The
  engine accepts only when genuinely losing (WDL loss >= 60%) or in a dead draw.
- **Castling**: drag or click the king two squares or onto its own rook, or type
  `O-O`, `0-0`, `o-o`. Castling rights a pasted FEN claims but the board cannot support
  are removed and reported.
- **Promotion** always asks for the piece, including when typed as `b8` without one.
- The engine never resigns unless "Engine may resign" is switched on.

## Look, motion and sound

See [ASSETS.md](ASSETS.md) for sources and licences.

- **Pieces**: the Cburnett geometry (GPLv2+), restyled and themed through CSS variables.
  No emoji or Unicode chess glyphs are used anywhere.
- **Board themes**: Slate, Oxblood, Glacier, with legibility enforced by tests.
- **Icons**: Lucide only.
- **Motion**: pieces slide with an ease-out cubic over 190 ms; captured pieces shrink and
  fade; a checked king gets a slowly breathing glow, a mated one a steady ring. All of it
  switches off under `prefers-reduced-motion`.
- **Sound**: one synthesised material (boxwood on felt, a wooden bar) for move, capture,
  castle, check, mate, game end, illegal move and the aura cue, loudness-matched. Master
  mute, and separate switches for board sounds, aura sounds and aura lines.
- **Game over**: the summary does not cover the board at once. The final position stays
  up with a result strip and a countdown (`GAME_OVER_REVIEW_SECONDS` in `src/config.ts`,
  default 60); Continue, Enter/Escape, or a click outside the board opens it early.

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
src/engine/     UCI client, engine tiers, move policy; strategy/ holds the strategic layer
src/chess/      rules, move resolution, positions, threats, analysis, PV gloss
src/aura/       Tactics Aura trigger table
src/audio/      sound playback and the move-to-sound mapping
src/pieces/     the themed piece set (geometry generated from assets/pieces/)
src/theme/      board themes
src/hooks/      useGame (engine and turn loop), clock, game-over review
src/components/ setup screen, board, commentary, history, summary, settings
src/config.ts   timing constants
scripts/        engine sync/chunking, piece and sound builds, browser test suites
engine-parts/   the full NNUE engine, committed as 40 MiB chunks + sha256 manifest
```

## Verification

- `npm run test`: 142 unit tests, covering the policy's tactical ceilings and each
  strategic term, the Chess.com rules including the USCF and timeout cases, castling
  through every input path, the aura trigger table, theme contrast, and the sound files'
  loudness and peaks.
- `npm run verify:positions`: the whole position library is legal and playable.
- `npm run smoke`: engine boot, typed and clicked moves, underpromotion, flip, forced
  mate, and the full NNUE build when assembled.
- `scripts/e2e-rules.mjs`: castling by 10 input paths for both colours, 50-move claims in
  both modes, draw offers declined and accepted by evaluation, and 14 moves of real play
  checking the strategic layer diverges from Stockfish's #1 within its cost cap.
- `scripts/e2e-experience.mjs`: piece set and icon audit, theme switching and
  persistence, move easing, capture fade, check glow, reduced motion, every sound switch,
  the aura HUD and its mute, and the game-over review (strip, countdown, board clicks do
  not skip, Continue / Escape / click-anywhere, and auto-advance at 60 s).

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

The piece geometry is Cburnett (GPLv2+); see [ASSETS.md](ASSETS.md).

Built with [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause),
[react-chessboard](https://github.com/Clariity/react-chessboard) (MIT) and
[Lucide](https://lucide.dev) (ISC).
