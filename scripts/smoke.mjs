/**
 * End-to-end smoke test in a real browser.
 *
 * Verifies the things a passing build cannot: that the WASM engine boots in a Web Worker,
 * speaks UCI, and actually answers a human move with a legal move of its own.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { Chess } from "chess.js";

const SHOTS = "/projects/sandbox/.kiro/artifacts/screenshots";
mkdirSync(SHOTS, { recursive: true });

const DIST = path.resolve(import.meta.dirname, "..", "dist");
if (!existsSync(DIST)) {
  console.error("FAIL  dist/ not found - run `npm run build` first.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/**
 * Static server for dist/, with the cross-origin isolation headers the multi-threaded
 * engine build needs. Serving in-process keeps the test self-contained.
 */
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let filePath = path.join(DIST, urlPath === "/" ? "index.html" : urlPath);

  // Keep traversal inside dist/, and fall back to the SPA entry point.
  if (!filePath.startsWith(DIST)) filePath = path.join(DIST, "index.html");
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, "index.html");
  }

  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Content-Type", MIME[path.extname(filePath)] ?? "application/octet-stream");
  res.setHeader("Content-Length", statSync(filePath).size);
  createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`info  serving ${DIST} at ${BASE}`);

const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exitCode = 1;
};
const pass = (msg) => console.log(`ok    ${msg}`);


/**
 * Waits until the app is genuinely accepting the user's move. The status text alone is
 * not enough: readiness is what enables the move input, so wait on that too.
 */
async function waitForUserTurn(page, timeout = 180000) {
  await page.waitForFunction(
    () => {
      const status = document.querySelector(".status")?.textContent ?? "";
      const input = document.querySelector(".moveinput input");
      return /Your move/.test(status) && !!input && !input.disabled;
    },
    null,
    { timeout },
  );
}

/** Clicks a square and waits until it is visibly selected, avoiding a race with React. */
async function selectSquare(page, square) {
  await page.click(`[data-square="${square}"]`);
  try {
    await page.waitForFunction(
      (sq) => {
        const inner = document.querySelector(`[data-square="${sq}"] div`);
        return !!inner && (inner.getAttribute("style") ?? "").includes("rgba(255, 214, 102");
      },
      square,
      { timeout: 10000 },
    );
  } catch (err) {
    const diag = await page.evaluate((sq) => {
      const el = document.querySelector(`[data-square="${sq}"]`);
      return {
        status: document.querySelector(".status")?.textContent?.trim(),
        meta: document.querySelector(".play__meta")?.textContent?.trim(),
        squareExists: !!el,
        innerStyle: el?.querySelector("div")?.getAttribute("style"),
        // Board orientation is visible from which rank sits in the first row.
        firstSquare: document.querySelector("[data-square]")?.getAttribute("data-square"),
        moveInputDisabled: document.querySelector(".moveinput input")?.disabled,
        occupied: [...document.querySelectorAll("[data-square]")]
          .filter((s) => s.querySelector("svg"))
          .map((s) => {
            const fill = getComputedStyle(s.querySelector("svg path")).fill;
            return `${s.getAttribute("data-square")}:${fill === "rgb(255, 255, 255)" ? "w" : "b"}`;
          })
          .join(","),
      };
    }, square);
    throw new Error(`${err.message}\n      diagnostics: ${JSON.stringify(diag)}`);
  }
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

try {
  await page.goto(BASE, { waitUntil: "networkidle" });

  // --- setup screen -----------------------------------------------------------------
  await page.waitForSelector(".setup__header h1", { timeout: 20000 });
  pass("setup screen rendered");

  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  console.log(`info  crossOriginIsolated=${isolated}`);

  // Confirm the position library rendered a realistic number of choices.
  await page.click(".tab:has-text('Library')");
  const chips = await page.locator(".chip").count();
  if (chips < 20) fail(`expected 20+ library positions, found ${chips}`);
  else pass(`library rendered ${chips} positions`);

  // Custom FEN validation should reject junk and accept a real FEN.
  await page.click(".tab:has-text('Custom FEN')");
  await page.fill("#fen", "not-a-fen");
  await page.waitForSelector(".note--bad", { timeout: 5000 });
  pass("invalid FEN rejected");
  await page.fill("#fen", "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3");
  await page.waitForSelector(".note--ok", { timeout: 5000 });
  pass("valid FEN accepted");

  // Chaos mode must produce a legal position.
  await page.click(".tab:has-text('Chaos')");
  await page.click(".btn--ghost");
  await page.waitForSelector(".fen-readout", { timeout: 5000 });
  const chaosFen = (await page.textContent(".fen-readout"))?.trim();
  try {
    const c = new Chess(chaosFen);
    if (c.isGameOver() || c.moves().length === 0) throw new Error("not playable");
    pass(`chaos position legal and playable: ${chaosFen}`);
  } catch (e) {
    fail(`chaos position invalid (${chaosFen}): ${e.message}`);
  }

  // --- start a standard game as White -----------------------------------------------
  await page.click(".tab:has-text('Standard')");
  await page.screenshot({ path: `${SHOTS}/01-setup.png`, fullPage: true });

  await page.click(".btn--primary");
  await page.waitForSelector(".play__grid", { timeout: 20000 });
  pass("play screen mounted");

  // The engine must reach a ready state and hand the move to the user.
  await waitForUserTurn(page);
  pass("engine booted and is waiting for the user");

  // Eval bar should have been seeded by the initial analysis search.
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".evalbar__label");
      return el && (el.textContent ?? "").trim() !== "\u2014";
    },
    null,
    { timeout: 60000 },
  );
  const seeded = (await page.textContent(".evalbar__label"))?.trim();
  pass(`eval bar seeded before the first move: ${seeded}`);

  // --- play a move by typing algebraic notation --------------------------------------
  await page.fill(".moveinput input", "e4");
  await page.click(".moveinput button");

  await page.waitForFunction(
    () => document.querySelectorAll(".history__move").length > 0,
    null,
    { timeout: 15000 },
  );
  const firstMove = (await page.locator(".history__move").first().textContent())?.trim();
  if (firstMove !== "e4") fail(`expected the user's move to be e4, got "${firstMove}"`);
  else pass("typed algebraic move accepted (e4)");

  // Thinking state must be visible rather than a frozen UI.
  const sawThinking = await page
    .waitForSelector(".status--thinking", { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (sawThinking) pass("engine thinking state surfaced in the UI");
  else console.log("warn  did not observe the thinking state (engine may have replied instantly)");

  // --- the engine must answer with a legal move --------------------------------------
  await page.waitForFunction(
    () => {
      const cells = [...document.querySelectorAll(".history__move")];
      return cells.filter((c) => (c.textContent ?? "").trim() !== "").length >= 2;
    },
    null,
    { timeout: 180000 },
  );

  const moves = (await page.locator(".history__move").allTextContents())
    .map((t) => t.trim())
    .filter(Boolean);
  const reply = moves[1];

  // Validate the engine's reply against chess.js independently of the app.
  const verify = new Chess();
  verify.move("e4");
  const legalReplies = verify.moves();
  if (!legalReplies.includes(reply)) {
    fail(`engine reply "${reply}" is not a legal response to e4`);
  } else {
    pass(`engine answered e4 with a legal move: ${reply}`);
  }

  // Commentary panel must expose real search output.
  const commentary = await page.textContent(".commentary");
  if (!/depth\s+\d+/.test(commentary ?? "")) fail("commentary panel shows no search depth");
  else pass("commentary panel shows depth and evaluation");

  const pvText = (await page.textContent(".commentary__pv"))?.trim();
  if (!pvText) fail("commentary panel shows no principal variation");
  else pass(`principal variation surfaced: ${pvText.slice(0, 60)}…`);

  await page.screenshot({ path: `${SHOTS}/02-after-engine-reply.png`, fullPage: true });

  // --- a second exchange, this time by clicking squares -------------------------------
  await waitForUserTurn(page, 60000);

  // Click-to-move: g1 then f3 (Nf3 is legal in essentially every reply to e4).
  await selectSquare(page, "g1");
  await page.click('[data-square="f3"]');
  const played = await page
    .waitForFunction(
      () => {
        const cells = [...document.querySelectorAll(".history__move")]
          .map((c) => (c.textContent ?? "").trim())
          .filter(Boolean);
        return cells.length >= 3;
      },
      null,
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);

  if (played) pass("click-to-move worked");
  else fail("click-to-move did not register a third move");

  await page.waitForFunction(
    () => {
      const cells = [...document.querySelectorAll(".history__move")]
        .map((c) => (c.textContent ?? "").trim())
        .filter(Boolean);
      return cells.length >= 4;
    },
    null,
    { timeout: 180000 },
  );
  const all = (await page.locator(".history__move").allTextContents())
    .map((t) => t.trim())
    .filter(Boolean);
  pass(`full move sequence played: ${all.join(" ")}`);

  // Replay the whole game through chess.js to prove every move was legal.
  const replay = new Chess();
  let ok = true;
  for (const san of all) {
    try {
      replay.move(san);
    } catch {
      ok = false;
      fail(`move sequence is not legal at "${san}"`);
      break;
    }
  }
  if (ok) pass("entire move sequence validates against chess.js");

  await page.screenshot({ path: `${SHOTS}/03-midgame.png`, fullPage: true });

  // --- scenario 2: capture-promotion, underpromotion, and the captured tray ----------
  console.log("\ninfo  scenario 2: underpromotion from a custom FEN");
  await page.click(".btn--quiet:has-text('New position')");
  await page.waitForSelector(".setup__header h1", { timeout: 20000 });

  await page.click(".tab:has-text('Custom FEN')");
  // White Ke1 + pawn b7, Black Ke8 + knight c8. bxc8 is a capture *and* a promotion.
  await page.fill("#fen", "2n1k3/1P6/8/8/8/8/8/4K3 w - - 0 1");
  await page.waitForSelector(".note--ok", { timeout: 5000 });
  await page.click(".btn--primary");

  await waitForUserTurn(page);

  // Dragging a pawn to the last rank must open the promotion dialog, not auto-queen.
  await selectSquare(page, "b7");
  await page.click('[data-square="c8"]');
  const sawDialog = await page
    .waitForSelector(".promo", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!sawDialog) fail("promotion dialog did not open for a pawn reaching the last rank");
  else pass("promotion dialog opened instead of auto-queening");

  const promoIcons = await page.locator(".promo .piece-icon svg").count();
  if (promoIcons !== 4) fail(`expected 4 promotion piece icons, found ${promoIcons}`);
  else pass("promotion dialog offers all four pieces as vector icons");

  await page.screenshot({ path: `${SHOTS}/04-promotion.png` });

  // Choose the knight: underpromotion must be respected exactly.
  await page.click(".promo__btn:has-text('Knight')");
  await page.waitForFunction(
    () => {
      const cells = [...document.querySelectorAll(".history__move")]
        .map((c) => (c.textContent ?? "").trim())
        .filter(Boolean);
      return cells.length >= 1;
    },
    null,
    { timeout: 15000 },
  );
  const promoMove = (await page.locator(".history__move").first().textContent())?.trim();
  if (promoMove !== "bxc8=N") fail(`expected underpromotion bxc8=N, got "${promoMove}"`);
  else pass("underpromotion recorded correctly as bxc8=N");

  // The board must settle showing a *white* knight on c8 and an empty b7.
  // Poll rather than sample once, since the board animates piece movement.
  const settled = await page
    .waitForFunction(
      () => {
        const at = (sq) => {
          const p = document.querySelector(`[data-square="${sq}"] svg path`);
          return p ? getComputedStyle(p).fill : null;
        };
        return at("c8") === "rgb(255, 255, 255)" && at("b7") === null;
      },
      null,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);

  if (settled) {
    pass("board settled showing the promoted white knight on c8 and an empty b7");
  } else {
    const promoted = await page.evaluate(() => {
      const at = (sq) => {
        const p = document.querySelector(`[data-square="${sq}"] svg path`);
        return p ? getComputedStyle(p).fill : null;
      };
      return { c8: at("c8"), b7: at("b7") };
    });
    fail(`board never settled on the promoted position: ${JSON.stringify(promoted)}`);
  }

  // K+N vs K is a dead position; the app must call it as insufficient material.
  const drawDetail = (await page.textContent(".summary__detail"))?.trim();
  if (!/insufficient material/i.test(drawDetail ?? "")) {
    fail(`expected an insufficient-material draw, got "${drawDetail}"`);
  } else {
    pass("K+N vs K correctly ruled a draw by insufficient material");
  }

  // The captured knight must now appear in the user's tray as a rendered SVG.
  const trayIcons = await page.locator(".tray .piece-icon svg").count();
  if (trayIcons < 1) fail("captured-pieces tray rendered no piece icons");
  else pass(`captured-pieces tray rendered ${trayIcons} piece icon(s)`);

  await page.screenshot({ path: `${SHOTS}/05-after-underpromotion.png`, fullPage: true });

  // --- scenario 3: the real engine must convert a forced mate, not shuffle ------------
  console.log("\ninfo  scenario 3: engine plays the forced mate");
  await page.click(".btn--ghost:has-text('Choose another position')");
  await page.waitForSelector(".setup__header h1", { timeout: 20000 });

  await page.click(".tab:has-text('Library')");
  await page.click(".chip:has-text('Back-rank mate in 1')");
  // Take Black so the engine is White and must find Ra8#.
  await page.click(".segmented__item:has-text('Black')");
  await page.click(".btn--primary");
  await page.waitForSelector(".play__grid", { timeout: 20000 });

  // The engine moves first here; wait for the game to finish.
  await page.waitForFunction(
    () => /Checkmate/i.test(document.querySelector(".status")?.textContent ?? ""),
    null,
    { timeout: 180000 },
  );

  const mateMove = (await page.locator(".history__move").first().textContent())?.trim();
  if (mateMove !== "Ra8#") fail(`engine should have played Ra8#, played "${mateMove}"`);
  else pass("engine found and played the forced mate Ra8#");

  const mateDetail = (await page.textContent(".summary__detail"))?.trim();
  if (!/checkmate/i.test(mateDetail ?? "") || !/white wins/i.test(mateDetail ?? "")) {
    fail(`expected a checkmate win for White, got "${mateDetail}"`);
  } else {
    pass(`game correctly ended: ${mateDetail}`);
  }

  await page.screenshot({ path: `${SHOTS}/06-engine-mate.png`, fullPage: true });

  // --- tofu check: no missing-glyph boxes anywhere in the rendered UI -----------------
  const tofu = await page.evaluate(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = '16px ui-sans-serif, system-ui, sans-serif';
    const tofuWidth = ctx.measureText("\uFFFF").width;
    const text = document.body.innerText ?? "";
    const bad = new Set();
    for (const ch of text) {
      if (ch.codePointAt(0) < 0x2000) continue;
      if (Math.abs(ctx.measureText(ch).width - tofuWidth) < 0.01) bad.add(ch);
    }
    return [...bad];
  });
  if (tofu.length) fail(`UI text contains glyphs that render as tofu: ${JSON.stringify(tofu)}`);
  else pass("no tofu glyphs in rendered UI text");

  if (consoleErrors.length) {
    console.log("\n--- console errors ---");
    for (const e of [...new Set(consoleErrors)].slice(0, 10)) console.log(`      ${e}`);
  } else {
    pass("no console errors");
  }
} catch (err) {
  fail(`smoke test threw: ${err.message}`);
  await page.screenshot({ path: `${SHOTS}/error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(process.exitCode ? "\nSMOKE TEST FAILED" : "\nSMOKE TEST PASSED");
