// RoomClient — the browser end of the shared session. Opens a WebSocket to
// /api/room (the htl_session cookie rides along, same-origin, so the Worker can
// authenticate the upgrade + resolve which session to join), tracks the participant
// list + the control baton, and reconnects with backoff. Pure transport: it exposes
// send helpers + an `on` handler bag; the React layer (useRoom) wires the behavior.
import type { ClientMsg, ServerMsg, Peer, Intent, TickDecks } from "./protocol";

export type RoomStatus = "offline" | "connecting" | "online" | "error";

export interface RoomHandlers {
  status?: (s: RoomStatus) => void;
  presence?: (peers: Peer[]) => void;
  role?: (anchorId: string | null) => void;
  intent?: (intent: Intent, from: string, seq: number) => void;
  tick?: (decks: TickDecks) => void;
  state?: (snapshot: unknown) => void;
  error?: (message: string) => void;
}

export interface RoomOptions {
  name?: string; // friendly participant label (account name) — falls back to the device
  joinCode?: string; // invite code → the Worker routes us into that host's session
}

const DEVICE_KEY = "htl_device_id";

/** Stable, non-secret per-device id (persisted in localStorage). */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = "d-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "d-" + Math.random().toString(36).slice(2, 10);
  }
}

/** A friendly device label derived from the UA (used when no account name is known). */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux";
  return "Device";
}

/** The invite code from the page URL (/?join=CODE), if we arrived via an invite. */
export function joinCodeFromUrl(): string | null {
  try {
    return new URLSearchParams(location.search).get("join");
  } catch {
    return null;
  }
}

// Persist this device's switch state so a PAGE REFRESH re-engages exactly where it was
// (a fresh client otherwise forgets it and drops out of the session). Short-lived so a
// reopen hours later doesn't silently auto-join.
const ENGAGE_KEY = "htl_room_engage";
const ENGAGE_TTL = 6 * 3600 * 1000;
function loadEngage(): { joined: boolean; control: boolean; listen: boolean } {
  try {
    const e = JSON.parse(localStorage.getItem(ENGAGE_KEY) || "null");
    if (e && typeof e.ts === "number" && Date.now() - e.ts < ENGAGE_TTL) {
      return { joined: !!e.joined, control: !!e.control, listen: !!e.listen };
    }
  } catch {
    /* ignore */
  }
  return { joined: false, control: false, listen: false };
}
function saveEngage(joined: boolean, control: boolean, listen: boolean): void {
  try {
    if (!joined) localStorage.removeItem(ENGAGE_KEY);
    else localStorage.setItem(ENGAGE_KEY, JSON.stringify({ joined, control, listen, ts: Date.now() }));
  } catch {
    /* ignore */
  }
}

export class RoomClient {
  readonly you = deviceId();
  readonly name: string;
  readonly kind = deviceName(); // device TYPE (iPhone / Mac / Linux …), separate from the label
  private joinCode: string | null;
  anchorId: string | null = null;
  peers: Peer[] = [];
  status: RoomStatus = "offline";

  private ws: WebSocket | null = null;
  private h: RoomHandlers = {};
  private retry = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Desired state (persisted), so a transient reconnect OR a page refresh re-engages
  // where we left off.
  private wantJoined: boolean;
  private wantControl: boolean;
  private wantListen: boolean;

  constructor(opts: RoomOptions = {}) {
    this.name = opts.name || deviceName();
    this.joinCode = opts.joinCode ?? joinCodeFromUrl();
    const e = loadEngage();
    this.wantJoined = e.joined;
    this.wantControl = e.control;
    this.wantListen = e.listen;
  }

  get isAnchor(): boolean {
    return this.anchorId !== null && this.anchorId === this.you;
  }

  on(h: RoomHandlers): void {
    this.h = { ...this.h, ...h };
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus("offline");
  }

  join(): void {
    this.wantJoined = true; // join = sync only; sound (🔊) + control (🎛️) are opt-in
    saveEngage(true, this.wantControl, this.wantListen);
    this.send({ t: "join" });
  }
  leave(): void {
    this.wantJoined = false;
    this.wantControl = false;
    this.wantListen = false;
    saveEngage(false, false, false);
    this.send({ t: "leave" });
  }
  control(on: boolean): void {
    this.wantControl = on; // INDEPENDENT of audio
    saveEngage(this.wantJoined, on, this.wantListen);
    this.send({ t: "control", on });
  }
  listen(on: boolean): void {
    this.wantListen = on; // INDEPENDENT of control
    saveEngage(this.wantJoined, this.wantControl, on);
    this.send({ t: "listen", on });
  }
  grant(to: string, on: boolean): void {
    this.send({ t: "grant", to, on });
  }
  sendIntent(intent: Intent): void {
    this.send({ t: "intent", intent });
  }
  sendTick(decks: TickDecks): void {
    this.send({ t: "tick", decks });
  }
  publishState(snapshot: unknown): void {
    this.send({ t: "state", snapshot });
  }
  requestState(): void {
    this.send({ t: "request-state" });
  }

  private open(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ device: this.you, name: this.name, kind: this.kind });
    if (this.joinCode) params.set("join", this.joinCode);
    const url = `${proto}://${location.host}/api/room?${params.toString()}`;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("online");
    };
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = () => {
      this.ws = null;
      if (!this.closed) {
        this.setStatus("offline");
        this.scheduleReconnect();
      }
    };
    ws.onerror = () => this.setStatus("error");
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    const delay = Math.min(1000 * 2 ** this.retry, 15000);
    this.retry++;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.open();
    }, delay);
  }

  private setStatus(s: RoomStatus): void {
    this.status = s;
    this.h.status?.(s);
  }

  private onMessage(ev: MessageEvent): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as ServerMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome":
        this.anchorId = msg.anchorId;
        this.peers = msg.peers;
        this.h.presence?.(msg.peers);
        this.h.role?.(msg.anchorId);
        // Auto-engage: restore the EXACT switch state we had (survives reconnect + page
        // refresh), or, for a fresh invite link, join silent + not driving (the new
        // default). Capture the wants first since join()/control()/listen() mutate them.
        {
          const wj = this.wantJoined || !!this.joinCode;
          const wc = this.wantControl;
          const wl = this.wantListen;
          if (wj) {
            this.join(); // → joined, but silent + not driving until restored below
            if (wc) this.control(true); // host re-asserts its own drive (guests: server grants)
            if (wl) this.listen(true); // restore sound only if we had it on
          }
        }
        // If a session is already running, ask for the current set so we mirror it.
        if (msg.anchorId && msg.anchorId !== this.you) this.requestState();
        break;
      case "presence":
        this.peers = msg.peers;
        this.h.presence?.(msg.peers);
        break;
      case "role":
        this.anchorId = msg.anchorId;
        this.peers = this.peers.map((p) => ({ ...p, anchor: p.id === msg.anchorId }));
        this.h.role?.(msg.anchorId);
        break;
      case "intent":
        this.h.intent?.(msg.intent, msg.from, msg.seq);
        break;
      case "tick":
        this.h.tick?.(msg.decks);
        break;
      case "state":
        this.h.state?.(msg.snapshot);
        break;
      case "error":
        this.h.error?.(msg.message);
        break;
    }
  }

  private send(msg: ClientMsg): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}
