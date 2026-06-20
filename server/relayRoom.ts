// RelayRoom — a SHARD of the broadcast crowd (Epic D2, the thousands-scale lift). A single
// DjRoom fans out O(N) per frame and the load test puts its knee at ~500 listeners
// (scripts/loadtest-room.mjs). To go past that the crowd is sharded: the Worker routes each
// anonymous pub-listener to one of R RelayRooms by hash(device); the master (DjRoom) pushes
// each crowd frame ONCE to each relay (O(R)), and each relay fans out to its own shard (O(N/R)).
// Read-only: a relay never takes writer messages; crowd→DJ (react/request/chat) from sharded
// listeners is a documented TODO (the master still owns that channel).
//
// Gated entirely behind RELAY_SHARDS (default 0 = off): when off, no listener ever reaches a
// relay and this class is dormant — the live single-DO path is untouched.
import { type Ws, type DurableObjectState } from "./roomState";
import type { ServerMsg } from "../src/htl/room/protocol";

declare const WebSocketPair: { new (): { 0: Ws; 1: Ws } };
interface DObjId {
  readonly name?: string;
}
interface DObjStub {
  fetch(req: Request | string, init?: RequestInit): Promise<Response>;
}
interface DObjNamespace {
  idFromName(name: string): DObjId;
  get(id: DObjId): DObjStub;
}
interface RelayEnv {
  ROOM?: DObjNamespace;
}

// What the master pushes us: a crowd frame + an optional cache key so a late joiner catches up
// without round-tripping the master.
interface PushBody {
  frame: ServerMsg;
  cache?: "welcome" | "state" | "automix" | "stemview" | "lyrics" | "live";
  cacheOnly?: boolean; // true = update the catch-up cache but DON'T re-fan to current listeners
  hostId?: string;
  idx?: number;
}

export class RelayRoom {
  private state: DurableObjectState;
  private env: RelayEnv;
  private hostId = "";
  private idx = 0;
  // Catch-up cache: the last of each kind the master pushed, replayed to a fresh listener.
  private welcome: string | null = null;
  private snapshot: string | null = null;
  private automix: string | null = null;
  private stems = new Map<string, string>(); // deck → stemview frame
  private lyrics = new Map<string, string>(); // deck → lyrics frame
  private reported = -1;

  constructor(state: DurableObjectState, env: RelayEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Master → relay push (DO-to-DO). Cache the catch-up kinds, then fan out to our shard.
    if (url.pathname === "/push") {
      const body = (await req.json()) as PushBody;
      if (body.hostId) this.hostId = body.hostId;
      if (body.idx != null) this.idx = body.idx;
      const json = JSON.stringify(body.frame);
      const f = body.frame as { t: string; deck?: string };
      if (body.cache === "welcome") this.welcome = json;
      else if (body.cache === "state") this.snapshot = json;
      else if (body.cache === "automix") this.automix = json;
      else if (body.cache === "stemview" && f.deck) this.stems.set(f.deck, json);
      else if (body.cache === "lyrics" && f.deck) this.lyrics.set(f.deck, json);
      if (!body.cacheOnly) this.fanout(json); // welcome refreshes are cache-only (no re-broadcast)
      return new Response(null, { status: 204 });
    }

    // Otherwise a pub-listener WS, routed here by the Worker.
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
    this.hostId = url.searchParams.get("host_id") || this.hostId;
    this.idx = Number(url.searchParams.get("idx")) || this.idx;
    const device = (url.searchParams.get("device") || "").slice(0, 64) || `anon-${this.reported + 1}`;
    for (const old of this.state.getWebSockets(device)) old.close(1000, "replaced");

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server, [device]);
    // Catch-up: hand the fresh listener the cached board so it renders without a master hop.
    const send = (s: string | null) => s && server.send(s);
    send(this.welcome ?? JSON.stringify({ t: "welcome", you: device, anchorId: null, peers: [], listeners: this.count(), pub: true, stageGate: "request", engineVersion: 0 } satisfies ServerMsg));
    send(this.snapshot);
    send(this.automix);
    for (const s of this.stems.values()) send(s);
    for (const l of this.lyrics.values()) send(l);
    void this.report();
    return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
  }

  async webSocketClose(): Promise<void> {
    await this.report();
  }
  async webSocketError(): Promise<void> {
    await this.report();
  }
  // Read-only shard: a sharded listener's react/request/chat would need forwarding to the master
  // (TODO). For the broadcast fan-out PoC, relay listeners receive only.
  webSocketMessage(): void {}

  private fanout(json: string): void {
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(json);
      } catch {
        /* socket gone — skip */
      }
    }
  }
  private count(): number {
    return this.state.getWebSockets().length;
  }
  // Tell the master our current shard size so it can aggregate the real crowd count. Throttled
  // to changes (the master sums per-shard counts for presence + the directory announce).
  private async report(): Promise<void> {
    const c = this.count();
    if (c === this.reported || !this.env.ROOM || !this.hostId) return;
    this.reported = c;
    try {
      const stub = this.env.ROOM.get(this.env.ROOM.idFromName(`home:${this.hostId}`));
      await stub.fetch(`https://relay/internal/relay-count?idx=${this.idx}&count=${c}`, { method: "POST" });
    } catch {
      /* master unreachable — count self-heals on the next change */
    }
  }
}
