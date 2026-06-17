// roomCrowd — the crowd→DJ side-channels (F4/F2 reactions + hype, F1 song requests), pulled
// out of the DjRoom as self-contained units. Each owns its OWN ephemeral state (windows,
// timers, rate buckets) and takes its dependencies by injection (how to broadcast, the clock),
// so they carry no membership/socket concerns and can be unit-tested without the whole DO.
import { isReaction, type ServerMsg, type SongRequest, type ChatMsg } from "../src/htl/room/protocol";

// Crowd reactions (F4) + hype (F2). Taps accumulate in a window and flush ONE aggregated frame
// per tick — never per tap, so a big room can't storm the fan-out — plus a decaying 0..1 hype
// EMA the DJ reads as energy. The flush keeps ticking to decay hype even with no new taps, then
// idles. A per-device token bucket caps a single spammer.
export class Reactions {
  private static FLUSH_MS = 1000;
  private static DECAY = 0.82; // per flush; ~settles over ~15s after a burst
  private static GAIN = 0.14; // window-total → hype contribution
  private static RATE_MAX = 10; // taps per RATE_WINDOW per device
  private static RATE_WINDOW = 2000;
  private window: Record<string, number> = {};
  private level = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rate: Record<string, { t: number; n: number }> = {};

  constructor(
    private readonly broadcast: (msg: ServerMsg) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get hype(): number {
    return this.level;
  }

  // A device taps an emoji. Returns false if dropped (unknown emoji / over the rate budget).
  tap(device: string, emoji: string): boolean {
    if (!isReaction(emoji)) return false;
    const now = this.now();
    const rl = this.rate[device];
    if (!rl || now - rl.t >= Reactions.RATE_WINDOW) this.rate[device] = { t: now, n: 1 };
    else if (rl.n >= Reactions.RATE_MAX) return false; // over budget → drop silently
    else rl.n++;
    this.window[emoji] = (this.window[emoji] ?? 0) + 1;
    this.schedule();
    return true;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const counts = this.window;
      this.window = {};
      const total = Object.values(counts).reduce((s, n) => s + n, 0);
      // EMA: decay the standing energy, add this window's contribution, clamp to [0,1].
      this.level = Math.min(1, this.level * Reactions.DECAY + total * Reactions.GAIN);
      if (this.level < 0.01) this.level = 0;
      this.broadcast({ t: "reactions", counts, hype: this.level });
      if (this.level > 0) this.schedule(); // keep decaying; idle once it settles
    }, Reactions.FLUSH_MS);
  }
}

// Song requests (F1): the crowd's asks held in memory (never persisted — live + ephemeral,
// like the knock list). Capped, deduped, one-per-device-per-window. Returns a result the DO
// turns into a relay or an error toast; carries no socket knowledge of its own.
export class Requests {
  private static MAX = 30;
  private static RATE_MS = 15_000; // one request per device per 15s
  private static MAXLEN = 120;
  private items: SongRequest[] = [];
  private seq = 0;
  private rate: Record<string, number> = {};
  // Who upvoted what (F3) — kept OUT of the wire SongRequest (just a count rides the wire);
  // here it enforces one vote per device per request.
  private voters = new Map<string, Set<string>>();

  constructor(private readonly now: () => number = Date.now) {}

  get list(): SongRequest[] {
    return this.items;
  }

  // Keep the list ranked: most-voted first, ties in insertion order (stable sort).
  private sort(): void {
    this.items.sort((a, b) => b.votes - a.votes);
  }

  // Add a request. `ok:true` → relay the new list. `ok:false` with a non-empty `error` → show
  // that toast to the asker. `ok:false` with an empty error = nothing to do (blank text). The
  // asker auto-upvotes their own request (votes starts at 1).
  add(device: string, name: string, raw: string): { ok: true } | { ok: false; error: string } {
    const text = (raw || "").trim().slice(0, Requests.MAXLEN);
    if (!text) return { ok: false, error: "" };
    const now = this.now();
    if (now - (this.rate[device] ?? 0) < Requests.RATE_MS) return { ok: false, error: "One request at a time — give it a moment." };
    if (this.items.some((r) => r.text.toLowerCase() === text.toLowerCase())) return { ok: false, error: "Already in the queue 👍" };
    this.rate[device] = now;
    const id = `q${++this.seq}`;
    this.items.push({ id, name: name || "Someone", text, votes: 1 });
    this.voters.set(id, new Set([device]));
    if (this.items.length > Requests.MAX) {
      const dropped = this.items.shift();
      if (dropped) this.voters.delete(dropped.id);
    }
    this.sort();
    return { ok: true };
  }

  // Upvote a request. Idempotent: one vote per device per request. Returns whether it changed
  // (so the DO only re-relays the list on a real vote).
  vote(device: string, id: string): boolean {
    const req = this.items.find((r) => r.id === id);
    if (!req) return false;
    const voted = this.voters.get(id) ?? new Set<string>();
    if (voted.has(device)) return false; // already voted
    voted.add(device);
    this.voters.set(id, voted);
    req.votes++;
    this.sort();
    return true;
  }

  dismiss(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((r) => r.id !== id);
    if (this.items.length === before) return false;
    this.voters.delete(id);
    return true;
  }

  clear(): boolean {
    if (!this.items.length) return false;
    this.items = [];
    this.voters.clear();
    return true;
  }
}

// Chat (F5). Holds a short rolling backlog (so a joiner sees recent lines) and enforces the
// anti-spam floor + the host's slow-mode per device. Mute/ban are MEMBERSHIP decisions the DO
// owns (they touch sockets); this unit only validates + rate-limits + buffers the text.
export class Chat {
  private static MAXLEN = 300;
  private static HISTORY = 30;
  private static BASE_RATE_MS = 1000; // always-on anti-spam floor, under the host's slow-mode
  private log: ChatMsg[] = [];
  private seq = 0;
  private last: Record<string, number> = {};

  constructor(private readonly now: () => number = Date.now) {}

  get history(): ChatMsg[] {
    return this.log;
  }

  // Post a line. `slowSec` is the host's slow-mode (0 = none). Returns the buffered message to
  // fan out, or a human reason it was held (rate/slow). Empty error = blank text (ignore).
  post(dev: string, name: string, raw: string, slowSec: number): { ok: true; msg: ChatMsg } | { ok: false; error: string } {
    const text = (raw || "").trim().slice(0, Chat.MAXLEN);
    if (!text) return { ok: false, error: "" };
    const now = this.now();
    const gap = Math.max(Chat.BASE_RATE_MS, Math.max(0, slowSec) * 1000);
    const since = now - (this.last[dev] ?? 0);
    if (since < gap) {
      const wait = Math.ceil((gap - since) / 1000);
      return { ok: false, error: slowSec > 0 ? `Slow mode — wait ${wait}s` : "Slow down a moment" };
    }
    this.last[dev] = now;
    const msg: ChatMsg = { id: `c${++this.seq}`, dev, name: name || "Someone", text };
    this.log.push(msg);
    if (this.log.length > Chat.HISTORY) this.log.shift();
    return { ok: true, msg };
  }
}
