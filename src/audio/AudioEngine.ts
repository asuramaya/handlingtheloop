import { Deck } from "./Deck";

// Master audio graph:
//
//   Deck A.output --> xfadeA --\
//                                >--> master --> destination
//   Deck B.output --> xfadeB --/
//
// The crossfader uses an equal-power curve so the perceived loudness stays
// roughly constant across the sweep (no dip in the middle).

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly deckA: Deck;
  readonly deckB: Deck;

  private readonly xfadeA: GainNode;
  private readonly xfadeB: GainNode;
  private readonly master: GainNode;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });

    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    this.xfadeA = this.ctx.createGain();
    this.xfadeB = this.ctx.createGain();
    this.xfadeA.connect(this.master);
    this.xfadeB.connect(this.master);

    this.deckA = new Deck(this.ctx);
    this.deckB = new Deck(this.ctx);
    this.deckA.output.connect(this.xfadeA);
    this.deckB.output.connect(this.xfadeB);

    this.setCrossfade(0);
  }

  /** Browsers start the context suspended until a user gesture. */
  resume() {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  deck(id: "A" | "B"): Deck {
    return id === "A" ? this.deckA : this.deckB;
  }

  /** position in [-1, 1]: -1 = full A, 0 = both, +1 = full B. */
  setCrossfade(position: number) {
    const x = (Math.max(-1, Math.min(1, position)) + 1) / 2; // -> [0,1]
    this.xfadeA.gain.value = Math.cos((x * Math.PI) / 2);
    this.xfadeB.gain.value = Math.cos(((1 - x) * Math.PI) / 2);
  }

  setMaster(gain: number) {
    this.master.gain.value = gain;
  }
}
