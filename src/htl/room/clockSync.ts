// ONE CLOCK FOR THE ROOM — each device's estimate of the room server's clock.
//
// ★ Operator, 2026-11-10: "lets work on sync in multi user sessions, maintaining the best possible
// alignment in audio between host and clients, i see that it struggles in edge cases". A tick
// carried the host's playhead and NOTHING about when it was true. The follower compared its own
// playhead against a value of unknown age (network + relay + the tick's own 250 ms cadence), so it
// could not tell lag from latency: it ignored any lead outright, and corrected a lag only past
// 0.6 s, by seeking. With a shared clock a tick says "the host was HERE at server time T", and the
// follower can compute where the host is NOW, to within the clock estimate's error.
//
// NTP's four-timestamp idea with the server's single stamp in the middle: the client sends its
// send time, the server answers with its own time, the client notes the arrival. Assuming the two
// legs are equal, the server's clock read `s` corresponds to the client's (c + rtt/2), so
// offset = s - (c + rtt/2) maps client ms → server ms. A sample's error is at most rtt/2, so of the
// recent samples the one with the SMALLEST rtt is the most trustworthy — queueing only ever
// lengthens a leg, it never shortens one.

export interface ClockSample {
  rtt: number; // ms
  offset: number; // server ms − client ms
}

export class ClockSync {
  static readonly KEEP = 24; // recent samples kept (~2 min at the steady ping rate)
  /** Samples whose round trip is within this of the fastest are averaged (ms, plus 15 %). */
  static readonly NEAR_MS = 4;
  /** A wall-clock vs performance-clock step bigger than this (ms) is a sleep / suspend: reset. */
  static readonly SLEEP_JUMP_MS = 1000;
  /** Slack (ms) on top of the two samples' own error bounds before a new sample is "disagreeing". */
  static readonly DISAGREE_MS = 25;
  private samples: ClockSample[] = [];
  private wallSkew: number | null = null; // Date.now() − performance.now() at the last check

  // ★ THE BEST SAMPLE CAN BE A STALE ONE (operator, 2026-11-11: session sync audit). The lowest-RTT
  // sample was trusted for its whole ~2 minute stay, so after the device slept (performance.now()
  // stalls while the server's clock runs on) or the route changed, serverNow was off by up to the
  // sleep's length and every timed tick computed the host's position seconds away. Two exits now:
  // a wall/perf clock discontinuity resets outright (checkContinuity), and a new sample that
  // disagrees with the estimate by more than both samples' error bounds can only mean the offset
  // itself moved (a sample's error is at most rtt/2), so the older samples are dropped.

  /** Detect a sleep (the wall clock stepped against the performance clock); resets and returns true. */
  checkContinuity(perf: number, wall: number): boolean {
    const skew = wall - perf;
    const jumped = this.wallSkew != null && Math.abs(skew - this.wallSkew) > ClockSync.SLEEP_JUMP_MS;
    this.wallSkew = skew;
    if (jumped) this.samples = [];
    return jumped;
  }

  /** A pong arrived: `c` = our send time, `s` = the server's clock, `now` = our arrival time,
   *  `wall` = Date.now() at arrival (optional: enables the sleep check). */
  add(c: number, s: number, now: number, wall?: number): void {
    if (wall != null) this.checkContinuity(now, wall);
    const rtt = now - c;
    if (!(rtt >= 0) || rtt > 10_000) return; // nonsense or a stale echo
    const sample = { rtt, offset: s - (c + rtt / 2) };
    const cur = this.offset();
    const b = this.best();
    if (cur != null && b && Math.abs(sample.offset - cur) > sample.rtt / 2 + b.rtt / 2 + ClockSync.DISAGREE_MS) this.samples = [];
    this.samples.push(sample);
    if (this.samples.length > ClockSync.KEEP) this.samples.shift();
  }

  /** The best current sample (smallest round trip), or null before the first pong. */
  best(): ClockSample | null {
    let b: ClockSample | null = null;
    for (const x of this.samples) if (!b || x.rtt < b.rtt) b = x;
    return b;
  }

  /** The offset estimate: the mean over the samples near the fastest round trip.
   *  ★ ONE BEST SAMPLE IS NOT ENOUGH ON A JITTERY LINK. A sample's error is half the difference
   *  between its two legs, and on a link whose legs jitter independently even the fastest of a dozen
   *  can be lopsided by tens of ms (measured, simulated 75 ms ±40 % each way: a steady 20 ms lead the
   *  follower could not see). The near-fastest samples are each about as trustworthy, and their
   *  asymmetries point both ways, so their mean is better than any one of them. */
  offset(): number | null {
    const b = this.best();
    if (!b) return null;
    const lim = b.rtt * 1.15 + ClockSync.NEAR_MS;
    let sum = 0;
    let n = 0;
    for (const x of this.samples) {
      if (x.rtt <= lim) {
        sum += x.offset;
        n++;
      }
    }
    return sum / n;
  }

  /** Server time (ms) for a local time (ms), or null until synced. */
  toServer(local: number): number | null {
    const o = this.offset();
    return o == null ? null : local + o;
  }

  /** How many samples are in, so a caller can ask for a quick burst first. */
  get count(): number {
    return this.samples.length;
  }

  reset(): void {
    this.samples = [];
  }
}
