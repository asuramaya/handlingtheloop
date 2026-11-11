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
  private samples: ClockSample[] = [];

  /** A pong arrived: `c` = our send time, `s` = the server's clock, `now` = our arrival time. */
  add(c: number, s: number, now: number): void {
    const rtt = now - c;
    if (!(rtt >= 0) || rtt > 10_000) return; // nonsense or a stale echo
    this.samples.push({ rtt, offset: s - (c + rtt / 2) });
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
