// Pure-Node smoke test of the wasm core (no browser): generate a sine, load it,
// render it back block by block, and check the output reconstructs the input.
// This gates the core logic before the AudioWorklet integration.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(new URL("../target/wasm32-unknown-unknown/release/htl_engine.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const x = instance.exports;

// memory.buffer detaches whenever the heap grows, so always take a fresh view.
const f32 = (ptr, len) => new Float32Array(x.memory.buffer, ptr, len);

const SR = 48000;
const FREQ = 220;
const AMP = 0.5;
const FRAMES = SR; // 1 second

// Generate the sine into wasm memory (planar L == R).
const lPtr = x.engine_alloc(FRAMES);
const rPtr = x.engine_alloc(FRAMES);
{
  const L = f32(lPtr, FRAMES);
  const R = f32(rPtr, FRAMES);
  for (let i = 0; i < FRAMES; i++) {
    const s = AMP * Math.sin((2 * Math.PI * FREQ * i) / SR);
    L[i] = s;
    R[i] = s;
  }
}

const e = x.engine_new(SR);
x.engine_load(e, lPtr, rPtr, FRAMES, 2);
x.engine_set(e, 0, 1); // play

// Render in 128-frame quanta like the worklet will, accumulating RMS + peak.
const N = 128;
let sumSq = 0;
let count = 0;
let peak = 0;
for (let done = 0; done < FRAMES; done += N) {
  const outPtr = x.engine_process(e, N);
  const out = f32(outPtr, N * 2); // [L(0..N), R(0..N)]
  for (let i = 0; i < N; i++) {
    const v = out[i];
    sumSq += v * v;
    count++;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
}

const rms = Math.sqrt(sumSq / count);
const expectedRms = AMP / Math.SQRT2;
const playheadSec = x.engine_playhead(e);

const result = {
  rms: +rms.toFixed(4),
  expectedRms: +expectedRms.toFixed(4),
  peak: +peak.toFixed(4),
  playheadSec: +playheadSec.toFixed(4),
  rmsError: +Math.abs(rms - expectedRms).toFixed(4),
};
console.log("RESULT", JSON.stringify(result));

const pass = result.rmsError < 0.01 && result.peak > 0.45 && Math.abs(result.playheadSec - 1.0) < 0.01;
console.log(pass ? "PASS: core reconstructs the loaded sine" : "FAIL");
process.exit(pass ? 0 : 1);
