import { describe, expect, it } from "vitest";
import { Deck, type MoveKind } from "./Deck";

// FX2 moves are a stack — last pressed wins, releasing falls back, releasing the last lands
// (operator, 2026-11-07: "gotta solve the interaction when one is held and another is triggered").
// The real Deck methods, on a deck whose audio engine and platter are recorders.
function rig() {
  const log: string[] = [];
  let jogPos = 0;
  const d = Object.create(Deck.prototype) as Deck & Record<string, unknown>;
  Object.assign(d, {
    _loaded: true,
    _playing: true,
    moveStack: [],
    moveActive: null,
    _freezeAt: null,
    startOffset: 0,
    t: 10, // the deck clock (position())
    jog: {
      jogging: false,
      moveEnter(k: MoveKind, from: number) { log.push(`enter ${k} @${from}`); jogPos = from - 1; (d as unknown as { _playing: boolean })._playing = false; /* the platter takes the audio */ },
      moveExit() { log.push("exit"); return jogPos; },
      cancelJog() {},
      softStart() { log.push("spin-up"); },
    },
    stretchNode: { port: { postMessage: (m: { type: string; on: boolean }) => log.push(`freeze ${m.on ? "on" : "off"}`) } },
  });
  Object.assign(d, {
    position: () => (d as unknown as { t: number }).t,
    slipArmForce: () => log.push("arm"),
    slipReleasePos: () => 42, // where the track would be
    spawnSource: (at: number) => log.push(`play @${at}`),
    seek: (at: number) => log.push(`seek @${at}`),
  });
  return { d, log };
}

describe("FX2 move stack", () => {
  it("one move: arm the shadow, run it, land on the shadow", () => {
    const { d, log } = rig();
    d.moveDown("censor");
    expect(d.moveHeld("censor")).toBe(true);
    d.moveUp("censor");
    expect(log).toEqual(["arm", "enter censor @10", "exit", "play @42"]);
  });

  it("a second press hands over from where the audio is; releasing it falls back; the last lands", () => {
    const { d, log } = rig();
    d.moveDown("censor"); // audio leaves 10 → platter at 9
    d.moveDown("brake"); // hand-over from 9
    expect(d.moveHeld("brake")).toBe(true);
    expect(d.moveHeld("censor")).toBe(false); // waiting underneath
    d.moveUp("brake"); // back to censor from where brake left it (8)
    expect(d.moveHeld("censor")).toBe(true);
    d.moveUp("censor");
    expect(log).toEqual(["arm", "enter censor @10", "exit", "enter brake @9", "exit", "enter censor @8", "exit", "play @42"]);
    expect(log.filter((l) => l === "arm")).toHaveLength(1); // ONE shadow for the whole run
  });

  it("releasing a move that is waiting underneath changes nothing audible", () => {
    const { d, log } = rig();
    d.moveDown("censor");
    d.moveDown("spin");
    const before = log.length;
    d.moveUp("censor"); // it was waiting
    expect(log.length).toBe(before);
    expect(d.moveHeld("spin")).toBe(true);
    d.moveUp("spin");
    expect(log.slice(before)).toEqual(["exit", "play @42"]);
  });

  it("FREEZE ↔ a platter move hand over both ways, and FREEZE lands with a re-seat", () => {
    const { d, log } = rig();
    d.moveDown("freeze"); // frozen at 10
    d.moveDown("censor"); // thaw, reverse from the frozen instant
    d.moveUp("censor"); // back to freeze: the voice restarts on the platter's point, frozen
    d.moveUp("freeze"); // land: the voice is running, so a declicked re-seat
    expect(log).toEqual(["arm", "freeze on", "freeze off", "enter censor @10", "exit", "play @9", "freeze on", "freeze off", "seek @42"]);
  });

  it("a move cannot start on a paused deck", () => {
    const { d, log } = rig();
    (d as unknown as { _playing: boolean })._playing = false;
    d.moveDown("brake");
    expect(log).toEqual([]);
    expect(d.moveHeld("brake")).toBe(false);
  });

  it("SHIFT = commit: release carries on from where the audio got to, not the shadow", () => {
    const { d, log } = rig();
    d.moveDown("censor", true);
    expect(d.moveCommitted).toBe(true);
    d.moveUp("censor");
    expect(log).toEqual(["arm", "enter censor @10", "exit", "play @9"]); // the reversed-to point, not 42
  });

  it("a committed BRAKE spins back up from where it stopped", () => {
    const { d, log } = rig();
    d.moveDown("brake", true);
    d.moveUp("brake");
    expect(log).toEqual(["arm", "enter brake @10", "exit", "spin-up"]);
  });

  it("the move SOUNDING when the stack empties decides: slip under commit still lands on the beat", () => {
    const { d, log } = rig();
    d.moveDown("drag", true); // commit underneath
    d.moveDown("censor"); // slip on top
    d.moveUp("drag"); // the waiting commit goes
    d.moveUp("censor"); // the sounding slip lands
    expect(log.at(-1)).toBe("play @42");
  });
});
