import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";

// THE CLIENT'S "APPLIERS NEVER GATE" RULE IS A CONCLUSION ABOUT THIS FILE, NOT A PROPERTY OF
// APPLIERS — Metron's correction to my ba5eb70e draft, and it is the half I had not stated.
//
// App.tsx's snapshot appliers (applyDeckControls / applyDeckRack / applyDeckStems, 40 write sites)
// must NOT ask canDriveDeck: they write the room's authoritative state into this device's decks, and
// a follower that gated them would stop following. That is correct, and it is SAFE ONLY BECAUSE an
// intent a device may not send never becomes authoritative in the first place — the server drops it.
//
// So the client has no second line, by design. Which makes this the whole line: every path that
// turns an inbound message into a broadcast `t: "intent"` must pass canDrive first. There is exactly
// ONE such path today (room.ts:797-798). A second one added without the check would make every
// applier on every client an unguarded write, and nothing on the client would object — because we
// will have just finished designing them not to.
//
// Asserted by DERIVATION, not by pinning the count: a new broadcast path is found and required to
// gate, rather than merely making a "1" into a "2".
const SRC = readFileSync(new URL("./room.ts", import.meta.url), "utf8");

describe("an intent only becomes authoritative if the sender may drive it", () => {
  const sites = [...SRC.matchAll(/\{\s*t:\s*"intent"/g)].map((m) => ({
    at: SRC.slice(0, m.index).split("\n").length,
    index: m.index!,
  }));

  test("there is at least one intent-broadcast site (vacuity guard)", () => {
    // An empty list would make the real assertion below pass while proving nothing — the failure
    // mode of every scan in this repo that had to be widened afterwards.
    expect(sites.length).toBeGreaterThan(0);
  });

  test("every intent broadcast is gated by canDrive within its own handler", () => {
    const ungated = sites.filter((s) => {
      // Back to the top of the enclosing handler — the nearest `case "…":` label above it.
      const head = SRC.lastIndexOf('case "', s.index);
      const block = SRC.slice(head < 0 ? 0 : head, s.index);
      return !/\bthis\.canDrive\s*\(/.test(block);
    });
    expect(
      ungated.map(
        (s) =>
          `server/room.ts:${s.at} broadcasts an intent with no canDrive check in its handler — ` +
          `every client's snapshot appliers trust this gate and have no second line`,
      ),
    ).toEqual([]);
  });

  test("the gate defers to the PURE per-deck rule, so a single-deck guest cannot move the rest", () => {
    // canDrive resolves the device's strongest permission and hands the decision to canDriveIntent
    // (src/htl/room/protocol). If that delegation is ever inlined, the shared rule and the server's
    // rule become two copies of one decision — the wire-duplication defect wireConstants pins.
    expect(SRC).toMatch(/private canDrive\([\s\S]{0,600}?return canDriveIntent\(/);
    expect(SRC).toMatch(/import \{[^}]*canDriveIntent[^}]*\} from "\.\.\/src\/htl\/room\/protocol"/);
  });
});
