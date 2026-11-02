import { describe, expect, it } from "vitest";
import { crashPrompts, type CrashGuardState } from "./crashPrompt";

const base: CrashGuardState = { gpuBlocked: false, gpuCrashedNow: false, gpuModelLabel: null, stemFailLevel: 0 };

describe("crashPrompts: a standing crash guard always asks, never disables silently", () => {
  it("asks nothing when no guard is standing", () => {
    expect(crashPrompts(base)).toEqual([]);
  });

  it("a crash THIS boot names the model and says it just happened", () => {
    const [p, ...rest] = crashPrompts({ ...base, gpuBlocked: true, gpuCrashedNow: true, gpuModelLabel: "Demucs" });
    expect(rest).toEqual([]);
    expect(p.id).toBe("gpu");
    expect(p.title).toMatch(/crashed while separating/);
    expect(p.body).toMatch(/^Demucs stem separation took the page down last time/);
    expect([p.accept, p.decline]).toEqual(["Try again", "Keep off"]);
  });

  it("a block CARRIED OVER from an earlier session still asks (the silent case this replaces)", () => {
    const [p] = crashPrompts({ ...base, gpuBlocked: true });
    expect(p.id).toBe("gpu");
    expect(p.title).toMatch(/paused after a crash/);
    expect(p.body).toMatch(/^GPU stem separation was paused/); // no model recorded → generic, not invented
  });

  it("the phone guard asks at level 1 (auto-fetch paused) and level 2 (stems off), with different words", () => {
    const l1 = crashPrompts({ ...base, stemFailLevel: 1 });
    const l2 = crashPrompts({ ...base, stemFailLevel: 2 });
    expect(l1.map((p) => p.id)).toEqual(["stems"]);
    expect(l1[0].body).toMatch(/automatic stem downloads are paused/);
    expect(l2[0].body).toMatch(/stems are off/);
  });

  it("both guards standing → both asked, GPU first", () => {
    expect(crashPrompts({ ...base, gpuBlocked: true, stemFailLevel: 1 }).map((p) => p.id)).toEqual(["gpu", "stems"]);
  });
});
