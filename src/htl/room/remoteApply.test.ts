import { describe, expect, it } from "vitest";
import { isApplyingRemote, withRemote } from "./remoteApply";
import { applyIntent } from "./applyIntent";
import { SimDevice } from "./roomSim";

// ★ THE ECHO GUARD (operator, 2026-11-11: session sync audit): local broadcasters stay quiet while
// remote state is being applied, and only then.
describe("withRemote / isApplyingRemote", () => {
  it("is raised inside, lowered after, and nests", () => {
    expect(isApplyingRemote()).toBe(false);
    withRemote(() => {
      expect(isApplyingRemote()).toBe(true);
      withRemote(() => expect(isApplyingRemote()).toBe(true));
      expect(isApplyingRemote()).toBe(true);
    });
    expect(isApplyingRemote()).toBe(false);
  });
  it("is lowered even when the block throws", () => {
    expect(() => withRemote(() => { throw new Error("x"); })).toThrow();
    expect(isApplyingRemote()).toBe(false);
  });
  it("applyIntent runs inside it, so a deck method it calls cannot broadcast", () => {
    const d = new SimDevice("phone");
    let seen: boolean | null = null;
    d.engine.deck("A").onLoopEdit = () => (seen = isApplyingRemote());
    applyIntent({ kind: "loop", deck: "A", action: "beat", beats: 4 }, d.engine, d.host);
    expect(seen).toBe(true);
  });
});
