// DjRoom — one Durable Object per SESSION (addressed by idFromName of the host's
// session key) that coordinates a shared DJ session across its participants. It is the
// single authoritative point: single-threaded so intents are totally ordered. It NEVER
// sees audio or credentials — only control intents, track ids, and opaque snapshots.
//
// Each device has two switches: controlling (🎛️ may drive — SHARED, many at once) and
// listening (🔊 renders its own audio). joined = controlling || listening (flipping either
// puts you in; both off = solo). Each device flips its OWN switches. One joined device is
// the ANCHOR — the playhead clock + snapshot authority — invisible plumbing, not a role.
//
// The host's own devices land here by default; guests on OTHER accounts (incl. anonymous)
// arrive via an invite code the Worker resolves to this same session. Uses the WebSocket
// Hibernation API so idle rooms cost nothing. See docs/shared-session.md.
import type { ClientMsg, ServerMsg, Peer } from "../src/htl/room/protocol";

// --- Minimal Cloudflare runtime types (no @cloudflare/workers-types installed). ---
interface Ws {
  send(msg: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
declare const WebSocketPair: { new (): { 0: Ws; 1: Ws } };
interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
interface DurableObjectState {
  acceptWebSocket(ws: Ws, tags?: string[]): void;
  getWebSockets(tag?: string): Ws[];
  storage: DurableObjectStorage;
}

interface Attachment {
  device: string;
  name: string;
  kind: string; // device type (iPhone / Mac / Linux …) for the roster icon
  host: boolean; // a device on the session-owner's account (set by the Worker, un-forgeable)
  joined: boolean; // a participant — STICKY: only `leave`/disconnect clears it
  listening: boolean; // rendering its own audio stream
  controlling: boolean; // allowed to drive the decks (shared); guests need a host grant
}

export class DjRoom {
  private state: DurableObjectState;
  private anchorId: string | null = null;
  private loaded = false;
  private seq = 0;
  private lastSnapshot: unknown;
  // Device ids the host has granted control. Persisted so a granted guest survives a
  // page refresh with its control intact instead of silently dropping to a listener (#10).
  private grants = new Set<string>();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  // The anchor assignment is the only durable bit — load it lazily.
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.anchorId = (await this.state.storage.get<string>("anchor")) ?? null;
    this.lastSnapshot = await this.state.storage.get("snapshot");
    this.grants = new Set((await this.state.storage.get<string[]>("grants")) ?? []);
    this.loaded = true;
  }

  private async saveGrants(): Promise<void> {
    await this.state.storage.put("grants", [...this.grants]);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    await this.load();

    const url = new URL(req.url);
    const device = (url.searchParams.get("device") || "").slice(0, 64) || `anon-${this.seq++}`;
    const name = (url.searchParams.get("name") || "Guest").slice(0, 48);
    const kind = (url.searchParams.get("kind") || "Device").slice(0, 24);
    const host = url.searchParams.get("host") === "1"; // set by the Worker from the authed identity

    // A device reconnecting replaces its stale socket(s) — keep one per device.
    for (const old of this.state.getWebSockets(device)) old.close(1000, "replaced");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Connect = PRESENT only, both switches off. Flipping either (or an invite/reconnect
    // auto-engaging) puts the device in. A previously host-granted device keeps its drive
    // right across a refresh (#10) — joined still requires its own auto-join on welcome.
    const granted = this.grants.has(device);
    server.serializeAttachment({ device, name, kind, host, joined: false, listening: false, controlling: granted } satisfies Attachment);
    this.state.acceptWebSocket(server, [device]);

    server.send(
      JSON.stringify({ t: "welcome", you: device, anchorId: this.anchorId, peers: this.peers() } satisfies ServerMsg),
    );
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
  }

  async webSocketMessage(ws: Ws, raw: string | ArrayBuffer): Promise<void> {
    await this.load();
    if (typeof raw !== "string") return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return;
    }
    const self = this.deviceOf(ws);
    if (!self) return;

    switch (msg.t) {
      case "join": {
        // Establish sync. Default: SILENT + not driving — joining mirrors the board only.
        // You opt into sound (🔊, self-only) and the host opts you into control (🎛️). The
        // session-starter turns both on itself (client startSession). Granted control (the
        // `grants` set) is preserved across this patch.
        this.patch(ws, { joined: true });
        await this.settle(self);
        break;
      }
      case "control": {
        // 🎛️ drive switch — INDEPENDENT of audio. Must be in the session first. Guests
        // can't turn it on (host grants); anyone may turn it off.
        const a = ws.deserializeAttachment() as Attachment | null;
        if (!a || !a.joined) break;
        if (msg.on && !a.host) {
          // A guest can't self-grant — tell them so instead of silently dropping it (bug #10).
          ws.send(JSON.stringify({ t: "error", message: "Only the host can hand you the decks." } satisfies ServerMsg));
          break;
        }
        this.patch(ws, { controlling: !!msg.on });
        await this.settle(self);
        break;
      }
      case "listen": {
        // 🔊 sound switch — INDEPENDENT of control. Must be in the session.
        const a = ws.deserializeAttachment() as Attachment | null;
        if (!a || !a.joined) break;
        this.patch(ws, { listening: !!msg.on });
        await this.settle(self);
        break;
      }
      case "grant": {
        // Only the HOST grants/revokes another participant's control (audio untouched).
        if (!this.isHostDevice(self)) break;
        const target = (msg.to || "").slice(0, 64);
        if (!target || !this.isLive(target) || !this.isJoined(target)) break;
        for (const t of this.state.getWebSockets(target)) this.patch(t, { controlling: !!msg.on });
        if (msg.on) this.grants.add(target);
        else this.grants.delete(target);
        await this.saveGrants();
        await this.settle(target);
        break;
      }
      case "leave": {
        this.patch(ws, { controlling: false, listening: false, joined: false });
        // A full leave drops any granted drive right too — the host re-grants on return.
        if (this.grants.delete(self)) await this.saveGrants();
        await this.settle(self);
        break;
      }
      case "intent": {
        // ANY controller drives. Relay to everyone else (the sender already applied it).
        if (this.isControlling(self)) this.relay(self, { t: "intent", from: self, seq: ++this.seq, intent: msg.intent });
        break;
      }
      case "tick": {
        // Only the anchor's clock ticks (one reference playhead).
        if (self === this.anchorId) this.relay(self, { t: "tick", decks: msg.decks });
        break;
      }
      case "state": {
        // The anchor (or, while vacant, anyone) defines the authoritative set.
        if (self === this.anchorId || this.anchorId === null) {
          this.lastSnapshot = msg.snapshot;
          await this.state.storage.put("snapshot", msg.snapshot);
          this.relay(self, { t: "state", snapshot: msg.snapshot });
        }
        break;
      }
      case "request-state": {
        if (this.lastSnapshot !== undefined) {
          ws.send(JSON.stringify({ t: "state", snapshot: this.lastSnapshot } satisfies ServerMsg));
        }
        break;
      }
    }
  }

  async webSocketClose(ws: Ws): Promise<void> {
    await this.load();
    const dev = this.deviceOf(ws);
    // A reconnect REPLACES the old socket: if the device still has another live socket,
    // this close is just the stale one — ignore it (don't churn presence / the anchor).
    if (dev && this.hasOtherSocket(dev, ws)) return;
    // Genuine departure: if the anchor dropped, move the clock; else refresh presence.
    if (dev && dev === this.anchorId) await this.setAnchor(this.nextAnchor(dev, ws), ws);
    else this.broadcastPresence(ws);
  }

  async webSocketError(ws: Ws): Promise<void> {
    await this.webSocketClose(ws);
  }

  // --- helpers ---
  private deviceOf(ws: Ws): string | null {
    const a = ws.deserializeAttachment() as Attachment | null;
    return a?.device ?? null;
  }

  private isLive(device: string | null): boolean {
    return !!device && this.state.getWebSockets(device).length > 0;
  }

  private isJoined(device: string): boolean {
    for (const ws of this.state.getWebSockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.joined) return true;
    }
    return false;
  }

  private isHostDevice(device: string): boolean {
    for (const ws of this.state.getWebSockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.host) return true;
    }
    return false;
  }

  private hasOtherSocket(device: string, except: Ws): boolean {
    for (const ws of this.state.getWebSockets(device)) if (ws !== except) return true;
    return false;
  }

  // Keep the anchor valid AND meaningful: it must be a live joined device, and it should
  // PREFER a controller (the controller holds the real board, so its snapshot is the one
  // new joiners sync). So: claim the anchor if none is active; hand it to a controller if
  // the current anchor only listens while we drive; release it if we leave.
  private async settle(self: string): Promise<void> {
    const anchorActive = !!this.anchorId && this.isLive(this.anchorId) && this.isJoined(this.anchorId);
    const anchorControls = !!this.anchorId && this.isControlling(this.anchorId);
    const anchorIsHost = !!this.anchorId && this.isHostDevice(this.anchorId);
    if (this.isJoined(self) && !anchorActive) {
      await this.setAnchor(self);
    } else if (anchorActive && !anchorControls && this.isControlling(self) && self !== this.anchorId) {
      await this.setAnchor(self); // a driver took over → make it the board's source of truth
    } else if (anchorActive && !anchorControls && !anchorIsHost && this.isHostDevice(self) && this.isJoined(self) && self !== this.anchorId) {
      await this.setAnchor(self); // owner joined → reclaim authority from a lone guest anchor (#7)
    } else if (!this.isJoined(self) && self === this.anchorId) {
      await this.setAnchor(this.nextAnchor(self));
    } else {
      this.broadcastPresence();
    }
  }

  private isControlling(device: string): boolean {
    for (const ws of this.state.getWebSockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.joined && a?.controlling) return true;
    }
    return false;
  }

  // The next anchor other than `except`. Preference: a CONTROLLING participant (holds the
  // real board) › a HOST device (the session owner, authoritative even while only
  // listening — keeps a lone guest from freezing the board, #7) › any joined participant.
  private nextAnchor(except: string, exceptWs?: Ws): string | null {
    let hostFallback: string | null = null;
    let anyFallback: string | null = null;
    for (const ws of this.state.getWebSockets()) {
      if (ws === exceptWs) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a || !a.joined || a.device === except) continue;
      if (a.controlling) return a.device;
      if (a.host && !hostFallback) hostFallback = a.device;
      if (!anyFallback) anyFallback = a.device;
    }
    return hostFallback ?? anyFallback;
  }

  private patch(ws: Ws, fields: Partial<Attachment>): void {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    ws.serializeAttachment({ ...a, ...fields } satisfies Attachment);
  }

  private peers(except?: Ws): Peer[] {
    const out: Peer[] = [];
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a)
        out.push({
          id: a.device,
          name: a.name,
          kind: a.kind || "Device",
          host: !!a.host,
          joined: !!a.joined,
          listening: !!a.listening,
          controlling: !!a.controlling,
          anchor: a.device === this.anchorId,
        });
    }
    return out;
  }

  private async setAnchor(device: string | null, except?: Ws): Promise<void> {
    this.anchorId = device;
    await this.state.storage.put("anchor", device);
    this.broadcast({ t: "role", anchorId: device }, except);
    this.broadcastPresence(except);
  }

  private relay(from: string, msg: ServerMsg): void {
    const json = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (this.deviceOf(ws) === from) continue;
      ws.send(json);
    }
  }

  private broadcast(msg: ServerMsg, except?: Ws): void {
    const json = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      ws.send(json);
    }
  }

  private broadcastPresence(except?: Ws): void {
    const peers = this.peers(except);
    const json = JSON.stringify({ t: "presence", peers } satisfies ServerMsg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      ws.send(json);
    }
  }
}
