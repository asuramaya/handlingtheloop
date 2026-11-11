import { describe, expect, it } from "vitest";
import { PendingDeckState, deckStateKey, forReplay, pendingTarget } from "./pendingDeckState";
import { Session } from "./roomSim";
import type { Intent } from "./protocol";

// ★ STATE FOR A TRACK THAT HAS NOT LANDED YET (operator, 2026-11-11: session sync audit). A loop /
// cue / hot-cue result reaching a deck still holding the old track was applied to the old buffer and
// wiped by the new buffer's reset. It is held for its track and applied when that track lands.

const loopState = (start: number, end: number): Extract<Intent, { kind: "loop" }> => ({ kind: "loop", deck: "A", action: "beat", beats: 4, state: { loop: { start, end, active: true, beats: 4 }, inPoint: null }, position: start });

describe("which intents are held", () => {
  it("absolute loop / cue / hot-cue state, collapsed per target", () => {
    expect(deckStateKey(loopState(1, 2))).toBe("loop");
    expect(deckStateKey({ kind: "loopBounds", deck: "A", start: 1, end: 2, active: true })).toBe("loop");
    expect(deckStateKey({ kind: "cue", deck: "A", position: 3 })).toBe("cue");
    expect(deckStateKey({ kind: "hotcue", deck: "A", slot: 4, action: "press", cue: 9, loop: null })).toBe("hc4");
    expect(deckStateKey({ kind: "hotcue", deck: "A", slot: 4, action: "clear" })).toBe("hc4");
  });
  it("not an older peer's result-less request, and not transport", () => {
    expect(deckStateKey({ kind: "loop", deck: "A", action: "in" })).toBeNull();
    expect(deckStateKey({ kind: "hotcue", deck: "A", slot: 0, action: "press" })).toBeNull();
    expect(deckStateKey({ kind: "transport", deck: "A", action: "play" })).toBeNull();
  });
});

describe("pendingTarget", () => {
  it("holds for the room's load target while the old track is still on the deck", () => {
    expect(pendingTarget({ loadedId: "old", tickVid: "new", roomLoadTarget: "new" })).toBe("new");
  });
  it("falls back to the anchor's tick when no load is in flight", () => {
    expect(pendingTarget({ loadedId: "old", tickVid: "new", roomLoadTarget: null })).toBe("new");
  });
  it("applies at once when the deck holds the session's track", () => {
    expect(pendingTarget({ loadedId: "same", tickVid: "same", roomLoadTarget: null })).toBeNull();
    expect(pendingTarget({ loadedId: "mine", tickVid: "theirs", roomLoadTarget: "mine" })).toBeNull(); // our own shared load
  });
});

describe("PendingDeckState", () => {
  it("keeps the LATEST per target, in arrival order, and hands them over only for the right track", () => {
    const p = new PendingDeckState();
    p.stash("new", loopState(1, 2));
    p.stash("new", { kind: "cue", deck: "A", position: 5 });
    p.stash("new", loopState(3, 4)); // replaces the first loop, and moves after the cue
    expect(p.take("A", "old")).toEqual([]); // still loading
    const out = p.take("A", "new");
    expect(out.map((i) => i.kind)).toEqual(["cue", "loop"]);
    expect((out[1] as Extract<Intent, { kind: "loop" }>).state?.loop?.start).toBe(3);
    expect(p.take("A", "new")).toEqual([]); // handed over once
  });
  it("a new target replaces what was held for the old one", () => {
    const p = new PendingDeckState();
    p.stash("t1", { kind: "cue", deck: "A", position: 5 });
    p.stash("t2", { kind: "cue", deck: "A", position: 6 });
    expect(p.take("A", "t1")).toEqual([]);
    expect(p.take("A", "t2")).toHaveLength(1);
  });
  it("replays without the head move: by then the tick owns the playhead", () => {
    const r = forReplay(loopState(1, 2) as Extract<Intent, { deck: "A" }>);
    expect("position" in r).toBe(false);
  });
});

describe("end to end: the loop survives the buffer landing", () => {
  it("a held loop applied after the track's reset matches the sender", () => {
    const s = new Session("laptop", "phone");
    const a = s.host.engine.deck("A");
    const b = s.guest.engine.deck("A");
    a.pos = 10;
    const p = new PendingDeckState();
    // The phone is still on the old track: the result is held instead of applied.
    s.host.wire = (i) => {
      if (deckStateKey(i)) p.stash("new", i as Extract<Intent, { deck: "A" }>);
    };
    a.setBeatLoop(4);
    b.loops.reset(); // the new buffer lands: Deck.setBuffer resets the loop engine
    for (const i of p.take("A", "new")) s.guest.apply(i);
    expect(b.loop).toEqual(a.loop);
  });
});
