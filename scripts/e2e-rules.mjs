/**
 * End-to-end checks for castling, draw rules, draw offers and the strategic layer, all
 * through the real UI against the real engine.
 *
 * Usage: npm run build && node scripts/e2e-rules.mjs
 */
import { Chess } from "chess.js";
import {
  SHOTS,
  clickMove,
  drag,
  history,
  launch,
  reporter,
  serve,
  startGame,
  typeMove,
  waitForPlies,
  waitForUserTurn,
} from "./lib/harness.mjs";

const r = reporter();

/** Runs one scenario; a throw fails that scenario, names it, and the suite continues. */
async function scenario(name, fn) {
  try {
    await fn();
  } catch (err) {
    r.fail(`${name} threw: ${err.message.split("\n")[0]}`);
    for (const p of browser.contexts().flatMap((c) => c.pages())) {
      await p.screenshot({ path: `${SHOTS}/e2e-error-${name.replace(/\W+/g, "-")}.png`, fullPage: true }).catch(() => {});
      await p.close().catch(() => {});
    }
  }
}
const server = await serve();
const browser = await launch();
const errors = [];

// Both sides may castle either way.
const CASTLE_W = "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 0 1";
const CASTLE_B = CASTLE_W.replace(" w ", " b ");

try {
  // ---- castling through every input path, both colours ---------------------------
  r.info("castling");
  const castles = [
    ["White drags e1-g1", CASTLE_W, "White", (p) => drag(p, "e1", "g1"), "O-O"],
    ["White drags e1-c1", CASTLE_W, "White", (p) => drag(p, "e1", "c1"), "O-O-O"],
    ["White clicks e1 then g1", CASTLE_W, "White", (p) => clickMove(p, "e1", "g1"), "O-O"],
    ["White drops the king on the h1 rook", CASTLE_W, "White", (p) => drag(p, "e1", "h1"), "O-O"],
    ["White clicks the king then the a1 rook", CASTLE_W, "White", (p) => clickMove(p, "e1", "a1"), "O-O-O"],
    ["White types o-o", CASTLE_W, "White", (p) => typeMove(p, "o-o"), "O-O"],
    ["White types 0-0-0", CASTLE_W, "White", (p) => typeMove(p, "0-0-0"), "O-O-O"],
    ["Black drags e8-g8", CASTLE_B, "Black", (p) => drag(p, "e8", "g8"), "O-O"],
    ["Black drags e8-c8", CASTLE_B, "Black", (p) => drag(p, "e8", "c8"), "O-O-O"],
    ["Black drops the king on the a8 rook", CASTLE_B, "Black", (p) => drag(p, "e8", "a8"), "O-O-O"],
  ];
  for (const [label, fen, side, act, want] of castles) await scenario(label, async () => {
    const page = await startGame(browser, server.base, { fen, side, errors });
    await act(page);
    // Wait for any non-empty cell: when Black starts, White's first cell is blank.
    const got = await waitForPlies(page, 1, 10000)
      .then(() => history(page))
      .catch(() => []);
    if (got[0] === want) r.pass(`${label} -> ${want}`);
    else r.fail(`${label}: expected ${want}, history ${JSON.stringify(got)}`);
    await page.close();
  });

  // Fresh game, scripted opening: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O. The engine picks
  // Black's moves, so type White's and accept whatever legal replies come back; castling
  // must succeed on move 4 whenever it is legal.
  await scenario("fresh-game castling", async () => {
    const page = await startGame(browser, server.base, { errors });
    for (const [i, mv] of ["e4", "Nf3", "Bc4"].entries()) {
      const pos = new Chess();
      for (const m of await history(page)) pos.move(m);
      if (!pos.moves().includes(mv)) {
        r.info(`scripted ${mv} not legal after ${pos.history().join(" ")}; stopping the script there`);
        break;
      }
      await typeMove(page, mv);
      await waitForPlies(page, (i + 1) * 2);
      await waitForUserTurn(page);
    }
    const before = await history(page);
    const probe = new Chess();
    for (const m of before) probe.move(m);
    if (!probe.moves().includes("O-O")) {
      r.info(`fresh-game O-O not legal after ${before.join(" ")}; skipped`);
    } else {
      await drag(page, "e1", "g1");
      await waitForPlies(page, 7, 20000).catch(() => {});
      const after = await history(page);
      if (after[6] === "O-O") r.pass(`fresh game: ${after.slice(0, 7).join(" ")}`);
      else r.fail(`fresh game castling failed: ${after.join(" ")}`);
    }
    await page.close();
  });

  // ---- custom FEN with impossible castling rights --------------------------------
  await scenario("impossible castling rights", async () => {
    const page = await browser.newPage();
    await page.goto(server.base, { waitUntil: "networkidle" });
    await page.click(".tab:has-text('Custom FEN')");
    await page.fill("#fen", "4k3/4p3/8/8/8/8/4P3/4K3 w KQ - 0 1");
    const note = await page.waitForSelector("[data-testid=castling-removed]", { timeout: 5000 }).then((e) => e.textContent()).catch(() => null);
    if (note?.includes("KQ")) r.pass("impossible castling rights are removed and reported");
    else r.fail(`impossible castling rights not reported (${note})`);
    await page.close();
  });

  // ---- 50-move rule: claimable, not automatic -------------------------------------
  r.info("draw claims");
  const FIFTY = "r3k3/pp3ppp/8/8/8/8/PP3PPP/4K2R w - - 99 60";
  await scenario("fifty-move claim", async () => {
    const page = await startGame(browser, server.base, { fen: FIFTY, errors });
    await drag(page, "e1", "d2");
    const banner = await page.waitForSelector(".claim", { timeout: 10000 }).then(() => true).catch(() => false);
    if (banner) r.pass("reaching 50 moves offers a claim instead of ending the game");
    else r.fail("no claim banner at the 50-move point");
    const over = await page.locator(".modal .summary__head, .review").count();
    if (over === 0) r.pass("game did not end automatically at 50 moves");
    else r.fail("game ended automatically at 50 moves");
    await page.click(".claim .btn--claim");
    const detail = await page.waitForFunction(() => /50-move/.test(document.body.innerText), null, { timeout: 10000 }).then(() => true).catch(() => false);
    if (detail) r.pass("claiming ends the game as a 50-move draw");
    else r.fail("claim did not end the game");
    await page.screenshot({ path: `${SHOTS}/e2e-fifty-claim.png`, fullPage: true });
    await page.close();
  });
  await scenario("fifty-move play on", async () => {
    const page = await startGame(browser, server.base, { fen: FIFTY, errors });
    await drag(page, "e1", "d2");
    await page.waitForSelector(".claim", { timeout: 10000 });
    await page.click(".claim .btn--ghost:has-text('Play on')");
    await waitForPlies(page, 2);
    await waitForUserTurn(page);
    const header = await page.locator(".play__actions .btn--claim").count();
    if (header === 1) r.pass("after playing on, the claim stays available on your turn");
    else r.fail("claim button missing after playing on");
    await page.close();
  });
  await scenario("fifty-move automatic", async () => {
    // Automatic mode: the same position ends the game immediately, like Chess.com.
    const page = await startGame(browser, server.base, {
      fen: FIFTY,
      errors,
      configure: (p) => p.click(".segmented__item:has-text('Automatic')"),
    });
    await drag(page, "e1", "d2");
    const ended = await page.waitForFunction(() => /50-move/.test(document.body.innerText), null, { timeout: 10000 }).then(() => true).catch(() => false);
    if (ended) r.pass("automatic mode ends the game at 50 moves");
    else r.fail("automatic mode did not end the game");
    await page.close();
  });

  // ---- draw offers routed through evaluation ---------------------------------------
  r.info("draw offers");
  await scenario("offer declined", async () => {
    // Balanced opening: the engine must decline by playing on.
    const page = await startGame(browser, server.base, { errors });
    await page.click(".btn:has-text('Offer draw')");
    await typeMove(page, "e4");
    await waitForPlies(page, 2);
    const note = await page.waitForSelector("[data-testid=draw-offer]", { timeout: 10000 }).then((e) => e.textContent());
    if (/declined/.test(note)) r.pass("engine declines a draw offer in a balanced position");
    else r.fail(`unexpected offer state: ${note}`);
    await page.close();
  });
  await scenario("offer accepted", async () => {
    // Engine (Black) has a bare king against K+Q: it is lost and should accept.
    const page = await startGame(browser, server.base, { fen: "4k3/8/8/8/8/8/3Q4/4K3 w - - 0 1", errors });
    await page.click(".btn:has-text('Offer draw')");
    await drag(page, "d2", "d4");
    const accepted = await page.waitForFunction(() => /Draw agreed|Agreement \u2014 Draw/.test(document.body.innerText), null, { timeout: 60000 }).then(() => true).catch(() => false);
    if (accepted) r.pass("engine accepts a draw offer when it is genuinely losing");
    else r.fail("engine did not accept a draw offer in a lost position");
    await page.close();
  });

  // ---- strategic layer diverges from Stockfish #1 in real play --------------------
  r.info("strategic layer");
  await scenario("strategic divergence", async () => {
    const page = await startGame(browser, server.base, { errors });
    let played = 0;
    for (let turn = 0; turn < 14; turn++) {
      const plies = (await history(page)).length;
      // Play the reply the engine itself expects - sensible, non-blundering moves.
      let move = "e4";
      if (plies > 0) {
        const pv = (await page.textContent(".commentary__pv").catch(() => "")) ?? "";
        const sans = pv.split(/\s+/).map((t) => t.replace(/^\d+\.+/, "")).filter(Boolean);
        move = sans[1];
      }
      const check = new Chess();
      for (const m of await history(page)) check.move(m);
      if (!move || !check.moves().includes(move)) move = check.moves()[0];
      if (!move || check.isGameOver()) break;
      await typeMove(page, move);
      await waitForPlies(page, plies + 2).catch(() => {});
      if (await page.locator(".status:has-text('Your move')").count() === 0) {
        await waitForUserTurn(page, 60000).catch(() => {});
      }
      played++;
    }
    const summary = await page.evaluate(() => window.__strategy?.summary());
    const log = await page.evaluate(() => window.__strategy?.log ?? []);
    r.info(`engine decisions: ${JSON.stringify(summary)}`);
    for (const e of log.filter((x) => x.diverged)) {
      r.info(`  ply ${e.ply}: Stockfish ${e.stockfishBest} -> played ${e.played} (${e.reason}, -${e.costCp}cp)${e.plan ? ` plan: ${e.plan}` : ""}`);
    }
    if (!summary || summary.decisions < 10) r.fail(`too few engine decisions logged (${summary?.decisions})`);
    else r.pass(`__strategy logged ${summary.decisions} decisions with per-candidate breakdowns`);
    if (summary && summary.diverged > 0) r.pass(`strategic layer diverged from Stockfish #1 ${summary.diverged}x in ${summary.decisions} moves`);
    else r.fail("strategic layer never diverged from Stockfish #1");
    const worst = Math.max(0, ...log.map((e) => e.costCp));
    if (worst <= 45) r.pass(`largest eval cost of any deviation: ${worst}cp (cap 45)`);
    else r.fail(`a deviation cost ${worst}cp, above the 45cp cap`);
    const divergedUi = await page.locator("[data-testid=diverged]").count();
    r.info(`divergence note currently shown in commentary: ${divergedUi > 0}`);
    await page.screenshot({ path: `${SHOTS}/e2e-strategy.png`, fullPage: true });
    await page.close();
  });
} catch (err) {
  r.fail(`e2e threw: ${err.message}`);
} finally {
  await browser.close();
  await server.close();
}

if (errors.length) {
  for (const e of [...new Set(errors)].slice(0, 8)) r.fail(`console: ${e}`);
} else {
  r.pass("no console errors");
}
console.log(r.failed ? `\nE2E RULES FAILED (${r.failed})` : "\nE2E RULES PASSED");
process.exit(r.failed ? 1 : 0);
