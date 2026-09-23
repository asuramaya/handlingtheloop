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

  it("distinguishes a worker that THREW from one that never existed — different causes, different fixes", async () => {
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
    // Measured, not assumed: a Worker SURVIVES an uncaught error — it fires onerror, drops that one
    // message, and answers the next normally. The line must not claim it died, because it did not.
    expect(said[0]).toMatch(/threw mid-flight/);
    expect(said[0]).toMatch(/survives/);
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

  it("two loads stranded by ONE reclamation are one incident, not two — the counter counts incidents", async () => {
    // Requests overlap as a matter of course: usePrefetch can have an analysis in flight when a
    // user load starts, and every request arms its own clock. One reclaimed worker strands both,
    // both timers fire, and counting each victim spent the whole retry budget on a single
    // reclamation — on a phone under memory pressure, which is the case the retry exists for.
    vi.useFakeTimers();
    try {
      let constructed = 0;
      vi.stubGlobal("Worker", class { onerror?: () => void; onmessage?: unknown; constructor() { constructed++; } postMessage() {} terminate() {} });
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const { analyzeTrackAsync } = await fresh();

      const a = analyzeTrackAsync(buf());
      const b = analyzeTrackAsync(buf()); // same worker, same silence
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await a).toBeTruthy();
      expect(await b).toBeTruthy();
      expect(constructed).toBe(1);

      // The retry must still be there: this is the FIRST incident, whatever it stranded.
      const third = analyzeTrackAsync(buf());
      expect(constructed).toBe(2);
      await vi.advanceTimersByTimeAsync(31_000);
      await third;

      const said = info.mock.calls.map((c) => String(c[0])).filter((s) => /analysis worker unavailable/.test(s));
      expect(said).toHaveLength(2);
      expect(said[0]).toMatch(/will try once more/); // not "twice" — two victims, one incident
      expect(said[1]).toMatch(/twice/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a FIRST hang buys one reconstruction — a reclaimed worker is transient, not broken", async () => {
    // The trigger for a hang is a browser reclaiming the worker under memory pressure, which is
    // transient: a backgrounded phone reclaims, returns, and would construct one fine. Retiring for
    // the session would convert one reclamation into a session-long main-thread regression, on the
    // platform least able to afford it. (This test asserted the opposite an hour ago; the old
    // behaviour was wrong and so was the test that pinned it.)
    vi.useFakeTimers();
    try {
      let constructed = 0;
      vi.stubGlobal("Worker", class { onerror?: () => void; onmessage?: unknown; constructor() { constructed++; } postMessage() {} terminate() {} });
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const { analyzeTrackAsync } = await fresh();

      const first = analyzeTrackAsync(buf());
      await vi.advanceTimersByTimeAsync(31_000);
      await first;
      expect(constructed).toBe(1);

      const second = analyzeTrackAsync(buf());
      await vi.advanceTimersByTimeAsync(31_000);
      await second;
      expect(constructed).toBe(2); // it tried again, which is the point

      // …and the SECOND hang is permanent: no third construction, no third budget.
      await analyzeTrackAsync(buf());
      expect(constructed).toBe(2);

      const said = info.mock.calls.map((c) => String(c[0])).filter((s) => /analysis worker unavailable/.test(s));
      expect(said).toHaveLength(2); // two different facts, not one repeated
      expect(said[0]).toMatch(/will try once more/);
      expect(said[1]).toMatch(/twice/);
    } finally {
      vi.useRealTimers();
    }
  });
});
