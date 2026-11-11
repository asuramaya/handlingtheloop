// RoomClient transport (operator, 2026-11-11: session sync audit): the outbox, the terminal
// 'replaced' close, and pong-based liveness — driven through a fake WebSocket and fake timers.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RoomClient, __setDeviceClaimForTests } from "./client";
import { DeviceIdClaim } from "./deviceClaim";
import type { ClientMsg, ServerMsg } from "./protocol";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static all: FakeWebSocket[] = [];
  readyState = 0;
  sent: ClientMsg[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalled = false;
  constructor(readonly url: string) {
    FakeWebSocket.all.push(this);
  }
  send(s: string): void {
    this.sent.push(JSON.parse(s));
  }
  // A half-open link: close() is recorded but the close never comes back.
  close(): void {
    this.closeCalled = true;
  }
  // test helpers
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(m: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  intents(): string[] {
    return this.sent.filter((m) => m.t === "intent").map((m) => (m as { intent: { kind: string } }).intent.kind);
  }
}

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const ME = "d-me";
const welcome = (anchorId: string | null): ServerMsg => ({ t: "welcome", you: ME, anchorId, peers: [] });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  FakeWebSocket.all = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "x", search: "" });
  vi.stubGlobal("sessionStorage", memStorage());
  vi.stubGlobal("localStorage", memStorage());
  const store = { v: ME as string | null, get: () => ME, set: () => {} };
  __setDeviceClaimForTests(new DeviceIdClaim(store, null));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __setDeviceClaimForTests(null);
});

// Connect, open, and take the welcome as a session member (wantJoined) — returns the live socket.
async function connected(c: RoomClient, anchorId: string | null = "host") {
  c.connect();
  await vi.advanceTimersByTimeAsync(0); // the device-id claim settles
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  ws.recv(welcome(anchorId));
  return ws;
}

describe("RoomClient outbox", () => {
  it("holds intents until the room confirms the join, then flushes them in order", async () => {
    const c = new RoomClient();
    c.join(); // a session member (offline yet: the join itself is resent on welcome)
    const ws = await connected(c);
    expect(ws.sent.some((m) => m.t === "join"), "welcome re-asserts the join").toBe(true);
    c.sendIntent({ kind: "load", deck: "A", videoId: "v" });
    c.sendIntent({ kind: "loop", deck: "A", action: "in" });
    expect(ws.intents(), "not yet joined on the server: held, not dropped").toEqual([]);
    ws.recv({ t: "joined" });
    expect(ws.intents()).toEqual(["load", "loop"]);
    c.sendIntent({ kind: "transport", deck: "A", action: "play" });
    expect(ws.intents()).toEqual(["load", "loop", "transport"]);
    c.close();
  });

  it("holds intents made while DISCONNECTED and flushes them, coalesced, after the rejoin", async () => {
    const c = new RoomClient();
    c.join();
    const ws = await connected(c);
    ws.recv({ t: "joined" });
    ws.serverClose(1006);
    c.sendIntent({ kind: "crossfade", value: 0.1 });
    c.sendIntent({ kind: "load", deck: "B", videoId: "x" });
    c.sendIntent({ kind: "crossfade", value: 0.9 });
    await vi.advanceTimersByTimeAsync(1_500); // backoff → reconnect
    const ws2 = FakeWebSocket.all.at(-1)!;
    expect(ws2).not.toBe(ws);
    ws2.open();
    ws2.recv(welcome("host"));
    expect(ws2.intents()).toEqual([]);
    ws2.recv({ t: "joined" });
    expect(ws2.intents()).toEqual(["load", "crossfade"]);
    const xf = ws2.sent.filter((m) => m.t === "intent").at(-1) as { intent: { value: number } };
    expect(xf.intent.value).toBe(0.9);
    c.close();
  });

  it("is capped: a long outage keeps the newest 200", async () => {
    const c = new RoomClient();
    c.join();
    const ws = await connected(c);
    ws.recv({ t: "joined" });
    ws.serverClose(1006);
    for (let i = 0; i < 250; i++) c.sendIntent({ kind: "hotcue", deck: "A", slot: i, action: "press" });
    await vi.advanceTimersByTimeAsync(1_500);
    const ws2 = FakeWebSocket.all.at(-1)!;
    ws2.open();
    ws2.recv(welcome("host"));
    ws2.recv({ t: "joined" });
    const slots = ws2.sent.filter((m) => m.t === "intent").map((m) => (m as { intent: { slot: number } }).intent.slot);
    expect(slots.length).toBe(200);
    expect(slots[0]).toBe(50);
    c.close();
  });

  it("an older room (no `joined` frame) releases the outbox on our own joined roster row", async () => {
    const c = new RoomClient();
    c.join();
    const ws = await connected(c);
    c.sendIntent({ kind: "load", deck: "A", videoId: "v" });
    ws.recv({
      t: "presence",
      peers: [{ id: ME, name: "me", kind: "Mac", host: true, joined: true, listening: false, controlling: true, anchor: false, pending: false, decks: "AB", stage: false, joinedAt: 1, color: "" }],
    });
    expect(ws.intents()).toEqual(["load"]);
    c.close();
  });

  it("control: outside a session (solo) nothing is held", async () => {
    const c = new RoomClient();
    const ws = await connected(c, null);
    c.sendIntent({ kind: "load", deck: "A", videoId: "v" });
    expect(ws.intents()).toEqual(["load"]);
    c.close();
  });

  it("a refusal reaches the handler", async () => {
    const c = new RoomClient();
    const got: string[] = [];
    c.on({ refused: (kind, reason) => got.push(`${kind}:${reason}`) });
    const ws = await connected(c);
    ws.recv({ t: "refused", kind: "crossfade", reason: "nope" });
    expect(got).toEqual(["crossfade:nope"]);
    c.close();
  });
});

describe("RoomClient replaced by another tab", () => {
  it("a 4004 close is terminal: no reconnect, offline, and an 'open in another tab' error", async () => {
    const c = new RoomClient();
    const errors: string[] = [];
    let replaced = 0;
    c.on({ error: (m) => errors.push(m), replaced: () => replaced++ });
    const ws = await connected(c);
    ws.serverClose(4004);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.all.length, "never reconnects into the other tab").toBe(1);
    expect(c.status).toBe("offline");
    expect(replaced).toBe(1);
    expect(errors.at(-1)).toMatch(/another tab/);
    c.close();
  });

  it("control: an ordinary drop still reconnects", async () => {
    const c = new RoomClient();
    const ws = await connected(c);
    ws.serverClose(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeWebSocket.all.length).toBe(2);
    c.close();
  });
});

describe("RoomClient pong liveness", () => {
  it("the ANCHOR with unanswered pings detaches its socket and opens a new one at once", async () => {
    const c = new RoomClient();
    const ws = await connected(c, ME); // we are the anchor — the old watchdog never checked us
    await vi.advanceTimersByTimeAsync(14_000); // pings go out, no pong ever comes back
    expect(ws.sent.some((m) => m.t === "ping")).toBe(true);
    expect(FakeWebSocket.all.length, "a new socket without waiting for onclose").toBe(2);
    expect(ws.closeCalled).toBe(true);
    expect(ws.onclose, "the dead socket's handlers are detached").toBeNull();
    // A late close of the dead socket can't clobber the new connection.
    c.close();
  });

  it("control: a link that answers its pings is left alone", async () => {
    const c = new RoomClient();
    const ws = await connected(c, ME);
    const origSend = ws.send.bind(ws);
    ws.send = (s: string) => {
      origSend(s);
      const m = JSON.parse(s) as ClientMsg;
      if (m.t === "ping") ws.recv({ t: "pong", c: m.c, s: Date.now() });
    };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.all.length).toBe(1);
    c.close();
  });

  it("control: a follower with no ticks flowing is not reconnected for inbound silence alone", async () => {
    const c = new RoomClient();
    c.join();
    const ws = await connected(c, "host");
    const origSend = ws.send.bind(ws);
    ws.send = (s: string) => {
      origSend(s);
      const m = JSON.parse(s) as ClientMsg;
      // A SLOW pong: answered after 6.5 s — past the old 6 s inbound limit, inside the pong timeout.
      if (m.t === "ping") setTimeout(() => ws.recv({ t: "pong", c: m.c, s: Date.now() }), 6_500);
    };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.all.length).toBe(1);
    c.close();
  });
});
