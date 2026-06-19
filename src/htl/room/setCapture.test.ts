import { describe, it, expect } from "vitest";
import { SetCapture } from "./setCapture";
import { ENGINE_VERSION } from "./protocol";

// A hand-cranked clock so capture timing is deterministic.
function clocked() {
  let t = 0;
  const cap = new SetCapture(() => t);
  return { cap, at: (ms: number) => (t = ms) };
}

describe("SetCapture", () => {
  it("captures only the recipe-relevant kinds, stamped relative to start", () => {
    const { cap, at } = clocked();
    at(1000);
    cap.start();
    at(1100);
    cap.record({ t: "intent", intent: { kind: "transport", deck: "A", play: true } as never });
    at(1200);
    cap.record({ t: "stemview", deck: "A", view: {} }); // display data — excluded
    at(1300);
    cap.record({ t: "state", snapshot: { foo: 1 } });
    at(1400);
    cap.record({ t: "lyrics", deck: "A", videoId: "x", lines: [], source: "yt" }); // excluded
    at(1500);
    cap.record({ t: "automix", state: {} });
    const set = cap.stop();
    expect(set).not.toBeNull();
    expect(set!.log.map((e) => e.m.t)).toEqual(["intent", "state", "automix"]);
    expect(set!.log[0].t).toBe(100); // 1100 - 1000 start
    expect(set!.engineVersion).toBe(ENGINE_VERSION);
    expect(set!.duration).toBe(500);
  });

  it("downsamples ticks to ~1/sec but keeps every intent", () => {
    const { cap, at } = clocked();
    cap.start();
    for (let ms = 0; ms <= 2500; ms += 250) {
      at(ms);
      cap.record({ t: "tick", decks: {} as never });
    }
    const ticks = cap.stop()!.log.filter((e) => e.m.t === "tick");
    // 0, 1000, 2000 → 3 anchors out of 11 raw ticks.
    expect(ticks.map((e) => e.t)).toEqual([0, 1000, 2000]);
  });

  it("builds a deduped tracklist + cover from now-playing marks", () => {
    const { cap, at } = clocked();
    cap.start();
    at(0);
    cap.mark({ videoId: "aaaaaaaaaaa", title: "One", artist: "X" });
    at(50);
    cap.mark({ videoId: "aaaaaaaaaaa", title: "One", artist: "X" }); // dup — ignored
    at(3000);
    cap.mark({ videoId: "bbbbbbbbbbb", title: "Two", artist: "Y" });
    const set = cap.stop()!;
    expect(set.tracklist.map((m) => m.videoId)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(set.tracklist[1].at).toBe(3000);
    expect(set.coverVideo).toBe("aaaaaaaaaaa");
  });

  it("returns null for an empty capture and is idempotent", () => {
    const { cap } = clocked();
    cap.start();
    expect(cap.stop()).toBeNull();
    expect(cap.stop()).toBeNull(); // second call after stop — no throw, still null
  });

  it("ignores records while not capturing", () => {
    const { cap } = clocked();
    cap.record({ t: "intent", intent: {} as never }); // before start
    cap.start();
    cap.stop();
    cap.record({ t: "intent", intent: {} as never }); // after stop
    expect(cap.capturing).toBe(false);
  });
});
