// End-to-end state-machine tests for the DjRoom DO, driven through a lightweight fake of the
// Cloudflare runtime (no workerd). The fake records sent messages + holds each socket's
// attachment so we can assert the membership transitions: knock→approve/deny, control grants,
// the public/stage gates, step-down, request relay, and the pub read-only guard.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { DjRoom } from "./room";
import type { Attachment, Ws, DurableObjectState } from "./roomState";
import { drivesAnything } from "./roomState";
import { DO_VALUE_CAP } from "../src/htl/room/doLimits";
import { MAX_STEMVIEW_BYTES, MAX_STEMVIEW_RECORD_BYTES } from "../src/htl/audio/stemViewBudget";

class FakeWs implements Ws {
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  tags: string[] = [];
  private att: unknown = null;
  send(m: string): void {
    if (this.closed) return;
    this.sent.push(m);
  }
  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }
  // ★ CLONE BOTH WAYS. Cloudflare's real serializeAttachment structured-clones the value with the
  // hibernating socket, so a real deserializeAttachment hands back a FRESH COPY every call. Storing
  // and returning the reference makes this double MORE FORGIVING THAN PRODUCTION — and that is the
  // worse direction. FakeState's defect made a write that never happened look like it did: the test
  // lied about the code, loudly, on our desk. This one would make a mutation REAL HIBERNATION
  // DISCARDS look like it persisted: the test passes here and the code fails in production, on
  // hibernation, which is the least reproducible condition in the system.
  // LATENT, NOT LIVE when closed: room.ts serializes at exactly two sites (connect, and patch —
  // which builds a fresh object via spread) and nothing mutates a deserialized attachment. Shut
  // before anyone writes the mutation that would walk through it.
  serializeAttachment(v: unknown): void {
    this.att = structuredClone(v);
  }
  deserializeAttachment(): unknown {
    return this.att === null || this.att === undefined ? this.att : structuredClone(this.att);
  }
  get a(): Attachment {
    return this.att as Attachment;
  }
  msgs(): { t: string; [k: string]: unknown }[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  got(t: string): boolean {
    return this.msgs().some((m) => m.t === t);
  }
  last(t: string): { t: string; [k: string]: unknown } | undefined {
    return [...this.msgs()].reverse().find((m) => m.t === t);
  }
}

class FakePair {
  0 = new FakeWs();
  1 = new FakeWs();
}
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = FakePair;

class FakeState implements DurableObjectState {
  sockets: FakeWs[] = [];
  store = new Map<string, unknown>();
  alarmAt: number | null = null;
  storage = {
    // Clone on GET as well as PUT. Real storage DESERIALISES, so a caller can never receive the
    // object the store holds. Returning the reference leaves a read-modify-write (schedulePresenceOffline:
    // get -> pending[acct] = ... -> put) mutating the STORE ITSELF before its put runs — and if such
    // a path ever failed to put, the store would still show the change, which is the same "a write
    // that never happened looks like it did" defect the put fix closed from the other side.
    get: async <T>(k: string) => {
      const v = this.store.get(k);
      return (v === undefined ? undefined : structuredClone(v)) as T | undefined;
    },
    // ★ CLONE ON PUT, as real storage does by serialising. Storing the reference let a later
    // mutation of the same in-memory object retroactively change what was "persisted" — so a test
    // asserting that both decks reached disk PASSED against code that wrote only one. The fake was
    // right where the real thing is wrong, which is the same defect roomSim's FakeDeck had.
    //
    // ★ AND REFUSE AN OVERSIZED VALUE, as the platform does. A real DO throws when a single value
    // exceeds 128 KiB; this fake accepted anything, which is the FORGIVING direction — the one
    // where the desk says yes and production says no. room.ts has fourteen put sites and only two
    // measure themselves against the cap (lyrics explicitly, stemviews via a clamp derived from
    // it); the rest are small by construction, and "by construction" is the kind of claim that
    // should be held by the fake rather than by a sentence. Audit of 8c31a299.
    put: async (k: string, v: unknown) => {
      const bytes = JSON.stringify(v ?? null).length;
      if (bytes > DO_VALUE_CAP) throw new RangeError(`DO value for "${k}" is ${bytes} bytes, over the ${DO_VALUE_CAP} cap`);
      this.store.set(k, structuredClone(v));
    },
    delete: async (k: string) => this.store.delete(k),
    getAlarm: async () => this.alarmAt,
    setAlarm: async (t: number) => void (this.alarmAt = t),
  };
  acceptWebSocket(ws: Ws, tags: string[] = []): void {
    (ws as FakeWs).tags = tags;
    this.sockets.push(ws as FakeWs);
  }
  getWebSockets(tag?: string): Ws[] {
    return this.sockets.filter((s) => !s.closed && (!tag || s.tags.includes(tag)));
  }
}

function makeRoom(env?: Record<string, unknown>) {
  const state = new FakeState();
  const room = new DjRoom(state as unknown as ConstructorParameters<typeof DjRoom>[0], env as ConstructorParameters<typeof DjRoom>[1]);
  async function connect(p: { device: string; name?: string; host?: boolean; pub?: boolean; follows?: boolean; acct?: string; invited?: boolean }) {
    const qs = new URLSearchParams({ device: p.device, name: p.name ?? p.device, kind: "Mac" });
    if (p.host) qs.set("host", "1");
    if (p.pub) qs.set("pub", "1");
    if (p.follows) qs.set("fol", "1"); // Worker-resolved follow flag (un-forgeable)
    if (p.acct) qs.set("acct", p.acct); // Worker-resolved account id (server-only; mention attribution)
    if (p.invited) qs.set("invited", "1"); // Worker-resolved push-invite grant (un-forgeable)
    const req = new Request(`https://x/api/room?${qs}`, { headers: { Upgrade: "websocket" } });
    let status = 101;
    try {
      status = (await room.fetch(req)).status; // 403/503 rejections construct fine in Node
    } catch (e) {
      if (!(e instanceof RangeError)) throw e; // the 101 success path throws under Node's Response; ignore
    }
    const ws = state.getWebSockets(p.device).slice(-1)[0] as FakeWs | undefined;
    return { ws: status === 101 ? ws : undefined, status };
  }
  const send = (ws: FakeWs, msg: unknown) => room.webSocketMessage(ws, JSON.stringify(msg));
  // Mark a socket closed (so getWebSockets excludes it) then drive the DO's close handler.
  const close = async (ws: FakeWs) => {
    ws.closed = true;
    await room.webSocketClose(ws);
  };
  const runAlarm = () => room.alarm();
  return { room, state, connect, send, close, runAlarm };
}

describe("DjRoom membership", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  it("host starts a session: join → joined + anchor, control → full decks", async () => {
    const { ws } = await h.connect({ device: "host1", host: true });
    if (!ws) throw new Error("no socket");
    await h.send(ws, { t: "join" });
    expect(ws.a.joined).toBe(true);
    expect(ws.a.host).toBe(true);
    await h.send(ws, { t: "control", on: true });
    expect(drivesAnything(ws.a)).toBe(true);
    expect(ws.a.decks).toBe("AB");
  });

  it("a guest KNOCKS (pending), the host approves → joined + listening", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const guest = (await h.connect({ device: "g1", host: false })).ws!;
    await h.send(guest, { t: "join" });
    expect(guest.a.pending).toBe(true);
    expect(guest.a.joined).toBe(false);
    await h.send(host, { t: "approve", to: "g1" });
    expect(guest.a.joined).toBe(true);
    expect(guest.a.listening).toBe(true);
    expect(drivesAnything(guest.a)).toBe(false); // approval ≠ control
  });

  it("an INVITED guest auto-joins (skips the knock), no host approval needed", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const friend = (await h.connect({ device: "g1", host: false, invited: true })).ws!;
    await h.send(friend, { t: "join" });
    expect(friend.a.pending).toBe(false); // no knock
    expect(friend.a.joined).toBe(true); // straight in
    expect(drivesAnything(friend.a)).toBe(false); // admitted ≠ control (still needs a host grant)
  });

  // #48: /internal/ismember authorizes a session GUEST fetching the HOST's global sample clip.
  // Only a JOINED participant (by un-forgeable account) matches — never a stranger or empty acct.
  const askMember = async (h: ReturnType<typeof makeRoom>, acct: string) =>
    ((await (await h.room.fetch(new Request(`https://x/internal/ismember?acct=${encodeURIComponent(acct)}`))).json()) as { member: boolean }).member;

  it("answers /internal/ismember true for a JOINED account, false for a stranger / empty", async () => {
    const host = (await h.connect({ device: "host1", host: true, acct: "u-host" })).ws!;
    await h.send(host, { t: "join" });
    const friend = (await h.connect({ device: "g1", host: false, invited: true, acct: "u-guest" })).ws!;
    await h.send(friend, { t: "join" }); // invited → auto-joins
    expect(await askMember(h, "u-host")).toBe(true);
    expect(await askMember(h, "u-guest")).toBe(true);
    expect(await askMember(h, "u-stranger")).toBe(false);
    expect(await askMember(h, "")).toBe(false);
  });

  it("a KNOCKING (pending) guest is NOT a member until the host approves", async () => {
    const host = (await h.connect({ device: "host1", host: true, acct: "u-host" })).ws!;
    await h.send(host, { t: "join" });
    const guest = (await h.connect({ device: "g1", host: false, acct: "u-knock" })).ws!;
    await h.send(guest, { t: "join" }); // knocks → pending, not joined
    expect(await askMember(h, "u-knock")).toBe(false);
    await h.send(host, { t: "approve", to: "g1" });
    expect(await askMember(h, "u-knock")).toBe(true);
  });

  it("a NON-invited guest still knocks (pending) — the grant is what auto-admits", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const guest = (await h.connect({ device: "g1", host: false })).ws!; // no invite
    await h.send(guest, { t: "join" });
    expect(guest.a.pending).toBe(true);
    expect(guest.a.joined).toBe(false);
  });

  it("a guest can't self-grant control; the host grant gives full decks", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const guest = (await h.connect({ device: "g1" })).ws!;
    await h.send(guest, { t: "join" });
    await h.send(host, { t: "approve", to: "g1" });
    await h.send(guest, { t: "control", on: true });
    expect(drivesAnything(guest.a)).toBe(false); // self-grant refused
    expect(guest.got("error")).toBe(true);
    await h.send(host, { t: "grant", to: "g1", on: true });
    expect(drivesAnything(guest.a)).toBe(true);
    expect(guest.a.decks).toBe("AB");
    await h.send(host, { t: "grant", to: "g1", on: false });
    expect(guest.a.decks).toBe("");
  });

  it("deny closes the knocking guest's socket", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const guest = (await h.connect({ device: "g1" })).ws!;
    await h.send(guest, { t: "join" });
    await h.send(host, { t: "deny", to: "g1" });
    expect(guest.got("kicked")).toBe(true);
    expect(guest.closed).toBe(true);
  });
});

describe("DjRoom public lobby + stage gate", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  async function liveHost() {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    await h.send(host, { t: "public", on: true });
    return host;
  }

  it("rejects a pub listener until the room is public (403), then admits it", async () => {
    await (await h.connect({ device: "host1", host: true })).ws!;
    const before = await h.connect({ device: "L1", pub: true });
    expect(before.status).toBe(403);
    await liveHost();
    const after = await h.connect({ device: "L2", pub: true });
    expect(after.status).toBe(101);
    expect(after.ws!.a.pub).toBe(true);
  });

  it("request gate: hand-raise → host approves → stage controller of that deck", async () => {
    const host = await liveHost();
    const lis = (await h.connect({ device: "L1", pub: true })).ws!;
    await h.send(lis, { t: "stage", deck: "A" });
    expect(lis.a.stageReq).toBe("A"); // hand raised (presence to the host is coalesced, ~1s — tested elsewhere)
    await h.send(host, { t: "stage-approve", to: "L1", deck: "A" });
    expect(lis.a.pub).toBe(false);
    expect(lis.a.stage).toBe(true);
    expect(drivesAnything(lis.a)).toBe(true);
    expect(lis.a.decks).toBe("A");
  });

  it("open gate: grab a free deck instantly; a second grabber on the same deck is refused", async () => {
    const host = await liveHost();
    await h.send(host, { t: "stageGate", mode: "open" });
    const a = (await h.connect({ device: "L1", pub: true })).ws!;
    await h.send(a, { t: "stage", deck: "B" });
    expect(a.a.stage).toBe(true);
    expect(a.a.decks).toBe("B");
    const b = (await h.connect({ device: "L2", pub: true })).ws!;
    await h.send(b, { t: "stage", deck: "B" });
    expect(b.a.stage).toBe(false); // taken
    expect(b.got("stage-self")).toBe(true);
    expect(b.got("error")).toBe(true);
  });

  it("closed gate: the crowd can't step up", async () => {
    const host = await liveHost();
    await h.send(host, { t: "stageGate", mode: "closed" });
    const lis = (await h.connect({ device: "L1", pub: true })).ws!;
    await h.send(lis, { t: "stage", deck: "A" });
    expect(lis.a.stageReq).toBe("");
    expect(lis.a.stage).toBe(false);
    expect(lis.got("error")).toBe(true);
  });

  it("step down returns a stage DJ to the floor (pub, not driving)", async () => {
    const host = await liveHost();
    await h.send(host, { t: "stageGate", mode: "open" });
    const lis = (await h.connect({ device: "L1", pub: true })).ws!;
    await h.send(lis, { t: "stage", deck: "A" });
    expect(lis.a.stage).toBe(true);
    await h.send(lis, { t: "stage", deck: null });
    expect(lis.a.pub).toBe(true);
    expect(drivesAnything(lis.a)).toBe(false);
    expect(lis.a.decks).toBe("");
  });

  // Invite-to-LIVE rollup: a host can direct-invite a friend while broadcasting. The invited friend
  // (jam + grant) lands as a roster PARTICIPANT (not the anon crowd), hears the set, and the host
  // can hand them the decks — co-DJing the live set. Proves the unified invite works while public.
  it("an invited friend joins a LIVE room as a participant (not the crowd), grantable to co-DJ", async () => {
    const host = await liveHost(); // public broadcast
    const friend = (await h.connect({ device: "F", invited: true })).ws!; // jam w/ grant — NOT pub
    await h.send(friend, { t: "join" });
    expect(friend.a.joined).toBe(true);
    expect(friend.a.pub).toBe(false); // in the roster, not the anonymous crowd count
    expect(drivesAnything(friend.a)).toBe(false); // hears the mix, doesn't drive yet
    await h.send(host, { t: "grant", to: "F", on: true }); // host hands them the decks
    expect(drivesAnything(friend.a)).toBe(true);
  });
});

describe("DjRoom crowd guard + requests", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  async function liveHost() {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    await h.send(host, { t: "public", on: true });
    return host;
  }

  it("a pub listener can't drive: an intent from the crowd is dropped (host never sees it)", async () => {
    const host = await liveHost();
    const lis = (await h.connect({ device: "L1", pub: true })).ws!;
    const before = host.msgs().filter((m) => m.t === "intent").length;
    await h.send(lis, { t: "intent", intent: { kind: "crossfade", value: 0.5 } });
    const after = host.msgs().filter((m) => m.t === "intent").length;
    expect(after).toBe(before); // guard dropped it
  });

  it("a song request reaches everyone (host + crowd) so the crowd can upvote (F3)", async () => {
    const host = await liveHost();
    const lis = (await h.connect({ device: "L1", name: "Ana", pub: true })).ws!;
    await h.send(lis, { t: "request", text: "Rosé — APT" });
    const onHost = host.last("requests");
    expect((onHost?.list as { text: string; votes: number }[])?.[0]).toMatchObject({ text: "Rosé — APT", votes: 1 });
    expect(lis.got("requests")).toBe(true); // the crowd gets the ranked list now (to vote)
  });

  it("a chat line fans out to everyone; mute blocks the muted device; ban evicts + locks out", async () => {
    const host = await liveHost();
    const a = (await h.connect({ device: "A", name: "Ana", pub: true })).ws!;
    await h.send(a, { t: "chat", text: "hello" });
    expect((host.last("chat")?.msg as { text: string })?.text).toBe("hello");
    expect(a.got("chat")).toBe(true); // sender sees it too (fan-out to all)

    // host mutes Ana → her next line is refused and she's told she's muted
    await h.send(host, { t: "mute", to: "A", on: true });
    expect(a.got("muted")).toBe(true);
    const chatsBefore = host.msgs().filter((m) => m.t === "chat").length;
    await h.send(a, { t: "chat", text: "blocked?" });
    expect(host.msgs().filter((m) => m.t === "chat").length).toBe(chatsBefore); // not fanned out

    // host bans Ana → socket closed, and a re-connect with the same device id is refused
    await h.send(host, { t: "ban", to: "A" });
    expect(a.closed).toBe(true);
    const rejoin = await h.connect({ device: "A", pub: true });
    expect(rejoin.status).toBe(403);
  });

  it("followers-only chat: only the host's followers (+ the host) may post", async () => {
    const host = await liveHost();
    const fan = (await h.connect({ device: "F", name: "Fan", pub: true, follows: true })).ws!;
    const rando = (await h.connect({ device: "R", name: "Rando", pub: true })).ws!;
    await h.send(host, { t: "chat-followers", on: true }); // host gates chat to followers

    // a follower posts fine
    await h.send(fan, { t: "chat", text: "love this" });
    expect((host.last("chat")?.msg as { text: string })?.text).toBe("love this");

    // a non-follower is refused (error to them, nothing fanned out)
    const before = host.msgs().filter((m) => m.t === "chat").length;
    await h.send(rando, { t: "chat", text: "let me in" });
    expect(host.msgs().filter((m) => m.t === "chat").length).toBe(before);
    expect(rando.got("error")).toBe(true);

    // the host themselves can always post
    await h.send(host, { t: "chat", text: "hey all" });
    expect((host.last("chat")?.msg as { text: string })?.text).toBe("hey all");

    // a non-host can't flip the gate: rando tries to turn it OFF, but it stays on —
    // a fresh non-follower is still blocked, proving the toggle was ignored
    await h.send(rando, { t: "chat-followers", on: false });
    const rando2 = (await h.connect({ device: "R2", pub: true })).ws!;
    await h.send(rando2, { t: "chat", text: "sneak in" });
    expect(rando2.got("error")).toBe(true);

    // the HOST turns it off → the non-follower finally gets in
    await h.send(host, { t: "chat-followers", on: false });
    await h.send(rando2, { t: "chat", text: "hi now" });
    expect((host.last("chat")?.msg as { text: string })?.text).toBe("hi now");
  });

  it("reports the authoritative live listener count over /internal/count (L4)", async () => {
    await liveHost();
    await h.connect({ device: "L1", pub: true });
    await h.connect({ device: "L2", pub: true });
    const res = await h.room.fetch(new Request("https://x/internal/count"));
    expect(await res.json()).toMatchObject({ listeners: 2, public: true }); // real sockets, not self-reported
  });

  // ★ BOTH DECKS MUST REACH DISK. persistStemViews throttles a write whose VALUE covers both decks.
  // With ONE timestamp for the record, deck B's publish inside the window hit the leading-edge
  // throttle and returned, and because a deck publishes its envelope roughly once per track load
  // there was no following write to carry it in — memory held both decks, disk held one,
  // permanently, with nothing reporting it. Found on the real sqlite by Deckard: a room parked with
  // two decks stored 60,032 bytes for a single deck's stem set.
  it("persists BOTH decks' stem envelopes when they publish inside one throttle window", async () => {
    const host = await liveHost();
    await h.send(host, { t: "stemview", deck: "A", view: { lane: "a".repeat(64) } });
    await h.send(host, { t: "stemview", deck: "B", view: { lane: "b".repeat(64) } });
    const stored = h.state.store.get("stemviews") as Record<string, unknown> | undefined;
    expect(stored).toBeDefined();
    expect(stored!.A).toBeDefined();
    expect(stored!.B).toBeDefined(); // the regression: B was silently absent
  });

  it("persists BOTH decks' lyrics inside one throttle window", async () => {
    const host = await liveHost();
    await h.send(host, { t: "lyrics", deck: "A", videoId: "v1", lines: [{ s: 0, w: "a" }], source: "t" });
    await h.send(host, { t: "lyrics", deck: "B", videoId: "v2", lines: [{ s: 0, w: "b" }], source: "t" });
    // Per-deck keys now (see "DjRoom persists lyrics per deck"): the throttle is per deck, so both
    // still land inside one window — they just land in two records that cannot starve each other.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.state.store.get("lyrics:A")).toBeDefined();
    expect(h.state.store.get("lyrics:B")).toBeDefined();
  });

  // ★ The stem request/ack pair is addressed to ONE device; the anonymous crowd must never get it.
  // POSITIVE CONTROL FIRST: an ordinary board intent MUST reach the same listener. Without it,
  // "the listener received no stemsAck" is vacuous — a listener socket receiving nothing at all
  // would pass the negative assertions trivially, which is the 4/4 matcher again.
  it("keeps stemsAck and reqStems off the listener crowd, while ordinary intents still reach it", async () => {
    const host = await liveHost();
    const listener = (await h.connect({ device: "L1", pub: true })).ws!;
    const intentsOf = (k: string) => listener.msgs().filter((m) => m.t === "intent" && (m as { intent?: { kind?: string } }).intent?.kind === k).length;

    await h.send(host, { t: "intent", intent: { kind: "transport", deck: "A", playing: true } });
    expect(intentsOf("transport")).toBe(1); // the control: this listener DOES receive intents

    await h.send(host, { t: "intent", intent: { kind: "stemsAck", deck: "A", model: "htdemucs", state: "separating" } });
    await h.send(host, { t: "intent", intent: { kind: "reqStems", deck: "A", model: "htdemucs" } });
    await h.send(host, { t: "intent", intent: { kind: "jog", deck: "A", value: 0.1 } });
    expect(intentsOf("stemsAck")).toBe(0);
    expect(intentsOf("reqStems")).toBe(0);
    expect(intentsOf("jog")).toBe(0);
  });

  it("a ban survives a DO eviction (reconstruct over the same storage)", async () => {
    const host = await liveHost();
    await h.connect({ device: "A", pub: true });
    await h.send(host, { t: "ban", to: "A" });
    // Rebuild the DO over the SAME persisted storage, as the runtime would after an idle evict.
    const room2 = new DjRoom(h.state as unknown as ConstructorParameters<typeof DjRoom>[0]);
    const req = new Request("https://x/api/room?device=A&name=A&kind=Mac&pub=1", { headers: { Upgrade: "websocket" } });
    expect((await room2.fetch(req)).status).toBe(403); // still banned
  });

  it("chat off (slow=-1) refuses everyone", async () => {
    const host = await liveHost();
    const a = (await h.connect({ device: "A", pub: true })).ws!;
    await h.send(host, { t: "chat-slow", seconds: -1 });
    const before = a.msgs().filter((m) => m.t === "chat").length;
    await h.send(a, { t: "chat", text: "anyone there" });
    expect(a.msgs().filter((m) => m.t === "chat").length).toBe(before);
    expect(a.got("error")).toBe(true);
  });

  it("upvotes are idempotent per device and re-rank the list", async () => {
    const host = await liveHost();
    const a = (await h.connect({ device: "A", name: "Ana", pub: true })).ws!;
    const b = (await h.connect({ device: "B", name: "Bo", pub: true })).ws!;
    await h.send(a, { t: "request", text: "first" }); // votes 1 (auto)
    await h.send(b, { t: "request", text: "second" }); // votes 1 (auto)
    // Bo upvotes "first" → it leads; a second Bo vote is ignored (idempotent)
    const firstId = (host.last("requests")!.list as { id: string; text: string }[]).find((r) => r.text === "first")!.id;
    await h.send(b, { t: "request-vote", id: firstId });
    await h.send(b, { t: "request-vote", id: firstId });
    const list = host.last("requests")!.list as { text: string; votes: number }[];
    expect(list[0]).toMatchObject({ text: "first", votes: 2 }); // 1 auto + 1 Bo (not 3)
  });
});

describe("DjRoom @mention notify bridge (Slice 7)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
    fetchMock = vi.fn(() => Promise.resolve(new Response(null)));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  async function livePublic(h: ReturnType<typeof makeRoom>) {
    const host = (await h.connect({ device: "host1", host: true, acct: "u-host" })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    await h.send(host, { t: "public", on: true });
    return host;
  }
  const notifyCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/internal/notify"));

  it("bridges a chat @mention to /internal/notify, attributed to the sender's account", async () => {
    const h = makeRoom({ TOKEN_ENC_KEY: "sek" });
    await livePublic(h);
    const fan = (await h.connect({ device: "F", name: "Fan", pub: true, acct: "u-fan" })).ws!;
    await h.send(fan, { t: "chat", text: "yo @nina this is fire @nina" }); // dup mention
    const calls = notifyCalls();
    expect(calls).toHaveLength(1); // deduped
    const init = calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({ toHandle: "nina", actorId: "u-fan", kind: "mention" });
    expect(init.headers).toMatchObject({ "x-htl-internal": "sek" });
  });

  it("does not bridge for an anon sender (no account) or without the secret", async () => {
    const h = makeRoom({ TOKEN_ENC_KEY: "sek" });
    await livePublic(h);
    const anon = (await h.connect({ device: "A", pub: true })).ws!; // no acct
    await h.send(anon, { t: "chat", text: "@nina hi" });
    expect(notifyCalls()).toHaveLength(0);

    const h2 = makeRoom(); // no TOKEN_ENC_KEY → bridge inert
    await livePublic(h2);
    const fan = (await h2.connect({ device: "F", pub: true, acct: "u-fan" })).ws!;
    await h2.send(fan, { t: "chat", text: "@nina hi" });
    expect(notifyCalls()).toHaveLength(0);
  });
});

describe("DjRoom presence-offline bridge (Slice 2)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
    fetchMock = vi.fn(() => Promise.resolve(new Response(null)));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });
  const presenceCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/internal/presence"));

  it("last socket close arms the alarm; the alarm bridges offline for that account", async () => {
    const h = makeRoom({ TOKEN_ENC_KEY: "sek" });
    const host = (await h.connect({ device: "h1", host: true, acct: "alice" })).ws!;
    await h.send(host, { t: "join" });
    await h.close(host);
    expect(h.state.alarmAt).not.toBeNull(); // armed
    expect(presenceCalls()).toHaveLength(0); // not yet — only on the alarm
    await h.runAlarm();
    const calls = presenceCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1]!.body as string)).toMatchObject({ acct: "alice" });
    expect((calls[0][1] as RequestInit).headers).toMatchObject({ "x-htl-internal": "sek" });
  });

  it("does not bridge offline if the account reconnected before the alarm fired", async () => {
    const h = makeRoom({ TOKEN_ENC_KEY: "sek" });
    const d1 = (await h.connect({ device: "d1", host: true, acct: "bob" })).ws!;
    await h.send(d1, { t: "join" });
    await h.close(d1); // last socket gone → alarm armed
    await h.connect({ device: "d2", host: true, acct: "bob" }); // same account, another device
    await h.runAlarm();
    expect(presenceCalls()).toHaveLength(0); // still online here → no offline
  });

  it("is inert without the bridge secret", async () => {
    const h = makeRoom(); // no TOKEN_ENC_KEY
    const host = (await h.connect({ device: "h1", host: true, acct: "alice" })).ws!;
    await h.send(host, { t: "join" });
    await h.close(host);
    expect(h.state.alarmAt).toBeNull(); // never armed
    await h.runAlarm();
    expect(presenceCalls()).toHaveLength(0);
  });
});

// The internal bridge's two hardening rules, asserted where they can otherwise regress in silence:
// the header carries the DEDICATED secret when there is one (the at-rest key should not be riding
// in a request header), and the POST goes where the deployment says, not where the connect URL did.
describe("DjRoom internal-bridge configuration", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
    fetchMock = vi.fn(() => Promise.resolve(new Response(null)));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  async function mentionWith(env: Record<string, string>) {
    const h = makeRoom(env);
    const host = (await h.connect({ device: "host1", host: true, acct: "u-host" })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    await h.send(host, { t: "public", on: true });
    const fan = (await h.connect({ device: "F", pub: true, acct: "u-fan" })).ws!;
    await h.send(fan, { t: "chat", text: "@nina hi" });
    return fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/internal/notify"));
  }

  it("prefers INTERNAL_SECRET over the at-rest encryption key", async () => {
    const calls = await mentionWith({ INTERNAL_SECRET: "bridge", TOKEN_ENC_KEY: "atrest" });
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as RequestInit).headers).toMatchObject({ "x-htl-internal": "bridge" });
  });

  it("posts to PUBLIC_ORIGIN when it is configured", async () => {
    const calls = await mentionWith({ TOKEN_ENC_KEY: "sek", PUBLIC_ORIGIN: "https://handlingtheloop.com" });
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toBe("https://handlingtheloop.com/internal/notify");
  });
});

// ★ A PUBLISH THAT IS DROPPED MUST SAY SO. `state` is accepted only from the anchor (or while the
// slot is vacant); anyone else's snapshot is discarded, nothing asks them to republish, and the room
// keeps whatever the previous session left — so every later joiner adopts THAT instead of the host's
// real board. That is the leading hypothesis for "a listener does not adopt the host's board"
// (thread d4a56d30), and it used to happen in total silence. The drop is now logged, because the
// only other instrument here (stemViewDropped) is a counter nothing in the codebase ever reads.
describe("DjRoom state authority", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  it("logs a state publish it drops, naming the publisher and the anchor", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" }); // host becomes the anchor
    const guest = (await h.connect({ device: "g1", host: false, invited: true })).ws!;
    await h.send(guest, { t: "join" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.send(guest, { t: "state", snapshot: { decks: { A: { videoId: "guestTrack" } } } });
      const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("state publish DROPPED"));
      expect(line, "a dropped publish must be visible somewhere a human can read it").toBeTruthy();
      expect(line).toContain("publisher=g1");
      expect(line).toContain("anchor=host1");
    } finally {
      warn.mockRestore();
    }
  });

  it("control: the ANCHOR's own publish is accepted in silence — the log means a real drop, not noise", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "hostTrack" } } } });
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("state publish DROPPED"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

// ★ EVERY DOOR INTO A SESSION MUST HAND OVER THE BOARD. Catch-up used to happen on exactly two
// paths — a public listener at connect, and a guest at the moment the host approves it — so anyone
// arriving through `join` (an approved guest returning after a refresh, an invited friend, the
// host's own second device) received `welcome` and `role` and NO snapshot. Their decks kept whatever
// they already held until the host next published, which is "a listener does not adopt the host's
// board" (thread d4a56d30) on every re-entry.
describe("DjRoom join hands over the board", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  const stateIds = (ws: FakeWs) =>
    ws.sent.map((m) => JSON.parse(m)).filter((m) => m.t === "state").map((m) => m.snapshot?.decks?.A?.videoId);

  it("an INVITED friend joining gets the current board", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "HOSTTRACK" } } } });
    const friend = (await h.connect({ device: "g1", invited: true })).ws!;
    await h.send(friend, { t: "join" });
    expect(stateIds(friend)).toContain("HOSTTRACK");
  });

  it("an APPROVED guest RETURNING after a refresh gets it too — the case a real reload hits", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const guest1 = (await h.connect({ device: "g2" })).ws!;
    await h.send(guest1, { t: "join" }); // knocks
    await h.send(host, { t: "approve", to: "g2" }); // approved (persists)
    await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "LATERTRACK" } } } });
    await h.close(guest1); // the tab reloads
    const guest2 = (await h.connect({ device: "g2" })).ws!;
    await h.send(guest2, { t: "join" }); // re-enters on the persisted approval
    expect(stateIds(guest2)).toContain("LATERTRACK");
  });

  it("control: a KNOCKING guest gets nothing — the door is the gate, and catch-up must not leak past it", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "PRIVATE" } } } });
    const stranger = (await h.connect({ device: "x1" })).ws!;
    await h.send(stranger, { t: "join" }); // not approved → pending
    expect(stateIds(stranger)).toEqual([]);
  });
});

// ★ SILENCE MUST NOT BE AMBIGUOUS. The drop log alone could not separate "published and accepted"
// from "never published at all" — opposite diagnoses with identical evidence, which sent one live
// run down the wrong branch (thread d4a56d30). Every outcome of a publish now says which it was,
// and catch-up says what it actually served, because "adopted a stale board" and "served nothing"
// look the same from the client.
describe("DjRoom publish observability", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });
  const lines = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.map((c: unknown[]) => String(c[0]));

  it("an accepted publish is logged WITH its content, so a stale board is visible as stale", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "aaa" }, B: { videoId: "bbb" } } } });
      const line = lines(warn).find((m) => m.includes("state publish accepted"));
      expect(line).toBeTruthy();
      expect(line).toContain("A=aaa");
      expect(line).toContain("B=bbb");
    } finally {
      warn.mockRestore();
    }
  });

  it("catch-up says when the room has NEVER held a board — the case that reads as 'the listener ignored it'", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const friend = (await h.connect({ device: "g1", invited: true })).ws!;
      await h.send(friend, { t: "join" });
      const line = lines(warn).find((m) => m.includes("NO SNAPSHOT"));
      expect(line).toBeTruthy();
      expect(line, "the device and the reason are what make the line usable when several fire at once").toContain("device=g1");
      expect(line).toContain("why=join");
    } finally {
      warn.mockRestore();
    }
  });

  it("the anchor slot names both sides whenever it moves", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = (await h.connect({ device: "host1", host: true })).ws!;
      await h.send(host, { t: "join" });
      expect(lines(warn).find((m) => m.includes("anchor: none -> host1"))).toBeTruthy();
    } finally {
      warn.mockRestore();
    }
  });
});

// ★ DOES A LATER PUBLISH REACH A LISTENER THAT WAS ALREADY CONNECTED? Deckard's live log shows a
// host publishing an EMPTY board first and a real one after (thread d4a56d30), with a listener that
// caught up on the emptiness and never converged. That leaves two candidates — the room does not
// relay the later publish, or the client does not apply it — and they live in different halves. The
// server's answer is here, so the other half can be searched without guessing about this one.
describe("DjRoom relays a later publish to a listener already tuned in", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  it("a PUBLIC listener that caught up on an empty board still receives the publish that follows", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    await h.send(host, { t: "public", on: true }); // go live — the broadcast plane opens
    // The go-live publish, before the decks are restored: exactly what the live log showed.
    await h.send(host, { t: "state", snapshot: { decks: { A: {}, B: {} } } });
    const listener = (await h.connect({ device: "L1", pub: true })).ws!;
    const atCatchUp = listener.sent
      .map((m) => JSON.parse(m))
      .filter((m) => m.t === "state")
      .map((m) => m.snapshot?.decks?.A?.videoId ?? null);
    expect(atCatchUp, "catch-up serves whatever the room holds — here, the empty board").toEqual([null]);
    // …and now the host publishes the real board.
    await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "REAL" }, B: { videoId: "REAL2" } } } });
    const after = listener.sent
      .map((m) => JSON.parse(m))
      .filter((m) => m.t === "state")
      .map((m) => m.snapshot?.decks?.A?.videoId ?? null);
    expect(after, "the room must relay it — a listener that joined during the empty window converges on the next publish").toContain("REAL");
  });
});

// ★ THE SERVER IS THE ONLY HONEST WITNESS THAT A TUNE-IN HAPPENED. Browser-side evidence could not
// tell one apart from a stale tab or a mis-aimed click (thread d4a56d30 — a selector that matched a
// CAPTION containing "listening", and a listener tab that had never actually reloaded, both read as
// success). A pub socket exists only after a tune-in — the client sets room=<handle> only when
// listenHandle is set — so this line is the fact, and it names the device so a re-connecting old tab
// is distinguishable from a fresh one.
describe("DjRoom witnesses a tune-in", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  it("logs the device and the running count when a public listener arrives", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    await h.send(host, { t: "public", on: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.connect({ device: "L-fresh", pub: true });
      const line = warn.mock.calls.map((c: unknown[]) => String(c[0])).find((m) => m.includes("listener tuned in"));
      expect(line).toBeTruthy();
      expect(line).toContain("device=L-fresh");
      expect(line).toContain("listeners=1");
    } finally {
      warn.mockRestore();
    }
  });

  it("control: a PARTICIPANT joining is not a tune-in and must not be logged as one", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const friend = (await h.connect({ device: "g1", invited: true })).ws!;
      await h.send(friend, { t: "join" });
      expect(warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m) => m.includes("listener tuned in"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

// ★ THE ONE FAILURE THIS GATE PROMISES IS "VISIBLY ABSENT AND REPORTED". An oversized stem envelope
// is dropped for everyone — the right call, since a stale same-song envelope would be silently WRONG
// — but on the server it was recorded only in a counter that nothing in this codebase reads. A
// missing remote waveform was therefore diagnosable only by a user saying a lane looked empty.
describe("DjRoom stemview drop is visible", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  it("logs an oversized stem view, naming the deck and the size against the cap", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // One stem lane far over the wire cap — the shape a long track produces.
      await h.send(host, { t: "stemview", deck: "B", view: { blob: "x".repeat(300_000) } });
      const line = warn.mock.calls.map((c: unknown[]) => String(c[0])).find((m) => m.includes("stemview DROPPED"));
      expect(line).toBeTruthy();
      expect(line).toContain("deck=B");
      expect(line).toContain("device=host1");
    } finally {
      warn.mockRestore();
    }
  });

  it("control: a normal-sized stem view is NOT logged — the line has to mean a real drop", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.send(host, { t: "stemview", deck: "A", view: { blob: "x".repeat(1000) } });
      expect(warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m) => m.includes("stemview DROPPED"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

// ★ A THROTTLE MUST NOT EAT THE NEWS. Logging accepted publishes on a time window alone rebuilt the
// ambiguity the line was added to remove: a host publishing an empty board and the real one a second
// later printed only the empty one, and the silence after it could mean "never republished" or
// "republished inside the window" — opposite diagnoses, identical evidence (thread d4a56d30, where
// only the listener's catch-up content settled it). A changed board is news; a repeat is noise.
describe("DjRoom publish log throttles repeats, not changes", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });
  const accepted = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m) => m.includes("state publish accepted"));

  it("an EMPTY board followed by the real one prints both — the go-live sequence", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.send(host, { t: "state", snapshot: { decks: { A: {}, B: {} } } });
      await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "real1" }, B: { videoId: "real2" } } } });
      const lines = accepted(warn);
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain("A=—");
      expect(lines[1]).toContain("A=real1");
    } finally {
      warn.mockRestore();
    }
  });

  it("control: an identical republish inside the window is throttled — the line still means something", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snap = { decks: { A: { videoId: "same" }, B: {} } };
      await h.send(host, { t: "state", snapshot: snap });
      await h.send(host, { t: "state", snapshot: snap });
      await h.send(host, { t: "state", snapshot: snap });
      expect(accepted(warn).length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// ★ WHAT AN ARRIVAL COSTS. Catch-up is the most expensive per-arrival work this room does — board,
// automix, BOTH stem envelopes, BOTH lyric sets — and 3e2e6d6 gave every `join` one. That was right
// (a joiner with no board was the defect) but it is not free, it scales with the crowd, and a
// client-driven request-state pays it again with nothing rate-limiting it. The size was a number
// nobody had.
describe("DjRoom catch-up reports its size", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  it("counts every frame it serves, so a heavy room is visible before it is felt", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "aaa" }, B: { videoId: "bbb" } } } });
    await h.send(host, { t: "stemview", deck: "A", view: { blob: "x".repeat(4000) } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let line = "";
    try {
      const friend = (await h.connect({ device: "g1", invited: true })).ws!;
      await h.send(friend, { t: "join" });
      line = warn.mock.calls.map((c: unknown[]) => String(c[0])).find((m) => m.includes("catch-up served")) ?? "";
    } finally {
      warn.mockRestore();
    }
    const bytes = Number(/bytes=(\d+)/.exec(line)?.[1] ?? 0);
    expect(bytes, "a served stem envelope is thousands of bytes — the count must include it").toBeGreaterThan(4000);
  });

  it("control: an EMPTY room's catch-up costs nothing — the number reflects what was sent, not a constant", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let line = "";
    try {
      const friend = (await h.connect({ device: "g2", invited: true })).ws!;
      await h.send(friend, { t: "join" });
      line = warn.mock.calls.map((c: unknown[]) => String(c[0])).find((m) => m.includes("catch-up served")) ?? "";
    } finally {
      warn.mockRestore();
    }
    expect(line).toContain("bytes=0");
  });
});

// ★ THE WINDOW THIS CLOSES. `state` is accepted only from the anchor, so a publish a device makes a
// moment before that slot arrives is dropped in silence — and nothing has ever asked for it again,
// so the room serves the previous session's board to every later joiner. Measured on the live rig as
// the host's first ~4 s (thread d4a56d30). The room now asks the device it just handed the slot to.
describe("DjRoom asks a new anchor to republish", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });
  const asks = (ws: FakeWs) => ws.sent.map((m) => JSON.parse(m)).filter((m) => m.t === "republish").length;

  it("asks the device that just took the slot", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" }); // claims a vacant anchor
    expect(asks(host)).toBe(1);
  });

  it("asks the NEW anchor when the slot moves — the reload case this exists for", async () => {
    // The host holds the slot, its tab goes away (a reload mints a NEW per-tab device id), and the
    // returning device claims the vacant slot. That returning device is the one whose early publish
    // was dropped, and the one that has to be asked.
    const host1 = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host1, { t: "join" });
    await h.close(host1);
    const host2 = (await h.connect({ device: "host2", host: true })).ws!;
    await h.send(host2, { t: "join" });
    expect(asks(host2), "the device that now owns the board is the one that owes a snapshot").toBe(1);
    expect(asks(host1), "a closed socket is never written to").toBe(1); // its own claim, nothing since
  });

  it("control: a device that never takes the slot is never asked", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const watcher = (await h.connect({ device: "g2", invited: true })).ws!;
    await h.send(watcher, { t: "join" }); // joins, but the host keeps the anchor
    expect(asks(watcher)).toBe(0);
  });
});

// ★ WHAT A 128 KiB VALUE CAP ACTUALLY DOES TO A LIVE ROOM — the audit half of 8c31a299.
//
// FakeState used to accept any value, so nothing in this file could tell the difference between a
// record that persists and one the platform refuses. That is the forgiving direction: the desk says
// yes and production says no. With the cap enforced, these ask what the room DOES about it.
//
// room.ts has fourteen storage.put sites and only two measure themselves against the cap (lyrics
// explicitly, stemviews through a clamp derived from it). The snapshot is the interesting one,
// because it is CLIENT-SUPPLIED and therefore unbounded by anything on this side.
describe("DjRoom under the DO value cap", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  // A snapshot a real host could plausibly build: lots of decks/FX state, JSON well over 128 KiB.
  const fatSnapshot = () => ({ decks: { A: { videoId: "FAT", pad: "x".repeat(DO_VALUE_CAP) }, B: {} } });

  it("the fake now REFUSES what the platform refuses — otherwise nothing below means anything", async () => {
    await expect(h.state.storage.put("snapshot", fatSnapshot())).rejects.toThrow(/over the \d+ cap/);
    expect(h.state.store.has("snapshot")).toBe(false);
  });

  it("an oversized snapshot still RELAYS — the live room is served from memory, not from disk", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const guest = (await h.connect({ device: "g1", invited: true })).ws!;
    await h.send(guest, { t: "join" });
    await h.send(host, { t: "state", snapshot: fatSnapshot() });
    const relayed = guest.sent.map((m) => JSON.parse(m)).filter((m) => m.t === "state");
    expect(relayed.some((m) => m.snapshot?.decks?.A?.videoId === "FAT")).toBe(true);
  });

  it("…and does NOT tear the socket down — a persist failure must never cost the connection", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await expect(h.send(host, { t: "state", snapshot: fatSnapshot() })).resolves.not.toThrow();
    expect(host.closed).toBe(false);
  });

  // ★ THE DEGRADATION NOBODY HAD NAMED. The relay keeps working, so the room looks healthy — but
  // the board never reaches disk, and a cold restart serves whatever was persisted BEFORE it. The
  // in-memory copy is doing all the work and nothing says so.
  //
  // ★ AND THE TIME TRAVEL IS LOAD-BEARING, not decoration. The snapshot persist is throttled to one
  // write per PERSIST_MIN_MS (10 s). Written without advancing the clock, the second publish is
  // skipped by the THROTTLE and never reaches the cap at all — the assertion still passes, for a
  // reason that has nothing to do with size. Caught by asking what else could make this row green.
  it("silently persists NOTHING, so a cold restart loses the board it was still relaying", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const host = (await h.connect({ device: "host1", host: true })).ws!;
      await h.send(host, { t: "join" });
      await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "SMALL" }, B: {} } } });
      // The control: a normal snapshot DOES reach disk, so the absence below is the size and
      // nothing else. Without this row the next assertion could pass on a room that never persists.
      expect((h.state.store.get("snapshot") as { decks: { A: { videoId: string } } }).decks.A.videoId).toBe("SMALL");
      vi.setSystemTime(1_000_000 + 30_000); // past the throttle, so the next put is genuinely attempted
      await h.send(host, { t: "state", snapshot: fatSnapshot() });
      expect((h.state.store.get("snapshot") as { decks: { A: { videoId: string } } }).decks.A.videoId).toBe("SMALL");
    } finally {
      vi.useRealTimers();
    }
  });

  // The proof that the row above is about SIZE: same two publishes, same clock advance, a small
  // second snapshot — which DOES overwrite. If this ever goes red the throttle changed, and the
  // test above stops meaning what it says.
  it("…while a normal second snapshot past the throttle overwrites the first", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000_000);
      const host = (await h.connect({ device: "host1", host: true })).ws!;
      await h.send(host, { t: "join" });
      await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "FIRST" }, B: {} } } });
      vi.setSystemTime(2_000_000 + 30_000);
      await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "SECOND" }, B: {} } } });
      expect((h.state.store.get("snapshot") as { decks: { A: { videoId: string } } }).decks.A.videoId).toBe("SECOND");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ★ DOES A GRANTED GUEST'S FX ACTUALLY REACH THE BOARD? — thread 93c2f4f2, measured.
//
// The gate itself (canDriveIntent) is pure and well covered in protocol.test.ts. What was NOT
// covered is the path that USES it: DjRoom.canDrive reads the attachment off the sender's own
// sockets, and nothing had checked that a grant puts the right decks there for an FX gesture, or
// that a stage DJ holding ONE deck is stopped at the other one's FX. The thread wanted this on the
// wire against a running worker; the DO is the thing the wire would be exercising, and in-process it
// is deterministic and runs in CI, so it is measured here instead.
//
// FX intents are deck-scoped (fxParam/fxBypass/fxRack all carry `deck`), which is exactly why the
// stage-DJ rows below can be asymmetric — and why "controlling" alone was never the right question.
describe("DjRoom FX drive gate", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  const fx = (deck: "A" | "B") => ({ kind: "fxParam", deck, slot: 0, param: "mix", value: 0.8 });
  const relayedFx = (ws: FakeWs) =>
    ws.msgs().filter((m) => m.t === "intent").map((m) => (m.intent as { kind?: string; deck?: string } | undefined));
  const sawFx = (ws: FakeWs, deck: "A" | "B") => relayedFx(ws).some((i) => i?.kind === "fxParam" && i?.deck === deck);

  async function hostAndGrantedGuest() {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    const guest = (await h.connect({ device: "g1", invited: true })).ws!;
    await h.send(guest, { t: "join" });
    await h.send(host, { t: "grant", to: "g1", on: true });
    return { host, guest };
  }

  it("a GRANTED guest drives FX on both decks, and the host sees it", async () => {
    const { host, guest } = await hostAndGrantedGuest();
    expect(guest.a.decks).toBe("AB"); // the precondition, stated rather than assumed
    await h.send(guest, { t: "intent", intent: fx("A") });
    await h.send(guest, { t: "intent", intent: fx("B") });
    expect(sawFx(host, "A")).toBe(true);
    expect(sawFx(host, "B")).toBe(true);
  });

  // The control that must fail: without the grant the identical gesture goes nowhere. If this ever
  // passes, the rows above prove nothing — they would be measuring a room that relays everything.
  it("…and an UNGRANTED guest's identical gesture is dropped", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    const guest = (await h.connect({ device: "g1", invited: true })).ws!;
    await h.send(guest, { t: "join" });
    expect(guest.a.decks).toBe("");
    await h.send(guest, { t: "intent", intent: fx("A") });
    expect(sawFx(host, "A")).toBe(false);
  });

  it("a REVOKED guest stops driving FX — the grant is not a one-way door", async () => {
    const { host, guest } = await hostAndGrantedGuest();
    await h.send(guest, { t: "intent", intent: fx("A") });
    expect(sawFx(host, "A")).toBe(true);
    await h.send(host, { t: "grant", to: "g1", on: false });
    await h.send(guest, { t: "intent", intent: fx("B") });
    expect(sawFx(host, "B")).toBe(false); // B never arrived; A above is why this row can tell
  });

  // ★ THE ASYMMETRY THAT MAKES "controlling" THE WRONG QUESTION. A stage DJ holding deck A is
  // `controlling` exactly as the granted guest is, and must still be refused deck B's FX.
  it("a stage DJ on deck A drives A's FX and is refused B's", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    await h.send(host, { t: "public", on: true });
    const lis = (await h.connect({ device: "L1", pub: true })).ws!;
    await h.send(lis, { t: "stage", deck: "A" });
    await h.send(host, { t: "stage-approve", to: "L1", deck: "A" });
    expect(drivesAnything(lis.a)).toBe(true);
    expect(lis.a.decks).toBe("A");
    await h.send(lis, { t: "intent", intent: fx("A") });
    await h.send(lis, { t: "intent", intent: fx("B") });
    expect(sawFx(host, "A")).toBe(true);
    expect(sawFx(host, "B")).toBe(false);
  });
});

// The observability half of ddf28822: the persist failure was swallowed in silence, and a silent
// degradation is the part nobody can act on. Measured with the engine (fxlab --snapshot-size): a
// two-deck board is ~2.6 KB plus ~1.7 KB per stem chain per deck, so the cap needs ~39 chains on a
// deck — not normal use, and nothing in the client bounds chain count.
describe("DjRoom says when a board is too big to persist", () => {
  let h: ReturnType<typeof makeRoom>;
  let warns: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    h = makeRoom();
    warns = [];
    spy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(" ")));
  });
  afterEach(() => spy.mockRestore());

  const fatSnapshot = () => ({ decks: { A: { videoId: "FAT", pad: "x".repeat(DO_VALUE_CAP) }, B: {} } });

  it("logs the size and what it costs, instead of swallowing it", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "state", snapshot: fatSnapshot() });
    const line = warns.find((w) => w.includes("snapshot NOT persisted"));
    expect(line).toBeTruthy();
    expect(line).toMatch(/cold restart will serve an OLDER one/);
    expect(line).toContain(String(DO_VALUE_CAP)); // the cap, so the reader can judge the number
  });

  // The control: a board that fits must stay quiet. A warning on every publish would be noise, and
  // noise is how a real signal gets filtered out of a console.
  it("says nothing at all about a board that fits", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "state", snapshot: { decks: { A: { videoId: "SMALL" }, B: {} } } });
    expect(warns.filter((w) => w.includes("snapshot NOT persisted"))).toEqual([]);
  });
});

// ★ WHAT A JOINER ACTUALLY COSTS — thread 54c64816, whose own numbers had gone stale.
//
// The row said "N joiners × up to 800 KB", written when room.ts bounded the envelope at a
// hand-written 400_000 per deck. That constant is gone: MAX_STEMVIEW_BYTES is derived from the
// client's own bucket clamp (stemViewBudget.ts), and the SAME gate admits to lastStemView and
// relays — deliberately, because lastStemView is replayed to every arrival forever with no rate
// limit, so one oversized frame passing once would tax every joiner after it.
//
// What nothing measured is what a joiner costs NOW. The amplification is real and by design: it is
// linear in crowd size and bounded by the record cap. These rows pin the constant, so raising
// MAX_BUCKETS shows up here as a bigger join rather than as a surprise in production.
describe("stemview catch-up: what each arrival is handed", () => {
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  // A view at the admission ceiling: the largest thing a client can publish and have cached.
  const fatView = () => ({ length: 9_000_000, sampleRate: 44100, bucket: 2048, pad: "x".repeat(MAX_STEMVIEW_BYTES - 200) });
  const bytesReceived = (ws: FakeWs) => ws.sent.reduce((n, m) => n + m.length, 0);

  async function liveRoomWithViews() {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    await h.send(host, { t: "stemview", deck: "A", view: fatView() });
    await h.send(host, { t: "stemview", deck: "B", view: fatView() });
    return host;
  }

  it("a view at the ceiling is ADMITTED — otherwise the rows below measure an empty cache", async () => {
    await liveRoomWithViews();
    const guest = (await h.connect({ device: "g1", invited: true })).ws!;
    await h.send(guest, { t: "join" });
    const views = guest.msgs().filter((m) => m.t === "stemview");
    expect(views.map((v) => v.deck).sort()).toEqual(["A", "B"]);
  });

  it("each arrival is handed BOTH decks, once — bounded by the record cap, not by the crowd", async () => {
    await liveRoomWithViews();
    const guest = (await h.connect({ device: "g1", invited: true })).ws!;
    await h.send(guest, { t: "join" });
    const cost = bytesReceived(guest);
    expect(cost).toBeGreaterThan(MAX_STEMVIEW_BYTES); // both decks really arrived
    expect(cost).toBeLessThanOrEqual(MAX_STEMVIEW_RECORD_BYTES + 8192); // and no more than the record
  });

  it("the cost is LINEAR in joiners and per-joiner flat — the amplification is the crowd, not the frame", async () => {
    await liveRoomWithViews();
    const costs: number[] = [];
    for (const d of ["g1", "g2", "g3"]) {
      const g = (await h.connect({ device: d, invited: true })).ws!;
      await h.send(g, { t: "join" });
      costs.push(bytesReceived(g));
    }
    // Each joiner pays the same; nobody pays for the joiners before them.
    expect(Math.max(...costs) - Math.min(...costs)).toBeLessThan(2048);
    expect(costs.length).toBe(3);
  });

  // The control that must fail: one byte over the gate and NOTHING is cached, so an arrival gets
  // no stemview at all. It is the fail-closed direction stemViewBudget.ts argues for, and if this
  // ever passes, the gate has stopped governing the cache and the rows above mean nothing.
  it("a view one byte over the gate is cached for NOBODY — visibly absent, not silently stale", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "control", on: true });
    await h.send(host, { t: "stemview", deck: "A", view: { pad: "x".repeat(MAX_STEMVIEW_BYTES + 1) } });
    const guest = (await h.connect({ device: "g1", invited: true })).ws!;
    await h.send(guest, { t: "join" });
    expect(guest.msgs().some((m) => m.t === "stemview")).toBe(false);
  });
});

// The same silence, one key over — and this one has no structural ceiling to fall back on.
// MEASURED against real synced lyrics from LRCLIB (the source the client itself uses), built into
// the exact record this persists, BOTH DECKS UNDER ONE KEY: Bohemian Rhapsody 372 words / 16.3 KB,
// One More Time 383 / 19.6 KB, Rap God 1542 / 64.3 KB. Rap God on both decks is 128.6 KB against a
// 131.07 KB cap — 98.1%, and it PASSES. So the realistic worst case is a hip-hop set rather than a
// determined user, it currently fits with ~2.4 KB to spare, and nothing in the client bounds a word
// list. That margin is why the silence mattered.
describe("DjRoom says when a caption set is too big to persist", () => {
  let h: ReturnType<typeof makeRoom>;
  let warns: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    h = makeRoom();
    warns = [];
    spy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(" ")));
  });
  afterEach(() => spy.mockRestore());

  const words = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i * 0.3, w: "word", d: 0.3 }));
  const fatLyrics = () => [{ start: 0, end: 3, text: "x", words: words(DO_VALUE_CAP / 20) }];

  it("logs the size, the decks and what it costs, instead of returning in silence", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "lyrics", deck: "A", videoId: "FAT", lines: fatLyrics(), source: "lrclib" });
    const line = warns.find((w) => w.includes("lyrics NOT persisted"));
    expect(line).toBeTruthy();
    expect(line).toMatch(/cold restart will serve OLDER captions or none/);
    expect(line).toContain(String(DO_VALUE_CAP)); // the cap, so the reader can judge the number
    expect(line).toMatch(/for deck A/); // WHICH deck was refused — per-deck keys, so it is one deck, not a record
  });

  // The control, and the one that keeps this honest: a caption set that fits must stay silent.
  it("says nothing at all about captions that fit", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    await h.send(host, { t: "lyrics", deck: "A", videoId: "SMALL", lines: [{ start: 0, end: 3, text: "hi", words: words(20) }], source: "lrclib" });
    expect(warns.filter((w) => w.includes("lyrics NOT persisted"))).toEqual([]);
  });
});

// ★ LYRICS: ONE DECK, ONE KEY, ONE BUDGET — the storage half of Deckard's caption measurement.
//
// Both decks used to persist under a single "lyrics" record measured against one 128 KiB cap. He
// measured a real hip-hop track (Rap God, 1542 words) at 64.3 KB on ONE deck and 128.6 KB on BOTH
// — 98.1% of the cap, passing with ~2.4 KB to spare — and nothing in the client bounds a word list.
// Coupled, a wordy track on A could stop B's captions reaching disk for reasons that have nothing
// to do with B. Split, the worst measured deck has 2.0x headroom.
describe("DjRoom persists lyrics per deck", () => {
  let h: ReturnType<typeof makeRoom>;
  let warns: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    h = makeRoom();
    warns = [];
    spy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(" ")));
  });
  afterEach(() => spy.mockRestore());

  const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i * 0.4, w: `word${i}` }));
  const say = (deck: "A" | "B", n: number) => ({ t: "lyrics", deck, videoId: `vid${deck}`, lines: lines(n), source: "lrclib" });

  async function host() {
    const ws = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(ws, { t: "join" });
    await h.send(ws, { t: "control", on: true });
    return ws;
  }

  it("writes lyrics:A and lyrics:B, not one shared record", async () => {
    const ws = await host();
    await h.send(ws, say("A", 40));
    await h.send(ws, say("B", 40));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.state.store.has("lyrics:A")).toBe(true);
    expect(h.state.store.has("lyrics:B")).toBe(true);
    expect(h.state.store.has("lyrics")).toBe(false);
  });

  // ★ THE POINT OF THE SPLIT. Deck A carries a caption set over the cap; deck B is ordinary. B must
  // still reach disk — under the old single record it could not, and nothing said why.
  it("an oversized deck A no longer stops deck B's captions from persisting", async () => {
    const ws = await host();
    await h.send(ws, { t: "lyrics", deck: "A", videoId: "vidA", lines: "x".repeat(DO_VALUE_CAP), source: "lrclib" });
    await h.send(ws, say("B", 40));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.state.store.has("lyrics:A")).toBe(false); // refused, and said so
    expect(h.state.store.has("lyrics:B")).toBe(true); // unaffected by a neighbour it has nothing to do with
    expect(warns.some((w) => w.includes("lyrics NOT persisted for deck A"))).toBe(true);
  });

  // The control: a caption set that fits must stay silent, or the log becomes noise and a real
  // refusal gets filtered out with it.
  it("says nothing about captions that fit", async () => {
    const ws = await host();
    await h.send(ws, say("A", 40));
    expect(warns.filter((w) => w.includes("lyrics NOT persisted"))).toEqual([]);
  });

  it("migrates a legacy single record to per-deck keys, and only then drops it", async () => {
    const legacy = { A: { videoId: "old-a", lines: lines(10), source: "lrclib" }, B: { videoId: "old-b", lines: lines(10), source: "lrclib" } };
    h.state.store.set("lyrics", structuredClone(legacy));
    const ws = await host(); // load() runs on the first request → reads the legacy record
    await h.send(ws, say("A", 20)); // first successful per-deck write retires it
    await new Promise((r) => setTimeout(r, 0)); // persistLyrics is fire-and-forget (`void`)
    expect(h.state.store.has("lyrics")).toBe(false);
    expect((h.state.store.get("lyrics:B") as { videoId: string }).videoId).toBe("old-b"); // B carried over untouched
    expect((h.state.store.get("lyrics:A") as { videoId: string }).videoId).toBe("vidA"); // A is the fresh one
  });

  it("serves the migrated captions to a joiner — the migration is not just a file move", async () => {
    h.state.store.set("lyrics", { A: { videoId: "old-a", lines: lines(10), source: "lrclib" } });
    await host();
    const guest = (await h.connect({ device: "g1", invited: true })).ws!;
    await h.send(guest, { t: "join" });
    expect(guest.msgs().some((m) => m.t === "lyrics" && m.videoId === "old-a")).toBe(true);
  });
});

describe("automix is HOST ONLY (operator ruling 34075fae)", () => {
  // ★ THE RULING IS STRICTER THAN THE QUESTION THAT PROMPTED IT. cb9000d2 asked whether a STAGE DJ
  // should be able to arm auto-mix; the operator answered "no, make it host only" — any seat not on
  // the session owner's account, INCLUDING a fully-granted guest holding both decks. Metron's
  // 55c0028 took the client control. This is the durable half: a client-side gate is a guard on the
  // surface, which is the thing this whole line of work has been removing.
  //
  // There were TWO server doors and the handover named one.
  let h: ReturnType<typeof makeRoom>;
  beforeEach(() => {
    h = makeRoom();
  });

  async function grantedGuest() {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const guest = (await h.connect({ device: "g1", host: false })).ws!;
    await h.send(guest, { t: "join" });
    await h.send(host, { t: "approve", to: "g1" });
    await h.send(host, { t: "grant", to: "g1", on: true }); // FULL control — decks "AB"
    return { host, guest };
  }
  const gotAutomix = (ws: { sent: string[] }, from: number) =>
    ws.sent.slice(from).map((m) => JSON.parse(m)).filter((m) => m.t === "automix");

  it("a fully-granted guest holds both decks — the seat the ruling excludes", async () => {
    const { guest } = await grantedGuest();
    expect(guest.a.decks).toBe("AB");
    expect(drivesAnything(guest.a)).toBe(true);
  });

  it("★ DOOR 2 — the automix STATE STREAM is refused for a granted guest (the door the handover missed)", async () => {
    // It was gated on `isControlling(self) || self === this.anchorId`. isControlling is
    // drivesAnything(), so "AB" passed — and the anchor clause admitted a NON-HOST anchor, because
    // the clock preference puts "any controller" above "any host".
    const { host, guest } = await grantedGuest();
    const mark = host.sent.length;
    await h.send(guest, { t: "automix", state: { on: true } as never });
    expect(gotAutomix(host, mark)).toEqual([]);
  });

  it("the HOST still drives it — a gate that closed on everyone would pass the test above", async () => {
    const { host, guest } = await grantedGuest();
    const mark = guest.sent.length;
    await h.send(host, { t: "automix", state: { on: true } as never });
    expect(gotAutomix(guest, mark).length).toBeGreaterThan(0);
  });

  it("★ DOOR 1 — the automix INTENT is refused for a granted guest, not merely for a one-deck seat", async () => {
    // canDriveIntent refuses this today only because the intent carries no `deck` and a deck-less
    // move needs BOTH. Right answer, wrong reason: it ADMITS "AB".
    const { host, guest } = await grantedGuest();
    const mark = host.sent.length;
    await h.send(guest, { t: "intent", intent: { kind: "automix", action: "toggle" } });
    const relayed = host.sent.slice(mark).map((m) => JSON.parse(m)).filter((m) => m.t === "intent" && m.intent?.kind === "automix");
    expect(relayed).toEqual([]);
  });
});
