import { describe, test, expect } from "vitest";
import { gpuRun, holdGpu, gpuHeld } from "./gpuQueue";

const defer = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("gpuRun — one heavy job at a time", () => {
  test("a second job does not start until the first finishes", async () => {
    const a = defer<string>();
    const started: string[] = [];
    const first = gpuRun(async () => {
      started.push("a");
      return a.promise;
    });
    const second = gpuRun(async () => {
      started.push("b");
      return "b";
    });
    await tick();
    expect(started).toEqual(["a"]); // b is still behind a
    a.resolve("a");
    expect(await Promise.all([first, second])).toEqual(["a", "b"]);
    expect(started).toEqual(["a", "b"]);
  });

  test("a throwing job still releases the queue for the next one", async () => {
    const boom = gpuRun(async () => {
      throw new Error("gpu lost");
    });
    await expect(boom).rejects.toThrow("gpu lost");
    await expect(gpuRun(async () => "after")).resolves.toBe("after");
  });
});

// ★ The quiet window. A transition is the one moment a paint gap is visible, so no NEW separation
// may begin while one is running — see the module header.
describe("holdGpu — the quiet window", () => {
  test("a job queued while held does not start until released", async () => {
    const release = holdGpu();
    let started = false;
    const job = gpuRun(async () => {
      started = true;
      return "done";
    });
    await tick();
    expect(started).toBe(false);
    expect(gpuHeld()).toBe(true);
    release();
    expect(gpuHeld()).toBe(false);
    expect(await job).toBe("done");
    expect(started).toBe(true);
  });

  // The hold is a "don't start" rule, not a "stop" rule: WebGPU work can't be preempted, and
  // killing it would throw away minutes of compute to save a few hundred ms of jank.
  test("a job already running is left alone", async () => {
    const d = defer<string>();
    let finished = false;
    const job = gpuRun(async () => {
      const v = await d.promise;
      finished = true;
      return v;
    });
    await tick();
    const release = holdGpu();
    d.resolve("kept");
    expect(await job).toBe("kept");
    expect(finished).toBe(true);
    release();
  });

  test("nested holds need every release — one holder cannot free another's", async () => {
    const r1 = holdGpu();
    const r2 = holdGpu();
    let started = false;
    const job = gpuRun(async () => {
      started = true;
      return 1;
    });
    r1();
    await tick();
    expect(started).toBe(false); // r2 still holds
    expect(gpuHeld()).toBe(true);
    r2();
    expect(await job).toBe(1);
  });

  test("releasing twice is a no-op, and cannot free a later hold", async () => {
    const r1 = holdGpu();
    r1();
    const r2 = holdGpu();
    r1(); // stale release — must NOT lower r2's hold
    let started = false;
    const job = gpuRun(async () => {
      started = true;
      return 1;
    });
    await tick();
    expect(started).toBe(false);
    expect(gpuHeld()).toBe(true);
    r2();
    expect(await job).toBe(1);
  });
});
