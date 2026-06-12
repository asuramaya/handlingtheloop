// Pro parametric EQ for a deck channel. A series chain of biquads, each a movable
// node in the curve UI:
//
//   input → HP-cut → low-shelf → mid-bell → high-shelf → LP-cut → output
//
// Shelves/bell carry gain (+ movable frequency, + Q on the bell); the HP/LP cuts
// carry a movable cutoff + resonance (Q). The band identities low/mid/high are kept
// so channel reset and room-sync map 1:1. `input`/`output` are plain gain nodes so
// the whole EQ can be re-routed for two extra modes:
//   • SOLO (audition): feed input straight through a bandpass to output, so you hear
//     just one band's frequency region while you hunt for the problem spot.
//   • BYPASS: feed input straight to output (compare with the EQ out of circuit).

export const EQ_MIN_DB = -26;
export const EQ_MAX_DB = 6;

// Movable band frequencies (Hz) + travel range. Defaults match the classic layout.
export const EQ_BANDS = {
  low: { freq: 200, min: 40, max: 500 },
  mid: { freq: 1000, min: 200, max: 6000 },
  high: { freq: 3200, min: 1500, max: 16000 },
} as const;

// Cut filters sit "off" at the spectrum extremes until dragged inward.
export const EQ_HP = { freq: 20, min: 20, max: 2200, q: 0.7 } as const;
export const EQ_LP = { freq: 20000, min: 320, max: 20000, q: 0.7 } as const;
export const EQ_Q_MIN = 0.3;
export const EQ_Q_MAX = 12;

export type EqRoute = "normal" | "solo" | "bypass";

export class Eq3 {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly pre: GainNode; // routing branch point (input → pre → chain/solo/output)
  private readonly hp: BiquadFilterNode; // low-cut (high-pass)
  private readonly low: BiquadFilterNode;
  private readonly mid: BiquadFilterNode;
  private readonly high: BiquadFilterNode;
  private readonly lp: BiquadFilterNode; // high-cut (low-pass)
  private readonly soloNode: BiquadFilterNode; // audition bandpass
  private route: EqRoute = "normal";
  // Scratch buffers for getFrequencyResponse, grown to the query length.
  private mag?: Float32Array<ArrayBuffer>;
  private phase?: Float32Array<ArrayBuffer>;

  constructor(ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.pre = ctx.createGain();
    // input → pre is permanent so external taps on `input` (e.g. the deck's pre-EQ
    // spectrum analyser) survive route changes; only `pre`'s output is re-routed.
    this.input.connect(this.pre);

    this.hp = ctx.createBiquadFilter();
    this.hp.type = "highpass";
    this.hp.frequency.value = EQ_HP.freq;
    this.hp.Q.value = EQ_HP.q;

    this.low = ctx.createBiquadFilter();
    this.low.type = "lowshelf";
    this.low.frequency.value = EQ_BANDS.low.freq;

    this.mid = ctx.createBiquadFilter();
    this.mid.type = "peaking";
    this.mid.frequency.value = EQ_BANDS.mid.freq;
    this.mid.Q.value = 0.9;

    this.high = ctx.createBiquadFilter();
    this.high.type = "highshelf";
    this.high.frequency.value = EQ_BANDS.high.freq;

    this.lp = ctx.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.frequency.value = EQ_LP.freq;
    this.lp.Q.value = EQ_LP.q;

    this.soloNode = ctx.createBiquadFilter();
    this.soloNode.type = "bandpass";
    this.soloNode.Q.value = 4;

    // Series EQ chain into the output; the solo bandpass also feeds the output but
    // only carries signal when the input is routed into it (see applyRoute).
    this.hp.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.lp);
    this.lp.connect(this.output);
    this.soloNode.connect(this.output);
    this.applyRoute();
  }

  private applyRoute() {
    this.pre.disconnect();
    if (this.route === "bypass") this.pre.connect(this.output);
    else if (this.route === "solo") this.pre.connect(this.soloNode);
    else this.pre.connect(this.hp);
  }

  get routeMode(): EqRoute {
    return this.route;
  }
  private setRoute(r: EqRoute) {
    if (this.route === r) return;
    this.route = r;
    this.applyRoute();
  }
  /** Audition one band: route the channel through a bandpass at `hz` (Q for width). */
  solo(hz: number, q = 4) {
    this.soloNode.frequency.value = hz;
    this.soloNode.Q.value = q;
    this.setRoute("solo");
  }
  clearSolo() {
    if (this.route === "solo") this.setRoute("normal");
  }
  setBypass(on: boolean) {
    this.setRoute(on ? "bypass" : "normal");
  }
  get bypassed() {
    return this.route === "bypass";
  }

  // --- band gains (dB) ---
  setLow(db: number) {
    this.low.gain.value = clampDb(db);
  }
  setMid(db: number) {
    this.mid.gain.value = clampDb(db);
  }
  setHigh(db: number) {
    this.high.gain.value = clampDb(db);
  }

  // --- band frequencies (Hz) ---
  setLowFreq(hz: number) {
    this.low.frequency.value = clampHz(hz, EQ_BANDS.low);
  }
  setMidFreq(hz: number) {
    this.mid.frequency.value = clampHz(hz, EQ_BANDS.mid);
  }
  setHighFreq(hz: number) {
    this.high.frequency.value = clampHz(hz, EQ_BANDS.high);
  }
  get lowFreq() {
    return this.low.frequency.value;
  }
  get midFreq() {
    return this.mid.frequency.value;
  }
  get highFreq() {
    return this.high.frequency.value;
  }

  // --- mid bell width ---
  setMidQ(q: number) {
    this.mid.Q.value = clampQ(q);
  }
  get midQ() {
    return this.mid.Q.value;
  }

  // --- HP / LP cut filters (cutoff + resonance) ---
  setHpFreq(hz: number) {
    this.hp.frequency.value = clampHz(hz, EQ_HP);
  }
  setHpQ(q: number) {
    this.hp.Q.value = clampQ(q);
  }
  get hpFreq() {
    return this.hp.frequency.value;
  }
  get hpQ() {
    return this.hp.Q.value;
  }
  setLpFreq(hz: number) {
    this.lp.frequency.value = clampHz(hz, EQ_LP);
  }
  setLpQ(q: number) {
    this.lp.Q.value = clampQ(q);
  }
  get lpFreq() {
    return this.lp.frequency.value;
  }
  get lpQ() {
    return this.lp.Q.value;
  }

  /** Flat: all gains 0, every node back to default freq/Q, cuts parked off-screen. */
  reset() {
    this.setLow(0);
    this.setMid(0);
    this.setHigh(0);
    this.low.frequency.value = EQ_BANDS.low.freq;
    this.mid.frequency.value = EQ_BANDS.mid.freq;
    this.high.frequency.value = EQ_BANDS.high.freq;
    this.mid.Q.value = 0.9;
    this.hp.frequency.value = EQ_HP.freq;
    this.hp.Q.value = EQ_HP.q;
    this.lp.frequency.value = EQ_LP.freq;
    this.lp.Q.value = EQ_LP.q;
    this.setBypass(false);
  }

  /** Combined magnitude (dB) at each frequency in `freqHz`, into `outDb` — the real
   *  response of all five biquads, summed in the dB domain. */
  magnitude(freqHz: Float32Array, outDb: Float32Array) {
    const n = freqHz.length;
    if (!this.mag || this.mag.length !== n) {
      this.mag = new Float32Array(n);
      this.phase = new Float32Array(n);
    }
    outDb.fill(0);
    const f = freqHz as Float32Array<ArrayBuffer>;
    for (const band of [this.hp, this.low, this.mid, this.high, this.lp]) {
      band.getFrequencyResponse(f, this.mag, this.phase!);
      for (let i = 0; i < n; i++) outDb[i] += 20 * Math.log10(this.mag[i] || 1e-6);
    }
  }
}

function clampDb(db: number): number {
  return Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, db));
}
function clampHz(hz: number, band: { min: number; max: number }): number {
  return Math.max(band.min, Math.min(band.max, hz));
}
function clampQ(q: number): number {
  return Math.max(EQ_Q_MIN, Math.min(EQ_Q_MAX, q));
}
