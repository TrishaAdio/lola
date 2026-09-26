/**
 * Shared browser-test harness: serves dist/ in-process with cross-origin isolation
 * headers and drives the real UI through Playwright.
 */
import { chromium } from "playwright";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

export const SHOTS = "/projects/sandbox/.kiro/artifacts/screenshots";
mkdirSync(SHOTS, { recursive: true });

const DIST = path.resolve(import.meta.dirname, "..", "..", "dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".json": "application/json",
};

export async function serve() {
  if (!existsSync(DIST)) throw new Error("dist/ not found - run `npm run build` first.");
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = path.join(DIST, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
      file = path.join(DIST, "index.html");
    }
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Content-Type", MIME[path.extname(file)] ?? "application/octet-stream");
    res.setHeader("Content-Length", statSync(file).size);
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function launch() {
  return chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
}

/** Tracks failures so a script can report a single pass/fail at the end. */
export function reporter() {
  let failed = 0;
  return {
    pass: (msg) => console.log(`ok    ${msg}`),
    fail: (msg) => {
      failed++;
      console.error(`FAIL  ${msg}`);
    },
    info: (msg) => console.log(`info  ${msg}`),
    get failed() {
      return failed;
    },
  };
}

export async function waitForUserTurn(page, timeout = 180000) {
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

/**
 * Opens the app and starts a game from `fen` playing `side`. `configure` may adjust the
 * setup screen (e.g. toggle settings) before the game starts.
 */
export async function startGame(
  browser,
  base,
  { fen, side = "White", configure, waitTurn = true, errors, init, prefs, reducedMotion } = {},
) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("close", () => context.close().catch(() => {}));
  if (prefs) {
    await page.addInitScript((p) => localStorage.setItem("ruthless-chess:prefs", JSON.stringify(p)), prefs);
  }
  if (init) await page.addInitScript(init);
  if (errors) {
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  }
  await page.goto(base, { waitUntil: "networkidle" });
  if (fen) {
    await page.click(".tab:has-text('Custom FEN')");
    await page.fill("#fen", fen);
    await page.waitForSelector(".note--ok", { timeout: 10000 });
  }
  await page.click(`.segmented__item:has-text('${side}')`);
  if (configure) await configure(page);
  await page.click(".btn--primary");
  await page.waitForSelector(".play__grid", { timeout: 20000 });
  if (waitTurn) await waitForUserTurn(page);
  return page;
}

export async function drag(page, from, to) {
  const a = await page.locator(`[data-square="${from}"]`).boundingBox();
  const b = await page.locator(`[data-square="${to}"]`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(
      a.x + a.width / 2 + ((b.x - a.x) * i) / 12,
      a.y + a.height / 2 + ((b.y - a.y) * i) / 12,
    );
  }
  await page.mouse.up();
  // @dnd-kit swallows every click for 50 ms after a drop (a capture-phase stopPropagation
  // it removes on a timer). A human never clicks that fast; wait it out so the next click
  // in a test is not silently eaten.
  await page.waitForTimeout(80);
}

export async function clickMove(page, from, to) {
  await page.click(`[data-square="${from}"]`);
  await page.waitForSelector(`[data-sq="${from}"] .sq-layer--selected`, { timeout: 10000 });
  await page.click(`[data-square="${to}"]`);
}

export async function typeMove(page, text) {
  await page.fill(".moveinput input", text);
  await page.click(".moveinput button");
}

export const history = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".history__move")].map((c) => c.textContent.trim()).filter(Boolean),
  );

export async function waitForPlies(page, n, timeout = 180000) {
  await page.waitForFunction(
    (count) =>
      [...document.querySelectorAll(".history__move")].filter((c) => c.textContent.trim()).length >= count,
    n,
    { timeout },
  );
}

/** Skips the game-over review strip to reach the summary modal. */
export async function continueToSummary(page) {
  await page.waitForSelector("[data-testid=review-strip]", { timeout: 20000 });
  await page.click("[data-testid=review-strip] .btn--review");
  await page.waitForSelector(".modal .summary__head", { timeout: 5000 });
}
