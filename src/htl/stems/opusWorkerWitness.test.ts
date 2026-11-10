import { afterEach, describe, expect, it, vi } from "vitest";

// THE STEM WORKER'S FALLBACK IS CORRECT AND INVISIBLE, which is the whole reason obligation
// bc201e32 demanded a witness before anyone was allowed to believe a green run. The stems still
// decode, they are still right, and the only difference is that the decode just ran on the MAIN
// THREAD — the entire thing the worker exists to avoid.
//
// That is not hypothetical here: the first two stemlab runs of this worker printed no numbers
// because the decode had silently fallen back (vite emits the worker as a separate asset the
// harness page was not serving). The path assertion caught it. These tests pin the machinery that
// made that possible, and the three behaviours inherited from analyzeWorker's corrections rather
// than re-derived: a witness per CAUSE, a hang attributed to a GENERATION, and a worker KEPT
// across onerror.

const planes = () => ({ planes: [new Float32Array(8), new Float32Array(8)], sampleRate: 48000 });
const packedStem = (len = 8) => ({
  L: new Int16Array(len),
  R: new Int16Array(len),
  length: len,
  sampleRate: 48000,
  base: { min: new Float32Array(1), max: new Float32Array(1), low: new Float32Array(1), mid: new Float32Array(1), high: new Float32Array(1), bucket: 256 },
});
vi.mock("./opus", () => ({
  decodeStemOpusPlanes: vi.fn(async () => planes()),
  decodeStemOpusPacked: vi.fn(async (_b: ArrayBuffer, o: { limit?: number }) => packedStem(o?.limit ?? 8)),
  planesToBuffer: vi.fn(async () => ({}) as AudioBuffer),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fresh() {
  vi.resetModules();
  return import("./opusWorker");
}

const bytes = () => new ArrayBuffer(64);

describe("the stem decode worker says which thread it ran on", () => {
  it("a construction failure falls back inline, says so, and REPORTS the path", async () => {
    vi.stubGlobal("Worker", class { constructor() { throw new Error("no workers here"); } });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { decodeStemPlanesAsync, lastDecodePath } = await fresh();
    const r = await decodeStemPlanesAsync(bytes());
    expect(r.sampleRate).toBe(48000); // the fallback is CORRECT — that is why it needs a witness
    expect(lastDecodePath()).toBe("inline");
    expect(info.mock.calls.map((c) => String(c[0])).some((s) => /stem decode worker unavailable/.test(s) && /MAIN THREAD/.test(s))).toBe(true);
  });

  it("says it ONCE per session, not once per stem — four stems load per song", async () => {
    vi.stubGlobal("Worker", class { constructor() { throw new Error("no workers here"); } });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { decodeStemPlanesAsync } = await fresh();
    for (let i = 0; i < 4; i++) await decodeStemPlanesAsync(bytes());
    expect(info.mock.calls.map((c) => String(c[0])).filter((s) => /stem decode worker unavailable/.test(s))).toHaveLength(1);
  });

  it("reports 'worker' when the worker actually answers — the assertion a harness leans on", async () => {
    vi.stubGlobal("Worker", class {
      onmessage?: (e: { data: unknown }) => void;
      postMessage(m: { id: number }) {
        setTimeout(() => this.onmessage?.({ data: { id: m.id, ...planes() } }), 0);
      }
      terminate() {}
    });
    const { decodeStemPlanesAsync, lastDecodePath } = await fresh();
    await decodeStemPlanesAsync(bytes());
    expect(lastDecodePath()).toBe("worker");
  });

  it("KEEPS the worker across onerror — a Worker measurably survives an uncaught error", async () => {
    // Measured in this repo's own Chromium: it fires onerror, drops that one message, and answers
    // the very next one normally. Retiring it here would throw away a healthy worker. (A worklet is
    // the opposite, which is why the same word for both is a trap.)
    let live: { onerror?: () => void; onmessage?: (e: { data: unknown }) => void } | null = null;
    let constructed = 0;
    let first = true;
    vi.stubGlobal("Worker", class {
      onerror?: () => void;
      onmessage?: (e: { data: unknown }) => void;
      constructor() { constructed++; live = this; }
      postMessage(m: { id: number }) {
        if (first) { first = false; setTimeout(() => live?.onerror?.(), 0); }
        else setTimeout(() => live?.onmessage?.({ data: { id: m.id, ...planes() } }), 0);
      }
      terminate() {}
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { decodeStemPlanesAsync, lastDecodePath } = await fresh();
    await decodeStemPlanesAsync(bytes());
    expect(lastDecodePath()).toBe("inline"); // that one load fell back
    await decodeStemPlanesAsync(bytes());
    expect(lastDecodePath()).toBe("worker"); // …and the NEXT one did not
    expect(constructed).toBe(1); // never retired
    expect(info.mock.calls.map((c) => String(c[0])).some((s) => /threw mid-flight/.test(s) && /survives/.test(s))).toBe(true);
  });

  it("a FIRST hang buys one reconstruction; the SECOND is permanent", async () => {
    vi.useFakeTimers();
    try {
      let constructed = 0;
      vi.stubGlobal("Worker", class { constructor() { constructed++; } postMessage() {} terminate() {} });
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const { decodeStemPlanesAsync } = await fresh();

      const a = decodeStemPlanesAsync(bytes());
      await vi.advanceTimersByTimeAsync(31_000);
      await a;
      expect(constructed).toBe(1);

      const b = decodeStemPlanesAsync(bytes());
      await vi.advanceTimersByTimeAsync(31_000);
      await b;
      expect(constructed).toBe(2); // it tried again — a reclaimed worker is transient

      await decodeStemPlanesAsync(bytes());
      expect(constructed).toBe(2); // …and the second hang retires it

      const said = info.mock.calls.map((c) => String(c[0])).filter((s) => /stem decode worker unavailable/.test(s));
      expect(said).toHaveLength(2);
      expect(said[0]).toMatch(/will try once more/);
      expect(said[1]).toMatch(/twice/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("★ FOUR STEMS STRANDED BY ONE RECLAMATION ARE ONE INCIDENT, not four", async () => {
    // Four stems decode per song load and overlap by construction, so counting each stranded
    // request would spend the entire retry budget on a single reclamation — on a phone, which is
    // the only platform where reclamation happens. This defect shipped in analyzeWorker before
    // Metron found it there; it is pinned here so it cannot arrive twice.
    vi.useFakeTimers();
    try {
      let constructed = 0;
      vi.stubGlobal("Worker", class { constructor() { constructed++; } postMessage() {} terminate() {} });
      vi.spyOn(console, "info").mockImplementation(() => {});
      const { decodeStemPlanesAsync } = await fresh();

      const four = [0, 1, 2, 3].map(() => decodeStemPlanesAsync(bytes()));
      await vi.advanceTimersByTimeAsync(31_000);
      for (const p of four) expect((await p).sampleRate).toBe(48000);
      expect(constructed).toBe(1);

      // The retry must still be intact: this was the FIRST incident, whatever it stranded.
      const next = decodeStemPlanesAsync(bytes());
      expect(constructed).toBe(2);
      await vi.advanceTimersByTimeAsync(31_000);
      await next;
    } finally {
      vi.useRealTimers();
    }
  });

  it("the PACKED int16 decode (mobile path) takes the same worker and the same witnessed fallback", async () => {
    // Worker answers with int16: nothing float32 crosses, and the path says "worker".
    const posted: unknown[] = [];
    vi.stubGlobal("Worker", class {
      onmessage?: (e: { data: unknown }) => void;
      postMessage(m: { id: number; pack?: { limit?: number } }, transfer: unknown[]) {
        posted.push({ pack: m.pack, transferred: transfer.length });
        setTimeout(() => this.onmessage?.({ data: { id: m.id, packed: packedStem(m.pack?.limit ?? 8) } }), 0);
      }
      terminate() {}
    });
    let mod = await fresh();
    const viaWorker = await mod.decodeStemPackedOffThread(bytes(), 12);
    expect(viaWorker.length).toBe(12);
    expect(viaWorker.L).toBeInstanceOf(Int16Array);
    expect(mod.lastDecodePath()).toBe("worker");
    expect(posted).toEqual([{ pack: { limit: 12 }, transferred: 1 }]); // the blob is transferred, not copied

    // No worker → decoded inline, with the limit passed through, and the fallback is reported.
    vi.stubGlobal("Worker", class { constructor() { throw new Error("no workers here"); } });
    vi.spyOn(console, "info").mockImplementation(() => {});
    mod = await fresh();
    const inline = await mod.decodeStemPackedOffThread(bytes(), 5);
    expect(inline.length).toBe(5);
    expect(mod.lastDecodePath()).toBe("inline");
  });
});
