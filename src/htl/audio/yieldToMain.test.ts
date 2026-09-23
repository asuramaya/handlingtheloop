import { describe, test, expect, afterEach, vi } from "vitest";
import { yieldToMain, yieldPrimitive, resetYieldPrimitive } from "./yieldToMain";

type G = { scheduler?: unknown };
const g = globalThis as G;

function withScheduler(s: unknown, fn: () => Promise<void> | void): Promise<void> | void {
  const had = "scheduler" in g;
  const prev = g.scheduler;
  g.scheduler = s;
  resetYieldPrimitive();
  const done = (): void => {
    if (had) g.scheduler = prev;
    else delete g.scheduler;
    resetYieldPrimitive();
  };
  const r = fn();
  return r instanceof Promise ? r.finally(done) : done();
}

afterEach(() => {
  resetYieldPrimitive();
});

describe("yieldToMain picks the best primitive present", () => {
  test("scheduler.yield wins when it exists", async () => {
    const y = vi.fn(() => Promise.resolve());
    await withScheduler({ yield: y, postTask: vi.fn() }, async () => {
      expect(yieldPrimitive()).toBe("scheduler.yield");
      await yieldToMain();
      expect(y).toHaveBeenCalledOnce();
    });
  });

  test("postTask is used when yield is ABSENT — the two have different availability, which is why probing one could retire a fix that exists", async () => {
    const pt = vi.fn((f: () => void) => {
      f();
      return Promise.resolve();
    });
    await withScheduler({ postTask: pt }, async () => {
      expect(yieldPrimitive()).toBe("scheduler.postTask");
      await yieldToMain();
      expect(pt).toHaveBeenCalledOnce();
      // user-blocking, NOT background: background sits with the timers on the axis that matters.
      expect((pt.mock.calls[0] as unknown[])[1]).toEqual({ priority: "user-blocking" });
    });
  });

  test("an engine with NEITHER lands on the timer — exactly the behaviour that shipped, so the unmeasured platform cannot regress", async () => {
    await withScheduler(undefined, async () => {
      expect(yieldPrimitive()).toBe("setTimeout");
      await expect(yieldToMain()).resolves.toBeUndefined();
    });
  });

  test("a `scheduler` object that carries neither member is not mistaken for support", async () => {
    await withScheduler({ postTask: 3, yield: null }, async () => {
      expect(yieldPrimitive()).toBe("setTimeout");
    });
  });
});

describe("it cannot fail at giving the thread back", () => {
  test("a rejecting scheduler is demoted to the timer for good, and the caller never sees the rejection", async () => {
    const y = vi.fn(() => Promise.reject(new Error("no")));
    await withScheduler({ yield: y }, async () => {
      await expect(yieldToMain()).resolves.toBeUndefined();
      expect(yieldPrimitive()).toBe("setTimeout");
      await yieldToMain();
      expect(y).toHaveBeenCalledOnce(); // demoted, not retried every slice
    });
  });

  test("a scheduler that THROWS synchronously is demoted too — the decode loop must survive it", async () => {
    const y = vi.fn(() => {
      throw new Error("nope");
    });
    await withScheduler({ yield: y }, async () => {
      await expect(yieldToMain()).resolves.toBeUndefined();
      expect(yieldPrimitive()).toBe("setTimeout");
    });
  });
});
