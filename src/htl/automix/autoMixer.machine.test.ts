import { describe, test, expect } from "vitest";
// STATE-MACHINE HARNESS for the AutoMixer. The pure helpers (decideLive/radioSeedSet/barsToSeconds)
// are unit-tested in autoMixer.test.ts; THIS file drives the whole tick() loop through a fake
// engine + queue and asserts the phase PATH and — the bug class the user hit — that liveId always
// follows the deck actually producing audio, never stranding on a deck nobody is hearing. It needs
// no AudioContext/DOM: the engine is reached only through injected deps, all faked here.
import { AutoMixer, type AutoMixerDeps } from "./autoMixer";
import type { AudioEngine, DeckId } from "../audio";
import type { MixQueue } from "./queue";
import type { TrackMeta } from "../library/types";
import type { AutoMixPhase } from "./types";

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
  setStemGain(): void {}
  resetEq(): void {}
  resetStems(): void {}
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

class Rig {
  engine = new FakeEngine();
  queue = new FakeQueue();
  mixer: AutoMixer;
  nowMs = 0;
  xfade = -1;
  autoAdvance = false; // advance playing decks' position each tick (playback simulation)
  deckTracks: Record<DeckId, TrackMeta | null> = { A: null, B: null };
  setups = new Map<string, Setup>();
  failLoads = new Set<string>(); // videoIds whose load resolves but never LANDS (un-loadable)
  liveHist: (DeckId | null)[] = [];
  phaseHist: AutoMixPhase[] = [];

  constructor() {
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
      stemsPending: () => false,
      onChange: () => {},
    };
    this.mixer = new AutoMixer(deps);
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
