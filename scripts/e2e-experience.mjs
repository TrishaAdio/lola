/**
 * End-to-end checks for the look, motion, sound and game-over flow, in a real browser
 * against the real engine.
 *
 * Usage: npm run build && node scripts/e2e-experience.mjs
 */
import {
  SHOTS,
  clickMove,
  launch,
  reporter,
  serve,
  startGame,
  typeMove,
  waitForPlies,
  waitForUserTurn,
} from "./lib/harness.mjs";

const r = reporter();
const server = await serve();
const browser = await launch();
const errors = [];

async function scenario(name, fn) {
  try {
    await fn();
  } catch (err) {
    r.fail(`${name} threw: ${err.message.split("\n")[0]}`);
  }
}

/** Samples every animated piece movement each frame: its easing and duration. */
const RECORD_MOTION = () => {
  window.__motion = [];
  const tick = () => {
    for (const el of document.querySelectorAll("[data-piece]")) {
      if (!/translate/.test(el.style.transform)) continue;
      const cs = getComputedStyle(el);
      window.__motion.push({ easing: cs.transitionTimingFunction, duration: cs.transitionDuration });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const sounds = (page) => page.evaluate(() => window.__sounds ?? []);
const EMOJI = /\p{Extended_Pictographic}/u;
const CHESS_GLYPHS = /[\u2654-\u265F]/;

try {
  // ---- iconography ------------------------------------------------------------------
  r.info("pieces, themes, icons");
  await scenario("pieces", async () => {
    const page = await startGame(browser, server.base, { errors });
    const pieces = await page.evaluate(() => {
      const svgs = [...document.querySelectorAll("#board-board svg[data-piece-code], .board-frame svg[data-piece-code]")];
      const body = svgs[0]?.querySelector("path");
      return {
        count: new Set(svgs.map((s) => s.closest("[data-square]")?.getAttribute("data-square"))).size,
        codes: [...new Set(svgs.map((s) => s.getAttribute("data-piece-code")))].sort().join(","),
        bodyFill: body?.getAttribute("fill"),
        ink: body ? getComputedStyle(body).stroke : null,
      };
    });
    if (pieces.count === 32) r.pass("all 32 pieces render from the app's own set");
    else r.fail(`expected 32 pieces, found ${pieces.count}`);
    if (pieces.codes === "bB,bK,bN,bP,bQ,bR,wB,wK,wN,wP,wQ,wR") r.pass("all 12 piece types present");
    else r.fail(`piece codes: ${pieces.codes}`);
    if (/url\(#rc-body-[wb]\)/.test(pieces.bodyFill ?? "")) r.pass("piece bodies use the themed gradient");
    else r.fail(`piece body fill is ${pieces.bodyFill}`);
    if (pieces.ink && pieces.ink !== "rgb(0, 0, 0)") r.pass(`outlines use theme ink (${pieces.ink}), not black`);
    else r.fail(`outline colour is ${pieces.ink}`);

    const text = await page.evaluate(() => document.body.innerText);
    if (!EMOJI.test(text) && !CHESS_GLYPHS.test(text)) r.pass("no emoji or Unicode chess glyphs anywhere in the UI");
    else r.fail("UI text contains emoji or Unicode chess glyphs");

    const icons = await page.evaluate(() => {
      const svgs = [...document.querySelectorAll(".play__bar svg")];
      return {
        total: svgs.length,
        lucide: svgs.filter((s) => s.classList.contains("lucide")).length,
        iconFonts: document.querySelectorAll("i[class*='fa'], .material-icons, .material-symbols-outlined").length,
        imgs: document.querySelectorAll(".play__bar img").length,
      };
    });
    if (icons.total >= 6 && icons.lucide === icons.total && icons.iconFonts === 0 && icons.imgs === 0) {
      r.pass(`header uses one icon set: ${icons.lucide}/${icons.total} icons are Lucide, no icon fonts or images`);
    } else r.fail(`icon audit: ${JSON.stringify(icons)}`);

    const unlabeled = await page.evaluate(() =>
      [...document.querySelectorAll(".play__bar button")]
        .filter((b) => !b.textContent.trim() && !b.getAttribute("aria-label"))
        .length,
    );
    if (unlabeled === 0) r.pass("every icon-only button has an accessible name");
    else r.fail(`${unlabeled} icon-only buttons lack a label`);
    await page.close();
  });

  await scenario("theme switching", async () => {
    const page = await startGame(browser, server.base, { errors });
    await page.click("[aria-label='Settings']");
    await page.click("[data-theme-id=glacier]");
    const applied = await page.evaluate(() => {
      const dark = document.querySelector("[data-square='a1']");
      return {
        theme: document.documentElement.dataset.theme,
        a1: getComputedStyle(dark).backgroundColor,
      };
    });
    if (applied.theme === "glacier" && applied.a1 === "rgb(106, 134, 152)") {
      r.pass("switching theme recolours the board live");
    } else r.fail(`theme switch: ${JSON.stringify(applied)}`);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `${SHOTS}/xp-theme-glacier.png`, fullPage: true });
    await page.reload({ waitUntil: "networkidle" });
    const kept = await page.evaluate(() => document.documentElement.dataset.theme);
    if (kept === "glacier") r.pass("theme choice persists across reloads");
    else r.fail(`theme after reload: ${kept}`);
    await page.close();
  });

  // ---- motion ------------------------------------------------------------------------
  r.info("motion");
  await scenario("move easing", async () => {
    const page = await startGame(browser, server.base, { side: "Black", init: RECORD_MOTION, errors });
    // The slide starts one render after the move is committed; let it run.
    await page.waitForTimeout(500);
    const motion = await page.evaluate(() => window.__motion);
    const eased = motion.filter((m) => m.easing === "cubic-bezier(0.215, 0.61, 0.355, 1)");
    if (motion.length > 0 && eased.length === motion.length && motion.every((m) => m.duration === "0.19s")) {
      r.pass(`engine move slid with ease-out cubic over 190 ms (${motion.length} frames observed)`);
    } else r.fail(`piece motion: ${JSON.stringify(motion.slice(0, 3))}`);
    await page.close();
  });

  await scenario("capture ghost", async () => {
    const page = await startGame(browser, server.base, { fen: "4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1", errors });
    await clickMove(page, "e4", "d5");
    const ghost = await page
      .waitForSelector("[data-sq=d5] .capture-ghost", { timeout: 3000, state: "attached" })
      .then((el) => el.evaluate((n) => {
        const cs = getComputedStyle(n);
        return { name: cs.animationName, duration: cs.animationDuration, delay: cs.animationDelay, piece: n.querySelector("svg")?.getAttribute("data-piece-code") };
      }))
      .catch(() => null);
    if (ghost?.name === "capture-out" && ghost.piece === "bP") {
      r.pass(`captured pawn shrinks and fades (${ghost.duration} after a ${ghost.delay} slide)`);
    } else r.fail(`capture ghost: ${JSON.stringify(ghost)}`);
    const played = await sounds(page);
    if (played.some((s) => s.name === "capture")) r.pass("capture plays the capture sound");
    else r.fail(`sounds after capture: ${JSON.stringify(played.map((s) => s.name))}`);
    await page.close();
  });

  await scenario("check glow", async () => {
    const page = await startGame(browser, server.base, { fen: "4k3/8/8/8/8/8/8/R3K3 w Q - 0 1", errors });
    await clickMove(page, "a1", "a8");
    const glow = await page
      .waitForSelector("[data-sq=e8] .king-glow", { timeout: 3000, state: "attached" })
      .then((el) => el.evaluate((n) => ({
        mate: n.classList.contains("king-glow--mate"),
        name: getComputedStyle(n).animationName,
        period: getComputedStyle(n).animationDuration,
      })))
      .catch(() => null);
    if (glow && !glow.mate && glow.name === "king-breathe") {
      r.pass(`checked king gets a soft breathing ring (${glow.period} period, no flashing)`);
    } else r.fail(`check glow: ${JSON.stringify(glow)}`);
    const played = await sounds(page);
    if (played.some((s) => s.name === "check")) r.pass("check plays the check cue");
    else r.fail(`sounds after check: ${JSON.stringify(played.map((s) => s.name))}`);
    await page.screenshot({ path: `${SHOTS}/xp-check-glow.png` });
    await waitForPlies(page, 2);
    await waitForUserTurn(page);
    if ((await page.locator(".king-glow").count()) === 0) r.pass("glow clears once the king escapes");
    else r.fail("glow stayed after the king left check");
    await page.close();
  });

  await scenario("reduced motion", async () => {
    const page = await startGame(browser, server.base, {
      fen: "4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1",
      init: RECORD_MOTION,
      reducedMotion: true,
      errors,
    });
    await clickMove(page, "e4", "d5");
    await waitForPlies(page, 2);
    const ghosts = await page.locator(".capture-ghost").count();
    const motion = await page.evaluate(() => window.__motion.filter((m) => parseFloat(m.duration) > 0));
    if (ghosts === 0 && motion.length === 0) r.pass("prefers-reduced-motion: no slides and no capture fade");
    else r.fail(`reduced motion: ${ghosts} ghosts, ${motion.length} animated moves`);
    await page.close();
  });

  // ---- sound switches ----------------------------------------------------------------
  r.info("sound");
  await scenario("sound switches", async () => {
    const page = await startGame(browser, server.base, { errors });
    await typeMove(page, "e4");
    await waitForPlies(page, 2);
    await waitForUserTurn(page);
    let log = await sounds(page);
    const heard = log.filter((s) => s.bus === "board" && !s.suppressed && s.name === "move");
    if (heard.length >= 1) r.pass("moves are voiced on the board bus");
    else r.fail(`board sounds: ${JSON.stringify(log)}`);

    await page.click("[aria-label='Settings']");
    await page.click(".switch:has-text('Board sounds')");
    await page.keyboard.press("Escape");
    const n = log.length;
    await typeMove(page, "Nf3");
    await waitForPlies(page, 4);
    await waitForUserTurn(page);
    log = (await sounds(page)).slice(n);
    if (log.length > 0 && log.every((s) => s.bus !== "board" || s.suppressed === "bus-off")) {
      r.pass("board sounds switch silences moves independently");
    } else r.fail(`with board sounds off: ${JSON.stringify(log)}`);

    await page.click("[aria-label='Mute']");
    const m = (await sounds(page)).length;
    await typeMove(page, "Bc4");
    await waitForPlies(page, 6);
    log = (await sounds(page)).slice(m);
    if (log.length > 0 && log.every((s) => s.suppressed === "muted")) r.pass("master mute silences everything");
    else r.fail(`with mute: ${JSON.stringify(log)}`);
    await page.close();
  });

  // ---- Tactics Aura HUD ----------------------------------------------------------------
  r.info("tactics aura");
  // White to move with a forced mate: the engine is White, the user Black.
  const MATE_NET = "6k1/8/8/8/8/8/1Q6/1R4K1 w - - 0 1";
  await scenario("aura hud", async () => {
    const page = await startGame(browser, server.base, { fen: MATE_NET, side: "Black", errors });
    const line = await page
      .waitForSelector(".aura-hud__line", { timeout: 20000 })
      .then((el) => el.evaluate((n) => ({ trigger: n.dataset.trigger, text: n.textContent, anim: getComputedStyle(n).animationName })))
      .catch(() => null);
    if (line?.trigger === "mate-net") r.pass(`proven mate fires the mate-net line: "${line.text}"`);
    else r.fail(`aura line: ${JSON.stringify(line)}`);
    if (line?.anim.includes("hud-in")) r.pass("aura line slides in as a HUD element");
    else r.fail(`aura animation: ${line?.anim}`);
    await page.screenshot({ path: `${SHOTS}/xp-aura-hud.png` });
    const auraSound = (await sounds(page)).find((s) => s.name === "aura");
    if (auraSound?.bus === "aura") r.pass("aura cue plays on its own bus");
    else r.fail(`aura sound: ${JSON.stringify(auraSound)}`);
    const gone = await page
      .waitForSelector(".aura-hud__line", { state: "detached", timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (gone) r.pass("aura line dismisses itself");
    else r.fail("aura line never went away");
    await page.close();
  });

  await scenario("aura muted", async () => {
    const page = await startGame(browser, server.base, {
      fen: MATE_NET,
      side: "Black",
      prefs: { auraMessages: false },
      errors,
    });
    await page.waitForTimeout(1500);
    const lines = await page.locator(".aura-hud__line").count();
    const auraSounds = (await sounds(page)).filter((s) => s.name === "aura").length;
    if (lines === 0 && auraSounds === 0) r.pass("aura lines switched off: no line and no cue");
    else r.fail(`aura muted: ${lines} lines, ${auraSounds} cues`);
    await page.close();
  });

  // ---- game-over review --------------------------------------------------------------
  r.info("game-over review");
  // Engine (White) mates at once with Ra8#.
  const MATE_IN_ONE = "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1";
  const mated = async () => {
    const page = await startGame(browser, server.base, { fen: MATE_IN_ONE, side: "Black", waitTurn: false, errors });
    await page.waitForFunction(() => /Checkmate/.test(document.body.innerText), null, { timeout: 60000 });
    return page;
  };

  await scenario("review strip", async () => {
    const page = await mated();
    const early = await page.evaluate(() => ({
      strip: !!document.querySelector("[data-testid=review-strip]"),
      modal: !!document.querySelector(".modal .summary__head"),
    }));
    if (!early.strip && !early.modal) r.pass("final move and mate effects play before anything appears");
    else r.fail(`at mate: ${JSON.stringify(early)}`);

    await page.waitForSelector("[data-testid=review-strip]", { timeout: 5000 });
    const strip = await page.textContent("[data-testid=review-strip]");
    if (/Checkmate \u2014 White wins/.test(strip) && /Summary in 60s/.test(strip)) {
      r.pass(`result strip: "${strip.replace(/\s+/g, " ").trim()}"`);
    } else r.fail(`strip text: ${strip}`);
    if ((await page.locator(".modal").count()) === 0) r.pass("board stays unobstructed during review");
    else r.fail("a modal covers the board during review");

    await page.waitForTimeout(2300);
    const later = await page.textContent("[data-testid=review-countdown]");
    const left = Number(later.match(/(\d+)s/)?.[1]);
    if (left >= 56 && left <= 58) r.pass(`countdown runs (${later})`);
    else r.fail(`countdown after ~2.3s: ${later}`);

    await page.mouse.click(...(await (async () => {
      const b = await page.locator("[data-square=d4]").boundingBox();
      return [b.x + b.width / 2, b.y + b.height / 2];
    })()));
    await page.waitForTimeout(300);
    if ((await page.locator(".modal").count()) === 0) r.pass("clicking the board keeps studying it");
    else r.fail("clicking the board skipped the review");
    await page.screenshot({ path: `${SHOTS}/xp-review-strip.png`, fullPage: true });

    await page.click("[data-testid=review-strip] .btn--review");
    const modal = await page.waitForSelector(".modal .summary__head", { timeout: 3000 }).then(() => true).catch(() => false);
    if (modal) r.pass("Continue opens the summary immediately");
    else r.fail("Continue did not open the summary");
    await page.close();
  });

  await scenario("click anywhere", async () => {
    const page = await mated();
    await page.waitForSelector("[data-testid=review-strip]", { timeout: 5000 });
    await page.click(".play__side .panel__title");
    const modal = await page.waitForSelector(".modal .summary__head", { timeout: 3000 }).then(() => true).catch(() => false);
    if (modal) r.pass("a click on empty space continues");
    else r.fail("click-anywhere did not continue");
    await page.close();
  });

  await scenario("keyboard", async () => {
    const page = await mated();
    await page.waitForSelector("[data-testid=review-strip]", { timeout: 5000 });
    await page.keyboard.press("Escape");
    const modal = await page.waitForSelector(".modal .summary__head", { timeout: 3000 }).then(() => true).catch(() => false);
    if (modal) r.pass("Escape continues");
    else r.fail("Escape did not continue");
    await page.close();
  });

  await scenario("auto-advance", async () => {
    const page = await mated();
    await page.waitForSelector("[data-testid=review-strip]", { timeout: 5000 });
    const t0 = Date.now();
    await page.waitForSelector(".modal .summary__head", { timeout: 75000 });
    const s = (Date.now() - t0) / 1000;
    if (s >= 58 && s <= 62) r.pass(`summary opens on its own after ${s.toFixed(1)}s`);
    else r.fail(`auto-advance took ${s.toFixed(1)}s`);
    await page.close();
  });
} catch (err) {
  r.fail(`e2e threw: ${err.message}`);
} finally {
  await browser.close();
  await server.close();
}

const realErrors = [...new Set(errors)].filter((e) => !/AudioContext|autoplay/i.test(e));
if (realErrors.length) for (const e of realErrors.slice(0, 8)) r.fail(`console: ${e}`);
else r.pass("no console errors");
console.log(r.failed ? `\nE2E EXPERIENCE FAILED (${r.failed})` : "\nE2E EXPERIENCE PASSED");
process.exit(r.failed ? 1 : 0);
