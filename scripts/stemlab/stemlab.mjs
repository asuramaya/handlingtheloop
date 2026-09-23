#!/usr/bin/env node
// STEMLAB — how long does the main thread stop while a song's stems decode?
//
// Why this exists: 6f64a98 sliced decodeStemOpus on an 8 ms clock and the thread that recorded it
// (bc482ba8) says, in its own words, "the 1.4 s frame SHOULD now be a stutter" and "not re-measured
// since the mitigation deployed". A mitigation whose effect has never been observed is a belief.
// This runs the real encoder and the real decoder in Chromium and reports what the eye would see —
// the largest FRAME GAP — with the slice budget as the only thing that differs between the two runs.
//
// CPU THROTTLING IS THE POINT, same as laglab: the operator's phone is not this machine, and 4x is
// Lighthouse's mid-tier-mobile setting. A green run at 1x proves nothing about the device the bug
// came from.
//
// Usage:
//   node scripts/stemlab/stemlab.mjs                     # 4 stems x 4 min, 4x CPU, sliced vs not
//   node scripts/stemlab/stemlab.mjs --cpu 1             # desktop baseline
//   node scripts/stemlab/stemlab.mjs --seconds 120       # shorter stems
//   node scripts/stemlab/stemlab.mjs --slice 16          # a different budget
//   node scripts/stemlab/stemlab.mjs --grid            # yield primitive x competing animation
//   node scripts/stemlab/stemlab.mjs --json
//
// Needs: playwright-core + a Chromium.

import { build } from "vite";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(__dirname, "harness.ts");

function parseArgs(argv) {
  const a = { seconds: 240, stems: 4, cpu: 4, slice: 8 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--seconds": a.seconds = Number(v); i++; break;
      case "--stems": a.stems = Number(v); i++; break;
      case "--cpu": a.cpu = Number(v); i++; break;
      case "--slice": a.slice = Number(v); i++; break;
      case "--json": a.json = true; break;
      case "--sweep": a.sweep = true; break;
      case "--grid": a.grid = true; break;
      case "--idle-only": a.idleOnly = true; break;
      case "--only": a.only = v.split(","); i++; break;
      case "--reps": a.reps = Number(v); i++; break;
      default: break;
    }
  }
  return a;
}

function findChromium() {
  const cache = resolve(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache)) {
      for (const p of [
        resolve(cache, d, "chrome-linux/chrome"),
        resolve(cache, d, "chrome-headless-shell-linux64/chrome-headless-shell"),
      ]) {
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) if (existsSync(p)) return p;
  return null;
}

async function bundleHarness() {
  const out = await build({
    configFile: false,
    logLevel: "error",
    build: { write: false, minify: false, target: "esnext", lib: { entry: HARNESS, formats: ["iife"], name: "stemlab", fileName: () => "stemlab.js" } },
  });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
  if (!chunk) throw new Error("stemlab: bundle produced no chunk");
  return chunk.code;
}

const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "—");

function row(label, r) {
  console.log(
    `  ${label.padEnd(22)} ${f(r.wallMs, 0).padStart(7)} ms   ${f(r.maxFrameGapMs, 0).padStart(6)} ms   ` +
      `${String(r.gapsOver50).padStart(4)}  ${String(r.gapsOver100).padStart(5)}   ${f(r.tbtMs, 0).padStart(7)} ms   ` +
      `${String(r.bursts).padStart(6)}  ${String(r.maxBurst).padStart(5)}  ${f(r.maxBurstPos, 2).padStart(5)}  ${f(r.meanBurst, 1).padStart(6)}   ` +
      `${f(r.worstDropMB, 1).padStart(7)}  ${String(r.drops).padStart(5)}  ${f(r.biggestDropMB, 1).padStart(6)}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exe = findChromium();
  if (!exe) {
    console.error("stemlab: no Chromium found (looked in ~/.cache/ms-playwright and PATH).");
    process.exit(2);
  }
  process.stderr.write("stemlab: bundling harness…\n");
  const code = await bundleHarness();
  process.stderr.write(`stemlab: launching Chromium (${exe})\n`);
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info", "--js-flags=--expose-gc"] });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") process.stderr.write(`[page:${m.type()}] ${m.text()}\n`); });
    page.on("pageerror", (e) => process.stderr.write(`[pageerror] ${e.message}\n`));
    // A REAL ORIGIN, not about:blank: WebCodecs needs a secure context, and on an opaque origin
    // AudioDecoder is simply absent — which reads exactly like "this browser cannot do Opus".
    await page.route("https://stemlab.local/", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><meta charset=utf-8><title>stemlab</title>" }),
    );
    await page.goto("https://stemlab.local/");
    await page.addScriptTag({ content: code });

    const supported = await page.evaluate(() => globalThis.stemlabSupported());
    if (!supported) {
      console.error("stemlab: this Chromium has no Opus AudioDecoder — nothing measured. (Absence here is unreadable, not negative.)");
      process.exit(3);
    }

    // ★ THE INSTRUMENT MUST FAIL ON PURPOSE BEFORE ITS SILENCE MEANS ANYTHING (c5932a5f). Force a
    // collection at a known moment and check the frame watcher registers a heap DROP and a gap. If
    // it cannot see a GC we caused, "the heap did not move across the worst gap" says nothing.
    const ctrl = await page.evaluate(() => globalThis.stemlabGcControl());
    console.log(
      `\n  GC control: forced=${ctrl.forced}  heapReadable=${ctrl.heapRead}  ` +
        `drop seen ${f(ctrl.seenDropMB, 1)} MB, gap ${f(ctrl.gapMs, 0)} ms` +
        `${!ctrl.heapRead || ctrl.seenDropMB < 4 ? "   ⚠ THE WATCHER CANNOT SEE A COLLECTION IT CAUSED — heap readings below are NON-READINGS" : "   ✓ the watcher sees a collection"}`,
    );

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: args.cpu });

    if (args.grid) {
      // ★ THIS TESTS A FIX, NOT AN EXPLANATION, which is why it is worth running after four
      // mechanisms died. Four proposed, four eliminated — yield count, chunk size, backlog, GC —
      // and the step between "some sleep" and "no sleep" is untouched. If a rAF-shaped yield
      // removes it, we do not need the mechanism.
      //
      // TBT AND ACHIEVED FPS ARE THE READOUTS, not max gap: worst-gap is a single order statistic
      // and four rounds of argument were built on its noise. TBT showed the same step every time
      // without the wobble.
      const reps = args.reps || 2;
      const cells = [];
      const plan = [];
      for (let r = 0; r < reps; r++) {
        for (const competing of args.idleOnly ? [false] : [false, true]) {
          for (const y of (args.only || ["none", "timeout", "raf", "scheduler", "postTask-ub", "postTask-bg"])) plan.push({ y, competing });
        }
      }
      // Interleave so a drifting machine cannot manufacture a ranking (the sweep's own lesson).
      // ★ FISHER-YATES, NOT A RANDOM COMPARATOR. `sort(() => Math.random() < 0.5 ? -1 : 1)` is the
      // classic bad shuffle: the comparator is not a consistent ordering, so the permutation it
      // produces is biased by the engine's sort algorithm rather than uniform — and the whole
      // reason the plan is shuffled is to stop a drifting machine manufacturing a ranking. An
      // instrument whose defence against bias is itself biased defends nothing. (Found reading my
      // own harness, not from a failure: it would have kept producing plausible orderings forever.)
      for (let i = plan.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [plan[i], plan[j]] = [plan[j], plan[i]];
      }
      for (const { y, competing } of plan) {
        cells.push(await page.evaluate((o) => globalThis.stemlabGrid(o), {
          seconds: args.seconds, stems: args.stems, sliceMs: args.slice, yieldName: y, competing,
        }));
      }
      const key = (c) => `${c.yieldName}/${c.competing ? "anim" : "idle"}`;
      const groups = new Map();
      for (const c of cells) {
        if (!groups.has(key(c))) groups.set(key(c), []);
        groups.get(key(c)).push(c);
      }
      console.log(`\n  STEMLAB GRID · ${args.stems} stems x ${args.seconds}s · ${args.cpu}x CPU · slice ${args.slice} ms · ${reps} reps, interleaved\n`);
      console.log("  yield / competing        wall        TBT     worst    anim fps");
      for (const [k, cs] of groups) {
        if (!cs[0].available) { console.log(`  ${k.padEnd(22)} — primitive NOT AVAILABLE in this browser (absent, not equal)`); continue; }
        const m = (f2) => cs.reduce((a, c) => a + f2(c), 0) / cs.length;
        console.log(
          `  ${k.padEnd(22)} ${f(m((c) => c.wallMs), 0).padStart(7)} ms ${f(m((c) => c.tbtMs), 0).padStart(7)} ms ` +
            `${f(m((c) => c.maxFrameGapMs), 0).padStart(6)} ms ${f(m((c) => c.paintedFps), 1).padStart(8)}`,
        );
      }
      console.log("");
      return;
    }

    const run = (sliceMs) =>
      page.evaluate((o) => globalThis.stemlabRun(o), { seconds: args.seconds, stems: args.stems, sliceMs });

    // ★ ABBA, NOT A→B. The first ordering I ran had sliced first and whole second, every time, and
    // it said the mitigation made things WORSE. That is exactly the shape of a warm-up curve read
    // as a state: the first run pays JIT, the first GC after a 1 MB encode, and a cold decoder.
    // Running sliced, whole, whole, sliced gives each condition one cold slot and one warm slot, so
    // an effect that follows the SLICING can be told apart from one that follows the POSITION.
    // ★ THE ORDER IS INTERLEAVED, NOT PAIRED — and that is Metron's correction, not a refinement.
    // My first budget sweep ran each budget in its own process and its control climbed monotonically
    // across them (244 → 256 → 289 ms): the SAME condition, drifting +18% in the same direction as
    // the independent variable. The effect survived that easily; the SHAPE I read off it — a curve
    // in budget that inverts at the unsliced boundary — is exactly what a drifting control
    // manufactures. A difference large against the drift can survive it. A slope cannot.
    const order = args.sweep
      ? [128, 8, null, 32, 8, null, 128, 32]
      : [args.slice, null, null, args.slice];
    const runs = [];
    for (const sliceMs of order) runs.push({ sliceMs, ...(await run(sliceMs)) });
    const pick = (want) => runs.filter((r) => (want === null ? r.sliceMs === null : r.sliceMs === want));
    const worst = (rs, k) => Math.max(...rs.map((r) => r[k]));
    const mean = (rs, k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
    const fold = (rs) => ({
      bytes: rs[0].bytes,
      wallMs: mean(rs, "wallMs"),
      maxFrameGapMs: worst(rs, "maxFrameGapMs"),
      gapsOver50: Math.round(mean(rs, "gapsOver50")),
      gapsOver100: Math.round(mean(rs, "gapsOver100")),
      tbtMs: mean(rs, "tbtMs"),
      worstDropMB: worst(rs, "worstDropMB"),
      drops: Math.round(mean(rs, "drops")),
      biggestDropMB: worst(rs, "biggestDropMB"),
      bursts: Math.round(mean(rs.map((r) => r.delivery), "bursts")),
      maxBurst: worst(rs.map((r) => r.delivery), "maxBurst"),
      maxBurstPos: mean(rs.map((r) => r.delivery), "maxBurstPos"),
      meanBurst: mean(rs.map((r) => r.delivery), "meanBurst"),
      dframes: rs[0].delivery.frames,
      decodedSeconds: rs[0].decodedSeconds,
    });
    const sliced = fold(pick(args.slice));
    const whole = fold(pick(null));
    const warmup = runs[0].wallMs / runs[3].wallMs; // same condition, cold slot vs warm slot

    if (args.json) {
      console.log(JSON.stringify({ cpu: args.cpu, args, runs, sliced, whole }, null, 2));
      return;
    }
    console.log(`\n  STEMLAB · ${args.stems} stems x ${args.seconds}s · ${args.cpu}x CPU · ${(sliced.bytes / 1024).toFixed(0)} KiB per stem\n`);
    console.log("                              wall      worst   >50ms  >100ms       TBT   bursts  maxB   pos    avgB   dropMB@worst  >4MB  maxDrop");
    if (args.sweep) {
      for (const b of [8, 32, 128]) row(`sliced (${b} ms)`, fold(pick(b)));
      row("unsliced (no sleep)", whole);
      const ctrl = pick(null).map((r) => Math.round(r.maxFrameGapMs));
      console.log(`\n  control repeats (same condition, interleaved): ${ctrl.join(", ")} ms` +
        ` — a MONOTONIC control across a sweep means the runs are not independent and any SHAPE read off it is the drift`);
    } else {
      row(`sliced (${args.slice} ms)`, sliced);
      row("unsliced (before)", whole);
    }
    console.log(`\n  warm-up check: the same condition cost ${f(warmup, 2)}x in the cold slot vs the warm one` +
      `${warmup > 1.15 || warmup < 0.87 ? " — position matters here IN EITHER DIRECTION, which is why the order is ABBA" : ""}`);
    const ratio = whole.maxFrameGapMs / Math.max(1, sliced.maxFrameGapMs);
    console.log(
      `\n  worst frame gap is ${f(ratio, 1)}x smaller when sliced. "Worst" is what the eye sees:` +
        ` one gap of ${f(whole.maxFrameGapMs, 0)} ms is a frozen picture, ${sliced.gapsOver50} gaps over 50 ms is a stutter.\n`,
    );
    if (sliced.decodedSeconds < args.seconds * args.stems * 0.99) {
      console.log(`  ⚠ decoded only ${f(sliced.decodedSeconds, 1)}s of ${args.seconds * args.stems}s — the measurement is of a SHORT decode, not a stem load.\n`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("stemlab error:", e?.stack || e?.message || e);
  process.exit(1);
});
