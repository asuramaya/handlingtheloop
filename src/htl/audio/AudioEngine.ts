import { barAnchor, barPhase, beatPhase, beatTimeOffset, nearestBeat, smartKeyShift } from "../analysis/analyze";
import { Deck, type SyncRole, type StretchEngineConfig } from "./Deck";
import { Sampler } from "./Sampler";
import { SCRATCH_WORKLET_SRC } from "./scratchWorklet";
import { STRETCH_WORKLET_SRC } from "./stretchWorklet";
import { REVERB_WORKLET_SRC } from "./reverbWorklet";
import { CRUSH_WORKLET_SRC } from "./crushWorklet";

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
  // Sampler strip: pads route by position — A-region pads into deck A's channel input
  // (EQ/filter/fader/crossfader apply), global pads to master (cut through), B-region
  // pads into deck B's channel. Built after the decks so their channel inputs exist.
  readonly sampler: Sampler;

  private readonly xfadeA: GainNode;
  private readonly xfadeB: GainNode;
  private readonly master: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  // Headphone-cue (PFL) bus: both decks' pre-fader cueSend taps mix into cueMaster,
  // which — when a separate cue device is chosen — bridges through a MediaStream into a
  // hidden <audio> element pinned to that device via setSinkId (the only way to drive a
  // SECOND physical output from one AudioContext). Built lazily; dangling = silent.
  private readonly cueMaster: GainNode;
  private cueStreamDest: MediaStreamAudioDestinationNode | null = null;
  private cueEl: HTMLAudioElement | null = null;
  private cueDeviceId = ""; // currently routed cue device ("" = none / single output)
  // Desired WSOLA engine config; re-applied whenever the stretch nodes (re)attach.
  private stretchCfg: StretchEngineConfig = { frame: 1024, search: 200, stride: 2 };
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
    // Sampler routes: region pads inject at each deck's channel input (rack.input → EQ →
    // fader → crossfader); global pads at master (pre-limiter, post-crossfade).
    this.sampler = new Sampler(this.ctx, { A: this.deckA.rack.input, master: this.master, B: this.deckB.rack.input });
    // Cue bus: both decks' pre-fader sends mix into cueMaster (unity). Its downstream
    // (the second device sink) is built on demand in setCueSinkId — until then this is
    // a dangling sub-mix with no output, so it costs nothing and makes no sound.
    this.cueMaster = this.ctx.createGain();
    this.deckA.cueSend.connect(this.cueMaster);
    this.deckB.cueSend.connect(this.cueMaster);
    // Sync follow/release: any tempo change routes through the state machine.
    this.deckA.onTempoChange = () => this.onDeckTempo("A");
    this.deckB.onTempoChange = () => this.onDeckTempo("B");
    // Key-lock follow/release: any pitch change routes through the KEY machine.
    this.deckA.onPitchChange = () => this.onDeckPitch("A");
    this.deckB.onPitchChange = () => this.onDeckPitch("B");
    // Continuous beat-sync phase-lock: tempo-match keeps the average tempo equal but the
    // beat phase still slides (rounded best-fit BPM + wavering dynamic grids), so poll the
    // slave→master phase error and ride a tiny rate trim to hold it. No-ops whenever
    // nothing is synced, so it's effectively free when unused.
    if (typeof setInterval !== "undefined") {
      this.syncCorrectTimer = setInterval(() => this.phaseCorrect(), AudioEngine.SYNC_TICK_MS);
    }

    this.setCrossfade(0);
    void this.ensureWorklets();
  }

  // Modules we've successfully addModule()'d — so a re-run never double-registers (which
  // throws), but still re-creates any NODE that failed to attach.
  private modulesAdded = new Set<string>();
  private ensuring = false;

  /** addModule() a worklet source exactly once. Records the failure (surfaced in Settings ▸
   *  Debug) and returns false so the caller skips node creation this round. */
  private async addModuleOnce(name: string, src: string): Promise<boolean> {
    if (this.modulesAdded.has(name)) return true;
    try {
      const url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.modulesAdded.add(name);
      return true;
    } catch (e) {
      console.warn(`[htl] ${name} worklet addModule failed:`, e);
      return false;
    }
  }

  /** Load + attach the per-deck worklets (scratch resampler, time-stretch playback engine,
   *  FDN reverb tank). IDEMPOTENT + RE-RUNNABLE: iOS Safari intermittently drops a worklet on
   *  the first try at construction (the context is suspended) — the "scrub works, Play silent"
   *  race, because the SCRATCH node attached but the STRETCH (playback) node didn't. So we run
   *  this again from the unlock gesture (context running = the reliable moment): each module is
   *  added once, and only the MISSING nodes are re-created (attachStretchNode reloads the
   *  current track's PCM, so a late attach still plays). `workletError` is recomputed from the
   *  live attach state so the debug overlay reflects reality, not a stale first-run failure. */
  async ensureWorklets(): Promise<void> {
    if (this.ensuring) return;
    this.ensuring = true;
    try {
      if (await this.addModuleOnce("scratch", SCRATCH_WORKLET_SRC)) {
        try {
          if (!this.deckA.scratchAttached) this.deckA.attachScratchNode(new AudioWorkletNode(this.ctx, "scratch", { outputChannelCount: [2] }));
          if (!this.deckB.scratchAttached) this.deckB.attachScratchNode(new AudioWorkletNode(this.ctx, "scratch", { outputChannelCount: [2] }));
        } catch (e) {
          console.warn("[htl] scratch node attach failed (will retry):", e);
        }
      }
      if (await this.addModuleOnce("stretch", STRETCH_WORKLET_SRC)) {
        try {
          if (!this.deckA.stretchAttached) {
            this.deckA.attachStretchNode(new AudioWorkletNode(this.ctx, "stretch", { outputChannelCount: [2] }));
            this.deckA.configureStretch(this.stretchCfg);
          }
          if (!this.deckB.stretchAttached) {
            this.deckB.attachStretchNode(new AudioWorkletNode(this.ctx, "stretch", { outputChannelCount: [2] }));
            this.deckB.configureStretch(this.stretchCfg);
          }
        } catch (e) {
          console.warn("[htl] stretch node attach failed (will retry on next gesture):", e);
        }
      }
      await this.addModuleOnce("reverb", REVERB_WORKLET_SRC); // ReverbFx creates nodes on demand
      await this.addModuleOnce("crush", CRUSH_WORKLET_SRC); // CrushFx creates nodes on demand
    } finally {
      this.ensuring = false;
    }
    // Recompute the diagnostic from the live state (a later re-attach clears a stale failure).
    const miss: string[] = [];
    if (!this.deckA.stretchAttached || !this.deckB.stretchAttached) miss.push("stretch");
    if (!this.deckA.scratchAttached || !this.deckB.scratchAttached) miss.push("scratch");
    this.workletError = miss.length ? `not attached: ${miss.join(", ")} (retries on next tap)` : "";
  }

  /** Browsers start the context suspended until a user gesture. */
  resume() {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** True once the output is actually flowing. iOS `resume()` is async and can ignore
   *  the first gesture, so the unlock loop polls this to know when to STOP retrying
   *  (rather than firing once and giving up — the cause of the "silent until refresh"
   *  flakiness on mobile, solo + listen alike). */
  get running(): boolean {
    return this.ctx.state === "running";
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
   *  settings tab). Stored so it survives node re-attach. Preserves the live
   *  separation reserve (a quality change mustn't drop pre-roll headroom). */
  setStretchConfig(cfg: StretchEngineConfig) {
    this.stretchCfg = { ...cfg, reserve: this.stretchCfg.reserve };
    this.deckA.configureStretch(this.stretchCfg);
    this.deckB.configureStretch(this.stretchCfg);
  }

  /** Raise/lower the worklet's pre-roll FIFO headroom on BOTH decks. The host bumps
   *  this while an on-device stem separation is in flight: the per-segment CPU FFT
   *  bursts (separator.worker) momentarily crowd the audio thread, and a reserve lets
   *  a pressured render quantum output pre-built grains instead of running the WSOLA/PV
   *  search and overrunning its budget (the mid-split stutter). 0 off = zero tempo/pitch
   *  control latency the rest of the time. Resends the FULL config so the worklet's
   *  geometry early-return fires (no grain rebuild / click). */
  setStretchReserve(samples: number) {
    const reserve = Math.max(0, Math.round(samples));
    if (this.stretchCfg.reserve === reserve) return;
    this.stretchCfg = { ...this.stretchCfg, reserve };
    this.deckA.configureStretch(this.stretchCfg);
    this.deckB.configureStretch(this.stretchCfg);
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

  /** True when this browser can pin a media element to a chosen output device
   *  (HTMLMediaElement.setSinkId — Chromium/Edge). Gates the cue-device UI; the cue
   *  bus needs a SECOND sink, which only the element variant provides. */
  get canCueDevice(): boolean {
    return typeof document !== "undefined" && typeof HTMLMediaElement !== "undefined" && typeof HTMLMediaElement.prototype.setSinkId === "function";
  }

  /** Route the headphone-cue (PFL) bus to a separate output device (Settings → Audio).
   *  `deviceId` "" tears the cue bus down (back to single output). Bridges cueMaster
   *  through a MediaStream into a hidden <audio> element pinned to the device — the
   *  only way to drive a second physical output from one AudioContext. No-op returning
   *  false when unsupported, so the UI can explain instead of throwing. */
  async setCueSinkId(deviceId: string): Promise<boolean> {
    this.cueDeviceId = deviceId || "";
    if (!this.cueDeviceId) {
      this.teardownCueBus();
      return true;
    }
    if (typeof document === "undefined") return false;
    try {
      if (!this.cueStreamDest) {
        this.cueStreamDest = this.ctx.createMediaStreamDestination();
        this.cueMaster.connect(this.cueStreamDest);
      }
      if (!this.cueEl) {
        const el = document.createElement("audio");
        el.setAttribute("playsinline", "");
        el.autoplay = true;
        el.srcObject = this.cueStreamDest.stream;
        el.style.display = "none";
        document.body.appendChild(el);
        this.cueEl = el;
      }
      const el = this.cueEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof el.setSinkId !== "function") {
        this.teardownCueBus();
        return false;
      }
      await el.setSinkId(deviceId);
      void el.play().catch(() => {}); // best-effort; starts once the context is running
      return true;
    } catch (e) {
      console.warn("[htl] cue setSinkId failed:", e);
      this.teardownCueBus();
      return false;
    }
  }

  /** Disconnect + remove the cue bridge, reverting to single-output. Safe to call when
   *  nothing is built. cueMaster stays (dangling/silent) for the next time around. */
  /** Stop the engine's background timers (the sync phase-lock poll). For teardown /
   *  hot-reload so the interval doesn't leak. */
  dispose(): void {
    if (this.syncCorrectTimer != null) {
      clearInterval(this.syncCorrectTimer);
      this.syncCorrectTimer = null;
    }
  }

  private teardownCueBus(): void {
    if (this.cueStreamDest) {
      try {
        this.cueMaster.disconnect(this.cueStreamDest);
      } catch {
        /* wasn't connected — ignore */
      }
      this.cueStreamDest = null;
    }
    if (this.cueEl) {
      try {
        this.cueEl.pause();
        this.cueEl.srcObject = null;
        this.cueEl.remove();
      } catch {
        /* ignore */
      }
      this.cueEl = null;
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
  private syncCorrectTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly SYNC_TICK_MS = 80; // phase-lock poll period
  private static readonly SYNC_PHASE_K = 0.06; // P-gain: rate trim per beat of phase error (gentle, ~8 s time constant)

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
    // Releasing sync (or losing a grid) must drop any residual phase-lock trim so the
    // freed deck returns to its exact set tempo.
    if (this.slaveId == null) {
      this.deckA.setSyncTrim(0);
      this.deckB.setSyncTrim(0);
    }
  }

  // Continuous phase-lock for the SYNC pair. matchSlaveTempo keeps the AVERAGE tempos
  // equal, but the best-fit BPM is rounded (0.01) and dynamic beatgrids waver, so the
  // beat phase slides over minutes — the decks drift apart. Each tick we measure the
  // slave→master beat-phase error and ride a tiny rate trim (a first-order loop) that
  // eases it to zero, so they stay locked indefinitely. Skipped whenever the user owns
  // the slave's motion (jog / ear-bend) or a loop is deliberately offsetting the phase.
  private phaseCorrect() {
    const sid = this.slaveId;
    if (sid == null) return;
    const slave = this.deck(sid);
    const master = this.deck(other(sid));
    const sg = slave.beatgrid;
    const mg = master.beatgrid;
    if (!sg || !mg) return;
    if (!slave.playing || !master.playing) {
      slave.setSyncTrim(0); // nothing to lock to while stopped
      return;
    }
    if (slave.jogging || master.jogging || slave.bending || master.bending) return;
    if (slave.loop?.active || master.loop?.active) return; // a loop intentionally breaks phase
    // Beat-phase error in [−0.5, 0.5) beats (positive = slave is ahead of master).
    let err = beatPhase(sg, slave.position()) - beatPhase(mg, master.position());
    if (err > 0.5) err -= 1;
    else if (err < -0.5) err += 1;
    // First-order correction: ahead → trim slower (negative), behind → trim faster.
    slave.setSyncTrim(-err * AudioEngine.SYNC_PHASE_K);
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
    slave.setSyncTrim(0); // start the lock from zero; the corrector takes over from here

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

  /** position in [-1, 1]: -1 = full A, 0 = both, +1 = full B. Smoothed with a short time
   *  constant so a stepped value stream (a broadcast LISTENER gets the crossfade coalesced
   *  to ~20Hz — see the room digest roll-up) glides instead of zippering. 15ms is below the
   *  perceptual threshold, so a local DJ's own fader feels instant. */
  setCrossfade(position: number) {
    const x = (Math.max(-1, Math.min(1, position)) + 1) / 2; // -> [0,1]
    const t = this.ctx.currentTime;
    this.xfadeA.gain.setTargetAtTime(Math.cos((x * Math.PI) / 2), t, 0.015);
    this.xfadeB.gain.setTargetAtTime(Math.cos(((1 - x) * Math.PI) / 2), t, 0.015);
  }

  setMaster(gain: number) {
    this.master.gain.value = gain;
  }
}
