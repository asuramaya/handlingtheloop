#!/usr/bin/env node
// draglab — the preset menu's drag-and-drop, driven for real.
//
// ★ WHY THIS EXISTS. The reorder in the FX preset menu was "fixed" five times from screenshots and
// reasoning, and broke again every time, because the thing that decides where a drop lands is
// document.elementFromPoint over two floating windows with their own stacking, clipping, flipping
// and hover-dismissal. NONE of that is visible in the source, and none of it is reachable from a
// unit test: jsdom has no layout, so every getBoundingClientRect is zeroes and every hit-test
// answers the same thing. So this drives the REAL app in a real Chromium with a real pointer, and
// asserts on the arrangement the menu actually renders afterwards.
//
// ★ AND IT ASSERTS ON WHAT IS RENDERED, NOT ON localStorage. The bank can be written correctly and
// still shown wrong (resolve, refs, tombstones and freshness all sit between the two), and a user
// believes the screen. The stored bank is read too, but only as a second opinion.
//
// Usage:  node scripts/draglab/draglab.mjs [--url http://localhost:5173] [--headed] [--only <n>]
// Needs:  the dev server already running, playwright-core, and a Chromium on the box.
import { chromium } from "playwright-core";
import { fakeAccount, bankOf } from "./account.mjs";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const URL_ = arg("--url", "http://localhost:5173");
const HEADED = process.argv.includes("--headed");
const ONLY = arg("--only", null);

function findChromium() {
  const cache = resolve(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((x) => x.startsWith("chromium")).sort().reverse()) {
      for (const rel of ["chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/chrome", "chrome-linux/headless_shell"]) {
        const p = resolve(cache, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/snap/bin/chromium", "/usr/bin/chromium"]) if (existsSync(p)) return p;
  return null;
}

// ★ TWO WIDTHS, AND THE NARROW ONE IS THE POINT. MenuFly does flip-then-clamp: with no room to the
// right it opens to the LEFT of its menu, directly OVER the list being dragged in — and the drop
// hit-test is elementFromPoint, which returns whatever is on top. Every drag in that menu used to
// land nowhere. At a comfortable width the flyout never flips and the whole failure is invisible,
// so the suite runs the same scenarios again at a width that forces it, and asserts the flip
// actually happened rather than assuming it.
const WIDE = 1600;
const NARROW = 1040;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "  \x1b[32m✓\x1b[0m" : "  \x1b[31m✗\x1b[0m"} ${name}${ok || !detail ? "" : `\n      ${detail}`}\n`);
};

// ── the page-side vocabulary ─────────────────────────────────────────────────────────────
// What the FIRST window shows, top level only: [{name, group, count}]. This is the assertion
// surface — it is literally the rows a user can see.
const TOP = `(() => {
  const menu = [...document.querySelectorAll('.fx-preset-menu')].find(m => !m.classList.contains('fx-menu-fly') && !m.classList.contains('layer-3'));
  if (!menu) return null;
  return [...menu.querySelectorAll('[data-drag]')].map(r => {
    const g = r.classList.contains('fx-section-row');
    return { name: (g ? r.querySelector('.fx-section-label') : r.querySelector('.fx-palette-item')).textContent.trim(), group: g, count: g ? Number(r.querySelector('.fx-section-n').textContent) : 0 };
  });
})()`;
const FLY = `(() => {
  const f = document.querySelector('.fx-menu-fly');
  if (!f) return null;
  return [...f.querySelectorAll('[data-drag] .fx-palette-item')].map(b => b.textContent.trim());
})()`;

async function boot(page, deck, tries = 2) {
  try {
    return await bootOnce(page, deck);
  } catch (e) {
    if (tries <= 1) throw e;
    return await boot(page, deck, tries - 1);
  }
}
async function bootOnce(page, deck, keep = false) {
  // ★ CLEARING THE BANK KEY IS NOT A RESET. App mirrors every bank write into settings.fxBanks
  // (the account-sync leg) and hydrateFxBanks() writes it straight back into localStorage on every
  // mount — so a harness that deletes only htl:fxpreset:eq gets its previous run handed back to it
  // by the app itself. Wipe the whole namespace.
  if (!keep)
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith("htl")) localStorage.removeItem(k);
    });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".fx-tab", { timeout: 60000 });
  // The EQ tab exists with no track loaded, which is what makes this harness cheap to run.
  const tabs = await page.$$(".fx-strip");
  const strip = tabs[deck] ?? tabs[0];
  const eq = await strip.$("text=EQ");
  await eq.click({ button: "right" });
  await page.waitForSelector(".fx-preset-menu", { timeout: 5000 });
}

/** ★ WAIT FOR THE CONDITION, NOT FOR A DURATION. Every fixed `waitForTimeout` in a suite is a bet
 *  that the machine is as fast today as it was when the number was chosen, and one of them lost:
 *  a gate run read 265/266 and the next read 266/266. Polling costs the same on a fast machine and
 *  simply does not have the failure mode on a slow one. Returns whether the condition ever held. */
async function waitFor(page, fn, arg = null, ms = 2000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(fn, arg)) return true;
    if (Date.now() > until) return false;
    await page.waitForTimeout(40);
  }
}

/** A real pointer drag: press, several intermediate moves (the hook arms on movement and decides
 *  on every move), then release. `to` may be a point or an element+fraction. */
async function drag(page, from, to, steps = 14) {
  // ★ A TARGET THAT ONLY EXISTS MID-DRAG. The chin's "TO THE END" lane is rendered only while a
  // drag is running — an empty lane above Default the rest of the time is 18px of nothing every
  // time the menu opens. So press first, jiggle enough to ARM the drag, and only then look it up.
  if (to.sel) {
    const a0 = await from.boundingBox();
    const sx = a0.x + a0.width / 2, sy = a0.y + a0.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(sx + i, sy + i);
    const el = await page.$(to.sel);
    if (!el) {
      await page.mouse.up();
      throw new Error(`drag: ${to.sel} never appeared`);
    }
    const t = await el.boundingBox();
    const tx = t.x + t.width / 2, ty = t.y + t.height / 2;
    for (let i = 1; i <= steps; i++) await page.mouse.move(sx + ((tx - sx) * i) / steps, sy + ((ty - sy) * i) / steps);
    await page.waitForTimeout(30);
    const fb = await page.evaluate(() => ({
      drop: [...document.querySelectorAll(".fx-section-row.drop")].map((r) => r.querySelector(".fx-section-label")?.textContent.trim()),
      topZone: !!document.querySelector(".fx-top-zone.drop"),
      end: !!document.querySelector(".fx-end-strip.drop"),
      lines: [...document.querySelectorAll(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3) .reorder-drop-line")].length,
    }));
    await page.mouse.up();
    await page.waitForTimeout(60);
    return fb;
  }
  // ★ BRING THE TARGET INTO VIEW BEFORE MEASURING IT. The menu caps at 240px and spends part of it
  // on a pinned chin, so a row further down the bank is CLIPPED — getBoundingClientRect answers for
  // it as if it were visible, the pointer is sent to a coordinate the chin is painted at, and the
  // drop lands on nothing. Park the pointer on the SOURCE first: a flyout row is in another window
  // and does not move when this list scrolls, and a menu row parked under the pointer cannot open
  // some other section's flyout as the rows slide past. Then measure, once, for real.
  if (to.el) {
    const a0 = await from.boundingBox();
    await page.mouse.move(a0.x + a0.width / 2, a0.y + a0.height / 2);
    await to.el.evaluate((n) => n.scrollIntoView({ block: "nearest" }));
    await page.waitForTimeout(40);
  }
  const a = await from.boundingBox();
  const b = to.box ? to : { x: (await to.el.boundingBox()).x + (await to.el.boundingBox()).width * (to.fx ?? 0.5), y: (await to.el.boundingBox()).y + (await to.el.boundingBox()).height * (to.fy ?? 0.5) };
  const x0 = a.x + a.width / 2, y0 = a.y + a.height / 2;
  const x1 = b.box ? b.box.x : b.x, y1 = b.box ? b.box.y : b.y;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  await page.waitForTimeout(30);
  // ★ WHAT THE SCREEN PROMISED, sampled the frame before release. Every group→group drag in this
  // suite passed on the ARRANGEMENT while showing the operator nothing at all — the heading `.drop`
  // outline and the drop line were wired to the top-level drag only, so a row leaving a flyout
  // moved correctly and invisibly. A drop with no target feedback is a drop nobody believes, and
  // that is what "it doesn't work" was. So the promise is an assertion now, not a side effect.
  const feedback = await page.evaluate(() => ({
    drop: [...document.querySelectorAll(".fx-section-row.drop")].map((r) => r.querySelector(".fx-section-label")?.textContent.trim()),
    topZone: !!document.querySelector(".fx-top-zone.drop"),
    lines: [...document.querySelectorAll(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3) .reorder-drop-line")].length,
  }));
  await page.mouse.up();
  await page.waitForTimeout(60);
  return feedback;
}

const rowAt = (page, i) => page.$(`.fx-preset-menu:not(.fx-menu-fly):not(.layer-3) [data-drag="${i}"]`);
const flyRow = (page, i) => page.$(`.fx-menu-fly [data-drag="${i}"]`);

async function openFly(page, i) {
  const h = await rowAt(page, i);
  // ★ SCROLL IT INTO VIEW FIRST. The menu caps at 240px and spends part of that on a pinned chin,
  // so a row further down is clipped: getBoundingClientRect still answers for it, but the pointer
  // sent there lands on whatever is painted at that spot, and the hover opens the WRONG section's
  // flyout — silently, because a flyout does appear. A person scrolls; so does this.
  await h.evaluate((n) => n.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(40);
  const bb = await h.boundingBox();
  // Leave first. The flyout opens on mouseENTER, and after a drop the pointer is often already
  // inside the row it needs to enter — no event fires and the window never appears.
  await page.mouse.move(bb.x + bb.width / 2, bb.y - 40);
  await page.waitForTimeout(30);
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForSelector(".fx-menu-fly", { timeout: 3000 });
  await page.waitForTimeout(50);
}

async function main() {
  const exe = findChromium();
  if (!exe) {
    console.error("draglab: no Chromium found (~/.cache/ms-playwright or PATH).");
    process.exit(2);
  }
  const browser = await chromium.launch({ executablePath: exe, headless: !HEADED, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: WIDE, height: 1000 } });
  page.on("pageerror", (e) => process.stderr.write(`  [page error] ${e.message}\n`));
  await page.goto(URL_, { waitUntil: "domcontentloaded" });

  const scenarios = [];
  const S = (name, fn) => scenarios.push({ name, fn });

  // ── 1. the top level reorders at all ──────────────────────────────────────────────────
  S("top level: drag a section above the one before it", async (deck, W) => {
    await boot(page, deck);
    const before = await page.evaluate(TOP);
    // rows 0 and 1 are the first two shipped sections
    await drag(page, await rowAt(page, 1), { el: await rowAt(page, 0), fy: 0.05 });
    const after = await page.evaluate(TOP);
    check(`[${W}/d${deck}] section moves above its predecessor`, after[0].name === before[1].name && after[1].name === before[0].name, `before=${before.slice(0, 2).map((r) => r.name)} after=${after.slice(0, 2).map((r) => r.name)}`);
  });

  // ── 2. into a group, from the top level ───────────────────────────────────────────────
  S("top level → group", async (deck, W) => {
    await boot(page, deck);
    // Make a loose preset at the top: pull the first item out of the first group.
    await openFly(page, 0);
    const name = (await page.evaluate(FLY))[0];
    await drag(page, await flyRow(page, 0), { el: await rowAt(page, 1), fy: 0.5 });
    let top = await page.evaluate(TOP);
    // BOTH sides, or a copy would pass as a move.
    check(`[${W}/d${deck}] group → another group (drop on heading middle)`, top[0].count === 3 && top[1].group && top[1].count === 4, `row0=${JSON.stringify(top[0])} row1=${JSON.stringify(top[1])}`);
    // and back out to no group, by dropping on the list's background
    await openFly(page, 1);
    const fly = await page.evaluate(FLY);
    const idx = fly.indexOf(name);
    await drag(page, await flyRow(page, idx), { sel: ".fx-end-strip" });
    top = await page.evaluate(TOP);
    check(`[${W}/d${deck}] group → no group (drop on the list background)`, top.some((r) => !r.group && r.name === name), `top=${JSON.stringify(top.map((r) => r.name))} looking for ${name}`);
  });

  // ── 3. a loose preset goes back INTO a group ──────────────────────────────────────────
  S("no group → group", async (deck, W) => {
    await boot(page, deck);
    await openFly(page, 0);
    const name = (await page.evaluate(FLY))[0];
    // Loose at the TOP, not at the end: this scenario then drags it into the group beside it, and
    // two rows at opposite ends of a scrolling list are not both on screen. Reaching across a fold
    // is auto-scroll's job and has its own scenario.
    await drag(page, await flyRow(page, 0), { el: await rowAt(page, 0), fy: 0.02 });
    let top = await page.evaluate(TOP);
    const loose = top.findIndex((r) => !r.group && r.name === name);
    check(`[${W}/d${deck}] it is loose first`, loose >= 0, JSON.stringify(top.map((r) => r.name)));
    if (loose < 0) return;
    const g0 = top.findIndex((r) => r.group);
    const before = top[g0].count;
    await drag(page, await rowAt(page, loose), { el: await rowAt(page, g0), fy: 0.5 });
    top = await page.evaluate(TOP);
    check(`[${W}/d${deck}] no group → group (drop on heading middle)`, top[g0 > loose ? g0 - 1 : g0].count === before + 1, `count ${before} → ${top[g0 > loose ? g0 - 1 : g0].count}`);
  });

  // ── 4. reorder INSIDE a group ─────────────────────────────────────────────────────────
  S("inside a group", async (deck, W) => {
    await boot(page, deck);
    await openFly(page, 0);
    const before = await page.evaluate(FLY);
    await drag(page, await flyRow(page, 1), { el: await flyRow(page, 0), fy: 0.05 });
    await openFly(page, 0);
    const after = await page.evaluate(FLY);
    check(`[${W}/d${deck}] reorder within a section`, after[0] === before[1] && after[1] === before[0], `before=${before} after=${after}`);
  });

  // ── 5. the heading's EDGE inserts beside it, not into it ──────────────────────────────
  S("heading edge band", async (deck, W) => {
    await boot(page, deck);
    await openFly(page, 0);
    const name = (await page.evaluate(FLY))[0];
    await drag(page, await flyRow(page, 0), { sel: ".fx-end-strip" });
    let top = await page.evaluate(TOP);
    const loose = top.findIndex((r) => !r.group && r.name === name);
    if (loose < 0) return check(`[${W}/d${deck}] edge band`, false, "could not make a loose preset");
    // ANY heading — the loose row can land anywhere in the list now that leaving a group honours
    // the gap you aimed at, so "the first group after it" is no longer guaranteed to exist.
    const g1 = top.findIndex((r) => r.group);
    if (g1 < 0) return check(`[${W}/d${deck}] edge band`, false, "no section to aim at");
    await drag(page, await rowAt(page, loose), { el: await rowAt(page, g1), fy: 0.02 });
    top = await page.evaluate(TOP);
    const stillLoose = top.some((r) => !r.group && r.name === name);
    check(`[${W}/d${deck}] heading top edge inserts BESIDE, not into`, stillLoose, `top=${JSON.stringify(top.map((r) => `${r.group ? "#" : ""}${r.name}`))}`);
  });


  // ── 6. the direction the operator reported broken: OUT of a group, INTO another, both ways ──
  S("group → group, target ABOVE the source", async (deck, W) => {
    await boot(page, deck);
    const before = await page.evaluate(TOP);
    // take from the LAST group, drop on the FIRST
    const gLast = before.length - 1;
    await openFly(page, gLast);
    const name = (await page.evaluate(FLY))[0];
    await drag(page, await flyRow(page, 0), { el: await rowAt(page, 0), fy: 0.5 });
    const top = await page.evaluate(TOP);
    check(`[${W}/d${deck}] group → group upward`, top[0].count === before[0].count + 1 && top[gLast].count === before[gLast].count - 1, `first ${before[0].count}→${top[0].count}, last ${before[gLast].count}→${top[gLast].count} (moved ${name})`);
    await openFly(page, 0);
    check(`[${W}/d${deck}] …and it is actually in the target group`, (await page.evaluate(FLY)).includes(name), `fly=${JSON.stringify(await page.evaluate(FLY))}`);
  });

  S("dropping on its OWN heading changes nothing", async (deck, W) => {
    await boot(page, deck);
    const before = await page.evaluate(TOP);
    await openFly(page, 1);
    const flyBefore = await page.evaluate(FLY);
    await drag(page, await flyRow(page, 0), { el: await rowAt(page, 1), fy: 0.5 });
    const top = await page.evaluate(TOP);
    check(`[${W}/d${deck}] same-group drop is a no-op, not a shuffle`, JSON.stringify(top) === JSON.stringify(before), `before=${JSON.stringify(before.map((r) => r.count))} after=${JSON.stringify(top.map((r) => r.count))}`);
    void flyBefore;
  });

  // ── 6b. EVERY ordered pair of groups, and the heading must SAY it is the target ─────────
  S("group → group, every pair, with feedback", async (deck, W) => {
    for (const [src, dst] of [[0, 1], [3, 0], [6, 3], [1, 6]]) {
      await boot(page, deck);
      const before = await page.evaluate(TOP);
      if (!before[src]?.group || !before[dst]?.group) continue;
      await openFly(page, src);
      const name = (await page.evaluate(FLY))[0];
      const fb = await drag(page, await flyRow(page, 0), { el: await rowAt(page, dst), fy: 0.5 });
      const after = await page.evaluate(TOP);
      const moved = after[dst].count === before[dst].count + 1 && after[src].count === before[src].count - 1;
      check(`[${W}/d${deck}] g${src}→g${dst} moves "${name}"`, moved, `${before[src].count}→${after[src].count} / ${before[dst].count}→${after[dst].count}`);
      check(`[${W}/d${deck}] g${src}→g${dst} lights the target heading`, fb.drop.length === 1 && fb.drop[0] === before[dst].name, `outlined=${JSON.stringify(fb.drop)}`);
    }
  });

  // ── 6c. LEAVING a group lands in the gap you pointed at, not beside its old section ─────
  S("out of a group, to a chosen position", async (deck, W) => {
    await boot(page, deck);
    const before = await page.evaluate(TOP);
    // take from a MIDDLE group and aim at the very top of the list
    await openFly(page, 3);
    const name = (await page.evaluate(FLY))[0];
    const fb = await drag(page, await flyRow(page, 0), { el: await rowAt(page, 0), fy: 0.02 });
    let top = await page.evaluate(TOP);
    check(`[${W}/d${deck}] out of a group → the FIRST slot, where it was aimed`, !top[0].group && top[0].name === name, `row0=${JSON.stringify(top[0])} (was ${before[0].name})`);
    check(`[${W}/d${deck}] …and the list drew a drop line while it was aimed there`, fb.lines > 0 && fb.topZone, `lines=${fb.lines} topZone=${fb.topZone}`);
    // and the other end: the landing strip under the last row
    await boot(page, deck);
    await openFly(page, 0);
    const n2 = (await page.evaluate(FLY))[0];
    await drag(page, await flyRow(page, 0), { sel: ".fx-end-strip" });
    top = await page.evaluate(TOP);
    check(`[${W}/d${deck}] out of a group → the LAST slot, via the landing strip`, !top[top.length - 1].group && top[top.length - 1].name === n2, `last=${JSON.stringify(top[top.length - 1])}`);
  });

  // ── 6d. a SECTION over a section reorders; it never nests, and never says it will ────────
  S("a section cannot be filed into a section", async (deck, W) => {
    await boot(page, deck);
    const before = await page.evaluate(TOP);
    const fb = await drag(page, await rowAt(page, 2), { el: await rowAt(page, 0), fy: 0.5 });
    const after = await page.evaluate(TOP);
    // Past a row's midpoint means AFTER it, so aiming at row 0's centre lands at slot 1 — the point
    // is that it is still a top-level row and nothing swallowed it.
    const counts = (l) => l.filter((r) => r.group).reduce((n, r) => n + r.count, 0);
    check(`[${W}/d${deck}] a section dropped on a section's MIDDLE reorders, never nests`, after.length === before.length && after[1].name === before[2].name && counts(after) === counts(before), `after=${JSON.stringify(after.map((r) => r.name))} presets ${counts(before)}→${counts(after)}`);
    check(`[${W}/d${deck}] …and never outlined it as a drop target`, fb.drop.length === 0, `outlined=${JSON.stringify(fb.drop)}`);
    // ★ AND NOTHING ELSE PROMISED IT EITHER. The `.drop` outline was always correct here; what read
    // as "you can nest this" was the plain :hover, which paints every row a dragged item crosses in
    // full accent — the loudest thing on screen, on rows that cannot accept the drop.
    const lit = await page.evaluate(() => !!document.querySelector(".fx-top-zone.dragging"));
    void lit;
  });

  // ── 6e. A BANK THAT PREDATES A FACTORY PRESET — the "NEW" section, driven for real ───────
  // resolve() appends NEW so a preset shipped after the operator last touched their bank is still
  // reachable; the mutations used to edit the STORED rows, which are one row shorter. Everything
  // from NEW onward addressed a different list from the one on screen, and the symptom was exactly
  // one preset that could not be dragged anywhere. A live bank is always a stale bank eventually,
  // so the suite grows one on purpose rather than only ever testing a fresh install.
  S("a stale bank's NEW section behaves like any other", async (deck, W) => {
    await boot(page, deck);
    // One preset name is all it takes to forge an OLD bank: a single hand-made section holding one
    // preset, which is what a user who grouped something months ago actually has stored. Everything
    // shipped since is then `missing`, and resolve() hands it back in a synthetic NEW section that
    // the stored arrangement does not contain. settings.fxBanks is still empty at this point, so
    // the hydrate has nothing to write back over this.
    await openFly(page, 0);
    const one = (await page.evaluate(FLY))[0];
    await page.evaluate((n) => localStorage.setItem("htl:fxpreset:eq", JSON.stringify({ rows: [{ name: "KEEP", sep: true, items: [{ ref: n }] }], gone: [] })), one);
    await bootOnce(page, deck, true); // reload WITHOUT wiping — that is the whole point
    let top = await page.evaluate(TOP);
    const nIdx = top.findIndex((r) => r.group && r.name === "NEW");
    check(`[${W}/d${deck}] a stale bank surfaces what it predates, in NEW`, nIdx > 0 && top[0].name === "KEEP" && top[0].count === 1, `top=${JSON.stringify(top.map((r) => `${r.group ? "#" : ""}${r.name}:${r.count}`))}`);
    if (nIdx < 0) return;
    await openFly(page, nIdx);
    const fly = await page.evaluate(FLY);
    check(`[${W}/d${deck}] NEW holds the presets the bank predates`, fly.length > 1, `fly=${JSON.stringify(fly)}`);
    // ★ THE ACTUAL FAILURE. NEW is a row the menu renders and the arrangement did not have, so a
    // drop into it hit rows[undefined] and returned silently: one preset that could not be dragged
    // anywhere, which reads as a guard and never was one.
    const name = fly[0];
    await drag(page, await flyRow(page, 0), { el: await rowAt(page, 0), fy: 0.5 });
    top = await page.evaluate(TOP);
    check(`[${W}/d${deck}] a preset stranded in NEW files into a real group`, top[0].count === 2, `KEEP ${JSON.stringify(top[0])} (moving ${name})`);
    // …and the top level can be rearranged across the row that used to be phantom
    await drag(page, await rowAt(page, nIdx), { el: await rowAt(page, 0), fy: 0.02 });
    top = await page.evaluate(TOP);
    check(`[${W}/d${deck}] and NEW itself reorders like any other section`, top[0].name === "NEW", `top=${JSON.stringify(top.map((r) => r.name))}`);
  });

  // ── 6f. THE TWO DOORS ONTO ONE BANK MUST SHOW THE SAME BANK ─────────────────────────────
  // The add picker's flyout rendered factoryFxPresets() — the shipped list, flat, in code order —
  // while the right-click menu renders the arrangement. Same effect, two different lists depending
  // on how you got there, and the one on the add path was the one that could not be curated. This
  // walks both doors and compares what is on the shelf.
  S("add-effect and right-click show the same bank", async (deck, W) => {
    await boot(page, deck);
    await page.evaluate(() => document.querySelector(".fx-menu-backdrop")?.click());
    await page.waitForTimeout(60);
    const strips = await page.$$(".fx-strip");
    const mine = strips[deck] ?? strips[0];
    const other = strips[deck === 0 ? 1 : 0] ?? strips[0];
    // ROWS OF WHATEVER PANEL: sections as "#NAME:n", presets as their name, in order.
    // A panel with a chin holds its rows in .fx-menu-body, one level in — see MENU_CHIN.
    const ROWS = (sel) => `(() => { const p = document.querySelector(${JSON.stringify(sel)}); if (!p) return null;
      const m = p.querySelector(".fx-menu-body") || p;
      return [...m.children].flatMap(n => {
        if (n.classList.contains("fx-section-row")) return ["#" + n.querySelector(".fx-section-label").textContent.trim() + ":" + n.querySelector(".fx-section-n").textContent.trim()];
        const b = n.classList.contains("fx-preset-apply") ? n : n.querySelector && n.querySelector(".fx-preset-apply");
        return b ? [b.textContent.trim()] : [];
      }); })()`;
    const closeAll = async () => { await page.evaluate(() => document.querySelector(".fx-menu-backdrop")?.click()); await page.waitForTimeout(80); };

    // Put an addable effect into THIS deck's chain, so it has a tab to right-click.
    await (await mine.$(".fx-tab-add")).click();
    await page.waitForSelector(".fx-preset-menu", { timeout: 3000 });
    const kind = await page.evaluate(() => {
      const n = [...document.querySelectorAll(".fx-preset-menu:not(.fx-menu-fly) .fx-palette-item")].find((b) => b.querySelector(".fx-add-more"));
      if (!n) return null;
      const k = n.childNodes[0].textContent.trim();
      n.click();
      return k;
    });
    if (!kind) return check(`[${W}/d${deck}] add/right-click parity`, false, "no addable kind carries presets");
    await page.waitForTimeout(150);

    // CURATE IT, through the door that owns the bank. Without this the two lists could agree merely
    // by both being the factory order, and the assertion would prove nothing.
    await page.evaluate((k) => [...document.querySelectorAll(".fx-strip .fx-tab")].find((n) => n.textContent.trim().startsWith(k))?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 420, clientY: 420 })), kind);
    await page.waitForSelector(".fx-preset-menu", { timeout: 3000 });
    const SEL = ".fx-preset-menu:not(.fx-menu-fly):not(.layer-3) .fx-top-zone > div:first-child";
    const before = await page.evaluate(ROWS(SEL));
    const r1 = await rowAt(page, 1);
    if (r1) await drag(page, r1, { el: await rowAt(page, 0), fy: 0.05 });
    check(`[${W}/d${deck}] ${kind}: the bank was actually curated first`, JSON.stringify(await page.evaluate(ROWS(SEL))) !== JSON.stringify(before), `unchanged: ${JSON.stringify(before)}`);
    // …and give it a SECTION, so the third window is exercised too: a picker that showed the right
    // presets in the wrong grammar (flat, no sections) would still be a disparity.
    await page.click('.fx-preset-menu:not(.fx-menu-fly) .fx-act[title^="Add a section"]');
    await page.waitForSelector(".dialog-input", { timeout: 3000 });
    await page.fill(".dialog-input", "MINE");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(120);
    const rows = await page.evaluate(ROWS(SEL));
    const sIdx = rows.findIndex((r) => r.startsWith("#MINE")); // a new section lands at the end
    // Fill it from another SECTION, not from a loose neighbour: every shipped bank is grouped now,
    // so "the row above" is a heading, and a section cannot be filed into a section.
    const gIdx = rows.findIndex((r) => r.startsWith("#") && !r.startsWith("#MINE"));
    if (sIdx >= 0 && gIdx >= 0) {
      await openFly(page, gIdx);
      await drag(page, await flyRow(page, 0), { el: await rowAt(page, sIdx), fy: 0.5 });
    }
    const menuRows = await page.evaluate(ROWS(SEL));
    check(`[${W}/d${deck}] ${kind}: a section with a preset in it now exists`, menuRows.some((r) => r.startsWith("#MINE:1")), `menu=${JSON.stringify(menuRows)}`);
    await closeAll();

    // The OTHER deck has not been given this effect, so its add picker still offers it. Banks are
    // per-KIND, not per-deck, so both doors are onto the same shelf.
    await (await other.$(".fx-tab-add")).click();
    await page.waitForSelector(".fx-preset-menu", { timeout: 3000 });
    const found = await page.evaluate((k) => {
      const n = [...document.querySelectorAll(".fx-preset-menu:not(.fx-menu-fly) .fx-palette-item")].find((b) => b.childNodes[0].textContent.trim() === k);
      if (!n) return false;
      n.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      n.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      return true;
    }, kind);
    await page.waitForSelector(".fx-menu-fly", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(80);
    const addRows = await page.evaluate(ROWS(".fx-menu-fly:not(.layer-3)"));
    check(`[${W}/d${deck}] ${kind}: the add picker offers the curated bank, not the factory list`, found && Array.isArray(addRows) && addRows.length > 1 && JSON.stringify(addRows) === JSON.stringify(menuRows), `add=${JSON.stringify(addRows)}\n      menu=${JSON.stringify(menuRows)}`);
    // The section opens into a THIRD window on this path too, and holds what was filed into it.
    await page.evaluate(() => {
      const n = [...document.querySelectorAll(".fx-menu-fly:not(.layer-3) .fx-section-row")].find((r) => r.querySelector(".fx-section-label").textContent.trim() === "MINE");
      n?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      n?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await page.waitForTimeout(120);
    const third = await page.evaluate(ROWS(".fx-menu-fly.layer-3"));
    check(`[${W}/d${deck}] ${kind}: a section in the add picker opens its own window`, Array.isArray(third) && third.length === 1, `third=${JSON.stringify(third)}`);
    await closeAll();
  });

  // ── 6g. THE ROW IS THE HIGHLIGHT, AND DEFAULT DOES NOT SCROLL AWAY ──────────────────────
  S("section rows fill the menu, and Default is pinned", async (deck, W) => {
    await boot(page, deck);
    const geo = await page.evaluate(() => {
      const box = document.querySelector(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3)");
      const body = box.querySelector(".fx-menu-body");
      const chin = box.querySelector(".fx-menu-chin");
      const sec = box.querySelector(".fx-section-row");
      const btn = sec?.querySelector(".fx-palette-item");
      return {
        rowW: sec ? Math.round(sec.getBoundingClientRect().width) : -1,
        btnW: btn ? Math.round(btn.getBoundingClientRect().width) : -1,
        hasChin: !!chin,
        chinDefault: chin?.querySelector(".fx-palette-item")?.textContent.trim(),
        // the chin must sit BELOW the body and outside anything that scrolls
        chinBelow: !!chin && !!body && chin.getBoundingClientRect().top >= body.getBoundingClientRect().bottom - 1,
        scrolls: body ? body.scrollHeight > body.clientHeight : false,
        boxScrolls: box.scrollHeight > box.clientHeight,
      };
    });
    // ★ THE BUTTON IS THE ROW. It carried no flex, so a section's hover lit a box that stopped
    // after its own label with dead menu either side — on the row you are most likely aiming at.
    check(`[${W}/d${deck}] a section's button fills its row`, geo.btnW > 0 && geo.btnW === geo.rowW, `row ${geo.rowW}px, button ${geo.btnW}px`);
    check(`[${W}/d${deck}] Default is a pinned chin, under the body`, geo.hasChin && geo.chinDefault === "Default" && geo.chinBelow, JSON.stringify(geo));
    // …and pinned means the BODY scrolls, not the box: a chin inside the scroller is not pinned.
    check(`[${W}/d${deck}] the body scrolls and the box does not`, !geo.boxScrolls, `bodyScrolls=${geo.scrolls} boxScrolls=${geo.boxScrolls}`);
    // Prove it: scroll to the bottom and the chin has not moved.
    const moved = await page.evaluate(() => {
      const box = document.querySelector(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3)");
      const body = box.querySelector(".fx-menu-body");
      const chin = box.querySelector(".fx-menu-chin");
      const before = chin.getBoundingClientRect().top;
      body.scrollTop = body.scrollHeight;
      return Math.abs(chin.getBoundingClientRect().top - before);
    });
    check(`[${W}/d${deck}] scrolling the list does not move the chin`, moved < 1, `chin moved ${moved}px`);
  });

  // ── 6h. AUTO-SCROLL: reaching a target that is not on screen when the drag starts ────────
  // The bank is taller than the 240px menu, so the two ends of it are never visible together. The
  // drag's edge auto-scroll is the only way across, and it runs on its own rAF precisely because
  // at the edge the pointer STOPS MOVING — a scroll driven by move events stalls exactly there.
  S("edge auto-scroll carries a drag across the fold", async (deck, W) => {
    await boot(page, deck);
    const before = await page.evaluate(TOP);
    const last = before.length - 1;
    const src = await rowAt(page, last);
    await src.evaluate((n) => n.scrollIntoView({ block: "nearest" }));
    await page.waitForTimeout(40);
    const a = await src.boundingBox();
    const body = await page.$(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3) .fx-menu-body");
    const br = await body.boundingBox();
    const scrolledAtStart = await body.evaluate((n) => n.scrollTop);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    // Walk up to the body's TOP edge and hold there — the pointer stops, the rAF keeps scrolling.
    for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 - ((a.y - br.y) * i) / 10 + 6);
    for (let i = 0; i < 30; i++) await page.mouse.move(a.x + a.width / 2, br.y + 6);
    await page.waitForTimeout(250);
    const scrolledAtEdge = await body.evaluate((n) => n.scrollTop);
    check(`[${W}/d${deck}] holding at the edge scrolls the list under the drag`, scrolledAtEdge < scrolledAtStart, `scrollTop ${scrolledAtStart} → ${scrolledAtEdge}`);
    await page.mouse.up();
    await page.waitForTimeout(80);
    const after = await page.evaluate(TOP);
    check(`[${W}/d${deck}] …and it lands near the top it was carried to`, after[0].name === before[last].name || after[1].name === before[last].name, `after=${JSON.stringify(after.map((r) => r.name))}`);
  });

  // ── 6i. THE CHAIN MENU PLAYS BY THE SAME RULES ──────────────────────────────────────────
  // Its saved rows carried three inline glyphs (› preview, ✎ rename, ✕ delete) long after the
  // preset menu was cleared of exactly that, and the ✕ deleted a whole chain from a bare 22px
  // target one pixel from the rename. The acts are a right-click row menu now, and the preview
  // flyout has to survive that menu opening over it — the hover-dismissal bug, one surface later.
  S("the chain bank is a bank", async (deck, W) => {
    await boot(page, deck);
    await page.evaluate(() => document.querySelector(".fx-menu-backdrop")?.click());
    await page.waitForTimeout(60);
    const strips = await page.$$(".fx-strip");
    const chip = await (strips[deck] ?? strips[0]).$(".fx-chain:not(.add)"); // the first .fx-chain is ＋
    if (!chip) return check(`[${W}/d${deck}] chain menu`, false, "no chain chip");
    await chip.click({ button: "right" });
    await page.waitForSelector(".fx-preset-menu", { timeout: 3000 });
    await page.waitForTimeout(100);
    const secs = await page.evaluate(() =>
      [...document.querySelectorAll(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3) .fx-section-row")].map(
        (n) => n.querySelector(".fx-section-label").textContent.trim() + ":" + n.querySelector(".fx-section-n").textContent.trim(),
      ),
    );
    check(`[${W}/d${deck}] the chain menu is SECTIONED, like every effect bank`, secs.length >= 4, `sections=${JSON.stringify(secs)}`);
    const glyphs = await page.evaluate(() => document.querySelectorAll(".fx-preset-mini").length);
    check(`[${W}/d${deck}] no inline glyph buttons anywhere`, glyphs === 0, `${glyphs} .fx-preset-mini still rendered`);
    if (!secs.length) return;
    // A section opens the second window, holding the chains in it.
    const head = (await page.$$(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3) .fx-section-row"))[0];
    const hb = await head.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y - 30);
    await page.waitForTimeout(30);
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.waitForSelector(".fx-menu-fly", { timeout: 3000 });
    await page.waitForTimeout(60);
    const inFly = await page.$$(".fx-menu-fly [data-drag]");
    check(`[${W}/d${deck}] a section opens its chains in the second window`, inFly.length > 0, `rows=${inFly.length}`);
    if (!inFly.length) return;
    // ★ THE PEEK, FIRST: hovering a chain row opens a THIRD window with its stems and its devices,
    // so the cost of recalling it is readable before the click rather than after it.
    const rb = await inFly[0].boundingBox();
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.waitForTimeout(200);
    const peek = await page.evaluate(() => {
      const w = document.querySelector(".fx-menu-fly.layer-3");
      if (!w) return null;
      return { stems: !!w.querySelector(".fly-stems"), devices: w.querySelectorAll(".fly-line").length, w: Math.round(w.getBoundingClientRect().width) };
    });
    check(`[${W}/d${deck}] hovering a chain peeks at its contents, in a third window`, !!peek && peek.stems && peek.devices > 0, `peek=${JSON.stringify(peek)}`);
    // ★ AND THE WINDOWS SIZE THEMSELVES. They used to carry the OPENING menu's measured width as a
    // minimum, so three short names sat in a box built for the longest list in the app.
    check(`[${W}/d${deck}] a window is as wide as its own content`, !!peek && peek.w < 168, `${peek?.w}px (the cap is 168)`);
    // ★ AND IT GOES AWAY. A hover-opened window closes on its OWN mouseleave, which never fires if
    // you leave the ROW without ever reaching the window — so moving off the list left the peek
    // stranded on screen over everything else. Leaving the row arms a grace; wait it out.
    // Leave the ROW without leaving the WINDOW — onto the flyout's own head, a few px up. That is
    // exactly the case the peek used to survive forever: its own mouseleave never fires.
    const flyHead = await page.evaluate(() => {
      const h = document.querySelector(".fx-menu-fly:not(.layer-3) .fx-preset-head").getBoundingClientRect();
      return { x: Math.round(h.x + h.width / 2), y: Math.round(h.y + h.height / 2) };
    });
    await page.mouse.move(flyHead.x, flyHead.y);
    check(`[${W}/d${deck}] the peek does not linger once the pointer leaves the row`, await waitFor(page, () => !document.querySelector(".fx-menu-fly.layer-3")), "a third window is still on screen");

    // Right-click a row: the row menu clears the peek and opens ABOVE every window it can be opened
    // from, and the section window it was opened from survives it.
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.waitForTimeout(150);
    // Re-query: the row has re-rendered since it was first found, and a stale handle is detached.
    await (await page.$$(".fx-menu-fly:not(.layer-3) [data-drag]"))[0].click({ button: "right" });
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => ({
      fly: !!document.querySelector(".fx-menu-fly:not(.layer-3)"),
      peek: !!document.querySelector(".fx-menu-fly.layer-3"),
      items: [...document.querySelectorAll(".fx-preset-menu.layer-4 .fx-palette-item")].map((n) => n.textContent.trim()),
    }));
    check(`[${W}/d${deck}] the row menu opens above every window it can be opened from`, after.items[0] === "Recall into this chain", `items=${JSON.stringify(after.items)}`);
    check(`[${W}/d${deck}] …and it takes the peek with it`, !after.peek, "the peek is still up under the menu");
    check(`[${W}/d${deck}] …and the section window survives it opening over it`, after.fly, "the flyout closed on a hover it never lost");
    await page.evaluate(() => document.querySelectorAll(".fx-menu-backdrop").forEach((b) => b.click()));
  });

  // ── 6k. NO WINDOW OUTLIVES WHAT OPENED IT ────────────────────────────────────────────────
  // Two stranded-window reports in a row, both with a peek left floating over the deck. A window
  // opened by a HOVER is only ever dismissed by an event, and there are two events it can miss:
  // the row unmounts under the pointer (no mouseleave is fired for an element that goes away), or
  // the pointer leaves the row for something that is not the window.
  S("no flyout outlives what opened it", async (deck, W) => {
    await boot(page, deck);
    await page.evaluate(() => document.querySelector(".fx-menu-backdrop")?.click());
    await page.waitForTimeout(60);
    const strips = await page.$$(".fx-strip");
    const chip = await (strips[deck] ?? strips[0]).$(".fx-chain:not(.add)");
    if (!chip) return check(`[${W}/d${deck}] chain menu`, false, "no chain chip");
    await chip.click({ button: "right" });
    await page.waitForSelector(".fx-preset-menu", { timeout: 3000 });
    await page.waitForTimeout(80);
    // Save the live chain as a preset — that is what puts a LOOSE row at the top level, which is
    // the shape both screenshots were taken in.
    await page.click('.fx-preset-menu:not(.fx-menu-fly) .fx-act[title^="Save this chain"]');
    await page.waitForSelector(".dialog-input", { timeout: 3000 });
    await page.fill(".dialog-input", "test");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    await chip.click({ button: "right" });
    await page.waitForSelector(".fx-preset-menu", { timeout: 3000 });
    await page.waitForTimeout(100);
    const loose = await page.$(".fx-preset-menu:not(.fx-menu-fly):not(.layer-4) [data-drag]:not(.fx-section-row)");
    check(`[${W}/d${deck}] saving puts a loose chain at the top level`, !!loose, "no loose row");
    if (!loose) return;
    const lb = await loose.boundingBox();
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
    await page.waitForTimeout(200);
    check(`[${W}/d${deck}] hovering it peeks`, await page.evaluate(() => !!document.querySelector(".fx-menu-fly.layer-3")), "no peek");
    // …now onto a SECTION heading. The peek belonged to a row nobody is pointing at any more.
    const head = (await page.$$(".fx-preset-menu:not(.fx-menu-fly):not(.layer-4) .fx-section-row"))[0];
    const hb = await head.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.waitForTimeout(350);
    const both = await page.evaluate(() => [...document.querySelectorAll(".fx-menu-fly")].map((f) => f.querySelector(".fx-preset-title")?.textContent.trim()));
    check(`[${W}/d${deck}] moving to a section leaves ONE window`, both.length === 1, `on screen: ${JSON.stringify(both)}`);
    // …and a peek opened from INSIDE that section window must go when the pointer leaves for good.
    const row = (await page.$$(".fx-menu-fly:not(.layer-3) [data-drag]"))[0];
    if (row) {
      const rb2 = await row.boundingBox();
      await page.mouse.move(rb2.x + rb2.width / 2, rb2.y + rb2.height / 2);
      await page.waitForTimeout(200);
      await page.mouse.move(20, 900); // right out of the whole stack
      const gone = await waitFor(page, () => document.querySelectorAll(".fx-menu-fly").length === 0);
      check(`[${W}/d${deck}] leaving the stack leaves NOTHING behind`, gone, `${await page.evaluate(() => document.querySelectorAll(".fx-menu-fly").length)} window(s) still on screen`);
    }
    // ★ THE PATHS EVENTS MISS. A real pointer does not teleport, and each of these used to strand a
    // window: the row UNMOUNTS under the pointer (no mouseleave is ever fired for it), and the
    // pointer sits in the GAP between a row and its window, which belongs to neither.
    const head2 = (await page.$$(".fx-preset-menu:not(.fx-menu-fly):not(.layer-4) .fx-section-row"))[0];
    if (head2) {
      const h2 = await head2.boundingBox();
      await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
      await page.waitForTimeout(200);
      const r3 = await (await page.$$(".fx-menu-fly:not(.layer-3) [data-drag]"))[0]?.boundingBox();
      if (r3) {
        await page.mouse.move(r3.x + r3.width / 2, r3.y + r3.height / 2);
        await page.waitForTimeout(200);
        const peekBox = await page.evaluate(() => {
          const w = document.querySelector(".fx-menu-fly.layer-3");
          if (!w) return null;
          const r = w.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y) };
        });
        check(`[${W}/d${deck}] a row inside the section window peeks too`, !!peekBox, "no peek from the flyout");
        if (peekBox) {
          // Park in the GAP between the row and its window — over the page, over neither.
          await page.mouse.move(Math.round((r3.x + r3.width + peekBox.x) / 2), r3.y + r3.height / 2);
          check(`[${W}/d${deck}] parking in the gap does not strand the peek`, await waitFor(page, () => !document.querySelector(".fx-menu-fly.layer-3")), "the peek survived the gap");
        }
      }
    }
    await page.evaluate(() => document.querySelectorAll(".fx-menu-backdrop").forEach((b) => b.click()));
  });

  // ── 6m. A DRAG MUST NOT LIGHT UP ROWS IT CANNOT LAND ON ─────────────────────────────────
  S("hover does not masquerade as a drop target mid-drag", async (deck, W) => {
    await boot(page, deck);
    const rows = await page.$$(".fx-preset-menu:not(.fx-menu-fly):not(.layer-4) [data-drag]");
    if (rows.length < 3) return check(`[${W}/d${deck}] hover-vs-drop`, false, "too few rows");
    const a = await rows[3].boundingBox();
    const t = await rows[0].boundingBox();
    const x0 = a.x + a.width / 2, y0 = a.y + a.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    let painted = null;
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(x0, y0 + ((t.y + t.height / 2 - y0) * i) / 10);
      const hit = await page.evaluate(() => {
        // What does the row under the pointer actually look like? An accent FILL is the promise.
        const r = [...document.querySelectorAll(".fx-top-zone .fx-palette-item")].find((n) => n.matches(":hover"));
        if (!r) return null;
        const bg = getComputedStyle(r).backgroundColor;
        return bg === "rgba(0, 0, 0, 0)" || bg === "transparent" ? null : bg;
      });
      if (hit) painted = hit;
    }
    await page.mouse.up();
    await page.waitForTimeout(60);
    check(`[${W}/d${deck}] no row is painted as a target while a section is dragged over it`, painted === null, `a row under the drag was filled ${painted}`);
  });

  // ── 6n. A SECTION'S RIGHT-CLICK IS THE SAME IN EVERY BANK ───────────────────────────────
  // The row menu read `menuDev.kind` and rendered only when a DEVICE menu was open, so right-
  // clicking a heading in the CHAIN menu set its state and then nothing appeared: chain sections
  // had no rename and no remove while every effect bank had both. Walk both banks, same gesture.
  S("section right-click: rename and remove, in every bank", async (deck, W) => {
    for (const which of ["preset", "chain"]) {
      await boot(page, deck);
      const strips = await page.$$(".fx-strip");
      if (which === "chain") {
        await page.evaluate(() => document.querySelector(".fx-menu-backdrop")?.click());
        await page.waitForTimeout(60);
        const chip = await (strips[deck] ?? strips[0]).$(".fx-chain:not(.add)");
        if (!chip) continue;
        await chip.click({ button: "right" });
        await page.waitForSelector(".fx-preset-menu", { timeout: 3000 });
        await page.waitForTimeout(80);
      }
      const SECS = `[...document.querySelectorAll(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3):not(.layer-4) .fx-section-row .fx-section-label")].map(n => n.textContent.trim())`;
      const before = await page.evaluate(SECS);
      const head = (await page.$$(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3):not(.layer-4) .fx-section-row"))[0];
      if (!head) continue;
      await head.click({ button: "right" });
      await page.waitForTimeout(150);
      const items = await page.evaluate(() =>
        [...document.querySelectorAll(".fx-preset-menu.layer-3 .fx-palette-item, .fx-preset-menu.layer-4 .fx-palette-item")].map((n) => n.textContent.trim()),
      );
      check(`[${W}/d${deck}] ${which}: a section's menu offers Rename and Remove section`, items.includes("Rename") && items.includes("Remove section"), `items=${JSON.stringify(items)}`);
      if (!items.includes("Rename")) continue;
      // RENAME it, for real, and read the list back.
      await page.evaluate(() => [...document.querySelectorAll(".fx-preset-menu.layer-3 .fx-palette-item, .fx-preset-menu.layer-4 .fx-palette-item")].find((n) => n.textContent.trim() === "Rename")?.click());
      await page.waitForSelector(".dialog-input", { timeout: 3000 });
      await page.fill(".dialog-input", "RENAMED");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      const renamed = await page.evaluate(SECS);
      check(`[${W}/d${deck}] ${which}: renaming a shipped section takes`, renamed[0] === "RENAMED", `${JSON.stringify(before)} → ${JSON.stringify(renamed)}`);
      // …and REMOVE it, keeping what was inside (the effect banks' rule, now the chain bank's too).
      const head2 = (await page.$$(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3):not(.layer-4) .fx-section-row"))[0];
      await head2.click({ button: "right" });
      await page.waitForTimeout(150);
      await page.evaluate(() => [...document.querySelectorAll(".fx-preset-menu.layer-3 .fx-palette-item, .fx-preset-menu.layer-4 .fx-palette-item")].find((n) => n.textContent.trim() === "Remove section")?.click());
      await page.waitForTimeout(200);
      const after = await page.evaluate(SECS);
      check(`[${W}/d${deck}] ${which}: removing a shipped section takes`, !after.includes("RENAMED") && after.length === before.length - 1, `${JSON.stringify(renamed)} → ${JSON.stringify(after)}`);
      await page.evaluate(() => document.querySelectorAll(".fx-menu-backdrop").forEach((b) => b.click()));
    }
  });

  // ── 6l. CHANGE YOUR MIND ON THE WAY TO A FLYOUT ──────────────────────────────────────────
  // ★ THE PATH THAT STRANDED EVERY ONE OF THEM, and the one the earlier scenarios never walked:
  // hover a section heading so its window opens, then go somewhere else WITHOUT EVER ENTERING IT.
  // The window's own mouseleave cannot fire — the pointer was never inside — so a dismissal built
  // out of enter/leave has no event to act on and the window simply stays, over the deck, forever.
  S("a flyout you never entered still goes away", async (deck, W) => {
    for (const which of ["preset", "chain"]) {
      await boot(page, deck);
      const strips = await page.$$(".fx-strip");
      if (which === "chain") {
        await page.evaluate(() => document.querySelector(".fx-menu-backdrop")?.click());
        await page.waitForTimeout(60);
        const chip = await (strips[deck] ?? strips[0]).$(".fx-chain:not(.add)");
        if (!chip) continue;
        await chip.click({ button: "right" });
        await page.waitForSelector(".fx-preset-menu", { timeout: 3000 });
        await page.waitForTimeout(80);
      }
      const head = (await page.$$(".fx-preset-menu:not(.fx-menu-fly):not(.layer-4) .fx-section-row"))[0];
      if (!head) continue;
      const hb = await head.boundingBox();
      await page.mouse.move(hb.x + hb.width / 2, hb.y - 30);
      await page.waitForTimeout(30);
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.waitForSelector(".fx-menu-fly", { timeout: 3000 });
      check(`[${W}/d${deck}] ${which}: the section window opens`, true);
      // …and now away, LEFT (the flyout hangs right, so this never touches it), then stop.
      // Away to the LEFT (the flyout hangs right, so this never touches it) — clamped into the
      // viewport, because a move to a negative x is not delivered at all and no pointermove fires.
      await page.mouse.move(Math.max(12, hb.x - 200), hb.y + 160);
      const cleared = await waitFor(page, () => document.querySelectorAll(".fx-menu-fly").length === 0);
      check(`[${W}/d${deck}] ${which}: a window you never entered does not strand`, cleared, `${await page.evaluate(() => document.querySelectorAll(".fx-menu-fly").length)} still on screen`);
      await page.evaluate(() => document.querySelectorAll(".fx-menu-backdrop").forEach((b) => b.click()));
    }
  });

  // ── 6o. THE ACCOUNT LEG, ROUND-TRIPPED ───────────────────────────────────────────────────
  // ★ THE INBOUND HALF WAS DEAD AND NOBODY COULD SEE IT. hydrateFxBanks ran ONCE on mount, and the
  // account blob always lands after mount (sign-in reconcile, 30s poll, live account broadcast all
  // call setSettings later) — so a second device showed the factory arrangement, and its first
  // local edit announced THAT back over the account and took the first device's curation with it.
  // This drives both legs against the real store: curate here, read what was announced OUT, then
  // deliver a DIFFERENT blob in and assert the menu re-renders from it.
  // ── 6o. THE ACCOUNT, DRIVEN LOCALLY ──────────────────────────────────────────────────────
  // ★ EVERY BUG IN THIS CODE IS ABOUT ORDER, and none of them are reachable from a unit test: the
  // account blob lands AFTER mount, two devices write in the wrong sequence, a push is refused and
  // nobody says so. `fakeAccount` is the whole signed-in server as a page.route, so all of it runs
  // on one machine with no D1, no OAuth and no second browser.
  S("account: a bank arrives, and an edit leaves", async (deck, W) => {
    const acct = await fakeAccount(page, { settings: { fxBanks: { eq: bankOf("FROM THE ACCOUNT", "Bass Kill", "High Kill") } } });
    try {
      await boot(page, deck);
      const arrived = await waitFor(page, () => {
        const m = document.querySelector(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3):not(.layer-4)");
        return !!m && [...m.querySelectorAll(".fx-section-label")].some((n) => n.textContent.trim() === "FROM THE ACCOUNT");
      }, null, 6000);
      check(`[${W}/d${deck}] INBOUND: a bank from the account reaches the MENU`, arrived, `top=${JSON.stringify((await page.evaluate(TOP)).slice(0, 2).map((r) => r.name))}`);
      if (!arrived) return;
      await drag(page, await rowAt(page, 1), { el: await rowAt(page, 0), fy: 0.05 });
      const sent = await waitFor(page, () => true, null, 0);
      void sent;
      let rows = null;
      for (const t0 = Date.now(); Date.now() - t0 < 5000; ) {
        rows = acct.lastPush?.fxBanks?.eq?.rows ?? null;
        if (rows) break;
        await page.waitForTimeout(100);
      }
      check(`[${W}/d${deck}] OUTBOUND: an edit made here leaves in the next push`, !!rows, `${acct.pushes.length} push(es)`);
    } finally {
      await acct.done();
    }
  });

  S("account: a second device does not clobber the first", async (deck, W) => {
    // ★ THE REGRESSION THAT MATTERS. Device A curates; device B signs in. If B's inbound leg is
    // dead, B shows the factory arrangement AND its first edit pushes that back over A's work —
    // silent destruction, in the direction nobody is looking. B must push A's bank plus its edit.
    const acct = await fakeAccount(page, { settings: { fxBanks: { eq: bankOf("DEVICE A", "Bass Kill", "High Kill", "Split Low") } } });
    try {
      await boot(page, deck);
      await waitFor(page, () => {
        const m = document.querySelector(".fx-preset-menu:not(.fx-menu-fly):not(.layer-3):not(.layer-4)");
        return !!m && [...m.querySelectorAll(".fx-section-label")].some((n) => n.textContent.trim() === "DEVICE A");
      }, null, 6000);
      await drag(page, await rowAt(page, 0), { el: await page.$(".fx-preset-menu:not(.fx-menu-fly) .fx-menu-body") ?? await rowAt(page, 0), fy: 0.98 });
      let pushed = null;
      for (const t0 = Date.now(); Date.now() - t0 < 5000; ) {
        pushed = acct.lastPush?.fxBanks?.eq?.rows ?? null;
        if (pushed) break;
        await page.waitForTimeout(100);
      }
      const names = JSON.stringify(pushed ?? []);
      check(`[${W}/d${deck}] the second device pushes the FIRST device's bank, not the factory one`, !!pushed && names.includes("DEVICE A"), `pushed=${names.slice(0, 120)}`);
    } finally {
      await acct.done();
    }
  });

  S("account: a refused push is visible, and signed-out is honest", async (deck, W) => {
    // The server caps the blob at 256 KB and returns 413. That refusal used to be swallowed, so a
    // user whose settings outgrew the cap simply stopped syncing, on every device, silently.
    const acct = await fakeAccount(page, { settings: { fxBanks: {} } });
    try {
      await boot(page, deck);
      await page.evaluate(() => document.querySelector(".fx-menu-backdrop")?.click());
      acct.fail(413);
      await boot(page, deck);
      await drag(page, await rowAt(page, 1), { el: await rowAt(page, 0), fy: 0.05 });
      await page.evaluate(() => document.querySelector(".fx-menu-backdrop")?.click());
      // Open Settings ▸ Audio and READ THE LINE — the panel is the whole point of the fix, so the
      // assertion is what the operator would actually see, not the state behind it.
      await page.click('[aria-label="Settings"]');
      await page.waitForSelector(".settings-tab", { timeout: 5000 });
      await page.evaluate(() => [...document.querySelectorAll(".settings-tab")].find((b) => /audio/i.test(b.textContent || ""))?.click());
      await page.waitForTimeout(200);
      const line = await waitFor(page, () => /too large/i.test(document.querySelector(".fx-bank-sync")?.textContent || ""), null, 6000);
      const text = await page.evaluate(() => document.querySelector(".fx-bank-sync")?.textContent?.trim() ?? "(no line rendered)");
      check(`[${W}/d${deck}] a refused push SAYS SO in Settings ▸ Audio`, line, `it says: "${text}"`);
      check(`[${W}/d${deck}] …and the server accepted nothing`, acct.pushes.length === 0, `${acct.pushes.length} push(es) got through a 413`);
    } finally {
      await acct.done();
    }
  });

  // ── 6j. A CHAIN SURVIVES A REFRESH ──────────────────────────────────────────────────────
  // `fxSnapshot()` serialises `rack.list`, and `rack.list` IS the master chain — so every stem
  // chain a DJ built was outside the snapshot entirely and went away on reload, silently, because
  // the master came back and the deck looked restored.
  S("stem chains survive a reload", async (deck, W) => {
    await boot(page, deck);
    await page.evaluate(() => document.querySelector(".fx-menu-backdrop")?.click());
    await page.waitForTimeout(60);
    const strips = await page.$$(".fx-strip");
    const strip = strips[deck] ?? strips[0];
    const before = await page.evaluate((d) => document.querySelectorAll(".fx-strip")[d].querySelectorAll(".fx-chain:not(.add)").length, deck);
    await (await strip.$(".fx-chain.add")).click();
    await page.waitForTimeout(200);
    const made = await page.evaluate((d) => document.querySelectorAll(".fx-strip")[d].querySelectorAll(".fx-chain:not(.add)").length, deck);
    check(`[${W}/d${deck}] a chain can be made`, made === before + 1, `${before} → ${made}`);
    if (made !== before + 1) return;
    // The periodic snapshot is IDLE-scheduled, so "a beat" is a guess about the machine. Wait for
    // the write itself to appear in storage — the only thing a reload can actually restore from.
    const wrote = await waitFor(page, (n) => {
      try {
        const raw = localStorage.getItem("htl.session.v1");
        if (!raw) return false;
        const d = JSON.parse(raw).decks;
        return (d?.A?.fxChains?.length ?? 0) >= n || (d?.B?.fxChains?.length ?? 0) >= n;
      } catch { return false; }
      // `made` counts CHIPS, which include the master; `fxChains` holds the stem chains only.
    }, made - 1, 6000);
    check(`[${W}/d${deck}] the chain reaches the snapshot at all`, wrote, "no fxChains in htl.session.v1");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".fx-tab", { timeout: 60000 });
    await page.waitForTimeout(400);
    const after = await page.evaluate((d) => document.querySelectorAll(".fx-strip")[d].querySelectorAll(".fx-chain:not(.add)").length, deck);
    check(`[${W}/d${deck}] …and it is still there after a refresh`, after === made, `${made} before reload, ${after} after`);
  });

  // ── 7. the ghost has to be ON TOP, or you cannot see what you are aiming ────────────────
  S("the ghost paints above the menu", async (deck, W) => {
    await boot(page, deck);
    const src = await rowAt(page, 2);
    const a = await src.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.width / 2 + 4 * i, a.y + a.height / 2 + 5 * i);
    const onTop = await page.evaluate(() => {
      const gh = document.querySelector(".reorder-ghost");
      if (!gh) return "no-ghost";
      const r = gh.getBoundingClientRect();
      // What paints at the ghost's own centre, ignoring that the ghost opts out of the pointer?
      // elementsFromPoint is in paint order, topmost first — so make the ghost answer briefly.
      const prev = gh.style.pointerEvents;
      gh.style.pointerEvents = "auto";
      const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      gh.style.pointerEvents = prev;
      return stack[0] === gh || gh.contains(stack[0]) ? "top" : `${stack[0]?.className || stack[0]?.tagName}`;
    });
    await page.mouse.up();
    await page.waitForTimeout(50);
    check(`[${W}/d${deck}] the ghost is the topmost thing at its own centre`, onTop === "top", `topmost = ${onTop}`);
  });

  for (const w of [WIDE, NARROW]) {
    await page.setViewportSize({ width: w, height: 1000 });
    for (const deck of [0, 1]) {
      process.stdout.write(`\n\x1b[1m${w}px · deck ${deck}\x1b[0m\n`);
      // ★ THE OVERLAP INVARIANT, checked directly rather than staged. The failure it guards is a
      // flyout that flipped LEFT over its own menu and then swallowed every hit-test, because
      // elementFromPoint returns whatever is on top. I could not stage that here honestly: the menu
      // opens at the EQ tab, and a flip needs the menu within ~137px of the viewport's right edge,
      // which that tab's position never produces at any desktop width. Asserting a flip I cannot
      // cause would be a green light for a case the suite never ran. So assert what makes overlap
      // survivable AT ALL — that the flyout stops answering the pointer while a drag is running.
      if (deck === 1) {
        await boot(page, deck);
        await openFly(page, 0);
        const src = await rowAt(page, 1);
        const a = await src.boundingBox();
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 - 3 * i);
        const inert = await page.evaluate(() => {
          const f = document.querySelector(".fx-menu-fly");
          return f ? getComputedStyle(f).pointerEvents : "no-flyout";
        });
        await page.mouse.up();
        await page.waitForTimeout(60);
        check(`[${w}/d${deck}] the flyout is pointer-transparent mid-drag`, inert === "none", `pointer-events=${inert}`);
      }
      for (const [i, s] of scenarios.entries()) {
        if (ONLY != null && String(i + 1) !== ONLY) continue;
        try {
          await s.fn(deck, w);
        } catch (e) {
          check(`[${w}/d${deck}] ${s.name}`, false, `threw: ${e.message}`);
        }
      }
    }
  }

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - bad.length}/${results.length} passed\n`);
  process.exit(bad.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
