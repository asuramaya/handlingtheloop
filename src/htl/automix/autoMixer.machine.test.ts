import { describe, test, expect, afterEach } from "vitest";
// STATE-MACHINE HARNESS for the AutoMixer. The pure helpers (decideLive/radioSeedSet/barsToSeconds)
// are unit-tested in autoMixer.test.ts; THIS file drives the whole tick() loop through a fake
// engine + queue and asserts the phase PATH and — the bug class the user hit — that liveId always
// follows the deck actually producing audio, never stranding on a deck nobody is hearing. It needs
// no AudioContext/DOM: the engine is reached only through injected deps, all faked here.
import { AutoMixer, type AutoMixerDeps } from "./autoMixer";
import type { AudioEngine, DeckId } from "../audio";
import type { MixQueue } from "./queue";
import type { TrackMeta } from "../library/types";
import type { AutoMixPhase, EnergyArc } from "./types";
import { gpuHeld } from "../stems/gpuQueue";

// ── fakes ──────────────────────────────────────────────────────────────────────────────────────

// Build a structurally-valid beatgrid so computeMixOut/computeMixIn/nearestBeat have real beats.
function mkGrid(bpm: number, dur: number): Record<string, unknown> {
  const beats: number[] = [];
  const spb = 60 / bpm;
  for (let t = 0; t < dur; t += spb) beats.push(t);
  return { bpm, firstBeat: 0, firstSound: 0, lastSound: dur * 0.95, beats, downbeat: 0 };
}

function mkTrack(videoId: string): TrackMeta {
  return { videoId, title: videoId, artist: "", duration: 0, thumbnail: null, views: null };
}

interface Setup {
  duration: number;
  bpm: number;
  hasStems: boolean;
}

class FakeDeck {
  playing = false;
  duration = 0;
  hasStems = false;
  keylock = true;
  effectiveBpm: number | undefined;
  beatgrid: Record<string, unknown> | null = null;
  private pos = 0;
  // DSP setters are no-ops we just record loosely (the blend math is ear-tested, not asserted here).
  tempo = 0;
  position(): number {
    return this.pos;
  }
  setPos(t: number): void {
    this.pos = t;
  }
  play(): void {
    this.playing = true;
  }
  pause(): void {
    this.playing = false;
  }
  seek(t: number): void {
    this.pos = t;
  }
  setTempo(v: number): void {
    this.tempo = v;
  }
  setPitch(): void {}
  keylockPinnedOff = false;
  setKeylock(v: boolean): void {
    this.keylock = v;
  }
  setKeylockPinnedOff(on: boolean): void {
    this.keylockPinnedOff = on;
    if (on) this.keylock = false;
  }
  setEqLow(): void {}
  setEqHigh(): void {}
  setFilter(): void {}
  // Stem gains ARE recorded — the stem race asserts that a degrade actually hands them back.
  stemGains: Record<string, number> = {};
  setStemGain(name: string, v: number): void {
    this.stemGains[name] = v;
  }
  resetEq(): void {}
  stemResets = 0;
  resetStems(): void {
    this.stemResets++;
    this.stemGains = {};
  }

  // ── gain staging ──
  loudness = 0.14; // the reference level, so an untouched deck needs no correction
  trim = 1;
  setTrim(g: number): void {
    this.trim = g;
  }

  // ── loops ──
  loopBeats = 0;
  setBeatLoop(b: number): void {
    this.loopBeats = b;
  }
  exitLoop(): void {
    this.loopBeats = 0;
  }
  spinbacks = 0;
  spinback(): void {
    this.spinbacks++;
  }
  cues = new Set<number>();
  slotIsSet(i: number): boolean {
    return this.cues.has(i);
  }
  hotCue(i: number): void {
    this.cues.add(i);
  }

  // ── a minimal FX rack: enough to build, find and route a stem chain ──
  rack = new FakeRack();
  addFxChain(name: string, stems = 0) {
    return this.rack.addChain(`c${this.rack.seq++}`, name, stems);
  }
  removeFxChain(id: string): boolean {
    return this.rack.removeChain(id);
  }
  setFxChainStems(id: string, stems: number): void {
    const c = this.rack.chain(id);
    if (c) c.stems = stems;
  }
  addFxTo(chainId: string, kind: string) {
    const c = this.rack.chain(chainId);
    if (!c || c.devices.some((d) => d.kind === kind)) return null;
    const d = mkDev(kind);
    c.devices.push(d);
    return d;
  }
}

interface FakeDev {
  kind: string;
  bypassed: boolean;
  params: Record<string, number>;
  setBypass(b: boolean, hard?: boolean): void;
  setParam(k: string, v: number): void;
  getParam(k: string): number;
  snapshotParams(): Record<string, number>;
}

function mkDev(kind: string): FakeDev {
  const d: FakeDev = {
    kind,
    bypassed: true, // the permanent bank sits DORMANT until thrown — same as the real rack
    params: { mix: 0.25 },
    setBypass(b) {
      d.bypassed = b;
    },
    setParam(k, v) {
      d.params[k] = v;
    },
    getParam(k) {
      return d.params[k] ?? 0;
    },
    snapshotParams: () => ({ ...d.params }),
  };
  return d;
}

interface FakeChain { id: string; name: string; stems: number; devices: FakeDev[]; master?: boolean }

class FakeRack {
  seq = 0;
  // Mirrors Deck.PERMANENT_KINDS: the whole pad-FX bank is always resident on the master chain.
  chains: FakeChain[] = [
    {
      id: "master",
      name: "MASTER",
      stems: 0,
      devices: ["eq", "delay", "reverb", "saturator", "crush", "mod", "gate", "noise", "comp"].map(mkDev),
      master: true,
    },
  ];
  device(addr: { chain: string; kind: string }): FakeDev | undefined {
    return this.chain(addr.chain)?.devices.find((d) => d.kind === addr.kind);
  }
  get chainList(): readonly FakeChain[] {
    return this.chains;
  }
  get allDevices() {
    return this.chains.flatMap((c) => c.devices);
  }
  chain(id: string): FakeChain | undefined {
    return this.chains.find((c) => c.id === id);
  }
  addChain(id: string, name: string, stems: number): FakeChain {
    const c: FakeChain = { id, name, stems, devices: [] };
    // Same one-owner partition the real rack enforces.
    for (const o of this.chains) if (!o.master) o.stems &= ~stems;
    this.chains.splice(this.chains.length - 1, 0, c);
    return c;
  }
  removeChain(id: string): boolean {
    const i = this.chains.findIndex((c) => c.id === id && !c.master);
    if (i < 0) return false;
    this.chains.splice(i, 1);
    return true;
  }
}

class FakeEngine {
  A = new FakeDeck();
  B = new FakeDeck();
  private syncSlave: Record<DeckId, boolean> = { A: false, B: false };
  private keySlave: Record<DeckId, boolean> = { A: false, B: false };
  deck(id: DeckId): FakeDeck {
    return id === "A" ? this.A : this.B;
  }
  syncRole(id: DeckId): string {
    return this.syncSlave[id] ? "slave" : "off";
  }
  keyRole(id: DeckId): string {
    return this.keySlave[id] ? "slave" : "off";
  }
  toggleSync(id: DeckId): void {
    this.syncSlave[id] = !this.syncSlave[id];
  }
  toggleKey(id: DeckId): void {
    this.keySlave[id] = !this.keySlave[id];
  }
  // The glide toggles this so SYNC drops its rubato feed-forward during a commanded tempo ramp.
  commandedRamp = false;
  setCommandedRamp(on: boolean): void {
    this.commandedRamp = on;
  }
}

// Minimal MixQueue: an ordered `upcoming` list + a `current`. ensureNext/peekNext read the head;
// advance pops it. No network — radio fill is irrelevant to the state-machine path under test.
class FakeQueue {
  upcoming: TrackMeta[] = [];
  current: TrackMeta | null = null;
  // The real MixQueue carries the arc, and startMix reads it to shape the gesture. Missing here,
  // `queue.arc` would be undefined and every shaped branch would silently take the neutral path —
  // a suite green for the wrong reason.
  arc: EnergyArc = "ride";
  removed: string[] = [];
  reseeds = 0;
  advance(): TrackMeta | null {
    const n = this.upcoming.shift() ?? null;
    if (n) this.current = n;
    return n;
  }
  peekNext(): TrackMeta | null {
    return this.upcoming[0] ?? null;
  }
  getCurrent(): TrackMeta | null {
    return this.current;
  }
  setCurrent(t: TrackMeta | null): void {
    this.current = t;
  }
  async ensureNext(): Promise<TrackMeta | null> {
    return this.upcoming[0] ?? null;
  }
  reseedRadio(): void {
    this.reseeds++;
  }
  remove(videoId: string): void {
    this.removed.push(videoId);
    this.upcoming = this.upcoming.filter((t) => t.videoId !== videoId);
  }
}

// Every Rig registers itself so afterEach can shut it down. The mixer holds a PROCESS-WIDE
// resource across a transition (the GPU quiet window — see stems/gpuQueue), and most tests here
// stop mid-transition on purpose. In the app that is fine: one mixer, alive for the session. In a
// test file it means each abandoned rig leaves its hold up, and the count only ever climbs — so
// the later tests that assert on gpuHeld() would read every earlier test's litter.
const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs) r.mixer.disable();
  rigs.length = 0;
});

class Rig {
  engine = new FakeEngine();
  perf: "subtle" | "standard" | "showy";
  autoFx = { stem: "vocals" as "vocals" | "other" | "drums" | "bass", seeded: false };
  queue = new FakeQueue();
  mixer: AutoMixer;
  nowMs = 0;
  xfade = -1;
  autoAdvance = false; // advance playing decks' position each tick (playback simulation)
  deckTracks: Record<DeckId, TrackMeta | null> = { A: null, B: null };
  setups = new Map<string, Setup>();
  failLoads = new Set<string>(); // videoIds whose load resolves but never LANDS (un-loadable)
  stemsPending = new Set<DeckId>(); // decks whose separation is still in flight
  liveHist: (DeckId | null)[] = [];
  phaseHist: AutoMixPhase[] = [];
  warmed: string[] = []; // videoIds handed to warmStems, in order
  gpuHeldHist: boolean[] = []; // gpuHeld() sampled after each tick, alongside phaseHist

  constructor(perf: "subtle" | "standard" | "showy" = "standard") {
    this.perf = perf;
    const deps: AutoMixerDeps = {
      engine: this.engine as unknown as AudioEngine,
      queue: this.queue as unknown as MixQueue,
      loadDeck: async (id, track) => {
        // Mirrors loadTrackToDeck: resolves even on failure. A failLoads track does NOT land.
        if (this.failLoads.has(track.videoId)) return;
        this.deckTracks[id] = track;
        this.applySetup(id, track.videoId);
        this.engine.deck(id).setPos(0);
      },
      deckTrack: (id) => this.deckTracks[id],
      applyCrossfade: (x) => {
        this.xfade = x;
      },
      getCrossfade: () => this.xfade,
      now: () => this.nowMs,
      stemsPending: (id) => this.stemsPending.has(id),
      performance: () => this.perf,
      autoFx: () => this.autoFx,
      onAutoFxSeeded: () => {
        this.autoFx = { ...this.autoFx, seeded: true };
      },
      warmStems: (vid) => {
        this.warmed.push(vid);
      },
      onChange: () => {},
    };
    this.mixer = new AutoMixer(deps);
    rigs.push(this);
  }

  private applySetup(id: DeckId, videoId: string): void {
    const s = this.setups.get(videoId);
    if (!s) return;
    const d = this.engine.deck(id);
    d.duration = s.duration;
    d.hasStems = s.hasStems;
    d.effectiveBpm = s.bpm;
    d.beatgrid = mkGrid(s.bpm, s.duration);
  }

  setup(videoId: string, s: Setup): void {
    this.setups.set(videoId, s);
  }

  // Simulate the USER (or UI) loading + starting a deck directly — the manual input the mixer
  // must reconcile against, bypassing the mixer entirely.
  loadAndPlay(id: DeckId, track: TrackMeta): void {
    this.deckTracks[id] = track;
    this.applySetup(id, track.videoId);
    this.engine.deck(id).play();
  }

  pause(id: DeckId): void {
    this.engine.deck(id).pause();
  }
  setPos(id: DeckId, t: number): void {
    this.engine.deck(id).setPos(t);
  }

  async tick(dtMs = 150): Promise<void> {
    this.nowMs += dtMs;
    if (this.autoAdvance) {
      for (const id of ["A", "B"] as DeckId[]) {
        const d = this.engine.deck(id);
        if (d.playing) d.setPos(d.position() + dtMs / 1000);
      }
    }
    await this.mixer.tick();
    // tick() fires preload/advance/fill as `void`-ed promises; drain them so their loads land
    // before we assert (a single macrotask boundary flushes all chained microtasks).
    await new Promise((r) => setTimeout(r, 0));
    const s = this.mixer.getStatus();
    this.liveHist.push(s.liveDeck);
    this.phaseHist.push(s.phase);
    this.gpuHeldHist.push(gpuHeld());
  }

  get live(): DeckId | null {
    return this.mixer.getStatus().liveDeck;
  }
  get phase(): AutoMixPhase {
    return this.mixer.getStatus().phase;
  }
}

// ── tests ──────────────────────────────────────────────────────────────────────────────────────

describe("AutoMixer machine — adoption & reconcile", () => {
  test("kickoff: both decks empty + a queued track → loads A, plays it, arms", async () => {
    const r = new Rig();
    const t1 = mkTrack("t1");
    r.setup("t1", { duration: 100, bpm: 120, hasStems: false });
    r.queue.upcoming = [t1];
    r.mixer.enable();
    await r.tick();
    expect(r.deckTracks.A).toBe(t1);
    expect(r.engine.A.playing).toBe(true);
    expect(r.live).toBe("A");
    expect(r.phase).not.toBe("idle");
  });

  test("adopts the deck already playing when enabled", async () => {
    const r = new Rig();
    r.setup("t1", { duration: 100, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.mixer.enable();
    await r.tick();
    expect(r.live).toBe("A");
  });

  test("THE BUG: armed on A, user starts deck B → liveId follows B, never strands on A", async () => {
    const r = new Rig();
    r.setup("t1", { duration: 100, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 100, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.mixer.enable();
    await r.tick();
    expect(r.live).toBe("A");

    // User drops a track on B and starts it (now BOTH play). Pre-fix this stayed "A" and stalled.
    r.loadAndPlay("B", mkTrack("t2"));
    await r.tick();
    expect(r.live).toBe("B");

    // And it STAYS on B across further ticks — no flip-back, no stall till A ends.
    await r.tick();
    await r.tick();
    expect(r.live).toBe("B");
  });

  test("symmetric: live on B, user starts deck A → follows A", async () => {
    const r = new Rig();
    r.setup("t1", { duration: 100, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 100, bpm: 120, hasStems: false });
    r.loadAndPlay("B", mkTrack("t2"));
    r.mixer.enable();
    await r.tick();
    expect(r.live).toBe("B");
    r.loadAndPlay("A", mkTrack("t1"));
    await r.tick();
    expect(r.live).toBe("A");
  });

  test("recovery: live on A, A stops while B plays → follows B", async () => {
    const r = new Rig();
    r.setup("t1", { duration: 100, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 100, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.mixer.enable();
    await r.tick();
    r.loadAndPlay("B", mkTrack("t2"));
    r.pause("A"); // user kills the old deck
    await r.tick();
    expect(r.live).toBe("B");
  });

  test("a PAUSE is not a skip: holds the live deck, never auto-advances the queue", async () => {
    const r = new Rig();
    const t2 = mkTrack("t2");
    r.setup("t1", { duration: 100, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 100, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [t2];
    r.mixer.enable();
    await r.tick();
    r.pause("A");
    r.setPos("A", 10); // mid-track, NOT near the musical end
    await r.tick();
    await r.tick();
    expect(r.live).toBe("A"); // still the live deck — a pause holds, never skips
    expect(r.engine.B.playing).toBe(false); // the idle deck was NOT auto-started
    expect(r.queue.upcoming).toEqual([t2]); // queue not advanced/consumed
    expect(r.queue.current?.videoId).toBe("t1"); // "now playing" unchanged
    // (deckTracks.B MAY hold t2 here — that's the eager preload decoding ahead, not a skip.)
  });

  test("natural end → autoplay-continues onto the free deck", async () => {
    const r = new Rig();
    const t2 = mkTrack("t2");
    r.setup("t1", { duration: 100, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 100, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [t2];
    r.mixer.enable();
    await r.tick();
    // A reaches its musical end (past lastSound) and stops.
    r.pause("A");
    r.setPos("A", 99);
    await r.tick();
    expect(r.deckTracks.B).toBe(t2);
    expect(r.engine.B.playing).toBe(true);
    expect(r.live).toBe("B");
    expect(r.queue.upcoming).toEqual([]); // consumed
  });

  test("un-loadable next track is dropped from the queue after MAX_LOAD_FAILS, not retried forever", async () => {
    const r = new Rig();
    const bad = mkTrack("bad");
    r.setup("t1", { duration: 100, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [bad];
    r.failLoads.add("bad"); // load resolves but never lands
    r.mixer.enable();
    // Eager preload keeps trying to put `bad` on the idle deck; after 2 non-landings it's dropped.
    for (let i = 0; i < 5; i++) await r.tick();
    expect(r.queue.removed).toContain("bad");
    expect(r.deckTracks.B).toBeNull(); // never falsely latched as loaded
  });
});

describe("AutoMixer machine — full transition path", () => {
  test("armed → preload → cueing → mixing → settle, with liveId flipping A → B", async () => {
    const r = new Rig();
    const t2 = mkTrack("t2");
    r.setup("t1", { duration: 60, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 60, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [t2];
    r.autoAdvance = true; // let playback drive the deck toward its mix-out
    r.mixer.enable();

    // Drive until the transition completes (back to armed with B live), or bail after a generous cap.
    let settledOnB = false;
    for (let i = 0; i < 600; i++) {
      await r.tick(500); // dt capped at 0.5s in tick(); fewer iterations
      if (r.live === "B" && r.phase === "armed") {
        settledOnB = true;
        break;
      }
    }

    expect(settledOnB).toBe(true);
    // The whole phase path was actually traversed — not a shortcut.
    expect(r.phaseHist).toContain("preload");
    expect(r.phaseHist).toContain("cueing");
    expect(r.phaseHist).toContain("mixing");
    // The incoming deck is now the live one, playing its own track.
    expect(r.live).toBe("B");
    expect(r.engine.B.playing).toBe(true);
    expect(r.deckTracks.B).toBe(t2);
    expect(r.engine.A.playing).toBe(false); // outgoing paused at settle
  });

  test("the glide holds commandedRamp through the fade, then clears it (no rubato-FF fight → no mid-fade tempo jumps)", async () => {
    // The glide ramps the master's tempo OFF its grid. SYNC's phase-lock has a grid-rubato
    // feed-forward that assumes grid-natural playback; left on during a commanded ramp it fights the
    // ramp and the slave's trim oscillates — the random tempo jumps mid-fade. beginGlide must raise
    // commandedRamp for the whole blend and endGlide must clear it at settle.
    const r = new Rig();
    const t2 = mkTrack("t2");
    r.setup("t1", { duration: 60, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 60, bpm: 128, hasStems: false }); // a real tempo gap → the glide has something to ramp
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [t2];
    r.autoAdvance = true;
    r.mixer.enable();

    let sawRampDuringMix = false;
    let settledOnB = false;
    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      if (r.phase === "mixing") sawRampDuringMix ||= r.engine.commandedRamp;
      if (r.live === "B" && r.phase === "armed") {
        settledOnB = true;
        break;
      }
    }
    expect(settledOnB).toBe(true);
    expect(sawRampDuringMix).toBe(true); // feed-forward suppressed for the whole ramp
    expect(r.engine.commandedRamp).toBe(false); // …re-armed to normal beatmatch once the fade ended
  });

  test("a non-key-matched glide pins keylock OFF during the blend, then restores it after", async () => {
    const r = new Rig();
    // Harmonically DISTANT keys → pickTransition keyMatch=false → the glide drops keylock for the
    // vinyl pitch ride, and must PIN it off so a stray setPitch can't silently re-freeze the ramp.
    const t1 = { ...mkTrack("t1"), key: "8A" };
    const t2 = { ...mkTrack("t2"), key: "2A" };
    r.setup("t1", { duration: 60, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 60, bpm: 120, hasStems: false });
    r.engine.A.keylock = true; // baseline (the default) — restored after the transition
    r.engine.B.keylock = true;
    r.loadAndPlay("A", t1);
    r.queue.upcoming = [t2];
    r.autoAdvance = true;
    r.mixer.enable();

    let pinnedDuringMix = false;
    let settledOnB = false;
    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      if (r.phase === "mixing" && r.engine.A.keylockPinnedOff && r.engine.B.keylockPinnedOff) pinnedDuringMix = true;
      if (r.live === "B" && r.phase === "armed") {
        settledOnB = true;
        break;
      }
    }

    expect(settledOnB).toBe(true);
    expect(pinnedDuringMix).toBe(true); // pinned off for the ride (blocks the setPitch re-engage freeze)
    // After the transition: the pin is cleared and the pre-glide keylock (ON) is restored on both.
    expect(r.engine.A.keylockPinnedOff).toBe(false);
    expect(r.engine.B.keylockPinnedOff).toBe(false);
    expect(r.engine.A.keylock).toBe(true);
    expect(r.engine.B.keylock).toBe(true);
  });

  test("user grabs the crossfader mid-mix → mixer hands off to manual, then re-adopts the survivor", async () => {
    const r = new Rig();
    const t2 = mkTrack("t2");
    r.setup("t1", { duration: 60, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 60, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [t2];
    r.autoAdvance = true;
    r.mixer.enable();

    // Drive into the mixing phase.
    let mixing = false;
    for (let i = 0; i < 400; i++) {
      await r.tick(500);
      if (r.phase === "mixing") {
        mixing = true;
        break;
      }
    }
    expect(mixing).toBe(true);

    // User yanks the crossfader hard → manual takeover.
    r.xfade = 1;
    await r.tick(500);
    expect(r.phase).toBe("manual");

    // User lands on a single deck (stops A); the mixer adopts the survivor (B) and re-arms.
    r.pause("A");
    await r.tick(500);
    expect(r.live).toBe("B");
    expect(r.phase).toBe("armed");
  });
});

// ── THE STEM RACE ───────────────────────────────────────────────────────────────────────────────
// Whether the incoming track is separated by mix time is a genuine race, and it used to be
// resolved exactly once at startMix. These drive a real transition and flip stem availability
// underneath it, which is the thing that actually happens on a slow separation or a mobile OOM.
describe("AutoMixer machine — the stem race", () => {
  // Run a transition, calling `during` on every tick that is in the mixing phase.
  async function mix(r: Rig, during: (r: Rig) => void): Promise<boolean> {
    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      if (r.phase === "mixing") during(r);
      if (r.live === "B" && r.phase === "armed") return true;
    }
    return false;
  }

  function rig(aStems: boolean, bStems: boolean): Rig {
    const r = new Rig();
    r.setup("t1", { duration: 60, bpm: 120, hasStems: aStems });
    r.setup("t2", { duration: 60, bpm: 120, hasStems: bStems });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [mkTrack("t2")];
    r.autoAdvance = true;
    r.mixer.enable();
    return r;
  }

  test("stems that arrive EARLY in the blend upgrade it to a stem swap", async () => {
    const r = rig(true, false); // outgoing separated, incoming not — starts as an EQ blend
    let upgraded = false;
    const done = await mix(r, (rr) => {
      // Separation lands the moment the blend begins, i.e. before the bass swap.
      rr.engine.B.hasStems = true;
      if (rr.mixer.getStatus().plan?.style === "stemswap") upgraded = true;
    });
    expect(done).toBe(true);
    expect(upgraded).toBe(true);
  });

  // ★ The constraint that makes the upgrade safe. After the bass swap has begun, the low end is
  // part-way across on the EQ path; switching to stem gains there would jump it.
  test("stems that arrive LATE do not upgrade — the low end is already crossing", async () => {
    const r = rig(true, false);
    let sawStemswap = false;
    let heldPast = false;
    const done = await mix(r, (rr) => {
      const st = rr.mixer.getStatus();
      // Blend progress, read exactly off the crossfader: with A live the ramp runs −1 → +1, so
      // p = (x + 1) / 2. Gating the test on the SAME quantity the guard uses makes it deterministic
      // rather than a guess about how many ticks a blend takes.
      const progress = (rr.xfade + 1) / 2;
      const swapStart = (st.plan?.bassSwapBar ?? 0) / Math.max(1, st.plan?.bars ?? 1);
      if (progress > swapStart + 0.1) {
        heldPast = true;
        rr.engine.B.hasStems = true; // separation finishes only now — too late to switch cleanly
      }
      if (st.plan?.style === "stemswap") sawStemswap = true;
    });
    expect(done).toBe(true);
    expect(heldPast).toBe(true); // the scenario actually happened
    expect(sawStemswap).toBe(false); // …and the mixer declined to upgrade
  });

  test("stems LOST mid-blend degrade to an EQ blend and hand the stem gains back", async () => {
    const r = rig(true, true); // both separated — starts as a stem swap
    let sawStemswap = false;
    let degraded = false;
    const done = await mix(r, (rr) => {
      const style = rr.mixer.getStatus().plan?.style;
      if (style === "stemswap") {
        sawStemswap = true;
        rr.engine.B.hasStems = false; // mobile drops the buffer under memory pressure
      } else if (sawStemswap && style === "blend") {
        degraded = true;
      }
    });
    expect(done).toBe(true);
    expect(sawStemswap).toBe(true);
    expect(degraded).toBe(true);
    // resetStems() was called on the way down, so no half-applied stem mix is left behind.
    expect(r.engine.A.stemResets).toBeGreaterThan(0);
  });

  test("a transition where stems never arrive is a plain blend, start to finish", async () => {
    const r = rig(false, false);
    const styles = new Set<string>();
    const done = await mix(r, (rr) => {
      const s = rr.mixer.getStatus().plan?.style;
      if (s) styles.add(s);
    });
    expect(done).toBe(true);
    expect(styles.has("stemswap")).toBe(false);
  });
});

// ── AUTO-owned FX + loops ───────────────────────────────────────────────────────────────────────
// The auto-mixer borrows the user's decks. Everything it builds for a transition has to be gone
// afterwards — that is the whole contract, and these are the leaks that would break it.
describe("AutoMixer machine — nothing is left behind", () => {
  function rig(stems: boolean): Rig {
    const r = new Rig();
    r.setup("t1", { duration: 60, bpm: 120, hasStems: stems });
    r.setup("t2", { duration: 60, bpm: 120, hasStems: stems });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [mkTrack("t2")];
    r.autoAdvance = true;
    r.mixer.enable();
    return r;
  }

  // The AUTO chain is NOT torn down — it is the user's and it persists. What must not survive is
  // the stem CLAIM: a chain still holding a stem after settle would keep the effect in the signal
  // path over the next track.
  test("the AUTO chain keeps hearing nothing once the transition is over", async () => {
    const r = rig(true);
    let routedDuringMix = false;
    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      const c = r.engine.A.rack.chains.find((x) => x.name === "AUTO");
      if (r.phase === "mixing" && (c?.stems ?? 0) !== 0) routedDuringMix = true;
      if (r.live === "B" && r.phase === "armed") break;
    }
    expect(routedDuringMix).toBe(true);
    for (const id of ["A", "B"] as const) {
      const c = r.engine[id].rack.chains.find((x) => x.name === "AUTO");
      if (c) expect(c.stems).toBe(0);
    }
  });

  test("claiming the VOICE stem gives it back to the user's chain afterwards", async () => {
    const r = rig(true);
    // The user owns a stem chain holding VOICE (4) + INST (8) before AUTO touches anything.
    const user = r.engine.A.addFxChain("MY VOX", 0b1100);
    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      if (r.live === "B" && r.phase === "armed") break;
    }
    expect(r.engine.A.rack.chain(user.id)?.stems).toBe(0b1100);
  });

  test("no deck is left looping after a transition", async () => {
    const r = rig(false);
    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      if (r.live === "B" && r.phase === "armed") break;
    }
    expect(r.engine.A.loopBeats).toBe(0);
    expect(r.engine.B.loopBeats).toBe(0);
  });

  // Disabling AUTO mid-transition is the harshest teardown path there is.
  test("disable() mid-mix leaves no chain, no loop and no trim behind", async () => {
    const r = rig(true);
    // A genuinely quiet master, so gain staging has something to correct and the restore is a
    // real assertion rather than a coincidence of both values being 1.
    r.engine.A.loudness = 0.05;
    r.engine.B.loudness = 0.05;
    let trimmedDuring = false;
    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      if (r.engine.A.trim !== 1 || r.engine.B.trim !== 1) trimmedDuring = true;
      if (r.phase === "mixing") break;
    }
    expect(trimmedDuring).toBe(true); // AUTO did level the channels
    r.mixer.disable();
    // The AUTO chain stays — it is the user's — but it must not be left hearing a stem.
    for (const id of ["A", "B"] as const) {
      const c = r.engine[id].rack.chains.find((x) => x.name === "AUTO");
      if (c) expect(c.stems).toBe(0);
    }
    expect(r.engine.A.loopBeats).toBe(0);
    expect(r.engine.A.trim).toBe(1); // …and handed them back at unity
    expect(r.engine.B.trim).toBe(1);
  });

  // The other half of the gain-staging contract: a hand on the knob outranks AUTO permanently.
  test("a trim the user moves is never touched again", async () => {
    const r = rig(false);
    r.engine.A.loudness = 0.05;
    for (let i = 0; i < 20; i++) await r.tick(500);
    const auto = r.engine.A.trim;
    expect(auto).not.toBe(1); // AUTO owns it at this point
    r.engine.A.setTrim(0.33); // the user reaches over mid-set
    for (let i = 0; i < 40; i++) await r.tick(500);
    expect(r.engine.A.trim).toBe(0.33);
    r.mixer.disable();
    expect(r.engine.A.trim).toBe(0.33); // not even reset on the way out — it is theirs now
  });
});

// ── EFFECTS WITHOUT STEMS ───────────────────────────────────────────────────────────────────────
// Separation is optional and often late, so the gestures that give a transition its character are
// built from the channel FX bank and the loop engine — both of which every deck always has. These
// drive real transitions on decks with NO stems at all and assert that something actually happened
// to the audio, and that everything borrowed came back.
describe("AutoMixer machine — effects carry a stem-free transition", () => {
  function rig(perf: "subtle" | "standard" | "showy" = "showy"): Rig {
    const r = new Rig(perf);
    r.setup("t1", { duration: 60, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 60, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [mkTrack("t2")];
    r.autoAdvance = true;
    r.mixer.enable();
    return r;
  }

  async function run(r: Rig, during: (r: Rig) => void = () => {}): Promise<boolean> {
    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      if (r.phase === "mixing") during(r);
      if (r.live === "B" && r.phase === "armed") return true;
    }
    return false;
  }

  // A well-matched pair SHOULD get a long blend — that is correct, not a failure of imagination.
  // What must not happen is every transition being the same one, so this runs several in a row on
  // one mixer (which is what carries `lastStyle`) and asks for variety across them.
  test("consecutive transitions do not all come out the same", async () => {
    const r = new Rig("showy");
    for (let i = 1; i <= 5; i++) r.setup(`t${i}`, { duration: 60, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [mkTrack("t2"), mkTrack("t3"), mkTrack("t4"), mkTrack("t5")];
    r.autoAdvance = true;
    r.mixer.enable();

    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      await r.tick(500);
      const s = r.mixer.getStatus().plan?.style;
      if (r.phase === "mixing" && s) seen.add(s);
      if (seen.size >= 2) break;
    }
    expect(seen.has("stemswap")).toBe(false); // no stems anywhere
    expect(seen.size).toBeGreaterThan(1); // it did not just blend every time
  });

  // A pair whose tempos genuinely clash is where the effects have to carry the change — there is
  // no beatmatch to hide behind.
  test("a clashing pair reaches for an effect gesture, and borrows the device to do it", async () => {
    const r = new Rig("showy");
    r.setup("t1", { duration: 60, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 60, bpm: 175, hasStems: false }); // no octave fold rescues this
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [mkTrack("t2")];
    r.autoAdvance = true;
    r.mixer.enable();

    const delay = r.engine.A.rack.device({ chain: "master", kind: "delay" })!;
    delay.setParam("mix", 0.33);
    delay.setParam("feedback", 0.11);
    const wasBypassed = delay.bypassed;

    let engagedSomething = false;
    let style: string | undefined;
    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      if (r.phase === "mixing") {
        style = r.mixer.getStatus().plan?.style;
        for (const d of r.engine.A.rack.chain("master")!.devices) if (!d.bypassed) engagedSomething = true;
      }
      if (r.live === "B" && r.phase === "armed") break;
    }

    expect(style).not.toBe("blend"); // a clash is never blended
    expect(engagedSomething).toBe(true); // an effect actually fired
    // …and the user's delay is back exactly as they left it.
    expect(delay.bypassed).toBe(wasBypassed);
    expect(delay.params.mix).toBeCloseTo(0.33, 6);
    expect(delay.params.feedback).toBeCloseTo(0.11, 6);
  });

  test("every FX device on both decks is dormant again once the transition settles", async () => {
    const r = rig();
    await run(r);
    for (const id of ["A", "B"] as const) {
      for (const d of r.engine[id].rack.chain("master")!.devices) {
        expect(d.bypassed).toBe(true);
      }
    }
  });

  // loopChop is the one gesture that needs no FX device at all — just the loop engine and a filter.
  test("a loop-driven gesture never leaves the outgoing deck looping", async () => {
    const r = rig();
    let looped = false;
    await run(r, (rr) => {
      if (rr.engine.A.loopBeats > 0) looped = true;
    });
    expect(r.engine.A.loopBeats).toBe(0);
    expect(r.engine.B.loopBeats).toBe(0);
    void looped; // whether a loop gesture was CHOSEN is up to resolveStyle; the release is not
  });

  test("under 'subtle' the mixer still completes transitions and leaves nothing engaged", async () => {
    const r = rig("subtle");
    expect(await run(r)).toBe(true);
    for (const d of r.engine.A.rack.chain("master")!.devices) expect(d.bypassed).toBe(true);
    expect(r.engine.A.loopBeats).toBe(0);
  });
});

// ── THE AUTO CHAIN ─────────────────────────────────────────────────────────────────────────────
// AUTO's transition effect is not AUTO's. It is a real, persistent chain in the user's rack named
// AUTO, which they edit like any other; AUTO only ROUTES a stem into it for the length of a
// transition and releases it at settle. So there is nothing to arbitrate — whatever they dialled is
// what plays — and the chain, and their edits, outlive the mix.
describe("AutoMixer machine — the AUTO chain is the user's", () => {
  function rig(): Rig {
    const r = new Rig("standard");
    for (const t of ["t1", "t2", "t3"]) r.setup(t, { duration: 60, bpm: 120, hasStems: true });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [mkTrack("t2"), mkTrack("t3")];
    r.autoAdvance = true;
    r.mixer.enable();
    return r;
  }

  const autoChain = (r: Rig, id: "A" | "B") => r.engine[id].rack.chains.find((c) => c.name === "AUTO");

  // Direction-agnostic: a set alternates A→B→A, so waiting for "B is live" only ever catches the
  // first transition. Wait for the live deck to CHANGE and settle.
  async function transition(r: Rig, during: (r: Rig) => void = () => {}): Promise<boolean> {
    const from = r.live;
    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      if (r.phase === "mixing") during(r);
      if (r.live !== from && r.phase === "armed") return true;
    }
    return false;
  }

  test("seeds ONE chain named AUTO, with a starting device, and reports it so it is never re-offered", async () => {
    const r = rig();
    await transition(r);
    const c = autoChain(r, "A");
    expect(c).toBeDefined();
    expect(c!.devices.length).toBeGreaterThan(0);
    expect(r.autoFx.seeded).toBe(true);
  });

  // ★ The chain PERSISTS. That is the whole point: it outlives the transition, so the user's edits
  // to it stick and editing it mid-mix is coherent.
  test("the chain survives the transition — only the stem routing is transient", async () => {
    const r = rig();
    let routedDuring = false;
    await transition(r, (rr) => {
      if ((autoChain(rr, "A")?.stems ?? 0) !== 0) routedDuring = true;
    });
    expect(routedDuring).toBe(true); // it heard the stem while the mix ran
    expect(autoChain(r, "A")).toBeDefined(); // …and it is still there afterwards
    expect(autoChain(r, "A")!.stems).toBe(0); // …silent again, claiming nothing
  });

  test("routes the stem the settings name", async () => {
    const r = rig();
    r.autoFx = { stem: "drums", seeded: false };
    let sawBit = 0;
    await transition(r, (rr) => {
      sawBit |= autoChain(rr, "A")?.stems ?? 0;
    });
    expect(sawBit).toBe(0b0001);
  });

  // AUTO must never write a device param — the user's dial is the truth.
  test("never touches what is in the chain", async () => {
    const r = rig();
    await transition(r); // seeds it
    const dev = autoChain(r, "A")!.devices[0];
    dev.setParam("mix", 0.17);
    dev.setBypass(false);
    await transition(r); // a second transition routes through it again
    expect(dev.params.mix).toBeCloseTo(0.17, 6);
  });

  // Deleting the chain IS how the tail is turned off — a mixer that put it back would be arguing.
  test("a deleted AUTO chain is not recreated, and the mix still completes", async () => {
    const r = rig();
    await transition(r);
    const c = autoChain(r, "A")!;
    r.engine.A.removeFxChain(c.id);
    r.autoFx = { ...r.autoFx, seeded: true };
    expect(await transition(r)).toBe(true);
    expect(autoChain(r, "A")).toBeUndefined();
  });

  test("a stem it borrows is handed back to whoever held it", async () => {
    const r = rig();
    const user = r.engine.A.addFxChain("MY VOX", 0b1100); // VOICE + INST
    await transition(r);
    expect(r.engine.A.rack.chain(user.id)?.stems).toBe(0b1100);
  });
});

// ── the separation schedule ────────────────────────────────────────────────────────────────────
// Two rules, both about WHEN the GPU is allowed to be busy rather than what it computes:
//   • warm the track after next, so separation has two tracks of lead instead of one;
//   • and never START one during a transition, when a dropped frame is actually visible.
describe("AutoMixer — the separation schedule", () => {
  test("warms the track AFTER next, not the one being preloaded", async () => {
    const r = new Rig();
    const [t2, t3] = [mkTrack("t2"), mkTrack("t3")];
    for (const v of ["t1", "t2", "t3"]) r.setup(v, { duration: 100, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [t2, t3];
    r.mixer.enable();
    await r.tick();
    await r.tick();
    // t2 goes to the idle DECK (ensurePreload separates it there); t3 is the one nothing else owns.
    expect(r.warmed).toContain("t3");
    expect(r.warmed).not.toContain("t2");
  });

  test("does not re-ask for the same track on every 150ms tick", async () => {
    const r = new Rig();
    const [t2, t3] = [mkTrack("t2"), mkTrack("t3")];
    for (const v of ["t1", "t2", "t3"]) r.setup(v, { duration: 100, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [t2, t3];
    r.mixer.enable();
    for (let i = 0; i < 20; i++) await r.tick();
    expect(r.warmed.filter((v) => v === "t3")).toHaveLength(1);
  });

  test("nothing to warm when the queue holds only the next track", async () => {
    const r = new Rig();
    const t2 = mkTrack("t2");
    for (const v of ["t1", "t2"]) r.setup(v, { duration: 100, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [t2];
    r.mixer.enable();
    for (let i = 0; i < 5; i++) await r.tick();
    expect(r.warmed).toEqual([]);
  });

  // ★ THE LAG FIX. The hold must be up for the whole visible part of the transition and DOWN
  // again by the time the mixer is armed on the new deck — a leaked hold starves separation for
  // the rest of the session, which is worse than the jank it was fixing.
  test("holds the GPU across the transition and releases it at settle", async () => {
    const r = new Rig();
    const t2 = mkTrack("t2");
    r.setup("t1", { duration: 60, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 60, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [t2];
    r.autoAdvance = true;
    r.mixer.enable();

    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      if (r.live === "B" && r.phase === "armed") break;
    }
    expect(r.live).toBe("B");

    // Held during cueing and mixing…
    const heldDuring = r.phaseHist
      .map((p, i) => ({ p, held: r.gpuHeldHist[i] }))
      .filter((x) => x.p === "cueing" || x.p === "mixing");
    expect(heldDuring.length).toBeGreaterThan(0);
    expect(heldDuring.every((x) => x.held)).toBe(true);
    // …and released by the time we are armed again on the new deck.
    expect(gpuHeld()).toBe(false);
  });

  test("a cancelled mix releases the hold too (the mixing branch never reaches abandonCue)", async () => {
    const r = new Rig();
    const t2 = mkTrack("t2");
    r.setup("t1", { duration: 60, bpm: 120, hasStems: false });
    r.setup("t2", { duration: 60, bpm: 120, hasStems: false });
    r.loadAndPlay("A", mkTrack("t1"));
    r.queue.upcoming = [t2];
    r.autoAdvance = true;
    r.mixer.enable();

    let reachedMixing = false;
    for (let i = 0; i < 600; i++) {
      await r.tick(500);
      if (r.phase === "mixing") {
        reachedMixing = true;
        break;
      }
    }
    expect(reachedMixing).toBe(true);
    expect(gpuHeld()).toBe(true);
    r.mixer.disable(); // → cancel() from inside the mixing branch
    expect(gpuHeld()).toBe(false);
  });
});
