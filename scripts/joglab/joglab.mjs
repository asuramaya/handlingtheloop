#!/usr/bin/env node
// JOGLAB — offline validation harness for the jog/scratch/motor-ramp DSP. Drives the REAL
// JogEngine + the REAL scratchWorklet (as a genuine AudioWorkletProcessor) inside Chromium's
// OfflineAudioContext, and diffs the worklet's own reported trajectory against the canonical
// TS reference (servoStep/brakeFriction) — the actual point: scratchWorklet.ts hand-duplicates
// that math inline ("kept in sync by hand"), so this is what actually catches a silent drift.
//
// Usage:
//   node scripts/joglab/joglab.mjs --scenario brake
//   node scripts/joglab/joglab.mjs --scenario spinback --loop-start 10 --loop-end 12 --start-pos 11.5
//   node scripts/joglab/joglab.mjs --scenario softStart --vinyl-start 0.18
//   node scripts/joglab/joglab.mjs --all          # brake, spinback, softStart, each with and without a loop

import { build } from "vite";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(__dirname, "harness.ts");

function parseArgs(argv) {
  const a = { scenario: "brake", seconds: 3, trackDuration: 30, startPos: 15, rate: 1 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--scenario": a.scenario = v; i++; break;
      case "--seconds": a.seconds = Number(v); i++; break;
      case "--track-duration": a.trackDuration = Number(v); i++; break;
      case "--start-pos": a.startPos = Number(v); i++; break;
      case "--rate": a.rate = Number(v); i++; break;
      case "--loop-start": a.loopStart = Number(v); i++; break;
      case "--loop-end": a.loopEnd = Number(v); i++; break;
      case "--vinyl-brake": a.vinylBrakeTime = Number(v); i++; break;
      case "--vinyl-start": a.vinylStartTime = Number(v); i++; break;
      case "--back-spin": a.backSpinLength = Number(v); i++; break;
      case "--spinback-strength": a.spinbackStrength = Number(v); i++; break;
      case "--all": a.all = true; break;
      case "--json": a.json = true; break;
      default: break;
    }
  }
  return a;
}

function findChromium() {
  const cache = resolve(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    const dirs = readdirSync(cache)
      .filter((d) => d.startsWith("chromium-") || d.startsWith("chromium_headless_shell-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const rel of [
        "chrome-linux64/chrome",
        "chrome-headless-shell-linux64/chrome-headless-shell",
        "chrome-linux/chrome",
        "chrome-linux/headless_shell",
        "chrome-linux/chrome-headless-shell",
      ]) {
        const p = resolve(cache, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/snap/bin/chromium", "/usr/bin/chromium"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function bundleHarness() {
  const out = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      minify: false,
      target: "esnext",
      lib: { entry: HARNESS, formats: ["iife"], name: "joglab", fileName: () => "joglab.js" },
    },
  });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
  if (!chunk) throw new Error("joglab: bundle produced no chunk");
  return chunk.code;
}

const f = (x, d = 3) => (x == null ? "—" : Number(x).toFixed(d));

function printReport(r) {
  console.log("");
  console.log(`  JOGLAB · ${r.scenario.toUpperCase()}`);
  console.log(`  applied: ${JSON.stringify(r.applied)}`);
  console.log("");
  if (r.note) console.log(`  ⚠ ${r.note}`);
  console.log(`  worklet settle   ${r.worklet.settleAt == null ? "never" : f(r.worklet.settleAt, 3) + "s"}   final pos ${f(r.worklet.finalPos, 3)}   samples ${r.worklet.sampleCount}${r.worklet.overshoot ? "   ⚠ OVERSHOOT" : ""}`);
  console.log(`  reference settle ${r.reference.settleAt == null ? "never" : f(r.reference.settleAt, 3) + "s"}   final vel ${f(r.reference.finalVel, 4)}`);
  const driftFlag = r.maxVelDrift > 0.05 ? "  ⚠ DRIFT — the worklet's hand-ported math has diverged from the TS reference" : "  (matches the TS reference ✓)";
  console.log(`  max drift        ${f(r.maxVelDrift, 4)} ×realtime${r.maxVelDriftAt != null ? ` at t=${f(r.maxVelDriftAt, 3)}s` : ""}${driftFlag}`);
  if (r.loopRespected != null) {
    console.log(`  loop confinement ${r.loopRespected ? "respected ✓" : "⚠ VIOLATED — the platter left the active loop's bounds"}`);
  }
  console.log("");
  console.log(`  input rms  ${f(r.inputRms, 4)}  output rms ${f(r.outputRms, 4)}${r.outputRms < 1e-4 ? "  ⚠ OUTPUT IS SILENT — nothing to judge the click detector against" : ""}`);
  if (r.clicks.length) {
    const bad = r.clicks.filter((c) => c.xMedian > 20);
    if (bad.length) {
      console.log(`  clicks ⚠ ${bad.length} discontinuit${bad.length === 1 ? "y" : "ies"}:`);
      for (const c of bad) console.log(`         t=${f(c.tSec, 3)}s   step ${f(c.step, 4)}   ${f(c.xMedian, 0)}× median`);
    } else {
      console.log(`  clicks none (smooth ✓)`);
    }
  } else {
    console.log(`  clicks none (smooth ✓)`);
  }
  console.log("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exe = findChromium();
  if (!exe) {
    console.error("joglab: no Chromium found (looked in ~/.cache/ms-playwright and PATH). Install one or set PATH.");
    process.exit(2);
  }
  process.stderr.write("joglab: bundling harness…\n");
  const code = await bundleHarness();
  process.stderr.write(`joglab: launching Chromium (${exe})\n`);
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") process.stderr.write(`[page:${m.type()}] ${m.text()}\n`); });
    page.on("pageerror", (e) => process.stderr.write(`[pageerror] ${e.message}\n`));
    // A REAL origin — AudioWorklet modules from a blob: URL don't load under an opaque
    // about:blank origin (the same gotcha fxlab documents).
    await page.route("https://joglab.local/", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><meta charset=utf-8><title>joglab</title>" }),
    );
    await page.goto("https://joglab.local/");
    await page.addScriptTag({ content: code });

    const scenarios = args.all ? ["brake", "spinback", "softStart"] : [args.scenario];
    const loops = args.all ? [null, { start: 10, end: 12 }] : [args.loopStart != null && args.loopEnd != null ? { start: args.loopStart, end: args.loopEnd } : null];

    for (const scenario of scenarios) {
      for (const loop of loops) {
        const spec = {
          scenario,
          seconds: args.seconds,
          trackDuration: args.trackDuration,
          startPos: loop ? (loop.start + loop.end) / 2 : args.startPos,
          rate: args.rate,
          loop,
          vinylBrakeTime: args.vinylBrakeTime,
          vinylStartTime: args.vinylStartTime,
          backSpinLength: args.backSpinLength,
          spinbackStrength: args.spinbackStrength,
        };
        const r = await page.evaluate((s) => globalThis.joglabRender(s), spec);
        if (args.json) console.log(JSON.stringify({ spec, result: r }, null, 2));
        else printReport({ ...r, applied: { ...r.applied, loop: loop ? `${loop.start}-${loop.end}` : "none" } });
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("joglab error:", e?.stack || e?.message || e);
  process.exit(1);
});
