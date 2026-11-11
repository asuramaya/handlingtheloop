// Duplicated tab → distinct device ids (operator, 2026-11-11: session sync audit).
import { describe, it, expect, vi } from "vitest";
import { DeviceIdClaim, type ClaimChannel, type IdStore } from "./deviceClaim";

// A same-origin channel bus: a message posted on one end reaches every OTHER end, asynchronously.
function bus() {
  const ends: ClaimChannel[] = [];
  return () => {
    const end: ClaimChannel = {
      onmessage: null,
      postMessage(msg) {
        for (const e of ends) if (e !== end) queueMicrotask(() => e.onmessage?.({ data: structuredClone(msg) }));
      },
    };
    ends.push(end);
    return end;
  };
}
const store = (initial: string | null): IdStore & { v: string | null } => ({
  v: initial,
  get() {
    return this.v;
  },
  set(id) {
    this.v = id;
  },
});

describe("DeviceIdClaim", () => {
  it("a duplicated tab (copied sessionStorage) mints a NEW id; the original keeps its own", async () => {
    vi.useFakeTimers();
    try {
      const open = bus();
      const original = new DeviceIdClaim(store("d-same"), open());
      await vi.advanceTimersByTimeAsync(300);
      expect(await original.ready).toBe("d-same");
      const dupStore = store("d-same"); // Duplicate Tab copied it
      const dup = new DeviceIdClaim(dupStore, open());
      await vi.advanceTimersByTimeAsync(10);
      const id = await dup.ready;
      expect(id).not.toBe("d-same");
      expect(dup.reminted).toBe(true);
      expect(dupStore.v, "persisted for this tab's reloads").toBe(id);
      expect(original.id).toBe("d-same");
    } finally {
      vi.useRealTimers();
    }
  });

  it("control: a lone tab (a plain reload) keeps its id after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const open = bus();
      const c = new DeviceIdClaim(store("d-mine"), open());
      await vi.advanceTimersByTimeAsync(300);
      expect(await c.ready).toBe("d-mine");
      expect(c.reminted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a channel the stored id is used as-is", async () => {
    const c = new DeviceIdClaim(store("d-x"), null);
    expect(await c.ready).toBe("d-x");
  });

  it("a first visit mints and stores an id", async () => {
    const s = store(null);
    const c = new DeviceIdClaim(s, null);
    expect(c.id).toMatch(/^d-/);
    expect(s.v).toBe(c.id);
  });
});
