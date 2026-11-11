import { describe, expect, it } from "vitest";
import type { Peer } from "@htl/room/protocol";
import { relationOf } from "./relation";

const peer = (o: Partial<Peer>): Peer => ({
  id: "x",
  name: "X",
  kind: "Linux",
  host: false,
  joined: true,
  listening: true,
  controlling: false,
  anchor: false,
  pending: false,
  decks: "",
  stage: false,
  joinedAt: 0,
  color: "",
  ...o,
});

describe("relationOf (Session rows colour-coded by relationship)", () => {
  const friends = new Set(["mira"]);
  it("this device and my other devices are 'you' (host side: every host device)", () => {
    const me = peer({ id: "me", host: true, name: "Hector" });
    expect(relationOf(me, me, "me", friends)).toBe("you");
    expect(relationOf(peer({ id: "phone", host: true, name: "Hector" }), me, "me", friends)).toBe("you");
  });
  it("a guest's other device matches by account name; the host is 'host'", () => {
    const me = peer({ id: "me", name: "Mira" });
    expect(relationOf(peer({ id: "p2", name: "Mira" }), me, "me", friends)).toBe("you");
    expect(relationOf(peer({ id: "h", host: true, name: "Hector" }), me, "me", friends)).toBe("host");
  });
  it("friends by public handle, then crowd (stepped up), then guest", () => {
    const me = peer({ id: "me", host: true, name: "Hector" });
    expect(relationOf(peer({ id: "a", handle: "Mira" }), me, "me", friends)).toBe("friend");
    expect(relationOf(peer({ id: "b", stage: true }), me, "me", friends)).toBe("crowd");
    expect(relationOf(peer({ id: "c" }), me, "me", friends)).toBe("guest");
    expect(relationOf(peer({ id: "d", stage: true, handle: "mira" }), me, "me", friends)).toBe("friend");
  });
});
