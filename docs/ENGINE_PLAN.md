# Lola Engine: Build Plan

The goal is an original chess engine, written from scratch, that replaces Stockfish in this
app and then beats Stockfish head to head. It uses no Stockfish code, no Stockfish nets,
no Stockfish-generated data, and no Lc0 nets or data.

## 1. The finish line

Lola beats the latest Stockfish in a long match (1,000+ games from paired openings) at
the same time control on the same machine, with a statistically significant score above
50%.

Stockfish has lost before, and how it lost is the blueprint:

- Leela Chess Zero won the TCEC superfinal against Stockfish in Seasons
  [15](https://en.wikipedia.org/wiki/TCEC_Season_15) and
  [17](https://en.wikipedia.org/wiki/TCEC_Season_17).
- AlphaZero beat Stockfish 8 over
  [1,000 games (+155 -6)](https://www.chess.com/news/view/updated-alphazero-crushes-stockfish-in-new-1-000-game-match)
  after [self-play on 5,000 TPUs](https://en.wikipedia.org/wiki/AlphaZero).
- Stockfish won the [Season 26 superfinal](https://lczero.org/watch) (2024), but Leela
  still won 17 of the 100 games. The measured gap was about 49 Elo.
- Stockfish's default nets have been trained on
  [data converted from Leela's self-play games](https://robotmoon.com/nnue-training-data/)
  since 2022.

Every win came from a large neural network on GPUs trained by self-play. Stockfish's
current strength is Leela's data plus its CPU search. Lola builds both halves with its
own code and data, then combines them (sections 4.6 and 4.7).

Every phase ends with a measured Elo number, not a guess.

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
| M6 Beat Stockfish | the section 1 match, won | above Stockfish |

M1 to M3 take months. M4 and M5 take sustained compute. M6 adds Lola-Zero and the hybrid
(sections 4.6 and 4.7) on top.

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
- use the player's GPU through **WebGPU** when available (section 4.7). Stockfish's
  WebAssembly build runs on the CPU only.

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
zero/                       Lola-Zero: transformer net, MCTS self-play, CUDA + WebGPU inference
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

### 4.6 Lola-Zero: the GPU engine
This is the engine type that has beaten Stockfish. It has three jobs: produce
Leela-quality training data of our own, be the GPU half of the hybrid, and play GPU
matches on its own.

- **network:** a transformer over the 64 squares with policy, WDL value and moves-left
  heads. It starts small (8 to 10 layers) and grows as data allows.
- **bootstrap:** first trained on Lola's own self-play games, which skips the expensive
  random-play phase. After that, pure self-play reinforcement learning.
- **self-play:** PUCT tree search at 400 to 800 visits per move, root noise, early-move
  temperature, and KataGo-style efficiency tricks (playout-cap randomization, auxiliary
  targets).
- **inference:** CUDA natively, WebGPU in the browser, fp16/int8.
- **data for Lola:** every self-play position is labelled with Lola-Zero's search value.
  Lola's NNUE trains on it, the role Leela's data plays for Stockfish.
- **gate:** a new network is promoted only if it beats the current one by SPRT.

### 4.7 The hybrid
Stockfish uses only the CPU, and most machines that run it have a GPU sitting idle. The
hybrid uses both.

- CPU threads run Lola's alpha-beta search. A GPU thread runs Lola-Zero's network on
  batched requests.
- The search posts positions (root, PV nodes, high-depth nodes) to a queue and reads
  results from a hash-keyed cache. It never waits on the GPU, so its speed does not drop.
- Where a result is available, the policy head drives move ordering and reductions. The
  value head is blended with the NNUE eval, with a weight tuned by SPSA.
- The same design runs natively (CUDA) and in the browser (WebGPU), where Stockfish's
  WebAssembly build is CPU-only.
- **gate:** the hybrid beats pure Lola at equal wall time on a CPU+GPU machine. Then it
  plays the section 1 match against Stockfish on that same machine.

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

**Phase 6: Lola-Zero and the hybrid (year 2 onward)**
- Lola-Zero pipeline (section 4.6): bootstrap networks from Lola's games, then self-play
  RL with the promotion gate
- Lola's NNUE trained on Lola-Zero-labelled data must beat the NNUE trained on Lola-only
  data by SPRT
- the hybrid (section 4.7) must beat pure Lola at equal wall time
- further edges, each SPRT-gated: threat-aware NNUE inputs, larger layers made affordable
  by sparsity-aware inference, learned pruning margins, multi-objective training from
  deep rescoring, and a match opening repertoire aimed at positions Lola scores well in
- *gate:* M6, the Stockfish match

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

## 7. Compute and cost

Priced at the marketplace rate for a 16-core + RTX 3090 box (about $0.17/h).

| Stage | Goal | Compute | Rough cost |
| --- | --- | --- | --- |
| Months 0 to 3 | M1, M2 | this sandbox + 1 rented box part-time | a few hundred dollars |
| Months 3 to 12 | M3, M4 | ~10 boxes | ~$10k |
| Year 2 | M5, Lola-Zero running | ~30 boxes | ~$45k |
| Year 3 | M6 | ~100 boxes (~1,600 cores, 100 GPUs) | ~$150k |

- **Reference point:** Stockfish's test farm played about
  [241M long-time-control games in 2024](https://huggingface.co/datasets/official-stockfish/fishtest_pgns)
  at [about 3 core-minutes each](https://official-stockfish.github.io/docs/fishtest-wiki/Fishtest-FAQ.html).
  That is roughly 1,400 cores around the clock for long tests alone. The year-3 stage
  matches it.
- **Volunteers cut the bill sharply.** Stockfish and Leela get most of their compute
  from donated machines. Open-sourcing Lola with a worker program anyone can run is the
  biggest cost lever.
- **Storage:** ~20 to 40 bytes per packed position, so billions of positions take
  hundreds of GB.

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
| GPU calls slow the hybrid's search | asynchronous batched requests; the search never waits on the GPU |
| Compute runs out | volunteer workers; every phase is useful on its own; the app keeps Stockfish until Lola surpasses it |

## 10. First concrete steps

1. Create `engine/` Cargo workspace and CI.
2. Bitboards, magics, movegen, perft suite to exact counts.
3. UCI loop with Stockfish-compatible `info` output; wasm single-thread build loaded by
   the existing worker code as a new tier.
4. Negamax + alpha-beta + material eval, playing in the app end to end.
5. SPRT runner, then start adding search features one test at a time.
