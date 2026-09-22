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
//   node scripts/fxlab/fxlab.mjs --live-audit                 # real-time gesture/click audit, every device (~8 min)
//   node scripts/fxlab/fxlab.mjs --live-audit-quick           # …the worklet devices only, 1 run each (pre-commit)
//   node scripts/fxlab/fxlab.mjs --shaper-latency             # Chromium's oversample="4x" group delay, measured
//   node scripts/fxlab/fxlab.mjs --noise-audit                # the riser: snap / dir / curve / key / duck / impact / width
//   node scripts/fxlab/fxlab.mjs --gate-align                 # does the GATE land on the beat
//   node scripts/fxlab/fxlab.mjs --stem-taps                  # NULL TEST: do the 4 stem taps sum to the mix output
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
      // {"kind":"reverb","params":{...},"gestures":[{"t":1.5,"param":"size","from":0.2,"to":0.9,"ms":300}],"n":3}
      case "--live-gesture": a.liveGesture = JSON.parse(v); i++; break;
      case "--live-audit": a.liveAudit = true; break;
      case "--live-audit-quick": a.liveAudit = true; a.quick = true; break;
      case "--shaper-latency": a.shaperLatency = true; break;
      case "--mod-width": a.modWidth = true; break;
      case "--gate-align": a.gateAlign = true; break;
      case "--master-duck": a.masterDuck = true; break;
      case "--sidechain-repatch": a.sidechainRepatch = true; break;
      case "--headroom-path": a.headroomPath = true; break;
      case "--capture-tap": a.captureTap = true; break;
      case "--codec-overshoot": a.codecOvershoot = true; break;
      case "--codec-margin": a.codecMargin = true; break;
      case "--snapshot-size": a.snapshotSize = true; break;
      case "--bypass-cost": a.bypassCost = true; break;
      case "--live-comp-prune": a.liveCompPrune = true; break;
      case "--sync-drift": a.syncDrift = true; break;
      case "--stem-taps": a.stemTaps = true; break;
      case "--noise-audit": a.noiseAudit = true; break;
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
  // ★ THE INPUT, FIRST AND UNMISSABLE. Everything below characterises the OUTPUT; if nothing went
  // in, every one of those numbers is float dust reported to four decimals. This line is the
  // difference between a measurement and a confident guess.
  // Tested as "not ok", not as "explicitly false": measure() now seeds these fail-closed, but a
  // report that somehow arrives without them is an UNREAD input, not a good one, and `=== false`
  // would have printed it as if the stimulus had been checked.
  if (!r.inputOk) {
    console.log("");
    console.log(`  ⚠⚠ NO INPUT — stimulus peak ${r.inputPeak} (signal=${r.signal}). Nothing below is a`);
    console.log(`     measurement: an estimator with nothing to estimate estimates NOISE. Check`);
    console.log(`     --signal / --tone-amp / --seconds before reading a single number.`);
    process.exitCode = 2;
  } else {
    console.log(`  input  ${f(r.inputPeak, 3)} pk / ${f(r.inputRms, 4)} rms   ← the stimulus actually rendered`);
  }
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

    if (args.liveGesture) {
      const g = args.liveGesture;
      const r = await page.evaluate((g) => globalThis.fxlabLiveGesture(g), g);
      g.gestures.forEach((ges, i) => {
        const label = ges.param === "__none" ? "control" : `${ges.param}${ges.ms ? ` drag→${ges.to}` : ` →${ges.to}`}`;
        console.log(`   ${label.padEnd(28)} ×${f(r.worst[i], 2).padStart(7)} material   at ${r.when[i].map((m) => `${m >= 0 ? "+" : ""}${m}ms`).join(" ")}   (step ${r.runs.map((x) => x[i].toExponential(1)).join(" ")})`);
      });
      console.log(`   finite=${r.finite}  peak=${f(r.peak, 3)}`);
      return;
    }

    if (args.noiseAudit) {
      console.log("\n  FXLAB · NOISE audit — the riser's seven claims, as numbers\n");
      const r = await page.evaluate(() => globalThis.fxlabNoiseAudit());
      for (const c of r.checks) {
        console.log(`   ${c.pass ? "✓" : "✗"} ${c.name.padEnd(28)} ${f(c.value, 3).padStart(9)} ${c.unit.padEnd(22)} ${c.detail}`);
      }
      const bad = r.checks.filter((c) => !c.pass);
      console.log(`\n  ${r.checks.length - bad.length}/${r.checks.length} pass${bad.length ? ` — ${bad.map((c) => c.name).join(", ")}` : ""}\n`);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }

    if (args.stemTaps) {
      console.log("\n  STEM TAPS — null test: (tap1+tap2+tap3+tap4) − mix. Silence means the substrate is exact.\n");
      const cases = [
        { name: "CONTROL taps-off", opts: { noTaps: true }, control: true },
        { name: "unity", opts: {} },
        { name: "tempo 1.25x", opts: { speed: 1.25 } },
        { name: "pitch +2st", opts: { pitch: 1.1225 } },
        { name: "both", opts: { speed: 0.85, pitch: 0.89 } },
        { name: "one stem muted", opts: { stemGains: [1, 0, 1, 1] } },
      ];
      let worst = -Infinity;
      for (const c of cases) {
        const r = await page.evaluate((o) => globalThis.fxlabStemTaps(o), c.opts);
        // The control is the test's own falsifier: taps OFF means the side outputs are silent, so
        // the "residual" is the whole mix and the null MUST be ~0 dB. A control that nulls is a
        // broken probe, not a passing one — that is the state this file shipped in for one run.
        if (!c.control) worst = Math.max(worst, r.nullDb);
        else if (r.nullDb < -20) console.log("   ⚠ CONTROL NULLED — the probe is measuring nothing; every number below is worthless.");
        
        console.log(
          `   ${c.name.padEnd(18)} mix ${f(r.mixRms, 5)} rms / ${f(r.mixPeak, 4)} pk   residual ${r.residRms.toExponential(2)} rms   NULL ${f(r.nullDb, 1).padStart(7)} dB${c.control ? "  ← must be ~0" : ""}${r.finite ? "" : "   ⚠ NON-FINITE"}`,
        );
      }
      // The input assertion: a null test over a dead signal cancels perfectly and proves nothing.
      console.log(`\n   worst null (control excluded) = ${f(worst, 1)} dB  ${worst < -100 ? "✓ exact — float dust, the taps ARE the mix" : worst < -60 ? "~ audible-clean but NOT exact; look for an off-by-one" : "✗ the taps are not the mix"}\n`);
      process.exitCode = worst < -100 ? 0 : 1;
      return;
    }

    if (args.codecOvershoot) {
      // Thread 307cb25b: a take measured 0.06 dB ABOVE the master ceiling, which the limiter's code
      // says cannot happen. Deckard found the recorder, not the limiter: a take was a lossy round
      // trip. This now measures the SHIPPED capture path against the lossy one it replaced — a tone
      // hard-capped in JavaScript, straight into the recorder's own tap, limiter nowhere near it.
      const fixed = await page.evaluate(() => globalThis.fxlabCodecOvershoot(false));
      const lossy = await page.evaluate(() => globalThis.fxlabCodecOvershoot(true));
      console.log("\n  CODEC OVERSHOOT — does a capture read back above what was put in?\n");
      console.log(`   cap (JS-clipped)       ${f(fixed.cap, 6)}   source peak ${f(fixed.sourcePeak, 6)}  \u2190 no node can raise this`);
      for (const [name, r] of [["shipped", fixed], ["CONTROL (lossy)", lossy]]) {
        console.log(
          `   ${name.padEnd(16)} ${String(r.mime).padEnd(34)} take peak ${f(r.takePeak, 6)}   overshoot ${f(r.overshootDb, 3).padStart(7)} dB   headroom to 1.0 ${f(20 * Math.log10(1 / r.takePeak), 3)} dB`,
        );
      }
      console.log(`\n   lossless formats here  ${fixed.lossless.length ? fixed.lossless.join(", ") : "none offered by this browser"}`);
      // The control must FAIL: if hiding the lossless formats does not reproduce the overshoot, the
      // capture format was never the cause and 307cb25b is unexplained again.
      const controlOvershoots = lossy.takePeak > lossy.cap * 1.001;
      const fixedClean = fixed.takePeak <= fixed.cap * 1.001;
      console.log(
        `\n   ${!controlOvershoots ? "\u2717 INCONCLUSIVE: the lossy control did NOT overshoot, so this probe cannot see the defect \u2014 the limiter is back under suspicion" : fixedClean ? "\u2713 the lossy control reads back ABOVE its own source and the shipped path does not" : "\u2717 the shipped path still overshoots \u2014 the lossless format did not take"}\n`,
      );
      if (!fixed.lossless.length) console.log("   note: this browser offers no lossless capture, so the shipped row IS the control \u2014 a take here is lossy by necessity and bufferToWav's \u00b11 clamp still applies.\n");
      process.exitCode = controlOvershoots && fixedClean ? 0 : 1;
      return;
    }

    if (args.syncDrift) {
      // Thread 42fa00eb, the operator's report. Phase error in BEATS between a synced pair, on the
      // real engine, sampled from the loop's OWN diagnostic so instrument and controller agree on
      // what "in sync" means. The disturbance is applied a third of the way in and released two
      // thirds in, so recovery is inside the window.
      const secs = 18;
      const rows = [];
      for (const sc of ["steady", "offbeat", "jitter:0.0232", "wander:0.0232", "jitter:0.05", "wander:0.05"]) rows.push(await page.evaluate(([s, n]) => globalThis.fxlabSyncDrift(s, n), [sc, secs]));
      // ★ AND THE REAL GRIDS, from Deckard's export (scripts/synclab/real-grids.json, 84a7749). A
      // synthesised rubato is a trend; a real tracked grid has SPIKES — worst single intervals of
      // 4.4% to 16.4% against an RMS of 0.72% to 4.5%. The loop's ±2-beat feed-forward window sees
      // those very differently, and only the real one is the stimulus production supplies.
      const { readFileSync: rf } = await import("node:fs");
      const pool = JSON.parse(rf(new URL("../synclab/real-grids.json", import.meta.url), "utf8")).grids;
      const byNote = Object.values(pool);
      const steadiest = byNote.reduce((m, g) => (g.rmsIntervalSpread < m.rmsIntervalSpread ? g : m));
      const waviest = byNote.reduce((m, g) => (g.rmsIntervalSpread > m.rmsIntervalSpread ? g : m));
      // ★ THE MATERIAL IS THE ONLY VARIABLE, which is Deckard's sharpest-test suggestion and it needed
      // MATCHED pairs: the first run crossed a steady grid with a wavy one, so every row mixed both
      // conditions and the budget split could not be read off it. Steady-vs-steady puts the
      // feed-forward at the detector floor (ff RMS 0.35%, headroom nearly the full 6%); wavy-vs-wavy
      // asks for 3.12% RMS with 9.45% peaks. Any difference between these two rows IS the split.
      for (const [name, pair] of [
        ["both-steady", { a: steadiest, b: steadiest }],
        ["both-wavy", { a: waviest, b: waviest }],
        ["mixed", { a: steadiest, b: waviest }],
      ])
        rows.push({ ...(await page.evaluate(([s, n, g]) => globalThis.fxlabSyncDrift(s, n, g), [name, secs, pair])), scenario: name });
      console.log(`\n  SYNC DRIFT — beat-phase error between a SYNCED pair (128 vs 124 bpm, B follows A), ${secs}s each\n`);
      for (const r of rows) {
        console.log(
          `   ${String(r.scenario).padEnd(12)} worst ${f(r.worstErr ?? NaN, 3).padStart(7)} beats   settled ${f(r.finalErr ?? NaN, 3).padStart(7)}   max trim ${f((r.maxTrim ?? 0) * 100, 2).padStart(5)}%   saturated ${String(r.saturatedTicks).padStart(2)}/${r.n}   audio ${f(r.audioFinalErr ?? NaN, 3).padStart(7)}`,
        );
      }
      const steady = rows[0];
      // The control: if the pair does not hold phase even UNDISTURBED, the rig is broken and every
      // disturbed row below is measuring that instead of the disturbance.
      if (steady.finalErr == null || steady.finalErr > 0.05) {
        console.log("\n   \u2717 INCONCLUSIVE: the UNDISTURBED pair does not hold phase, so this rig is not measuring the disturbances \u2014 fix the baseline first.\n");
        process.exitCode = 1;
        return;
      }
      // ★ THE GRID CAN LIE AND EVERY SYNC READING STAYS GREEN. `audio` is measured from the onsets
      // the stimulus rendered, not from the grids the loop servos on, so it is the only column able
      // to contradict the other four. The `offbeat` row moves deck B's grid half a beat off its own
      // audio: the loop locks the grids perfectly and reports itself in sync while the two records
      // are audibly half a beat apart. That is Deckard's offbeat finding, reproduced from my side.
      const ob = rows.find((r) => r.scenario === "offbeat");
      if (ob) {
        // The control comes FIRST: if this reading cannot see an HONEST pair as aligned, it is not
        // an instrument, and whatever it says about the dishonest one is unreadable, not negative.
        if (steady.audioFinalErr == null || steady.audioFinalErr > 0.05) {
          console.log("\n   \u2717 INCONCLUSIVE: the audio-phase reading does not see the UNDISTURBED pair as aligned, so it cannot be trusted to see a misaligned one.\n");
          process.exitCode = 1;
          return;
        }
        const hid = (ob.finalErr ?? 1) < 0.05 && (ob.audioFinalErr ?? 0) > 0.3;
        console.log(`   offbeat grid \u2014 loop reports ${f(ob.finalErr ?? NaN, 3)} beats (in sync); the AUDIO is ${f(ob.audioFinalErr ?? NaN, 3)} beats apart`);
        console.log(`   ${hid ? "\u2713 reproduced: a grid half a beat off its own audio is INVISIBLE to every sync diagnostic \u2014 the servo is right and the map is wrong" : "\u2026 not reproduced in this run"}`);
      }
      const bad = rows.filter((r) => (r.finalErr ?? 0) > 0.05);
      console.log(`\n   ${bad.length ? `\u2717 ${bad.map((r) => r.scenario).join(", ")} do NOT return to phase within the window` : "\u2713 every scenario returns to phase after its disturbance"}\n`);
      for (const r of rows) console.log(`   ${String(r.scenario).padEnd(12)} ${r.series.join("  ")}`);
      console.log("");
      process.exitCode = 0;
      return;
    }

    if (args.liveCompPrune) {
      // b15e044d: my offline probe said a bypassed device costs 92.6%; Deckard's LIVE probe counted
      // process() calls on a SYNTHETIC worklet and got 0. Two variables changed between them —
      // renderer AND device. This changes one: his binary method, live, with a REAL CompFx.
      const r = await page.evaluate(() => globalThis.fxlabLiveCompPrune());
      console.log("\n  LIVE + REAL CompFx — is the upstream of a BYPASSED device still scheduled?\n");
      const pct = (n) => (r.active ? `${((n / r.active) * 100).toFixed(1)}%` : "n/a");
      console.log(`   active            ${String(r.active).padStart(5)} process() calls/s   (baseline, counter feeding the comp)`);
      // ★ THIS ROW IS EXPECTED TO BE NON-ZERO AND IT IS NOT THE QUESTION. CompFx is an INSERT with a
      // dry leg: bypassed, it still carries audio input→dry→output, so the counter upstream is
      // legitimately still reachable. What bypass prunes is the WET subgraph (the worklet), which a
      // counter placed upstream cannot see. Read the meter row, not this one.
      console.log(`   comp BYPASSED     ${String(r.bypassed).padStart(5)}   ${pct(r.bypassed)}  \u2190 setBypass(true) \u2014 non-zero EXPECTED: the dry leg still carries audio`);
      console.log(`   un-bypassed       ${String(r.reactivated).padStart(5)}   ${pct(r.reactivated)}  \u2190 the control: a zero that cannot come back is a broken probe`);
      console.log(`   output severed    ${String(r.severed).padStart(5)}   ${pct(r.severed)}  \u2190 the REFERENCE: an unambiguously cut path`);
      console.log(`   + wet meter cut   ${String(r.severedNoMeter).padStart(5)}   ${pct(r.severedNoMeter)}  \u2190 the AnalyserNode on the wet bus, also disconnected`);
      // ★ THE RIG HAS TO PROVE IT CAN SEE A PRUNE BEFORE ITS "NOT PRUNED" MEANS ANYTHING. If
      // severing the output does not zero the counter, this rig cannot observe pruning through a
      // CompFx at all, and the bypassed row is unreadable rather than negative.
      if (!(r.active > 0 && r.reactivated > 0)) {
        console.log("\n   \u2717 INCONCLUSIVE: the counter never ran, or never came back \u2014 nothing here is a measurement.\n");
        process.exitCode = 1;
        return;
      }
      if (r.severed !== 0 && r.severedNoMeter !== 0) {
        console.log("\n   \u2717 INCONCLUSIVE: even a SEVERED output keeps the counter running, so this rig cannot see a prune");
        console.log("   through a CompFx. The bypassed row above is unreadable, not negative \u2014 do not conclude from it.\n");
        process.exitCode = 1;
        return;
      }
      if (r.severed !== 0 && r.severedNoMeter === 0) {
        console.log("\n   \u2605 THE WET-BUS AnalyserNode is what keeps a CompFx's upstream scheduled: severing the output");
        console.log("   alone changes nothing, and cutting the meter as well is what zeroes it.\n");
        process.exitCode = 0;
        return;
      }
      console.log(
        `\n   ${r.bypassed === 0 ? "\u2713 PRUNED with the REAL device too \u2014 so the 92.6% was the OFFLINE RENDERER, not CompFx" : "\u2717 NOT pruned with the real device \u2014 the offline number was about CompFx, and setBypass's comment is wrong for it"}\n`,
      );
      process.exitCode = 0;
      return;
    }

    if (args.bypassCost) {
      // Verifying BaseFxDevice.setBypass's claim that a cut wet->output lets the engine prune the
      // whole subgraph. If true, an always-armed rack is free when idle; if false, every chain a DJ
      // builds is a standing bill on the audio thread (f2b8f545's lag, one candidate).
      const N = 24;
      const runs = [];
      // Each mode twice, interleaved, because a single timing is a measurement with nothing to
      // disagree with — and the second pass also pays any JIT warm-up the first one bought.
      for (let pass = 0; pass < 2; pass++)
        for (const mode of ["none", "active", "bypassed", "bypassed-nometer"]) runs.push(await page.evaluate(([n, m]) => globalThis.fxlabBypassCost(n, m), [N, mode]));
      const best = (m) => Math.min(...runs.filter((r) => r.mode === m).map((r) => r.ms));
      const none = best("none"), active = best("active"), bypassed = best("bypassed"), noMeter = best("bypassed-nometer");
      console.log(`\n  BYPASS COST — does a bypassed device still get rendered? (${N} comp devices in series, ${runs[0].seconds}s offline)\n`);
      for (const m of ["none", "active", "bypassed", "bypassed-nometer"]) {
        const all = runs.filter((r) => r.mode === m).map((r) => f(r.ms, 1)).join(" / ");
        console.log(`   ${m.padEnd(10)} ${f(best(m), 1).padStart(8)} ms   (runs: ${all})`);
      }
      const span = active - none;
      const share = span > 0 ? ((bypassed - none) / span) * 100 : 0;
      console.log(`\n   ${N} active devices cost   ${f(span, 1)} ms over the empty graph`);
      console.log(`   bypassed sits at         ${f(share, 1)}% of that`);
      // The control: if ACTIVE is not measurably dearer than NONE, the rig cannot see device cost
      // at all and the bypassed number below means nothing.
      if (span < none * 0.15) {
        console.log("\n   \u2717 INCONCLUSIVE: active devices are not measurably dearer than an empty graph, so this rig cannot see device cost \u2014 ignore the bypassed row.\n");
        process.exitCode = 1;
        return;
      }
      const meterShare = span > 0 ? ((noMeter - none) / span) * 100 : 0;
      console.log(`   with the wet METER cut it sits at ${f(meterShare, 1)}% \u2014 the only difference between those two rows`);
      console.log(
        `\n   ${share < 25 ? "\u2713 a bypassed device is PRUNED here \u2014 setBypass's comment holds in this renderer" : "\u2717 a bypassed device is STILL RENDERED HERE \u2014 setBypass's pruning claim does NOT hold in this renderer"}`,
      );
      if (share >= 25) {
        console.log(
          `   ${meterShare < 25 ? "\u2605 AND THE WET-BUS AnalyserNode IS WHY: it is a sink, so everything upstream of it stays reachable and nothing is pruned." : "   the meter is NOT the cause \u2014 cutting it changes nothing, so the reachability is somewhere else and this is unexplained."}\n`,
        );
      } else console.log("");
      // ★ WHAT THIS DOES NOT ESTABLISH, said here rather than left for the reader to remember.
      console.log("\n   \u2605 READ THIS BEFORE ACTING ON THE ROWS ABOVE. The renderer is an OfflineAudioContext, and an");
      console.log("   offline render is not obliged to prune the same graph a live one does \u2014 this harness already");
      console.log("   documents one offline/live divergence (port messages never reach a processor offline). So the");
      console.log("   finding is 'the offline renderer does not prune a bypassed device', and whether PRODUCTION pays");
      console.log("   this is UNCONFIRMED. Confirm on a live context before changing any code on account of it.");
      console.log("   Offline render time is also not real-time audio-thread load; only the RATIO is being claimed.");
      console.log("   \u2605 SETTLED SINCE: Deckard's scripts/liveprune.mjs counts process() calls on a LIVE context and");
      console.log("   gets a clean 0 for a simple node chain \u2014 so pruning DOES work live and this offline result is a");
      console.log("   renderer artefact for that case. What is still open is CompFx specifically: --live-comp-prune");
      console.log("   cannot make even a SEVERED CompFx output stop scheduling its upstream, so that rig cannot see a");
      console.log("   prune through this device and the question is unanswered rather than answered badly.\n");
      process.exitCode = 0;
      return;
    }

    if (args.snapshotSize) {
      // Thread ddf28822: an oversized snapshot relays fine and persists NEVER, silently, so a cold
      // restart serves a stale board. room.test.ts proved the behaviour; this asks whether a real
      // board can reach the 128 KiB DO value cap, from the engine rather than from an estimate.
      const CAP = 128 * 1024;
      const rows = [];
      for (const chains of [0, 1, 2, 4]) rows.push(await page.evaluate((c) => globalThis.fxlabSnapshotSize(c), chains));
      console.log("\n  SNAPSHOT SIZE — what a real board serialises to, against the 128 KiB DO value cap\n");
      for (const r of rows) {
        const pct = (r.bytes / CAP) * 100;
        console.log(
          `   ${String(r.chains).padStart(2)} stem chain(s)/deck   ${String(r.bytes).padStart(7)} bytes   ${f(pct, 1).padStart(6)}% of the cap   devices ${String(r.masterDevices + r.chainDevices).padStart(3)}   params ${String(r.params).padStart(4)}${r.bytes > CAP ? "   \u2190 OVER" : ""}`,
        );
      }
      const base = rows[0];
      const perChain = rows.length > 1 ? (rows[rows.length - 1].bytes - base.bytes) / (rows[rows.length - 1].chains * 2) : 0;
      console.log(`\n   a deck's permanent bank alone   ${base.bytes} bytes for both decks`);
      console.log(`   each stem chain adds            ~${Math.round(perChain)} bytes`);
      console.log(`   chains per deck to reach the cap ~${perChain > 0 ? Math.ceil((CAP - base.bytes) / (perChain * 2)) : "n/a"}`);
      // REPORTS. The question it answers is "is ddf28822 theoretical or live", and the answer is a
      // number, not a verdict — the UI caps how many chains a DJ can build, and this says nothing
      // about lyrics or stem views, which ride their own keys with their own bounds.
      console.log(`\n   ${rows.some((r) => r.bytes > CAP) ? "\u2717 a REACHABLE board exceeds the cap \u2014 ddf28822 is live, not theoretical" : "\u2713 no configuration measured here reaches the cap"}\n`);
      process.exitCode = 0;
      return;
    }

    if (args.codecMargin) {
      // Thread 3495e865: on a browser with no lossless capture (Safari/iOS) a take is lossy by
      // necessity, and bufferToWav CLAMPS at ±1. Deckard's 0.079 dB of room was measured on a
      // steady sine — the easiest thing a codec ever sees. This asks what a hot broadband mix has,
      // and whether Recorder's fit keeps it out of the clamp.
      const clean = await page.evaluate(() => globalThis.fxlabCodecMargin(false));
      const lossy = await page.evaluate(() => globalThis.fxlabCodecMargin(true));
      const repeat = await page.evaluate(() => globalThis.fxlabCodecMargin(false));
      console.log("\n  CODEC MARGIN — does a LOSSY take survive the ±1 save clamp?\n");
      console.log(`   limiter GR             ${f(clean.grDb, 2)} dB   ceiling ${f(clean.ceiling, 6)}  \u2190 the mix is working the brickwall`);
      for (const [name, r] of [["lossless (truth)", clean], ["LOSSY (iOS path)", lossy]]) {
        const raw = r.takePeak / (r.fitGain || 1);
        console.log(
          `   ${name.padEnd(17)} ${String(r.mime).padEnd(26)} decoded peak ${f(raw, 6)}   saved peak ${f(r.takePeak, 6)}   fit ${f(20 * Math.log10(r.fitGain), 3).padStart(7)} dB   clamped ${r.clipped}`,
        );
      }
      // Determinism first: the lossless take is only ground truth if the rig repeats.
      const drift = Math.abs(20 * Math.log10(repeat.takePeak / clean.takePeak));
      console.log(`\n   rig determinism        lossless run twice: ${f(clean.takePeak, 6)} vs ${f(repeat.takePeak, 6)}  (${f(drift, 3)} dB apart)`);
      if (drift > 0.01) {
        console.log("\n   \u2717 INCONCLUSIVE: the two lossless runs disagree, so the lossless take is not ground truth and nothing below is measurable here.\n");
        process.exitCode = 1;
        return;
      }
      const rawLossy = lossy.takePeak / (lossy.fitGain || 1);
      const overshootDb = 20 * Math.log10(rawLossy / clean.takePeak);
      console.log(`   codec overshoot        ${f(overshootDb, 3)} dB on broadband, against ${f(20 * Math.log10(1 / clean.ceiling), 3)} dB of room  (a sine overshoots by 0.221 dB \u2014 this is why a sine was the wrong stimulus)`);
      // The control must FAIL: if the lossy path did NOT need fitting on this material, the probe
      // never reached the defect and the shipped row below proves nothing.
      const defectReached = lossy.fitGain < 1;
      const fixHolds = lossy.clipped === 0 && clean.fitGain === 1;
      console.log(
        `\n   ${!defectReached ? "\u2717 INCONCLUSIVE: the lossy take never exceeded full scale, so this material does not reach the clamp \u2014 ignore the rows above" : fixHolds ? "\u2713 the lossy take needed fitting and got it (0 clamped), and the lossless take was left untouched" : "\u2717 a take would still be clamped on save"}\n`,
      );
      console.log("   It says nothing about material louder or denser than this one.\n");
      process.exitCode = defectReached && fixHolds ? 0 : 1;
      return;
    }

    if (args.captureTap) {
      const shipped = await page.evaluate(() => globalThis.fxlabCaptureTap(false));
      const control = await page.evaluate(() => globalThis.fxlabCaptureTap(true));
      console.log("\n  CAPTURE TAP — is a recorded take under the master ceiling, or clipped?\n");
      console.log(`   shipped (post-ceiling tap)  GR ${f(shipped.grDb, 2)} dB   captured peak ${f(shipped.capturePeak, 4)}   ceiling ${f(shipped.ceiling, 4)}`);
      console.log(`   CONTROL (pre-limiter tap)   GR ${f(control.grDb, 2)} dB   captured peak ${f(control.capturePeak, 4)}   \u2190 must EXCEED the ceiling`);
      // THE CLAIM IS ABOUT THE ENCODER, NOT THE CEILING. encodeWav clamps at ±1, so "the take is
      // clipped" means peak > 1 — that is the defect 660cb4a fixed and the only thing this probe
      // should certify. Whether the limiter sits exactly on its own -0.3 dB ceiling is a separate
      // question about the limiter, reported below rather than folded into this verdict.
      const controlClips = control.capturePeak > 1;
      const ok = controlClips && shipped.grDb > 0.5 && shipped.capturePeak > 0.01 && shipped.capturePeak <= 1;
      console.log(`\n   ${!controlClips ? "\u2717 INCONCLUSIVE: the control did not clip, so this probe cannot catch the bug \u2014 ignore the shipped row" : ok ? "\u2713 the control CLIPS (>1, the encoder would clamp it) and the shipped take does not" : "\u2717 the shipped take would still be clamped by the encoder"}\n`);
      const over = 20 * Math.log10(shipped.capturePeak / shipped.ceiling);
      if (over > 0.02) console.log(`   note: the shipped take sits ${f(over, 2)} dB ABOVE the limiter's nominal -0.3 dB ceiling. Under 1 (so not clipped), but a brickwall that overshoots its own ceiling is a question about the LIMITER, unexplained and not chased here.\n`);
      process.exitCode = ok ? 0 : 1;
      return;
    }

    if (args.headroomPath) {
      const rows = await page.evaluate(() => globalThis.fxlabHeadroomPath());
      console.log("\n  HEADROOM PATH — the master limiter's own gain reduction on identical hot material:\n");
      for (const r of rows) console.log(`   ${r.name.padEnd(14)} headroom ${String(r.headroomDb).padStart(3)} dB   limiter GR ${f(r.grDb, 2).padStart(6)} dB`);
      const hot = rows.find((r) => r.headroomDb === 0);
      const quiet = rows.find((r) => r.headroomDb === -20);
      const ok = (hot?.grDb ?? 0) > 1 && (quiet?.grDb ?? 1) < 0.1;
      console.log(`\n   ${ok ? "\u2713 the trim is BEFORE the limiter \u2014 pulling it down takes the limiter out of reduction" : "\u2717 inconclusive: the limiter did not reduce at all, or the trim did not reach it"}\n`);
      process.exitCode = ok ? 0 : 1;
      return;
    }

    if (args.sidechainRepatch) {
      const rows = await page.evaluate(() => globalThis.fxlabSidechainRepatch());
      console.log("\n  SIDECHAIN RE-PATCH — after the comp device is REBUILT, is the other deck still wired to its detector?\n");
      for (const r of rows) {
        console.log(`   ${r.name.padEnd(18)} re-patched ${r.connected ? "yes" : "NO "}   to the FRESH device ${r.toFresh ? "yes" : "NO "}${r.control ? "   \u2190 control, must be NO" : ""}`);
      }
      const armed = rows.find((r) => !r.control);
      const ctrl = rows.find((r) => r.control);
      const ok = !!armed?.toFresh && !ctrl?.connected;
      console.log(`\n   ${ok ? "\u2713 the patch follows the device that exists, and the pre-fix control stays unwired" : "\u2717 inconclusive \u2014 the control did not fail, so this proves nothing"}\n`);
      process.exitCode = ok ? 0 : 1;
      return;
    }

    if (args.masterDuck) {
      const rows = await page.evaluate(() => globalThis.fxlabMasterDuck());
      console.log("\n  MASTER DUCK — how far deck A's 1 kHz tone moves when deck B's kick lands, with NO deck control engaged:\n");
      for (const r of rows) {
        console.log(
          `   ${r.name.padEnd(18)} duck ${f(r.duckDb, 2).padStart(7)} dB   recover ${Number.isFinite(r.recoverMs) ? f(r.recoverMs, 0).padStart(4) + " ms" : "  >beat"}   tone harmonics ${Number.isFinite(r.kickThd) ? f(r.kickThd, 1).padStart(6) + " dB" : "     n/a"}   peak ${f(r.peak, 3)}${r.control ? "  \u2190 control, must be ~0" : ""}`,
        );
      }
      const worstControl = Math.max(...rows.filter((r) => r.control).map((r) => Math.abs(r.duckDb)));
      console.log(`\n   controls worst |duck| = ${f(worstControl, 2)} dB ${worstControl < 0.3 ? "\u2713 the probe reads the tone, not itself" : "\u2717 the probe is measuring its own stimulus \u2014 the numbers above mean nothing"}\n`);
      process.exitCode = worstControl < 0.3 ? 0 : 1;
      return;
    }

    if (args.gateAlign) {
      console.log("\n  GATE beat alignment — phase error of each gate opening, in CYCLES (0 = on the grid):\n");
      for (const on of [true, false]) {
        const r = await page.evaluate((on) => globalThis.fxlabGateAlign(on), on);
        const err = r.cycleErr;
        const worst = err.length ? Math.max(...err.map((e) => Math.abs(e))) : NaN;
        console.log(`   ALIGN ${on ? "on " : "off"}  (${err.length} openings, period ${f(r.period, 3)}s)`);
        console.log(`      ${err.slice(0, 12).map((e) => (e >= 0 ? "+" : "") + f(e, 3)).join("  ")}`);
        console.log(`      worst |error| = ${f(worst, 3)} cycles${on ? "  ← the grid line is at 0" : "  ← the grid was deliberately set 0.31 of a cycle away"}`);
      }
      console.log("");
      return;
    }

    if (args.modWidth) {
      const r = await page.evaluate(() => globalThis.fxlabModWidth([0, 0.25, 0.5, 0.75, 1]));
      console.log("\n  MOD stereo WIDTH — what it buys, and what a mono sum costs:\n");
      console.log("   width   L/R corr   mono sum vs L");
      for (const x of r) console.log(`   ${f(x.width, 2).padStart(5)}   ${f(x.corr, 3).padStart(8)}   ${f(x.monoVsLeftDb, 2).padStart(8)} dB`);
      console.log("");
      return;
    }

    if (args.shaperLatency) {
      console.log(`\n  WaveShaper oversample="4x" latency, measured with an identity curve:`);
      for (const sr of [44100, 48000, 96000]) {
        const r = await page.evaluate((sr) => globalThis.fxlabShaperLatency(sr), sr);
        console.log(`   ${String(sr).padStart(6)} Hz: direct @ ${r.direct}  shaped @ ${r.shaped}  lag ${String(r.lagSamples).padStart(4)} samples = ${f((r.lagSamples / r.sr) * 1000, 3)} ms   (pre-peak energy ${r.energyBefore.toExponential(1)})`);
      }
      console.log("");
      return;
    }

    if (args.liveAudit) {
      // ★ Every step metric here is measured on a REAL-TIME AudioContext, which is why it takes
      // wall-clock minutes. The offline path cannot answer this question for a worklet device at
      // all: OfflineAudioContext.suspend() injects a ×12 step into ANY worklet graph (see
      // --suspend-quirk), so those verdicts measured Chromium, not the DSP.
      console.log(`\n  FXLAB · live gesture audit${args.quick ? " (quick: worklet devices, 1 run each)" : ""} — splice-prone gestures, on the wall clock\n`);
      const r = await page.evaluate((q) => globalThis.fxlabLiveAudit(q ? 1 : 3, q), !!args.quick);
      let dev = "";
      for (const c of r.checks) {
        const d = c.name.split(" ")[0];
        if (d !== dev) {
          dev = d;
          console.log("");
        }
        console.log(`   ${c.pass ? "✓" : "✗"} ${c.name.padEnd(40)} ${f(c.value, 2).padStart(7)} ${c.unit.padEnd(14)} ${c.detail}`);
      }
      const bad = r.checks.filter((c) => !c.pass);
      console.log(`\n  ${r.checks.length - bad.length}/${r.checks.length} pass${bad.length ? ` — ${bad.length} to look at:\n   ${bad.map((c) => c.name).join("\n   ")}` : ""}\n`);
      process.exitCode = r.ok ? 0 : 1;
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
