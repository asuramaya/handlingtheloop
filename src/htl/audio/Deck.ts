import type { Beatgrid, KeyInfo, Pyramid, PyramidLevel } from "../analysis/analyze";
import { beatTimeOffset, nearestBeat, shiftKey } from "../analysis/analyze";

// WSOLA stretch-engine config posted to the worklet. The preset numbers (frame/
// search/stride) plus the optional quality toggles wired from the Audio settings tab.
export interface StretchEngineConfig {
  frame: number;
  search: number;
  stride: number;
  engine?: "wsola" | "pv"; // time-stretch algorithm: WSOLA (time-domain) or phase-locked vocoder (STFT)
  transient?: boolean; // preserve attacks (copy 1:1, no WSOLA doubling / PV phase reset)
  aa?: boolean; // anti-aliased windowed-sinc resampling when pitching up
  tThresh?: number; // transient-detector flux/EMA threshold (lower = more sensitive)
}

// Base (level-0) waveform envelope for one stem: per-256-sample-bucket min/max + the
// normalized low/mid/high band energies. On mobile this is computed in the SAME pass
// that packs the stem to int16 (loadEnginePcm), so the raw float32 buffers can be freed
// the instant stems are handed off — the LOD ladder downsamples from this, no PCM needed.
const STEM_BASE_BUCKET = 256;
interface StemBaseLevel {
  min: Float32Array;
  max: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  length: number;
  sampleRate: number;
  bucket: number;
}

// LOD pyramid from a precomputed level-0 min/max envelope (bands zeroed — stems
// colour per-stem, not by band). Cheap O(count) downsample; the O(n) min/max pass
// is done time-sliced by the caller so nothing blocks.
function buildLodPyramid(
  min: Float32Array,
  max: Float32Array,
  length: number,
  sr: number,
  bucket: number,
  // Optional per-bucket band energy (0..1) for the level-0 mip — gives stem lanes the
  // same rekordbox frequency colouring as the mix. Omitted (remote-stem display, which
  // has no PCM to band-split) → zeroed, and the renderer falls back to the flat colour.
  low0?: Float32Array,
  mid0?: Float32Array,
  high0?: Float32Array,
): Pyramid {
  const zeros = (k: number) => new Float32Array(k);
  const L0 = low0 ?? zeros(min.length);
  const M0 = mid0 ?? zeros(min.length);
  const H0 = high0 ?? zeros(min.length);
  const levels: PyramidLevel[] = [{ bucket, min, max, low: L0, mid: M0, high: H0 }];
  while (levels[levels.length - 1].min.length > 1) {
    const prev = levels[levels.length - 1];
    const pc = prev.min.length;
    const nc = Math.ceil(pc / 2);
    const lvl: PyramidLevel = { bucket: prev.bucket * 2, min: zeros(nc), max: zeros(nc), low: zeros(nc), mid: zeros(nc), high: zeros(nc) };
    for (let i = 0; i < nc; i++) {
      const a = i * 2;
      const b = Math.min(pc - 1, a + 1);
      lvl.min[i] = Math.min(prev.min[a], prev.min[b]);
      lvl.max[i] = Math.max(prev.max[a], prev.max[b]);
      lvl.low[i] = (prev.low[a] + prev.low[b]) * 0.5;
      lvl.mid[i] = (prev.mid[a] + prev.mid[b]) * 0.5;
      lvl.high[i] = (prev.high[a] + prev.high[b]) * 0.5;
    }
    levels.push(lvl);
  }
  return { sampleRate: sr, length, levels };
}
import { STEM_NAMES, type StemName, type Stems } from "../stems";
import { isMobileDevice } from "../stems/models";
import { decodeAudio } from "./decode";
import { Eq3, EQ_HP, EQ_LP } from "./Eq3";

// A single deck: source -> EQ3 -> trim gain -> output (into the crossfader).
//
// AudioBufferSourceNode is one-shot, so play/seek/tempo rebuild it; position is
// reconstructed from context time so the playhead stays continuous. The deck
// owns tempo (so Sync can drive it and the UI reflects it), 8 hot cues, and a
// beat-based loop implemented with the source node's native loopStart/loopEnd.

export const HOT_CUE_COUNT = 8;

// Serializable per-deck stem waveform envelopes — the host ships these over the
// session so a stem-less remote (a phone) can render the 4-lane display. A COARSE
// LOD level (≈2048-sample buckets), min/max quantized to int8 + base64, keeps it
// ~70 KB/track. The remote rebuilds a full pyramid from it (deep zoom goes coarse —
// fine, it has no local PCM anyway).
export interface StemView {
  length: number; // total samples (pyramid length)
  sampleRate: number;
  bucket: number; // sample bucket of the shipped level
  stems: Record<StemName, { min: string; max: string }>; // base64(Int8Array)
  // Optional COARSE per-stem band energy (low/mid/high, base64 int8) so a stem-less remote
  // (a phone — it has no PCM to band-split) gets the SAME rekordbox frequency colouring as the
  // host. Shipped at a low bucket count (~768) since colour changes slowly across a waveform;
  // the remote upsamples to the min/max resolution on rebuild. Optional → an older peer that
  // omits them still renders (flat per-stem colour, the prior behaviour). Adds ~12 KB/track,
  // well under the session/DO size budget. Rides INSIDE the opaque stemview `view` — no
  // protocol change.
  bands?: Record<StemName, { low: string; mid: string; high: string }>;
}

function quantizeI8(f: Float32Array): Int8Array {
  const out = new Int8Array(f.length);
  for (let i = 0; i < f.length; i++) {
    let v = Math.round(f[i] * 127);
    out[i] = v > 127 ? 127 : v < -127 ? -127 : v;
  }
  return out;
}
function i8ToB64(a: Int8Array): string {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u.length; i += CH) s += String.fromCharCode(...u.subarray(i, i + CH));
  return btoa(s);
}
function b64ToF32(b: string): Float32Array {
  const bin = atob(b);
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    const v = bin.charCodeAt(i); // 0..255
    out[i] = (v < 128 ? v : v - 256) / 127; // int8 → −1..1
  }
  return out;
}

// Average-pool a band envelope down to n buckets (host → wire). Colour changes slowly across
// a waveform, so a coarse band track upsamples back to full resolution with no visible loss.
function downsampleAvg(src: Float32Array, n: number): Float32Array {
  if (src.length <= n) return src;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * src.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * src.length) / n));
    let s = 0;
    for (let j = a; j < b; j++) s += src[j];
    out[i] = s / (b - a);
  }
  return out;
}
// Linearly stretch a coarse band envelope back up to n buckets (remote rebuild).
function upsampleTo(src: Float32Array, n: number): Float32Array {
  if (src.length === n) return src;
  const out = new Float32Array(n);
  if (src.length === 0 || n === 0) return out;
  if (src.length === 1) return out.fill(src[0]);
  for (let i = 0; i < n; i++) {
    const x = (i * (src.length - 1)) / (n - 1 || 1);
    const a = Math.floor(x);
    const b = Math.min(src.length - 1, a + 1);
    out[i] = src[a] + (src[b] - src[a]) * (x - a);
  }
  return out;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
// Unlocked (grid magnet off) loop-boundary nudge granularity, as a fraction of a
// beat — one arrow press / scroll tick moves a 1/16-beat for surgical trimming.
const ADJUST_FINE_BEATS = 1 / 16;

// Peak amplitude of an analyser's current time-domain frame, in dBFS.
function peakDb(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  an.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  return peak > 1e-5 ? 20 * Math.log10(peak) : -100;
}

export interface Loop {
  active: boolean;
  start: number;
  end: number;
  beats: number;
}

// Beat-sync role of a deck. "master" is the tempo reference; "slave" follows it.
// Directional: at most one master + one slave at a time (resolved by AudioEngine).
export type SyncRole = "off" | "master" | "slave";

export class Deck {
  readonly output: GainNode; // channel level fader (feeds the crossfader)
  private readonly trimNode: GainNode;
  private readonly eq: Eq3;
  // Post-fader stereo meter: split L/R into two analysers (sinks). The UI reads
  // instantaneous peak per channel and applies its own ballistics, so any number
  // of readers a frame is fine (no shared smoothed state to fight over).
  private readonly meterL: AnalyserNode;
  private readonly meterR: AnalyserNode;
  private readonly meterPre: AnalyserNode; // pre-EQ spectrum tap (raw track) for the EQ backdrop
  private readonly meterBuf: Float32Array<ArrayBuffer>; // scratch buffer for time-domain reads
  private readonly ctx: AudioContext;
  private _trim = 1;
  private _level = 1;
  private _eqLow = 0;
  private _eqMid = 0;
  private _eqHigh = 0;
  // Filter = two INDEPENDENT cut amounts (0 = off … 1 = full), so HP and LP can be on
  // together (band-pass). The legacy one-knob bipolar filter just drives one side and
  // zeroes the other; the Starrypad's two knobs drive each side on its own.
  private _hp = 0; // high-pass amount 0..1
  private _lp = 0; // low-pass amount 0..1
  private _fxOn = true; // FX master: when off the color filter is bypassed
  private _loudness: number | null = null; // cached integrated RMS of the track
  skipBeats = 4; // per-deck jog skip / beat-jump resolution (beats; 4 = one bar)

  buffer: AudioBuffer | null = null;
  beatgrid: Beatgrid | null = null;
  private running = false; // is the stretch engine voicing this deck (vs idle/scrub)
  // Optional 4-stem playback: when set, each stem gets its own live-toggleable gain
  // and the sum (all stems on) is the original mix. null = play the plain buffer.
  private stems: Stems | null = null;
  // Stem base envelopes captured during the mobile int16 pack (loadEnginePcm) and
  // consumed synchronously by setStems to build the pyramids + free the float32 stems.
  private pendingStemBase: Record<StemName, StemBaseLevel> | null = null;
  // "Stems are active" is tracked SEPARATELY from holding the raw `stems` AudioBuffers,
  // because on mobile we FREE those buffers once the engine owns the PCM and the
  // pyramids are built (the iPhone OOM fix — see buildStemPyramidsLazy). hasStems and
  // the stem mixer stay live off this flag + the worklet, not the (freed) buffers.
  private stemsLoaded = false;
  // Does the STRETCH ENGINE currently hold the 4 separate stems (vs a single mix)?
  // The per-stem gain path (rampStem) is gated on this so it no-ops on a mix-only
  // track — stem index 0 aliases the mix group, so posting would scale the whole mix.
  // Mobile DOES load stems (mixer works); the iPhone silent-playback bug was the
  // worklet's AudioParams, not memory — see stretchWorklet.
  private engineStems = false;
  private stemMuted: Record<StemName, boolean> = { vocals: false, drums: false, bass: false, other: false };
  private stemGain: Record<StemName, number> = { vocals: 1, drums: 1, bass: 1, other: 1 }; // per-stem level (knob)
  // Per-stem waveform envelopes for the viewport (null until built off the hot
  // path). `stemPyramidJob` supersedes an in-flight lazy build when stems change.
  stemPyramids: Record<StemName, Pyramid> | null = null;
  private stemPyramidJob = 0;
  onStemPyramids?: () => void; // viewport hook: async envelopes are ready → redraw
  onStemsReady?: () => void; // App hook: local neural pyramids built → publish to a session
  // True only when the CURRENT stems are a NEURAL split (Demucs/Open-Unmix). The viewport
  // shows a per-stem 4-lane waveform for neural stems and one collapsed waveform for DSP
  // stems (or none / mid-separation) — the DSP split is too rough to be worth 4 lanes.
  stemsNeural = false;

  private _playing = false;
  private startOffset = 0;
  private startedAt = 0;
  private _rate = 1;
  private _tempo = 0; // percent
  private _keylock = true; // keep pitch constant under tempo by default (modern DJ)
  private _pitchSemis = 0; // musical key shift, −12 … +12 semitones
  key: KeyInfo | null = null; // detected musical key (set after setBuffer)
  private stretchNode: AudioWorkletNode | null = null; // unified tempo+pitch engine (owns playback)
  lastDiag: Record<string, number> | null = null; // TEMP iPhone playback diagnostics (worklet heartbeat)
  get stretchAttached() { return this.stretchNode != null; } // TEMP diag: did the module load?
  private scratchNode: AudioWorkletNode | null = null; // continuous scrub resampler
  quantizeOn = false; // magnet: snap cues/loops/jumps to the beatgrid
  // Beat-sync role, OWNED by AudioEngine (the 2-deck relationship lives there) and
  // mirrored here so the UI can light the SYNC button. "slave" follows the master.
  syncRole: SyncRole = "off";
  onTempoChange?: () => void; // AudioEngine hook, fired at the end of setTempo
  keyRole: SyncRole = "off"; // harmonic (KEY) lock role — same gate as syncRole
  onPitchChange?: () => void; // AudioEngine hook, fired at the end of setPitch

  // --- jog/platter physics (see scrubBegin / jogTick) ---
  private static readonly MAX_COAST = 3; // cap on release speed (× realtime)
  private jogPhase: "off" | "grab" | "coast" = "off";
  private jogPos = 0; // platter position (track sec) — authoritative while jogging
  private jogVel = 0; // sounding velocity (track-sec / real-sec, signed)
  private handPos = 0; // where the finger says the platter is (accumulated)
  private handLast = 0; // handPos at the previous frame tick (for frame-rate fling velocity)
  private handVel = 0; // smoothed finger velocity, drives pitch + release fling
  private jogInputAt = 0; // ctx time of the last pointer sample (for per-input motion)
  private jogLast = 0; // ctx time of the last tick
  private jogRaf = 0; // requestAnimationFrame handle (0 = loop idle)
  private jogReturnToPlay = false; // release should spin back up to play, not rest
  private _jogWeight = 0.4; // 0 = featherweight/snappy … 1 = heavy flywheel
  private _jogDrag = 0.4; // 0 = frictionless glide … 1 = quick brake
  // --- pitch-bend (jog outer-ring / un-gripped turn / scroll while playing) ---
  // A momentary tempo push for beat-matching: `_bend` is a fractional offset folded
  // into the sounding rate (effRate = _rate·(1+_bend)). Each nudge adds to it and it
  // decays back to 0, so a faster turn piles up a bigger sustained push and letting go
  // eases home to the set tempo. NEVER a re-seek (that would glitch at the tick rate).
  private _bend = 0;
  private bendRaf = 0;
  private static readonly BEND_GAIN = 6; // ticks→push: how hard a turn bends the tempo
  private static readonly BEND_DECAY = 0.18; // s, ease-back-to-tempo time constant
  private static readonly BEND_MAX = 0.6; // cap the push at ±60% of the set tempo
  private static readonly BEND_SEARCH = 6; // paused: scale a bend nudge into a frame-search seek
  cuePoint = 0;
  hotCues: (number | null)[] = new Array(HOT_CUE_COUNT).fill(null);
  hotLoops: (Loop | null)[] = new Array(HOT_CUE_COUNT).fill(null); // saved loops per pad
  loop: Loop | null = null;
  loopInPoint: number | null = null; // pending manual loop-in (FLX4 style)
  // Loop-boundary fine-adjust: when set, waveform drag / scroll / arrow keys move
  // this boundary (the loop's start or end) instead of the playhead. Toggled by
  // Shift-IN / Shift-OUT. null = normal (playhead) interaction.
  adjusting: "in" | "out" | null = null;

  // --- follower visual clock (shared session) ---
  // A co-DJ mirrors the anchor's ~12 Hz playhead tick. Reading the LOCAL audio clock
  // for the WAVEFORM stutters: a muted passenger never starts a source and a backgrounded
  // / un-gestured mobile tab keeps the AudioContext SUSPENDED, so ctx.currentTime is
  // frozen and the head only jumps on each 80 ms tick ("sippy" / "the rate collapses").
  // So a follower draws from a CONTINUOUS wall-clock extrapolation of the anchor tick
  // instead — phase-locked to the master like the scrub stream. Visual ONLY: position()
  // stays the audio truth. The phase error is absorbed as a small velocity bias (never a
  // position jump), so re-anchoring on each tick is seamless — no per-tick step.
  private followOn = false;
  private followPos = 0; // extrapolation anchor (track sec) — set for continuity each tick
  private followAt = 0; // performance.now() (sec) when the anchor was set
  private followPlaying = false;
  private followBias = 0; // extra velocity (track-sec/sec) that eases the head onto the tick

  onEnded?: () => void;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.eq = new Eq3(ctx);
    // eq -> trim -> level(output) -> crossfader. The one-knob "filter" now drives the
    // EQ's own HP/LP cut nodes (see applyFilter) — there's no separate color-filter node.
    this.trimNode = ctx.createGain();
    this.output = ctx.createGain();
    this.eq.output.connect(this.trimNode);
    this.trimNode.connect(this.output);
    // Post-fader meter tap: a channel splitter feeding two analyser sinks (no
    // onward connection) so the meter reads exactly what feeds the crossfader,
    // per channel, without altering the audio path.
    const split = ctx.createChannelSplitter(2);
    this.meterL = ctx.createAnalyser();
    this.meterR = ctx.createAnalyser();
    this.meterL.fftSize = 1024;
    this.meterR.fftSize = 1024;
    this.meterBuf = new Float32Array(1024);
    this.output.connect(split);
    split.connect(this.meterL, 0);
    split.connect(this.meterR, 1);
    // Pre-EQ spectrum tap (raw track entering the channel) — a silent analyser sink
    // on the EQ input, for the curve's PRE/POST spectrum toggle.
    this.meterPre = ctx.createAnalyser();
    this.meterPre.fftSize = 1024;
    this.eq.input.connect(this.meterPre);
  }

  /** Instantaneous post-fader peak per channel in dBFS (−100 = silence … 0 = full
   *  scale). No smoothing — the UI applies its own meter ballistics, so it's safe
   *  to call from several meters a frame. */
  meterStereo(): { l: number; r: number } {
    return { l: peakDb(this.meterL, this.meterBuf), r: peakDb(this.meterR, this.meterBuf) };
  }

  get playing() {
    return this._playing;
  }
  get duration() {
    return this.buffer?.duration ?? 0;
  }
  get tempo() {
    return this._tempo;
  }
  get rate() {
    return this._rate;
  }
  get keylock() {
    return this._keylock;
  }

  /** Unified time-stretch engine (Phase 1: attached + wired to EQ but not yet
   *  driving playback — it outputs silence until Phase 2 routes the transport
   *  through it). Owns the playhead, looping, stems, and tempo+pitch. */
  attachStretchNode(node: AudioWorkletNode) {
    if (this.stretchNode) {
      try {
        this.stretchNode.disconnect();
      } catch {
        /* ignore */
      }
    }
    node.connect(this.eq.input);
    this.stretchNode = node;
    node.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string };
      if (m?.type === "diag") { this.lastDiag = e.data as Record<string, number>; return; }
      if (m?.type === "ended" && this.running) {
        this._playing = false;
        this.running = false;
        this.startOffset = this.buffer?.duration ?? 0;
        this.onEnded?.();
      }
    };
    // (Re)load the current PCM in case a track was set before the node attached, and
    // re-assert the current tempo/pitch (now port messages, so they must be re-sent).
    this.loadEnginePcm();
    this.stretchNode?.port.postMessage({ type: "speed", value: this._rate });
    this.updatePitch();
  }

  // Pack the current PCM (mix, or 4 time-aligned stems in STEM_NAMES order) into
  // fresh INT16 arrays and hand them to the stretch engine (transferred — the deck
  // keeps its own AudioBuffer for the waveform/analysis). int16 HALVES the audio-
  // thread footprint vs float32, which is what lets 4 stems × 2 decks fit on a phone
  // (the OOM that kept mobile mix-only). The worklet runs ONE WSOLA search over the
  // gain-weighted sum and overlap-adds all groups, so there's no per-stem stretch
  // duplication — the stems are resident once. The engine owns playback from here;
  // this is the only place it gets audio.
  private loadEnginePcm() {
    const node = this.stretchNode;
    const buf = this.buffer;
    if (!node || !buf) return;
    // Mobile packs INT16 (halves the audio-thread footprint so 4 stems × 2 decks fit a
    // phone). Desktop keeps raw FLOAT32 — RAM is plentiful and a `.slice` memcpy is far
    // cheaper than a per-sample pack loop on the load path (the pack froze the main
    // thread ~0.2 s per stem swap; the seamless re-seat below tolerates it, but desktop
    // shouldn't pay it at all).
    const packInt16 = isMobileDevice();
    const useStems = !!this.stems;
    // On mobile + stems, FUSE the base waveform envelope (min/max + low/mid/high bands)
    // into the SAME pass that packs int16. That lets setStems free the raw ~460 MB
    // float32 stems the instant the handoff completes, instead of holding them across
    // the async pyramid build — the lingering that caused the two-deck ~1.15 GB iOS peak
    // (it collapses to the single-deck ~800 MB). Desktop keeps the buffers + async build.
    const wantBase = packInt16 && useStems;
    this.pendingStemBase = wantBase ? ({} as Record<StemName, StemBaseLevel>) : null;
    const gL: (Int16Array | Float32Array)[] = [];
    const gR: (Int16Array | Float32Array)[] = [];
    const transfer: ArrayBuffer[] = [];
    const pushGroup = (b: AudioBuffer, name?: StemName) => {
      const n = b.length;
      const fL = b.getChannelData(0);
      const fR = b.numberOfChannels > 1 ? b.getChannelData(1) : fL;
      let L: Int16Array | Float32Array;
      let R: Int16Array | Float32Array;
      if (packInt16 && wantBase && name) {
        // Fused: pack int16 AND accumulate the base min/max + band envelope in one
        // traversal of the float32 (matches buildStemPyramidsLazy's math exactly).
        const li = new Int16Array(n);
        const ri = new Int16Array(n);
        const sr = b.sampleRate;
        const cnt = Math.max(1, Math.ceil(n / STEM_BASE_BUCKET));
        const min = new Float32Array(cnt);
        const max = new Float32Array(cnt);
        const low = new Float32Array(cnt);
        const mid = new Float32Array(cnt);
        const high = new Float32Array(cnt);
        const aLow = 1 - Math.exp((-2 * Math.PI * 200) / sr);
        const aMid = 1 - Math.exp((-2 * Math.PI * 2000) / sr);
        let lp200 = 0, lp2000 = 0, lSum = 0, mSum = 0, hSum = 0;
        let maxLow = 1e-9, maxMid = 1e-9, maxHigh = 1e-9, bMin = 1, bMax = -1, c = 0, bi = 0;
        for (let i = 0; i < n; i++) {
          const fl = fL[i], fr = fR[i];
          const sl = fl * 32767, srr = fr * 32767;
          li[i] = sl < -32767 ? -32767 : sl > 32767 ? 32767 : Math.round(sl);
          ri[i] = srr < -32767 ? -32767 : srr > 32767 ? 32767 : Math.round(srr);
          const s = (fl + fr) * 0.5;
          lp200 += aLow * (s - lp200);
          lp2000 += aMid * (s - lp2000);
          const lo = lp200, md = lp2000 - lp200, hi = s - lp2000;
          if (s < bMin) bMin = s;
          if (s > bMax) bMax = s;
          lSum += lo * lo; mSum += md * md; hSum += hi * hi;
          if (++c >= STEM_BASE_BUCKET || i === n - 1) {
            const lv = Math.sqrt(lSum / c), mv = Math.sqrt(mSum / c), hv = Math.sqrt(hSum / c);
            min[bi] = bMin; max[bi] = bMax; low[bi] = lv; mid[bi] = mv; high[bi] = hv;
            if (lv > maxLow) maxLow = lv;
            if (mv > maxMid) maxMid = mv;
            if (hv > maxHigh) maxHigh = hv;
            bi++; bMin = 1; bMax = -1; lSum = mSum = hSum = 0; c = 0;
          }
        }
        for (let i = 0; i < cnt; i++) { low[i] /= maxLow; mid[i] /= maxMid; high[i] /= maxHigh; }
        this.pendingStemBase![name] = { min, max, low, mid, high, length: n, sampleRate: sr, bucket: STEM_BASE_BUCKET };
        L = li;
        R = ri;
      } else if (packInt16) {
        const li = new Int16Array(n);
        const ri = new Int16Array(n);
        for (let i = 0; i < n; i++) {
          // round-to-nearest, full-scale ±32767 (symmetric, unity gain); clamp the rare
          // inter-sample / source overshoot beyond ±1.0.
          const sl = fL[i] * 32767;
          const sr = fR[i] * 32767;
          li[i] = sl < -32767 ? -32767 : sl > 32767 ? 32767 : Math.round(sl);
          ri[i] = sr < -32767 ? -32767 : sr > 32767 ? 32767 : Math.round(sr);
        }
        L = li;
        R = ri;
      } else {
        L = fL.slice();
        R = fR.slice();
      }
      gL.push(L);
      gR.push(R);
      transfer.push(L.buffer as ArrayBuffer, R.buffer as ArrayBuffer);
    };
    // Stems → 4 engine groups (drives the per-stem mixer); else the single mix.
    // Mobile loads stems too — the iPhone silent-playback bug was the worklet's
    // AudioParams, not memory, so there's no reason to starve the phone of the mixer.
    if (useStems) for (const name of STEM_NAMES) pushGroup(this.stems![name], name);
    else pushGroup(buf);
    this.engineStems = useStems;
    node.port.postMessage({ type: "loadPcm", gL, gR, length: buf.length, int16: packInt16 }, transfer);
  }

  /** Push WSOLA engine config (grain/search/stride + transient/AA toggles) to the worklet. */
  configureStretch(cfg: StretchEngineConfig) {
    this.stretchNode?.port.postMessage({ type: "config", ...cfg });
  }

  setKeylock(on: boolean) {
    this._keylock = on;
    this.updatePitch();
  }

  /** Wire the scratch resampler in parallel with the source, into the EQ (raw
   *  pitch, bypassing key-lock — scrubbing should pitch like vinyl). */
  attachScratchNode(node: AudioWorkletNode) {
    node.connect(this.eq.input);
    this.scratchNode = node;
    if (this.buffer) this.sendScratchBuffer();
  }

  // Hand the whole decoded track to the resampler (its own copies, so the
  // AudioBuffer's backing store isn't detached by the transfer).
  private sendScratchBuffer() {
    if (!this.scratchNode || !this.buffer) return;
    const b = this.buffer;
    const channels: Float32Array[] = [];
    const transfer: ArrayBuffer[] = [];
    for (let c = 0; c < b.numberOfChannels; c++) {
      const copy = b.getChannelData(c).slice();
      channels.push(copy);
      transfer.push(copy.buffer);
    }
    this.scratchNode.port.postMessage({ type: "load", channels, length: b.length }, transfer);
  }
  private scratchStart() {
    this.scratchNode?.port.postMessage({ type: "start", pos: this.jogPos * this.ctx.sampleRate });
  }
  private scratchMove() {
    // Position only — the worklet reconstructs smooth motion from the position
    // stream itself; feeding it our noisy per-frame velocity made it garbled.
    this.scratchNode?.port.postMessage({ type: "move", pos: this.jogPos * this.ctx.sampleRate });
  }
  private scratchStop() {
    this.scratchNode?.port.postMessage({ type: "stop" });
  }

  // De-tangled pitch: the stretch engine takes a `pitch` factor INDEPENDENT of
  // tempo (the engine handles time-stretch separately), so there is no 1/rate
  // correction. key-lock ON → pitch = the musical key shift only; key-lock OFF →
  // pitch also rides the tempo rate (vinyl: faster = higher).
  private updatePitch() {
    const shift = Math.pow(2, this._pitchSemis / 12);
    const pitch = this._keylock ? shift : this.effRate() * shift;
    // Port message, not an AudioParam — the worklet de-zippers it (see stretchWorklet).
    this.stretchNode?.port.postMessage({ type: "pitch", value: pitch });
  }

  /** Musical key shift in semitones (−24 … +24, up to ±2 octaves). Engages key-lock
   *  so the shift is pitch-only (tempo-independent). */
  get pitch() {
    return this._pitchSemis;
  }
  setPitch(semis: number) {
    this._pitchSemis = Math.max(-24, Math.min(24, Math.round(semis))); // up to ±2 octaves (PITCH_RANGES)
    if (this._pitchSemis !== 0) this._keylock = true;
    this.updatePitch();
    this.onPitchChange?.(); // AudioEngine KEY hook: master→slave follow / release
  }
  /** The track's key after the current pitch shift (null if un-analysed). */
  get effectiveKey(): KeyInfo | null {
    return this.key ? shiftKey(this.key, this._pitchSemis) : null;
  }
  /** BPM after the tempo fader is applied. */
  get effectiveBpm(): number | null {
    return this.beatgrid ? this.beatgrid.bpm * this._rate : null;
  }

  async loadArrayBuffer(data: ArrayBuffer) {
    this.setBuffer(await decodeAudio(this.ctx, data));
  }

  setBuffer(buffer: AudioBuffer, beatgrid: Beatgrid | null = null) {
    this.stopSource();
    this._playing = false;
    this.startOffset = 0;
    this.cuePoint = 0;
    this.hotCues = new Array(HOT_CUE_COUNT).fill(null);
    this.hotLoops = new Array(HOT_CUE_COUNT).fill(null);
    this.loop = null;
    this.loopInPoint = null;
    this.stopJog();
    this.stems = null; // new track: drop stems until re-derived, reset mutes to all-on
    this.stemsLoaded = false;
    this.stemMuted = { vocals: false, drums: false, bass: false, other: false };
    this.stemGain = { vocals: 1, drums: 1, bass: 1, other: 1 };
    this.stemPyramids = null;
    this.buffer = buffer;
    this.beatgrid = beatgrid;
    this.key = null; // re-set by the caller from the track analysis
    this._pitchSemis = 0;
    this.updatePitch();
    this._loudness = null; // recompute lazily for the new track
    this.loadEnginePcm(); // hand the mix PCM to the stretch engine
    for (const name of STEM_NAMES) this.rampStem(name); // reset engine stem gains to all-on
    this.sendScratchBuffer();
  }

  // --- stems -----------------------------------------------------------------
  // A track can carry 4 time-aligned stem buffers (vocals/drums/bass/other) that
  // share the deck's clock, loop and tempo. With stems set, playback sums their
  // per-stem gains so any can be muted live; with all on the sum IS the mix.
  get hasStems(): boolean {
    return this.stemsLoaded;
  }
  /** Should the per-stem mixer cells render? For LOCAL stems (desktop split/neural/DSP)
   *  → yes the moment they're loaded. For a REMOTE-display deck (a mobile guest mirroring
   *  a host) → only once the host's 4-lane envelopes have actually arrived (stemPyramids),
   *  so the cells never sit above a single combined waveform when the host hasn't — or
   *  can't — stream them. That mismatch (controls with no stems behind them) reads as a bug. */
  get stemControlsReady(): boolean {
    return this.stemsLoaded && (!this.remoteStems || this.stemPyramids != null);
  }
  // True when stems are present only as REMOTE display/control (no local buffers) —
  // this device is a controller for a host that has stems. Lets the UI/deep-zoom know
  // there's no local PCM to read (stemChannel returns null → LOD/envelope only).
  remoteStems = false;
  /** Mark that stems EXIST for this deck WITHOUT holding their buffers — for a device
   *  acting as a remote controller of a host that has stems. The mixer cells light up
   *  and reflect/drive the host's per-stem state over the session; local audio stays
   *  the plain mix (engineStems stays false, so rampStem no-ops). The 4-lane waveform
   *  fills in when the host's stem envelopes arrive (setRemoteStemView, phase 2). */
  markRemoteStems(present: boolean, neural = true) {
    this.remoteStems = present;
    this.stemsLoaded = present;
    this.stemsNeural = present && neural;
    if (!present) this.stemPyramids = null;
  }
  /** HOST: snapshot this deck's stem waveform envelopes for transmission to remotes.
   *  null until the neural pyramids are built. Coarse level → small payload. */
  extractStemView(): StemView | null {
    // A remote-display deck holds the HOST's envelopes (rebuilt via setRemoteStemView),
    // not its own — it must never re-publish them, or a granted/clock remote would
    // overwrite the host's real stem view with a coarser re-derivation (feedback).
    if (this.remoteStems) return null;
    const py = this.stemPyramids;
    // Stream whenever REAL local stem pyramids exist — neural OR DSP. (Previously
    // neural-only, which stranded a DSP-stem host: it advertised hasStems in the snapshot
    // — so a mobile guest lit up the stem cells — yet extractStemView refused to serialise
    // the view, so the guest's 4-lane waveform never arrived. Controls over a single
    // combined waveform, permanently. DSP pyramids carry band energy too, so they colour fine.)
    if (!py) return null;
    const stems = {} as Record<StemName, { min: string; max: string }>;
    const bands = {} as Record<StemName, { low: string; mid: string; high: string }>;
    const BAND_BUCKETS = 768; // coarse band resolution shipped over the wire
    let bucket = 256;
    let length = 0;
    let sampleRate = this.ctx.sampleRate;
    for (const name of STEM_NAMES) {
      const p = py[name];
      if (!p || !p.levels.length) return null;
      length = p.length;
      sampleRate = p.sampleRate;
      // Pick a level coarse enough to cap the BUCKET COUNT (~3000 max), so a long track's
      // envelope stays small: ≥2048-sample buckets for resolution, but coarser still when
      // the track is long enough that 2048 would blow past 3000 buckets. Keeps the 4-deck
      // payload well under the session/DO limits (a long track previously made it huge).
      const minBucket = Math.max(2048, Math.ceil(p.length / 3000));
      const lvl = p.levels.find((l) => l.bucket >= minBucket) ?? p.levels[p.levels.length - 1];
      bucket = lvl.bucket;
      stems[name] = { min: i8ToB64(quantizeI8(lvl.min)), max: i8ToB64(quantizeI8(lvl.max)) };
      // Coarse band energy (0..1) → int8 → base64, downsampled to ≤768 buckets.
      const bb = Math.min(BAND_BUCKETS, lvl.min.length);
      bands[name] = {
        low: i8ToB64(quantizeI8(downsampleAvg(lvl.low, bb))),
        mid: i8ToB64(quantizeI8(downsampleAvg(lvl.mid, bb))),
        high: i8ToB64(quantizeI8(downsampleAvg(lvl.high, bb))),
      };
    }
    return { length, sampleRate, bucket, stems, bands };
  }
  /** REMOTE: rebuild the 4-lane stem display from a host's transmitted envelopes.
   *  No local PCM — marks remote stems present so the mixer cells light up too. */
  setRemoteStemView(view: StemView): void {
    if (!view?.stems) return;
    const out = {} as Record<StemName, Pyramid>;
    for (const name of STEM_NAMES) {
      const s = view.stems[name];
      if (!s) return;
      const min = b64ToF32(s.min);
      const max = b64ToF32(s.max);
      // Band energy when the host shipped it (newer peers) → upsampled to the min/max
      // resolution → real rekordbox stem colouring. Omitted → zeroed → flat colour (old peers).
      const b = view.bands?.[name];
      const low = b ? upsampleTo(b64ToF32(b.low), min.length) : undefined;
      const mid = b ? upsampleTo(b64ToF32(b.mid), min.length) : undefined;
      const high = b ? upsampleTo(b64ToF32(b.high), min.length) : undefined;
      out[name] = buildLodPyramid(min, max, view.length, view.sampleRate, view.bucket, low, mid, high);
    }
    this.markRemoteStems(true, true);
    this.stemPyramids = out; // markRemoteStems cleared it; set the real envelopes
    this.onStemPyramids?.();
  }
  stemActive(name: StemName): boolean {
    return !this.stemMuted[name];
  }
  /** Raw PCM (channel 0) of a stem — for the deep-zoom oscilloscope, which reads the
   *  real signal instead of the 256-sample LOD. The buffers are already resident (the
   *  deck plays them), so this is zero-copy. null when the track has no stems. */
  stemChannel(name: StemName): Float32Array | null {
    return this.stems ? this.stems[name].getChannelData(0) : null;
  }
  /** The knob level for a stem (0..1.5; 1 = unity). */
  stemLevel(name: StemName): number {
    return this.stemGain[name];
  }
  /** Actual gain applied = level, or 0 when muted. */
  private effectiveStemGain(name: StemName): number {
    return this.stemMuted[name] ? 0 : this.stemGain[name];
  }
  // Push a stem's live gain to the engine. The grain overlap-add (~one grain ≈
  // 20 ms) cross-fades the change, so mutes/level moves stay click-free.
  private rampStem(name: StemName) {
    // Mix-only engine (mobile): there are no stem groups to address — and stem index
    // 0 aliases the mix group, so posting would scale the whole mix. Leave it alone.
    if (!this.engineStems) return;
    this.stretchNode?.port.postMessage({
      type: "stemGain",
      index: STEM_NAMES.indexOf(name),
      value: this.effectiveStemGain(name),
    });
  }
  /** Set a stem's level (the mixer knob). Independent of the mute button. */
  setStemGain(name: StemName, level: number) {
    this.stemGain[name] = Math.max(0, Math.min(1.5, level));
    this.rampStem(name);
  }
  /** Attach (or clear with null) the stem buffers. Swaps a live source group over
   *  seamlessly — all-on sums to the same mix, so there's no audible jump. Also
   *  builds the per-stem waveform envelopes so the viewport can render them. */
  setStems(stems: Stems | null, neural = false) {
    this.stems = stems;
    this.stemsLoaded = !!stems;
    this.stemsNeural = !!stems && neural;
    // Real local stems (desktop neural OR the on-device DSP baseline) are authoritative —
    // this device plays them, so it's no longer just mirroring a host's remote stem view.
    // Clearing this lets local stems win over a session's streamed envelopes (display + audio
    // stay consistent) and lets the device advertise its own stems again.
    if (stems) this.remoteStems = false;
    // Audio swaps in instantly (all-on === the mix, so it's seamless). The
    // per-stem waveform envelopes are SECOND-CLASS: built lazily off the hot path.
    // KEEP the old envelopes on screen while the new ones build, so upgrading
    // DSP→neural shows the (DSP) quad continuously instead of flashing back to the
    // single mix waveform. Only clear when stems are removed (setBuffer handles a
    // fresh track).
    if (!stems) this.stemPyramids = null;
    const job = ++this.stemPyramidJob;
    // Hand the new PCM (mix or 4 stems) to the engine; resume in place if playing.
    // Sample the playhead AFTER loadEnginePcm, not before: int16-packing 4 stems is a
    // non-trivial main-thread loop, during which the engine keeps playing the old PCM
    // and advances ~0.2 s. Capturing pos beforehand re-seated at that stale point →
    // the engine REPLAYED the gap (the "repeats a few times then plays" stutter on
    // every stem swap). all-on === the mix, so re-seating at the live position is
    // seamless.
    this.loadEnginePcm();
    for (const name of STEM_NAMES) this.rampStem(name); // re-assert current stem gains
    if (this._playing) this.spawnSource(this.position());
    if (this.pendingStemBase) {
      // Mobile: loadEnginePcm already computed the base envelopes in its pack pass.
      // Build the (cheap, downsampled) LOD ladders from them, publish, and FREE the raw
      // float32 stems NOW — synchronously, before control returns — so a serialized
      // second-deck derive can't overlap this deck's ~460 MB (collapses the iOS peak).
      const base = this.pendingStemBase;
      this.pendingStemBase = null;
      const out = {} as Record<StemName, Pyramid>;
      for (const name of STEM_NAMES) {
        const bse = base[name];
        out[name] = buildLodPyramid(bse.min, bse.max, bse.length, bse.sampleRate, bse.bucket, bse.low, bse.mid, bse.high);
      }
      this.stemPyramids = out;
      this.stems = null; // engine has the int16 PCM, pyramids have the visuals — drop the float32
      this.onStemPyramids?.();
      this.onStemsReady?.();
    } else if (stems) {
      void this.buildStemPyramidsLazy(stems, job); // desktop: async build, keep the buffers
    }
  }
  // Time-sliced min/max envelope build (yields ~every 1M samples) — never blocks,
  // and a newer setStems supersedes an in-flight build via the job token.
  private async buildStemPyramidsLazy(stems: Stems, job: number): Promise<void> {
    const idle: () => Promise<void> = () =>
      new Promise((r) =>
        typeof requestIdleCallback !== "undefined" ? requestIdleCallback(() => r()) : setTimeout(r, 0),
      );
    const BUCKET = 256;
    const out = {} as Record<StemName, Pyramid>;
    for (const name of STEM_NAMES) {
      const b = stems[name];
      const ch0 = b.getChannelData(0);
      const ch1 = b.numberOfChannels > 1 ? b.getChannelData(1) : null;
      const n = ch0.length;
      const count = Math.max(1, Math.ceil(n / BUCKET));
      const min = new Float32Array(count);
      const max = new Float32Array(count);
      // Per-bucket low/mid/high band energy so each stem lane gets its OWN frequency
      // colouring (cheap: two one-pole LPFs per sample, same split as the mix pyramid).
      const low = new Float32Array(count);
      const mid = new Float32Array(count);
      const high = new Float32Array(count);
      const aLow = 1 - Math.exp((-2 * Math.PI * 200) / b.sampleRate);
      const aMid = 1 - Math.exp((-2 * Math.PI * 2000) / b.sampleRate);
      let lp200 = 0;
      let lp2000 = 0;
      let lSum = 0;
      let mSum = 0;
      let hSum = 0;
      let maxLow = 1e-9;
      let maxMid = 1e-9;
      let maxHigh = 1e-9;
      let bMin = 1;
      let bMax = -1;
      let cnt = 0;
      let bi = 0;
      for (let i = 0; i < n; i++) {
        const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
        lp200 += aLow * (s - lp200);
        lp2000 += aMid * (s - lp2000);
        const lo = lp200;
        const md = lp2000 - lp200;
        const hi = s - lp2000;
        if (s < bMin) bMin = s;
        if (s > bMax) bMax = s;
        lSum += lo * lo;
        mSum += md * md;
        hSum += hi * hi;
        if (++cnt >= BUCKET || i === n - 1) {
          const lv = Math.sqrt(lSum / cnt);
          const mv = Math.sqrt(mSum / cnt);
          const hv = Math.sqrt(hSum / cnt);
          min[bi] = bMin;
          max[bi] = bMax;
          low[bi] = lv;
          mid[bi] = mv;
          high[bi] = hv;
          if (lv > maxLow) maxLow = lv;
          if (mv > maxMid) maxMid = mv;
          if (hv > maxHigh) maxHigh = hv;
          bi++;
          bMin = 1;
          bMax = -1;
          lSum = mSum = hSum = 0;
          cnt = 0;
        }
        if ((i & 0xfffff) === 0xfffff) {
          await idle();
          if (job !== this.stemPyramidJob) return; // superseded by a newer track/stems
        }
      }
      for (let i = 0; i < count; i++) {
        low[i] /= maxLow;
        mid[i] /= maxMid;
        high[i] /= maxHigh;
      }
      out[name] = buildLodPyramid(min, max, n, b.sampleRate, BUCKET, low, mid, high);
      await idle();
      if (job !== this.stemPyramidJob) return;
    }
    if (job === this.stemPyramidJob) {
      this.stemPyramids = out;
      this.onStemPyramids?.(); // nudge the viewport to re-rasterise the quad lanes
      this.onStemsReady?.(); // host: publish the envelopes to any shared session

      // iPhone OOM FIX. The stretch engine already holds its OWN copy of the 4 stem
      // PCM channels (transferred in loadEnginePcm) and the pyramids now own the
      // visuals — so the deck's raw `stems` AudioBuffers (~424 MB for a 5-min track)
      // are pure redundant memory. On MOBILE, where two stem'd decks otherwise hold
      // ~2× and jetsam-kill the tab (→ crash loop), release them now. hasStems and
      // the stem mixer keep working off `stemsLoaded` + the worklet; only the
      // deep-zoom true-signal stem render (stemChannel) falls back to LOD, which is
      // an acceptable trade on a phone. Desktop keeps the buffers (headroom + sharper
      // zoom + safe against a stretch-node reattach).
      if (isMobileDevice()) this.stems = null;
    }
  }
  setStemMute(name: StemName, muted: boolean) {
    this.stemMuted[name] = muted;
    this.rampStem(name);
  }
  toggleStem(name: StemName) {
    this.setStemMute(name, !this.stemMuted[name]);
  }

  /** Solo a stem: mute every other stem (so only this one plays). If it's already
   *  the sole one playing, restore them all — so the same tap toggles solo on/off. */
  soloStem(name: StemName) {
    if (!this.hasStems) return;
    const isSolo = this.stemActive(name) && STEM_NAMES.every((n) => n === name || !this.stemActive(n));
    for (const n of STEM_NAMES) this.setStemMute(n, isSolo ? false : n !== name);
  }
  /** Reset every stem to its default: level back to unity (1) and un-muted. */
  resetStems() {
    for (const name of STEM_NAMES) {
      this.stemGain[name] = 1;
      this.stemMuted[name] = false;
      this.rampStem(name);
    }
  }

  /** Sounding playback rate = the set tempo, momentarily scaled by an active bend.
   *  Everything that advances the playhead reads THIS, not the raw tempo, so a bend
   *  speeds/slows the audio + clock together and stays drift-free. */
  private effRate(): number {
    return this._rate * (1 + this._bend);
  }

  /** Current playhead position in seconds (wraps inside an active loop). */
  position(): number {
    if (!this.buffer) return 0;
    let pos = this._playing
      ? this.startOffset + (this.ctx.currentTime - this.startedAt) * this.effRate()
      : this.startOffset;
    if (this._playing && this.loop?.active) {
      const len = this.loop.end - this.loop.start;
      if (len > 0 && pos > this.loop.start) pos = this.loop.start + ((pos - this.loop.start) % len);
    }
    return Math.max(0, Math.min(this.buffer.duration, pos));
  }

  // --- follower visual clock ---
  private static nowSec(): number {
    return (typeof performance !== "undefined" ? performance.now() : 0) / 1000;
  }
  // Track-sec the follow clock has reached right now (anchor + elapsed·velocity).
  private followExtrapolate(now: number): number {
    const dt = Math.min(Math.max(0, now - this.followAt), 0.5); // cap a stalled tick
    return this.followPos + dt * ((this._rate > 0 ? this._rate : 1) + this.followBias);
  }
  /** Feed the anchor's playhead tick (a co-DJ following the session). Re-anchors the
   *  clock to where it ALREADY is (continuity — no step) and folds the phase error into
   *  a gentle velocity bias that eases onto the tick over ~0.4 s; a real jump (seek /
   *  loop / big desync) or a play-state change snaps hard. */
  followTick(pos: number, playing: boolean): void {
    const now = Deck.nowSec();
    if (this.followOn && this.followPlaying && playing) {
      const predicted = this.followExtrapolate(now);
      const err = pos - predicted;
      if (Math.abs(err) > 0.35) {
        this.followPos = pos; // real jump → snap
        this.followBias = 0;
      } else {
        this.followPos = predicted; // continuity: start the next segment where we are
        this.followBias = Math.max(-0.5, Math.min(0.5, err / 0.4)); // absorb phase via velocity
      }
    } else {
      this.followPos = pos; // first tick / play-state flip → hard anchor
      this.followBias = 0;
    }
    this.followPlaying = playing;
    this.followAt = now;
    this.followOn = true;
  }
  /** Stop following — the local clock drives the drawn playhead again. */
  endFollow(): void {
    this.followOn = false;
    this.followBias = 0;
  }
  /** Playhead for DRAWING. A follower draws the smooth, phase-locked extrapolation of
   *  the anchor tick (so the head glides at the display rate even when the local audio
   *  clock is frozen/suspended); everyone else draws their real local clock. */
  visualPosition(): number {
    if (!this.followOn || this.jogging || !this.buffer) return this.position();
    // When our OWN audio clock is live (context running), it's the smoothest, most
    // accurate playhead AND it's exactly what we hear — draw it. The tick-extrapolated
    // clock is only a fallback for a SUSPENDED context (a mobile passenger), where
    // position() would freeze between ticks; on desktop it just added per-tick jitter.
    if (this.ctx.state === "running") return this.position();
    let pos = this.followPlaying ? this.followExtrapolate(Deck.nowSec()) : this.followPos;
    if (this.followPlaying && this.loop?.active) {
      const len = this.loop.end - this.loop.start;
      if (len > 0 && pos > this.loop.start) pos = this.loop.start + ((pos - this.loop.start) % len);
    }
    return Math.max(0, Math.min(this.buffer.duration, pos));
  }
  /** Is the DRAWN playhead advancing? (drives the viewport's rAF.) */
  get visualPlaying(): boolean {
    if (!this.followOn || this.jogging || this.ctx.state === "running") return this._playing;
    return this.followPlaying;
  }

  play() {
    this.cancelJog(); // a transport action wins over an in-flight platter coast
    this.clearBend();
    if (!this.buffer || this._playing) return;
    // iOS boots the AudioContext SUSPENDED (clock frozen) until a gesture resumes
    // it. Scrub/needle-drop already do this, but tapping Play first does not — so a
    // fresh load + Play (no prior scrub) rendered silence. Resume on the Play gesture.
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.spawnSource(this.startOffset);
    this._playing = true;
  }
  pause() {
    this.cancelJog();
    this.clearBend();
    if (!this._playing) return;
    this.startOffset = this.position();
    this.stopSource();
    this._playing = false;
  }
  togglePlay() {
    this._playing ? this.pause() : this.play();
  }

  seek(seconds: number) {
    this.cancelJog();
    this.clearBend();
    const target = Math.max(0, Math.min(this.duration, seconds));
    if (this._playing) {
      // Declicked gapless re-seat. The old stopSource()+spawnSource() pair coalesced in
      // the worklet before any audio rendered, so the 5 ms fade never happened → a hard
      // click at the discontinuity on every cue/loop jump (worse on rapid fire). One
      // 'seek' message fades across the jump instead.
      this.spawnSource(target, true);
    } else {
      this.startOffset = target;
    }
  }

  // --- scrubbing (jog-wheel / vinyl feel) ---
  //
  // The waveform drag is modelled as a weighted platter. While the finger is down
  // ("grab") a critically-damped spring pulls the platter toward the finger — a
  // heavier platter trails it (drag you can feel + hear). On release ("coast") the
  // platter keeps its spin and either glides to rest under friction (was paused)
  // or eases back up to play speed like a motor catching it (was playing). One
  // audio grain per animation frame voices the slice the platter sweeps, so the
  // pitch tracks the real platter speed and there's no grain pile-up.

  /** Tune the platter feel. Both 0..1. weight = inertia, drag = coast friction. */
  setJogPhysics(weight: number, drag: number) {
    this._jogWeight = Math.max(0, Math.min(1, weight));
    this._jogDrag = Math.max(0, Math.min(1, drag));
  }

  get scrubbing() {
    return this.jogPhase !== "off";
  }
  /** True while the platter is being dragged OR still coasting after release. */
  get jogging() {
    return this.jogPhase !== "off";
  }

  scrubBegin() {
    if (!this.buffer) return;
    // iOS starts the AudioContext suspended (its clock frozen) until a gesture
    // resumes it. The jog physics tick off ctx.currentTime, so without this a
    // scrub before the first Play sees dt≈0 every frame and the platter never
    // moves. Resuming on the grab gesture unlocks it.
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.clearBend(); // a grab takes over the clock — drop any decaying bend first
    // Gripping the platter stops it dead (like a hand on vinyl) — it then follows
    // the finger from rest, so there's no forward lurch/creep when you take hold.
    this.jogReturnToPlay = this._playing || (this.jogPhase === "coast" && this.jogReturnToPlay);
    this.jogPos = this.position();
    if (this._playing) {
      this.startOffset = this.jogPos;
      this.stopSource();
      this._playing = false;
    }
    this.handPos = this.handLast = this.jogPos;
    this.jogVel = 0;
    this.handVel = 0;
    this.jogInputAt = this.ctx.currentTime;
    this.jogLast = this.ctx.currentTime;
    this.jogPhase = "grab";
    this.scratchStart();
    this.startJogLoop();
  }

  /** One (coalesced) pointer sample of finger motion, in track seconds. Applied
   *  straight to the platter and voiced on the worklet immediately — so scratch
   *  resolution tracks the mouse's true report rate (125–1000 Hz), not the display
   *  refresh. Position only: the release-fling VELOCITY is derived at frame rate in
   *  grabTick() (the AudioContext clock doesn't advance within a frame, so it can't
   *  time individual samples — but the worklet gets full-rate position regardless). */
  scrubMove(deltaSec: number) {
    if (this.jogPhase !== "grab") return;
    this.jogInputAt = this.ctx.currentTime;
    let p = this.handPos + deltaSec;
    const dur = this.buffer ? this.buffer.duration : 0;
    if (p < 0) p = 0;
    else if (p > dur) p = dur;
    this.handPos = this.jogPos = p;
    this.startOffset = p;
    this.scratchMove(); // per-input-sample worklet push
  }

  scrubEnd() {
    if (this.jogPhase !== "grab") return;
    // Motion was applied per input sample in scrubMove(); just hand the platter its
    // release spin — the finger's last smoothed velocity, capped so a violent flick
    // can't launch it across the whole track.
    const max = Deck.MAX_COAST;
    this.jogVel = Math.max(-max, Math.min(max, this.handVel));
    this.jogLast = this.ctx.currentTime;
    this.jogPhase = "coast";
    this.startJogLoop();
  }

  // A tap/click on the waveform: an instant seek with no grab, scrub or momentum.
  // (The viewport only grabs the platter once the finger actually moves, so a tap
  // never enters the jog at all — this just jumps from the current playhead.)
  needleDrop(deltaSec: number) {
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.seek(this.position() + deltaSec);
  }

  // --- pitch-bend (the jog's outer ring, an un-gripped turn, or scroll while playing) ---
  //
  // A momentary tempo push for beat-matching. The platter ISN'T gripped, so we don't
  // scratch or stop — we nudge the sounding rate and let it ease back to the set tempo,
  // exactly like leaning on a spinning record. Driven by relative ticks: turn faster
  // and the pushes pile up into a bigger sustained bend; stop and it decays home. While
  // PAUSED there's nothing to bend, so the same gesture frame-searches through the track
  // (how you fine-tune a cue point) instead of doing nothing.

  /** One relative bend nudge. `deltaSec` = how far the platter rolled (sign = direction).
   *  Playing → bends the tempo and auto-reverts; paused → needle-searches. */
  bend(deltaSec: number) {
    if (this.jogPhase !== "off") return; // a gripped / coasting platter owns the motion
    if (this.ctx.state === "suspended") void this.ctx.resume();
    if (!this._playing) {
      this.needleDrop(deltaSec * Deck.BEND_SEARCH);
      return;
    }
    // Convert the roll distance into a push relative to the set tempo (so it feels the
    // same at any pitch-fader setting), accumulate, and clamp.
    const push = (deltaSec / Math.max(0.05, this._rate)) * Deck.BEND_GAIN;
    this.reanchorClock(); // freeze position() at the OLD rate before the rate changes
    this._bend = Math.max(-Deck.BEND_MAX, Math.min(Deck.BEND_MAX, this._bend + push));
    this.pushRate();
    this.startBendDecay();
  }

  // Freeze position() at its CURRENT value and restart the linear clock from there.
  // Used before a rate change (so the new rate continues seamlessly) AND before a
  // loop-bounds change: position() folds a monotonic accumulator (startOffset +
  // elapsed·rate) through `(pos - loopStart) % loopLen`; if loopStart/loopLen change
  // while that accumulator is large, the modulo lands on a phase unrelated to where
  // the audio actually is (the worklet keeps idealPos as a real in-loop value), so the
  // drawn playhead "loses track" of the loop. Re-anchoring collapses the accumulator
  // to the current real in-loop position so both clocks stay aligned across the edit.
  private reanchorClock() {
    if (!this._playing) return;
    this.startOffset = this.position();
    this.startedAt = this.ctx.currentTime;
  }
  // Push the sounding rate (tempo × bend) to the engine voice + key-lock/vinyl pitch.
  private pushRate() {
    this.stretchNode?.port.postMessage({ type: "speed", value: this.effRate() });
    this.updatePitch();
  }
  // Ease an active bend back to 0 over BEND_DECAY, re-anchoring the clock each frame so
  // the playhead stays continuous as the rate glides home.
  private startBendDecay() {
    if (this.bendRaf || typeof requestAnimationFrame === "undefined") return;
    let last = this.ctx.currentTime;
    const tick = () => {
      this.bendRaf = 0;
      const now = this.ctx.currentTime;
      const dt = Math.min(0.05, Math.max(0, now - last));
      last = now;
      const live = this._bend !== 0 && this._playing && this.jogPhase === "off";
      if (live) {
        this.reanchorClock();
        this._bend *= Math.exp(-dt / Deck.BEND_DECAY);
        if (Math.abs(this._bend) < 1e-3) this._bend = 0;
        this.pushRate();
      }
      if (this._bend !== 0 && this._playing && this.jogPhase === "off") {
        this.bendRaf = requestAnimationFrame(tick);
      }
    };
    this.bendRaf = requestAnimationFrame(tick);
  }
  // Drop any active bend back to the set tempo at once — a transport action / scrub /
  // explicit tempo change takes over the clock, so the residual push must not linger.
  private clearBend() {
    if (this.bendRaf) {
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.bendRaf);
      this.bendRaf = 0;
    }
    if (this._bend !== 0) {
      this.reanchorClock();
      this._bend = 0;
      this.pushRate();
    }
  }

  private startJogLoop() {
    if (this.jogRaf || typeof requestAnimationFrame === "undefined") return;
    this.jogLast = this.ctx.currentTime;
    const tick = () => {
      this.jogRaf = 0;
      const phase = this.jogPhase;
      if (phase === "off") return;
      const now = this.ctx.currentTime;
      let dt = now - this.jogLast;
      this.jogLast = now;
      if (dt > 0) {
        dt = Math.min(dt, 0.05); // a tab-blur gap must not fling the platter
        if (phase === "grab") {
          this.grabTick(dt); // active motion posts in scrubMove(); this tracks fling + settles
        } else {
          this.stepCoast(dt); // may settle the platter to "off"
          this.startOffset = this.jogPos;
          if (this.jogPhase !== "off") this.scratchMove(); // voice the coast motion
        }
      }
      if (this.jogPhase !== "off") this.jogRaf = requestAnimationFrame(tick);
    };
    this.jogRaf = requestAnimationFrame(tick);
  }

  // Abort an in-flight jog (drag or coast) WITHOUT moving the playhead — the
  // current platter position is already mirrored into startOffset each tick, so a
  // transport action (play/pause/seek/cue) simply takes over from where it is.
  private cancelJog() {
    if (this.jogPhase === "off") return;
    this.jogPhase = "off";
    if (this.jogRaf) {
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.jogRaf);
      this.jogRaf = 0;
    }
    this.jogVel = 0;
    this.handVel = 0;
    this.scratchStop();
  }

  // Full reset on track load: cancel the jog and zero the platter.
  private stopJog() {
    this.cancelJog();
    if (this.bendRaf) {
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.bendRaf);
      this.bendRaf = 0;
    }
    this._bend = 0;
    this.jogPos = 0;
    this.handPos = 0;
    this.jogReturnToPlay = false;
  }

  // GRAB tick (frame rate): the platter IS the finger while gripped — each pointer
  // sample is applied + voiced directly in scrubMove() at full input rate (1:1, no
  // spring lag, sharp scratches). Here we only (a) track the release-fling velocity
  // from the net hand motion this frame (the AudioContext clock can't time individual
  // sub-frame samples), and (b) when the finger is HELD STILL / between input batches,
  // feed the worklet the held position so it settles to zero speed.
  private grabTick(dt: number) {
    const moved = this.handPos - this.handLast;
    this.handLast = this.handPos;
    const inst = moved / dt;
    const hk = 1 - Math.exp(-dt / 0.03); // light smoothing → clean release-fling velocity
    this.handVel += (inst - this.handVel) * hk;
    this.jogVel = this.handVel;
    if (this.ctx.currentTime - this.jogInputAt > 0.006) {
      // no fresh input: settle the worklet to the held position (else it would drift)
      this.startOffset = this.jogPos;
      this.scratchMove();
    }
  }

  // COAST step: no finger. Either spin back up to play speed, or rub to a stop.
  private stepCoast(dt: number) {
    if (this.jogReturnToPlay) {
      // Releasing a scrub during playback: catch back to 1× quickly and locally,
      // so the audio glides back to speed where you let go instead of the platter
      // throwing the playhead forward through the track. Weight lengthens it a bit.
      const tau = lerp(0.025, 0.12, this._jogWeight);
      this.jogVel += (this._rate - this.jogVel) * (1 - Math.exp(-dt / tau));
      this.jogPos += this.jogVel * dt;
      this.clampJog();
      if (Math.abs(this.jogVel - this._rate) < 0.03) {
        // Hand the platter back to normal playback, continuing seamlessly: fade
        // the resampler out as the buffer source fades in (both declick).
        this.jogPhase = "off";
        this.scratchStop();
        this.startOffset = this.jogPos;
        this.spawnSource(this.jogPos);
        this._playing = true;
      }
    } else {
      // Friction glide: drag sets the brake strength, weight lengthens the coast.
      // Kept short (sub-second) so a flick eases off instead of spinning away.
      const tau = lerp(0.6, 0.1, this._jogDrag) * lerp(0.7, 1.3, this._jogWeight);
      this.jogVel *= Math.exp(-dt / tau);
      this.jogPos += this.jogVel * dt;
      this.clampJog();
      if (Math.abs(this.jogVel) < 0.02) {
        this.jogPhase = "off";
        this.jogVel = 0;
        this.startOffset = this.jogPos; // settle, paused, where it stopped
        this.scratchStop();
      }
    }
  }

  private clampJog() {
    const dur = this.buffer ? this.buffer.duration : 0;
    if (this.jogPos <= 0) {
      this.jogPos = 0;
      if (this.jogVel < 0) this.jogVel = 0;
    } else if (this.jogPos >= dur) {
      this.jogPos = dur;
      if (this.jogVel > 0) this.jogVel = 0;
    }
  }

  setTempo(tempoPercent: number) {
    this.clearBend(); // a deliberate tempo move supersedes any momentary bend
    const rate = 1 + tempoPercent / 100;
    if (this._playing) {
      this.startOffset = this.position();
      this.startedAt = this.ctx.currentTime;
    }
    this._tempo = tempoPercent;
    this._rate = rate;
    // Glide the engine's speed so fader moves bend tempo smoothly instead of
    // stepping. Stems are one engine voice, so they stay sample-locked for free.
    // Port message, not an AudioParam — the worklet de-zippers it (see stretchWorklet).
    this.stretchNode?.port.postMessage({ type: "speed", value: rate });
    this.updatePitch(); // vinyl mode (key-lock off) tracks the new tempo
    this.onTempoChange?.(); // AudioEngine sync hook: master→slave follow / release
  }

  get quantizing() {
    return this.quantizeOn;
  }
  setQuantize(on: boolean) {
    this.quantizeOn = on;
  }
  private snap(t: number): number {
    const g = this.beatgrid;
    if (!g) return t;
    return nearestBeat(g, t); // dynamic grid aware (falls back to the uniform comb)
  }
  private maybeSnap(t: number): number {
    return this.quantizeOn ? this.snap(t) : t;
  }

  /** Jump by N beats from the current position, landing on the real grid beat. */
  beatJump(beats: number) {
    const g = this.beatgrid;
    if (!g) {
      this.seek(this.position() + beats * (60 / 120));
      return;
    }
    this.seek(beatTimeOffset(g, this.position(), beats));
  }

  /** Jump to the next (dir>0) / previous (dir<0) phrase boundary — an 8/16/32-bar
   *  section start. Past the detected range (or with no phrase data) it falls back
   *  to a phrase-length jump in bars so the control always does something useful. */
  phraseJump(dir: number) {
    const g = this.beatgrid;
    if (!g) return;
    const pos = this.position();
    const eps = 0.08; // don't re-land on the boundary we're sitting on
    const phrases = g.phrases;
    if (phrases && phrases.length) {
      if (dir > 0) {
        for (let i = 0; i < phrases.length; i++) {
          if (phrases[i] > pos + eps) return this.seek(phrases[i]);
        }
      } else {
        for (let i = phrases.length - 1; i >= 0; i--) {
          if (phrases[i] < pos - eps) return this.seek(phrases[i]);
        }
      }
    }
    const bars = g.phraseBars ?? 16;
    const bpb = g.beatsPerBar ?? 4;
    this.seek(beatTimeOffset(g, pos, dir * bars * bpb));
  }

  // --- cue ---
  setCue() {
    this.cuePoint = this.maybeSnap(this.position());
  }
  jumpToCue() {
    this.seek(this.cuePoint);
  }

  // --- hot cues: tap empty pad to set, tap set pad to jump ---
  hotCue(i: number) {
    // A saved loop on this pad takes priority: recall + activate it.
    if (this.hotLoops[i]) {
      this.recallLoop(i);
      return;
    }
    const cur = this.hotCues[i];
    if (cur == null) this.hotCues[i] = this.maybeSnap(this.position());
    else this.seek(cur);
  }
  clearHotCue(i: number) {
    this.hotCues[i] = null;
    this.hotLoops[i] = null;
  }
  slotIsSet(i: number): boolean {
    return this.hotCues[i] != null || this.hotLoops[i] != null;
  }

  /** Save the current loop to pad `i` (so it can be recalled later). */
  saveLoop(i: number): boolean {
    if (!this.loop) return false;
    this.hotLoops[i] = { ...this.loop, active: false };
    this.hotCues[i] = null;
    return true;
  }
  /** Recall + activate the loop saved on pad `i`. */
  recallLoop(i: number) {
    const l = this.hotLoops[i];
    if (!l) return;
    this.loop = { ...l, active: true };
    this.applyLoop();
    this.seek(l.start);
  }

  // --- loops ---
  /** Set + enable a loop of `beats` length, snapped to the beatgrid.
   *  Resizing an ACTIVE loop keeps its in-point anchored (rekordbox behaviour),
   *  so 1/2/4/8 changes the length in place instead of jumping the loop to the
   *  playhead. With no active loop, drop a fresh loop at the current position. */
  setBeatLoop(beats: number) {
    if (!this.buffer) return;
    const g = this.beatgrid;
    const interval = g?.interval ?? 60 / 120;
    const start = this.loop?.active ? this.loop.start : g ? this.snap(this.position()) : this.position();
    // End on the beat `beats` away on the actual grid (exact even if tempo drifts),
    // not start + beats·interval which only holds for a perfectly constant tempo.
    // `beats` can be sub-1 (1/2 … 1/16); beatTimeOffset interpolates the fraction.
    const rawEnd = g ? beatTimeOffset(g, start, beats) : start + beats * interval;
    // Never let the loop collapse to a degenerate/NaN window — a sub-quantum or NaN
    // loopEnd hangs/crackles the source node. Floor it at ~5 ms (well below any
    // musical 1/16-beat loop, which is ≥~20 ms) and fall back to the interval math.
    const MIN_LOOP = 0.005;
    let end = Math.min(this.duration, rawEnd);
    if (!(end > start + MIN_LOOP)) end = Math.min(this.duration, start + Math.max(MIN_LOOP, beats * interval));
    this.reanchorClock(); // collapse the loop-phase accumulator before the bounds change
    this.loop = { active: true, start, end, beats };
    this.applyLoop();
    // Keep the playhead inside the (possibly shrunk) region so a live source
    // doesn't run past the new loopEnd before wrapping.
    if (this._playing) {
      const pos = this.position();
      if (pos < start || pos > end) this.seek(start);
    }
  }

  // FLX4-style manual loop. With no active loop: tap IN to drop the entry point,
  // tap OUT to set the exit and start looping. With a loop already running, IN
  // and OUT nudge that loop's in/out boundaries so it can be fine-tuned.
  loopIn() {
    const t = this.maybeSnap(this.position());
    if (this.loop?.active) {
      this.reanchorClock(); // phase-lock the playhead across the in-point nudge
      this.loop.start = Math.min(t, this.loop.end - 1e-3);
      this.loop.beats = this.loopBeats(this.loop);
      this.applyLoop();
      if (this._playing && this.position() < this.loop.start) this.seek(this.loop.start);
    } else {
      this.loopInPoint = t;
    }
  }
  loopOut() {
    const t = this.maybeSnap(this.position());
    if (this.loop?.active) {
      if (t > this.loop.start) {
        this.reanchorClock(); // phase-lock the playhead across the out-point nudge
        this.loop.end = t;
        this.loop.beats = this.loopBeats(this.loop);
        this.applyLoop();
      }
      return;
    }
    if (this.loopInPoint == null) return;
    const start = this.loopInPoint;
    const end = t;
    this.loopInPoint = null;
    if (end <= start) return;
    this.loop = { active: true, start, end, beats: 0 };
    this.loop.beats = this.loopBeats(this.loop);
    this.applyLoop();
  }

  private loopBeats(loop: Loop): number {
    const interval = this.beatgrid?.interval ?? 60 / 120;
    return Math.max(1, Math.round((loop.end - loop.start) / interval));
  }

  // Fired after a loop BOUNDARY edit (fine-adjust / move) so the App can broadcast the
  // absolute region to a session (in/out/exit emit their own intents; this covers the
  // nudge/drag/move paths those don't). Not fired for plain in/out/exit/beat loops.
  onLoopEdit?: () => void;
  /** Current loop region (absolute), or null — the setpoint sent over a session. */
  loopRegion(): { start: number; end: number; active: boolean } | null {
    return this.loop ? { start: this.loop.start, end: this.loop.end, active: this.loop.active } : null;
  }
  /** Apply an absolute loop region from a session peer (fine-adjust / move sync). */
  applyLoopRegion(start: number, end: number, active: boolean) {
    if (end <= start) return;
    this.reanchorClock(); // phase-lock the playhead across a peer's loop reshape
    this.loop = { active, start, end, beats: this.loopBeats({ active, start, end, beats: 0 }) };
    this.applyLoop();
  }

  /** Shift the whole loop by `beats` (keeping its length), grid-locked. Positive
   *  = forward. Used to move a loop a bar/beat at a time without resizing it. */
  moveLoop(beats: number) {
    if (!this.loop) return;
    const interval = this.beatgrid?.interval ?? 60 / 120;
    const len = this.loop.end - this.loop.start;
    let start = this.loop.start + beats * interval;
    if (start < 0) start = 0;
    if (start + len > this.duration) start = Math.max(0, this.duration - len);
    this.reanchorClock(); // phase-lock the playhead across the loop move
    this.loop = { ...this.loop, start, end: start + len };
    this.applyLoop();
    if (this._playing && this.loop.active) {
      const pos = this.position();
      if (pos < start || pos > start + len) this.seek(start);
    }
    this.onLoopEdit?.();
  }
  reloop() {
    if (!this.loop) return;
    this.loop.active = true;
    this.applyLoop();
    this.seek(this.loop.start);
  }

  toggleLoop() {
    if (!this.loop) return;
    if (this.loop.active) this.rebaseClock(); // turning OFF: anchor before unwrapping
    this.loop.active = !this.loop.active;
    this.applyLoop();
  }
  exitLoop() {
    if (!this.loop) return;
    this.rebaseClock();
    this.loop.active = false;
    this.adjusting = null; // leaving the loop ends any boundary edit (no stuck highlight)
    this.applyLoop();
  }

  /** Exit an active loop as a "loop roll": instead of staying put (exitLoop), jump
   *  to where the track WOULD be had it never looped — the un-wrapped clock — so the
   *  music snaps back on-beat after the momentary stutter. Pair with setBeatLoop()
   *  on press / rollOut() on release for a hold-to-roll pad. */
  rollOut() {
    if (!this.loop?.active) return;
    this.loop.active = false;
    if (this._playing) {
      // Raw (un-wrapped) offset = where playback would have reached with no loop.
      const raw = this.startOffset + (this.ctx.currentTime - this.startedAt) * this.effRate();
      this.applyLoop();
      this.seek(Math.max(0, Math.min(this.duration, raw)));
    } else {
      this.applyLoop();
    }
  }

  /** Wipe the loop entirely (region + any pending in-point), so the deck plays
   *  straight through. Shift-RELOOP / Shift-EXIT. */
  clearLoop() {
    if (this.loop?.active) this.rebaseClock(); // anchor before the region disappears
    this.loop = null;
    this.loopInPoint = null;
    this.adjusting = null;
    this.applyLoop();
  }

  // --- loop-boundary fine-adjust (Shift-IN / Shift-OUT) ---
  /** Toggle fine-adjust of a loop boundary. "in" targets the active loop's start
   *  (or a pending manual loop-in point); "out" targets the loop's end. Re-toggling
   *  the same side, or a side with nothing to move, turns it off. Returns the mode. */
  /** Toggle loop-boundary fine-adjust (the IN/OUT "head editor"). A small state
   *  machine so the IN/OUT button highlights contextually and every press does
   *  something useful regardless of loop state:
   *    - same boundary already armed → disarm (toggle off)
   *    - IN → arm "in"; if there's no loop or in-point yet, drop one at the playhead
   *    - OUT → arm "out"; if only an in-point exists, close the loop here first so
   *      there's an end to nudge; with nothing at all, stay off (nothing to adjust) */
  toggleAdjust(which: "in" | "out"): "in" | "out" | null {
    if (this.adjusting === which) {
      this.adjusting = null;
      return null;
    }
    if (which === "in") {
      if (!this.loop && this.loopInPoint == null) this.loopInPoint = this.maybeSnap(this.position());
      this.adjusting = "in";
    } else {
      if (!this.loop && this.loopInPoint != null) this.loopOut(); // close in→here, then adjust the end
      this.adjusting = this.loop ? "out" : null;
    }
    return this.adjusting;
  }
  endAdjust() {
    this.adjusting = null;
  }
  /** Position of the boundary currently under adjustment, or null. */
  private adjustAnchor(): number | null {
    if (this.adjusting === "in") return this.loop ? this.loop.start : this.loopInPoint;
    if (this.adjusting === "out") return this.loop ? this.loop.end : null;
    return null;
  }
  /** Place the boundary under adjustment at `pos` (clamped to the track, in kept
   *  before out), keeping the loop live + audible. Shared by drag / scroll / keys. */
  private setAdjustPos(pos: number) {
    pos = Math.max(0, Math.min(this.duration, pos));
    if (this.loop?.active) this.reanchorClock(); // phase-lock the playhead before reshaping the live loop
    if (this.adjusting === "in") {
      if (this.loop) {
        this.loop.start = Math.min(pos, this.loop.end - 1e-3);
        this.loop.beats = this.loopBeats(this.loop);
        this.applyLoop();
        if (this._playing && this.position() < this.loop.start) this.seek(this.loop.start);
      } else {
        this.loopInPoint = pos;
      }
    } else if (this.adjusting === "out" && this.loop) {
      this.loop.end = Math.max(pos, this.loop.start + 1e-3);
      this.loop.beats = this.loopBeats(this.loop);
      this.applyLoop();
    }
    if (this.loop) this.onLoopEdit?.(); // broadcast the new region to a session
  }
  /** Continuous nudge of the adjusted boundary by `deltaSec` (waveform drag). The
   *  lock follows the grid magnet: quantize on → the boundary snaps to the nearest
   *  grid beat as you drag; off → it moves freely for surgical sub-beat placement. */
  adjustBy(deltaSec: number) {
    const cur = this.adjustAnchor();
    if (cur == null) return;
    this.setAdjustPos(this.maybeSnap(cur + deltaSec));
  }
  /** Discrete step of the adjusted boundary by `units` (arrow keys / scroll ticks).
   *  Quantize on → move `units` whole beats along the real grid (lands on a beat);
   *  off → move a fine fraction of a beat so unlocked edits stay surgical. */
  adjustStep(units: number) {
    const cur = this.adjustAnchor();
    if (cur == null) return;
    const g = this.beatgrid;
    if (this.quantizeOn && g) {
      this.setAdjustPos(beatTimeOffset(g, cur, units));
    } else {
      const interval = g?.interval ?? 60 / 120;
      this.setAdjustPos(cur + units * interval * ADJUST_FINE_BEATS);
    }
  }

  // Re-anchor the playback clock to the CURRENT (wrapped) position. While a loop
  // is active, position() folds the ever-growing raw offset back into the loop
  // with a modulo; the moment the loop stops wrapping, that raw offset would snap
  // the playhead far ahead. Rebasing here keeps it continuous with the audio.
  private rebaseClock() {
    if (!this._playing) return;
    this.startOffset = this.position();
    this.startedAt = this.ctx.currentTime;
  }

  private applyLoop() {
    const l = this.loop;
    // Only loop on a finite, non-degenerate window — a NaN/inverted loopEnd would
    // hang the engine's playhead wrap, so any bad value just falls back to no loop.
    const valid = !!l && l.active && Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start;
    this.stretchNode?.port.postMessage({
      type: "loop",
      active: valid,
      start: valid ? l!.start : 0,
      end: valid ? l!.end : 0,
    });
  }

  // --- EQ / trim ---
  get trim() {
    return this._trim;
  }
  setTrim(gain: number) {
    this._trim = gain;
    this.trimNode.gain.value = gain;
  }
  get level() {
    return this._level;
  }
  setLevel(gain: number) {
    this._level = gain;
    this.output.gain.value = gain;
  }
  get eqLow() {
    return this._eqLow;
  }
  get eqMid() {
    return this._eqMid;
  }
  get eqHigh() {
    return this._eqHigh;
  }
  setEqLow(db: number) {
    this._eqLow = db;
    this.eq.setLow(db);
  }
  setEqMid(db: number) {
    this._eqMid = db;
    this.eq.setMid(db);
  }
  setEqHigh(db: number) {
    this._eqHigh = db;
    this.eq.setHigh(db);
  }

  // --- EQ band frequencies (Pro-Q-style: drag a node sideways) ---
  get eqLowFreq() {
    return this.eq.lowFreq;
  }
  get eqMidFreq() {
    return this.eq.midFreq;
  }
  get eqHighFreq() {
    return this.eq.highFreq;
  }
  get eqMidQ() {
    return this.eq.midQ;
  }
  setEqLowFreq(hz: number) {
    this.eq.setLowFreq(hz);
  }
  setEqMidFreq(hz: number) {
    this.eq.setMidFreq(hz);
  }
  setEqHighFreq(hz: number) {
    this.eq.setHighFreq(hz);
  }
  setEqMidQ(q: number) {
    this.eq.setMidQ(q);
  }

  // --- HP / LP cut filters (cutoff + resonance) ---
  get eqHpFreq() {
    return this.eq.hpFreq;
  }
  get eqHpQ() {
    return this.eq.hpQ;
  }
  get eqLpFreq() {
    return this.eq.lpFreq;
  }
  get eqLpQ() {
    return this.eq.lpQ;
  }
  setEqHpFreq(hz: number) {
    this.eq.setHpFreq(hz);
  }
  setEqHpQ(q: number) {
    this.eq.setHpQ(q);
  }
  setEqLpFreq(hz: number) {
    this.eq.setLpFreq(hz);
  }
  setEqLpQ(q: number) {
    this.eq.setLpQ(q);
  }

  // --- EQ routing: bypass (A/B the EQ) + solo (audition one band) ---
  get eqBypassed() {
    return this.eq.bypassed;
  }
  setEqBypass(on: boolean) {
    this.eq.setBypass(on);
  }
  soloBand(hz: number, q = 4) {
    this.eq.solo(hz, q);
  }
  clearSolo() {
    this.eq.clearSolo();
  }

  /** Restore the EQ to flat: all band gains 0 dB, every node back to its default
   *  frequency / bell width, the cut filters parked off, bypass cleared. */
  resetEq() {
    this.eq.reset();
    this._eqLow = 0;
    this._eqMid = 0;
    this._eqHigh = 0;
  }

  /** Combined EQ magnitude (dB) at each frequency in `freqHz`, into `outDb` — the
   *  real biquad response, for drawing the curve. */
  eqMagnitude(freqHz: Float32Array, outDb: Float32Array) {
    this.eq.magnitude(freqHz, outDb);
  }

  /** Spectrum (0…255 per bin): post-fader by default, or pre-EQ (the raw track,
   *  before this channel's EQ) when `source === "pre"`. */
  get spectrumBins() {
    return this.meterL.frequencyBinCount;
  }
  get sampleRate() {
    return this.ctx.sampleRate;
  }
  spectrum(out: Uint8Array, source: "pre" | "post" = "post") {
    const an = source === "pre" ? this.meterPre : this.meterL;
    an.getByteFrequencyData(out as Uint8Array<ArrayBuffer>);
  }

  // Bipolar representation for the one-knob UI / session sync: +hp, −lp, 0 = flat.
  // (When both sides are engaged independently it reports the HP side — the single
  // knob can't draw a band-pass, but the EQ curve shows both real cuts.)
  get filterValue() {
    return this._hp > 0 ? this._hp : -this._lp;
  }
  // One-knob DJ color filter: left = low-pass (cutoff sweeps down), right =
  // high-pass (cutoff sweeps up), centre = bypassed. Bipolar → drives one side, parks
  // the other (so the on-screen knob stays a single flat-centre control).
  setFilter(v: number) {
    const x = Math.max(-1, Math.min(1, v));
    if (x >= 0) {
      this._hp = x;
      this._lp = 0;
    } else {
      this._lp = -x;
      this._hp = 0;
    }
    this.applyFilter();
  }
  // Independent high-pass / low-pass amount (0 = off … 1 = full) — the Starrypad's two
  // dedicated knobs, which can engage both at once (band-pass) instead of one-or-other.
  get hpAmount() {
    return this._hp;
  }
  get lpAmount() {
    return this._lp;
  }
  setHpAmount(a: number) {
    this._hp = Math.max(0, Math.min(1, a));
    this.applyFilter();
  }
  setLpAmount(a: number) {
    this._lp = Math.max(0, Math.min(1, a));
    this.applyFilter();
  }

  // FX master: a bypass for the deck's color filter. Off pins it transparent
  // while keeping the knob value, so flipping it back restores the same sweep.
  get fxOn() {
    return this._fxOn;
  }
  setFx(on: boolean) {
    this._fxOn = on;
    this.applyFilter();
  }
  // Drive the EQ's own HP/LP cut nodes (the curve's edge handles) INDEPENDENTLY from the
  // two amounts: HP sweeps its cutoff up (20 → 2200 Hz), LP sweeps its cutoff down
  // (20000 → 320 Hz); 0 on a side parks it open. Both can be engaged (band-pass).
  // FX-off pins both transparent while keeping the amounts.
  private applyFilter() {
    const hp = this._fxOn ? this._hp : 0;
    const lp = this._fxOn ? this._lp : 0;
    this.eq.setHpFreq(hp > 0 ? EQ_HP.min * Math.pow(EQ_HP.max / EQ_HP.min, hp) : EQ_HP.min);
    this.eq.setLpFreq(lp > 0 ? EQ_LP.max * Math.pow(EQ_LP.min / EQ_LP.max, lp) : EQ_LP.max);
  }

  // Integrated RMS loudness (linear) of the loaded track, computed once and
  // cached. Sub-sampled — loudness is a slow average, so a stride is plenty and
  // keeps a multi-minute track from blocking. Used by the "dB" gain-match button.
  get loudness(): number {
    if (this._loudness != null) return this._loudness;
    const b = this.buffer;
    if (!b) return 0;
    let sumSq = 0;
    let n = 0;
    const stride = 64;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i += stride) {
        sumSq += d[i] * d[i];
        n++;
      }
    }
    this._loudness = n ? Math.sqrt(sumSq / n) : 0;
    return this._loudness;
  }

  // ~5 ms fade in/out around every source start/stop kills the clicks you'd
  // otherwise hear on cue, seek, loop and play/pause — this is most of what makes
  // playback feel "tight" like hardware.
  private static readonly FADE = 0.005;

  // Start (or re-seat) the stretch engine at `offset`. The engine owns the
  // playhead, looping, stem mixing and declick — so this just (re)asserts the
  // loop + stem gains and tells it to start. position() stays analytical because
  // the engine advances the playhead at exactly the tempo rate.
  // `gapless` = a re-seat while already playing (cue/loop/hot-cue jump): post the
  // declicked 'seek' (fade-out → reset-at-silence → fade-in) instead of 'start' (which
  // hard-resets the FIFO at full gain → a click). Fresh play from stopped uses 'start'
  // (gain is already 0, so no click) and no stopSource is needed for the gapless path.
  private spawnSource(offset: number, gapless = false) {
    if (!this.buffer || !this.stretchNode) return;
    const t = this.ctx.currentTime;
    // With a loop active, fold the start point into [start, end) so playback
    // begins inside the loop (the engine wraps from there). The clock anchor
    // (startOffset) stays = offset since position() folds it the same way.
    let startAt = offset;
    if (this.loop?.active) {
      const { start, end } = this.loop;
      const len = end - start;
      // Fold ONLY a start that's PAST the loop end back into [start, end) — that's
      // exactly what position() does (it wraps only once pos > loop.start). A point
      // BEFORE the loop must stay put so playback runs UP TO the loop and starts
      // wrapping when it arrives; folding it into the loop made the audio jump into
      // the loop while the drawn playhead (position()) sat before it — they desynced.
      if (len > 0 && startAt >= end) {
        startAt = start + ((startAt - start) % len);
      }
    }
    this.applyLoop();
    for (const name of STEM_NAMES) this.rampStem(name);
    this.stretchNode.port.postMessage({ type: gapless ? "seek" : "start", offset: startAt });
    this.running = true;
    this.startOffset = offset;
    this.startedAt = t;
  }

  // Stop the engine voice (it fades out over its own ~5 ms declick and goes idle).
  private stopSource() {
    if (!this.running) return;
    this.running = false;
    this.stretchNode?.port.postMessage({ type: "stop", fade: Deck.FADE });
  }
}
