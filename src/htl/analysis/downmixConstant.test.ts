import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// EIGHT INDEPENDENT HAND-COPIES OF THE SAME DOWNMIX, AND EXTRACTING THEM WOULD BE WORSE.
//
// `(ch0[i] + ch1[i]) * 0.5` appears eight times across analysis, the deck, the waveform envelope
// and the fingerprint. Deckard raised it as the drift shape we have been naming all session and
// then argued against extracting it, and he is right: seven of the eight are FUSED into a loop that
// is already doing something else — accumulating a window, striding a decimation, filling a pyramid
// bucket. There is no loop to extract, only an operation, and extracting an operation means a call
// per sample over tens of millions of samples on the load path. A shared buffer-pass helper would
// cost a whole extra traversal and a 46 MB allocation, which is precisely what 93257e4 removed.
//
// So the duplication stays, and the drift risk is answered the way we have answered it all night:
// with an instrument instead of an abstraction. The copies may differ in shape — they must not
// differ in WHAT THEY COMPUTE. A seventh copy at 0.707, or a "fix" to one site only, fails here.
//
// This scan deliberately crosses directory boundaries, because three of the eight live outside
// src/htl/analysis and a scan that stopped there would have the population hole that both of
// tonight's scans turned out to have (89b720f4, and Deckard's own f857959).

const ROOTS = ["src/htl/analysis", "src/htl/audio", "src/components", "src/htl/fingerprint"];
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([^:])\/\/.*$/gm, "$1");

/** A sum of two arrays at the SAME index, scaled by a constant — a two-channel downmix. */
const MIX = /\(\s*(\w+)\[([^\]]+)\]\s*\+\s*(\w+)\[([^\]]+)\]\s*\)\s*\*\s*([0-9.]+)/g;

function sites(): { file: string; text: string; k: string }[] {
  const out: { file: string; text: string; k: string }[] = [];
  for (const root of ROOTS) {
    for (const name of readdirSync(root)) {
      if (!/\.tsx?$/.test(name) || /\.test\./.test(name)) continue;
      const p = join(root, name);
      if (statSync(p).isDirectory()) continue;
      for (const m of stripComments(readFileSync(p, "utf8")).matchAll(MIX)) {
        if (m[2] !== m[4]) continue; // different indices — not a channel pair
        out.push({ file: p, text: `(${m[1]}[${m[2]}] + ${m[3]}[${m[4]}]) * ${m[5]}`, k: m[5] });
      }
    }
  }
  return out;
}

describe("every hand-copied stereo downmix computes the same thing", () => {
  it("the scan found the copies (vacuity guard) — a scan matching nothing passes forever", () => {
    expect(sites().length).toBeGreaterThanOrEqual(8);
  });

  it("all of them scale by exactly 0.5", () => {
    const wrong = sites().filter((s) => s.k !== "0.5");
    expect(wrong.map((s) => `${s.file}: ${s.text}`)).toEqual([]);
  });

  it("CONTROL: the matcher reads the constant, so a different one would be caught", () => {
    const found = [...stripComments("const x = (a[i] + b[i]) * 0.707;").matchAll(MIX)];
    expect(found).toHaveLength(1);
    expect(found[0][5]).toBe("0.707");
  });

  it("CONTROL: a sum at DIFFERENT indices is not a downmix and is not counted", () => {
    const m = [...stripComments("const y = (a[i] + b[i + 1]) * 0.5;").matchAll(MIX)];
    expect(m).toHaveLength(1);
    expect(m[0][2]).not.toBe(m[0][4]); // the filter above drops it
  });
});
