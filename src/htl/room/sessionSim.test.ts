import { describe, it, expect } from "vitest";
import {
  decideTickResync,
  decideSnapshotDeck,
  isSocketStale,
  RESYNC_STUCK_MS,
} from "./sessionFollow";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Fault-injection session SIMULATION — the automated counterpart to the broadcast load harness
// (scripts/loadtest-room.mjs), but for CORRECTNESS under adverse networks instead of scale. It
// models one shared session (a host + N followers) and drives the REAL decision functions from
// sessionFollow.ts (decideTickResync ①, isSocketStale ②, decideSnapshotDeck) through a channel that
// can DROP / STALL / go HALF-OPEN per follower — then asserts the two invariants the divergence fix
// must guarantee, across many fuzzed fault patterns, deterministically (seeded, no network):
//
//   SAFETY    — a follower NEVER drives a deck whose loaded track ≠ the track the anchor is ticking
//               (the "shared board, wrong song" guarantee).
//   LIVENESS  — after the faults stop, every follower CONVERGES to the anchor's track within bound.
//
// The wiring (load timing, supersession, reconnect→request-state) is MODELLED; the decisions are the
// real shipped code. A regression SENTINEL (fixes disabled) proves the harness actually detects the
// bug — otherwise "it converged" would be vacuous. See htl-session-divergence-fix.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// Deterministic RNG so a failing fuzz seed is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEP_MS = 50; //        sim resolution
const TICK_MS = 250; //       anchor tick cadence (4/s — matches App.buildTick)
const WATCHDOG_MS = 2000; //  follower liveness check
const STALE_MS = 6000; //     no-inbound → half-open (matches RoomClient.STALE_MS)
const LOAD_MS = 1500; //      modelled decode time for a track on the follower
const RECONNECT_MS = 800; //  reconnect + welcome + request-state round-trip

type Msg = { kind: "tick"; vid: string | null } | { kind: "load"; vid: string } | { kind: "snapshot"; vid: string | null };

interface GuestFault {
  dropP: number; //          per-message drop probability (lossy link)
  latencyMs: number; //      delivery latency
  halfOpenAt: number | null; // time the current socket goes DEAD (delivers nothing until a reconnect)
  faultsEndAt: number; //    after this, the link is clean (lossy stops; a reconnect heals half-open)
}

class Guest {
  loadedVid: string | null = null;
  loadingVid = "";
  roomLoadTarget: string | null = null;
  loadDoneAt = Infinity; // when the in-flight load lands
  reconciledTarget: string | null = null;
  resyncAt = -1e9;
  lastRecvAt = 0;
  socketDead = false; // half-open: the live socket delivers nothing until a reconnect
  inbox: { at: number; msg: Msg }[] = [];
  // Telemetry the assertions read:
  droveMismatch = false; // SAFETY: ever drove a deck whose loadedVid ≠ the tick's vid
  constructor(
    readonly fault: GuestFault,
    readonly rng: () => number,
    readonly tickVidEnabled: boolean, // ① on/off (anchor stamps vid)
    readonly watchdogEnabled: boolean, // ② on/off (half-open detection)
  ) {}

  // Host emits a message → schedule its arrival unless the socket is dead or the link drops it.
  recv(msg: Msg, now: number): void {
    if (this.socketDead) return; // half-open: nothing gets through this socket
    if (now < this.fault.faultsEndAt && this.rng() < this.fault.dropP) return; // lossy drop
    this.inbox.push({ at: now + this.fault.latencyMs, msg });
  }

  private runRoomLoad(vid: string, now: number): void {
    this.roomLoadTarget = vid;
    this.loadingVid = vid;
    this.loadDoneAt = now + LOAD_MS; // models the async fetch+decode
    this.reconciledTarget = null;
  }

  // Watchdog + in-flight-load completion + inbox draining for this step.
  step(now: number, anchorPresent: boolean, requestState: (g: Guest, now: number) => void): void {
    // Half-open onset.
    if (this.fault.halfOpenAt != null && now >= this.fault.halfOpenAt && now < this.fault.faultsEndAt) this.socketDead = true;

    // A finished load lands.
    if (this.loadingVid && now >= this.loadDoneAt) {
      this.loadedVid = this.loadingVid;
      this.loadingVid = "";
      this.roomLoadTarget = null;
      this.loadDoneAt = Infinity;
    }

    // Deliver any inbox messages due now.
    for (const { at, msg } of this.inbox.splice(0)) {
      if (at > now) {
        this.inbox.push({ at, msg });
        continue;
      }
      this.lastRecvAt = now;
      this.apply(msg, now, requestState);
    }

    // ② Half-open watchdog (every WATCHDOG_MS). Only a joined follower with a remote anchor trips it.
    if (this.watchdogEnabled && now % WATCHDOG_MS === 0) {
      const stale = isSocketStale({ online: true, hasSocket: true, follower: anchorPresent, lastRecvAt: this.lastRecvAt, now, staleMs: STALE_MS });
      if (stale) {
        // A reconnect only SUCCEEDS once the underlying link is back (now ≥ faultsEndAt): a fresh
        // socket then bypasses the dead one, welcome resets liveness, and request-state delivers the
        // anchor's current snapshot. Before that, the new socket is just as dead — the watchdog keeps
        // retrying (lastRecvAt is NOT reset, so it stays stale and fires again next tick).
        if (now >= this.fault.faultsEndAt) {
          this.socketDead = false;
          this.lastRecvAt = now;
          requestState(this, now); // schedules a snapshot{hostVid} reply on the healed socket
        }
      }
    }
  }

  private apply(msg: Msg, now: number, requestState: (g: Guest, now: number) => void): void {
    if (msg.kind === "load") {
      if (msg.vid !== this.loadedVid && msg.vid !== this.roomLoadTarget) this.runRoomLoad(msg.vid, now);
      return;
    }
    if (msg.kind === "snapshot") {
      const act = decideSnapshotDeck({ snapVideoId: msg.vid, loadedId: this.loadedVid, roomLoadTarget: this.roomLoadTarget, loadingVid: this.loadingVid, reconciledTarget: this.reconciledTarget });
      if (act === "load" && msg.vid) this.runRoomLoad(msg.vid, now);
      else if (act === "reconcile") this.reconciledTarget = msg.vid;
      return;
    }
    // tick
    const tickVid = this.tickVidEnabled ? msg.vid : undefined; // ① off → no identity stamped
    const loadingThis = tickVid != null && (this.roomLoadTarget === tickVid || this.loadingVid === tickVid);
    const r = decideTickResync({ tickVid, loadedId: this.loadedVid, loadingThisVid: loadingThis, sinceResyncMs: now - this.resyncAt });
    if (r === "drive") {
      // SAFETY: when we drive, the deck we drive MUST hold the track the tick is for.
      if (tickVid != null && tickVid !== this.loadedVid) this.droveMismatch = true;
      return;
    }
    if (r === "load" || r === "force-load") {
      this.resyncAt = now;
      if (r === "force-load") {
        this.roomLoadTarget = null;
        this.loadingVid = "";
      }
      if (tickVid) this.runRoomLoad(tickVid, now);
      requestState(this, now);
    }
    // wait/load/force-load → frozen (not driving) — safe by construction.
  }
}

interface SimOpts {
  guests: GuestFault[];
  loadSchedule: { at: number; vid: string }[]; // when the host loads each track
  durationMs: number;
  tickVidEnabled?: boolean;
  watchdogEnabled?: boolean;
  seed?: number;
}

function simulate(opts: SimOpts) {
  const rng = mulberry32(opts.seed ?? 1);
  const guests = opts.guests.map((f) => new Guest(f, mulberry32((opts.seed ?? 1) ^ Math.floor(rng() * 1e9)), opts.tickVidEnabled ?? true, opts.watchdogEnabled ?? true));
  let hostVid: string | null = null;
  // request-state reply: the host sends its current snapshot back after a reconnect round-trip.
  const requestState = (g: Guest, now: number) => g.inbox.push({ at: now + RECONNECT_MS, msg: { kind: "snapshot", vid: hostVid } });

  for (let now = 0; now <= opts.durationMs; now += STEP_MS) {
    // Host loads a track → emits a `load` intent immediately + a `snapshot` right after (App
    // republishes on `loaded` change), then every tick carries the new vid.
    for (const ld of opts.loadSchedule) {
      if (ld.at === now) {
        hostVid = ld.vid;
        for (const g of guests) {
          g.recv({ kind: "load", vid: ld.vid }, now);
          g.recv({ kind: "snapshot", vid: ld.vid }, now + 1);
        }
      }
    }
    // Anchor tick (4/s), stamped with the host's current vid.
    if (now % TICK_MS === 0) for (const g of guests) g.recv({ kind: "tick", vid: hostVid }, now);
    // Advance every follower.
    for (const g of guests) g.step(now, true, requestState);
  }
  return { hostVid, guests };
}

// A clean, generous link: everything converges trivially. (Baseline sanity.)
describe("session sim — baseline", () => {
  it("a clean link converges every follower to the host's track", () => {
    const { hostVid, guests } = simulate({
      guests: [{ dropP: 0, latencyMs: 100, halfOpenAt: null, faultsEndAt: 0 }, { dropP: 0, latencyMs: 250, halfOpenAt: null, faultsEndAt: 0 }],
      loadSchedule: [{ at: 0, vid: "trackONE001" }, { at: 4000, vid: "trackTWO002" }],
      durationMs: 12000,
    });
    for (const g of guests) {
      expect(g.loadedVid).toBe(hostVid);
      expect(g.droveMismatch).toBe(false);
    }
  });
});

// ① The dropped-load case: the `load` intent + its snapshot are lost (lossy link), so only the
// stamped tick can recover the follower.
describe("session sim — dropped load (① tick identity recovers)", () => {
  it("converges via the tick's vid after the load intent is lost", () => {
    const lossy: GuestFault = { dropP: 0.6, latencyMs: 200, halfOpenAt: null, faultsEndAt: 5000 };
    const { hostVid, guests } = simulate({ guests: [lossy], loadSchedule: [{ at: 1000, vid: "newTrack001" }], durationMs: 20000, seed: 7 });
    expect(guests[0].loadedVid).toBe(hostVid);
    expect(guests[0].droveMismatch).toBe(false);
  });
});

// ② The half-open case: the socket dies and NEVER delivers again — only the watchdog (a reconnect →
// request-state) can recover the follower. This is the 4G-stall the fix exists for.
describe("session sim — half-open socket (② watchdog recovers)", () => {
  // Guest loads track 1 (delivered), THEN the socket dies and the host switches to track 2 — the
  // real "wrong song": stuck on track 1 with the host's board moving, until the watchdog recovers.
  const HALF_OPEN_SCENARIO = { guests: [{ dropP: 0, latencyMs: 150, halfOpenAt: 1500, faultsEndAt: 9000 }], loadSchedule: [{ at: 0, vid: "firstTrak01" }, { at: 3000, vid: "afterStall1" }], durationMs: 20000 };

  it("converges via a watchdog-forced reconnect when the socket is dead", () => {
    const { hostVid, guests } = simulate(HALF_OPEN_SCENARIO);
    expect(guests[0].loadedVid).toBe(hostVid); // recovered to track 2
    expect(guests[0].droveMismatch).toBe(false); // never drove track 1 under track 2's board
  });

  it("REGRESSION SENTINEL: with ① and ② disabled, the half-open follower STAYS stuck on track 1 (proves the harness has teeth)", () => {
    const { hostVid, guests } = simulate({ ...HALF_OPEN_SCENARIO, tickVidEnabled: false, watchdogEnabled: false });
    expect(guests[0].loadedVid).toBe("firstTrak01"); // the OLD bug: stuck on the wrong song
    expect(guests[0].loadedVid).not.toBe(hostVid); // permanent divergence
  });
});

// The worst case: two independent followers on lossy + half-open 4G, many random fault patterns.
describe("session sim — fuzz (phone-host-4G + phone-guest-4G)", () => {
  it("every fault pattern converges and never drives the wrong track", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = mulberry32(seed);
      const mkFault = (): GuestFault => {
        const halfOpen = rng() < 0.4;
        const start = 1000 + Math.floor(rng() * 4000);
        return { dropP: 0.2 + rng() * 0.5, latencyMs: 100 + Math.floor(rng() * 400), halfOpenAt: halfOpen ? start : null, faultsEndAt: start + 3000 + Math.floor(rng() * 6000) };
      };
      const last = 1000 + Math.floor(rng() * 5000);
      const { hostVid, guests } = simulate({
        guests: [mkFault(), mkFault()],
        loadSchedule: [{ at: 500, vid: "fuzzTrack01" }, { at: last, vid: "fuzzTrack02" }],
        durationMs: 30000,
        seed,
      });
      for (const g of guests) {
        expect(g.droveMismatch, `seed ${seed}: drove a mismatched deck`).toBe(false);
        expect(g.loadedVid, `seed ${seed}: did not converge`).toBe(hostVid);
      }
    }
  });
});

// Sanity on the modelled timing: recovery is BOUNDED (a stuck guard is force-healed), not eventual-
// only — a follower converges within the stuck window + a load after the faults clear.
describe("session sim — bounded recovery", () => {
  it("converges within RESYNC_STUCK_MS + a load after the link clears", () => {
    const halfOpen: GuestFault = { dropP: 0, latencyMs: 150, halfOpenAt: 1000, faultsEndAt: 8000 };
    const settleBy = 8000 + RESYNC_STUCK_MS + LOAD_MS + RECONNECT_MS + 2000;
    const { hostVid, guests } = simulate({ guests: [halfOpen], loadSchedule: [{ at: 2000, vid: "boundedTr1" }], durationMs: settleBy });
    expect(guests[0].loadedVid).toBe(hostVid);
  });
});
