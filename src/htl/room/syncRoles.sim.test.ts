import { describe, it, expect } from "vitest";
import { Session } from "./roomSim";
import { applyBoardAction } from "../board/boardActions";
import type { Deck } from "../audio/Deck";

// ★ SYNC / KEY ROLES ACROSS DEVICES, through the REAL apply path (operator, 2026-11-11: session sync
// audit). The bug: a received `sync` lit the button and left the engine's follower null, so the
// far side's next press read "off", ENGAGED instead of releasing, and its tempo released the host —
// both ends inverted. "host" is the anchor (Session makes devices[0] the anchor).

const roles = (s: Session) => s.devices.map((d) => [d.engine.syncSlave, d.engine.syncRole("A"), d.engine.syncRole("B")]);

function session() {
  const s = new Session("host", "guest");
  s.each((d) => {
    d.engine.deck("A").tempo = 2; // the leader is pitched up; the follower must follow it
    d.engine.deck("B").tempo = 0;
  });
  return s;
}

describe("SYNC role crosses as a REAL role", () => {
  it("the host engages: the guest's ENGINE holds the role and its follower follows", () => {
    const s = session();
    s.host.pressSync("B");
    expect(s.guest.engine.syncSlave).toBe("B");
    expect(s.guest.engine.syncRole("A")).toBe("master");
    expect(s.guest.engine.deck("B").tempo).toBe(2); // followed (the marked tempo landed as an echo)
    expect(roles(s)[0]).toEqual(roles(s)[1]);
  });

  it("★ the guest presses the SYNC the host engaged: it RELEASES, on both (was: engaged, then inverted)", () => {
    const s = session();
    s.host.pressSync("B");
    s.guest.pressSync("B");
    expect(s.guest.engine.syncSlave).toBeNull();
    expect(s.host.engine.syncSlave).toBeNull();
  });

  it("toggling from either side, any number of times, keeps both on the same role", () => {
    const s = session();
    const presses: ["host" | "guest", "A" | "B"][] = [
      ["host", "B"], ["guest", "A"], ["guest", "A"], ["host", "A"], ["guest", "B"], ["host", "B"], ["guest", "B"],
    ];
    for (const [who, id] of presses) {
      s.device(who).pressSync(id);
      expect(roles(s)[0]).toEqual(roles(s)[1]);
      expect(s.host.engine.deck("A").tempo).toBe(s.guest.engine.deck("A").tempo);
      expect(s.host.engine.deck("B").tempo).toBe(s.guest.engine.deck("B").tempo);
    }
  });

  it("a guest pressing the button that reads MASTER releases on the host too", () => {
    const s = session();
    s.host.pressSync("B"); // B follows A; A reads MASTER everywhere
    expect(s.guest.engine.syncRole("A")).toBe("master");
    s.guest.pressSync("A");
    expect(s.host.engine.syncSlave).toBeNull();
    expect(s.guest.engine.syncSlave).toBeNull();
  });
});

describe("tempo after sync — the echo keeps the lock, a hand releases it", () => {
  it("a follower tempo marked `follow` never releases, whatever the order it lands in", () => {
    const s = session();
    s.host.pressSync("B");
    s.guest.apply({ kind: "control", deck: "B", param: "tempo", value: 2.004, follow: true });
    expect(s.guest.engine.syncSlave).toBe("B");
    expect(s.guest.engine.deck("B").tempo).toBe(2.004);
  });

  it("an unmarked re-broadcast of the SAME value (an older peer's emitDeckControls) keeps the lock", () => {
    const s = session();
    s.host.pressSync("B");
    s.guest.apply({ kind: "control", deck: "B", param: "tempo", value: 2 });
    expect(s.guest.engine.syncSlave).toBe("B");
  });

  it("★ a guest's hand on the follower's tempo releases the lock on the HOST (was: host kept it)", () => {
    const s = session();
    s.host.pressSync("B");
    s.guest.engine.deck("B").setTempo(5); // the guest drags B's fader
    s.guest.emit({ kind: "control", deck: "B", param: "tempo", value: 5 }, { local: false });
    expect(s.guest.engine.syncSlave).toBeNull();
    expect(s.host.engine.syncSlave).toBeNull();
    expect(s.host.engine.deck("B").tempo).toBe(5);
  });

  it("a hand that drags the follower to EXACTLY the locked value still releases everywhere", () => {
    // The receiver cannot tell this from an echo by the number alone, so the presser says so
    // (shouldAnnounceAutoRole: a guest announces a release its own hand caused).
    const s = session();
    s.host.pressSync("B");
    s.guest.engine.deck("B").setTempo(2);
    s.guest.emit({ kind: "control", deck: "B", param: "tempo", value: 2 }, { local: false });
    expect(s.host.engine.syncSlave).toBeNull();
  });

  it("a leader tempo move re-matches the follower on the guest, keeping the role", () => {
    const s = session();
    s.host.pressSync("B");
    s.host.engine.deck("A").setTempo(3);
    s.host.emit({ kind: "control", deck: "A", param: "tempo", value: 3 }, { local: false });
    expect(s.guest.engine.syncSlave).toBe("B");
    expect(s.guest.engine.deck("B").tempo).toBe(3);
  });
});

describe("KEY role crosses as a REAL role", () => {
  it("engage shifts the far follower; a press from the far side releases it on both, back to 0", () => {
    const s = session();
    s.host.pressKey("B");
    expect(s.guest.engine.keySlave).toBe("B");
    expect(s.guest.engine.deck("B").pitch).toBe(s.host.engine.deck("B").pitch);
    expect(s.guest.engine.deck("B").pitch).not.toBe(0);
    s.guest.pressKey("B");
    expect(s.host.engine.keySlave).toBeNull();
    expect(s.guest.engine.keySlave).toBeNull();
    expect(s.host.engine.deck("B").pitch).toBe(0);
    expect(s.guest.engine.deck("B").pitch).toBe(0);
  });
});

describe("gestures that used to emit nothing now reach the far deck", () => {
  it("jog start carries the sender's slip; the receiver grabs with it", () => {
    const s = session();
    s.host.emit({ kind: "jog", deck: "A", phase: "start", slip: true }, { local: false });
    expect(s.guest.engine.deck("A").log).toContain("scrubBegin slip=true");
    s.host.emit({ kind: "jog", deck: "A", phase: "start" }, { local: false });
    expect(s.guest.engine.deck("A").log).toContain("scrubBegin"); // an older peer: the receiver's own slip
  });

  it("cue/hot-cue hold preview, bend, spinback, brake, sustained reverse", () => {
    const s = session();
    const sends = [
      { kind: "board", deck: "A", id: "preview", phase: "down", arg: 12.5 },
      { kind: "board", deck: "A", id: "preview", phase: "up", arg: 1 },
      { kind: "board", deck: "A", id: "bend", arg: 0.02 },
      { kind: "board", deck: "A", id: "spinback", arg: 20 },
      { kind: "board", deck: "A", id: "brake" },
      { kind: "board", deck: "A", id: "reverse", phase: "down" },
      { kind: "board", deck: "A", id: "censor", phase: "up" },
    ] as const;
    for (const i of sends) s.host.emit(i, { local: false });
    expect(s.guest.engine.deck("A").log).toEqual(
      expect.arrayContaining(["previewHold 12.5", "previewRelease slip=true", "bend 0.02", "spinback 20", "brake", "reverse true", "censorEnd"]),
    );
  });

  it("a bend of zero, or a non-number, is ignored rather than guessed", () => {
    const s = session();
    applyBoardAction(s.guest.engine.deck("A") as unknown as Deck, "bend", undefined, 0);
    applyBoardAction(s.guest.engine.deck("A") as unknown as Deck, "bend", undefined, "x");
    expect(s.guest.engine.deck("A").log.some((l) => l.startsWith("bend"))).toBe(false);
  });

  it("the MIDI SMART CFX EQ bypass reaches both far decks", () => {
    const s = session();
    for (const d of ["A", "B"] as const) s.host.emit({ kind: "toggle", deck: d, param: "eqBypass", value: true });
    expect(s.guest.engine.deck("A").toggles.eqBypass).toBe(true);
    expect(s.guest.engine.deck("B").toggles.eqBypass).toBe(true);
  });
});
