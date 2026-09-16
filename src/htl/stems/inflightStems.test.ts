// ONE JOB PER (TRACK, MODEL), enforced inside loadStems. The bug this pins: a remote stem request
// on the host went through forceSeparate, which never read App's `stemJobs` map, so while the
// host's own separation of a track was still running, a guest's request started a SECOND full
// separation of that same track. The operator's requirement is "never duplicate work", and the
// dedupe only covered callers that remembered to consult it.
//
// Like the authority test, the load-bearing assertions are on an EFFECT THAT MUST NOT HAPPEN —
// how many times the separator was STARTED — because a duplicate separation still produces
// correct stems. Nothing about the output tells you the host did the work twice.
import { describe, it, expect, vi, beforeEach } from "vitest";

// A controllable separator: each call parks until the test resolves it, and exposes the progress
// callback it was handed so the test can drive progress for that job.
type Parked = { resolve: (v: unknown) => void; reject: (e: unknown) => void; progress: (p: number) => void };
const parked: Parked[] = [];
const separateNeural = vi.fn((_mix: unknown, _m: unknown, onProgress: (p: number) => void) =>
  new Promise((resolve, reject) => parked.push({ resolve, reject, progress: onProgress })),
);
vi.mock("./separate", () => ({
  separateNeural: (...a: unknown[]) => (separateNeural as unknown as (...x: unknown[]) => unknown)(...a),
  setDemucsQuality: () => {},
}));
vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) }))); // cold cache
vi.mock("./models", async (orig) => ({ ...((await orig()) as object), deviceSupportsModel: () => true }));

import { loadStems, setSeparationAuthority, STEM_NAMES } from "./index";
import { getStemModel } from "./models";

const MODEL = getStemModel("htdemucs");
const ctx = { sampleRate: 44100 } as unknown as BaseAudioContext;
const mix = { length: 44100, sampleRate: 44100, numberOfChannels: 2 } as unknown as AudioBuffer;
const stems = Object.fromEntries(STEM_NAMES.map((n) => [n, mix]));
// runLoadStems awaits the (cold) manifest probe before it reaches the separator.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("one separation per (track, model)", () => {
  beforeEach(() => {
    separateNeural.mockClear();
    parked.length = 0;
    setSeparationAuthority(() => true);
  });

  it("a second caller for the same track JOINS the running job — the separator starts ONCE", async () => {
    const hostOwn = loadStems(ctx, "trackAAAAAA", mix, MODEL); // the host's own derive
    await flush();
    const guestRequest = loadStems(ctx, "trackAAAAAA", mix, MODEL); // a remote request mid-run
    await flush();
    expect(separateNeural).toHaveBeenCalledTimes(1); // the whole point
    parked[0].resolve(stems);
    await expect(hostOwn).resolves.toBe(stems);
    await expect(guestRequest).resolves.toBe(stems);
  });

  it("a joining caller hears progress — replayed immediately, then live", async () => {
    const seen: number[] = [];
    void loadStems(ctx, "trackBBBBBB", mix, MODEL);
    await flush();
    parked[0].progress(0.4); // job is 40% in before the request arrives
    void loadStems(ctx, "trackBBBBBB", mix, MODEL, (p) => seen.push(p));
    expect(seen).toEqual([0.4]); // replay: a requester joining at 40% hears 40% NOW, not silence
    parked[0].progress(0.5);
    expect(seen).toEqual([0.4, 0.5]); // and then follows the live job
    parked[0].resolve(stems);
  });

  it("FORCE (re-analyze) always starts its own job — the user asked for a fresh compute", async () => {
    void loadStems(ctx, "trackCCCCCC", mix, MODEL);
    await flush();
    void loadStems(ctx, "trackCCCCCC", mix, MODEL, undefined, true);
    await flush();
    expect(separateNeural).toHaveBeenCalledTimes(2);
    parked.forEach((j) => j.resolve(stems));
  });

  it("an ordinary caller arriving mid-re-analyze joins it rather than starting a third job", async () => {
    void loadStems(ctx, "trackDDDDDD", mix, MODEL, undefined, true);
    await flush();
    void loadStems(ctx, "trackDDDDDD", mix, MODEL);
    await flush();
    expect(separateNeural).toHaveBeenCalledTimes(1);
    parked[0].resolve(stems);
  });

  it("different tracks or models are different jobs", async () => {
    void loadStems(ctx, "trackEEEEEE", mix, MODEL);
    void loadStems(ctx, "trackFFFFFF", mix, MODEL);
    await flush();
    expect(separateNeural).toHaveBeenCalledTimes(2);
    parked.forEach((j) => j.resolve(stems));
  });

  it("a finished job is not cached forever — the next call starts fresh", async () => {
    const first = loadStems(ctx, "trackGGGGGG", mix, MODEL);
    await flush();
    parked[0].resolve(stems);
    await first;
    await flush();
    void loadStems(ctx, "trackGGGGGG", mix, MODEL);
    await flush();
    expect(separateNeural).toHaveBeenCalledTimes(2);
    parked[1].resolve(stems);
  });

  it("a failure reaches every joined caller, then clears so a retry can run", async () => {
    const a = loadStems(ctx, "trackHHHHHH", mix, MODEL);
    await flush();
    const b = loadStems(ctx, "trackHHHHHH", mix, MODEL);
    parked[0].reject(new Error("worker crashed"));
    await expect(a).rejects.toThrow("worker crashed");
    await expect(b).rejects.toThrow("worker crashed");
    await flush();
    void loadStems(ctx, "trackHHHHHH", mix, MODEL); // must NOT be handed the old failure
    await flush();
    expect(separateNeural).toHaveBeenCalledTimes(2);
    parked[1].resolve(stems);
  });
});
