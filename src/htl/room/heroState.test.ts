import { describe, it, expect } from "vitest";
import { heroState, type HeroInputs } from "./heroState";

const base: HeroInputs = {
  online: true,
  pending: false,
  listeningTo: null,
  broadcasting: false,
  isGuest: false,
  signedIn: true,
};
const s = (o: Partial<HeroInputs>) => heroState({ ...base, ...o });

describe("heroState", () => {
  it("reports each state on its own", () => {
    expect(s({ online: false })).toBe("offline");
    expect(s({ pending: true })).toBe("pending");
    expect(s({ listeningTo: "dj" })).toBe("listening");
    expect(s({ broadcasting: true })).toBe("live");
    expect(s({})).toBe("idle");
    expect(s({ signedIn: false, isGuest: true })).toBe("none");
  });

  // ★ THE PRIORITIES ARE THE POINT. Each of these is a state that CAN coexist with the one
  // below it, and picking the wrong winner is a real misreport, not a cosmetic one.
  it("OFFLINE beats everything — a dead socket makes every other reading stale", () => {
    expect(s({ online: false, broadcasting: true })).toBe("offline");
    expect(s({ online: false, listeningTo: "dj" })).toBe("offline");
    expect(s({ online: false, pending: true })).toBe("offline");
  });

  it("PENDING beats listening/live — what you could do is moot while you are held at the door", () => {
    expect(s({ pending: true, listeningTo: "dj" })).toBe("pending");
    expect(s({ pending: true, broadcasting: true })).toBe("pending");
  });

  it("LISTENING beats live — you are in someone else's room, and that is the fact on screen", () => {
    expect(s({ listeningTo: "dj", broadcasting: true })).toBe("listening");
  });

  it("a GUEST is never idle — idle offers 'Go live', which a guest cannot do", () => {
    expect(s({ isGuest: true })).toBe("none");
    expect(s({ isGuest: true, signedIn: true })).toBe("none");
  });

  it("signed out with no session has nothing to report", () => {
    expect(s({ signedIn: false })).toBe("none");
  });

  it("a guest CAN still be listening, pending or offline — 'none' is only the fallthrough", () => {
    expect(s({ isGuest: true, listeningTo: "dj" })).toBe("listening");
    expect(s({ isGuest: true, pending: true })).toBe("pending");
    expect(s({ isGuest: true, online: false })).toBe("offline");
  });
});
