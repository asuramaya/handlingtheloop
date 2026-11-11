import { describe, expect, it } from "vitest";
import { Session, type FakeDeck } from "./roomSim";
import type { Beatgrid } from "../analysis/analyze";
import type { Deck } from "../audio/Deck";
import type { Intent } from "./protocol";
import { quantizedHotCue, quantizedPlay, quantizedTogglePlay } from "../../components/quantizedTransport";
import { loopEditIntent, hotCueResultIntent } from "./loopWire";

// ★ LOOPS, CUES AND HOT CUES CARRY RESULTS (operator, 2026-11-11: session sync audit). Every
// scenario: the sender's deck sits at X, the receiver's at X + 0.1 s (where it really is, ~100 ms of
// network later), with and without grid lock, on the same grid and on a different one. After the
// gesture, both devices must hold IDENTICAL loop regions / in-points / cues / hot cues / positions.
// The decks run the REAL LoopEngine (roomSim.FakeDeck), so a receiver that re-ran the gesture would
// land somewhere else, and the control rows show that it does.

const GRID: Beatgrid = { bpm: 120, firstBeat: 0, interval: 0.5, beatsPerBar: 4 };
const OTHER_GRID: Beatgrid = { bpm: 128, firstBeat: 0.03, interval: 60 / 128, beatsPerBar: 4 };
const X = 10.2; // snaps to 10.0 on GRID; X + 0.1 snaps to 10.5: a whole beat apart

type Setup = { quant: boolean; guestGrid: Beatgrid | null; playing?: boolean };
const SETUPS: [string, Setup][] = [
  ["no grid lock", { quant: false, guestGrid: GRID }],
  ["grid lock on", { quant: true, guestGrid: GRID }],
  ["grid lock on, a different grid on the receiver", { quant: true, guestGrid: OTHER_GRID }],
];

function session({ quant, guestGrid, playing = false }: Setup) {
  const s = new Session("laptop", "phone");
  const a = s.host.engine.deck("A");
  const b = s.guest.engine.deck("A");
  a.grid = GRID;
  b.grid = guestGrid;
  for (const d of [a, b]) {
    d.toggles.quantize = quant;
    d.playing = playing;
  }
  a.pos = X;
  b.pos = X + 0.1;
  return { s, a, b };
}

const loopOf = (d: FakeDeck) => ({ state: d.loopState(), cue: d.cuePoint, hotCues: [...d.hotCues], hotLoops: d.hotLoops.map((l) => (l ? { ...l } : null)) });
const agree = (a: FakeDeck, b: FakeDeck) => expect(loopOf(b)).toEqual(loopOf(a));
/** Advance both playheads by the same amount, as both devices play on. */
const advance = (a: FakeDeck, b: FakeDeck, by: number) => {
  a.pos += by;
  b.pos += by;
};

describe.each(SETUPS)("two devices, 100 ms apart — %s", (_name, setup) => {
  it("loop IN then OUT: the same pending in-point, then the same region", () => {
    const { a, b } = session(setup);
    a.loopIn();
    agree(a, b);
    advance(a, b, 2);
    a.loopOut();
    agree(a, b);
    expect(a.loop?.active).toBe(true);
  });

  it("a LOST loop IN does not turn OUT into a no-op on the receiver", () => {
    const { s, a, b } = session(setup);
    const wire = s.host.wire;
    s.host.wire = null; // the IN never arrives
    a.loopIn();
    s.host.wire = wire;
    advance(a, b, 2);
    a.loopOut();
    agree(a, b);
    expect(b.loop?.active).toBe(true);
  });

  it("beat loop: the same {start, end, beats}", () => {
    const { a, b } = session(setup);
    a.setBeatLoop(4);
    agree(a, b);
    a.setBeatLoop(1); // resize in place
    agree(a, b);
  });

  it("exit then reloop: same region, same active flag, same head", () => {
    const { a, b } = session({ ...setup, playing: true });
    a.setBeatLoop(4);
    a.exitLoop();
    agree(a, b);
    expect(b.loop?.active).toBe(false);
    advance(a, b, 3);
    a.reloop();
    agree(a, b);
    expect(b.pos).toBe(a.pos);
  });

  it("roll release: the receiver snaps back to the SENDER's un-wrapped position", () => {
    const { a, b } = session({ ...setup, playing: true });
    a.setBeatLoop(0.5);
    a.raw = 13.37; // where the track would be had it never looped
    a.rollOut();
    agree(a, b);
    expect(b.loop?.active).toBe(false);
    expect(b.pos).toBe(13.37);
  });

  it("SHIFT clear: the receiver wipes the region, so a later reloop cannot bring it back", () => {
    const { a, b } = session(setup);
    a.setBeatLoop(4);
    a.clearLoop();
    agree(a, b);
    expect(b.loop).toBeNull();
    b.reloop();
    expect(b.loop).toBeNull();
  });

  it("moving an active loop: same region, and both heads pulled inside", () => {
    const { a, b } = session({ ...setup, playing: true });
    a.setBeatLoop(2);
    a.moveLoop(8);
    agree(a, b);
    expect(b.pos).toBe(a.pos);
  });

  it("hot cue on an EMPTY slot stores the sender's cue, not one at the receiver's playhead", () => {
    const { s, a, b } = session(setup);
    quantizedHotCue(a as unknown as Deck, "A", 3, (i) => s.host.send(i));
    agree(a, b);
    expect(b.hotCues[3]).toBe(a.hotCues[3]);
    expect(b.pos).toBe(X + 0.1); // setting a cue moves nobody's head
  });

  it("hot cue JUMP lands where the sender landed, even when the receiver had another cue stored", () => {
    const { s, a, b } = session({ ...setup, playing: true });
    a.applyHotCue(2, 30.2, null);
    b.applyHotCue(2, 55, null); // the receiver's pad disagrees (a lost save, an older session)
    quantizedHotCue(a as unknown as Deck, "A", 2, (i) => s.host.send(i));
    agree(a, b);
    expect(b.pos).toBe(a.pos);
    if (setup.quant) expect(a.pos).toBe(30); // the LANDED (quantized) place, not the stored 30.2
  });

  it("saving a loop to a pad and recalling it from the pad", () => {
    const { s, a, b } = session({ ...setup, playing: true });
    a.setBeatLoop(4);
    a.saveLoop(5);
    s.host.send(hotCueResultIntent("A", 5, "save", a));
    a.exitLoop();
    advance(a, b, 10);
    quantizedHotCue(a as unknown as Deck, "A", 5, (i) => s.host.send(i));
    agree(a, b);
    expect(b.loop?.active).toBe(true);
    expect(b.pos).toBe(a.pos);
  });

  it("quantized PLAY: the receiver starts from the sender's landed position", () => {
    const { s, a, b } = session(setup);
    quantizedTogglePlay(a as unknown as Deck, "A", (i) => s.host.send(i));
    expect(a.playing).toBe(true);
    expect(b.playing).toBe(true);
    expect(b.pos).toBe(a.pos);
    if (setup.quant) expect(a.pos).toBe(10);
  });

  it("quantized pad launch (quantizedPlay) carries the landed position too", () => {
    const { s, a, b } = session(setup);
    quantizedPlay(a as unknown as Deck, "A", (i) => s.host.send(i));
    expect(b.playing).toBe(true);
    expect(b.pos).toBe(a.pos);
  });

  it("pause carries where the sender stopped", () => {
    const { s, a, b } = session({ ...setup, playing: true });
    quantizedTogglePlay(a as unknown as Deck, "A", (i) => s.host.send(i));
    expect(b.playing).toBe(false);
    expect(b.pos).toBe(a.pos);
  });

  it("a fine-adjust step and an armed in-point reach the receiver", () => {
    const { a, b } = session(setup);
    a.setBeatLoop(4);
    a.toggleAdjust("out");
    a.adjustStep(1);
    agree(a, b);
  });
});

describe("the echo — a receiver never broadcasts what it was told", () => {
  it("applying a peer's result sends nothing back", () => {
    const { s, a } = session({ quant: true, guestGrid: OTHER_GRID });
    a.setBeatLoop(4);
    a.loopIn();
    a.exitLoop();
    expect(s.host.sent.length).toBe(3);
    expect(s.guest.sent).toEqual([]);
  });

  it("an OLDER peer's bare loop intent is re-run here (the fallback), and still is not echoed", () => {
    const { s, b } = session({ quant: true, guestGrid: GRID });
    s.host.send({ kind: "loop", deck: "A", action: "beat", beats: 4 }); // no `state`: an older bundle
    expect(b.loop).toMatchObject({ active: true, beats: 4 });
    expect(s.guest.sent).toEqual([]);
    expect(s.host.engine.deck("A").loop).toBeNull(); // the sender was never told its own gesture back
  });
});

// The control rows: what the receiver did with the OLD, result-less messages. If these ever stop
// diverging, the fixture stopped exercising the bug and the rows above prove nothing.
describe("control — the old request-style messages diverge under the same conditions", () => {
  it("a bare loop IN re-run 100 ms later with grid lock lands a whole beat away", () => {
    const { s, a, b } = session({ quant: true, guestGrid: GRID });
    a.loops.loopIn();
    s.host.send({ kind: "loop", deck: "A", action: "in" });
    expect(a.loopInPoint).toBe(10);
    expect(b.loopInPoint).toBe(10.5);
  });

  it("a bare hot-cue press on an empty slot set the cue at the receiver's playhead", () => {
    const { s, a, b } = session({ quant: false, guestGrid: GRID });
    a.loops.hotCue(0);
    s.host.send({ kind: "hotcue", deck: "A", slot: 0, action: "press" });
    expect(b.hotCues[0]).not.toBe(a.hotCues[0]);
  });
});

describe("loopWire — the shape on the wire", () => {
  it("roll and clear ride as action 'exit' (an older bundle falls through to a beat loop on an unknown action)", () => {
    const st = { loop: { start: 1, end: 2, active: false, beats: 2 }, inPoint: null };
    expect((loopEditIntent("A", { action: "roll", seek: 4 }, st) as Extract<Intent, { kind: "loop" }>).action).toBe("exit");
    expect((loopEditIntent("A", { action: "clear" }, { loop: null, inPoint: null }) as Extract<Intent, { kind: "loop" }>).action).toBe("exit");
  });
  it("a boundary move rides loopBounds with the count and the head move", () => {
    expect(loopEditIntent("B", { action: "bounds", seek: 3 }, { loop: { start: 3, end: 5, active: true, beats: 4 }, inPoint: null })).toEqual({ kind: "loopBounds", deck: "B", start: 3, end: 5, active: true, beats: 4, position: 3 });
  });
  it("survives JSON (null slot contents are kept, absent ones stay absent)", () => {
    const i = hotCueResultIntent("A", 0, "press", { hotCues: [7], hotLoops: [null] });
    expect(JSON.parse(JSON.stringify(i))).toEqual({ kind: "hotcue", deck: "A", slot: 0, action: "press", cue: 7, loop: null });
  });
});
