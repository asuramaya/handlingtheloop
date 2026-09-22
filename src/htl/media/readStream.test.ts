import { describe, expect, it, vi, afterEach } from "vitest";
import { readStream, STREAM_STALL_MS } from "./source";

// ★ THE FAILURE THIS EXISTS FOR: a half-open connection where `reader.read()` never settles — no
// bytes, no error, no end. The load awaiting it never finishes and never reports, which is how a
// listener ended up with one deck adopted and one deck silently stuck on its own track for a whole
// session (ruling 92d04ef9). The abort signal is no help: nobody knows to abort.
afterEach(() => {
  vi.useRealTimers();
});

function reader(script: (Promise<{ done: boolean; value?: Uint8Array }> | "hang")[]) {
  let i = 0;
  const cancelled: unknown[] = [];
  return {
    cancelled,
    read: () => {
      const step = script[Math.min(i++, script.length - 1)];
      return step === "hang" ? new Promise<{ done: boolean; value?: Uint8Array }>(() => {}) : step;
    },
    cancel: (reason?: unknown) => {
      cancelled.push(reason ?? null);
    },
  };
}
const chunk = (n: number) => Promise.resolve({ done: false, value: new Uint8Array(n) });
const end = Promise.resolve({ done: true });

describe("readStream", () => {
  it("drains a normal stream and reports every chunk", async () => {
    const got: number[] = [];
    await readStream(reader([chunk(3), chunk(5), end]), (v) => got.push(v.byteLength));
    expect(got).toEqual([3, 5]);
  });

  it("a stream that goes SILENT throws instead of hanging forever", async () => {
    vi.useFakeTimers();
    const r = reader([chunk(1), "hang"]);
    const p = readStream(r, () => {}, 1000);
    const assertion = expect(p).rejects.toThrow(/stalled/i);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it("releases the socket when it gives up — a stalled reader left open holds the connection", async () => {
    vi.useFakeTimers();
    const r = reader(["hang"]);
    const p = readStream(r, () => {}, 500);
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    expect(r.cancelled.length).toBe(1);
  });

  it("CONTROL: a SLOW stream that keeps delivering is never killed — the clock measures silence, not duration", async () => {
    vi.useFakeTimers();
    let delivered = 0;
    const slow = {
      read: () =>
        new Promise<{ done: boolean; value?: Uint8Array }>((res) =>
          setTimeout(() => (delivered++ < 5 ? res({ done: false, value: new Uint8Array(1) }) : res({ done: true })), 900),
        ),
      cancel: () => {},
    };
    const p = readStream(slow, () => {}, 1000);
    await vi.advanceTimersByTimeAsync(6000);
    await expect(p).resolves.toBeUndefined();
    expect(delivered).toBeGreaterThan(4);
  });

  it("the default window is generous enough that only a real hang trips it", () => {
    expect(STREAM_STALL_MS).toBeGreaterThanOrEqual(10_000);
  });
});
