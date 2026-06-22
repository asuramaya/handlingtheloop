import type { AudioEngine, DeckId } from "@htl/audio";
import type { MidiEvent } from "@htl/midi";

// An Xbox / W3C "standard"-mapping gamepad as a DJ control surface. It does NOT touch the
// decks directly — it emits the SAME MidiEvent stream the MIDI layer produces, fed into
// App's onMidiEvent. So it inherits focus, shift, room-sync, velocity, the jog/scratch model
// and the room-control gate for free; nothing downstream knows a gamepad exists.
//
// Layout (standard mapping):
//   A B X Y            → hot cues 1-4 on the FOCUSED deck
//   LB / RB            → play/pause Deck A / Deck B
//   LT / RT (analog)   → the crossfader (push toward A / B; springs to centre on release)
//   Left / Right stick → scratch Deck A / Deck B (deflect = grab + spin, recentre = let go)
//   D-pad ←/→          → focus Deck A / B     D-pad ↑/↓ → beat-jump fwd / back (focused)
//   View / Menu        → SYNC / KEY-match (focused)
//   L3 / R3            → spinback / cue (focused)
//   …and the pad RUMBLES on every beat of the deck you're driving (harder on the bar line).

export interface GamepadStatus {
  connected: boolean;
  id: string | null;
}

interface GamepadOpts {
  engine: AudioEngine;
  getFocused: () => DeckId;
  onEvent: (e: MidiEvent) => void;
  onStatus?: (s: GamepadStatus) => void;
  getEnabled?: () => boolean;
}

// Standard-mapping button indices.
const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7,
  VIEW = 8, MENU = 9, L3 = 10, R3 = 11, DUP = 12, DDOWN = 13, DLEFT = 14, DRIGHT = 15;

const DEAD = 0.18; // stick deadzone (fraction)
const TRIG_DEAD = 0.06; // trigger engage threshold
const SCRATCH_GAIN = 5; // jog ticks per frame at full stick deflection

// Press-edge buttons → a control action. Deckless actions drive the FOCUSED deck (App resolves
// `deck ?? focused`); LB/RB name their own deck so each bumper plays its side.
const PRESS: Record<number, { action: string; deck?: DeckId }> = {
  [A]: { action: "hotcue1" },
  [B]: { action: "hotcue2" },
  [X]: { action: "hotcue3" },
  [Y]: { action: "hotcue4" },
  [LB]: { action: "play", deck: "A" },
  [RB]: { action: "play", deck: "B" },
  [VIEW]: { action: "sync" },
  [MENU]: { action: "keyMatch" },
  [L3]: { action: "spinback" },
  [R3]: { action: "cue" },
  [DUP]: { action: "jogFwd" },
  [DDOWN]: { action: "jogBack" },
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
// Deadzone + rescale so the live range starts just past the dead band (no jump at the edge).
const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

type Actuator = { playEffect?: (type: string, params: object) => Promise<unknown> };

export class GamepadEngine {
  private raf = 0;
  private prev: boolean[] = [];
  private scratch: Record<DeckId, boolean> = { A: false, B: false };
  private xfade = false;
  private beatIdx: Record<DeckId, number> = { A: -1, B: -1 };
  private present = false;
  private padId: string | null = null;

  constructor(private o: GamepadOpts) {}

  start() {
    this.raf = requestAnimationFrame(this.loop);
  }
  stop() {
    cancelAnimationFrame(this.raf);
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const pad = this.pickPad();
    const present = !!pad;
    if (present !== this.present || (pad && pad.id !== this.padId)) {
      this.present = present;
      this.padId = pad?.id ?? null;
      this.o.onStatus?.({ connected: present, id: this.padId });
    }
    if (!pad) return;
    if (this.o.getEnabled && !this.o.getEnabled()) return;
    this.handleButtons(pad);
    this.handleTriggers(pad);
    this.handleSticks(pad);
    this.handleRumble(pad);
  };

  // First standard-mapping pad if any, else the first connected one.
  private pickPad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    let first: Gamepad | null = null;
    for (const p of pads) {
      if (!p) continue;
      if (!first) first = p;
      if (p.mapping === "standard") return p;
    }
    return first;
  }

  private edge(i: number, b: readonly GamepadButton[]): boolean {
    return (b[i]?.pressed ?? false) && !this.prev[i];
  }

  private handleButtons(pad: Gamepad) {
    const b = pad.buttons;
    if (this.edge(DLEFT, b)) this.o.onEvent({ type: "focus", deck: "A" });
    if (this.edge(DRIGHT, b)) this.o.onEvent({ type: "focus", deck: "B" });
    for (const key in PRESS) {
      const i = Number(key);
      if (this.edge(i, b)) {
        const m = PRESS[i];
        this.o.onEvent({ type: "button", action: m.action, deck: m.deck, pressed: true, shift: false, velocity: 127 });
      }
    }
    for (let i = 0; i < b.length; i++) this.prev[i] = b[i]?.pressed ?? false;
  }

  // Analog triggers form the crossfader: push RT toward B, LT toward A; releasing both
  // springs it back to centre (a transform-style cut), and leaves the on-screen fader free
  // while no trigger is touched.
  private handleTriggers(pad: Gamepad) {
    const lt = pad.buttons[LT]?.value ?? 0;
    const rt = pad.buttons[RT]?.value ?? 0;
    if (lt > TRIG_DEAD || rt > TRIG_DEAD) {
      this.xfade = true;
      this.o.onEvent({ type: "fader", target: "crossfader", value: clamp01(0.5 + (rt - lt) / 2) });
    } else if (this.xfade) {
      this.xfade = false;
      this.o.onEvent({ type: "fader", target: "crossfader", value: 0.5 });
    }
  }

  private handleSticks(pad: Gamepad) {
    this.stickScratch("A", dz(pad.axes[0] ?? 0));
    this.stickScratch("B", dz(pad.axes[2] ?? 0));
  }
  // Deflecting the stick grabs the platter (jogTouch) and spins it (jogTurn scratch); letting
  // it recentre releases — the existing vinyl-scrub path resumes playback.
  private stickScratch(deck: DeckId, x: number) {
    if (x !== 0) {
      if (!this.scratch[deck]) {
        this.scratch[deck] = true;
        this.o.onEvent({ type: "jogTouch", deck, down: true });
      }
      this.o.onEvent({ type: "jogTurn", deck, delta: x * SCRATCH_GAIN, scratch: true });
    } else if (this.scratch[deck]) {
      this.scratch[deck] = false;
      this.o.onEvent({ type: "jogTouch", deck, down: false });
    }
  }

  // Haptic metronome: pulse the pad as the deck you're driving crosses each beat (harder on
  // the bar line). Reads the constant beatgrid so there's no array search per frame.
  private handleRumble(pad: Gamepad) {
    const act = (pad as Gamepad & { vibrationActuator?: Actuator }).vibrationActuator;
    if (!act?.playEffect) return;
    const id = this.playingDeck(this.o.getFocused());
    if (!id) return;
    const deck = this.o.engine.deck(id);
    const g = deck.beatgrid;
    const pos = deck.position();
    if (!g || g.interval <= 0 || pos < g.firstBeat) {
      this.beatIdx[id] = -1;
      return;
    }
    const idx = Math.floor((pos - g.firstBeat) / g.interval);
    if (idx === this.beatIdx[id]) return;
    const back = idx < this.beatIdx[id]; // looped / seeked backward → re-anchor, no pulse
    this.beatIdx[id] = idx;
    if (back) return;
    const down = idx % (g.beatsPerBar ?? 4) === 0;
    void act
      .playEffect("dual-rumble", {
        duration: down ? 110 : 70,
        strongMagnitude: down ? 0.8 : 0.35,
        weakMagnitude: down ? 0.5 : 0.2,
      })
      .catch(() => {});
  }
  private playingDeck(focus: DeckId): DeckId | null {
    if (this.o.engine.deck(focus).playing) return focus;
    const other: DeckId = focus === "A" ? "B" : "A";
    return this.o.engine.deck(other).playing ? other : null;
  }
}
