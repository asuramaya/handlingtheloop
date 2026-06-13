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
  // TEMP iPhone diagnostics: surface worklet-module load failures (console is
  // invisible on an iPhone) so the on-screen overlay can show WHY playback is dead.
  workletError = "";

  // iOS BACKGROUND-AUDIO bridge. iOS suspends a raw AudioContext the moment Safari is
  // backgrounded / the phone locks / audio is handed to BT/CarPlay — there's no API to
  // keep a Web Audio graph alive. The ONLY way through: route the mix into a
  // MediaStream feeding a PLAYING <audio> element; iOS keeps a media element alive in
  // the background (like a music app), which keeps the context rendering. Fail-safe:
  // any failure reverts to the plain destination so audio is never lost.
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private keepAlive: HTMLAudioElement | null = null;
  private bgAudioOn = false;

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
      this.workletError += "scratch:" + (e instanceof Error ? e.message : String(e)) + " ";
    }
    try {
      await add(STRETCH_WORKLET_SRC);
      this.deckA.attachStretchNode(new AudioWorkletNode(this.ctx, "stretch", { outputChannelCount: [2] }));
      this.deckB.attachStretchNode(new AudioWorkletNode(this.ctx, "stretch", { outputChannelCount: [2] }));
      this.deckA.configureStretch(this.stretchCfg); // apply any quality picked before init finished
      this.deckB.configureStretch(this.stretchCfg);
    } catch (e) {
      console.warn("[htl] stretch engine unavailable:", e);
      this.workletError += "stretch:" + (e instanceof Error ? e.message : String(e)) + " ";
    }
  }

  /** Browsers start the context suspended until a user gesture. */
  resume() {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  // iOS Safari only UNLOCKS audio output when an actual node is started inside a user
  // gesture. In a session a LISTENER's first sound starts later, from a network tick
  // (deck.play()), never from the tap — so a bare resume() leaves the route muted and
  // the listener is silent. Call this FROM A GESTURE (the Listen tap): it resumes AND
  // starts a 1-sample silent buffer, fully priming the output so later tick-driven
  // playback is audible. Runs the primer once (idempotent after the first unlock).
  private unlocked = false;
  unlock() {
    if (this.ctx.state === "suspended") void this.ctx.resume();
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start(0);
    } catch {
      /* primer is best-effort */
    }
  }

  /** Set the time-stretch engine quality on both decks (from the Audio Engine
   *  settings tab). Stored so it survives node re-attach. */
  setStretchConfig(cfg: { frame: number; search: number; stride: number }) {
    this.stretchCfg = cfg;
    this.deckA.configureStretch(cfg);
    this.deckB.configureStretch(cfg);
  }

  /** True when this browser can route the context to a chosen output device
   *  (AudioContext.setSinkId — Chromium/Edge; Firefox/Safari currently can't). */
  get canSetSink(): boolean {
    return typeof (this.ctx as unknown as { setSinkId?: unknown }).setSinkId === "function";
  }

  /** Route the whole mix to a specific audio output device (Settings → Audio).
   *  `deviceId` "" = system default. No-op returning false when unsupported, so
   *  the UI can explain instead of throwing. Safe on a suspended context. */
  async setSinkId(deviceId: string): Promise<boolean> {
    const ctx = this.ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
    if (typeof ctx.setSinkId !== "function") return false;
    try {
      await ctx.setSinkId(deviceId || ""); // "" → default device
      return true;
    } catch (e) {
      console.warn("[htl] setSinkId failed:", e);
      return false;
    }
  }

  get backgroundAudioActive(): boolean {
    return this.bgAudioOn;
  }

  /** Bridge the mix through a MediaStream into a hidden, playing <audio> element so
   *  iOS keeps it alive in the background (lock / app-switch / Bluetooth / CarPlay).
   *  MUST be called from a user gesture (the element's play()). Idempotent. Any error
   *  — or a rejected play — reverts to ctx.destination so playback is never lost. */
  enableBackgroundAudio(): void {
    if (this.bgAudioOn || typeof document === "undefined") return;
    try {
      const dest = this.ctx.createMediaStreamDestination();
      const el = document.createElement("audio");
      el.setAttribute("playsinline", "");
      el.autoplay = true;
      el.loop = true; // a live stream never ends; loop is just belt-and-braces
      el.srcObject = dest.stream;
      el.style.display = "none";
      document.body.appendChild(el);
      // Re-route the terminal: limiter → media element (via the stream), not → device.
      try {
        this.limiter.disconnect(this.ctx.destination);
      } catch {
        /* wasn't connected (already bridged) — ignore */
      }
      this.limiter.connect(dest);
      this.streamDest = dest;
      this.keepAlive = el;
      this.bgAudioOn = true;
      void el.play().catch(() => this.disableBackgroundAudio()); // fail-safe revert
    } catch {
      this.disableBackgroundAudio();
    }
  }

  /** Tear the bridge down and go back to plain ctx.destination output (the fail-safe,
   *  and the desktop path). */
  disableBackgroundAudio(): void {
    if (this.streamDest) {
      try {
        this.limiter.disconnect(this.streamDest);
      } catch {
        /* ignore */
      }
    }
    try {
      this.limiter.connect(this.ctx.destination);
    } catch {
      /* already connected — ignore */
    }
    if (this.keepAlive) {
      try {
        this.keepAlive.pause();
        this.keepAlive.srcObject = null;
        this.keepAlive.remove();
      } catch {
        /* ignore */
      }
    }
    this.keepAlive = null;
    this.streamDest = null;
    this.bgAudioOn = false;
  }

  /** Wake the output after a backgrounding / lock / route change: resume the context
   *  AND re-play the keep-alive element (iOS pauses it on an interruption). Call on
   *  return-to-foreground and on audio-route changes so the sound doesn't stay dead. */
  resumeOutput(): void {
    if (this.ctx.state === "suspended") void this.ctx.resume();
    const el = this.keepAlive;
    if (el && el.paused) void el.play().catch(() => {});
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

  /** Which deck is the SYNC slave (null = off) — the absolute setpoint to send over a
   *  session so a peer can mirror the button without a non-idempotent toggle. */
  get syncSlave(): DeckId | null {
    return this.slaveId;
  }
  /** Mirror a peer's SYNC role for the BUTTON only. We do NOT engage the tempo engine
   *  here: the master's tempo already crosses as control intents, so a follower that
   *  also matched would fight those values. Display state only. */
  mirrorSyncDisplay(slave: DeckId | null) {
    this.deckA.syncRole = slave == null ? "off" : slave === "A" ? "slave" : "master";
    this.deckB.syncRole = slave == null ? "off" : slave === "B" ? "slave" : "master";
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

  /** Which deck is the KEY slave (null = off) — absolute setpoint for the session. */
  get keySlave(): DeckId | null {
    return this.keySlaveId;
  }
  /** Mirror a peer's KEY role for the button only (the master's pitch crosses as a
   *  control intent, so the follower must not also re-shift). Display state only. */
  mirrorKeyDisplay(slave: DeckId | null) {
    this.deckA.keyRole = slave == null ? "off" : slave === "A" ? "slave" : "master";
    this.deckB.keyRole = slave == null ? "off" : slave === "B" ? "slave" : "master";
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
