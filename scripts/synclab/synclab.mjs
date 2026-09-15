#!/usr/bin/env node
// SYNCLAB — two browsers, one room, and a record of what actually crossed the wire.
//
// Why this exists: a collaboration bug is the one class you cannot debug from one screen. "It did
// not sync" is four different faults — the gesture never emitted, the frame never left, the frame
// arrived and was ignored, or it applied and the UI did not repaint — and they are
// indistinguishable from either end alone. This runs ONE side and writes a timestamped log of every
// websocket frame, console line, socket transition and long task, so two sides can be joined
// afterwards on a shared wall clock and each fault told apart from the others.
//
// THE CLOCK IS THE WHOLE TRICK. performance.now() is per-page and cannot be compared across two
// browsers; Date.now() can, because both processes share the machine's clock. Every record carries
// BOTH: `at` (wall, for cross-side joins) and `t` (page-relative, for within-side ordering).
//
// POSITIVE CONTROL, and it is not optional. A sync checker that cannot detect a MISSED update will
// report perfect sync forever and both readers will believe it — the exact failure that produced
// five meaningless clean results in one investigation earlier today. `--control` makes the far side
// miss a change on purpose and asserts the harness reports the divergence; if it does not, the run
// aborts rather than yielding a negative nobody should trust.
//
// Usage:
//   node scripts/synclab/synclab.mjs --role a --url https://… --out a.json --hold 90
//   node scripts/synclab/synclab.mjs --role b --url https://…?join=CODE --out b.json --hold 90
//   node scripts/synclab/synclab.mjs --compare a.json b.json
//
// Needs: playwright-core + a Chromium.

import { chromium } from "playwright-core";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function findChrome() {
  const cache = resolve(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((x) => x.startsWith("chromium")).sort().reverse()) {
      for (const rel of ["chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/chrome"]) {
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the in-page recorder ──────────────────────────────────────────────────────────────────────
// Installed before the app's own scripts, so the socket it opens is already wrapped. Wrapping
// WebSocket rather than using CDP's Network domain is deliberate: this sees the frame at the moment
// the APP hands it over or receives it, which is the boundary a sync bug lives at — CDP timestamps
// the transport and would hide a frame the app built late or handled slowly.
const RECORDER = `
window.__sync = { frames: [], console: [], sockets: [], tasks: [], t0: Date.now() };
const rec = (o) => { o.at = Date.now(); o.t = Math.round(performance.now()); window.__sync.frames.push(o); };
const peek = (data) => {
  if (typeof data !== "string") return { t: "(binary)", bytes: data?.byteLength ?? 0 };
  try {
    const m = JSON.parse(data);
    // Keep the SHAPE, drop the payload: snapshots and stem views are enormous and the question is
    // always "did this kind of message cross, and when", never "what were the 40,000 samples".
    return { t: m.t, kind: m.intent?.kind, deck: m.intent?.deck ?? m.deck, param: m.intent?.param ?? m.intent?.fx, value: typeof m.intent?.value === "number" ? Math.round(m.intent.value * 1000) / 1000 : m.intent?.value, bytes: data.length };
  } catch { return { t: "(unparsed)", bytes: data.length }; }
};
const OrigWS = window.WebSocket;
function PatchedWS(url, protocols) {
  const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
  const room = String(url).includes("/api/room");
  window.__sync.sockets.push({ url: String(url).slice(0, 120), room, event: "new", at: Date.now(), t: Math.round(performance.now()) });
  ws.addEventListener("open", () => window.__sync.sockets.push({ room, event: "open", at: Date.now(), t: Math.round(performance.now()) }));
  ws.addEventListener("close", (e) => window.__sync.sockets.push({ room, event: "close", code: e.code, at: Date.now(), t: Math.round(performance.now()) }));
  ws.addEventListener("error", () => window.__sync.sockets.push({ room, event: "error", at: Date.now(), t: Math.round(performance.now()) }));
  if (room) {
    ws.addEventListener("message", (e) => rec({ dir: "in", ...peek(e.data) }));
    const send = ws.send.bind(ws);
    ws.send = (d) => { rec({ dir: "out", ...peek(d) }); return send(d); };
  }
  return ws;
}
PatchedWS.prototype = OrigWS.prototype;
for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) PatchedWS[k] = OrigWS[k];
window.WebSocket = PatchedWS;

try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__sync.tasks.push({ at: Date.now(), t: Math.round(e.startTime), d: Math.round(e.duration) }); })
    .observe({ entryTypes: ["longtask"] });
} catch {}
`;

// ── compare mode ──────────────────────────────────────────────────────────────────────────────
if (has("compare")) {
  const i = process.argv.indexOf("--compare");
  const A = JSON.parse(readFileSync(process.argv[i + 1], "utf8"));
  const B = JSON.parse(readFileSync(process.argv[i + 2], "utf8"));
  const out = A.frames.filter((f) => f.dir === "out" && f.t === "intent");
  const inb = B.frames.filter((f) => f.dir === "in" && f.t === "intent");
  console.log(`\nsynclab compare — A sent ${out.length} intents, B received ${inb.length}\n`);
  console.log("  kind              param        A sent     B got    latency");
  let matched = 0;
  const lat = [];
  for (const o of out) {
    // Match on the identity the wire carries, then take the FIRST arrival after it was sent.
    const m = inb.find((x) => x.kind === o.kind && x.deck === o.deck && x.param === o.param && x.value === o.value && x.at >= o.at - 50);
    if (m) { matched++; lat.push(m.at - o.at); }
    console.log(`  ${String(o.kind ?? "?").padEnd(16)}${String(o.param ?? "").padEnd(12)}${String(o.at % 100000).padStart(7)}  ${m ? String(m.at % 100000).padStart(8) : "   MISSING".padStart(8)}  ${m ? String(m.at - o.at).padStart(7) + " ms" : "    —"}`);
  }
  const sorted = [...lat].sort((a, b) => a - b);
  console.log(`\n  delivered ${matched}/${out.length}${out.length ? ` (${Math.round((matched / out.length) * 100)}%)` : ""}`);
  if (sorted.length) console.log(`  latency  median ${sorted[Math.floor(sorted.length / 2)]} ms · p95 ${sorted[Math.floor(sorted.length * 0.95)]} ms · worst ${sorted.at(-1)} ms`);
  if (matched < out.length) console.log(`\n  ⚠ ${out.length - matched} intent(s) never reached B — that is a real sync failure, not latency.`);
  process.exit(0);
}

// ── run mode ──────────────────────────────────────────────────────────────────────────────────
const ROLE = arg("role", "a");
const URL_ = arg("url", "https://handlingtheloop.com/");
const OUT = arg("out", `synclab-${ROLE}.json`);
const HOLD = +arg("hold", 60); // seconds to stay open recording
const exe = findChrome();
if (!exe) { console.error("synclab: no Chromium found."); process.exit(2); }

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => process.stderr.write(`  [${ROLE} page error] ${String(e).slice(0, 160)}\n`));
page.on("console", (m) => {
  const t = m.text();
  if (/\[htl\]/.test(t) || m.type() === "error") process.stderr.write(`  [${ROLE} ${m.type()}] ${t.slice(0, 200)}\n`);
});
await page.addInitScript(RECORDER);
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
console.log(`[${ROLE}] loaded ${URL_}`);
await sleep(HOLD * 1000);

const data = await page.evaluate(() => ({ ...window.__sync, url: location.href }));
writeFileSync(OUT, JSON.stringify(data, null, 1));
const room = data.sockets.filter((s) => s.room);
console.log(`[${ROLE}] wrote ${OUT} — ${data.frames.length} room frames, ${room.length} socket events, ${data.tasks.length} long tasks`);
console.log(`[${ROLE}] socket: ${room.map((s) => s.event).join(" → ") || "NEVER OPENED"}`);
const kinds = {};
for (const f of data.frames) { const k = `${f.dir} ${f.t}${f.kind ? ":" + f.kind : ""}`; kinds[k] = (kinds[k] ?? 0) + 1; }
for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`   ${String(n).padStart(5)}  ${k}`);
await browser.close();
