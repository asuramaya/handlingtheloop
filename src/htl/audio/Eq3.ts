// Three-band DJ-style EQ: low shelf / mid peaking / high shelf.
// Gains run from full "kill" (-26 dB, effectively silent) up to +6 dB boost,
// matching the feel of a rekordbox / club mixer channel strip.

export const EQ_MIN_DB = -26;
export const EQ_MAX_DB = 6;

export class Eq3 {
  readonly input: BiquadFilterNode;
  readonly output: BiquadFilterNode;
  private readonly low: BiquadFilterNode;
  private readonly mid: BiquadFilterNode;
  private readonly high: BiquadFilterNode;

  constructor(ctx: AudioContext) {
    this.low = ctx.createBiquadFilter();
    this.low.type = "lowshelf";
    this.low.frequency.value = 200;

    this.mid = ctx.createBiquadFilter();
    this.mid.type = "peaking";
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.8;

    this.high = ctx.createBiquadFilter();
    this.high.type = "highshelf";
    this.high.frequency.value = 3200;

    this.low.connect(this.mid);
    this.mid.connect(this.high);

    this.input = this.low;
    this.output = this.high;
  }

  /** db in [EQ_MIN_DB, EQ_MAX_DB] per band. */
  setLow(db: number) {
    this.low.gain.value = clampDb(db);
  }
  setMid(db: number) {
    this.mid.gain.value = clampDb(db);
  }
  setHigh(db: number) {
    this.high.gain.value = clampDb(db);
  }
}

function clampDb(db: number): number {
  return Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, db));
}
