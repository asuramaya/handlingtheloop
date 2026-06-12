import { barAnchor, barPhase, beatPhase, beatTimeOffset, nearestBeat, smartKeyShift } from "../analysis/analyze";
import { Deck, type SyncRole } from "./Deck";
import { SCRATCH_WORKLET_SRC } from "./scratchWorklet";
import { STRETCH_WORKLET_SRC } from "./stretchWorklet";

type DeckId = "A" | "B";
const other = (id: DeckId): DeckId => (id === "A" ? "B" : "A");

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
  private readonly limiter: DynamicsCompressorNode;
  // Desired WSOLA engine config; re-applied whenever the stretch nodes (re)attach.
  private stretchCfg = { frame: 1024, search: 200, stride: 2 };

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });

    // master -> brick-wall-ish limiter -> destination. Two decks at full level
    // plus EQ boost can exceed 0 dBFS; the limiter catches the peaks so the mix
    // never hard-clips into crackle.
    this.master = this.ctx.createGain();
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.master.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    this.xfadeA = this.ctx.createGain();
    this.xfadeB = this.ctx.createGain();
    this.xfadeA.connect(this.master);
    this.xfadeB.connect(this.master);

    this.deckA = new Deck(this.ctx);
    this.deckB = new Deck(this.ctx);
    this.deckA.output.connect(this.xfadeA);
    this.deckB.output.connect(this.xfadeB);
    // Sync follow/release: any tempo change routes through the state machine.
    this.deckA.onTempoChange = () => this.onDeckTempo("A");
    this.deckB.onTempoChange = () => this.onDeckTempo("B");
    // Key-lock follow/release: any pitch change routes through the KEY machine.
    this.deckA.onPitchChange = () => this.onDeckPitch("A");
    this.deckB.onPitchChange = () => this.onDeckPitch("B");

    this.setCrossfade(0);
    void this.initWorklets();
  }

  // Load the per-deck worklets (Blob URLs → bundler-agnostic): the scratch
  // resampler and the unified time-stretch engine (tempo + key + playback). If a
  // module fails to load the decks degrade gracefully (no scrub / no playback).
  private async initWorklets() {
    const add = async (src: string) => {
      const url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    };
    try {
      await add(SCRATCH_WORKLET_SRC);
      this.deckA.attachScratchNode(new AudioWorkletNode(this.ctx, "scratch", { outputChannelCount: [2] }));
      this.deckB.attachScratchNode(new AudioWorkletNode(this.ctx, "scratch", { outputChannelCount: [2] }));
    } catch (e) {
      console.warn("[htl] scratch resampler unavailable:", e);
    }
    try {
      await add(STRETCH_WORKLET_SRC);
      this.deckA.attachStretchNode(new AudioWorkletNode(this.ctx, "stretch", { outputChannelCount: [2] }));
      this.deckB.attachStretchNode(new AudioWorkletNode(this.ctx, "stretch", { outputChannelCount: [2] }));
      this.deckA.configureStretch(this.stretchCfg); // apply any quality picked before init finished
      this.deckB.configureStretch(this.stretchCfg);
    } catch (e) {
      console.warn("[htl] stretch engine unavailable:", e);
    }
  }

  /** Browsers start the context suspended until a user gesture. */
  resume() {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Set the time-stretch engine quality on both decks (from the Audio Engine
   *  settings tab). Stored so it survives node re-attach. */
  setStretchConfig(cfg: { frame: number; search: number; stride: number }) {
    this.stretchCfg = cfg;
    this.deckA.configureStretch(cfg);
    this.deckB.configureStretch(cfg);
  }

  deck(id: "A" | "B"): Deck {
    return id === "A" ? this.deckA : this.deckB;
  }

  // ---- beat-sync state machine -------------------------------------------------
  // SYNC is a persistent TOGGLE, not a one-shot. The relationship is DIRECTIONAL:
  // one SLAVE follows one MASTER (the other deck). `slaveId` is the single source of
  // truth — master = the other deck, null = no sync — so the configuration is always
  // valid by construction (the "gate": at most one master + one slave, or neither).
  // While engaged the slave's tempo tracks the master's continuously; nudging the
  // slave's own tempo releases the lock.
  private slaveId: DeckId | null = null;
  private propagating = false; // guards the master→slave tempo echo from recursing

  private get masterId(): DeckId | null {
    return this.slaveId == null ? null : other(this.slaveId);
  }

  /** "off" | "master" | "slave" for a deck — what the UI lights the SYNC button on. */
  syncRole(id: DeckId): SyncRole {
    if (this.slaveId == null) return "off";
    return id === this.slaveId ? "slave" : "master";
  }
  get synced(): boolean {
    return this.slaveId != null;
  }

  private writeRoles() {
    this.deckA.syncRole = this.syncRole("A");
    this.deckB.syncRole = this.syncRole("B");
  }

  /**
   * SYNC toggle. The gate, by current role of `id`:
   *   off    → `id` becomes SLAVE following the other (which becomes MASTER); align.
   *   slave  → release the pair (both off).
   *   master → flip direction: `id` becomes SLAVE following the other; align.
   * Engaging needs both decks analysed + a buffer, else it's a no-op (nothing to
   * lock to) so the button never lights on an un-syncable pair.
   */
  toggleSync(id: DeckId) {
    if (this.syncRole(id) === "slave") {
      this.slaveId = null; // toggle off
    } else {
      const me = this.deck(id);
      const them = this.deck(other(id));
      if (!me.beatgrid || !them.beatgrid || !me.buffer) return;
      this.slaveId = id; // engage / flip: `id` follows the other
      this.alignSlave();
    }
    this.writeRoles();
  }

  /** Match only the slave's TEMPO to the master's effective BPM (half/double folded).
   *  Used both on engage and on every master tempo change (continuous follow). */
  private matchSlaveTempo() {
    const sid = this.slaveId;
    if (sid == null) return;
    const slave = this.deck(sid);
    const master = this.deck(other(sid));
    const sg = slave.beatgrid;
    const mg = master.beatgrid;
    if (!sg || !mg) return;
    let target = master.effectiveBpm ?? mg.bpm;
    while (target / sg.bpm > Math.SQRT2) target /= 2;
    while (target / sg.bpm < 1 / Math.SQRT2) target *= 2;
    this.propagating = true; // this setTempo is the echo — don't let it release sync
    slave.setTempo((target / sg.bpm - 1) * 100);
    this.propagating = false;
  }

  /** Tempo-match + phase-align the slave to its master (on engage / re-sync). */
  private alignSlave() {
    const sid = this.slaveId;
    if (sid == null) return;
    const slave = this.deck(sid);
    const master = this.deck(other(sid));
    const sg = slave.beatgrid;
    const mg = master.beatgrid;
    if (!sg || !mg || !slave.buffer) return;
    this.matchSlaveTempo();

    // Phase align: bar-level when both downbeats are known (the two "1"s land
    // together — a phrase-tight mix), else per-beat. Minimal move (wrap to nearest).
    if (sg.downbeat != null && mg.downbeat != null) {
      const oFrac = barPhase(mg, master.position());
      const bar = barAnchor(sg, slave.position());
      let target = bar.start + oFrac * bar.length;
      const pos = slave.position();
      if (target - pos > bar.length / 2) target -= bar.length;
      else if (pos - target > bar.length / 2) target += bar.length;
      slave.seek(target);
    } else {
      const oFrac = beatPhase(mg, master.position());
      const sBeat = nearestBeat(sg, slave.position());
      const interval = beatTimeOffset(sg, sBeat, 1) - sBeat || sg.interval;
      slave.seek(sBeat + oFrac * interval);
    }
  }

  // Deck tempo hook: master moves → slave follows; the user moving the SLAVE's own
  // tempo means they're taking it off the leash, so release the lock.
  private onDeckTempo(id: DeckId) {
    if (this.propagating || this.slaveId == null) return;
    if (id === this.slaveId) {
      this.slaveId = null;
      this.writeRoles();
    } else {
      this.matchSlaveTempo();
    }
  }

  /** Re-assert the lock after a deck in the pair loads a new track (grid changed). */
  reassertSync(id: DeckId) {
    if (this.slaveId == null || (id !== this.slaveId && id !== this.masterId)) return;
    if (!this.deck(this.slaveId).beatgrid) {
      this.slaveId = null; // slave lost its grid → can't follow
    } else {
      this.alignSlave();
    }
    this.writeRoles();
  }

  // ---- key-lock state machine --------------------------------------------------
  // KEY is the harmonic twin of SYNC: a persistent directional master/slave TOGGLE
  // (same gate, separate from tempo sync — you can lock key without locking tempo).
  // The slave is pitch-shifted by the SMALLEST move that makes it harmonically
  // COMPATIBLE with the master (Camelot-aware, mode-aware), not forced onto an exact
  // tonic; while locked the slave follows the master's key, and moving the slave's
  // own key (or releasing) un-shifts it back to the track's own pitch.
  private keySlaveId: DeckId | null = null;
  private keyPropagating = false;

  private get keyMasterId(): DeckId | null {
    return this.keySlaveId == null ? null : other(this.keySlaveId);
  }

  keyRole(id: DeckId): SyncRole {
    if (this.keySlaveId == null) return "off";
    return id === this.keySlaveId ? "slave" : "master";
  }
  get keyLocked(): boolean {
    return this.keySlaveId != null;
  }

  private writeKeyRoles() {
    this.deckA.keyRole = this.keyRole("A");
    this.deckB.keyRole = this.keyRole("B");
  }

  /** KEY toggle. off → become key-SLAVE, smart-shifted to a key compatible with the
   *  other (= MASTER); slave → release (un-shift to the track's own key); master →
   *  flip direction. No-op to engage until both decks have a detected key. */
  toggleKey(id: DeckId) {
    if (this.keyRole(id) === "slave") {
      this.keySlaveId = null;
      this.keyPropagating = true;
      this.deck(id).setPitch(0); // release → back to the original key
      this.keyPropagating = false;
    } else {
      const me = this.deck(id);
      const them = this.deck(other(id));
      if (!me.key || !them.key) return;
      this.keySlaveId = id;
      this.matchKeyToMaster();
    }
    this.writeKeyRoles();
  }

  /** Smart-shift the slave to a key harmonically compatible with the master's
   *  CURRENT (pitch-shifted) key. Runs on engage and on every master key change. */
  private matchKeyToMaster() {
    const sid = this.keySlaveId;
    if (sid == null) return;
    const slave = this.deck(sid);
    const masterKey = this.deck(other(sid)).effectiveKey;
    if (!slave.key || !masterKey) return;
    const shift = smartKeyShift(slave.key, masterKey, 12);
    this.keyPropagating = true;
    slave.setPitch(shift);
    this.keyPropagating = false;
  }

  // Deck pitch hook: master key moves → slave re-matches; the user moving the
  // SLAVE's own key takes it off the leash → release the lock.
  private onDeckPitch(id: DeckId) {
    if (this.keyPropagating || this.keySlaveId == null) return;
    if (id === this.keySlaveId) {
      this.keySlaveId = null;
      this.writeKeyRoles();
    } else {
      this.matchKeyToMaster();
    }
  }

  /** Re-assert the key lock after a deck in the pair loads a new track. */
  reassertKey(id: DeckId) {
    if (this.keySlaveId == null || (id !== this.keySlaveId && id !== this.keyMasterId)) return;
    if (!this.deck(this.keySlaveId).key) {
      this.keySlaveId = null;
    } else {
      this.matchKeyToMaster();
    }
    this.writeKeyRoles();
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
