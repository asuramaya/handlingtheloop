import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeChannels } from "./analyze";

// THE WORKER IS SENT A MONO MIX, AND THAT IS ONLY SAFE WHILE NOTHING DOWNSTREAM WANTS STEREO.
//
// analyzeTrackAsync used to copy and transfer both channels. Every consumer downmixes first, with
// the same expression — computePyramidFromChannels, the key chromagram, and beats.ts's decimateMono
// each compute `(ch0[i] + ch1[i]) * 0.5` — so the second channel crossed the boundary purely to be
// averaged away three times. Mixing on the near side halves the allocation and the transfer.
//
// That rests on a CLOSED-WORLD CLAIM about the consumers, which is the kind of sentence that is true
// when written and quietly false later. So the scan below is the real test here: it reads the
// analysis sources and fails if any consumer of channel 1 stops using that exact downmix — because
// such a consumer would now be handed a mono mix and would silently measure the wrong thing. The
// equivalence test above it is the cheaper half.

describe("analysis is mono-safe", () => {
  it("gives the same answer from a pre-mixed mono channel as from the stereo pair", () => {
    const SR = 48000;
    const SECS = 40;
    const n = SR * SECS;
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    let s = 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    for (let t = 1; t < SECS - 1; t += 60 / 128) {
      const at = Math.round(t * SR);
      for (let i = 0; i < SR * 0.25 && at + i < n; i++) {
        const u = i / SR;
        const v = Math.exp(-u * 18) * Math.sin(2 * Math.PI * (52 + 60 * Math.exp(-u * 40)) * u);
        a[at + i] += v;
        b[at + i] += v * 0.92; // genuinely different channels, or the test proves nothing
      }
      const ha = Math.round((t + 0.234) * SR);
      for (let i = 0; i < SR * 0.04 && ha + i < n; i++) {
        const e = Math.exp(-(i / SR) * 90) * 0.2;
        a[ha + i] += rnd() * e;
        b[ha + i] += rnd() * e;
      }
    }
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (a[i] + b[i]) * 0.5;

    const st = analyzeChannels(a, b, SR);
    const mo = analyzeChannels(mono, null, SR);
    expect(mo.bpm).toBeCloseTo(st.bpm!, 6);
    expect(mo.key?.camelot).toBe(st.key?.camelot);
    expect(mo.energy).toBeCloseTo(st.energy, 6);
    expect(mo.beatgrid?.downbeat).toBe(st.beatgrid?.downbeat);
    expect(mo.beatgrid?.beats?.length).toBe(st.beatgrid?.beats?.length);
    let worst = 0;
    const p = st.beatgrid?.beats;
    const q = mo.beatgrid?.beats;
    if (p && q) for (let i = 0; i < p.length; i++) worst = Math.max(worst, Math.abs(p[i] - q[i]));
    expect(worst).toBeLessThan(1e-4); // sub-0.1 ms; it measured exactly 0 on this material
  }, 120_000);

  it("the scanned directory IS the whole consumer set — the scan's own population, checked", () => {
    // ★ THE HOLE METRON'S ANALYSER SCAN HAD, ASKED OF MINE BEFORE IT BITES. His scan read
    // src/htl/audio and src/components, so the one file where he had actually made the mistake —
    // in scripts/ — was outside its population and it could not see it. The scan below reads
    // src/htl/analysis. That is only sufficient while the analyzeTrack chain cannot reach a
    // channel consumer living somewhere else, which is an assumption, and an unchecked assumption
    // about a population is what this whole class of failure is made of.
    //
    // So it is checked: the chain's imports are enumerated, and anything leaving this directory has
    // to be named here with the reason it cannot consume a channel pair. A new outside import fails
    // this test and forces that question to be answered rather than inherited.
    const OUTSIDE_OK: Record<string, string> = {
      "../stems/fft": "takes plain Float32Arrays, never an AudioLike or a channel pair — it cannot read channel 1",
    };
    const offenders: string[] = [];
    // ★ AND THE ROSTER IS DERIVED, NOT WRITTEN DOWN. This named three files. There are ten modules
    // in this directory, so a hand-written roster is itself a closed-world claim about which of
    // them form the chain — the exact "a comment that COUNTS or NAMES its neighbours is
    // load-bearing" shape, in test form. Add an outside import to palette.ts or debrick.ts and a
    // three-file roster passes while the population it stands for has quietly widened. Reading the
    // directory costs nothing and cannot go stale. (Checked at the time of writing: only analyze.ts
    // and beats.ts reach outside at all, both to ../stems/fft, so this widening is free today —
    // which is the point. It was free to state correctly and it was not stated correctly.)
    const chain = readdirSync(__dirname).filter((f) => /\.ts$/.test(f) && !/\.test\./.test(f));
    expect(chain.length).toBeGreaterThanOrEqual(3); // vacuity: an empty roster scans nothing
    for (const f of chain) {
      const src = readFileSync(join(__dirname, f), "utf8");
      for (const m of src.matchAll(/^import\s+(?:type\s+)?.*?from\s+"([^"]+)"/gm)) {
        const spec = m[1];
        if (spec.startsWith("./")) continue; // inside the scanned directory
        if (spec in OUTSIDE_OK) continue;
        offenders.push(`${f} imports ${spec}`);
      }
    }
    expect(
      offenders,
      `the analysis chain now reaches outside src/htl/analysis. If any of these can be handed an AudioLike or a channel pair, the downmix scan below is blind to it:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no analysis consumer reads channel 1 except to average it", () => {
    const dir = __dirname;
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.includes(".test."))) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/ch1\[[^\]]+\]/g)) {
        const at = m.index ?? 0;
        const around = src.slice(Math.max(0, at - 80), at + 40).replace(/\s+/g, " ");
        // The one sanctioned shape, in either operand order.
        if (/\(\s*ch0\[[^\]]+\]\s*\+\s*ch1\[[^\]]+\]\s*\)\s*\*\s*0\.5/.test(around)) continue;
        offenders.push(`${f}: …${around.slice(-70)}`);
      }
    }
    expect(
      offenders,
      `these read channel 1 some other way — analyzeTrackAsync now sends a MONO mix, so they would be measuring the wrong signal:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
