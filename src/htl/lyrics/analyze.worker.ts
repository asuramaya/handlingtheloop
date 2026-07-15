/// <reference lib="webworker" />
// The vocal stem's TIMING evidence, off the main + audio threads.
//
// ★ WHAT THIS REPLACED, AND WHY. This file used to load Whisper from a CDN and transcribe the vocal
// stem — 586-759 MB of model, tens of seconds of autoregressive GPU decode, and on real tracks it
// mostly HALLUCINATED. That isn't a model-size failure (large-v3-turbo failed too): a generative
// model samples the next token conditioned on audio it finds ambiguous, and sung vowels are
// maximally ambiguous, so inventing words is IN ITS OUTPUT SPACE. Meanwhile the words to nearly
// every song are already written down (see lrclib.ts — 92% of a real library came back line-synced).
//
// So the model is gone, and what's left is the part that was always ours to do: measure WHEN the
// singing happens. Two numbers out of the isolated vocal, both cheap CPU DSP, no download, no GPU:
//
//   onsets  — spectral flux peaks: the instant a vocal note/consonant STARTS.
//   env     — a short-time energy envelope: WHERE there is a voice at all.
//
// The alignment itself (lrcAlign.ts) is a pure function, so it is unit-tested rather than
// eyeballed; this worker exists only to keep ~30k FFTs off the UI thread.
import { FFT, hannPeriodic } from "../stems/fft";
import { alignLrc, alignPlain } from "./lrcAlign";
import type { LyricsLine } from "./types";

const SR = 16000; // everything below works at 16 kHz mono — plenty for onsets and energy

/** Linear-resample mono PCM to 16 kHz. */
export function to16k(pcm: Float32Array, sampleRate: number): Float32Array {
  if (Math.abs(sampleRate - SR) < 1) return pcm;
  const ratio = sampleRate / SR;
  const n = Math.floor(pcm.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = x | 0;
    const f = x - i0;
    out[i] = (pcm[i0] || 0) * (1 - f) + (pcm[i0 + 1] || 0) * f;
  }
  return out;
}

// ---- ONSETS: when did a vocal note start? ------------------------------------------------
// Half-wave-rectified spectral flux with an adaptive peak-pick. Reliable ONLY because the vocal is
// isolated — on a full mix the drums would drown every one of these peaks. This is the one place
// stem separation buys us something no cleverness could replace.
const ON_N = 1024;
const ON_HOP = 160; // 10 ms @ 16 kHz
const ON_BINS = ON_N / 2;
const onFft = new FFT(ON_N);
const onWin = hannPeriodic(ON_N);

export function detectOnsets(audio: Float32Array): { times: number[]; strengths: number[] } {
  const frames = Math.floor((audio.length - ON_N) / ON_HOP) + 1;
  if (frames < 4) return { times: [], strengths: [] };
  const re = new Float32Array(ON_N);
  const im = new Float32Array(ON_N);
  let prevMag = new Float32Array(ON_BINS);
  let curMag = new Float32Array(ON_BINS);
  const flux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * ON_HOP;
    for (let i = 0; i < ON_N; i++) {
      re[i] = (audio[off + i] || 0) * onWin[i];
      im[i] = 0;
    }
    onFft.transform(re, im, false);
    let fl = 0;
    for (let k = 0; k < ON_BINS; k++) {
      const m = Math.hypot(re[k], im[k]);
      curMag[k] = m;
      const d = m - prevMag[k];
      if (d > 0) fl += d; // half-wave-rectified spectral flux
    }
    flux[f] = fl;
    const t = prevMag;
    prevMag = curMag;
    curMag = t;
  }
  // Adaptive peak-pick: a local max comfortably above its local mean, ≥50 ms apart.
  //
  // ★ AND KEEP HOW STRONG EACH ONE WAS. A sung note ATTACK and a vibrato ripple inside a held vowel
  // are both local maxima of spectral flux, and this detector cannot tell them apart — it fired 647
  // times on a track with 160 words. But an attack is a far BIGGER spike than a ripple, so the
  // strength is exactly the evidence that separates them. Throwing it away (as this did) forces
  // every downstream consumer to treat a vibrato wobble as a possible word start.
  const times: number[] = [];
  const strengths: number[] = [];
  const W = 8; // ±80 ms local window
  let lastF = -100;
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, f - W); j <= Math.min(frames - 1, f + W); j++) {
      s += flux[j];
      c++;
    }
    const mean = s / c;
    if (flux[f] > mean * 1.6 + 1e-6 && f - lastF >= 5) {
      times.push((f * ON_HOP) / SR);
      strengths.push(flux[f] / (mean + 1e-9)); // how far above its neighbourhood this spike stands
      lastF = f;
    }
  }
  return { times, strengths };
}

// ---- ENERGY: where is there a voice at all? ----------------------------------------------
/** RMS per `hop` seconds. Smoothed a little, so one glottal gap doesn't read as silence. */
export const ENV_HOP = 0.05; // 50 ms — fine enough to place a line, coarse enough to be cheap
export function energyEnvelope(audio: Float32Array): Float32Array {
  const hop = Math.round(ENV_HOP * SR);
  const frames = Math.max(1, Math.floor(audio.length / hop));
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const off = f * hop;
    for (let i = 0; i < hop; i++) {
      const v = audio[off + i] || 0;
      s += v * v;
    }
    env[f] = Math.sqrt(s / hop);
  }
  // A 3-frame max-smooth: a breath between words must not carve a line in half.
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    out[f] = Math.max(env[Math.max(0, f - 1)], env[f], env[Math.min(frames - 1, f + 1)]);
  }
  return out;
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type !== "align") return;
  const { id, pcm, sampleRate, lines, plain, duration } = msg as {
    id: number;
    pcm: Float32Array;
    sampleRate: number;
    lines?: LyricsLine[]; // line-synced (the good case)
    plain?: string[]; // ...or the right words with NO clock at all — forced alignment's home ground
    duration: number;
  };
  try {
    const audio = to16k(pcm, sampleRate);
    (self as unknown as Worker).postMessage({ type: "progress", phase: "onsets", pct: 30, id });
    const { times: onsets, strengths } = detectOnsets(audio);
    (self as unknown as Worker).postMessage({ type: "progress", phase: "energy", pct: 70, id });
    const env = energyEnvelope(audio);
    (self as unknown as Worker).postMessage({ type: "progress", phase: "align", pct: 90, id });
    const out = plain?.length
      ? alignPlain({ text: plain, onsets, strengths, env, hop: ENV_HOP, duration })
      : alignLrc({ lines: lines ?? [], onsets, strengths, env, hop: ENV_HOP, duration });
    (self as unknown as Worker).postMessage({ type: "done", id, lines: out.lines, report: out.report, onsets: onsets.length });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: "error", id, message: String((err as Error)?.message ?? err) });
  }
};
