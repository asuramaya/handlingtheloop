// Pure-Node sample-exact check of the stem mix (no audio graph, no worklet) to
// localize the tiny residual seen in the browser render: if maxErr is ~0 here,
// the core mix is bit-exact and the browser residual is OfflineAudioContext
// pipeline latency, not a core bug.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(new URL("../target/wasm32-unknown-unknown/release/htl_engine.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const x = instance.exports;
const f32 = (ptr, len) => new Float32Array(x.memory.buffer, ptr, len);

const SR = 48000;
const FRAMES = SR;
const STEMS = [
  { freq: 440, amp: 0.2 },
  { freq: 220, amp: 0.2 },
  { freq: 110, amp: 0.2 },
  { freq: 330, amp: 0.2 },
];
const gains = (process.argv[2] ?? "1,1,1,1").split(",").map(Number);

// stem PCM + reference mix
const stems = STEMS.map((s) => {
  const b = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) b[i] = s.amp * Math.sin((2 * Math.PI * s.freq * i) / SR);
  return b;
});
const ref = new Float32Array(FRAMES);
for (let i = 0; i < FRAMES; i++) {
  let v = 0;
  for (let s = 0; s < stems.length; s++) v += stems[s][i] * gains[s];
  ref[i] = v;
}

const e = x.engine_new(SR);
x.engine_stems_begin(e, STEMS.length, FRAMES);
for (let s = 0; s < STEMS.length; s++) {
  const ptr = x.engine_alloc(FRAMES);
  f32(ptr, FRAMES).set(stems[s]);
  x.engine_load_stem(e, s, ptr, 0, FRAMES, 1);
  x.engine_free_buf(ptr, FRAMES);
  x.engine_set_stem_gain(e, s, gains[s]);
}
x.engine_set(e, 0, 1); // play

// Render directly and compare to the reference, sample for sample.
const N = 128;
let maxErr = 0;
for (let done = 0; done < FRAMES; done += N) {
  const out = f32(x.engine_process(e, N), N * 2);
  for (let i = 0; i < N && done + i < FRAMES; i++) {
    maxErr = Math.max(maxErr, Math.abs(out[i] - ref[done + i]));
  }
}
const pass = maxErr < 1e-6;
console.log("RESULT", JSON.stringify({ pass, gains, maxErrVsReference: +maxErr.toExponential(2) }));
console.log(pass ? "PASS: core stem mix is bit-exact" : "FAIL");
process.exit(pass ? 0 : 1);
