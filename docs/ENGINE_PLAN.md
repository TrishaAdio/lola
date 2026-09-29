# Lola Engine: Build Plan

The goal is an original chess engine, written from scratch, that replaces Stockfish in this
app and gets as close to the top of the rating lists as engineering and compute allow. It
uses no Stockfish code, no Stockfish nets, no Stockfish-generated data, and no Lc0 nets or
data.

## 1. Reality check on "4500 Elo"

The target number needs defining before we start, because as a literal goal it cannot be
reached, and the reason affects how we measure progress.

- **Elo only means something relative to a pool.** The top engines sit around 3600 to 3700
  on the CCRL-style lists. The exact figure depends on the list, the time control and the
  opening book. No list has a 4500 player to measure against.
- **Chess at this level is mostly draws.** A rating gap of D implies an expected score of
  `1 / (1 + 10^(-D/400))`. Being 900 Elo above Stockfish means scoring about **99.5%**
  against it. Stockfish draws itself from the standard start nearly every time at longer
  time controls, which is why TCEC forces unbalanced openings. An engine that "crushes"
  Stockfish from balanced positions is ruled out by how drawish the game is, not by weak
  engineering.
- **So "4500" becomes a set of measurable targets** (section 2). The top one is "beats
  the current Stockfish in a statistically significant head-to-head match". Nobody
  outside the Stockfish project has done that in years. It is a multi-year stretch goal.

Everything below is designed so each phase ends with a measured Elo number, not a guess.

## 2. Targets

Ratings are measured against an anchored gauntlet of open-source engines with known
ratings. Those engines are only opponents for measurement. None of their code or data
goes into Lola.

| Milestone | Definition | Rough Elo (CCRL-like scale) |
| --- | --- | --- |
| M1 Correct | perft-exact movegen, legal UCI, plays full games in the browser | ~1800 |
| M2 Classical | alpha-beta + hand-crafted eval, tuned | 2600 to 2900 |
| M3 First net | NNUE trained only on Lola self-play data | 3100 to 3300 |
| M4 Flywheel | iterated data/net generations, full search feature set | 3400 to 3550 |
| M5 Top tier | parity-range with the strongest engines | 3600+ |
| M6 Stretch | positive, SPRT-confirmed score vs current Stockfish | above Stockfish |

M1 to M3 are realistic in months. M4 and M5 take sustained compute and discipline. M6 is
the research frontier.

## 3. Constraints set by this app

The engine is a drop-in replacement for the Stockfish worker (`src/engine/uci.ts`,
`src/engine/tiers.ts`), so it must:

- run as **WebAssembly in a Web Worker**, receive UCI strings via `postMessage`, and emit
  UCI lines back
- support `MultiPV` (the strategy layer asks for 5 lines), `UCI_ShowWDL` (draw offers and
  resign logic read `wdl`), and `go depth | movetime | nodes`
- emit `info depth seldepth nodes score cp|mate wdl multipv pv` in Stockfish's format so
  `parseInfo` works unchanged
- ship a **single-threaded build** that runs without cross-origin isolation, and a
  **threaded build** (wasm threads + `SharedArrayBuffer`) for isolated pages
- run on **wasm `simd128`** only: no AVX2, AVX-512, PEXT or VNNI. This rules out PEXT
  sliders and makes NNUE inference roughly 2 to 3x slower than native, so the net
  architecture must be chosen for 128-bit SIMD.
- keep downloads sane: a **lite net** (at most ~2 MB, the current default experience) and a
  **full net** (target at most ~40 MB, fits the existing chunking scheme)
- keep strength-limiting (`Skill Level`, `UCI_LimitStrength`) for Practice mode only

The same codebase also builds **natively** (AVX2/AVX-512). All training, data generation
and testing runs natively, where it is 10 to 50x cheaper than in the browser.

## 4. Architecture

**Language: Rust.** It gives native speed, first-class `wasm32` + `simd128` targets,
`std::arch` intrinsics for native SIMD, safe concurrency for Lazy SMP, and one toolchain
for engine, datagen and tools.

```
engine/                     Cargo workspace
  crates/core/              board, bitboards, movegen, make/unmake, zobrist, SEE
  crates/eval/              HCE (bootstrap) + NNUE inference (scalar / simd128 / avx2 / avx512)
  crates/search/            iterative deepening, PVS, pruning, TT, histories, SMP, time mgmt
  crates/uci/               protocol, options, info formatting (Stockfish-compatible)
  crates/datagen/           self-play position generator, binary packed format
  crates/tools/             perft, bench, EPD suites, net converter, SPSA client
  bins/lola/                native UCI binary
  bins/lola-wasm/           wasm entry + worker glue (single and threaded)
trainer/                    PyTorch NNUE trainer (our own), quantizer, exporter
testing/                    SPRT runner, gauntlet configs, opening books (our own)
```

### 4.1 Board and move generation
- 64-bit bitboards, 8x8 mailbox mirror for O(1) piece lookup
- **fancy magic bitboards** for sliders (portable to wasm), precomputed attack tables
- pseudo-legal staged generation (TT move, good captures, killers, quiets, bad captures)
  with fast legality checks via pin masks and checkers
- incremental Zobrist keys for position, pawns and non-pawn material (the latter two feed
  correction histories)
- Chess960 support from day one: it costs little now and a lot to add later
- **exit test:** perft matches reference counts on a 100+ position suite (including
  en-passant pins, castling through check, promotions), at no less than 150 Mnps perft
  natively with bulk counting

### 4.2 Search
Built up incrementally. Every item lands behind an SPRT test (section 6).

- iterative deepening, aspiration windows, principal variation search
- transposition table: 10-byte entries in 3-entry clusters, aging, depth/bound
  replacement, prefetch natively
- quiescence with SEE pruning and delta pruning; check evasions in qsearch
- pruning and reductions: reverse futility, null-move with verification at high depth,
  razoring, futility, late move pruning, SEE-based pruning of quiets and captures,
  ProbCut, **log-formula LMR** adjusted by history, PV-node, improving and cut-node flags
- extensions: check, **singular extensions** with double/triple extensions and negative
  extensions, multicut
- move ordering: butterfly history, capture history, 1-ply and 2-ply continuation
  histories, killers, counter-moves, and a threat-aware history split (from-square
  attacked / to-square attacked)
- **correction history**: pawn-structure, material and continuation-keyed corrections
  applied to the static eval
- mate distance pruning, upcoming-repetition detection (cuckoo tables), 50-move scaling
  of eval
- **Lazy SMP** on shared TT for the threaded build
- time management: base allocation by moves-to-go/increment, scaled at runtime by
  best-move stability, node share of the best move, and score drops
- MultiPV and `searchmoves` done properly (root move exclusion, per-line aspiration)

### 4.3 Evaluation, stage 1: HCE (bootstrap only)
A hand-crafted, tapered (midgame/endgame) evaluation: material, PSTs, mobility, pawn
structure, passed pawns, king safety, threats. Weights are fitted with **Texel tuning**
on positions from Lola's own games. Its only jobs are to reach M2 and to produce the
first generation of training data. It is retired once a net beats it.

### 4.4 Evaluation, stage 2: NNUE
- **inputs:** piece-square features relative to the side to move, **king buckets** (start
  with 4 to 8 buckets, mirrored horizontally so the king is always on files e to h),
  768 x buckets features per perspective
- **accumulator:** incrementally updated on make/unmake, lazily refreshed via a
  per-bucket "finny table" cache when the king changes bucket
- **layers:** feature transformer to hidden (lite: 256, full: 1024 to 1536), pairwise
  SCReLU/CReLU, then **output buckets by piece count** (8). Small dense layers after the
  FT are added only if SPRT shows they pay for themselves on simd128.
- **quantization:** int16 FT weights, int8/int16 dense layers, sized so the simd128
  inner loop has no widening bottleneck
- **WDL:** a fitted logistic model maps eval to win/draw/loss per material bucket,
  refitted after every net generation, so `UCI_ShowWDL` stays meaningful
- **trainer:** our own PyTorch trainer: sparse-input FT, blended loss
  `lambda * sigmoid(eval) + (1 - lambda) * game_result`, cosine LR, warm restarts,
  exports straight to the engine's binary format with a checksum header

### 4.5 Data flywheel (the actual moat)
Net quality is limited by data quality. Stronger engines usually have better data, not
cleverer code.

1. **Gen 0:** HCE Lola self-play at fixed nodes (for example 5k), with randomized
   openings (8 to 10 random plies plus our own book) and adjudication. Store FEN-equivalent
   packed records `{board, eval, result, ply}`.
2. **Filter:** drop positions in check, positions whose best move is a capture or
   promotion (not quiet), and positions with |eval| beyond a cap. Deduplicate by hash.
3. **Train net v1, SPRT vs HCE.** It must win clearly.
4. **Gen N+1:** self-play with net N at higher node counts. Train net N+1 on the new data,
   mixed with the best older data. Keep a net only if it passes SPRT.
5. **Scale:** grow hidden size and king buckets only when data volume supports it
   (roughly 1B+ positions for a 1024-wide net, several billion for larger).
6. **Rescoring:** re-evaluate old positions with a deeper search by the latest net.
   This is effectively distillation of search into eval.

Throughput estimate: at 5k nodes/move, one modern core yields on the order of 100 to
300 positions/s. A 64-core box gives roughly 0.5 to 1.5B positions per day. That is
enough to iterate a generation every few days.

## 5. Phased roadmap

Each phase has an exit gate. The next phase starts only after the gate passes.

**Phase 0: foundations (weeks 1 to 3)**
- workspace, CI (fmt, clippy, tests, perft suite, `bench` node-count determinism check)
- board, movegen, perft; UCI skeleton; random/material-only player
- wasm builds (single + threaded) producing a `lola.js` + `lola.wasm` pair matching the
  existing worker contract; first run inside the app
- SPRT runner and a small anchored gauntlet
- *gate:* perft-exact, deterministic `bench`, plays legal games in the browser

**Phase 1: classical engine (weeks 3 to 8)**
- PVS + TT + qsearch + move ordering, then pruning features one by one
- HCE plus Texel tuning
- time management, MultiPV, WDL output
- *gate:* M2 measured on the gauntlet

**Phase 2: first net (weeks 8 to 14)**
- datagen crate, packed format, filtering
- PyTorch trainer, quantizer, exporter; scalar + simd128 + AVX2 inference with
  bit-exact agreement tests across all three
- *gate:* net v1 beats HCE by SPRT; M3 on the gauntlet

**Phase 3: search depth (months 4 to 8, in parallel with Phase 4)**
- singular extensions, correction histories, continuation histories, ProbCut, cuckoo
  repetition, threat-aware ordering
- **SPSA tuning** of every search constant at scale (hundreds of thousands of games)
- Lazy SMP scaling tests (1, 2, 4, 8 threads)

**Phase 4: flywheel (month 5 onward)**
- 1 generation every 3 to 7 days, net growth as data allows, lite and full nets trained
  from the same data
- *gate:* M4, then M5

**Phase 5: app integration (can start after Phase 1)**
- add `lola` / `lola-lite` tiers in `src/engine/tiers.ts`, sync script for the Lola
  builds, keep Stockfish selectable until Lola is stronger in the app
- run the existing `smoke`, `e2e-rules`, `e2e-experience` suites against Lola
- once Lola passes Stockfish-lite in-browser at app time controls, make it the default;
  once it passes full Stockfish, remove Stockfish and the GPL assets (`engine-parts/`,
  the `stockfish` dependency)

**Phase 6: research track toward M6 (ongoing)**
Speculative ideas, each gated by SPRT and dropped if it fails:
- a **small policy network** for move ordering at high-depth nodes only, where its cost
  is amortized
- larger post-FT layers made affordable by sparsity-aware inference (skip zero blocks
  after the activation)
- multi-objective training: eval + WDL + "search disagreement" targets from deep
  rescoring
- learned LMR/pruning margins (a tiny model on node features instead of hand formulas)
- opening play tuned for winning chances against draw-seeking opponents, since at the
  top the Elo comes from unbalanced positions

## 6. Testing discipline

This is what separates a 3600 engine from a 3000 one. It is non-negotiable.

- **SPRT for every functional change.** STC `8+0.08` with bounds `[0, 2]` Elo for gainers
  and `[-3, 0]` for simplifications, then LTC `40+0.4` confirmation for anything touching
  search. Pentanomial statistics, paired openings.
- **Non-functional changes** must keep `bench` node count identical.
- **Own opening book:** balanced (|eval| small) positions generated from Lola's own
  analysis, so no external engine's evaluation enters the pipeline.
- **Test infrastructure:** a distributed worker fleet (OpenBench-style: a server hands out
  test jobs, cheap cloud or donated cores run games). Game runner: our own, or fastchess
  as a tool.
- **Regression gauntlet** weekly against the anchored pool to keep the Elo curve honest.
- **Browser benchmark**: nps and depth-at-1s in Chrome, Firefox and Safari for every
  release candidate, since native gains do not always carry over to wasm.

## 7. Compute budget (order of magnitude)

| Workload | Resource |
| --- | --- |
| SPRT testing | 64 to 256 CPU cores continuously once past M2 |
| Datagen | 64+ cores, bursts to several hundred per generation |
| Training | 1 modern GPU; a 1024-wide net trains in hours to a day |
| Storage | ~20 to 40 bytes/position packed; billions of positions = tens to hundreds of GB |

Without that compute, the realistic ceiling is roughly M3/M4. Nothing in the design
changes, only the pace.

## 8. What "our own" means (originality rules)

- no code copied or translated from Stockfish or any other engine; published ideas
  (papers, CPW, well-known techniques like LMR or NNUE itself) are fair game
- no nets, weights or training data produced by other engines
- other engines are allowed **only** as opponents in measurement gauntlets
- tools (Rust, PyTorch, a game runner) are fine

This keeps Lola licensable on our own terms and removes the GPL obligation the README
currently warns about.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Subtle movegen/TT bugs silently cost Elo | perft suite, `bench` determinism, debug-build asserts, hash-collision stress tests |
| Self-play data collapses into narrow styles | randomized openings, own book diversity, mixing generations |
| wasm speed gap erases native gains | browser nps in CI; net sizes chosen for simd128 |
| Overfitting to STC | LTC confirmation for search changes |
| Compute runs out | phases are useful on their own; the app keeps Stockfish until Lola surpasses it |

## 10. First concrete steps

1. Create `engine/` Cargo workspace and CI.
2. Bitboards, magics, movegen, perft suite to exact counts.
3. UCI loop with Stockfish-compatible `info` output; wasm single-thread build loaded by
   the existing worker code as a new tier.
4. Negamax + alpha-beta + material eval, playing in the app end to end.
5. SPRT runner, then start adding search features one test at a time.
