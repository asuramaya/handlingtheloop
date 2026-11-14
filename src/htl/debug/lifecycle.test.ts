import { describe, expect, it } from "vitest";
import { type LifeRecord, classifyExit } from "./lifecycle";

const rec = (over: Partial<LifeRecord>): LifeRecord => ({ id: "x", start: 0, beat: 1000, state: "visible", exit: null, ...over });

describe("classifyExit — refresh vs crash", () => {
  it("first boot", () => expect(classifyExit(null, "navigate", false)).toBe("first"));
  it("a refresh unloads cleanly (pagehide) and reloads", () => expect(classifyExit(rec({ exit: "pagehide" }), "reload", false)).toBe("refresh"));
  it("a close or navigation unloads cleanly and comes back as a navigation", () =>
    expect(classifyExit(rec({ exit: "pagehide" }), "navigate", false)).toBe("closed"));
  it("no clean exit while on screen is a crash — even when the browser reloads it for you", () => {
    expect(classifyExit(rec({ state: "visible" }), "reload", false)).toBe("crash");
    expect(classifyExit(rec({ state: "visible" }), "navigate", false)).toBe("crash");
  });
  it("no clean exit while hidden is a background kill, not our crash", () => {
    expect(classifyExit(rec({ state: "hidden" }), "navigate", false)).toBe("background");
    expect(classifyExit(rec({ state: "frozen" }), "reload", false)).toBe("background");
  });
  it("the browser saying it discarded the tab wins over the visibility guess", () =>
    expect(classifyExit(rec({ state: "visible" }), "reload", true)).toBe("discarded"));
});
