// AudioWorklet source for the UNIFIED time-stretch engine — the single stage
// that owns playback and does tempo AND pitch, replacing the old
// `BufferSource.playbackRate` (tempo) + phase-vocoder (key) cascade.
//
// It holds the track's PCM (the mix, or 4 stems), owns a fractional source
// playhead, and on every block produces output by:
//   1. WSOLA time-stretch by  β = pitch / speed   (time-domain → crisp
//      transients, no phase smear), then
//   2. cubic resample by      γ = pitch           (sets the musical pitch).
// Net: the source playhead advances at exactly `speed` samples per output
// sample → musical tempo = speed, pitch = pitch, fully decoupled. Key-lock is
// no longer a special case: the host sets pitch = 1 (key-lock, tempo-only) or
// pitch = speed (vinyl) — there is no 1/rate correction anywhere.
//
// WSOLA (Verhelst–Roelands): grains of length FS are overlap-added at a fixed
// SYNTHESIS hop HS; the ANALYSIS pointer advances by Ha = HS·speed/pitch, and
// for each grain we search ±SEARCH around it for the offset whose overlap best
// cross-correlates with the previous grain's natural continuation — that search
// is what removes the phase-cancellation/"chorusing" of plain OLA. The clock
// (idealPos) advances by Ha with NO accumulation of the search offset, so the
// playhead never drifts from the host's analytical position().
//
// Stems stay sample-locked: ONE search offset (computed on the gain-weighted
// mono sum) is applied to all stems, which are mixed during overlap-add.
//
// Loaded via a Blob URL so it works regardless of bundler (see AudioEngine).
export const STRETCH_WORKLET_SRC = `
const RING = 8192;          // intermediate FIFO length (> max FS + margin)
const RMASK = RING - 1;     // RING is a power of two

class Stretch extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'speed', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.loaded = false;
    this.playing = false;
    this.ended = false;
    this.sr = sampleRate;
    // PCM groups (1 = mix, 4 = stems): per-group L/R channels + live gains.
    this.gL = []; this.gR = []; this.gain_ = new Float32Array(4); this.nG = 0; this.length = 0;
    // transport
    this.idealPos = 0;       // drift-free clock (source samples)
    this.grainStart = 0;     // last grain read position (source samples)
    this.naturalNext = 0;    // source idx the next grain should continue from
    this.loopActive = false; this.loopStart = 0; this.loopEnd = 0;
    // intermediate FIFO (stretched, pre-resample)
    this.ringL = new Float32Array(RING); this.ringR = new Float32Array(RING);
    this.wHead = 0; this.rHead = 0; // FIFO write (int) / read (frac) cursors
    // declick
    this.gain = 0; this.gainTarget = 0;
    this.kGain = 1 - Math.exp(-1 / (0.005 * this.sr)); // ~5 ms
    // tunable WSOLA config (settings → 'config' message); 'balanced' default.
    this.applyConfig({ frame: 1024, search: 200, stride: 2 });
    this.port.onmessage = (e) => this.onMsg(e.data);
  }
  // (Re)size the grain machinery. FS = grain length, HS = hop & overlap.
  applyConfig(c) {
    const FS = Math.max(128, Math.min(RING - 1024, c.frame | 0));
    this.FS = FS; this.HS = FS >> 1; this.OVL = FS - (FS >> 1);
    this.SEARCH = Math.max(0, c.search | 0); this.CSTRIDE = Math.max(1, c.stride | 0);
    // Bound the cross-correlation work so NO preset can overrun the audio-thread
    // quantum. Hi-Fi (search 300 · stride 1 · overlap 1024) was ~600k iterations
    // PER GRAIN — a burst that blew the 2.67 ms deadline → dropout/silence. Cap to
    // ~MAX_OFF offsets × MAX_TAP taps (CSTRIDE stays the floor); the search RANGE is
    // unchanged, just scanned more coarsely, which is plenty to seat a grain.
    const MAX_OFF = 64, MAX_TAP = 96;
    this.offStep = Math.max(this.CSTRIDE, Math.ceil((2 * this.SEARCH + 1) / MAX_OFF));
    this.tapStep = Math.max(this.CSTRIDE, Math.ceil(this.OVL / MAX_TAP));
    this.win = new Float32Array(FS);
    for (let i = 0; i < FS; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FS - 1));
    this.olaL = new Float32Array(FS); this.olaR = new Float32Array(FS);
    this.target = new Float32Array(this.OVL); // mono continuation reference
    if (this.loaded) this.refreshTarget();
  }
  onMsg(d) {
    if (d.type === 'config') { this.applyConfig(d); return; }
    if (d.type === 'loadPcm') {
      this.gL = d.gL; this.gR = d.gR; this.nG = d.gL.length; this.length = d.length;
      for (let g = 0; g < 4; g++) this.gain_[g] = g < this.nG ? 1 : 0;
      this.loaded = true;
    } else if (d.type === 'start') {
      this.reset(d.offset || 0); this.playing = true; this.ended = false; this.gainTarget = 1;
    } else if (d.type === 'seek') {
      const wasPlaying = this.playing; this.reset(d.offset || 0);
      this.playing = wasPlaying; this.ended = false; this.gainTarget = wasPlaying ? 1 : 0;
    } else if (d.type === 'stop') {
      this.playing = false; this.gainTarget = 0;
    } else if (d.type === 'loop') {
      this.loopActive = !!d.active; this.loopStart = (d.start || 0) * this.sr; this.loopEnd = (d.end || 0) * this.sr;
    } else if (d.type === 'stemGain') {
      if (d.index >= 0 && d.index < 4) this.gain_[d.index] = d.value;
    } else if (d.type === 'clear') {
      this.loaded = false; this.playing = false; this.gL = []; this.gR = []; this.nG = 0;
    }
  }
  reset(offsetSec) {
    this.idealPos = Math.max(0, offsetSec * this.sr);
    this.grainStart = this.idealPos;
    this.naturalNext = this.idealPos;
    this.olaL.fill(0); this.olaR.fill(0);
    this.wHead = 0; this.rHead = 0;
    this.refreshTarget();
  }
  // mono(idx): gain-weighted L+R sum across groups, bounds-clamped to silence.
  mono(idx) {
    if (idx < 0 || idx >= this.length) return 0;
    let s = 0;
    for (let g = 0; g < this.nG; g++) { const ga = this.gain_[g]; if (ga) s += ga * (this.gL[g][idx] + this.gR[g][idx]); }
    return s;
  }
  refreshTarget() {
    const base = this.naturalNext;
    for (let i = 0; i < this.OVL; i++) this.target[i] = this.mono(base + i);
  }
  // Produce one grain: search, overlap-add (stem-mixed), emit HS samples to FIFO.
  grain(Ha) {
    // loop wrap on the clock + continuation reference
    if (this.loopActive && this.loopEnd > this.loopStart && this.idealPos >= this.loopEnd) {
      const len = this.loopEnd - this.loopStart;
      this.idealPos -= len; this.naturalNext -= len; this.refreshTarget();
    }
    if (!this.loopActive && this.idealPos >= this.length) { this.markEnded(); return; }

    const FS = this.FS, HS = this.HS, OVL = this.OVL, SEARCH = this.SEARCH, win = this.win;
    const offStep = this.offStep, tapStep = this.tapStep;
    const base = Math.round(this.idealPos);
    // cross-correlation search for the best-matching grain offset (bounded work)
    let bestD = 0, best = -Infinity;
    for (let d = -SEARCH; d <= SEARCH; d += offStep) {
      const gs = base + d;
      let dot = 0, en = 0;
      for (let i = 0; i < OVL; i += tapStep) { const c = this.mono(gs + i); dot += c * this.target[i]; en += c * c; }
      const score = dot / Math.sqrt(en + 1e-9);
      if (score > best) { best = score; bestD = d; }
    }
    const gs = base + bestD;
    // overlap-add the windowed, stem-mixed grain
    const olaL = this.olaL, olaR = this.olaR, len = this.length;
    for (let i = 0; i < FS; i++) {
      const si = gs + i; const w = win[i];
      if (si >= 0 && si < len) {
        let l = 0, r = 0;
        for (let g = 0; g < this.nG; g++) { const ga = this.gain_[g]; if (ga) { l += ga * this.gL[g][si]; r += ga * this.gR[g][si]; } }
        olaL[i] += w * l; olaR[i] += w * r;
      }
    }
    // emit the first HS (now-complete) samples into the FIFO
    for (let i = 0; i < HS; i++) { const w = this.wHead & RMASK; this.ringL[w] = olaL[i]; this.ringR[w] = olaR[i]; this.wHead++; }
    olaL.copyWithin(0, HS, FS); olaL.fill(0, OVL, FS);
    olaR.copyWithin(0, HS, FS); olaR.fill(0, OVL, FS);
    // advance the drift-free clock; set the next continuation reference
    this.idealPos += Ha;
    this.grainStart = gs; this.naturalNext = gs + HS; this.refreshTarget();
  }
  markEnded() {
    if (!this.ended) { this.ended = true; this.playing = false; this.gainTarget = 0; this.port.postMessage({ type: 'ended' }); }
  }
  cubicRing(buf, pos) {
    const i = Math.floor(pos); const x = pos - i;
    const s1 = buf[(i - 1) & RMASK], s2 = buf[i & RMASK], s3 = buf[(i + 1) & RMASK], s4 = buf[(i + 2) & RMASK];
    const c1 = x * (-0.5 + x * (1 - 0.5 * x));
    const c2 = 1 + x * x * (1.5 * x - 2.5);
    const c3 = x * (0.5 + x * (2 - 1.5 * x));
    const c4 = 0.5 * x * x * (x - 1);
    return s1 * c1 + s2 * c2 + s3 * c3 + s4 * c4;
  }
  process(_inputs, outputs, params) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const frames = out[0].length;
    const outL = out[0], outR = out.length > 1 ? out[1] : out[0];
    if (!this.loaded) { outL.fill(0); if (out.length > 1) outR.fill(0); return true; }

    const speed = params.speed.length > 0 ? params.speed[params.speed.length - 1] : 1;
    const pitch = params.pitch.length > 0 ? params.pitch[params.pitch.length - 1] : 1;
    const Ha = this.HS * speed / pitch;   // analysis hop (β = pitch/speed → Ha = HS/β)
    const gamma = pitch;             // resample ratio

    for (let i = 0; i < frames; i++) {
      this.gain += (this.gainTarget - this.gain) * this.kGain;
      if (!this.playing && this.gain < 1e-4) { outL[i] = 0; outR[i] = 0; continue; }
      // keep the FIFO ahead of the cubic read (needs rHead-1 .. rHead+2)
      let guard = 0;
      while (this.wHead - this.rHead < gamma + 3) {
        if (this.ended) break;
        this.grain(Ha);
        if (++guard > 64) break; // safety: never spin forever in the audio thread
      }
      if (this.wHead - this.rHead < 2) { outL[i] = 0; outR[i] = 0; continue; }
      const l = this.cubicRing(this.ringL, this.rHead);
      const r = this.cubicRing(this.ringR, this.rHead);
      outL[i] = l * this.gain; outR[i] = r * this.gain;
      this.rHead += gamma;
    }
    return true;
  }
}
registerProcessor('stretch', Stretch);
`;
