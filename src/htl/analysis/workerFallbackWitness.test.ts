import { afterEach, describe, expect, it, vi } from "vitest";

// A SILENTLY DEGRADED WORKER LOOKS EXACTLY LIKE A WORKING ONE.
//
// Every fallback in analyzeWorker is correct and invisible: the track loads, the analysis is right,
// and the only difference is that the detector just ran on the MAIN THREAD — the one thing the
// module exists to avoid. "Seems fine" is unfalsifiable without a witness, and the symptom (a long
// frame at track load) surfaces nowhere near the cause. Metron's bc201e32 requires the same of the
// stems worker before a green run from it can be believed; this is the live instance of that class.
//
// The test is about the WITNESS, not the analysis: that it speaks, that it speaks once, and that it
// distinguishes causes that need different fixes.

const buf = () => {
  const d = new Float32Array(4096);
  for (let i = 0; i < d.length; i++) d[i] = Math.sin(i / 8) * 0.2;
  return { sampleRate: 48000, length: d.length, numberOfChannels: 1, getChannelData: () => d } as unknown as AudioBuffer;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fresh() {
  vi.resetModules();
  return import("./analyzeWorker");
}

describe("the analysis worker says so when it is not being used", () => {
  it("reports a construction failure, and still returns a real analysis", async () => {
    vi.stubGlobal("Worker", class { constructor() { throw new Error("no workers here"); } });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { analyzeTrackAsync } = await fresh();
    const a = await analyzeTrackAsync(buf());
    expect(a).toBeTruthy(); // the fallback is correct — that is exactly why it needs a witness
    const said = info.mock.calls.map((c) => String(c[0]));
    expect(said.some((s) => /analysis worker unavailable/.test(s) && /MAIN THREAD/.test(s))).toBe(true);
  });

  it("says it ONCE, not once per track load", async () => {
    vi.stubGlobal("Worker", class { constructor() { throw new Error("no workers here"); } });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { analyzeTrackAsync } = await fresh();
    await analyzeTrackAsync(buf());
    await analyzeTrackAsync(buf());
    await analyzeTrackAsync(buf());
    const said = info.mock.calls.map((c) => String(c[0])).filter((s) => /analysis worker unavailable/.test(s));
    expect(said).toHaveLength(1); // a line per load is noise nobody reads
  });

  it("distinguishes a worker that DIED from one that never existed — different causes, different fixes", async () => {
    let live: { onerror?: () => void } | null = null;
    vi.stubGlobal(
      "Worker",
      class {
        onerror?: () => void;
        onmessage?: unknown;
        constructor() {
          live = this as { onerror?: () => void };
        }
        postMessage() {
          setTimeout(() => live?.onerror?.(), 0); // constructed fine, then fell over
        }
      },
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { analyzeTrackAsync } = await fresh();
    const a = await analyzeTrackAsync(buf());
    expect(a).toBeTruthy();
    const said = info.mock.calls.map((c) => String(c[0])).filter((s) => /analysis worker unavailable/.test(s));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/died mid-flight/);
    expect(said[0]).not.toMatch(/could not be constructed/);
  });

  it("a worker that goes SILENT does not hang the load — it is the failure with no event", async () => {
    // Construction failure and onerror both announce themselves. This one does not: the worker
    // accepts the message and never replies. App.tsx awaits this on the track-load path, so without
    // a clock the deck never lands at all — no error, no fallback, no line.
    vi.useFakeTimers();
    try {
      vi.stubGlobal("Worker", class { onerror?: () => void; onmessage?: unknown; postMessage() { /* swallowed, forever */ } terminate() {} });
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const { analyzeTrackAsync } = await fresh();
      const p = analyzeTrackAsync(buf());
      await vi.advanceTimersByTimeAsync(31_000);
      const a = await p;
      expect(a).toBeTruthy(); // it LANDS, which is the whole point
      const said = info.mock.calls.map((c) => String(c[0])).filter((s) => /analysis worker unavailable/.test(s));
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/stopped answering/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("one hang retires the worker, so the NEXT load does not pay the budget again", async () => {
    vi.useFakeTimers();
    try {
      let constructed = 0;
      vi.stubGlobal("Worker", class { onerror?: () => void; onmessage?: unknown; constructor() { constructed++; } postMessage() {} terminate() {} });
      vi.spyOn(console, "info").mockImplementation(() => {});
      const { analyzeTrackAsync } = await fresh();
      const first = analyzeTrackAsync(buf());
      await vi.advanceTimersByTimeAsync(31_000);
      await first;
      expect(constructed).toBe(1);
      // The second load must resolve WITHOUT another 30 s wait — no timer advance here at all.
      await analyzeTrackAsync(buf());
      expect(constructed).toBe(1); // retired, never rebuilt
    } finally {
      vi.useRealTimers();
    }
  });
});
