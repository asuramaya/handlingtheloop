import { describe, it, expect } from "vitest";
import { type Attachment, roleOf, pubMayChange, PUB_ALLOWED, peerOf, welcomeFor, presenceFor, type RoomView } from "./roomState";

// A blank participant attachment; spread to make the role under test.
function att(over: Partial<Attachment>): Attachment {
  return {
    device: "d1", name: "Dev", kind: "Mac", host: false, joined: false, listening: false,
    controlling: false, pending: false, pub: false, decks: "", stageReq: "", stage: false,
    joinedAt: 0, color: "", ...over,
  };
}

describe("roleOf", () => {
  it("maps the flags to exactly one role", () => {
    expect(roleOf(att({ pub: true, joined: true, listening: true }))).toBe("crowd");
    expect(roleOf(att({ stage: true, joined: true, controlling: true, decks: "A" }))).toBe("stage");
    expect(roleOf(att({ pending: true }))).toBe("pending");
    expect(roleOf(att({}))).toBe("present");
    expect(roleOf(att({ joined: true, controlling: true, decks: "AB" }))).toBe("controller");
    expect(roleOf(att({ joined: true, listening: true }))).toBe("listener");
  });
  it("pub and stage win over the joined/controlling flags they also set", () => {
    // a stage device IS joined+controlling, but its role is 'stage' (anchor-ineligible etc.)
    expect(roleOf(att({ stage: true, joined: true, controlling: true, decks: "B", listening: true }))).toBe("stage");
    expect(roleOf(att({ pub: true, joined: true, listening: true }))).toBe("crowd");
  });
});

describe("PUB_ALLOWED / pubMayChange", () => {
  it("admits exactly the crowd messages", () => {
    for (const t of ["request-state", "leave", "stage", "react", "request"] as const) {
      expect(pubMayChange(t)).toBe(true);
    }
  });
  it("rejects every writer message", () => {
    for (const t of ["join", "control", "listen", "grant", "approve", "deny", "kick", "intent", "tick", "state", "public", "stageGate", "stage-approve", "stage-deny"] as const) {
      expect(pubMayChange(t)).toBe(false);
    }
  });
  it("never accidentally lists a deck-driving message", () => {
    expect(PUB_ALLOWED.has("intent")).toBe(false);
    expect(PUB_ALLOWED.has("control")).toBe(false);
  });
});

describe("peerOf", () => {
  it("carries the per-deck + stage fields and marks the anchor", () => {
    const p = peerOf(att({ device: "d2", joined: true, controlling: true, decks: "B", stage: true }), "d2");
    expect(p).toMatchObject({ id: "d2", joined: true, controlling: true, decks: "B", stage: true, anchor: true });
    expect(peerOf(att({ device: "d3" }), "d2").anchor).toBe(false);
  });
});

describe("welcomeFor / presenceFor", () => {
  const view: RoomView = {
    anchorId: "d1",
    peers: [peerOf(att({ device: "d1", joined: true }), "d1")],
    listeners: 7,
    isPublic: true,
    stageGate: "open",
    stage: [{ id: "x", name: "X", deck: "A" }],
  };

  it("gives a participant the roster + hand-raises + requests; the crowd gets none of it", () => {
    const reqs = [{ id: "q1", name: "Y", text: "Rosé — APT" }];
    const part = welcomeFor("d1", view, false, reqs);
    const crowd = welcomeFor("anon", view, true, reqs);
    if (part.t !== "welcome" || crowd.t !== "welcome") throw new Error("not welcome");
    expect(part.peers.length).toBe(1);
    expect(part.stage?.length).toBe(1);
    expect(part.requests?.length).toBe(1);
    expect(part.pub).toBeUndefined();
    // crowd: count + gate only, never the roster / hand-raises / requests
    expect(crowd.peers).toEqual([]);
    expect(crowd.pub).toBe(true);
    expect(crowd.stage).toBeUndefined();
    expect(crowd.requests).toBeUndefined();
    expect(crowd.listeners).toBe(7);
    expect(crowd.stageGate).toBe("open");
  });

  it("presence full carries the roster + hand-raises; lite is count + gate only", () => {
    const { full, lite } = presenceFor(view);
    if (full.t !== "presence" || lite.t !== "presence") throw new Error("not presence");
    expect(full.peers.length).toBe(1);
    expect(full.stage?.length).toBe(1);
    expect(lite.peers).toEqual([]);
    expect(lite.stage).toBeUndefined();
    expect(lite.listeners).toBe(7);
    expect(lite.stageGate).toBe("open");
  });
});
