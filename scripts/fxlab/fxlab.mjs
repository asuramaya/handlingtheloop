#!/usr/bin/env node
// FXLAB — offline FX analysis harness. Renders ONE effect through Chromium's OfflineAudioContext
// (the real production DSP, not a reimplementation) and prints a report a text agent can read:
// peak/RMS/clip, decay + tail, an ASCII envelope, and — for the delay — the per-repeat echo ladder
// with the TRUE loop gain (so "too feedbacky" becomes a number, not a vibe).
//
// Usage:
//   node scripts/fxlab/fxlab.mjs --kind delay --signal impulse --seconds 8
//   node scripts/fxlab/fxlab.mjs --kind delay --preset "1/4 Dub" --signal impulse --seconds 8
//   node scripts/fxlab/fxlab.mjs --kind delay --params '{"feedback":0.62,"time":0.5,"mix":0.3}'
//   node scripts/fxlab/fxlab.mjs --kind reverb --preset "Big Hall" --signal impulse
//   node scripts/fxlab/fxlab.mjs --sweep-feedback           # feedback 0.2..0.9 loop-gain table (delay)
//   node scripts/fxlab/fxlab.mjs --churn                     # rapid real-time param-drag stress test (MOD)
//   node scripts/fxlab/fxlab.mjs --mod-voice-sweep            # STAGES 2..12 peak/clip table (MOD chorus+flanger)
//   node scripts/fxlab/fxlab.mjs --mod-audit                  # the 2026-08 MOD review, one number + pass line per finding
//
// Flags: --kind --preset --params(json) --signal(impulse|burst|noise|tone|silence)
//        --seconds --bpm --json (raw JSON only) --sweep-feedback
//
// Needs: playwright-core + a Chromium (auto-discovered from ~/.cache/ms-playwright or PATH).

import { build } from "vite";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(__dirname, "harness.ts");

function parseArgs(argv) {
  const a = { kind: "delay", signal: "impulse", seconds: 6, bpm: 120 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--kind": a.kind = v; i++; break;
      case "--preset": a.preset = v; i++; break;
      case "--params": a.params = JSON.parse(v); i++; break;
      case "--signal": a.signal = v; i++; break;
      case "--seconds": a.seconds = Number(v); i++; break;
      case "--bpm": a.bpm = Number(v); i++; break;
      case "--json": a.json = true; break;
      case "--sweep-feedback": a.sweepFeedback = true; break;
      case "--churn": a.churn = true; break;
      case "--mod-voice-sweep": a.modVoiceSweep = true; break;
      case "--mod-audit": a.modAudit = true; break;
      case "--mod-probe": a.modProbe = JSON.parse(v); i++; break;
      case "--mod-spikes": a.modSpikes = JSON.parse(v); i++; break;
      case "--mod-growth": a.modGrowth = JSON.parse(v); i++; break;
      case "--mod-gesture": a.modGesture = JSON.parse(v); i++; break; // {"params":{...},"param":"rate","to":0.8}
      case "--mod-gesture-repeat": a.modGestureRepeat = JSON.parse(v); i++; break;
      case "--mod-thru": a.modThru = true; break;
      case "--suspend-quirk": a.suspendQuirk = true; break;
      case "--mod-live-gesture": a.modLiveGesture = JSON.parse(v); i++; break;
      case "--throw": a.throwPreset = v; i++; break;
      case "--throw-at": a.throwAt = Number(v); i++; break;
      case "--throw-off": a.throwOff = Number(v); i++; break;
      case "--stepped": a.stepped = true; break;
      case "--pad-throw": a.padThrow = true; break;
      case "--start-bypassed": a.startBypassed = true; break;
      case "--bypass-at": a.bypassAt = Number(v); i++; break;
      case "--bank": a.bank = true; break;
      case "--coverage": a.coverage = true; break;
      case "--tone-hz": a.toneHz = Number(v); i++; break;
      case "--tone-amp": a.toneAmp = Number(v); i++; break;
      default: break;
    }
  }
  return a;
}

// Find a Chromium executable playwright-core can drive (it doesn't bundle one).
function findChromium() {
  const cache = resolve(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    const dirs = readdirSync(cache)
      .filter((d) => d.startsWith("chromium-") || d.startsWith("chromium_headless_shell-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const rel of [
        // Current Playwright builds unpack to *-linux64; the older -linux names are kept for
        // an older cache. Without the 64 variants this whole branch silently misses and we
        // fall through to a system Chrome — which works, but isn't the pinned build.
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

// Bundle harness.ts → a single IIFE string exposing globalThis.fxlabRender.
async function bundleHarness() {
  const out = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      minify: false,
      target: "esnext",
      lib: { entry: HARNESS, formats: ["iife"], name: "fxlab", fileName: () => "fxlab.js" },
    },
  });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
  if (!chunk) throw new Error("fxlab: bundle produced no chunk");
  return chunk.code;
}

async function renderOne(page, spec) {
  return page.evaluate((s) => globalThis.fxlabRender(s), spec);
}

// ---- pretty print --------------------------------------------------------
const BARS = "▁▂▃▄▅▆▇█";
function sparkline(envDb, floorDb = -72, ceilDb = 0) {
  const span = ceilDb - floorDb;
  return envDb
    .map((db) => {
      const t = Math.max(0, Math.min(1, (db - floorDb) / span));
      return BARS[Math.min(BARS.length - 1, Math.round(t * (BARS.length - 1)))];
    })
    .join("");
}
const f = (x, d = 2) => (x == null ? "—" : Number(x).toFixed(d));

// An EQ curve, drawn. Each column is a log-spaced probe frequency; the bar rides a ±12 dB
// scale with the 0 dB line marked, so a preset's SHAPE is readable at a glance.
function printResponse(hz, db) {
  const rows = 9; // ±12 dB in 3 dB steps
  const dbOfRow = (r) => 12 - r * 3; // row 0 = +12, row 4 = 0, row 8 = -12
  console.log(`  response (${hz[0]}Hz … ${(hz[hz.length - 1] / 1000).toFixed(0)}kHz, ±12 dB):`);
  for (let r = 0; r < rows; r++) {
    const lvl = dbOfRow(r);
    const label = `${lvl > 0 ? "+" : ""}${lvl}`.padStart(3);
    let line = "";
    for (let i = 0; i < hz.length; i++) {
      const v = db[i];
      const hit = lvl === 0 ? true : lvl > 0 ? v >= lvl - 1.5 && v > 0 : v <= lvl + 1.5 && v < 0;
      line += lvl === 0 ? (Math.abs(v) < 1.5 ? "━" : "·") : hit ? "█" : " ";
    }
    console.log(`  ${label} │${line}`);
  }
  const ticks = hz.map((h) => (h < 100 ? "" : h === 1000 || h === 100 || h === 10000 ? "┬" : "")).join("");
  console.log(`      └${"─".repeat(hz.length)}`);
  console.log(`       ${ticks}`);
  const lo = db.slice(0, 8);
  const mid = db.slice(8, 19);
  const hi = db.slice(19);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  console.log(`       lows ${f(avg(lo), 1)} dB · mids ${f(avg(mid), 1)} dB · highs ${f(avg(hi), 1)} dB`);
}

function printReport(r, spec) {
  const width = r.envBuckets;
  console.log("");
  console.log(`  FXLAB · ${r.kind.toUpperCase()} · signal=${r.signal} · ${r.seconds}s @ ${r.sampleRate}Hz`);
  if (spec.preset) console.log(`  preset: "${spec.preset}"`);
  console.log(`  params: ${JSON.stringify(r.applied)}`);
  console.log("");
  console.log(`  peak   ${f(r.peak, 3)}  (${f(r.peakDb, 1)} dB)${r.clipped ? "   ⚠ CLIPPED (>0 dBFS)" : ""}`);
  console.log(`  rms    ${f(r.rms, 4)}  (${f(r.rmsDb, 1)} dB)`);
  console.log(`  dc     ${f(r.dc, 4)}`);
  console.log(`  decay  ${f(r.decayTo60Sec, 2)}s to -60dB   ·   tail ${f(r.tailSec, 2)}s`);
  if (r.effFeedback != null) {
    const tag = r.growing ? "  ⚠ GROWING (tail builds — unstable)" : "";
    console.log(`  loop   effective feedback ${f(r.effFeedback, 3)}  (${f(r.effFeedbackDbPerRepeat, 1)} dB/repeat)${tag}`);
    const setFb = r.applied.feedback;
    if (setFb != null && r.effFeedback != null) {
      const excess = r.effFeedback - setFb;
      const flag = Math.abs(excess) > 0.06 ? `  ⚠ ${excess > 0 ? "EXCEEDS" : "under"} set feedback by ${f(Math.abs(excess), 3)}` : "  (matches set feedback ✓)";
      console.log(`         set feedback ${f(setFb, 3)}${flag}`);
    }
  }
  if (r.clicks) {
    // A click is a step the material itself could never make. >20× the median step is audible;
    // a smooth ramp keeps every step inside the signal's own slew.
    const bad = r.clicks.filter((c) => c.xMedian > 20);
    if (bad.length) {
      console.log(`  clicks ⚠ ${bad.length} discontinuit${bad.length === 1 ? "y" : "ies"} (step ≫ the signal's own slew):`);
      for (const c of bad) console.log(`         t=${f(c.tSec, 3)}s   step ${f(c.step, 4)}   ${f(c.xMedian, 0)}× median`);
    } else {
      console.log(`  clicks none — biggest step ${f(Math.max(0, ...r.clicks.map((c) => c.xMedian)), 1)}× median (smooth ✓)`);
    }
  }
  console.log("");
  if (r.responseDb) printResponse(r.responseHz, r.responseDb);
  console.log("");
  console.log(`  envelope (${width} buckets, ${f(r.seconds / width, 3)}s each, -72..0 dB):`);
  console.log(`  ${sparkline(r.envDb)}`);
  console.log("");
  if (r.echoes && r.echoes.length) {
    console.log(`  echo ladder (per-repeat peak at n×${f(r.applied.time, 3)}s):`);
    const head = r.echoes.slice(0, 14);
    for (const e of head) {
      const bar = "█".repeat(Math.max(0, Math.round((e.amp / (r.echoes[0].amp || 1)) * 28)));
      console.log(`   ${String(e.n).padStart(2)}  t=${f(e.tSec, 3)}s  ${f(e.db, 1).padStart(6)}dB  ${bar}`);
    }
    if (r.echoes.length > head.length) console.log(`   … ${r.echoes.length - head.length} more`);
    console.log("");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exe = findChromium();
  if (!exe) {
    console.error("fxlab: no Chromium found (looked in ~/.cache/ms-playwright and PATH). Install one or set PATH.");
    process.exit(2);
  }
  process.stderr.write("fxlab: bundling harness…\n");
  const code = await bundleHarness();
  process.stderr.write(`fxlab: launching Chromium (${exe})\n`);
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    // Forward WARNINGS too, not just errors. The worklet devices (reverb/crush/mod) degrade to a
    // native fallback with a console.warn when their module isn't loaded — swallow that and the
    // harness happily reports a fallback's numbers as if they were the real DSP.
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") process.stderr.write(`[page:${m.type()}] ${m.text()}\n`); });
    page.on("pageerror", (e) => process.stderr.write(`[pageerror] ${e.message}\n`));
    // The page needs a REAL ORIGIN. On about:blank (what setContent gives you) the origin is
    // opaque, and Chromium refuses to load an AudioWorklet module from a blob: URL there — so
    // addModule() fails, every worklet device (reverb / crush / mod) quietly degrades to its
    // native fallback, and the harness reports the fallback's numbers as if they were the DSP.
    // Serving the shell from a routed origin makes the blob loadable and the worklets real.
    await page.route("https://fxlab.local/", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><meta charset=utf-8><title>fxlab</title>" }),
    );
    await page.goto("https://fxlab.local/");
    await page.addScriptTag({ content: code });

    if (args.sweepFeedback) {
      // A one-shot table: hold everything else, sweep the feedback param, read the true loop gain.
      console.log("\n  FXLAB · delay feedback sweep (impulse, time=0.5s, mix=0.3, 10s)\n");
      console.log("   set-fb   eff-fb   dB/rep   decay-to-60   tail   growing");
      for (const fb of [0.2, 0.3, 0.38, 0.45, 0.55, 0.62, 0.7, 0.8, 0.9]) {
        const r = await renderOne(page, {
          kind: "delay",
          signal: "impulse",
          seconds: 10,
          params: { feedback: fb, time: 0.5, mix: 0.3, hp: 120, lp: 6500, sync: 0 },
        });
        console.log(
          `   ${f(fb, 2).padStart(5)}   ${f(r.effFeedback, 3).padStart(6)}   ${f(r.effFeedbackDbPerRepeat, 1).padStart(6)}   ${f(r.decayTo60Sec, 2).padStart(9)}s   ${f(r.tailSec, 2).padStart(4)}s   ${r.growing ? "⚠ yes" : "no"}`,
        );
      }
      console.log("");
      return;
    }

    if (args.churn) {
      // Rapid real-time parameter drags — the class of bug a static render can never show, since
      // it only ever builds a device once. See harness.ts's fxlabChurn for what it drives.
      console.log("\n  FXLAB · churn (MOD) — real-time STAGES drag across all 4 modes + a BARBER depth/source/feedback probe\n");
      const r = await page.evaluate(() => globalThis.fxlabChurn());
      if (r.ok) console.log(`  ✓ survived ${r.steps} rapid param changes, context still running (${r.finalState})\n`);
      else console.log(`  ✗ CRASHED after ${r.steps} param changes — context ended up "${r.finalState}"${r.error ? `: ${r.error}` : ""}\n`);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }

    if (args.modLiveGesture) {
      const g = args.modLiveGesture;
      const r = await page.evaluate((g) => globalThis.fxlabModLiveGesture(g.params, g.param, g.to, g.n || 4), g);
      console.log(`   live steps: ${r.join("  ")}`);
      return;
    }

    if (args.suspendQuirk) {
      for (const [w, settle] of [[false, 0], [true, 0], [true, 40]]) {
        const r = await page.evaluate(({ w, settle }) => globalThis.fxlabSuspendQuirk(10, w, settle), { w, settle });
        console.log(`   worklet=${w} settle=${settle}ms: steps ${r.join("  ")}`);
      }
      return;
    }

    if (args.modThru) {
      const r = await page.evaluate(() => globalThis.fxlabModThru(false));
      console.log(`   thru corr ${f(r.thru, 3)}   nothru corr ${f(r.nothru, 3)}`);
      const r2 = await page.evaluate(() => globalThis.fxlabModThru(true, 40));
      console.log(`   after a live render + 40 offline renders: thru corr ${f(r2.thru, 3)}   nothru corr ${f(r2.nothru, 3)}   dryDelay=${r2.dryDelayValue} off=${r2.dryOffsetSec} mode=${r2.mode} thru=${r2.thruParam} builds=${r2.builds}`);
      console.log(`   reps (max corr [per 0.25 s bucket]):\n   ${r.reps.join("\n   ")}`);
      console.log(`   (first run: dryDelay=${r.dryDelayValue} off=${r.dryOffsetSec} mode=${r.mode} thru=${r.thruParam} builds=${r.builds})`);
      return;
    }

    if (args.modGestureRepeat) {
      const g = args.modGestureRepeat;
      const r = await page.evaluate((g) => globalThis.fxlabModGestureRepeat(g.params, g.param, g.to, g.n || 6), g);
      console.log(`   steps: ${r.steps.join("  ")}`);
      if (r.worst) {
        console.log(`   worst ×${r.worst.step.toFixed(2)} at ${r.worst.at.toFixed(4)}s; retired engines at switch: ${r.worst.retiredAtSwitch}; teardowns at ctx t: ${r.worst.teardowns.map((t) => t.toFixed(3)).join(", ") || "(none logged)"}`);
        const pairs = [];
        for (let i = 0; i < r.worst.win.length; i += 2) pairs.push(`${r.worst.win[i]}/${r.worst.win[i + 1]}`);
        console.log("   out/wet every 4 samples ±64: " + pairs.join("  "));
        console.log(`   out rms before ${f(r.worst.before,3)} / after(50-300ms) ${f(r.worst.after1,3)} / after(1-1.9s) ${f(r.worst.after2,3)}   dry ref before ${f(r.worst.dryB,3)} after ${f(r.worst.dryA,3)}`);
      }
      return;
    }

    if (args.modGesture) {
      const r = await page.evaluate((g) => globalThis.fxlabModGesture(g.params, g.param, g.to, g.midT), args.modGesture);
      for (const k in r) console.log(`   ${k.padEnd(12)} ${f(r[k], 2)}`);
      return;
    }

    if (args.modGrowth) {
      const r = await page.evaluate(({ p, t, sec }) => globalThis.fxlabModGrowth(p, t, sec), { p: args.modGrowth, t: !!args.padThrow, sec: args.seconds });
      for (const k in r) console.log(`   ${k.padEnd(12)} ${f(r[k], 2)}`);
      return;
    }

    if (args.modSpikes) {
      const r = await page.evaluate((p) => globalThis.fxlabModSpikes(p), args.modSpikes);
      console.log(`   spikes: ${r.n}   |saw| histogram (0.0‥1.0 in tenths): ${r.hist.join(" ")}`);
      console.log(`   saw value at the 12 biggest: ${r.sawAtTop.join(", ")}`);
      console.log(`   biggest spike at ${r.atSec.toFixed(4)}s — (wet, saw) every 4 samples, ±120:`);
      const pairs = [];
      for (let i = 0; i < r.win.length; i += 2) pairs.push(`${r.win[i]}/${r.win[i + 1]}`);
      console.log("   " + pairs.join("  "));
      return;
    }

    if (args.modProbe) {
      const r = await page.evaluate(({ p, sig, sec }) => globalThis.fxlabModProbe(p, sig, sec), { p: args.modProbe, sig: args.signal === "tone" || args.signal === "pink" ? args.signal : "noise", sec: args.seconds });
      for (const k in r) console.log(`   ${k.padEnd(20)} ${f(r[k], 2)}`);
      return;
    }

    if (args.modAudit) {
      // The MOD review's findings as a before/after table — see harness.ts fxlabModAudit for what
      // each number measures. Wet is recovered as out − dryGain·dry so the wet path is inspected
      // on its own; every render is also scanned for non-finite samples.
      console.log("\n  FXLAB · MOD audit — one measurement per review finding\n");
      const r = await page.evaluate(() => globalThis.fxlabModAudit());
      const w = Math.max(...r.checks.map((c) => c.name.length));
      for (const c of r.checks) {
        console.log(`   ${c.pass ? "✓" : "✗"} ${c.name.padEnd(w)}  ${String(c.value).padStart(8)} ${c.unit.padEnd(14)}  ${c.detail}`);
      }
      console.log(`\n  ${r.ok ? "ALL PASS" : `${r.checks.filter((c) => !c.pass).length} FAILING`}\n`);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }

    if (args.modVoiceSweep) {
      // A REAL regression test for the "DSP breaks at high voice count" bug: CHORUS/FLANGER's
      // multi-voice sum used to connect every voice directly into the tone filter with NO
      // normalization — fine at STAGES=2, but at STAGES=12 up to 12 correlated voices could sum
      // to ~12× amplitude and hard-clip (BaseFxDevice's `wet` has no limiter downstream). Unlike
      // --churn (which needs REAL wall-clock timing to reproduce and this harness's headless
      // audio backend can't), THIS one a static render genuinely catches: peak amplitude is a
      // property of the rendered PCM, not of live thread-scheduling pressure. Sweeps STAGES
      // 2..12 at depth=1/feedback=1 (worst case) for both CHORUS and FLANGER, at each MIX the
      // rack actually exposes: the device's own 0.5 default, and 1.0 (full wet, the ceiling).
      console.log("\n  FXLAB · MOD voice-count sweep — peak amplitude vs. STAGES, worst-case depth/feedback\n");
      for (const mode of [0, 1]) {
        const modeName = mode === 0 ? "CHORUS" : "FLANGER";
        for (const mix of [0.5, 1.0]) {
          console.log(`  ${modeName} · mix=${mix}`);
          console.log("   stages   peak    peakDb   clipped");
          for (const stages of [2, 4, 6, 8, 10, 12]) {
            const r = await renderOne(page, {
              kind: "mod",
              signal: "noise",
              seconds: 3,
              params: { mode, stages, depth: 1, feedback: 1, mix },
            });
            const flag = r.clipped ? "  ⚠ CLIPPED" : "";
            console.log(`   ${String(stages).padStart(6)}   ${f(r.peak, 3).padStart(5)}   ${f(r.peakDb, 1).padStart(6)}   ${r.clipped ? "yes" : "no"}${flag}`);
          }
          console.log("");
        }
      }
      return;
    }

    if (args.coverage) {
      // Which knobs does each bank never touch? A `dead` param is a capability of the effect that
      // no factory preset demonstrates.
      const kinds = args.kind && args.kind !== "all" ? [args.kind] : ["eq", "delay", "reverb", "mod", "crush", "gate", "noise", "saturator", "comp"];
      console.log("");
      for (const k of kinds) {
        const c = await page.evaluate((kk) => globalThis.fxlabCoverage(kk), k);
        const dead = c.params.filter((p) => p.dead || p.missing === c.presets);
        const flat = c.params.filter((p) => p.flat);
        const used = c.params.filter((p) => !p.dead && !p.flat && p.missing < c.presets);
        console.log(`  ${c.kind.toUpperCase().padEnd(10)} ${c.presets} presets · ${c.params.length} params · ${used.length} exercised`);
        if (dead.length) console.log(`     ✗ never moved:  ${dead.map((p) => `${p.id}=${f(p.def, 2)}`).join("  ")}`);
        if (flat.length) console.log(`     ~ one value:    ${flat.map((p) => `${p.id}=${f(p.min, 2)}`).join("  ")}`);
        console.log(`     ✓ exercised:    ${used.map((p) => `${p.id}[${f(p.min, 2)}‥${f(p.max, 2)}]×${p.distinct}`).join("  ")}`);
        console.log("");
      }
      return;
    }

    if (args.bank) {
      // Audition a WHOLE bank in one pass — every factory preset for a kind, side by side. For the
      // EQ this prints each preset's real curve, which is the only honest way to judge a bank of
      // curves without ears.
      const names = await page.evaluate((k) => globalThis.fxlabPresetNames(k), args.kind);
      for (const name of names) {
        const r = await renderOne(page, { kind: args.kind, presetName: name, signal: args.signal, seconds: args.seconds, bpm: args.bpm });
        printReport(r, { preset: name });
      }
      return;
    }

    const spec = {
      kind: args.kind,
      presetName: args.preset ?? null,
      params: args.params ?? null,
      signal: args.signal,
      seconds: args.seconds,
      bpm: args.bpm,
      throwPreset: args.throwPreset ?? null,
      throwAt: args.throwAt ?? null,
      throwOff: args.throwOff ?? null,
      stepped: !!args.stepped,
      toneHz: args.toneHz ?? 1000,
      toneAmp: args.toneAmp ?? 1,
      padThrow: !!args.padThrow,
      startBypassed: !!args.startBypassed,
      bypassAt: args.bypassAt ?? null,
    };
    const r = await renderOne(page, spec);
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else printReport(r, args);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("fxlab error:", e?.stack || e?.message || e);
  process.exit(1);
});
