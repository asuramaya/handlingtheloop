import type { Beatgrid, KeyInfo, Pyramid, PyramidLevel } from "../analysis/analyze";
import { beatTimeOffset, shiftKey } from "../analysis/analyze";
import { LoopEngine } from "./LoopEngine";
export { HOT_CUE_COUNT, type Loop } from "./LoopEngine";
import { JogEngine } from "./JogEngine";

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
  reserve?: number; // pre-roll FIFO headroom (samples) the worklet keeps ahead; raised during stem separation
}

// Base (level-0) waveform envelope for one stem: per-256-sample-bucket min/max + the
// normalized low/mid/high band energies. On mobile this is computed in the SAME pass
// that packs the stem to int16 (loadEnginePcm), so the raw float32 buffers can be freed
// the instant stems are handed off — the LOD ladder downsamples from this, no PCM needed.
const STEM_BASE_BUCKET = 256;
// Cross-device contract (desktop side): the raw float32 stem AudioBuffers are ~92 MB/min and
// held TWICE (deck originals + the worklet's transferred copy), so they only bite on LONG
// tracks. Desktop keeps them for normal tracks (crisp deep-zoom + safe stretch-node reattach)
// but releases them past this length to roughly double its headroom. (Mobile always releases.)
const DESKTOP_FREE_STEMS_SECONDS = 480; // 8 min
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
import { STEM_NAMES, type StemName, type Stems, type PackedStems } from "../stems";
import { isMobileDevice } from "../stems/models";
import { decodeAudio } from "./decode";
import { Eq3, EQ_HP, EQ_LP } from "./Eq3";
import { FxRack, type FxDevice, type FxKind, type FxSlot } from "./Fx";
import { DelayFx } from "./DelayFx";
import { ReverbFx } from "./ReverbFx";
import { SaturatorFx } from "./SaturatorFx";
import { CrushFx } from "./CrushFx";
import { ModFx } from "./ModFx";
import { GateFx } from "./GateFx";
import { NoiseFx } from "./NoiseFx";

// A single deck: source -> EQ3 -> trim gain -> output (into the crossfader).
//
// AudioBufferSourceNode is one-shot, so play/seek/tempo rebuild it; position is
// reconstructed from context time so the playhead stays continuous. The deck
// owns tempo (so Sync can drive it and the UI reflects it), 8 hot cues, and a
// beat-based loop implemented with the source node's native loopStart/loopEnd.

// Serializable per-deck stem waveform envelopes — the host ships these over the
// session so a stem-less remote (a phone) can render the 4-lane display. A COARSE
// LOD level (≈2048-sample buckets), min/max quantized to int8 + base64, keeps it
// ~70 KB/track. The remote rebuilds a full pyramid from it (deep zoom goes coarse —
// fine, it has no local PCM anyway).
export interface StemView {
  videoId?: string; // the track these envelopes are FOR — a guest drops a view whose id
  //   doesn't match the song currently on that deck (the slot-vs-song staleness fix).
  //   Optional so an older peer that omits it still renders (best-effort, as before).
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

// Beat-sync role of a deck. "master" is the tempo reference; "slave" follows it.
// Directional: at most one master + one slave at a time (resolved by AudioEngine).
export type SyncRole = "off" | "master" | "slave";

// Performance-pad modes. Unshifted: cue / fx / loop / sampler (the deck's LOCAL sample pads).
// Shifted peers (SHIFT on the mode row): roll (momentary loop) ↔ loop, global (the account's
// GLOBAL sample bank) ↔ sampler, fx2 (the LATCH layer of the FX bank) ↔ fx. CUE has NO shift peer
// (the old KEY/keyboard slot was retired — pitched playback now lives as a per-pad sampler param).
export type PadMode = "cue" | "fx" | "loop" | "sampler" | "roll" | "global" | "fx2";
// Each unshifted mode's shifted peer (mirrors the FLX silkscreen's gray labels). cue → cue = no
// peer (the slot is blank); the UI shows no shifted label for CUE and shift+CUE stays in cue.
export const PAD_MODE_SHIFT: Record<PadMode, PadMode> = {
  cue: "cue", // no shift peer (blank slot)
  fx: "fx2",
  loop: "roll",
  sampler: "global",
  roll: "loop",
  global: "sampler",
  fx2: "fx",
};
// Shifted peers that are labelled but not yet functional (dimmed/disabled). None currently — kept
// for the next reserved mode (was KEY, now retired).
export const PAD_MODE_RESERVED = new Set<PadMode>();

export class Deck {
  readonly output: GainNode; // channel level fader (feeds the crossfader)
  readonly cueSend: GainNode; // pre-fader PFL tap (headphone cue) — AudioEngine wires it to the cue bus
  private readonly trimNode: GainNode;
  private readonly eq: Eq3;
  readonly rack: FxRack; // the channel-strip device chain (EQ is dev0; effects splice in after)
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
  private _cueLevel = 0; // headphone-cue send level 0..1 (0 = not in the cue bus); local monitor only
  private _eqLow = 0;
  private _eqMid = 0;
  private _eqHigh = 0;
  // Filter = two INDEPENDENT cut amounts (0 = off … 1 = full), so HP and LP can be on
  // together (band-pass). The legacy one-knob bipolar filter just drives one side and
  // zeroes the other; the Starrypad's two knobs drive each side on its own.
  private _hp = 0; // high-pass amount 0..1
  private _lp = 0; // low-pass amount 0..1
  private _loudness: number | null = null; // cached integrated RMS of the track
  // Scalars that outlive `this.buffer`: on mobile we RELEASE the ~92 MB float32 mix once stems
  // are packed into the worklet (releaseMixBuffer) — the worklet is the audio source from then
  // on, so duration + "a track is loaded" must come from these, not the (now null) buffer.
  private _duration = 0;
  private _loaded = false;
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
  // Resident int16 stem bytes handed to the worklet for THIS deck (0 when mix-only). The mobile
  // seatbelt sums this across decks to refuse a stem load that would OOM the tab, instead of
  // crashing — a byte-accurate budget replacing the old (bytes-blind) seconds proxy.
  private _stemBytes = 0;
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
  private _keylockPinnedOff = false; // Smart Fader pins keylock off so setPitch can't re-engage it
  private _pitchSemis = 0; // musical key shift, −12 … +12 semitones
  key: KeyInfo | null = null; // detected musical key (set after setBuffer)
  private stretchNode: AudioWorkletNode | null = null; // unified tempo+pitch engine (owns playback)
  private extractSeq = 0; // request id for extractRegion round-trips to the worklet
  lastDiag: Record<string, number> | null = null; // TEMP iPhone playback diagnostics (worklet heartbeat)
  get stretchAttached() { return this.stretchNode != null; } // did the playback worklet attach?
  get scratchAttached() { return this.jog.attached; } // did the scrub worklet attach?
  quantizeOn = false; // magnet: snap cues/loops/jumps to the beatgrid
  // Performance-pad mode: the one 8-pad bank (+ the keyboard 1-8) acts as hot cues, beat
  // loops, the sampler, or performance FX (Pad-FX). Lives on the deck (not just the UI) so
  // the keymap + MIDI route 1-8 by it.
  // Unshifted modes (CUE/FX/LOOP/SMP) + their shifted-layer peers, selected via SHIFT on the
  // mode-selector row. ROLL = loop sizes that momentary-roll; SONG = the loaded track's stems.
  padMode: PadMode = "cue";
  setPadMode(m: PadMode) {
    this.padMode = m;
  }
  // --- Slip mode (the shadow-playhead primitive) ---
  // rekordbox SLIP: while a scratch / hold / loop-roll overrides the audio, the track
  // keeps advancing SILENTLY underneath; on release, playback snaps to where it would be
  // had the override never happened (back on-beat). Generalises the loop-roll's analytic
  // un-wrap (rollOut) to any platter action via an explicit anchor (pos + ctx time) taken
  // when the action begins; slipShadow() reads the elapsed·rate offset off it on release.
  slipEnabled = false; // the SLIP toggle (live per-deck mode, like quantize; default off)
  private slipAnchor: { pos: number; t: number } | null = null;
  // Beat-sync role, OWNED by AudioEngine (the 2-deck relationship lives there) and
  // mirrored here so the UI can light the SYNC button. "slave" follows the master.
  syncRole: SyncRole = "off";
  onTempoChange?: () => void; // AudioEngine hook, fired at the end of setTempo
  onRateChange?: () => void; // Sampler hook — region voices ride the deck tempo; fired at the end of setTempo
  keyRole: SyncRole = "off"; // harmonic (KEY) lock role — same gate as syncRole
  onPitchChange?: () => void; // AudioEngine hook, fired at the end of setPitch

  // --- jog/platter physics + scratch resampler (state + driver) ---
  // Extracted into JogEngine (grab/coast + Vinyl Speed Adjust motor ramps/spinback + the
  // scratch worklet node), wired to this deck's transport via the host callbacks built in
  // the ctor. Deck forwards the public surface (scrubBegin/Move/End, spinback,
  // setJogPhysics/setVinylSpeed/…) to it; bend/sync-trim/clock stay native below.
  readonly jog: JogEngine;
  // --- pitch-bend (jog outer-ring / un-gripped turn / scroll while playing) ---
  // A momentary tempo push for beat-matching: `_bend` is a fractional offset folded
  // into the sounding rate (effRate = _rate·(1+_bend)). Each nudge adds to it and it
  // decays back to 0, so a faster turn piles up a bigger sustained push and letting go
  // eases home to the set tempo. NEVER a re-seek (that would glitch at the tick rate).
  private _bend = 0;
  private bendRaf = 0;
  private _bendScale = 1; // user multiplier on BEND_GAIN (pitch-bend strength)
  private static readonly BEND_GAIN = 6; // ticks→push: how hard a turn bends the tempo
  private static readonly BEND_DECAY = 0.18; // s, ease-back-to-tempo time constant
  private static readonly BEND_MAX = 0.6; // cap the push at ±60% of the set tempo
  private static readonly BEND_SEARCH = 6; // paused: scale a bend nudge into a frame-search seek
  // --- continuous beat-sync phase-lock (driven by AudioEngine.phaseCorrect) ---
  // A tiny rate trim the SYNC slave rides to null residual beat-phase drift. Tempo-match
  // alone can't hold phase forever (the best-fit BPM is rounded to 0.01 and dynamic
  // beatgrids waver), so beats slowly slide; this folds into effRate exactly like _bend,
  // so the clock + audio stay together and the slave imperceptibly speeds/slows to stay
  // locked. 0 whenever the deck isn't following.
  private _syncTrim = 0;
  // ±6 % rate: headroom to actually FOLLOW a master's local tempo / rubato (feed-forward + phase PI),
  // not just nudge a sub-beat slip. SMC's failure study calls even ±20 % detection bounds "too rigid"
  // for expressive music, so ±2 % was 10× tighter than that. Pitch-SAFE under keylock (default on —
  // WSOLA holds pitch as the rate moves); it only moves pitch when keylock is off (varispeed).
  static readonly SYNC_TRIM_MAX = 0.06;
  // Loop / cue / hot-cue subsystem (state + editing logic), constructed in the ctor.
  // Deck forwards `deck.loop` / `deck.cuePoint` etc. to it (getters below) and delegates
  // the public methods, so every existing reader/caller is unchanged. See LoopEngine.ts.
  readonly loops: LoopEngine;
  get loop() { return this.loops.loop; }
  set loop(v) { this.loops.loop = v; }
  get cuePoint() { return this.loops.cuePoint; }
  set cuePoint(v) { this.loops.cuePoint = v; }
  get hotCues() { return this.loops.hotCues; }
  set hotCues(v) { this.loops.hotCues = v; }
  get hotLoops() { return this.loops.hotLoops; }
  set hotLoops(v) { this.loops.hotLoops = v; }
  get loopInPoint() { return this.loops.loopInPoint; }
  set loopInPoint(v) { this.loops.loopInPoint = v; }
  get adjusting() { return this.loops.adjusting; }
  /** Fired after a loop BOUNDARY edit (fine-adjust / move) so the App can broadcast the
   *  absolute region to a session (in/out/exit emit their own intents; this covers the
   *  nudge/drag/move paths those don't). Not fired for plain in/out/exit/beat loops. */
  onLoopEdit?: () => void;

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
  // The anchor's effective rate streamed in the tick. When set (following), it OVERRIDES our
  // locally-computed effRate so our clock + (listener) audio run at the host's exact rate —
  // the host's bend/sync-trim never cross as intents, so self-computing the rate drifts.
  private _followRate: number | null = null;

  onEnded?: () => void;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    // Wire the loop/cue subsystem to this deck's transport via bound callbacks, so
    // its clock/worklet internals stay private (mirrors the eq/rack composition).
    this.loops = new LoopEngine({
      position: () => this.position(),
      seek: (t) => this.seek(t),
      reanchorClock: () => this.reanchorClock(),
      rebaseClock: () => this.rebaseClock(),
      rawOffset: () => this.startOffset + (this.ctx.currentTime - this.startedAt) * this.effRate(),
      postLoop: (active, start, end) => this.stretchNode?.port.postMessage({ type: "loop", active, start, end }),
      beatgrid: () => this.beatgrid,
      duration: () => this.duration,
      playing: () => this._playing,
      loaded: () => this._loaded,
      quantize: () => this.quantizeOn,
      onLoopEdit: () => this.onLoopEdit?.(),
    });
    // The FX rack is the deck's channel-strip device chain. The EQ is the first
    // (pinned, but reorderable) device; new effects (delay/reverb/chorus) slot in
    // after it. The deck keeps a direct `this.eq` reference so the EQ proxy methods
    // (and the curve UI, automix, MIDI, the color filter) address it without going
    // through the rack — the rack only owns ROUTING.
    this.eq = new Eq3(ctx);
    this.rack = new FxRack(ctx);
    this.rack.add(this.eq);
    // rack(eq → …) -> trim -> level(output) -> crossfader. The one-knob "filter" now drives
    // the EQ's own HP/LP cut nodes (see applyFilter) — there's no separate color-filter node.
    this.trimNode = ctx.createGain();
    this.output = ctx.createGain();
    this.rack.output.connect(this.trimNode);
    this.trimNode.connect(this.output);
    // Pre-fader headphone cue (PFL) tap: a parallel send off the trim node (post-EQ,
    // BEFORE the channel fader/crossfader) so a deck can be auditioned in the cue
    // device even while faded out of the master mix. Starts silent (gain 0);
    // AudioEngine connects cueSend to the cue bus — see setCueSinkId.
    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;
    this.trimNode.connect(this.cueSend);
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
    // Pre-rack spectrum tap (raw track entering the channel) — a silent analyser sink
    // on the rack input, for the curve's PRE/POST spectrum toggle.
    this.meterPre = ctx.createAnalyser();
    this.meterPre.fftSize = 1024;
    this.rack.input.connect(this.meterPre);
    // The jog/scratch/motor physics, wired to this deck's transport via bound callbacks
    // (its platter state + the scratch worklet stay private; mirrors the loops/eq/rack
    // composition). Deck's bend/clock read its phase via `this.jog.jogging`.
    this.jog = new JogEngine(ctx, {
      position: () => this.position(),
      startOffset: () => this.startOffset,
      setStartOffset: (v) => { this.startOffset = v; },
      playing: () => this._playing,
      setPlaying: (v) => { this._playing = v; },
      loaded: () => this._loaded,
      duration: () => this._duration,
      rate: () => this._rate,
      effRate: () => this.effRate(),
      play: () => this.play(),
      pause: () => this.pause(),
      spawnSource: (at) => this.spawnSource(at),
      stopSource: () => this.stopSource(),
      clearBend: () => this.clearBend(),
      scratchBuffer: () => this.buffer,
      connectScratch: (node) => { node.connect(this.rack.input); },
      slipArm: () => this.slipArm(),
      slipArmForce: () => this.slipArmForce(),
      slipReleasePos: () => this.slipReleasePos(),
    });
  }

  /** Instantaneous post-fader peak per channel in dBFS (−100 = silence … 0 = full
   *  scale). No smoothing — the UI applies its own meter ballistics, so it's safe
   *  to call from several meters a frame. */
  meterStereo(): { l: number; r: number } {
    return { l: peakDb(this.meterL, this.meterBuf), r: peakDb(this.meterR, this.meterBuf) };
  }

  get playing() {
    // During a soft-start ramp the audio is spinning up but the transport INTENT is
    // "playing", so the UI / emit / session see play immediately (a brake reads paused —
    // _playing is already false there). Internal logic uses the _playing field directly.
    return this._playing || this.jog.ramping === "start";
  }
  get duration() {
    return this._duration;
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

  /** Attach (or hot-swap) the unified time-stretch worklet — THE playback engine: it owns the
   *  playhead, looping, stems, and tempo+pitch, and its output feeds the rack (→ EQ → fader).
   *  Re-attach reloads the current PCM and re-sends speed/pitch (they're port messages). */
  attachStretchNode(node: AudioWorkletNode) {
    if (this.stretchNode) {
      try {
        this.stretchNode.disconnect();
      } catch {
        /* ignore */
      }
    }
    node.connect(this.rack.input);
    this.stretchNode = node;
    node.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string };
      if (m?.type === "diag") { this.lastDiag = e.data as Record<string, number>; return; }
      if (m?.type === "ended" && this.running) {
        this._playing = false;
        this.running = false;
        this.startOffset = this._duration;
        this.onEnded?.();
      }
    };
    // (Re)load the current PCM in case a track was set before the node attached, and
    // re-assert the current tempo/pitch (now port messages, so they must be re-sent).
    this.loadEnginePcm();
    this.stretchNode?.port.postMessage({ type: "speed", value: this.effRate() });
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
    const useStems = !!this.stems;
    // Need a source: stems play from `this.stems`, the plain mix from `buf`. On mobile we
    // release `buf` once stems are packed (releaseMixBuffer), so a stems pack must NOT be
    // gated on `buf` — only the mix path requires it.
    if (!node || (!useStems && !buf)) return;
    // Mobile packs INT16 (halves the audio-thread footprint so 4 stems × 2 decks fit a
    // phone). Desktop keeps raw FLOAT32 — RAM is plentiful and a `.slice` memcpy is far
    // cheaper than a per-sample pack loop on the load path (the pack froze the main
    // thread ~0.2 s per stem swap; the seamless re-seat below tolerates it, but desktop
    // shouldn't pay it at all).
    const packInt16 = isMobileDevice();
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
    else pushGroup(buf!); // guard above guarantees buf when !useStems
    this.engineStems = useStems;
    // Track length comes from whichever source we packed — `buf` may be null (mobile, mix
    // released after a stems pack), so read it from the first stem in that case.
    const length = useStems ? this.stems![STEM_NAMES[0]].length : buf!.length;
    // Resident-byte tally for the seatbelt: sum the group buffers we're handing off (stems only;
    // the mix isn't counted as stem memory). Read BEFORE postMessage detaches them.
    this._stemBytes = useStems ? gL.reduce((s, a, i) => s + a.byteLength + gR[i].byteLength, 0) : 0;
    node.port.postMessage({ type: "loadPcm", gL, gR, length, int16: packInt16 }, transfer);
  }

  /** Push WSOLA engine config (grain/search/stride + transient/AA toggles) to the worklet. */
  configureStretch(cfg: StretchEngineConfig) {
    this.stretchNode?.port.postMessage({ type: "config", ...cfg });
  }

  setKeylock(on: boolean) {
    this._keylock = on;
    this.updatePitch();
  }

  /** Pin key-lock OFF (Smart Fader): keeps the tempo-pitch GLIDE alive AND stops setPitch from
   *  silently re-enabling key-lock when the key is nudged mid-transition — so a manual KEY shift
   *  rides ON TOP of the glide (additive) instead of killing it. Unpin restores normal behaviour. */
  setKeylockPinnedOff(on: boolean) {
    this._keylockPinnedOff = on;
    if (on && this._keylock) {
      this._keylock = false;
      this.updatePitch();
    }
  }
  get keylockPinnedOff() {
    return this._keylockPinnedOff;
  }

  /** Wire the scratch resampler in parallel with the source (into the channel input, raw
   *  pitch — scrubbing should pitch like vinyl). The JogEngine owns the node + its PCM. */
  attachScratchNode(node: AudioWorkletNode) {
    this.jog.attachNode(node);
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
    // A manual key shift normally engages key-lock (pitch-only) — UNLESS pinned off (Smart Fader),
    // where the nudge must add to the live tempo-pitch glide rather than freeze it.
    if (this._pitchSemis !== 0 && !this._keylockPinnedOff) this._keylock = true;
    this.updatePitch();
    this.onPitchChange?.(); // AudioEngine KEY hook: master→slave follow / release
  }
  /** The track's key after the current pitch shift (null if un-analysed). */
  get effectiveKey(): KeyInfo | null {
    return this.key ? shiftKey(this.key, this._pitchSemis) : null;
  }
  /** LIVE sounding pitch shift in semitones — the integer manual `pitch` PLUS the continuous
   *  tempo-induced shift when key-lock is OFF (the Smart-Fader / vinyl glide). Equals `pitch`
   *  when key-locked. Lets the UI surface the sub-semitone drift that `pitch` alone hides. */
  get livePitchSemis(): number {
    const r = this.effRate();
    return this._pitchSemis + (this._keylock || r <= 0 ? 0 : 12 * Math.log2(r));
  }
  /** The track's key at the LIVE sounding pitch (nearest semitone) — tracks the glide, unlike
   *  `effectiveKey` which counts only the integer manual shift. */
  get liveKey(): KeyInfo | null {
    return this.key ? shiftKey(this.key, Math.round(this.livePitchSemis)) : null;
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
    this._syncTrim = 0; // a new track invalidates any inherited phase-lock trim
    this.loops.reset();
    this.jog.reset(); // cancel any platter coast + stale the scratch PCM
    // Drop any decaying pitch-bend (the platter reset above handled the jog half).
    if (this.bendRaf) {
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.bendRaf);
      this.bendRaf = 0;
    }
    this._bend = 0;
    this.stems = null; // new track: drop stems until re-derived, reset mutes to all-on
    this.stemsLoaded = false;
    this.stemMuted = { vocals: false, drums: false, bass: false, other: false };
    this.stemGain = { vocals: 1, drums: 1, bass: 1, other: 1 };
    this.stemPyramids = null;
    this.buffer = buffer;
    this._duration = buffer.duration;
    this._loaded = true;
    this.beatgrid = beatgrid;
    this.key = null; // re-set by the caller from the track analysis
    this._pitchSemis = 0;
    this.updatePitch();
    this._loudness = null; // recompute lazily for the new track
    this.loadEnginePcm(); // hand the mix PCM to the stretch engine
    for (const name of STEM_NAMES) this.rampStem(name); // reset engine stem gains to all-on
    // New track → the scratch worklet's old PCM is stale (jog.reset() above cleared the
    // loaded flag). Desktop re-sends now; mobile defers the (full float32) copy until the
    // first scratch, to keep it out of the 2-deck iOS peak.
    if (!isMobileDevice()) this.jog.sendBuffer();
  }

  /** Release the decoded float32 mix buffer (~92 MB) — called on MOBILE once this deck's stems
   *  are packed into the worklet, since the worklet stems are the audio source from then on and
   *  the float32 mix is dead weight (the dominant steady-state cost of following a 2-deck session
   *  with stems on a phone). Playback/seek/duration run off `_loaded`/`_duration`; loudness is
   *  force-cached first; the waveform uses the LOD pyramid (no raw-PCM read on mobile). Cost:
   *  scratch and a revert-to-plain-mix (setStems(null)) need a re-load until then — fine for a
   *  phone following a stem session. The caller also drops the shared trackCache reference
   *  (dropCachedBuffer) — BOTH must go for the buffer to actually free. No-op if already gone. */
  releaseMixBuffer() {
    if (!this.buffer) return;
    void this.loudness; // force the lazy RMS scan to cache `_loudness` before the buffer drops
    this.buffer = null;
  }

  // --- stems -----------------------------------------------------------------
  // A track can carry 4 time-aligned stem buffers (vocals/drums/bass/other) that
  // share the deck's clock, loop and tempo. With stems set, playback sums their
  // per-stem gains so any can be muted live; with all on the sum IS the mix.
  /** Resident int16 stem bytes this deck handed to the worklet (0 = mix-only). Feeds the
   *  mobile stem-load seatbelt so two long stem sets can't blow the iOS memory ceiling. */
  get stemBytes(): number {
    return this.stemsLoaded ? this._stemBytes : 0;
  }
  get hasStems(): boolean {
    return this.stemsLoaded;
  }
  /** The single invariant the whole session path keys on: this deck has its OWN local
   *  stems (real buffers / pyramids), NOT a mirrored host view. Snapshots advertise this
   *  (never remote-only stems), extractStemView only serialises this, and a guest only
   *  mirrors when this is false — so reuse one getter instead of `hasStems && !remoteStems`
   *  scattered at each site (where the two could drift). */
  get ownStems(): boolean {
    return this.stemsLoaded && !this.remoteStems;
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
  extractStemView(videoId?: string): StemView | null {
    // A remote-display deck holds the HOST's envelopes (rebuilt via setRemoteStemView),
    // not its own — it must never re-publish them, or a granted/clock remote would
    // overwrite the host's real stem view with a coarser re-derivation (feedback).
    if (!this.ownStems) return null;
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
      // Pick a level coarse enough to cap the BUCKET COUNT, so a long track's envelope
      // stays small: a 1024-sample floor (≈2× the old 2048 → visibly finer guest lanes),
      // coarsened further once a long track would blow past ~4500 buckets. The byte
      // ceiling stays bounded for the 4-deck payload; oversized still rides in-memory only
      // (the DO 128 KiB cap — see server/room.ts), it just won't persist.
      const minBucket = Math.max(1024, Math.ceil(p.length / 4500));
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
    return { videoId, length, sampleRate, bucket, stems, bands };
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
  /** A stem's full decoded buffer — for the sampler's stem-aware region pads (chop just the
   *  vocal / drums). Resident only on desktop, short tracks (mobile + long tracks release
   *  `this.stems`), so a null here makes the sampler fall back to the full-mix region. */
  stemBuffer(name: StemName): AudioBuffer | null {
    return this.stems ? this.stems[name] : null;
  }
  /** Pull a [start,end]-second region's PCM back out of the stretch worklet as a small AudioBuffer.
   *  On mobile the raw mix + stem AudioBuffers are freed once stems pack into the worklet
   *  (releaseMixBuffer + `this.stems = null`), so the local sampler — which slices an AudioBuffer —
   *  has nothing to grab. The int16 PCM still lives in the worklet, so copy just the slice back (a
   *  loop = a few seconds = cheap, no OOM). `stem` picks one stem group; undefined = the full mix
   *  (sum of all groups). Resolves null if the worklet isn't loaded or the node hot-swaps mid-call. */
  extractRegion(start: number, end: number, stem?: StemName): Promise<AudioBuffer | null> {
    const node = this.stretchNode;
    if (!node || end - start < 0.02) return Promise.resolve(null);
    const group = stem ? STEM_NAMES.indexOf(stem) : -1; // -1 = sum every group → the mix
    const id = ++this.extractSeq;
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (buf: AudioBuffer | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        node.port.removeEventListener("message", onMsg);
        resolve(buf);
      };
      const onMsg = (e: MessageEvent) => {
        const d = e.data as { type?: string; id?: number; length?: number; sampleRate?: number; L?: Float32Array; R?: Float32Array };
        if (d?.type !== "region" || d.id !== id) return; // not our reply (rides alongside the node's onmessage)
        if (!d.length || !d.L || !d.R) return finish(null);
        const buf = this.ctx.createBuffer(2, d.length, d.sampleRate || this.ctx.sampleRate);
        buf.getChannelData(0).set(d.L); // .set (not copyToChannel) sidesteps the ArrayBuffer/SAB generic
        buf.getChannelData(1).set(d.R);
        finish(buf);
      };
      node.port.addEventListener("message", onMsg); // the port is already started (onmessage is set in attachStretchNode)
      timer = setTimeout(() => finish(null), 2000); // safety: never hang if the node swaps out
      node.port.postMessage({ type: "extractRegion", id, start, end, group });
    });
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
      // an acceptable trade. ALWAYS on a phone (the 2-deck OOM). On DESKTOP only past
      // DESKTOP_FREE_STEMS_SECONDS — short tracks keep the buffers (crisp deep-zoom + safe
      // against a stretch-node reattach), long tracks release them to ~2× the headroom
      // (a reattach there re-packs the mix, losing stems until reload — fine on a long track).
      if (isMobileDevice() || this._duration > DESKTOP_FREE_STEMS_SECONDS) this.stems = null;
    }
  }

  /** Load PRE-PACKED int16 stems (from `loadStemsPackedInt16`) with NO float32 intermediate —
   *  the packed build never holds the full float32 set, so this is the OOM-safe path for LONG
   *  tracks on mobile. Posts the int16 PCM straight to the worklet and builds the LOD pyramids
   *  from the supplied envelopes (no PCM re-scan). `this.stems` stays null (deep-zoom stem render
   *  → LOD only). Mirrors the tail of setStems' mobile branch, minus the float32 pack. */
  loadPackedStems(packed: PackedStems, neural = false) {
    this.stems = null;
    this.stemsLoaded = true;
    this.stemsNeural = neural;
    this.remoteStems = false; // real local stems — no longer mirroring a host's remote view
    this.engineStems = true;
    this.stemPyramids = null;
    const job = ++this.stemPyramidJob;
    const transfer: ArrayBuffer[] = [];
    for (let i = 0; i < packed.gL.length; i++)
      transfer.push(packed.gL[i].buffer as ArrayBuffer, packed.gR[i].buffer as ArrayBuffer);
    // Resident-byte tally for the seatbelt (read before postMessage detaches the buffers).
    this._stemBytes = transfer.reduce((s, b) => s + b.byteLength, 0);
    // int16 PCM straight to the worklet (it sets nG, scales by INV16, resets gains to 1).
    this.stretchNode?.port.postMessage(
      { type: "loadPcm", gL: packed.gL, gR: packed.gR, length: packed.length, int16: true },
      transfer,
    );
    for (const name of STEM_NAMES) this.rampStem(name); // re-assert the current per-stem gains
    if (this._playing) this.spawnSource(this.position());
    if (job !== this.stemPyramidJob) return; // superseded mid-call
    const out = {} as Record<StemName, Pyramid>;
    for (const name of STEM_NAMES) {
      const b = packed.base[name];
      out[name] = buildLodPyramid(b.min, b.max, packed.length, packed.sampleRate, b.bucket, b.low, b.mid, b.high);
    }
    this.stemPyramids = out;
    this.onStemPyramids?.();
    this.onStemsReady?.();
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
    // A follower runs at the ANCHOR's streamed rate (folds in the host's bend + sync-trim,
    // which never cross as intents) so audio + clock stay in lockstep instead of drifting.
    if (this._followRate != null && this._followRate > 0) return this._followRate;
    return this._rate * (1 + this._bend) * (1 + this._syncTrim);
  }
  /** The effective sounding rate (tempo·bend·sync-trim) — the anchor publishes this in its tick
   *  so followers can match it. */
  get effectiveRate(): number {
    return this.effRate();
  }

  /** Current playhead position in seconds (wraps inside an active loop). */
  position(): number {
    if (!this._loaded) return 0;
    let pos = this._playing
      ? this.startOffset + (this.ctx.currentTime - this.startedAt) * this.effRate()
      : this.startOffset;
    if (this._playing && this.loop?.active) {
      const len = this.loop.end - this.loop.start;
      if (len > 0 && pos > this.loop.start) pos = this.loop.start + ((pos - this.loop.start) % len);
    }
    return Math.max(0, Math.min(this._duration, pos));
  }

  // --- follower visual clock ---
  private static nowSec(): number {
    return (typeof performance !== "undefined" ? performance.now() : 0) / 1000;
  }
  // Track-sec the follow clock has reached right now (anchor + elapsed·velocity).
  private followExtrapolate(now: number): number {
    const dt = Math.min(Math.max(0, now - this.followAt), 0.5); // cap a stalled tick
    const base = this._followRate != null && this._followRate > 0 ? this._followRate : this._rate > 0 ? this._rate : 1;
    return this.followPos + dt * (base + this.followBias);
  }
  /** Feed the anchor's playhead tick (a co-DJ following the session). Re-anchors the
   *  clock to where it ALREADY is (continuity — no step) and folds the phase error into
   *  a gentle velocity bias that eases onto the tick over ~0.4 s; a real jump (seek /
   *  loop / big desync) or a play-state change snaps hard. */
  followTick(pos: number, playing: boolean, rate?: number): void {
    const now = Deck.nowSec();
    // Adopt the anchor's effective rate so our clock + (listener) audio run in lockstep with
    // the host (its bend/sync-trim never cross as intents). Re-speed the worklet only when it
    // moved meaningfully, so a listener's own audio tracks the host's tempo/jog.
    if (rate != null && rate > 0) {
      const moved = this._followRate == null || Math.abs(this._followRate - rate) > 0.0008;
      this._followRate = rate;
      if (moved) this.pushRate();
    }
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
    if (this._followRate != null) {
      this._followRate = null; // back to our own tempo/pitch
      this.pushRate();
    }
  }
  /** Playhead for DRAWING. A follower draws the smooth, phase-locked extrapolation of
   *  the anchor tick (so the head glides at the display rate even when the local audio
   *  clock is frozen/suspended); everyone else draws their real local clock. */
  visualPosition(): number {
    if (!this.followOn || this.jogging || !this._loaded) return this.position();
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
    return Math.max(0, Math.min(this._duration, pos));
  }
  /** Is the DRAWN playhead advancing? (drives the viewport's rAF.) */
  get visualPlaying(): boolean {
    if (!this.followOn || this.jogging || this.ctx.state === "running") return this._playing;
    return this.followPlaying;
  }

  play() {
    this.jog.cancelJog(); // a transport action wins over an in-flight platter coast
    this.clearBend();
    if (!this._loaded || this._playing) return;
    // iOS boots the AudioContext SUSPENDED (clock frozen) until a gesture resumes
    // it. Scrub/needle-drop already do this, but tapping Play first does not — so a
    // fresh load + Play (no prior scrub) rendered silence. Resume on the Play gesture.
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.spawnSource(this.startOffset);
    this._playing = true;
  }
  pause() {
    this.jog.cancelJog();
    this.clearBend();
    if (!this._playing) return;
    this.startOffset = this.position();
    this.stopSource();
    this._playing = false;
  }
  togglePlay() {
    this.playing ? this.requestPause() : this.requestPlay();
  }
  /** User-initiated play (button / key / MIDI): soft-start when Vinyl Speed is on, else
   *  instant. Session-follow / cue-drop paths keep calling play() directly for no ramp.
   *  softStart() falls back to play() when the motor feel is off. */
  requestPlay() {
    this.jog.softStart();
  }
  /** User-initiated pause: brake when Vinyl Speed is on, else instant (brakeStop falls
   *  back to pause() when off). */
  requestPause() {
    this.jog.brakeStop();
  }

  seek(seconds: number) {
    this.jog.cancelJog();
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
    this.jog.setJogPhysics(weight, drag);
  }

  /** Scale how hard a pitch-bend nudge pushes the tempo (0.25..2, 1 = default). */
  setBendStrength(mult: number) {
    this._bendScale = Math.max(0.1, Math.min(4, mult));
  }

  /** Vinyl Speed Adjust — the turntable motor feel. enabled=false restores instant
   *  play/pause + a dead platter stop. brake/start are 0..1 (→ stop / spin-up times). */
  setVinylSpeed(enabled: boolean, brake: number, start: number) {
    this.jog.setVinylSpeed(enabled, brake, start);
  }
  /** Spinback length + strength, 0..1 (Short … Long). */
  setBackSpinLength(v: number) {
    this.jog.setBackSpinLength(v);
  }

  get scrubbing() {
    return this.jog.scrubbing;
  }
  /** True only while the finger holds the platter (the grab phase) — see JogEngine.grabbing. */
  get grabbing() {
    return this.jog.grabbing;
  }
  /** True while the platter is being dragged OR still coasting after release. */
  get jogging() {
    return this.jog.jogging;
  }
  /** True while a momentary pitch-bend is decaying — pauses the sync phase-lock so the
   *  corrector doesn't chase a transient ear-nudge. */
  get bending() {
    return this._bend !== 0;
  }

  /** Apply the SYNC phase-lock rate trim (AudioEngine drives this each correction tick).
   *  Folds into effRate like a bend, so the math clock and the audio glide together and
   *  the slave imperceptibly speeds/slows to hold beat phase. No-op when unchanged. */
  setSyncTrim(trim: number) {
    const t = Math.max(-Deck.SYNC_TRIM_MAX, Math.min(Deck.SYNC_TRIM_MAX, trim));
    if (t === this._syncTrim) return;
    this.reanchorClock(); // freeze position() at the OLD rate before it changes (continuity)
    this._syncTrim = t;
    this.pushRate();
  }
  /** The applied (clamped) phase-lock trim — for the sync diagnostic (saturation = |requested|>this). */
  get syncTrim() {
    return this._syncTrim;
  }

  /** Grip the platter (pointer/jog down) — stops it dead, then it follows the finger. */
  scrubBegin() {
    this.jog.scrubBegin();
  }

  /** One (coalesced) pointer sample of finger motion, in track seconds — applied straight
   *  to the platter and voiced on the worklet immediately (tracks the mouse's true report
   *  rate, not the display refresh). */
  scrubMove(deltaSec: number) {
    this.jog.scrubMove(deltaSec);
  }

  /** Release the platter — hands it its fling velocity to coast (or a back-spin). */
  scrubEnd() {
    this.jog.scrubEnd();
  }

  // --- Vinyl Speed Adjust: transport motor ramps (brake / soft-start / spinback) ---
  // Each hands the audio to the scratch resampler and drives it through stepCoast at a
  // MOTOR time (not the jog weight/drag), so the playhead + pitch glide like a deck
  // powering down or up. The coast machinery already knows how to ramp toward play speed
  // (resumePlay) or down to a stop; these just seed it from a transport action.

  /** Spin the platter backward then let the motor catch it back to play — a triggerable
   *  back-spin (key / pad / FX), independent of a physical jog flick. */
  spinback(strength?: number) {
    this.jog.spinback(strength);
  }
  /** Release-FX Vinyl Brake: decelerate to a stop now (always, even with Vinyl Speed off). */
  releaseBrake() {
    this.jog.brakeNow();
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
    if (this.jog.jogging) return; // a gripped / coasting platter owns the motion
    if (this.ctx.state === "suspended") void this.ctx.resume();
    if (!this._playing) {
      this.needleDrop(deltaSec * Deck.BEND_SEARCH);
      return;
    }
    // Convert the roll distance into a push relative to the set tempo (so it feels the
    // same at any pitch-fader setting), accumulate, and clamp.
    const push = (deltaSec / Math.max(0.05, this._rate)) * Deck.BEND_GAIN * this._bendScale;
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
      const live = this._bend !== 0 && this._playing && !this.jog.jogging;
      if (live) {
        this.reanchorClock();
        this._bend *= Math.exp(-dt / Deck.BEND_DECAY);
        if (Math.abs(this._bend) < 1e-3) this._bend = 0;
        this.pushRate();
      }
      if (this._bend !== 0 && this._playing && !this.jog.jogging) {
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
    // effRate() (not raw rate) so a SYNC slave's phase-lock trim survives a tempo follow.
    // Port message, not an AudioParam — the worklet de-zippers it (see stretchWorklet).
    this.stretchNode?.port.postMessage({ type: "speed", value: this.effRate() });
    this.updatePitch(); // vinyl mode (key-lock off) tracks the new tempo
    this.onTempoChange?.(); // AudioEngine sync hook: master→slave follow / release
    this.onRateChange?.(); // Sampler hook: re-rate any live region voices to the new deck tempo
  }

  get quantizing() {
    return this.quantizeOn;
  }
  setQuantize(on: boolean) {
    this.quantizeOn = on;
  }

  // --- Slip mode ---
  get slipping() {
    return this.slipEnabled;
  }
  setSlip(on: boolean) {
    this.slipEnabled = on;
    if (!on) this.slipAnchor = null; // dropping the mode forgets any in-flight shadow
  }
  toggleSlip() {
    this.setSlip(!this.slipEnabled);
  }
  /** Begin a slip overlay: anchor the shadow playhead at the live position + clock so it
   *  keeps advancing at the play rate while a scratch/hold overrides the audio. No-op
   *  unless SLIP is on AND the deck was playing (nothing advances under a paused deck).
   *  Called by JogEngine at the start of a grab (before the source stops). */
  slipArm() {
    this.slipAnchor = this.slipEnabled && this._playing ? { pos: this.position(), t: this.ctx.currentTime } : null;
  }
  /** Force-anchor the shadow regardless of the SLIP toggle (CENSOR always slip-returns).
   *  Still playing-only — nothing advances under a paused deck. */
  slipArmForce() {
    this.slipAnchor = this._playing ? { pos: this.position(), t: this.ctx.currentTime } : null;
  }
  /** End a slip overlay: the shadow position (where the track would be now), consumed.
   *  Returns null when no anchor is set → the caller does its normal (coast) release.
   *  (The slip-toggle gate lives in slipArm; once an anchor exists, the shadow is real.) */
  slipReleasePos(): number | null {
    const a = this.slipAnchor;
    this.slipAnchor = null;
    return a ? this.shadowOf(a.pos, a.t) : null;
  }
  /** Where a playhead anchored at (pos, t) and running at the play rate would be now —
   *  loop-wrapped + clamped. The slip shadow, shared by slip release + cue-preview. */
  private shadowOf(pos: number, t: number): number {
    let p = pos + (this.ctx.currentTime - t) * this.effRate();
    if (this.loop?.active) {
      const len = this.loop.end - this.loop.start;
      if (len > 0 && p > this.loop.start) p = this.loop.start + ((p - this.loop.start) % len);
    }
    return Math.max(0, Math.min(this._duration, p));
  }

  // --- sustained reverse / censor (route through the scratch resampler) ---
  get reversing() {
    return this.jog.reversing;
  }
  /** Sustained REVERSE toggle — plays backward at the set tempo until turned off. */
  setReverse(on: boolean) {
    if (on) this.jog.reverseStart(false);
    else this.jog.reverseStop();
  }
  /** CENSOR (momentary reverse): plays backward while held, then slip-snaps forward to
   *  where the track would be on release (always slip-returns, regardless of the toggle). */
  censorBegin() {
    this.jog.reverseStart(true);
  }
  censorEnd() {
    this.jog.reverseStop();
  }

  // --- momentary preview (hot-cue-hold / cue-preview) ---
  private previewAnchor: { pos: number; t: number; wasPlaying: boolean } | null = null;
  get previewing() {
    return this.previewAnchor != null;
  }
  /** Momentary play-from-`pos` with return on release (hold a hot cue). Remembers where we
   *  are + the play state, jumps to `pos`, and ensures playback. */
  previewHold(pos: number) {
    if (!this._loaded) return;
    this.previewAnchor = { pos: this.position(), t: this.ctx.currentTime, wasPlaying: this._playing };
    this.seek(Math.max(0, Math.min(this._duration, pos)));
    if (!this._playing) this.play();
  }
  /** Release a preview hold: SLIP on (and we were playing) → snap to the shadow and keep
   *  playing (the hold was a non-destructive roll); else return to the pre-press position
   *  and restore the prior play state (classic cue-preview). */
  previewRelease() {
    const a = this.previewAnchor;
    this.previewAnchor = null;
    if (!a) return;
    if (this.slipEnabled && a.wasPlaying) {
      this.seek(this.shadowOf(a.pos, a.t)); // slip: snap to where it would be, keep playing
    } else if (a.wasPlaying) {
      this.seek(a.pos); // was playing, slip off: return to the press point, keep rolling
    } else {
      // Was PAUSED (cue-preview): stop the preview voice FIRST so the return seek happens
      // while paused — a paused seek only moves startOffset (silent). Seeking before pausing
      // re-seated a fresh gapless source at a.pos whose declick fade rang out = the "ghost".
      this.pause();
      this.seek(a.pos);
    }
  }

  /** Jump by N beats from the current position, landing on the real grid beat. */
  beatJump(beats: number) {
    const g = this.beatgrid;
    const pos = this.position();
    if (!g) {
      this.seek(pos + beats * (60 / 120));
      return;
    }
    // Move `beats` RELATIVE to the current position (phase-preserving), not to an absolute
    // grid offset from the preceding beat. beatTimeOffset(...,n) lands on beat[floor]+n, so a
    // sub-beat skip (e.g. skip = 0.5) snaps to the half-beat point of the CURRENT beat — which
    // can equal where we already are, leaving the jump stuck (the deck-B "jog forward dead"
    // bug: its skip was 0.5). The local interval = the gap between this beat and the next,
    // valid on a dynamic grid too; scaling it by `beats` always advances by the skip amount.
    const interval = beatTimeOffset(g, pos, 1) - beatTimeOffset(g, pos, 0);
    this.seek(pos + beats * interval);
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

  // --- cue / loop / hot-cue: state + logic live in this.loops (LoopEngine); delegated. ---
  setCue() { this.loops.setCue(); }
  jumpToCue() { this.loops.jumpToCue(); }
  hotCue(i: number) { this.loops.hotCue(i); }
  clearHotCue(i: number) { this.loops.clearHotCue(i); }
  slotIsSet(i: number): boolean { return this.loops.slotIsSet(i); }
  saveLoop(i: number): boolean { return this.loops.saveLoop(i); }
  recallLoop(i: number) { this.loops.recallLoop(i); }
  setBeatLoop(beats: number) { this.loops.setBeatLoop(beats); }
  loopIn() { this.loops.loopIn(); }
  loopOut() { this.loops.loopOut(); }
  loopRegion() { return this.loops.loopRegion(); }
  applyLoopRegion(start: number, end: number, active: boolean) { this.loops.applyLoopRegion(start, end, active); }
  moveLoop(beats: number) { this.loops.moveLoop(beats); }
  reloop() { this.loops.reloop(); }
  toggleLoop() { this.loops.toggleLoop(); }
  exitLoop() { this.loops.exitLoop(); }
  rollOut() { this.loops.rollOut(); }
  clearLoop() { this.loops.clearLoop(); }
  toggleAdjust(which: "in" | "out"): "in" | "out" | null { return this.loops.toggleAdjust(which); }
  endAdjust() { this.loops.endAdjust(); }
  adjustBy(deltaSec: number) { this.loops.adjustBy(deltaSec); }
  adjustStep(units: number) { this.loops.adjustStep(units); }

  // Re-anchor the playback clock to the CURRENT (wrapped) position. While a loop
  // is active, position() folds the ever-growing raw offset back into the loop
  // with a modulo; the moment the loop stops wrapping, that raw offset would snap
  // the playhead far ahead. Rebasing here keeps it continuous with the audio.
  private rebaseClock() {
    if (!this._playing) return;
    this.startOffset = this.position();
    this.startedAt = this.ctx.currentTime;
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
  get cueLevel() {
    return this._cueLevel;
  }
  /** Headphone-cue (PFL) send level, 0..1. Local monitor only — never broadcast to a
   *  session. A short ramp avoids zipper noise while the cue fader is dragged. */
  setCueLevel(v: number) {
    const g = Math.max(0, Math.min(1, v));
    this._cueLevel = g;
    const now = this.ctx.currentTime;
    this.cueSend.gain.cancelScheduledValues(now);
    this.cueSend.gain.setTargetAtTime(g, now, 0.01);
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

  // --- per-band SHAPE (bell / lo-shelf / hi-shelf) + shelf Q (live in bell mode) ---
  get eqLowShape() {
    return this.eq.lowShape;
  }
  setEqLowShape(i: number) {
    this.eq.setLowShape(i);
  }
  get eqMidShape() {
    return this.eq.midShape;
  }
  setEqMidShape(i: number) {
    this.eq.setMidShape(i);
  }
  get eqHighShape() {
    return this.eq.highShape;
  }
  setEqHighShape(i: number) {
    this.eq.setHighShape(i);
  }
  get eqLowQ() {
    return this.eq.lowQ;
  }
  setEqLowQ(q: number) {
    this.eq.setLowQ(q);
  }
  get eqHighQ() {
    return this.eq.highQ;
  }
  setEqHighQ(q: number) {
    this.eq.setHighQ(q);
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

  // --- FX rack: the channel-strip device chain. Every device — the EQ included — is a
  // first-class, addable/removable member. Slots index the FULL rack. The EQ is a SINGLE
  // persistent instance (`this.eq`): it can be pulled out of and pushed back into the chain
  // but is never destroyed, so the eq* proxies / color filter / automix / MIDI always have
  // a live target (no audio while the EQ is out). The EQ's PARAMS still ride the eq*
  // ControlParams; the `fx` snapshot syncs only its presence + position (empty params).
  private static readonly FX_KINDS: ReadonlySet<string> = new Set<FxKind>(["eq", "delay", "reverb", "saturator", "crush", "mod", "gate", "noise"]);
  // Effects driven by a momentary pad-throw — added DORMANT (bypassed) so the pad is the trigger.
  private static readonly PAD_THROW_KINDS: ReadonlySet<string> = new Set<FxKind>(["saturator", "crush", "mod", "gate", "noise"]);
  // The permanent pad-FX bank: every FX pad's backing device is ALWAYS resident, in pad-layout
  // order (ECHO·VERB·SAT·CRUSH / —·GATE·NOISE; CENS is transport-reverse, no device). They sit
  // DORMANT (bypassed → wet pruned, zero CPU) until thrown, so every pad is one tap from firing
  // AND one right-click from its control surface. "Opening" an effect just reveals an always-live
  // device — nothing is loaded on demand (DSP is decoupled from display).
  private static readonly PAD_FX_ORDER: readonly FxKind[] = ["delay", "reverb", "saturator", "crush", "mod", "gate", "noise"];
  // Devices that can never be removed/added at runtime (fixed-membership rack): the EQ channel
  // strip + the whole pad-FX bank. Reorder still applies (chain order is musical); presence doesn't.
  private static readonly PERMANENT_KINDS: ReadonlySet<string> = new Set<FxKind>(["eq", ...Deck.PAD_FX_ORDER]);
  private makeFx(kind: string): FxDevice | null {
    if (this.rack.list.some((d) => d.kind === kind)) return null; // ONE of each kind per channel
    switch (kind) {
      case "eq":
        return this.eq; // single instance (the guard above prevents a second)
      case "delay":
        return new DelayFx(this.ctx);
      case "reverb":
        return new ReverbFx(this.ctx);
      case "saturator":
        return new SaturatorFx(this.ctx);
      case "crush":
        return new CrushFx(this.ctx);
      case "mod":
        return new ModFx(this.ctx);
      case "gate":
        return new GateFx(this.ctx);
      case "noise":
        return new NoiseFx(this.ctx);
      default:
        return null;
    }
  }
  /** The whole device chain in order (EQ included, wherever it sits). */
  get fxDevices(): readonly FxDevice[] {
    return this.rack.list;
  }
  fxDeviceAt(i: number): FxDevice | undefined {
    return this.rack.deviceAt(i);
  }
  hasFxKind(kind: FxKind): boolean {
    return this.rack.list.some((d) => d.kind === kind);
  }
  /** Add a device at rack index `at` (default: end). Null if unknown / the single EQ is
   *  already present. */
  addFx(kind: FxKind, at = this.rack.list.length): FxDevice | null {
    const d = this.makeFx(kind);
    if (!d) return null;
    this.rack.add(d, at);
    // Pad-throw effects are momentary TRIGGERS (FLX4/rekordbox-style): they start DORMANT
    // (bypassed) and the pad enables + applies them while held, then they go back off on
    // release (setThrow snapshots/restores the bypass). Un-bypass in the panel to run one
    // persistently. ECHO/VERB target delay/reverb (real sends you dial), so those stay active.
    if (Deck.PAD_THROW_KINDS.has(kind)) d.setBypass(true);
    return d;
  }
  removeFxAt(i: number) {
    // Fixed-membership rack: the EQ channel strip AND the whole pad-FX bank are permanent
    // residents (always present, one per kind, never removable) — A/B them with bypass, dial
    // them in the panel. Only reorder moves them. Nothing here ever leaves the chain.
    if (Deck.PERMANENT_KINDS.has(this.rack.deviceAt(i)?.kind ?? "")) return;
    this.rack.remove(i);
  }
  /** Provision the permanent pad-FX bank (delay…noise) as DORMANT residents so every FX pad is
   *  always armed and every effect is one right-click from its panel. Idempotent + re-runnable.
   *  MUST run AFTER the worklets load — ReverbFx/CrushFx/ModFx build AudioWorkletNodes in their
   *  constructors, and before addModule() those throw and the device degrades to its native
   *  fallback for good. AudioEngine calls this once ensureWorklets() resolves (see its ctor). */
  ensurePadFx() {
    for (const kind of Deck.PAD_FX_ORDER) {
      if (this.rack.indexOf(kind) >= 0) continue; // already resident (re-run guard)
      const d = this.makeFx(kind);
      if (!d) continue;
      this.rack.add(d);
      d.setBypass(true); // dormant: wet pruned (zero CPU) until a pad throws or you un-bypass it
    }
  }
  moveFx(from: number, to: number) {
    this.rack.move(from, to);
  }
  setFxParam(i: number, param: string, v: number) {
    this.rack.deviceAt(i)?.setParam(param, v);
  }
  setFxBypass(i: number, on: boolean) {
    this.rack.deviceAt(i)?.setBypass(on);
  }
  resetFxAt(i: number) {
    this.rack.deviceAt(i)?.reset();
  }
  // ECHO OUT (Release FX, item 8): a momentary delay-tail "throw". Press snapshots the rack's
  // delay device, un-bypasses it, and pushes it to a long near-self-oscillating wet tail;
  // RELEASE restores the prior feedback/mix (but leaves the device active) so the captured
  // repeats decay naturally and ring out — pair it with a brake / fader pull into silence.
  // No-op when no delay is in the chain (canEchoOut gates the UI). OWES a real-device ear-test
  // (the 0.85/0.85 throw is a starting point, not eared-in).
  private echoSnapshot: { fb: number; mix: number; wasBypassed: boolean } | null = null;
  private echoRingTimer: ReturnType<typeof setTimeout> | null = null;
  echoOut(on: boolean): void {
    const dev = this.rack.deviceAt(this.rack.indexOf("delay"));
    if (!dev) return;
    if (on) {
      if (this.echoRingTimer) { clearTimeout(this.echoRingTimer); this.echoRingTimer = null; }
      if (this.echoSnapshot) return; // already thrown
      this.echoSnapshot = { fb: dev.getParam("feedback"), mix: dev.getParam("mix"), wasBypassed: dev.bypassed };
      if (dev.bypassed) dev.setBypass(false);
      dev.setParam("feedback", 0.85); // long, slowly-decaying tail (FB cap is 0.95)
      dev.setParam("mix", 0.85); // mostly-wet throw
    } else {
      const s = this.echoSnapshot;
      if (!s) return;
      this.echoSnapshot = null;
      dev.setParam("feedback", s.fb); // back to the user's setting → the captured repeats decay out
      dev.setParam("mix", s.mix);
      // The delay is a permanent resident: if it was DORMANT before the throw, let the tail ring
      // then return it to dormant so it never colours the dry signal at rest. If the user had it
      // dialled in (un-bypassed) we leave it exactly as they set it.
      if (s.wasBypassed) this.echoRingTimer = setTimeout(() => { dev.setBypass(true); this.echoRingTimer = null; }, 2400);
    }
  }
  /** A delay device is present to throw an echo from (gates the ECHO control). */
  get canEchoOut(): boolean {
    return this.rack.indexOf("delay") >= 0;
  }
  get echoingOut(): boolean {
    return this.echoSnapshot != null;
  }
  // REVERB OUT — the wet-throw twin of echoOut for the rack's reverb device: snapshot the
  // mix, un-bypass, drench it (mix → 0.85) while held; release restores so the tail blooms
  // and decays. No-op without a reverb in the chain (canReverbOut gates the FX pad).
  private reverbSnapshot: { mix: number; wasBypassed: boolean } | null = null;
  private reverbRingTimer: ReturnType<typeof setTimeout> | null = null;
  reverbOut(on: boolean): void {
    const dev = this.rack.deviceAt(this.rack.indexOf("reverb"));
    if (!dev) return;
    if (on) {
      if (this.reverbRingTimer) { clearTimeout(this.reverbRingTimer); this.reverbRingTimer = null; }
      if (this.reverbSnapshot) return;
      this.reverbSnapshot = { mix: dev.getParam("mix"), wasBypassed: dev.bypassed };
      if (dev.bypassed) dev.setBypass(false);
      dev.setParam("mix", 0.85);
    } else {
      const s = this.reverbSnapshot;
      if (!s) return;
      this.reverbSnapshot = null;
      dev.setParam("mix", s.mix);
      // Permanent resident → bloom the tail, then re-dormant if it wasn't dialled in (see echoOut).
      if (s.wasBypassed) this.reverbRingTimer = setTimeout(() => { dev.setBypass(true); this.reverbRingTimer = null; }, 2400);
    }
  }
  get canReverbOut(): boolean {
    return this.rack.indexOf("reverb") >= 0;
  }
  get reverbingOut(): boolean {
    return this.reverbSnapshot != null;
  }
  // SATURATOR THROW — slam the rack's saturator drive while held (pad-FX). No-op without a
  // saturator in the chain (canSatThrow gates the pad).
  satThrow(on: boolean): void {
    (this.rack.deviceAt(this.rack.indexOf("saturator")) as SaturatorFx | undefined)?.setThrow(on);
  }
  get canSatThrow(): boolean {
    return this.rack.indexOf("saturator") >= 0;
  }
  get satThrowing(): boolean {
    return (this.rack.deviceAt(this.rack.indexOf("saturator")) as SaturatorFx | undefined)?.throwing ?? false;
  }
  // CRUSH THROW — smash the rack's bitcrusher to a heavy setting while held (pad-FX). No-op
  // without a crusher in the chain (canCrushThrow gates the pad).
  crushThrow(on: boolean): void {
    (this.rack.deviceAt(this.rack.indexOf("crush")) as CrushFx | undefined)?.setThrow(on);
  }
  get canCrushThrow(): boolean {
    return this.rack.indexOf("crush") >= 0;
  }
  get crushThrowing(): boolean {
    return (this.rack.deviceAt(this.rack.indexOf("crush")) as CrushFx | undefined)?.throwing ?? false;
  }
  // MOD THROW — deepen the rack modulator's swirl (depth + feedback) while held (pad-FX).
  modThrow(on: boolean): void {
    (this.rack.deviceAt(this.rack.indexOf("mod")) as ModFx | undefined)?.setThrow(on);
  }
  get canModThrow(): boolean {
    return this.rack.indexOf("mod") >= 0;
  }
  get modThrowing(): boolean {
    return (this.rack.deviceAt(this.rack.indexOf("mod")) as ModFx | undefined)?.throwing ?? false;
  }
  // GATE THROW — slam the rack's trance-gate to a full-depth stutter while held (pad-FX). No-op
  // without a gate in the chain (canGateThrow gates the pad).
  gateThrow(on: boolean): void {
    (this.rack.deviceAt(this.rack.indexOf("gate")) as GateFx | undefined)?.setThrow(on);
  }
  get canGateThrow(): boolean {
    return this.rack.indexOf("gate") >= 0;
  }
  get gateThrowing(): boolean {
    return (this.rack.deviceAt(this.rack.indexOf("gate")) as GateFx | undefined)?.throwing ?? false;
  }
  // NOISE THROW — engage the rack's noise riser while held (RISE mode auto-builds, else a manual
  // gate at the current sweep); release cuts it (the drop). No-op without a noise device.
  noiseThrow(on: boolean): void {
    (this.rack.deviceAt(this.rack.indexOf("noise")) as NoiseFx | undefined)?.setThrow(on);
  }
  get canNoiseThrow(): boolean {
    return this.rack.indexOf("noise") >= 0;
  }
  get noiseThrowing(): boolean {
    return (this.rack.deviceAt(this.rack.indexOf("noise")) as NoiseFx | undefined)?.throwing ?? false;
  }
  /** Copy the device at rack index `i` to `other` — same kind, same params. The EQ copies
   *  to the other deck's EQ; an effect copies to the other's same-kind device (added if
   *  missing). Returns the destination rack index on `other`, or −1. */
  copyFxTo(other: Deck, i: number): number {
    const src = this.rack.deviceAt(i);
    if (!src) return -1;
    let dstIdx = other.rack.list.findIndex((d) => d.kind === src.kind);
    if (dstIdx < 0) {
      const added = other.addFx(src.kind);
      if (!added) return -1;
      dstIdx = other.rack.list.indexOf(added);
    }
    const dst = other.rack.deviceAt(dstIdx);
    if (!dst) return -1;
    const p = src.snapshotParams();
    for (const k in p) dst.setParam(k, p[k]);
    dst.setBypass(src.bypassed);
    return dstIdx;
  }
  /** Serialize the WHOLE chain (order + presence) for the session snapshot + profiles. The
   *  EQ carries no params here — those ride the eq* ControlParams — just its slot/position. */
  fxSnapshot(): FxSlot[] {
    return this.rack.list.map((d) => ({
      kind: d.kind,
      bypassed: d.bypassed,
      params: d.kind === "eq" ? {} : d.snapshotParams(),
    }));
  }
  /** Reconcile the rack to `slots`. Membership is now FIXED (EQ + the permanent pad-FX bank are
   *  always resident), so this never adds or removes — it syncs each matching device's params +
   *  bypass BY KIND, then reconciles chain ORDER to the snapshot. The EQ reuses `this.eq` and its
   *  params ride the eq* path (skipped here). `undefined` = an older snapshot with no FX info →
   *  leave the bank at its defaults. Kinds the snapshot omits (e.g. an older, smaller chain) keep
   *  their dormant defaults; unknown kinds are ignored. */
  applyFxSnapshot(slots: ReadonlyArray<{ kind: string; bypassed: boolean; params: Record<string, number> }> | undefined) {
    if (!slots) return;
    // Guarantee the bank is resident before syncing — covers a restore/room-intent that lands
    // BEFORE the AudioEngine ctor's post-worklet provisioning (early boot). Idempotent: a no-op
    // once provisioned, so the common path just syncs. (On a very-early restore this provisions
    // exactly as the old rebuild did — same worklet-availability characteristics, never param loss.)
    this.ensurePadFx();
    const known = slots.filter((s) => Deck.FX_KINDS.has(s.kind));
    for (const s of known) {
      const idx = this.rack.indexOf(s.kind as FxKind);
      if (idx < 0) continue; // not resident (shouldn't happen post-provision) — never re-create
      const d = this.rack.deviceAt(idx);
      if (!d || d.kind === "eq") continue; // EQ params come from the eq* ControlParams
      for (const k in s.params) d.setParam(k, s.params[k]);
      d.setBypass(s.bypassed);
    }
    // Match the chain order to the snapshot (listed kinds first, in order; residents the snapshot
    // omits keep their relative tail position). No-op when the order already matches.
    this.rack.orderByKinds(known.map((s) => s.kind));
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
  // Momentary one-knob filter THROW (FX pad): hold sweeps the colour filter to `target`
  // (−1 = full LP, +1 = full HP), release restores whatever it was before. applyFilter
  // ramps the cutoff, so the sweep in and back are declicked.
  private filterSnapshot: number | null = null;
  filterThrow(target: number, on: boolean): void {
    if (on) {
      if (this.filterSnapshot == null) this.filterSnapshot = this.filterValue;
      this.setFilter(target);
    } else if (this.filterSnapshot != null) {
      this.setFilter(this.filterSnapshot);
      this.filterSnapshot = null;
    }
  }
  get filteringThrow(): boolean {
    return this.filterSnapshot != null;
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

  // Drive the EQ's own HP/LP cut nodes (the curve's edge handles) from the two filter amounts:
  // HP sweeps its cutoff up (20 → 2200 Hz), LP sweeps its cutoff down (20000 → 320 Hz); 0 on a
  // side parks it open. Both can be engaged (band-pass). The colour filter is ALWAYS live now —
  // its old on/off master (fxOn) was a vestige of the SMART-CFX-turns-filter-on/off design and
  // is gone; the knob's centre IS the off (both amounts 0 = transparent).
  private applyFilter() {
    const hp = this._hp;
    const lp = this._lp;
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
    if (!this._loaded || !this.stretchNode) return;
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
    this.loops.applyLoop();
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
