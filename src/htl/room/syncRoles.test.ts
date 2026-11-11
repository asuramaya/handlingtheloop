import { describe, it, expect } from "vitest";
import { FollowTempoGate, isRoleEcho, keyStateIntents, shouldAnnounceAutoRole, syncStateIntents, SYNC_ECHO_TEMPO_EPS } from "./syncRoles";
import type { DeckId } from "./protocol";

// operator, 2026-11-11: session sync audit — the pure half of SYNC/KEY roles across devices.

const src = (syncSlave: DeckId | null, keySlave: DeckId | null, tempo: Record<DeckId, number>, pitch: Record<DeckId, number> = { A: 0, B: 0 }) => ({
  syncSlave,
  keySlave,
  deck: (id: DeckId) => ({ tempo: tempo[id], pitch: pitch[id] }),
});

describe("isRoleEcho — a remote tempo on the follower: the lock's echo, or a hand?", () => {
  it("a `follow`-marked value is always the echo, however far it moves", () => {
    expect(isRoleEcho({ isFollower: true, current: 0, incoming: 3.2, follow: true, eps: SYNC_ECHO_TEMPO_EPS })).toBe(true);
  });
  it("an unmarked value that does not move the deck is the echo (an older peer re-broadcasting)", () => {
    expect(isRoleEcho({ isFollower: true, current: 3.2, incoming: 3.21, eps: SYNC_ECHO_TEMPO_EPS })).toBe(true);
  });
  it("an unmarked value that moves the deck is a hand on the fader → it releases", () => {
    expect(isRoleEcho({ isFollower: true, current: 3.2, incoming: 0, eps: SYNC_ECHO_TEMPO_EPS })).toBe(false);
  });
  it("a deck that is not the follower is never an echo (nothing to keep)", () => {
    expect(isRoleEcho({ isFollower: false, current: 1, incoming: 1, follow: true, eps: SYNC_ECHO_TEMPO_EPS })).toBe(false);
  });
});

describe("syncStateIntents — what crosses after a role change, in order", () => {
  it("engage: role, then the leader's tempo, then the follower's marked `follow`, then the align seek", () => {
    const out = syncStateIntents(src("B", null, { A: 2, B: -1.5 }), { deck: "B", pos: 42.5 });
    expect(out).toEqual([
      { kind: "sync", slave: "B" },
      { kind: "control", deck: "A", param: "tempo", value: 2 },
      { kind: "control", deck: "B", param: "tempo", value: -1.5, follow: true },
      { kind: "transport", deck: "B", action: "seek", position: 42.5 },
    ]);
  });
  it("no seek when the engage did not move the follower", () => {
    const out = syncStateIntents(src("A", null, { A: 0, B: 0 }), null);
    expect(out.map((i) => i.kind)).toEqual(["sync", "control", "control"]);
  });
  it("an align for the OTHER deck (stale) is not sent", () => {
    const out = syncStateIntents(src("A", null, { A: 0, B: 0 }), { deck: "B", pos: 1 });
    expect(out.some((i) => i.kind === "transport")).toBe(false);
  });
  it("release: only the role — neither deck's tempo moved", () => {
    expect(syncStateIntents(src(null, null, { A: 4, B: 4 }), null)).toEqual([{ kind: "sync", slave: null }]);
  });
});

describe("keyStateIntents", () => {
  it("engage: role, leader's pitch, follower's pitch marked `follow`", () => {
    expect(keyStateIntents(src(null, "A", { A: 0, B: 0 }, { A: 3, B: -1 }))).toEqual([
      { kind: "key", slave: "A" },
      { kind: "control", deck: "B", param: "pitch", value: -1 },
      { kind: "control", deck: "A", param: "pitch", value: 3, follow: true },
    ]);
  });
  it("release: role, then both pitches as plain setpoints (the released follower is back at 0)", () => {
    expect(keyStateIntents(src(null, null, { A: 0, B: 0 }, { A: 0, B: 2 }))).toEqual([
      { kind: "key", slave: null },
      { kind: "control", deck: "A", param: "pitch", value: 0 },
      { kind: "control", deck: "B", param: "pitch", value: 2 },
    ]);
  });
});

describe("shouldAnnounceAutoRole — who speaks for a role change nobody pressed", () => {
  it("the anchor announces every cause (hand-off, re-align, release)", () => {
    for (const kind of ["release", "handoff", "reassert"] as const) {
      expect(shouldAnnounceAutoRole({ isAnchor: true, cause: { kind, remote: false } })).toBe(true);
      expect(shouldAnnounceAutoRole({ isAnchor: true, cause: { kind, remote: true } })).toBe(true);
    }
  });
  it("a guest announces only a release its OWN hand caused", () => {
    expect(shouldAnnounceAutoRole({ isAnchor: false, cause: { kind: "release", remote: false } })).toBe(true);
    expect(shouldAnnounceAutoRole({ isAnchor: false, cause: { kind: "release", remote: true } })).toBe(false);
    expect(shouldAnnounceAutoRole({ isAnchor: false, cause: { kind: "handoff", remote: false } })).toBe(false);
    expect(shouldAnnounceAutoRole({ isAnchor: false, cause: { kind: "reassert", remote: false } })).toBe(false);
  });
});

describe("FollowTempoGate — the anchor's continuous follow, rate-limited", () => {
  function harness() {
    let t = 0;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 1;
    const sent: [DeckId, number][] = [];
    const gate = new FollowTempoGate((d, v) => sent.push([d, v]), {
      minMs: 250,
      eps: SYNC_ECHO_TEMPO_EPS,
      now: () => t,
      schedule: (fn, ms) => {
        const id = nextId++;
        timers.push({ at: t + ms, fn, id });
        return id;
      },
      cancel: (h) => {
        const i = timers.findIndex((x) => x.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const advance = (ms: number) => {
      t += ms;
      for (const x of [...timers].sort((a, b) => a.at - b.at)) {
        if (x.at <= t) {
          timers.splice(timers.indexOf(x), 1);
          x.fn();
        }
      }
    };
    return { gate, sent, advance };
  }

  it("sends the first value at once, then at most one per window, and always the last", () => {
    const { gate, sent, advance } = harness();
    gate.note("B", 1);
    for (let i = 1; i <= 10; i++) {
      advance(20);
      gate.note("B", 1 + i * 0.1); // a fader sweep, 50 Hz
    }
    expect(sent).toEqual([["B", 1]]); // nothing more inside the 250 ms window
    advance(300);
    expect(sent).toEqual([["B", 1], ["B", 2]]); // the trailing value: where the anchor settled
  });

  it("ignores moves inside the epsilon (no traffic for a steady lock)", () => {
    const { gate, sent, advance } = harness();
    gate.note("A", 5);
    advance(1000);
    gate.note("A", 5.01);
    expect(sent).toEqual([["A", 5]]);
  });

  it("a value back at what was sent cancels a pending trailing send", () => {
    const { gate, sent, advance } = harness();
    gate.note("A", 5);
    advance(10);
    gate.note("A", 6);
    advance(10);
    gate.note("A", 5);
    advance(500);
    expect(sent).toEqual([["A", 5]]);
  });
});
