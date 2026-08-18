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
// PCM is stored INT16 (the host packs it) — halves audio-thread memory so 4 stems ×
// 2 decks fit on a phone. The WSOLA search and the flux onset detector are scale-
// INVARIANT (xcorr argmax / flux-vs-EMA ratio are unchanged by a global factor), so
// they run on the raw int16 untouched; only the overlap-add — the one place audio is
// actually produced — rescales back to float by INV16. all-on still sums to the mix
// (within int16 quantization, ~ -90 dB, inaudible; the source is lossy anyway).
const INV16 = 1 / 32767;
// Shared with scratchWorklet.ts — both modules load into the SAME AudioWorkletGlobalScope
// (one global scope per BaseAudioContext), so publishing this worklet's resident PCM here
// lets scratch read it directly with zero extra copies and no message round-trip. See
// scratchWorklet.ts's header comment for the reader side.
if (!globalThis.__htlPcm) globalThis.__htlPcm = new Map();

class Stretch extends AudioWorkletProcessor {
  // NOTE: speed/pitch are driven by PORT MESSAGES, not AudioParams. iOS Safari has
  // a history of AudioWorklet parameterDescriptors bugs — if the descriptors fail to
  // register, process()'s \`params.speed\` is undefined, \`.length\` throws, and the
  // processor is killed on its first block → permanent silence (while desktop is
  // fine). Routing them over the port (smoothed here for de-zipper) sidesteps that
  // entirely; there are no parameterDescriptors and process() takes no params arg.
  constructor(options) {
    super();
    this.deckId = (options && options.processorOptions && options.processorOptions.deckId) || 'A';
    this.loaded = false;
    this.playing = false;
    this.ended = false;
    this.sr = sampleRate;
    // tempo (speed) + key (pitch) factors, smoothed toward their targets per block
    // (~20 ms) so fader/key moves don't zipper — replaces the old AudioParam ramps.
    this.speed = 1; this.speedTarget = 1;
    this.pitch = 1; this.pitchTarget = 1;
    this.kParam = 1 - Math.exp(-128 / (0.02 * this.sr));
    this.diagN = 0; // heartbeat counter (TEMP iPhone playback diagnostics)
    this.underruns = 0; // cumulative FIFO-dry dropouts mid-playback (host auto-raises pre-roll, #14)
    // PCM groups (1 = mix, 4 = stems): per-group L/R int16 channels + live gains.
    this.gL = []; this.gR = []; this.gain_ = new Float32Array(4); this.nG = 0; this.length = 0;
    this.pcmScale = INV16; // int16 PCM → float at OLA; host sends int16:false (desktop) for raw float32
    // transport
    this.idealPos = 0;       // drift-free clock (source samples)
    this.grainStart = 0;     // last grain read position (source samples)
    this.naturalNext = 0;    // source idx the next grain should continue from
    this.loopActive = false; this.loopStart = 0; this.loopEnd = 0;
    // intermediate FIFO (stretched, pre-resample)
    this.ringL = new Float32Array(RING); this.ringR = new Float32Array(RING);
    this.wHead = 0; this.rHead = 0; // FIFO write (int) / read (frac) cursors
    // Pre-roll reserve (samples) the producer keeps AHEAD of the read cursor. 0 = the
    // original just-in-time behaviour (lowest tempo/pitch control latency). The host
    // RAISES this during on-device stem separation so a CPU-pressured quantum outputs
    // pre-built grains instead of running the WSOLA/PV search and overrunning its
    // ~2.7 ms budget (the per-segment stutter). Built bounded (see process) so it never
    // itself spikes the audio thread; the drawn playhead is clock-based (Deck.position
    // reads ctx.currentTime, not this producer cursor) so deepening it never desyncs.
    this.reserve = 0;
    // STEM TAPS — the routing substrate for per-stem FX (chains). OFF by default and free when
    // off: the OLA below sums the gain-weighted groups in one pass exactly as it always has, and
    // nothing here is allocated. Switched ON, the SAME grain (same search, same seating, same
    // window) is overlap-added per group into four side FIFOs, drained by the SAME read cursor —
    // so the four taps are sample-aligned with each other by construction, and their sum is the
    // main output. The expensive half of WSOLA (the cross-correlation search) is shared; only the
    // OLA inner loop multiplies. ⚠ The phase vocoder cannot do this: it sums the groups in the
    // TIME domain before the FFT precisely so there is ONE FFT per frame, and per-stem taps would
    // mean four. So taps force the WSOLA producer (see process) and the host is told.
    this.taps = false;
    this.tapOlaL = null; this.tapOlaR = null; this.tapRingL = null; this.tapRingR = null;
    // declick
    this.gain = 0; this.gainTarget = 0;
    this.kGain = 1 - Math.exp(-1 / (0.005 * this.sr)); // ~5 ms
    // Seek declick: a re-seat while playing (cue/loop/hot-cue jump) must NOT reset the
    // FIFO at full gain — that's a hard click at the discontinuity (the old stop+start
    // pair coalesced before any audio rendered, so the fade never happened). Instead a
    // 'seek' fades out FAST (kSeek), resets at silence, then fades back in. seekPending
    // holds the pending source offset (seconds), -1 = none. Rapid re-seeks just update
    // the target while muted → always lands on the latest, no click, no pile-up.
    this.kSeek = 1 - Math.exp(-1 / (0.0015 * this.sr)); // ~1.5 ms fade-out before reset
    this.seekPending = -1;
    // Transient preservation (Driedger & Müller, "A Review of TSM", Appl. Sci. 2016;
    // Grofit & Lavner, "Enhanced WSOLA with Management of Transients"): attacks are
    // copied 1:1 with the search suppressed, the stretch deviation repaid afterwards.
    this.transientOn = true; this.tThresh = 2.2; this.energyEMA = 0; this.debt = 0;
    // Anti-aliased pitch-up resampling (windowed sinc; cutoff tracks 1/gamma).
    this.aaOn = true; this.buildSinc();
    // Phase-LOCKED phase vocoder (Laroche & Dolson, "Improved Phase Vocoder
    // Time-Scale Modification of Audio", IEEE TSAP 1999) — the OTHER selectable
    // stretch engine, the structural fix for WSOLA's metallic/scratchy sound on
    // dense polyphony (WSOLA aligns ONE grain → every other simultaneous pitch
    // gets a phase jump). The PV stretches in the STFT domain and re-locks the
    // phases per spectral peak ("identity" locking) so vertical phase coherence
    // is preserved → no metallic AND no naive-PV wateriness. Same transport shell
    // as WSOLA (idealPos clock, loop wrap, declick/seek, the γ resampler for
    // pitch, int16 pcmScale): the PV only replaces the time-stretch-by-β stage.
    // Stems stay phase-locked for free — the gain-weighted stem sum is built in
    // the time domain BEFORE the FFT, so there is ONE FFT/frame (per channel)
    // regardless of stem count and the output IS the live mix.
    this.engineMode = 'wsola';   // 'wsola' | 'pv' — host selects via config; default keeps old behaviour
    this.pvN = 0; this.pvWin = null; this.pvInit = false; this.pvEMA = 0;
    // tunable WSOLA config (settings → 'config' message); 'balanced' default.
    this.applyConfig({ frame: 1024, search: 200, stride: 2 });
    this.port.onmessage = (e) => this.onMsg(e.data);
  }
  // (Re)size the grain machinery. FS = grain length, HS = hop & overlap.
  applyConfig(c) {
    // Cheap, click-free knobs first: the settings effect re-posts config on EVERY
    // settings change, so these must not depend on a buffer rebuild.
    if (c.transient !== undefined) this.transientOn = !!c.transient;
    if (c.aa !== undefined) this.aaOn = !!c.aa;
    if (c.tThresh) this.tThresh = +c.tThresh;
    // Pre-roll reserve — a cheap knob, set BEFORE the geometry early-return below so a
    // reserve-only change (host raising it for a separation) applies without a grain
    // rebuild. Clamp so reserve + grain headroom always fits the RING.
    if (c.reserve !== undefined) this.reserve = Math.max(0, Math.min(RING - 1536, c.reserve | 0));
    // Engine selection (wsola | pv) + the PV's FFT size. A swap or an FFT-size
    // change while PLAYING would discontinuity the FIFO/OLA → click, so it goes
    // through the declicked seek path (fade out → re-seat at idealPos → fade in).
    if (c.engine !== undefined) {
      const m = c.engine === 'pv' ? 'pv' : 'wsola';
      if (m !== this.engineMode) {
        this.engineMode = m;
        if (this.loaded && this.playing) this.seekPending = Math.max(0, this.idealPos / this.sr);
      }
    }
    if (this.engineMode === 'pv') {
      // Tie FFT size to the quality tier: Fast/Balanced (frame ≤1024) → 2048,
      // Hi-Fi (frame 2048) → 4096. Bigger N = finer frequency resolution = better
      // peak separation on dense mixes, at more CPU/latency.
      const N = (c.frame | 0) >= 2048 ? 4096 : 2048;
      if (this.pvN !== N) {
        const wasPlaying = this.loaded && this.playing;
        this.buildPv(N, 4);
        if (wasPlaying) this.seekPending = Math.max(0, this.idealPos / this.sr);
      }
    }
    const FS = Math.max(128, Math.min(RING - 1024, c.frame | 0));
    const SEARCH = Math.max(0, c.search | 0);
    this.CSTRIDE = Math.max(1, c.stride | 0);
    // Bound the cross-correlation work so NO preset can overrun the audio-thread
    // quantum. Capped to ~MAX_OFF offsets × MAX_TAP taps (CSTRIDE stays the floor);
    // the search RANGE is unchanged, just scanned at a stride. The mono scratch
    // (filled ONCE per grain, see grain()) makes each tap a plain array read instead
    // of a gain-weighted mono() call whose overlapping windows recomputed the same
    // sample dozens of times — so we afford ~2× the old resolution in the same
    // budget. Finer grain seating = less periodicity warble under stretch.
    const MAX_OFF = 128, MAX_TAP = 192;
    // Geometry unchanged (e.g. an AA/transient/threshold toggle, or an unrelated
    // settings change) → just refresh the stride caps and bail BEFORE reallocating,
    // so the in-flight OLA accumulator is preserved (a rebuild would click).
    if (this.win && FS === this.FS && SEARCH === this.SEARCH) {
      this.offStep = Math.max(this.CSTRIDE, Math.ceil((2 * SEARCH + 1) / MAX_OFF));
      this.tapStep = Math.max(this.CSTRIDE, Math.ceil(this.OVL / MAX_TAP));
      return;
    }
    this.FS = FS; this.HS = FS >> 1; this.OVL = FS - (FS >> 1);
    this.SEARCH = SEARCH;
    this.offStep = Math.max(this.CSTRIDE, Math.ceil((2 * this.SEARCH + 1) / MAX_OFF));
    this.tapStep = Math.max(this.CSTRIDE, Math.ceil(this.OVL / MAX_TAP));
    this.win = new Float32Array(FS);
    // PERIODIC Hann (denominator FS, not FS-1): the symmetric Hann breaks Constant-
    // Overlap-Add at the 50% synthesis hop, leaving a periodic amplitude ripple at the
    // hop rate (a low-level roughness). The periodic Hann sums to exactly 1.0 at 50%
    // overlap → flat OLA gain.
    for (let i = 0; i < FS; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FS);
    this.olaL = new Float32Array(FS); this.olaR = new Float32Array(FS);
    if (this.taps) this.allocTaps(); // grain geometry changed → the per-stem accumulators follow it
    this.target = new Float32Array(this.OVL); // mono continuation reference
    // Scratch for the gain-weighted mono of the whole span a grain reads: the search
    // range (±SEARCH) plus the continuation-refresh tail (HS+OVL). Filled once per
    // grain so the cross-correlation is array reads, not mono() calls.
    this.monoBuf = new Float32Array(2 * this.SEARCH + this.HS + this.OVL + 8);
    if (this.loaded) this.refreshTarget();
  }
  onMsg(d) {
    if (d.type === 'config') { this.applyConfig(d); return; }
    if (d.type === 'speed') { this.speedTarget = Math.max(0.25, Math.min(4, d.value || 1)); return; }
    if (d.type === 'pitch') { this.pitchTarget = Math.max(0.25, Math.min(4, d.value || 1)); return; }
    if (d.type === 'loadPcm') {
      // gL/gR are one typed array per group (1 = mix, 4 = stems), transferred. Mobile
      // sends Int16Arrays (half the memory → fits a phone) rescaled by INV16 at output;
      // desktop sends raw Float32Arrays (int16:false → scale 1; RAM is plentiful, and
      // the float .slice is far cheaper than an int16 pack loop on the load path).
      // Indexing returns numbers either way, so the search/mono/flux code is agnostic.
      this.gL = d.gL; this.gR = d.gR; this.nG = d.gL.length; this.length = d.length;
      this.pcmScale = d.int16 === false ? 1 : INV16;
      for (let g = 0; g < 4; g++) this.gain_[g] = g < this.nG ? 1 : 0;
      this.loaded = true;
      // A new source invalidates any grains ALREADY synthesised from the OLD PCM that are
      // still queued in the output FIFO — drop them so the previous track can't bleed through
      // before the next start/seek re-seats the read head. (start/seek reset these anyway, but
      // a swap that isn't immediately followed by one would otherwise drain stale audio.)
      this.wHead = 0; this.rHead = 0; this.olaL.fill(0); this.olaR.fill(0); this.clearTaps(); this.seekPending = -1;
      // Publish for the scratch worklet — same arrays, no copy (see the module-scope note above).
      globalThis.__htlPcm.set(this.deckId, { gL: this.gL, gR: this.gR, length: this.length, pcmScale: this.pcmScale });
    } else if (d.type === 'start') {
      this.reset(d.offset || 0); this.playing = true; this.ended = false; this.gainTarget = 1;
    } else if (d.type === 'seek') {
      // Declicked re-seat (Deck only sends this while playing): fade out fast, then the
      // process loop resets at silence and fades back in. No immediate reset → no click.
      this.seekPending = Math.max(0, d.offset || 0); this.ended = false; this.gainTarget = 0;
    } else if (d.type === 'stop') {
      this.playing = false; this.gainTarget = 0;
    } else if (d.type === 'loop') {
      this.loopActive = !!d.active; this.loopStart = (d.start || 0) * this.sr; this.loopEnd = (d.end || 0) * this.sr;
    } else if (d.type === 'taps') {
      this.setTaps(!!d.on);
    } else if (d.type === 'stemGain') {
      if (d.index >= 0 && d.index < 4) this.gain_[d.index] = d.value;
    } else if (d.type === 'clear') {
      this.loaded = false; this.playing = false; this.gL = []; this.gR = []; this.nG = 0;
      globalThis.__htlPcm.delete(this.deckId); // no stale PCM left for scratch to read after unload
    } else if (d.type === 'extractRegion') {
      // Copy a [start,end]-second slice of the resident PCM back to the main thread as float32.
      // The local sampler needs an AudioBuffer to grab a loop, but on mobile the deck's raw mix +
      // stem AudioBuffers are freed once stems pack in here (this worklet is then the ONLY copy).
      // \`mask\` selects which groups to sum: <0 = every group (the mix); otherwise the set bits pick
      // the stems (one bit = one stem, several = a subset). Transferred out, nothing lingers here.
      // Empty (length 0) if nothing's loaded.
      const sr = this.sr, len = this.length, nG = this.nG, scale = this.pcmScale, mask = d.mask;
      const s0 = Math.max(0, Math.min(len, Math.round((d.start || 0) * sr)));
      const s1 = Math.max(s0, Math.min(len, Math.round((d.end || 0) * sr)));
      const n = s1 - s0;
      const L = new Float32Array(n), R = new Float32Array(n);
      if (this.loaded && nG > 0 && n > 0) {
        for (let i = 0; i < n; i++) {
          let l = 0, r = 0;
          for (let g = 0; g < nG; g++) { if (mask < 0 || (mask & (1 << g))) { l += this.gL[g][s0 + i]; r += this.gR[g][s0 + i]; } }
          L[i] = l * scale; R[i] = r * scale;
        }
      }
      this.port.postMessage({ type: 'region', id: d.id, length: n, sampleRate: sr, L, R }, [L.buffer, R.buffer]);
    }
  }
  reset(offsetSec) {
    this.idealPos = Math.max(0, offsetSec * this.sr);
    this.grainStart = this.idealPos;
    this.naturalNext = this.idealPos;
    this.olaL.fill(0); this.olaR.fill(0); this.clearTaps();
    this.wHead = 0; this.rHead = 0;
    this.debt = 0; this.energyEMA = 0;
    this.seekPending = -1; // a hard reset (start/clear) cancels any pending declick-seek
    // PV transport: drop the synthesis OLA + force a phase RESET on the next frame
    // (carrying stale synthesis phase across a seek smears the attack → click).
    if (this.pvOlaL) { this.pvOlaL.fill(0); this.pvOlaR.fill(0); }
    if (this.pvPrevMag) this.pvPrevMag.fill(0);
    this.pvInit = false; this.pvEMA = 0;
    this.refreshTarget();
  }
  // mono(idx): gain-weighted L+R sum across groups, bounds-clamped to silence.
  mono(idx) {
    if (idx < 0 || idx >= this.length) return 0;
    let s = 0;
    for (let g = 0; g < this.nG; g++) { const ga = this.gain_[g]; if (ga) s += ga * (this.gL[g][idx] + this.gR[g][idx]); }
    return s;
  }
  // (De)allocate the four per-stem accumulators + FIFOs. Called on the toggle and on any grain
  // geometry change; freeing nulls them so the taps-off path allocates nothing at all.
  allocTaps() {
    const FS = this.FS;
    this.tapOlaL = []; this.tapOlaR = []; this.tapRingL = []; this.tapRingR = [];
    for (let g = 0; g < 4; g++) {
      this.tapOlaL.push(new Float32Array(FS)); this.tapOlaR.push(new Float32Array(FS));
      this.tapRingL.push(new Float32Array(RING)); this.tapRingR.push(new Float32Array(RING));
    }
  }
  setTaps(on) {
    if (on === this.taps) return;
    this.taps = on;
    if (!on) { this.tapOlaL = null; this.tapOlaR = null; this.tapRingL = null; this.tapRingR = null; return; }
    this.allocTaps();
    // Turning taps on mid-flight swaps the producer (PV → WSOLA) and starts the side FIFOs empty
    // while the main FIFO is mid-grain: re-seat through the declick so neither is heard tearing.
    if (this.loaded && this.playing) this.seekPending = Math.max(0, this.idealPos / this.sr);
  }
  clearTaps() {
    if (!this.taps || !this.tapOlaL) return;
    for (let g = 0; g < 4; g++) { this.tapOlaL[g].fill(0); this.tapOlaR[g].fill(0); }
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
    // Fill the gain-weighted mono scratch ONCE for the whole span the search and the
    // continuation refresh will read: source [base-SEARCH, base-SEARCH+span). Adjacent
    // search offsets overlap by ~OVL, so doing this here instead of per-candidate
    // collapses ~OVL/offStep redundant mono() evaluations per sample into one.
    const M = this.monoBuf, lo = base - SEARCH, span = 2 * SEARCH + HS + OVL;
    for (let i = 0; i < span; i++) M[i] = this.mono(lo + i);
    // Onset detection (high-frequency-content flux of the emit region vs its running
    // EMA) — Grofit & Lavner detect transients inside the WSOLA loop; reusing the mono
    // scratch makes it nearly free. A detected attack is copied verbatim: the search
    // is suppressed (no WSOLA doubling/stutter) and the hop forced to HS (no stretch).
    let flux = 0;
    for (let i = SEARCH + 1; i < SEARCH + HS; i++) { const dM = M[i] - M[i - 1]; flux += dM * dM; }
    const ema = this.energyEMA;
    const transient = this.transientOn && ema > 1e-7 && flux > this.tThresh * ema && flux > 1e-5;
    this.energyEMA = ema + 0.3 * (flux - ema);
    // cross-correlation search for the best-matching grain offset — plain array reads
    // into M (candidate start index = SEARCH + d). Skipped on a transient → bestD = 0
    // (the natural continuation, no relocation).
    const tgt = this.target;
    let bestD = 0;
    if (!transient) {
      let best = -Infinity;
      for (let d = -SEARCH; d <= SEARCH; d += offStep) {
        const o = SEARCH + d;
        let dot = 0, en = 0;
        for (let i = 0; i < OVL; i += tapStep) { const c = M[o + i]; dot += c * tgt[i]; en += c * c; }
        const score = dot / Math.sqrt(en + 1e-9);
        if (score > best) { best = score; bestD = d; }
      }
    }
    const gs = base + bestD;
    // overlap-add the windowed, stem-mixed grain
    const olaL = this.olaL, olaR = this.olaR, len = this.length, scale = this.pcmScale;
    if (!this.taps) {
      // The hot path, byte-for-byte what it always was: one gain-weighted sum per sample.
      for (let i = 0; i < FS; i++) {
        const si = gs + i; const w = win[i];
        if (si >= 0 && si < len) {
          let l = 0, r = 0;
          for (let g = 0; g < this.nG; g++) { const ga = this.gain_[g]; if (ga) { l += ga * this.gL[g][si]; r += ga * this.gR[g][si]; } }
          olaL[i] += w * l * scale; olaR[i] += w * r * scale; // PCM (int16 mobile / float32 desktop) → output
        }
      }
    } else {
      // Tapped: the same window over the same grain, kept SEPARATE per group. The main
      // accumulator still gets the sum, in the same order, so the main output is unchanged.
      const tL = this.tapOlaL, tR = this.tapOlaR, nG = this.nG;
      for (let i = 0; i < FS; i++) {
        const si = gs + i; const w = win[i];
        if (si >= 0 && si < len) {
          const ws = w * scale;
          let l = 0, r = 0;
          for (let g = 0; g < nG; g++) {
            const ga = this.gain_[g]; if (!ga) continue;
            const gl = ga * this.gL[g][si], gr = ga * this.gR[g][si];
            l += gl; r += gr;
            tL[g][i] += ws * gl; tR[g][i] += ws * gr;
          }
          olaL[i] += w * l * scale; olaR[i] += w * r * scale;
        }
      }
    }
    // emit the first HS (now-complete) samples into the FIFO
    for (let i = 0; i < HS; i++) { const w = this.wHead & RMASK; this.ringL[w] = olaL[i]; this.ringR[w] = olaR[i]; this.wHead++; }
    if (this.taps) {
      // Side FIFOs ride the SAME write cursor, so they need no cursor of their own — one read
      // head (rHead, below) drains all five in lockstep and alignment is structural, not tuned.
      const base = this.wHead - HS;
      for (let g = 0; g < 4; g++) {
        const oL = this.tapOlaL[g], oR = this.tapOlaR[g], rL = this.tapRingL[g], rR = this.tapRingR[g];
        for (let i = 0; i < HS; i++) { const w = (base + i) & RMASK; rL[w] = oL[i]; rR[w] = oR[i]; }
        oL.copyWithin(0, HS, FS); oL.fill(0, OVL, FS);
        oR.copyWithin(0, HS, FS); oR.fill(0, OVL, FS);
      }
    }
    olaL.copyWithin(0, HS, FS); olaL.fill(0, OVL, FS);
    olaR.copyWithin(0, HS, FS); olaR.fill(0, OVL, FS);
    // Advance the drift-free clock. Normally by Ha; through a transient by HS (1:1
    // copy) with the ratio deviation booked to debt and repaid (clamped to ±HS/2 per
    // grain, so we never reverse or over-stretch) across the following grains — the
    // average source rate, and thus position(), stays exact (Driedger & Müller).
    let adv;
    if (transient) { adv = HS; this.debt += HS - Ha; }
    else { const corr = Math.max(-HS * 0.5, Math.min(HS * 0.5, this.debt)); adv = Ha - corr; this.debt -= corr; }
    this.idealPos += adv;
    this.grainStart = gs; this.naturalNext = gs + HS;
    const tb = SEARCH + bestD + HS;
    for (let i = 0; i < OVL; i++) tgt[i] = M[tb + i];
  }
  // ---- Phase-locked phase vocoder ------------------------------------------
  // Allocate the STFT machinery for FFT size N at the given OLA overlap factor
  // (4 = 75%). Guarded: only (re)builds when N changes, so the per-settings-post
  // applyConfig is cheap and never resets a live OLA accumulator.
  buildPv(N, overlap) {
    if (this.pvN === N && this.pvWin && this.pvOverlap === overlap) return;
    this.pvN = N; this.pvOverlap = overlap; this.Rs = (N / overlap) | 0;
    const bins = (N >> 1) + 1;
    // PERIODIC Hann, applied as BOTH the analysis and synthesis window (→ Hann²
    // effective). Sum of the squared window over hops is the OLA normalization.
    this.pvWin = new Float32Array(N);
    for (let i = 0; i < N; i++) this.pvWin[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    let s = 0; const mid = N >> 1, Rs = this.Rs;
    for (let m = -overlap; m <= overlap; m++) { const idx = mid - m * Rs; if (idx >= 0 && idx < N) { const ww = this.pvWin[idx]; s += ww * ww; } }
    this.pvNorm = s || 1;
    // FFT scratch (reused per channel), bin-indexed STFT state (per channel).
    this.fre = new Float32Array(N); this.fim = new Float32Array(N);
    this.pvMag = new Float32Array(bins); this.pvPh = new Float32Array(bins);
    this.pvPeak = new Int32Array(bins);
    this.omega = new Float32Array(bins);
    for (let k = 0; k < bins; k++) this.omega[k] = 2 * Math.PI * k / N;
    this.prevPhL = new Float32Array(bins); this.prevPhR = new Float32Array(bins);
    this.sumPhL = new Float32Array(bins); this.sumPhR = new Float32Array(bins);
    this.pvPrevMag = new Float32Array(bins);   // transient flux reference (L channel)
    this.pvOlaL = new Float32Array(N); this.pvOlaR = new Float32Array(N);
    // radix-2 FFT tables: twiddles + bit-reversal permutation.
    this.cosT = new Float32Array(N); this.sinT = new Float32Array(N);
    for (let i = 0; i < N; i++) { const a = 2 * Math.PI * i / N; this.cosT[i] = Math.cos(a); this.sinT[i] = Math.sin(a); }
    this.rev = new Int32Array(N);
    let bitsN = 0; while ((1 << bitsN) < N) bitsN++;
    for (let i = 0; i < N; i++) { let x = i, r = 0; for (let b = 0; b < bitsN; b++) { r = (r << 1) | (x & 1); x >>= 1; } this.rev[i] = r; }
    this.pvInit = false;
  }
  // In-place iterative radix-2 FFT over fre/fim (this.pvN points). inv=false →
  // forward (W = e^-i2πk/N), inv=true → inverse with 1/N scaling.
  fft(re, im, inv) {
    const N = this.pvN, rev = this.rev, cosT = this.cosT, sinT = this.sinT;
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; } }
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1, step = (N / len) | 0;
      for (let i = 0; i < N; i += len) {
        let ti = 0;
        for (let k = 0; k < half; k++) {
          const wr = cosT[ti], wi = inv ? sinT[ti] : -sinT[ti];
          const a = i + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          ti += step;
        }
      }
    }
    if (inv) { const f = 1 / N; for (let i = 0; i < N; i++) { re[i] *= f; im[i] *= f; } }
  }
  // Forward STFT of one channel (ch 0=L,1=R) at source offset 'base': window the
  // gain-weighted stem sum (× pcmScale), FFT, fill pvMag/pvPh for bins 0..N/2.
  pvSpectrum(ch, base) {
    const N = this.pvN, win = this.pvWin, re = this.fre, im = this.fim, scale = this.pcmScale;
    const src = ch === 0 ? this.gL : this.gR, len = this.length, nG = this.nG;
    for (let i = 0; i < N; i++) {
      const si = base + i; let acc = 0;
      if (si >= 0 && si < len) { for (let g = 0; g < nG; g++) { const ga = this.gain_[g]; if (ga) acc += ga * src[g][si]; } }
      re[i] = win[i] * acc * scale; im[i] = 0;
    }
    this.fft(re, im, false);
    const bins = (N >> 1) + 1, mag = this.pvMag, ph = this.pvPh;
    for (let k = 0; k < bins; k++) { const rr = re[k], ii = im[k]; mag[k] = Math.sqrt(rr * rr + ii * ii); ph[k] = Math.atan2(ii, rr); }
  }
  // Phase-locked synthesis for one channel: propagate the synthesis phase at each
  // spectral PEAK (true-frequency estimate via phase unwrapping), then LOCK every
  // other bin's phase to its nearest peak preserving the analysis-frame phase
  // relationship (Laroche-Dolson identity locking). On a transient / first frame,
  // reset the synthesis phase to the analysis phase (keeps attacks sharp). Builds
  // the synthesis spectrum into fre/fim, iFFTs, and OLAs into 'ola'.
  pvSynth(prevPh, sumPh, ola, transient, Ra) {
    const N = this.pvN, Rs = this.Rs, bins = (N >> 1) + 1;
    const mag = this.pvMag, ph = this.pvPh, re = this.fre, im = this.fim, om = this.omega;
    const TWO = 2 * Math.PI;
    if (this.pvInit && !transient) {
      const peaks = this.pvPeak; let np = 0;
      // peaks = bins that dominate their ±2 neighbourhood (the partials)
      for (let k = 2; k < bins - 2; k++) { const m = mag[k]; if (m > mag[k - 1] && m > mag[k - 2] && m > mag[k + 1] && m > mag[k + 2]) peaks[np++] = k; }
      if (np === 0) { for (let k = 0; k < bins; k++) sumPh[k] = ph[k]; }
      else {
        // advance each peak's synthesis phase by Rs · instantaneous frequency
        for (let pidx = 0; pidx < np; pidx++) {
          const p = peaks[pidx];
          let dphi = ph[p] - prevPh[p] - Ra * om[p];
          dphi = dphi - TWO * Math.round(dphi / TWO);   // principal value (-π..π)
          sumPh[p] += Rs * (om[p] + dphi / Ra);
        }
        // lock every bin to its nearest peak (region of influence)
        let pi = 0;
        for (let k = 0; k < bins; k++) {
          while (pi + 1 < np && Math.abs(peaks[pi + 1] - k) <= Math.abs(peaks[pi] - k)) pi++;
          const p = peaks[pi];
          if (k !== p) sumPh[k] = sumPh[p] + (ph[k] - ph[p]);
        }
      }
    } else {
      for (let k = 0; k < bins; k++) sumPh[k] = ph[k];   // init / transient → phase reset
    }
    prevPh.set(ph);
    // magnitude · e^{i·synthesisPhase}, then Hermitian-mirror to the upper half
    for (let k = 0; k < bins; k++) { const m = mag[k], a = sumPh[k]; re[k] = m * Math.cos(a); im[k] = m * Math.sin(a); }
    for (let k = 1; k < (N >> 1); k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    this.fft(re, im, true);
    const win = this.pvWin, norm = this.pvNorm;
    for (let i = 0; i < N; i++) ola[i] += re[i] * win[i] / norm;
  }
  // One PV synthesis frame: emit Rs stretched samples to the FIFO, advance the
  // drift-free clock by Ra (= Rs·speed/pitch). Mirrors grain() in the transport.
  pvFrame(Ra) {
    if (this.loopActive && this.loopEnd > this.loopStart && this.idealPos >= this.loopEnd) {
      const len = this.loopEnd - this.loopStart;
      this.idealPos -= len; this.pvInit = false; // phase-reset across the loop seam
    }
    if (!this.loopActive && this.idealPos >= this.length) { this.markEnded(); return; }
    const N = this.pvN, Rs = this.Rs, bins = (N >> 1) + 1;
    const base = Math.round(this.idealPos);
    // L: forward STFT → transient decision (HF-weighted magnitude flux vs EMA) → synth
    this.pvSpectrum(0, base);
    let flux = 0; const pm = this.pvPrevMag;
    for (let k = 0; k < bins; k++) { const d = this.pvMag[k] - pm[k]; if (d > 0) flux += d * d; pm[k] = this.pvMag[k]; }
    const ema = this.pvEMA;
    const transient = this.transientOn && ema > 1e-9 && flux > this.tThresh * ema && flux > 1e-7;
    this.pvEMA = ema + 0.3 * (flux - ema);
    this.pvSynth(this.prevPhL, this.sumPhL, this.pvOlaL, transient, Ra);
    // R: same transient decision (kept in lock-step with L so the stereo image holds)
    this.pvSpectrum(1, base);
    this.pvSynth(this.prevPhR, this.sumPhR, this.pvOlaR, transient, Ra);
    // emit the first Rs (now-complete) OLA samples, shift the accumulators down
    const olaL = this.pvOlaL, olaR = this.pvOlaR;
    for (let i = 0; i < Rs; i++) { const w = this.wHead & RMASK; this.ringL[w] = olaL[i]; this.ringR[w] = olaR[i]; this.wHead++; }
    olaL.copyWithin(0, Rs, N); olaL.fill(0, N - Rs, N);
    olaR.copyWithin(0, Rs, N); olaR.fill(0, N - Rs, N);
    this.idealPos += Ra;
    this.grainStart = base; this.naturalNext = base + Rs;
    this.pvInit = true;
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
  // Windowed-sinc table for anti-aliased resampling (Smith, CCRMA "Digital Audio
  // Resampling Home Page"): ideal bandlimited interpolation h(t)=c·sinc(c·t) with
  // c=min(1,1/gamma). Sampled at sRES points per zero-crossing over sZ crossings,
  // Blackman-windowed, read with linear table interpolation.
  buildSinc() {
    const Z = 8, RES = 512;
    this.sZ = Z; this.sRES = RES;
    const n = Z * RES + 2;
    const T = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const u = k / RES;                         // 0 .. Z (zero crossings)
      const x = Math.PI * u;
      const s = k === 0 ? 1 : Math.sin(x) / x;   // sinc
      const w = u <= Z ? 0.42 + 0.5 * Math.cos(Math.PI * u / Z) + 0.08 * Math.cos(2 * Math.PI * u / Z) : 0;
      T[k] = s * w;
    }
    this.sinc = T;
  }
  // Anti-aliased fractional read at pos with cutoff factor c (=1/gamma < 1). Sums
  // windowed-sinc taps over ±sZ/c FIFO samples; cutoff AND gain scale by c (Smith).
  sincRing(buf, pos, c) {
    const RES = this.sRES, T = this.sinc, last = T.length - 1;
    const supp = this.sZ / c;
    const iL = Math.ceil(pos - supp), iR = Math.floor(pos + supp);
    let acc = 0;
    for (let nn = iL; nn <= iR; nn++) {
      const arg = Math.abs((pos - nn) * c) * RES;
      const k = arg | 0;
      if (k >= last) continue;
      acc += buf[nn & RMASK] * (T[k] + (T[k + 1] - T[k]) * (arg - k));
    }
    return acc * c;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const frames = out[0].length;
    const outL = out[0], outR = out.length > 1 ? out[1] : out[0];
    // Stem taps: outputs[1..4] = DRUM/BASS/VOICE/INST, present only when the host built the node
    // with five outputs AND switched taps on. Zeroed up front so every early-out below (not
    // loaded, muted, FIFO dry) silences them along with the main pair, instead of leaving the
    // previous quantum's samples behind in a buffer the graph reuses.
    const tapped = this.taps && !!this.tapRingL && outputs.length > 4;
    const tOut = tapped ? [outputs[1], outputs[2], outputs[3], outputs[4]] : null;
    if (tapped) for (let g = 0; g < 4; g++) { const o = tOut[g]; if (o && o.length) { o[0].fill(0); if (o.length > 1) o[1].fill(0); } }
    if (!this.loaded) { outL.fill(0); if (out.length > 1) outR.fill(0); return true; }

    // glide speed/pitch toward their targets (de-zipper) — was the AudioParam ramp
    this.speed += (this.speedTarget - this.speed) * this.kParam;
    this.pitch += (this.pitchTarget - this.pitch) * this.kParam;
    const speed = this.speed, pitch = this.pitch;
    // analysis hop = synthesisHop · speed/pitch (β = pitch/speed → hop_a = hop_s/β).
    // WSOLA synthesis hop = HS; the phase-locked vocoder's = Rs. Same drift-free
    // clock either way; the engine flag just picks which producer fills the FIFO.
    // ⚠ Taps force WSOLA. The PV sums the groups before its FFT by design (one FFT per frame at
    // any stem count); per-stem taps there would mean four FFTs per frame — a real cost, not a
    // refactor. So while any stem-routed chain is live the producer is WSOLA, and the host is told
    // rather than left wondering why the engine setting stopped taking.
    const pv = this.engineMode === 'pv' && !!this.pvWin && !this.taps;
    const synHop = pv ? this.Rs : this.HS;
    const Aa = synHop * speed / pitch;
    const gamma = pitch;             // resample ratio
    // Pitch-UP reads the FIFO faster than 1× → aliasing; switch to the windowed-sinc
    // reader (cutoff c=1/gamma). Pitch-down/unity have no aliasing → keep the cheap
    // cubic. need is the lookahead the active reader requires past rHead.
    const aa = this.aaOn && gamma > 1.0001;
    const c = aa ? 1 / gamma : 1;
    const supp = aa ? this.sZ / c : 0; // sinc half-support, in FIFO samples
    const need = supp + gamma + 2;

    for (let i = 0; i < frames; i++) {
      // Pending declick-seek: fade out FAST, then reset the playhead at silence and fade
      // back in — a click-free cue/loop jump (no FIFO discontinuity at audible gain).
      if (this.seekPending >= 0) {
        this.gain += (0 - this.gain) * this.kSeek;
        if (this.gain < 0.02) { this.reset(this.seekPending); this.playing = true; this.gainTarget = 1; }
      } else {
        this.gain += (this.gainTarget - this.gain) * this.kGain;
      }
      if (!this.playing && this.gain < 1e-4) { outL[i] = 0; outR[i] = 0; continue; }
      let guard = 0;
      while (this.wHead - this.rHead < need) {
        if (this.ended) break;
        if (pv) this.pvFrame(Aa); else this.grain(Aa);
        if (++guard > 64) break; // safety: never spin forever in the audio thread
      }
      const avail = this.wHead - this.rHead;
      if (avail < 2) {
        // FIFO ran dry mid-playback = a real audible dropout (the producer couldn't refill
        // inside this quantum — the symptom a wireless clock's bursty callbacks cause). Count
        // it, but NOT during a seek reset / end-of-track, so the host adapts to true skips only.
        if (this.playing && !this.ended && this.seekPending < 0) this.underruns++;
        outL[i] = 0; outR[i] = 0; continue;
      }
      // sinc only while its full support is buffered; cubic otherwise (drain tail)
      const useAa = aa && avail > supp + 1;
      const l = useAa ? this.sincRing(this.ringL, this.rHead, c) : this.cubicRing(this.ringL, this.rHead);
      const r = useAa ? this.sincRing(this.ringR, this.rHead, c) : this.cubicRing(this.ringR, this.rHead);
      outL[i] = l * this.gain; outR[i] = r * this.gain;
      if (tapped) {
        // Same reader, same cursor, same declick gain — so sum(taps) == main, sample for sample.
        for (let g = 0; g < 4; g++) {
          const o = tOut[g]; if (!o || !o.length) continue;
          const sl = useAa ? this.sincRing(this.tapRingL[g], this.rHead, c) : this.cubicRing(this.tapRingL[g], this.rHead);
          o[0][i] = sl * this.gain;
          if (o.length > 1) o[1][i] = (useAa ? this.sincRing(this.tapRingR[g], this.rHead, c) : this.cubicRing(this.tapRingR[g], this.rHead)) * this.gain;
        }
      }
      this.rHead += gamma;
    }
    // Pre-roll headroom: with a reserve configured (host raises it during on-device stem
    // separation), produce a BOUNDED number of grains ahead so a CPU-pressured quantum
    // outputs from the reserve without running the WSOLA/PV search — process() stays cheap
    // and finishes inside its budget instead of glitching each separation segment. Capped
    // per block so building the reserve never itself spikes the audio thread; skipped while
    // a declick-seek is fading out (about to reset the FIFO).
    if (this.reserve > 0 && this.playing && !this.ended && this.seekPending < 0) {
      let ahead = 0;
      while (this.wHead - this.rHead < need + this.reserve && ahead < 4) {
        if (pv) this.pvFrame(Aa); else this.grain(Aa);
        if (this.ended) break;
        ahead++;
      }
    }
    // TEMP iPhone diagnostics: report live state ~4×/s so the UI can show why a deck
    // is (not) sounding — loaded? playing? FIFO filling? output actually non-zero?
    if ((++this.diagN % 12) === 0) {
      let pk = 0;
      for (let i = 0; i < frames; i++) { const a = outL[i] < 0 ? -outL[i] : outL[i]; if (a > pk) pk = a; }
      this.port.postMessage({
        type: 'diag', loaded: this.loaded, playing: this.playing, ended: this.ended,
        nG: this.nG, len: this.length, fifo: this.wHead - this.rHead,
        ideal: Math.round(this.idealPos), peak: pk, gain: this.gain,
        underruns: this.underruns,
      });
    }
    return true;
  }
}
registerProcessor('stretch', Stretch);
`;
