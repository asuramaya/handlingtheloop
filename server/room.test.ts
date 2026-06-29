// End-to-end state-machine tests for the DjRoom DO, driven through a lightweight fake of the
// Cloudflare runtime (no workerd). The fake records sent messages + holds each socket's
// attachment so we can assert the membership transitions: knock→approve/deny, control grants,
// the public/stage gates, step-down, request relay, and the pub read-only guard.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { DjRoom } from "./room";
import type { Attachment, Ws, DurableObjectState } from "./roomState";

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
  serializeAttachment(v: unknown): void {
    this.att = v;
  }
  deserializeAttachment(): unknown {
    return this.att;
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
    get: async <T>(k: string) => this.store.get(k) as T | undefined,
    put: async (k: string, v: unknown) => void this.store.set(k, v),
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
    expect(ws.a.controlling).toBe(true);
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
    expect(guest.a.controlling).toBe(false); // approval ≠ control
  });

  it("an INVITED guest auto-joins (skips the knock), no host approval needed", async () => {
    const host = (await h.connect({ device: "host1", host: true })).ws!;
    await h.send(host, { t: "join" });
    const friend = (await h.connect({ device: "g1", host: false, invited: true })).ws!;
    await h.send(friend, { t: "join" });
    expect(friend.a.pending).toBe(false); // no knock
    expect(friend.a.joined).toBe(true); // straight in
    expect(friend.a.controlling).toBe(false); // admitted ≠ control (still needs a host grant)
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
    expect(guest.a.controlling).toBe(false); // self-grant refused
    expect(guest.got("error")).toBe(true);
    await h.send(host, { t: "grant", to: "g1", on: true });
    expect(guest.a.controlling).toBe(true);
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
    expect(lis.a.controlling).toBe(true);
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
    expect(lis.a.controlling).toBe(false);
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
    expect(friend.a.controlling).toBe(false); // hears the mix, doesn't drive yet
    await h.send(host, { t: "grant", to: "F", on: true }); // host hands them the decks
    expect(friend.a.controlling).toBe(true);
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
