#!/usr/bin/env node
// DOCKLAB — sweep desktop panel placements across viewport sizes.
//
// Written because two operator-reported regressions ("the right dock doesn't extend to the
// bottom", "centre is anchored to the top instead of the middle") could not be reproduced — at
// ONE viewport, 2327x1179. A single measurement has nothing to disagree with, and a panel bug
// that depends on window size is invisible from a window that is big enough. So: sweep, and let
// the size at which it breaks be the finding.
//
// Usage: node scripts/phonelab/docklab.mjs [--url http://localhost:5173/]

import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function findChrome() {
  const c = resolve(homedir(), ".cache/ms-playwright");
  if (existsSync(c))
    for (const d of readdirSync(c).filter((x) => x.startsWith("chromium")).sort().reverse())
      for (const r of ["chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/chrome", "chrome-linux/headless_shell"]) {
        const p = resolve(c, d, r);
        if (existsSync(p)) return p;
      }
  for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/chromium"]) if (existsSync(p)) return p;
  return null;
}
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const URL_ = arg("url", "http://localhost:5173/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Desktop sizes only (all > 768px wide, so the phone sheet never applies), from a laptop at
// 125% scale up to the big monitor the original "cannot reproduce" was measured on.
const SIZES = (arg("sizes", "1366x700,1920x1080")).split(",").map((s) => s.split("x").map(Number));
const MODES = ["left", "right", "center", "bottom"];
// ★ FOUR PANELS, NOT ONE. The first sweep measured only the Library and came back clean, which
// says nothing about the other three — and SettingsPanel is the one whose placement plumbing
// changed most (it went from reading settings.settingsDock itself to taking a resolved prop).
// The chin's button order is Library / Settings / People / Session.
const PANELS = [
  { key: "library", field: "libraryDock", chin: 0, panelCls: "lib-panel" },
  { key: "settings", field: "settingsDock", chin: 1, panelCls: "settings-panel" },
  { key: "people", field: "peopleDock", chin: 2, panelCls: "people-screen" },
  { key: "session", field: "sessionDock", chin: 3, panelCls: "social-screen" },
];

const SET_DOCK = (field, mode) => `(() => {
  const k='htl.settings.v1'; const s=JSON.parse(localStorage.getItem(k)||'{}');
  s[${JSON.stringify(field)}]=${JSON.stringify(mode)};
  // ★ CLEAR THE PERSISTED OPEN-STATE, BOTH KEYS. htl:libOpen and htl:rightDock survive a reload
  // and restore a panel of their own choosing. With them left alone, a reload reopens (say)
  // Settings, the "already open" guard below sees a backdrop and skips its click, and the run
  // measures Settings while the row says "people". That is how this harness first reported
  // People and Session as ignoring their placement in all four modes — a clean, plausible,
  // entirely fabricated bug. Hence also the panel-identity assertion after the click.
  try { localStorage.removeItem('htl:libOpen'); localStorage.removeItem('htl:rightDock'); } catch {}
  localStorage.setItem(k, JSON.stringify(s)); return s[${JSON.stringify(field)}]; })()`;

const PROBE = `(() => {
  const bd = document.querySelector('.modal-backdrop');
  if (!bd) return { open:false };
  const b = bd.getBoundingClientRect();
  const p = bd.querySelector(':scope > .panel');
  const pr = p ? p.getBoundingClientRect() : null;
  const cs = getComputedStyle(bd);
  return { open:true, cls: bd.className.trim(), cls_panel: p ? p.className.trim() : '',
    backdrop:[+b.top.toFixed(1), +b.bottom.toFixed(1), +b.height.toFixed(1)],
    panel: pr ? [+pr.top.toFixed(1), +pr.bottom.toFixed(1), +pr.height.toFixed(1)] : null,
    align: cs.alignItems, vh: innerHeight,
    handles: bd.querySelectorAll('.dock-resizer').length }; })()`;

const exe = findChrome();
if (!exe) { console.error("docklab: no Chromium found."); process.exit(2); }
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });

console.log("\ndocklab — desktop panel placement sweep\n");
console.log("  viewport    panel     mode     panel top  panel bottom  gap top  gap bot  handles  verdict");
const bad = [];
for (const [W, H] of SIZES) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  await sleep(1200);
  for (const panel of PANELS) for (const mode of MODES) {
    await page.evaluate(SET_DOCK(panel.field, mode));
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(1600);
    // Open the Library dock — but only if it is not ALREADY open. `htl:libOpen` persists in
    // localStorage, so after a reload the dock restores itself and a blind click TOGGLES IT
    // SHUT. The first run of this harness did exactly that and reported "panel did not open"
    // for right and bottom at every single size — a clean, plausible, entirely self-inflicted
    // result. An instrument that creates the state it reports is worse than no instrument.
    await page.evaluate(`(() => {
      if (document.querySelector('.modal-backdrop')) return 'already open';
      const b=[...document.querySelectorAll('.chin button')][${panel.chin}];
      if(b) b.click(); return 'clicked'; })()`);
    await sleep(1100); // let the post-load settings sync land before probing
    const r = await page.evaluate(PROBE);
    // ★ ASSERT THE MODE ACTUALLY TOOK, not just that a panel opened. The app syncs settings
    // from the dev backend after load and can clobber the localStorage written a moment earlier,
    // so a reload sometimes renders the PREVIOUS iteration's placement. That produced rows
    // reading "settings / bottom" while the geometry was plainly centre, and "settings / center"
    // while it was plainly an edge dock — a one-step lag, invisible in any single run and caught
    // only because the same combination disagreed with itself across viewport sizes. The
    // backdrop's own class IS the resolved placement, so it is the honest thing to check.
    if (r.open && !r.cls.includes("dock-" + mode)) {
      const v = `✗ MODE DID NOT TAKE (rendered ${r.cls.replace('modal-backdrop','').trim()}) — inconclusive`;
      console.log(`  ${String(W+'x'+H).padEnd(11)} ${panel.key.padEnd(9)} ${mode.padEnd(8)} ${v}`); bad.push([W,H,panel.key,mode,v]); continue; }
    if (r.open && !r.cls_panel.includes(panel.panelCls)) {
      const v = `✗ WRONG PANEL OPENED (${r.cls_panel}) — inconclusive`;
      console.log(`  ${String(W+'x'+H).padEnd(11)} ${panel.key.padEnd(9)} ${mode.padEnd(8)} ${v}`); bad.push([W,H,panel.key,mode,v]); continue; }
    if (!r.open) { const v = "✗ NEVER OPENED — inconclusive, not a pass";
      console.log(`  ${String(W+'x'+H).padEnd(11)} ${panel.key.padEnd(9)} ${mode.padEnd(8)} ${v}`); bad.push([W,H,panel.key,mode,v]); continue; }
    const gapTop = r.panel ? r.panel[0] : null;
    const gapBot = r.panel ? +(r.vh - r.panel[1]).toFixed(1) : null;
    let verdict = "ok";
    if (mode === "right" || mode === "left") {
      // an edge dock must span the full height below the chin
      if (gapBot > 2) { verdict = `✗ ${gapBot}px SHORT of the bottom`; bad.push([W,H,panel.key,mode,verdict]); }
    } else if (mode === "center") {
      // ★ EQUAL GAPS IS NOT ENOUGH, and scoring it that way handed me a false pass on the very
      // bug I was hunting: a panel that fills the whole viewport has gapTop === gapBot === 0 and
      // sails through a symmetry check. "Centred" means symmetric AND inset. A full-bleed box
      // whose content sits at the top is exactly what "centre is anchored to the top" looks like.
      if (gapTop < 2 && gapBot < 2) { verdict = "✗ FULL-BLEED, not centred (ignoring its placement)"; bad.push([W,H,panel.key,mode,verdict]); }
      else if (Math.abs(gapTop - gapBot) > 4) { verdict = `✗ NOT centred (${gapTop} vs ${gapBot})`; bad.push([W,H,panel.key,mode,verdict]); }
    } else if (mode === "bottom") {
      // A bottom sheet is a partial-height panel pinned to the bottom edge. One that starts at
      // y=0 is not a sheet, it is a panel ignoring the setting.
      if (gapTop < 2) { verdict = "✗ FULL-HEIGHT, not a bottom sheet (ignoring its placement)"; bad.push([W,H,panel.key,mode,verdict]); }
    }
    console.log(`  ${String(W+'x'+H).padEnd(11)} ${panel.key.padEnd(9)} ${mode.padEnd(8)} ${String(r.panel?.[0]).padStart(9)} ${String(r.panel?.[1]).padStart(13)} ${String(gapTop).padStart(8)} ${String(gapBot).padStart(8)} ${String(r.handles).padStart(8)}  ${verdict}`);
  }
  await page.close();
}
console.log(bad.length ? `\n✗ ${bad.length} anomaly(ies) found.\n` : "\n✓ every placement correct at every size swept.\n");
await browser.close();
process.exit(bad.length ? 1 : 0);
