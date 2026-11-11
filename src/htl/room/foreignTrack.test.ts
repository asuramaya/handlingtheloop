import { describe, expect, it } from "vitest";
import { holdsForeignTrack, isAudibleDeckIntent } from "./sessionFollow";

describe("holdsForeignTrack — a follower deck holding a track the session is not playing", () => {
  it("a guest's own track while the anchor ticks another (pressed play while knocking)", () => {
    expect(holdsForeignTrack({ loadedId: "mine", tickVid: "host", roomLoadTarget: null })).toBe(true);
  });
  it("the outgoing track while the host's track downloads (room load in flight)", () => {
    expect(holdsForeignTrack({ loadedId: "mine", tickVid: null, roomLoadTarget: "host" })).toBe(true);
    expect(holdsForeignTrack({ loadedId: null, tickVid: "host", roomLoadTarget: "host" })).toBe(true);
  });
  it("landed on the session's track: not foreign", () => {
    expect(holdsForeignTrack({ loadedId: "host", tickVid: "host", roomLoadTarget: "host" })).toBe(false);
    expect(holdsForeignTrack({ loadedId: "host", tickVid: "host", roomLoadTarget: null })).toBe(false);
  });
  it("an older anchor that stamps nothing, and no load in flight: cannot tell, so not foreign", () => {
    expect(holdsForeignTrack({ loadedId: "x", tickVid: undefined, roomLoadTarget: null })).toBe(false);
  });
  it("a co-DJ's OWN shared pick, landed before the anchor's: not foreign", () => {
    expect(holdsForeignTrack({ loadedId: "picked", tickVid: "old", roomLoadTarget: "picked" })).toBe(false);
  });
});

describe("isAudibleDeckIntent — intents that would sound a foreign buffer", () => {
  it("transport of every kind, and a hot-cue press", () => {
    expect(isAudibleDeckIntent("transport", "play")).toBe(true);
    expect(isAudibleDeckIntent("transport", "seek")).toBe(true);
    expect(isAudibleDeckIntent("hotcue", "press")).toBe(true);
  });
  it("not knobs, cue points or a hot-cue save", () => {
    expect(isAudibleDeckIntent("control")).toBe(false);
    expect(isAudibleDeckIntent("cue")).toBe(false);
    expect(isAudibleDeckIntent("hotcue", "save")).toBe(false);
  });
});
