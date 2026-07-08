import type { AudioEngine, DeckId } from "@htl/audio";
import type { MidiEvent } from "@htl/midi";

// An Xbox / W3C "standard"-mapping gamepad as a DJ control surface. It does NOT touch the
// decks directly — it emits the SAME MidiEvent stream the MIDI layer produces, fed into App's
// onMidiEvent. So it inherits the focus model, room-sync, the jog/scratch path and the
// room-control gate for free; nothing downstream knows a gamepad exists.
//
// Focus model: ONE control set drives the FOCUSED deck; the Share/centre button flips focus.
//   Share (centre)     → switch deck attention (focus toggle)
//   A                  → play / pause
//   X / Y / B          → loop IN / OUT / EXIT
//   D-pad              → the keyboard arrows: ←/→ nudge a beat, ↑/↓ jump a skip
//   Left stick   ↔     → scratch (grab + spin the platter)      ↕ → zoom the waveform
//   Right stick  ↔     → crossfader A↔B (incremental, holds)    ↕ → focused channel volume
//   LT / RT (hold)     → low-pass / high-pass filter (release = off)
//   LB / RB            → beatgrid magnet (G) / SHIFT (held)
//   View / Menu        → SYNC / KEY-match (focused)
//   L3 / R3 (clicks)   → CUE / arm-disarm Smart Fader
//   Guide (centre X)   → open / close the library = CRATE-DIG MODE (below)
//   …and the pad RUMBLES on every beat of the focused deck (harder on the bar line).
//
// CRATE-DIG MODE — while the library dock is open the DJ map is suspended and the pad drives the
// library instead: D-pad ↑/↓ (+ left stick ↕) move the row cursor, ←/→ jump list ↔ sources, A / B
// load the highlighted track onto deck A / B, Guide closes it. The pad reads the live libOpen state
// each frame (getLibraryOpen), so opening the library any other way (Alt / chin) flips it too.

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
  getLibraryOpen?: () => boolean; // library open → the pad flips into crate-dig mode
}

// Standard-mapping indices.
const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7, VIEW = 8, MENU = 9, L3 = 10, R3 = 11,
  DUP = 12, DDOWN = 13, DLEFT = 14, DRIGHT = 15;
const GUIDE = 16; // the centre Xbox/Guide button (X logo) → open/close the library (crate-dig mode)
const SHARE = [17]; // Series X/S Share button → focus toggle (older pads report the centre as 16 — see note)

const DEAD = 0.18; // stick deadzone (fraction)
const TRIG_DEAD = 0.06; // trigger engage threshold
const SCRATCH_GAIN = 5; // jog ticks per frame at full stick deflection
const XF_RATE = 0.015; // crossfader travel per frame at full stick (incremental → holds)
const LEVEL_RATE = 0.012; // channel-volume nudge per frame at full stick
const ZOOM_FRAMES = 6; // frames between zoom steps while the stick is held (~10/s)
const BROWSE_FRAMES = 5; // frames between library-scroll steps while the stick is held (~12/s)
// Bluetooth rumble lands late (the BT hop + motor spin-up, ~100-150 ms), so we PRE-FIRE: the
// pulse goes out this many ms BEFORE the beat sounds, landing the buzz on the beat. Tune to your
// pad/stack — bigger if it still lags, smaller if it pre-empts.
const RUMBLE_LEAD_MS = 130;

// Press-edge buttons → a deckless control action (drives the FOCUSED deck via App's
// `deck ?? focused`). Hot cues are gone — 4 pads fell short; these are the transport/loop core.
const PRESS: Record<number, string> = {
  [A]: "play",
  [X]: "loopIn",
  [Y]: "loopOut",
  [B]: "loopExit",
  [LB]: "grid", // the G key — beatgrid quantize magnet
  [VIEW]: "sync", // SYNC the focused deck
  [MENU]: "keyMatch", // KEY-match the focused deck
  [L3]: "cue", // left stick click → CUE
  [R3]: "smartFaderToggle", // right stick click → arm / disarm Smart Fader
  [DUP]: "jogFwd", // ↑ jump forward (skip size)
  [DDOWN]: "jogBack", // ↓ jump back
  [DLEFT]: "jogBackBeat", // ← nudge back a beat
  [DRIGHT]: "jogFwdBeat", // → nudge forward a beat
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
// Deadzone + rescale so the live range starts just past the dead band (no jump at the edge).
const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

type Actuator = { playEffect?: (type: string, params: object) => Promise<unknown> };

export class GamepadEngine {
  private raf = 0;
  private prev: boolean[] = [];
  private scratchDeck: DeckId | null = null;
  private shiftDown = false;
  private trigOn: Record<"lp" | "hp", boolean> = { lp: false, hp: false };
  private xfPos = 0.5; // tracked crossfader position (incremental driver)
  private zoomCd = 0;
  private browseCd = 0; // library-scroll throttle (left stick ↕ in crate-dig mode)
  private firedBeat: Record<DeckId, number> = { A: -1, B: -1 }; // last beat index we've already pulsed for
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
    // Guide (centre X) opens/closes the library in BOTH modes — it's how you get out of crate-dig.
    this.handleGuide(pad);
    if (this.o.getLibraryOpen?.()) {
      this.handleBrowse(pad); // crate-dig: DJ controls suspended, the pad drives the library
    } else {
      this.handleButtons(pad);
      this.handleTriggers(pad);
      this.handleSticks(pad);
      this.handleRumble(pad);
    }
    this.syncPrev(pad); // snapshot button states once per frame → edge() for whichever mode ran
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
    for (const key in PRESS) {
      const i = Number(key);
      if (this.edge(i, b)) {
        this.o.onEvent({ type: "button", action: PRESS[i], pressed: true, shift: false, velocity: 127 });
      }
    }
    // Share → flip the focused deck (read live so repeated presses toggle).
    if (SHARE.some((i) => this.edge(i, b))) {
      this.o.onEvent({ type: "focus", deck: this.o.getFocused() === "A" ? "B" : "A" });
    }
    // RB = SHIFT, momentary (down while held, up on release).
    const rb = b[RB]?.pressed ?? false;
    if (rb !== this.shiftDown) {
      this.shiftDown = rb;
      this.o.onEvent({ type: "shift", down: rb });
    }
  }

  // Guide (centre X) → toggle the library dock. Fires in both modes (always the way out of
  // crate-dig). Shared edge tracker — syncPrev snapshots index 16 each frame if the pad reports it.
  private handleGuide(pad: Gamepad) {
    if (this.edge(GUIDE, pad.buttons)) this.o.onEvent({ type: "library" });
  }

  // Crate-dig mode (library open): the DJ map is suspended and the pad drives the library.
  //   D-pad ↑/↓ (+ left stick ↕) → move the row cursor    D-pad ←/→ → jump list ↔ sources
  //   A → load deck A            B → load deck B           Guide → close (handled above)
  // A soft rumble tick marks each cursor step (tactile flicking). The rest stay idle for now.
  private handleBrowse(pad: Gamepad) {
    const b = pad.buttons;
    // If the library opened mid-scratch, release the platter so it doesn't stay grabbed.
    if (this.scratchDeck) {
      this.o.onEvent({ type: "jogTouch", deck: this.scratchDeck, down: false });
      this.scratchDeck = null;
    }
    let moved = false;
    if (this.edge(DUP, b)) { this.o.onEvent({ type: "browse", delta: -1 }); moved = true; }
    if (this.edge(DDOWN, b)) { this.o.onEvent({ type: "browse", delta: 1 }); moved = true; }
    if (this.edge(DLEFT, b) || this.edge(DRIGHT, b)) this.o.onEvent({ type: "selector" }); // jump list ↔ sources
    if (this.edge(A, b)) this.o.onEvent({ type: "load", deck: "A" });
    if (this.edge(B, b)) this.o.onEvent({ type: "load", deck: "B" });
    // Left stick ↕ = fast scroll for long crates (throttled to ~12 steps/s).
    const y = dz(pad.axes[1] ?? 0);
    if (y === 0) this.browseCd = 0;
    else if (this.browseCd > 0) this.browseCd--;
    else { this.browseCd = BROWSE_FRAMES; this.o.onEvent({ type: "browse", delta: y < 0 ? -1 : 1 }); moved = true; }
    if (moved) this.tick(pad);
  }

  // A short, soft haptic blip — the felt cue for a cursor step while crate-digging.
  private tick(pad: Gamepad) {
    const act = (pad as Gamepad & { vibrationActuator?: Actuator }).vibrationActuator;
    void act?.playEffect?.("dual-rumble", { duration: 26, strongMagnitude: 0, weakMagnitude: 0.22 }).catch(() => {});
  }

  // Snapshot every button's pressed state once per frame — the basis for edge() next frame, in
  // whichever mode ran (lifted out of handleButtons so crate-dig edges work too).
  private syncPrev(pad: Gamepad) {
    const b = pad.buttons;
    for (let i = 0; i < b.length; i++) this.prev[i] = b[i]?.pressed ?? false;
  }

  // Triggers are momentary filter holds: LT = low-pass, RT = high-pass. Release → 0 (off).
  private handleTriggers(pad: Gamepad) {
    this.trig("filterLp", "lp", pad.buttons[LT]?.value ?? 0);
    this.trig("filterHp", "hp", pad.buttons[RT]?.value ?? 0);
  }
  private trig(target: "filterLp" | "filterHp", key: "lp" | "hp", val: number) {
    if (val > TRIG_DEAD) {
      this.trigOn[key] = true;
      this.o.onEvent({ type: "fader", target, value: clamp01(val) });
    } else if (this.trigOn[key]) {
      this.trigOn[key] = false;
      this.o.onEvent({ type: "fader", target, value: 0 });
    }
  }

  private handleSticks(pad: Gamepad) {
    const focus = this.o.getFocused();
    this.stickScratch(focus, dz(pad.axes[0] ?? 0)); // L stick ↔ → scratch focused
    this.stickZoom(focus, dz(pad.axes[1] ?? 0)); // L stick ↕ → zoom focused
    this.crossfade(dz(pad.axes[2] ?? 0)); // R stick ↔ → crossfader
    this.volume(focus, dz(pad.axes[3] ?? 0)); // R stick ↕ → focused channel volume
  }

  // Deflecting grabs the platter (jogTouch) and spins it (jogTurn scratch); recentre releases.
  // Tracks WHICH deck was grabbed so a mid-scratch focus flip releases the old platter cleanly.
  private stickScratch(focus: DeckId, x: number) {
    if (x !== 0) {
      if (this.scratchDeck && this.scratchDeck !== focus) {
        this.o.onEvent({ type: "jogTouch", deck: this.scratchDeck, down: false });
        this.scratchDeck = null;
      }
      if (!this.scratchDeck) {
        this.scratchDeck = focus;
        this.o.onEvent({ type: "jogTouch", deck: focus, down: true });
      }
      this.o.onEvent({ type: "jogTurn", deck: this.scratchDeck, delta: x * SCRATCH_GAIN, scratch: true });
    } else if (this.scratchDeck) {
      this.o.onEvent({ type: "jogTouch", deck: this.scratchDeck, down: false });
      this.scratchDeck = null;
    }
  }

  // Up (negative Y) zooms IN. Throttled to discrete steps so a held stick zooms smoothly.
  private stickZoom(deck: DeckId, y: number) {
    if (y === 0) {
      this.zoomCd = 0;
      return;
    }
    if (this.zoomCd > 0) {
      this.zoomCd--;
      return;
    }
    this.zoomCd = ZOOM_FRAMES;
    this.o.onEvent({ type: "zoom", deck, delta: y < 0 ? 1 : -1 });
  }

  // Incremental crossfader: the stick NUDGES the position and it holds when released (a stick
  // that sprang the crossfader back to centre would be useless). Left = A, right = B.
  private crossfade(x: number) {
    if (x === 0) return;
    this.xfPos = clamp01(this.xfPos + x * XF_RATE);
    this.o.onEvent({ type: "fader", target: "crossfader", value: this.xfPos });
  }

  // Focused channel volume — a relative nudge (up = louder) that holds where you leave it.
  private volume(deck: DeckId, y: number) {
    if (y === 0) return;
    this.o.onEvent({ type: "knob", target: "level", deck, delta: -y * LEVEL_RATE });
  }

  // Haptic metronome: pulse the pad on each beat of the focused deck (harder on the bar line).
  // PREDICTIVE — it fires RUMBLE_LEAD_MS before the next beat sounds so the Bluetooth-delayed
  // buzz lands on the beat. The lead is converted to real time via the deck's playback rate, so
  // it stays aligned when sync/tempo speeds the track up or down.
  private handleRumble(pad: Gamepad) {
    const act = (pad as Gamepad & { vibrationActuator?: Actuator }).vibrationActuator;
    if (!act?.playEffect) return;
    const id = this.playingDeck(this.o.getFocused());
    if (!id) return;
    const deck = this.o.engine.deck(id);
    const g = deck.beatgrid;
    const pos = deck.position();
    if (!g || g.interval <= 0) {
      this.firedBeat[id] = -1;
      return;
    }
    // The next beat at/after the playhead, and how long (in REAL seconds) until it sounds.
    const nextIdx = Math.max(0, Math.ceil((pos - g.firstBeat) / g.interval));
    const realToNext = (g.firstBeat + nextIdx * g.interval - pos) / (deck.rate || 1);
    if (realToNext > RUMBLE_LEAD_MS / 1000) return; // not imminent yet
    if (this.firedBeat[id] === nextIdx) return; // already pulsed for this beat
    this.firedBeat[id] = nextIdx;
    const down = nextIdx % (g.beatsPerBar ?? 4) === 0;
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
