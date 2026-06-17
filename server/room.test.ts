// End-to-end state-machine tests for the DjRoom DO, driven through a lightweight fake of the
// Cloudflare runtime (no workerd). The fake records sent messages + holds each socket's
// attachment so we can assert the membership transitions: knock→approve/deny, control grants,
// the public/stage gates, step-down, request relay, and the pub read-only guard.
import { describe, it, expect, beforeEach } from "vitest";
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
  storage = {
    get: async <T>(k: string) => this.store.get(k) as T | undefined,
    put: async (k: string, v: unknown) => void this.store.set(k, v),
  };
  acceptWebSocket(ws: Ws, tags: string[] = []): void {
    (ws as FakeWs).tags = tags;
    this.sockets.push(ws as FakeWs);
  }
  getWebSockets(tag?: string): Ws[] {
    return this.sockets.filter((s) => !s.closed && (!tag || s.tags.includes(tag)));
  }
}

function makeRoom() {
  const state = new FakeState();
  const room = new DjRoom(state as unknown as ConstructorParameters<typeof DjRoom>[0]);
  async function connect(p: { device: string; name?: string; host?: boolean; pub?: boolean }) {
    const qs = new URLSearchParams({ device: p.device, name: p.name ?? p.device, kind: "Mac" });
    if (p.host) qs.set("host", "1");
    if (p.pub) qs.set("pub", "1");
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
  return { room, state, connect, send };
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

  it("a song request reaches participants (the host), not the crowd", async () => {
    const host = await liveHost();
    const lis = (await h.connect({ device: "L1", name: "Ana", pub: true })).ws!;
    await h.send(lis, { t: "request", text: "Rosé — APT" });
    const req = host.last("requests");
    expect((req?.list as { text: string }[])?.[0]?.text).toBe("Rosé — APT");
    expect(lis.got("requests")).toBe(false); // the crowd never receives the list
  });
});
