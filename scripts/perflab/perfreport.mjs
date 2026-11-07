#!/usr/bin/env node
// PERFREPORT — read a Settings ▸ Debug ▸ Performance capture (perf-capture-*.json) and say where the
// time went: frame pacing, the long frames and the code the browser blamed for them, slow inputs,
// heap, and audio dropouts.
//
// Long Animation Frame entries name a script by URL + CHARACTER OFFSET. With --dist (default
// ./dist/assets) the offset is looked up in the built bundle, so a minified `X` becomes the source
// text it starts with, which is enough to find it. The bundle must be the SAME build the capture
// was taken on (hashed filenames make a mismatch obvious: the file is simply missing).
//
//   node scripts/perflab/perfreport.mjs <perf-capture.json> [--dist dist/assets]

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: perfreport.mjs <perf-capture.json> [--dist dist/assets]");
  process.exit(2);
}
const di = args.indexOf("--dist");
const DIST = resolve(di > -1 ? args[di + 1] : "dist/assets");
const c = JSON.parse(readFileSync(file, "utf8"));
if (c.kind !== "htl-perf") throw new Error("not an htl perf capture");

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const ms = (n) => `${n.toFixed(1)} ms`;

console.log(`\nperf capture ${new Date(c.capturedAt).toISOString()}  ${(c.durationMs / 1000).toFixed(1)} s`);
console.log(`env: dpr ${c.env.dpr}  viewport ${c.env.viewport}  cores ${c.env.cores}  mem ${c.env.deviceMemoryGb} GB  ${String(c.env.ua).match(/Chrome\/[\d.]+|Firefox\/[\d.]+|Version\/[\d.]+ Safari/)?.[0] ?? ""}`);
for (const k of Object.keys(c.env).filter((k) => k.startsWith("no_"))) console.log(`  ⚠ browser lacks ${k.slice(3)} — that section is empty for that reason, not because it was clean`);

// Frames
const f = c.frames;
const slow = f.filter((d) => d > 25);
console.log(`\nFRAMES  ${f.length}  p50 ${ms(q(f, 0.5))}  p95 ${ms(q(f, 0.95))}  p99 ${ms(q(f, 0.99))}  max ${ms(Math.max(0, ...f))}`);
console.log(`  slow (>25 ms): ${slow.length} (${((slow.length / Math.max(1, f.length)) * 100).toFixed(1)}%), time lost to them ${ms(sum(slow.map((d) => d - 16.7)))}`);

// Long frames, aggregated by blamed script
const bundles = new Map();
const where = (src) => {
  const [name, pos] = src.split(":");
  if (!name || pos === "-1") return src;
  if (!bundles.has(name)) {
    const p = resolve(DIST, name);
    bundles.set(name, existsSync(p) ? readFileSync(p, "utf8") : null);
  }
  const text = bundles.get(name);
  if (!text) return `${src} (bundle not found in ${DIST})`;
  return `${src}  ${text.slice(+pos, +pos + 110).replace(/\s+/g, " ")}`;
};
const lo = c.loafs;
console.log(`\nLONG FRAMES  ${lo.length}  total ${ms(sum(lo.map((l) => l.d)))}  blocking ${ms(sum(lo.map((l) => l.block)))}  render part ${ms(sum(lo.map((l) => l.render)))}`);
const byScript = new Map();
let unattributed = 0;
for (const l of lo) {
  const scripted = sum(l.scripts.map((s) => s.d));
  unattributed += Math.max(0, l.d - scripted);
  for (const s of l.scripts) {
    const k = `${s.inv} | ${s.fn || "(anon)"} | ${s.src}`;
    const e = byScript.get(k) ?? { n: 0, d: 0, layout: 0, max: 0, src: s.src };
    e.n++;
    e.d += s.d;
    e.layout += s.layout;
    e.max = Math.max(e.max, s.d);
    byScript.set(k, e);
  }
}
console.log(`  not in any script (style/layout/paint/GC/other): ${ms(unattributed)}`);
for (const [k, e] of [...byScript].sort((a, b) => b[1].d - a[1].d).slice(0, 15)) {
  console.log(`  ${ms(e.d).padStart(10)}  ×${e.n}  max ${ms(e.max)}  forced layout ${ms(e.layout)}  ${k.split(" | ").slice(0, 2).join(" ")}`);
  console.log(`              ${where(e.src)}`);
}
console.log("  worst five:");
for (const l of [...lo].sort((a, b) => b.d - a.d).slice(0, 5)) {
  console.log(`   @${(l.t / 1000).toFixed(1)}s ${ms(l.d)} (render ${ms(l.render)})  ${l.scripts.map((s) => `${s.inv}/${s.fn || "anon"} ${ms(s.d)}`).join(" ; ")}`);
}

// Inputs
// Hover enter/leave/over/out are not interactions anyone waits on; they only add noise here.
const ev = c.events.filter((e) => !/^(pointer|mouse)(enter|leave|over|out)$/.test(e.name));
console.log(`\nINPUTS slower than a frame: ${ev.length}`);
const byName = new Map();
for (const e of ev) {
  const k = `${e.name} ${e.target}`;
  const x = byName.get(k) ?? [];
  x.push(e);
  byName.set(k, x);
}
for (const [k, xs] of [...byName].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
  console.log(`  ${String(xs.length).padStart(4)}×  p95 ${ms(q(xs.map((e) => e.d), 0.95))}  wait ${ms(q(xs.map((e) => e.wait), 0.95))}  handler ${ms(q(xs.map((e) => e.proc), 0.95))}  ${k}`);
}

// Heap + audio
const s = c.samples;
const heap = s.map((x) => x.heapMb).filter((x) => x != null);
if (heap.length) console.log(`\nHEAP  start ${heap[0]} MB  max ${Math.max(...heap)} MB  end ${heap.at(-1)} MB`);
const au = s.filter((x) => x.audio);
if (au.length) {
  const a0 = au[0].audio;
  const a1 = au.at(-1).audio;
  console.log(`AUDIO  dropouts (worklet underruns) ${a1.underruns - a0.underruns}  output latency ${a1.outputLatencyMs} ms  base ${a1.baseLatencyMs} ms  state ${a1.state}  stems ${a1.stems || "-"}  stretch ${a1.stretch ?? "?"}`);
  for (let i = 1; i < au.length; i++) {
    const d = au[i].audio.underruns - au[i - 1].audio.underruns;
    if (d > 0) console.log(`  @${(au[i].t / 1000).toFixed(0)}s +${d} underruns`);
  }
}
if (c.marks.length) console.log(`\nMARKS  ${c.marks.map((m) => `@${(m.t / 1000).toFixed(1)}s ${m.label}`).join("  ")}`);

// Timed app work (waveform rebuilds etc.), if this build recorded it.
if (c.work) {
  console.log("\nAPP WORK (ms per call)");
  for (const [k, xs] of Object.entries(c.work).sort()) {
    const d = xs.map((x) => x[1]);
    console.log(`  ${k.padEnd(12)} ×${String(d.length).padStart(5)}  p50 ${q(d, 0.5).toFixed(2)}  p95 ${q(d, 0.95).toFixed(2)}  max ${Math.max(...d).toFixed(2)}  total ${sum(d).toFixed(0)}`);
  }
}
