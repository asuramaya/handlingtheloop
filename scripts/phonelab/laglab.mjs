#!/usr/bin/env node
// LAGLAB — measure the board's RESPONSIVENESS, not its layout.
//
// Why this exists: "it feels laggy" is the one bug report that cannot be acted on, because every
// engineer reading it immediately has a favourite suspect and no way to be told they are wrong.
// phonelab answers "is the board the right SHAPE"; this answers "does the main thread STALL", and
// it answers it per GESTURE, so a stall has an owner instead of being a property of the app.
//
// What it records, continuously, and slices by gesture window:
//   • long tasks (PerformanceObserver 'longtask') — anything ≥50 ms that blocked input
//   • frame gaps (rAF deltas) — what the eye actually sees, which a long-task count can miss
//     when the jank is many 30 ms frames rather than one 300 ms freeze
//   • TBT (total blocking time): the part of each long task over 50 ms, summed — the standard
//     single number for "how much input was refused during this window"
//
// CPU THROTTLING IS THE POINT. A desktop dev machine runs this board with room to spare; the
// operator's phone does not. --cpu 4 (the default) is Lighthouse's mid-tier-mobile setting. A
// green run at 1x proves nothing about the device the bug was reported from.
//
// Usage:
//   node scripts/phonelab/laglab.mjs                              # live site, 390x844, 4x throttle
//   node scripts/phonelab/laglab.mjs --url http://localhost:5173/ # a dev build
//   node scripts/phonelab/laglab.mjs --cpu 1                      # unthrottled, for a baseline
//   node scripts/phonelab/laglab.mjs --w 1280 --h 800 --desktop    # desktop shape
//   node scripts/phonelab/laglab.mjs --json
//
// Needs: playwright-core + a Chromium.

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
const has = (k) => process.argv.includes(`--${k}`);
const DESKTOP = has("desktop");
const W = +arg("w", DESKTOP ? 1280 : 390), H = +arg("h", DESKTOP ? 800 : 844);
const URL_ = arg("url", "https://handlingtheloop.com/");
const CPU = +arg("cpu", 4);
const JSON_ONLY = has("json");
const PROFILE = has("profile"); // also run the JS sampling profiler and name the hot functions
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The recorder. Installed BEFORE the app's own scripts run, so nothing in the boot path is
// invisible to it. `__lag.mark(name)` opens a window; everything observed lands in one flat list
// and is sliced by those marks at report time — so adding a gesture never means adding a counter.
const RECORDER = `
window.__lag = { tasks: [], frames: [], marks: [] };
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lag.tasks.push({ t: e.startTime, d: e.duration }); })
    .observe({ entryTypes: ["longtask"] });
} catch (e) { window.__lag.noLongtask = String(e); }
let last = performance.now();
const tick = (now) => { window.__lag.frames.push({ t: now, d: now - last }); last = now; requestAnimationFrame(tick); };
requestAnimationFrame(tick);
window.__lag.mark = (name) => { window.__lag.marks.push({ name, t: performance.now() }); };
`;

const exe = findChrome();
if (!exe) { console.error("laglab: no Chromium found (~/.cache/ms-playwright or PATH)."); process.exit(2); }

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage(
  DESKTOP ? { viewport: { width: W, height: H } } : { viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
);
page.on("pageerror", (e) => process.stderr.write(`  [page error] ${e.message}\n`));
await page.addInitScript(RECORDER);

const cdp = await page.context().newCDPSession(page);
if (CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
// The sampling profiler NAMES the blocking work. A long-task window tells you WHEN the main
// thread stalled; only a profile tells you WHAT was on it — and against a minified bundle the
// names are mangled, so point --profile at a dev server (unminified) to get real ones.
if (PROFILE) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start"); }

await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.evaluate(`window.__lag.mark("boot")`);
await sleep(4000);

// Focus a deck — on a phone only the focused deck shows its control surface, so every gesture
// below would otherwise be aimed at a display:none bank (phonelab's own hard-won lesson).
await page.evaluate(`(() => { const b = document.querySelector('.bank'); if (b) b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); })()`);
await sleep(600);

const tabNames = await page.evaluate(`(() => {
  const bank = document.querySelector('.bank.focused') || document.querySelector('.bank');
  const tabs = bank ? [...bank.querySelectorAll('.fx-rack-bar .fx-tab:not(.fx-page-close)')] : [];
  return tabs.map((t) => (t.textContent || '').trim());
})()`);

// ── the gestures ────────────────────────────────────────────────────────────────────────────
// Each is marked, then given time to settle, so its window holds its own cost and not its
// neighbour's tail.
async function gesture(name, body, settle = 1400) {
  await page.evaluate(`window.__lag.mark(${JSON.stringify(name)})`);
  await body();
  await sleep(settle);
}

await gesture("idle-baseline", async () => {}, 2500);

for (const want of tabNames) {
  await gesture(`tab:${want}`, async () => {
    await page.evaluate(`((want) => {
      const bank = document.querySelector('.bank.focused') || document.querySelector('.bank');
      const tabs = bank ? [...bank.querySelectorAll('.fx-rack-bar .fx-tab:not(.fx-page-close)')] : [];
      const tab = tabs.find((t) => (t.textContent || '').trim() === want);
      if (tab) tab.click();
    })(${JSON.stringify(want)})`);
  });
}

await gesture("power-toggle", async () => {
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('.fx-bar button, .fx-power')].find((x) => /⏻/.test(x.textContent || '') || x.classList.contains('fx-power'));
    if (b) b.click();
  })()`);
});

// A knob DRAG, not a click: the sustained pointermove stream is where a per-move re-render or a
// per-move broadcast shows up, and a single click cannot see it.
await gesture("knob-drag", async () => {
  const box = await page.evaluate(`(() => {
    const k = document.querySelector('.fx-panel canvas, .fx-stage canvas');
    if (!k) return null;
    const r = k.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!box) return;
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(box.x + Math.sin(i / 4) * (box.w / 3), box.y + Math.cos(i / 5) * (box.h / 3));
    await sleep(16);
  }
  await page.mouse.up();
});

await gesture("idle-after", async () => {}, 2500);

let profile = null;
if (PROFILE) profile = (await cdp.send("Profiler.stop")).profile;
const raw = await page.evaluate(`(() => ({ tasks: window.__lag.tasks, frames: window.__lag.frames, marks: window.__lag.marks, noLongtask: window.__lag.noLongtask }))()`);
await browser.close();

// ── report ──────────────────────────────────────────────────────────────────────────────────
const windows = raw.marks.map((m, i) => ({ name: m.name, from: m.t, to: raw.marks[i + 1]?.t ?? Infinity }));
const rows = windows.map((w) => {
  const tasks = raw.tasks.filter((t) => t.t >= w.from && t.t < w.to);
  const frames = raw.frames.filter((f) => f.t >= w.from && f.t < w.to);
  const tbt = tasks.reduce((s, t) => s + Math.max(0, t.d - 50), 0);
  const worstTask = tasks.reduce((s, t) => Math.max(s, t.d), 0);
  const worstFrame = frames.reduce((s, f) => Math.max(s, f.d), 0);
  const p95 = frames.length ? [...frames].sort((a, b) => a.d - b.d)[Math.floor(frames.length * 0.95)].d : 0;
  return { window: w.name, ms: +(Math.min(w.to, raw.frames.at(-1)?.t ?? w.to) - w.from).toFixed(0), longTasks: tasks.length, tbtMs: +tbt.toFixed(0), worstTaskMs: +worstTask.toFixed(0), p95FrameMs: +p95.toFixed(1), worstFrameMs: +worstFrame.toFixed(1) };
});

if (JSON_ONLY) { console.log(JSON.stringify({ url: URL_, viewport: `${W}x${H}`, cpuThrottle: CPU, tabs: tabNames, rows }, null, 2)); process.exit(0); }

console.log(`\nlaglab — ${URL_}  ${W}x${H}  cpu ${CPU}x${raw.noLongtask ? `  ⚠ longtask observer unavailable: ${raw.noLongtask}` : ""}`);
console.log(`rack tabs found: ${tabNames.join(" ") || "NONE"}\n`);
console.log("  window            span   tasks    TBT   worst   p95f   worstf");
for (const r of rows) {
  const hot = r.tbtMs > 200 || r.worstFrameMs > 200;
  console.log(
    `  ${(hot ? "! " : "  ") + r.window.padEnd(16)}${String(r.ms).padStart(5)}  ${String(r.longTasks).padStart(5)}  ${String(r.tbtMs).padStart(5)}  ${String(r.worstTaskMs).padStart(6)}  ${String(r.p95FrameMs).padStart(5)}  ${String(r.worstFrameMs).padStart(7)}`,
  );
}
// ── who was on the thread ───────────────────────────────────────────────────────────────────
// Self time only. A parent frame's total time tells you the call tree; self time tells you the
// function that was actually executing when the clock ran, which is the one worth changing.
if (profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas ?? [];
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0) / 1000));
  const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
  const rowsP = [...self.entries()]
    .map(([id, ms]) => { const n = byId.get(id); const f = n?.callFrame ?? {}; return { ms, name: f.functionName || "(anonymous)", where: `${(f.url || "").split("/").pop()}:${(f.lineNumber ?? 0) + 1}` }; })
    .filter((r) => r.ms >= 5)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 18);
  console.log("\n  on the main thread (self time, whole run)");
  console.log("     ms     %   function                                where");
  for (const r of rowsP) console.log(`  ${r.ms.toFixed(0).padStart(6)}  ${((r.ms / total) * 100).toFixed(1).padStart(4)}   ${r.name.slice(0, 36).padEnd(36)}  ${r.where}`);
}

console.log("\n  TBT = blocking time over the 50 ms threshold, summed. p95f/worstf = frame gaps (16.7 ms = smooth).");
console.log("  A '!' marks a window that blocked >200 ms or dropped a frame longer than 200 ms.\n");
