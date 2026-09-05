#!/usr/bin/env node
// PHONELAB — measure the phone board's layout in a REAL phone viewport.
//
// Why this exists: the mobile board has now been broken twice by changes that looked correct in
// the only state anyone screenshotted, and neither break was reachable from the desktop window
// the dev normally has open. Chrome's extension cannot resize a window here (outerWidth reports
// 0), so "check it on a phone" kept resolving to "reason about it and hope". This launches
// Chromium at an actual phone size with isMobile + hasTouch, so `(max-width: 768px)` and
// `(pointer: coarse)` both match the way they do on glass.
//
// It answers ONE question by default, the one the operator asked for:
//   does the deck stay exactly the same height between the MIX page and the FX page?
//
// Usage:
//   node scripts/phonelab/phonelab.mjs                     # 390x844 portrait
//   node scripts/phonelab/phonelab.mjs --w 844 --h 390     # landscape
//   node scripts/phonelab/phonelab.mjs --url http://localhost:5173/
//   node scripts/phonelab/phonelab.mjs --shot out.png      # also save a screenshot of each page
//   node scripts/phonelab/phonelab.mjs --device COMP       # open a named effect rather than the first
//
// Needs: playwright-core + a Chromium, and a dev server already running.

import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function findChrome() {
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

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const W = +arg("w", 390), H = +arg("h", 844);
const URL_ = arg("url", "http://localhost:5173/");
const SHOT = arg("shot", null);
const DEVICE = arg("device", null); // which device tab to open (default: the first)

// Everything whose height must not change when the page turns, plus the strip whose POSITION
// must not change. Measured from the same element set on both pages so the diff is meaningful.
const PROBE = `(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const b = e.getBoundingClientRect(); return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), h: +b.height.toFixed(1) }; };
  const bank = document.querySelector('.bank.focused') || document.querySelector('.bank');
  const bankR = bank && bank.getBoundingClientRect();
  const strip = bank && bank.querySelector('.fx-rack-bar');
  const stripR = strip && strip.getBoundingClientRect();
  return {
    page: bank ? (bank.classList.contains('page-fx') ? 'fx' : 'perform') : 'no-bank',
    lanesFlank: r('.lanes-flank'),
    decksThird: r('.decks-third'),
    lanes: r('.lanes'),
    bank: bankR ? { top: +bankR.top.toFixed(1), bottom: +bankR.bottom.toFixed(1), h: +bankR.height.toFixed(1) } : null,
    fxStrip: stripR ? { top: +stripR.top.toFixed(1), bottom: +stripR.bottom.toFixed(1), h: +stripR.height.toFixed(1) } : null,
    viewport: [innerWidth, innerHeight],
    coarse: matchMedia('(pointer: coarse)').matches,
    phone: matchMedia('(max-width: 768px)').matches,
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exe = findChrome();
if (!exe) { console.error("phonelab: no Chromium found (~/.cache/ms-playwright or PATH)."); process.exit(2); }

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
page.on("pageerror", (e) => process.stderr.write(`  [page error] ${e.message}\n`));
await page.goto(URL_, { waitUntil: "domcontentloaded" });
await sleep(2500);

// Focus a deck first: on a phone only the FOCUSED deck shows its control surface, so an
// unfocused board would measure a bank that is display:none and report a meaningless 0.
await page.evaluate(`(() => { const b = document.querySelector('.bank'); if (b) b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); })()`);
await sleep(400);

const before = await page.evaluate(PROBE);
if (SHOT) await page.screenshot({ path: SHOT.replace(/\.png$/, "") + "-perform.png" });

// Turn to the FX page the way a finger does: tap a device tab in the rack bar.
const tapped = await page.evaluate(`(() => {
  const bank = document.querySelector('.bank.focused') || document.querySelector('.bank');
  const tabs = bank ? [...bank.querySelectorAll('.fx-rack-bar .fx-tab:not(.fx-page-close)')] : [];
  const want = ${JSON.stringify(DEVICE)};
  const tab = want ? tabs.find((t) => (t.textContent || '').trim().toUpperCase().startsWith(want.toUpperCase())) : tabs[0];
  if (!tab) return null;
  tab.click();
  return (tab.textContent || '').trim().slice(0, 12);
})()`);
await sleep(500);

const after = await page.evaluate(PROBE);
if (SHOT) await page.screenshot({ path: SHOT.replace(/\.png$/, "") + "-fx.png" });

await browser.close();

// ── report ──────────────────────────────────────────────────────────────────────────────────
const d = (a, b) => (a == null || b == null ? null : +(b - a).toFixed(1));
console.log(`\nphonelab — ${W}x${H}  (coarse: ${before.coarse}, max-width:768px: ${before.phone})`);
console.log(`tapped device tab: ${tapped ?? "NONE FOUND"}`);
console.log(`page: ${before.page} -> ${after.page}\n`);

const rows = [
  ["lanes-flank height", before.lanesFlank?.h, after.lanesFlank?.h],
  ["decks-third height", before.decksThird?.h, after.decksThird?.h],
  ["bank height", before.bank?.h, after.bank?.h],
  ["bank top", before.bank?.top, after.bank?.top],
  ["fx strip bottom", before.fxStrip?.bottom, after.fxStrip?.bottom],
  ["fx strip top", before.fxStrip?.top, after.fxStrip?.top],
];
console.log("  metric                 perform        fx         delta");
let bad = 0;
for (const [name, a, b] of rows) {
  const delta = d(a, b);
  const ok = delta === 0;
  if (!ok) bad++;
  console.log(`  ${name.padEnd(22)} ${String(a ?? "—").padStart(8)} ${String(b ?? "—").padStart(9)} ${String(delta ?? "—").padStart(10)}  ${ok ? "✓" : "✗ MOVED"}`);
}
// ★ A PASS THAT WAS NEVER TESTED IS NOT A PASS. If the tap did not actually turn the page, every
// delta is zero because nothing happened — the most dangerous possible green. This bit at
// 844x390: a phone in LANDSCAPE is wider than 768px, so the board takes the DESKTOP layout,
// `usePhone()` is false, and tapping a device tab does not open the FX page at all. The run
// reported six zeroes and told me nothing.
if (before.page === after.page) {
  console.log(
    `\n✗ INCONCLUSIVE — the page never turned (${before.page} -> ${after.page}).` +
      `\n  Every delta above is zero because nothing happened, not because nothing moved.` +
      (before.phone ? "" : "\n  This viewport is WIDER than 768px, so the board is on its DESKTOP layout and the FX page does not exist here.") +
      "\n",
  );
  process.exit(2);
}
console.log(
  bad === 0
    ? "\n✓ PASS — the deck and the FX strip are pixel-identical across the page turn.\n"
    : `\n✗ FAIL — ${bad} measurement(s) moved between the MIX page and the FX page.\n`,
);
process.exit(bad === 0 ? 0 : 1);
