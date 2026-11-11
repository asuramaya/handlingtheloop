import { describe, expect, it } from "vitest";
import { ClockSync } from "./clockSync";

describe("ClockSync — the room server's clock, from ping/pong", () => {
  it("a symmetric round trip recovers the offset exactly", () => {
    const c = new ClockSync();
    // server is 5000 ms ahead; 40 ms each way
    c.add(1000, 1000 + 40 + 5000, 1080);
    expect(c.toServer(2000)).toBe(7000);
  });
  it("trusts the fastest round trip: a queued sample cannot drag the estimate", () => {
    const c = new ClockSync();
    c.add(1000, 1000 + 20 + 5000, 1040); // clean: 20 ms each way
    c.add(2000, 2000 + 20 + 5000, 2400); // the reply sat in a queue for 360 ms
    expect(c.best()?.rtt).toBe(40);
    expect(c.toServer(3000)).toBe(8000);
  });
  it("averages the samples near the fastest round trip, so lopsided legs cancel", () => {
    const c = new ClockSync();
    c.add(1000, 1000 + 30 + 5000, 1050); // out 30, back 20: offset reads +5
    c.add(2000, 2000 + 20 + 5000, 2050); // out 20, back 30: offset reads -5
    c.add(3000, 3000 + 200 + 5000, 3300); // slow, far from the fastest: ignored
    expect(c.toServer(0)).toBe(5000);
  });
  it("is null until the first pong, and ignores nonsense", () => {
    const c = new ClockSync();
    expect(c.toServer(1)).toBeNull();
    c.add(1000, 5000, 900); // arrived before it was sent
    expect(c.toServer(1)).toBeNull();
  });
});
