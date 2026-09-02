// AudioWorklet source for the DYNAMICS processor (COMP) — the machine the rest of the stack has
// been missing. Web Audio ships a DynamicsCompressorNode, but it is a dead end for character: no
// makeup, no sidechain input, no lookahead, a detector you can't choose and a release you can't
// shape. A compressor's identity IS its detector topology and its ballistics, so it has to be a
// worklet with a real single-sample loop.
//
//   sidechain (internal or EXTERNAL) → SC high-pass → SC low-pass → detector (peak | RMS)
//        → gain computer (log domain, soft knee) → ballistics (attack / release, program-dependent)
//        → gain, applied to the LOOKAHEAD-delayed audio → makeup
//
// Four MODES, which are four sets of ballistics rather than four algorithms:
//   GLUE  — VCA feed-forward, RMS-ish detector, the auto-release that makes a mix cohere (SSL G).
//   FET   — peak detector, microsecond attack, grabby, adds its own bite (an 1176).
//   OPTO  — fixed attack, TWO-STAGE program-dependent release: fast at first, then long. The
//           gentle one; it never sounds like it's working (an LA-2A).
//   LIMIT — brickwall. Lookahead lets it see the peak coming and duck BEFORE it lands, so the
//           ceiling is a real ceiling, not a hope. This mode is also what sits on the master bus.
//
// The SIDECHAIN HIGH-PASS is not a garnish — without it a kick drum pumps the entire track and the
// whole thing sounds like a pumping mess. That single filter is most of why a buss comp works.
// The LOW-PASS beside it is the same idea for the other end: a hi-hat wash or a sibilant vocal can
// trigger the detector just as uselessly as a kick's boom — a real band, not a highpass alone.
//
// Params ride PORT MESSAGES, never AudioParams (iOS Safari kills worklets whose
// parameterDescriptors fail to register — the project-wide rule). Gain reduction is posted BACK
// over the same port, because a compressor you can't see is a compressor you can't set.
export const COMP_WORKLET_SRC = `
const DB = 8.6858896380650366; // 20/ln(10) — dB per neper, so we can do the log domain with Math.log

class Comp extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 0;        // 0 GLUE, 1 FET, 2 OPTO, 3 LIMIT
    this.threshold = -18; // dB
    this.ratio = 4;
    this.attackMs = 10;
    this.releaseMs = 250;
    this.knee = 6;        // dB, soft-knee width
    this.makeupDb = 0;
    this.auto = 1;        // auto makeup + (GLUE/OPTO) program-dependent release
    this.scHz = 0;        // sidechain high-pass (0 = off)
    this.scLoHz = 20000;  // sidechain low-pass — parked at the top (near-transparent), same
                           // "no special off state" convention as Delay/Reverb's own LP cut
    this.scExt = 0;       // 1 = detect from the EXTERNAL sidechain input, not the audio
    this.lookMs = 0;      // lookahead (ms)
    this.ceilingDb = -0.3;// LIMIT: the brickwall

    // ★ Two values that a MODE change moves instantly, and that a splice lives in if you let it:
    this.lookNow = 0;     // the lookahead the READ POINTER is actually using, in fractional samples
    this.makeupS = -1;    // slewed makeup gain (linear); −1 = "not primed yet", see process()
    this.envDb = 0;       // the smoothed gain reduction, in dB (≤ 0)
    this.rms = 0;         // RMS detector state
    this.scHpZ = [0, 0];  // one-pole HP state, per channel
    this.scLpZ = [0, 0];  // one-pole LP state, per channel — in series AFTER the HP
    this.optoSlow = 0;    // OPTO's second (slow) release stage
    // Lookahead ring — sized for the max lookahead we allow (10 ms at any sane rate).
    this.ringLen = Math.max(64, Math.ceil(sampleRate * 0.01) + 128);
    this.ring = [new Float32Array(this.ringLen), new Float32Array(this.ringLen)];
    this.ringW = 0;
    this.grMax = 0;       // worst GR since the last meter post (for the needle)
    this.metCnt = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      for (const k of ["mode","threshold","ratio","attackMs","releaseMs","knee","makeupDb","auto","scHz","scLoHz","scExt","lookMs","ceilingDb"]) {
        if (d[k] !== undefined) this[k] = d[k];
      }
    };
  }

  // Gain computer: how much reduction (dB, ≤ 0) this input level should get. Soft knee is the
  // standard quadratic interpolation across the knee width, so the ratio eases in instead of
  // switching on — which is the difference between "compressed" and "audibly compressing".
  computeGr(levelDb) {
    const mode = this.mode;
    const ratio = mode === 3 ? 1000 : this.ratio;      // LIMIT: effectively ∞:1
    const thr = mode === 3 ? this.ceilingDb : this.threshold;
    const knee = mode === 3 ? 1 : this.knee;           // LIMIT wants a hard corner
    const over = levelDb - thr;
    const slope = 1 / ratio - 1;                       // ≤ 0
    if (over <= -knee / 2) return 0;
    if (over >= knee / 2) return slope * over;
    const x = over + knee / 2;
    return (slope * x * x) / (2 * knee);               // quadratic knee
  }

  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0];
    if (!inp || inp.length === 0 || !out || out.length === 0) return true;
    const ch = Math.min(inp.length, out.length);
    const n = out[0].length;
    const sr = sampleRate;

    // The DETECTOR's source: the audio itself, or the external sidechain when one is patched in
    // (deck B ducking deck A, or the mic ducking the music).
    const scIn = inputs[1];
    const sc = this.scExt && scIn && scIn.length ? scIn : inp;

    const mode = this.mode;
    // Ballistics per mode. These timings ARE the character.
    let atkMs = this.attackMs;
    let relMs = this.releaseMs;
    if (mode === 1) atkMs = Math.min(atkMs, 0.8);      // FET — microseconds, it grabs transients
    if (mode === 2) { atkMs = 10; }                    // OPTO — fixed attack; the cell has no choice
    if (mode === 3) { atkMs = Math.min(atkMs, 0.5); }  // LIMIT — the lookahead covers the attack
    const atkC = Math.exp(-1 / (sr * Math.max(1e-5, atkMs / 1000)));

    // SC high-pass + low-pass coefficients (one-pole each, in series — the sidechain gets an
    // actual band, not a highpass alone).
    const hpC = this.scHz > 0 ? Math.exp((-2 * Math.PI * this.scHz) / sr) : 0;
    const lpC = Math.exp((-2 * Math.PI * this.scLoHz) / sr);

    // Auto makeup: give back roughly the gain the threshold+ratio will take away at a typical
    // programme level, so switching the comp in doesn't just make everything quieter.
    const makeup = this.auto
      ? this.makeupDb + -this.threshold * (1 - 1 / this.ratio) * 0.55
      : this.makeupDb;
    const makeupLin = Math.exp((mode === 3 ? this.makeupDb : makeup) / DB);

    const look = Math.min(0.01, Math.max(0, this.lookMs / 1000));
    const lookN = look * sr; // fractional on purpose — this.lookNow WALKS toward it, see below
    // ★ THE LOOKAHEAD IS A DELAY LINE, AND A DELAY LINE'S LENGTH CANNOT JUMP.
    // MODE posts its own ballistics, and GLUE→LIMIT takes lookMs 0 → 1.5, which moved the ring's
    // read pointer 72 samples in one sample: a splice, straight into the output, on a control
    // whose entire job is to make the sound MORE controlled (fxlab --live-audit: ×25 the median
    // step, both directions). The read position walks instead, at 1/256 of a sample per sample —
    // 1.5 ms of travel takes ~0.4 s and deviates the pitch by 0.4%, which is nothing, and the
    // ring is read with linear interpolation so the walk itself is smooth.
    const lookStep = 1 / 256;
    // …and the same for MAKEUP: auto-makeup is derived from threshold and ratio, so a mode change
    // moves it several dB at once. A gain step IS a click, however good the reason for it.
    const mkC = Math.exp(-1 / (sr * 0.02)); // ~20 ms
    if (this.makeupS < 0) this.makeupS = makeupLin; // first block: land on it, don't ramp from 0

    for (let i = 0; i < n; i++) {
      // ---- detect ----------------------------------------------------------
      let d = 0;
      for (let c = 0; c < sc.length; c++) {
        let x = sc[c][i] || 0;
        if (hpC > 0) {
          // one-pole high-pass: y = x − lowpass(x). The kick stops driving the whole mix.
          const z = this.scHpZ[c] || 0;
          const lp = x * (1 - hpC) + z * hpC;
          this.scHpZ[c] = lp;
          x = x - lp;
        }
        // one-pole low-pass, in series after the high-pass — a hi-hat/cymbal wash stops
        // triggering the detector the way an open kick's low end stops triggering it above.
        const zl = this.scLpZ[c] || 0;
        const lpx = x * (1 - lpC) + zl * lpC;
        this.scLpZ[c] = lpx;
        x = lpx;
        const a = Math.abs(x);
        if (a > d) d = a;
      }
      // GLUE and OPTO detect on an RMS-ish average — that's why they sound like they're riding
      // the music instead of chasing every transient. FET and LIMIT are peak.
      let det = d;
      if (mode === 0 || mode === 2) {
        const rc = Math.exp(-1 / (sr * 0.01)); // 10 ms RMS window
        this.rms = d * d * (1 - rc) + this.rms * rc;
        det = Math.sqrt(this.rms);
      }
      const levelDb = det > 1e-7 ? Math.log(det) * DB : -140;

      // ---- gain computer + ballistics --------------------------------------
      const target = this.computeGr(levelDb); // ≤ 0 dB

      // RELEASE is where the character lives.
      let rMs = relMs;
      if (mode === 0 && this.auto) {
        // GLUE auto-release: the deeper it's working, the slower it lets go. That lag is the
        // "glue" — the comp stops breathing in time with the music and just holds it together.
        rMs = 120 + 900 * Math.min(1, Math.abs(this.envDb) / 10);
      } else if (mode === 2) {
        // OPTO: two stages. A fast one recovers the first few dB quickly, a slow one drags the
        // rest back over seconds. Program-dependent by construction, never quite the same twice.
        this.optoSlow += (Math.abs(this.envDb) - this.optoSlow) * 0.00002;
        rMs = 60 + 2400 * Math.min(1, this.optoSlow / 6);
      } else if (mode === 3) {
        rMs = Math.max(relMs, 50);
      }
      const relC = Math.exp(-1 / (sr * Math.max(1e-4, rMs / 1000)));

      // Smooth in the dB domain: attack when we need MORE reduction, release when less.
      const coef = target < this.envDb ? atkC : relC;
      this.envDb = target + (this.envDb - target) * coef;

      this.makeupS = makeupLin + (this.makeupS - makeupLin) * mkC;
      const g = Math.exp(this.envDb / DB) * this.makeupS;
      if (-this.envDb > this.grMax) this.grMax = -this.envDb;

      // ---- apply to the LOOKAHEAD-delayed audio ----------------------------
      // The detector sees the sample NOW; the output is playing one lookahead ago. So the gain is
      // already down by the time the peak arrives — which is the whole trick of a brickwall.
      const dl = lookN - this.lookNow;
      this.lookNow += dl > lookStep ? lookStep : dl < -lookStep ? -lookStep : dl;
      const L = this.ringLen;
      const rp = this.ringW - this.lookNow;
      const ri = Math.floor(rp);
      const rf = rp - ri;
      const r0 = ((ri % L) + L) % L;
      const r1 = (r0 + 1) % L;
      for (let c = 0; c < ch; c++) {
        const ring = this.ring[c];
        ring[this.ringW] = inp[c] ? inp[c][i] : 0;
        let y = (this.lookNow > 0.0001 ? ring[r0] + (ring[r1] - ring[r0]) * rf : ring[this.ringW]) * g;
        // LIMIT is a guarantee, not a suggestion: whatever slipped past the detector gets clamped.
        if (mode === 3) {
          const ceil = Math.exp(this.ceilingDb / DB);
          if (y > ceil) y = ceil;
          else if (y < -ceil) y = -ceil;
        }
        out[c][i] = y;
      }
      this.ringW = (this.ringW + 1) % this.ringLen;
    }

    // Post the worst gain reduction of the last ~85 ms back to the UI. A compressor you can't see
    // is a compressor you can't set — the needle IS the interface.
    if (++this.metCnt >= 8) {
      this.port.postMessage({ gr: this.grMax });
      this.grMax = 0;
      this.metCnt = 0;
    }
    return true;
  }
}
registerProcessor('comp', Comp);
`;
