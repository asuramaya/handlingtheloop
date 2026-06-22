// RoomClient — the browser end of the shared session. Opens a WebSocket to
// /api/room (the htl_session cookie rides along, same-origin, so the Worker can
// authenticate the upgrade + resolve which session to join), tracks the participant
// list + the control baton, and reconnects with backoff. Pure transport: it exposes
// send helpers + an `on` handler bag; the React layer (useRoom) wires the behavior.
import type { ClientMsg, ServerMsg, Peer, Intent, TickDecks, DeckId, StageReq, StageGate, SongRequest, ChatMsg } from "./protocol";
import { ENGINE_VERSION } from "./protocol";
import { SetCapture, type CapturedSet } from "./setCapture";

export type RoomStatus = "offline" | "connecting" | "online" | "error";

export interface RoomHandlers {
  status?: (s: RoomStatus) => void;
  presence?: (peers: Peer[]) => void;
  role?: (anchorId: string | null) => void;
  intent?: (intent: Intent, from: string, seq: number) => void;
  tick?: (decks: TickDecks) => void;
  state?: (snapshot: unknown) => void;
  automix?: (state: unknown) => void;
  stemview?: (deck: DeckId, view: unknown) => void;
  lyrics?: (deck: DeckId, videoId: string, lines: unknown, source: string) => void;
  settings?: (settings: unknown, updatedAt: number) => void; // a same-account device's settings landed
  listeners?: (count: number, isPublic: boolean) => void; // broadcast-plane listener count + whether the room is public
  stage?: (reqs: StageReq[]) => void; // HOST: listeners raising a hand to step up to the decks
  stageGate?: (mode: StageGate) => void; // how the crowd reaches the decks (request/open/closed)
  stageSelf?: (status: "declined") => void; // LISTENER: the host declined my step-up request
  reactions?: (counts: Record<string, number>, hype: number) => void; // aggregated crowd reactions + hype level
  requests?: (list: SongRequest[]) => void; // the live song-request list (participants only)
  chat?: (msg: ChatMsg) => void; // a live chat line (F5)
  chatHistory?: (list: ChatMsg[]) => void; // recent chat backlog on join
  chatSlow?: (seconds: number) => void; // slow-mode interval (<0 off, 0 normal, >0 N-sec)
  chatFollowers?: (on: boolean) => void; // followers-only chat toggle (rides presence)
  muted?: (on: boolean) => void; // the host muted/unmuted THIS device
  mutedList?: (ids: string[]) => void; // HOST: the set of muted device ids (drives the unmute toggle)
  engine?: (stale: boolean, roomVersion: number) => void; // D5: room's engine version differs from ours → unfaithful mix
  hostColor?: (color: string) => void; // the room vibe (host accent) — applies for crowd listeners too (no roster)
  setCaptured?: (set: CapturedSet) => void; // G1a HOST: a broadcast ended → here's the captured recipe to persist
  kicked?: (reason?: string) => void;
  error?: (message: string) => void;
}

export interface RoomOptions {
  name?: string; // friendly participant label (account name) — falls back to the device
  joinCode?: string; // invite code → the Worker routes us into that host's session
  color?: string; // this device's account accent (hex) — the room vibe is the host's
  listenHandle?: string; // tune into a PUBLIC room by the host's @handle (read-only listener, no invite)
}

const DEVICE_KEY = "htl_device_id";

/** Stable, non-secret per-TAB device id. Stored in sessionStorage (not localStorage) so
 *  each browser tab/window is its OWN participant: opening htl twice in one browser yields
 *  two devices that see + sync with each other, instead of sharing one id — which made the
 *  room treat them as the same device and forcibly close one socket when the other
 *  connected (a connect/disconnect flap that looked like a hang). It survives a same-tab
 *  refresh (sessionStorage persists across reloads); a fresh tab / browser restart starts
 *  a new id, and the ENGAGE auto-rejoin (localStorage) covers re-entry into a live set. */
export function deviceId(): string {
  const mint = () => "d-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  try {
    let id = sessionStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = mint();
      sessionStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return mint();
  }
}

/** A friendly device label derived from the UA (used when no account name is known). */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  // iPadOS ≥13 Safari reports a DESKTOP "Macintosh" UA, so /iPad/ alone misses it — tell a
  // real Mac from an iPad by touch points (a Mac reports maxTouchPoints 0). Misclassifying an
  // iPad as "Mac" made the session treat it as a DESKTOP, so the clock-anchor logic never
  // reclaimed the clock from it (server MOBILE_KINDS didn't match) — it stayed the anchor with
  // a frozen/suspended audio clock and the session never recovered after the host refreshed.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)) return "iPad";
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
  private color: string;
  // When set, this client is a PUBLIC read-only listener tuned into someone's @handle —
  // it never drives, never auto-engages the join/control switches.
  private readonly listenHandle: string | null;
  anchorId: string | null = null;
  peers: Peer[] = [];
  status: RoomStatus = "offline";
  listenerCount = 0; // broadcast-plane crowd size (from welcome/presence)
  roomPublic = false; // whether the room is open to anon listeners
  roomEngineVersion = 0; // the room's reconstruction-engine version (anchor's; D5). 0 = unknown
  roomHostColor = ""; // the host/anchor's account accent — the room vibe (rides welcome/presence)
  stageReqs: StageReq[] = []; // pending floor→stage hand-raises (host-visible)
  stageGate: StageGate = "request"; // how the crowd reaches the decks

  private ws: WebSocket | null = null;
  private h: RoomHandlers = {};
  // G1a: records the host's outbound recipe while live (started/stopped by goPublic).
  private capture = new SetCapture();
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
    this.color = opts.color ?? "";
    this.listenHandle = opts.listenHandle ?? null;
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
    this.finalizeCapture(); // teardown mid-broadcast still keeps the set (best-effort; G1a)
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
  approve(to: string): void {
    this.send({ t: "approve", to });
  }
  deny(to: string): void {
    this.send({ t: "deny", to });
  }
  kick(to: string): void {
    this.send({ t: "kick", to });
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
  sendLyrics(deck: DeckId, videoId: string, lines: unknown, source: string): void {
    this.send({ t: "lyrics", deck, videoId, lines, source });
  }

  sendStemView(deck: DeckId, view: unknown): void {
    this.send({ t: "stemview", deck, view });
  }
  /** Broadcast the auto-DJ queue + status to the room (host → guests). */
  sendAutomix(state: unknown): void {
    this.send({ t: "automix", state });
  }
  /** Broadcast my colour/theme settings to my OTHER signed-in devices (the server relays
   *  ONLY to the account owner's own devices). updatedAt drives last-write-wins on the receiver. */
  sendSettings(settings: unknown, updatedAt: number): void {
    this.send({ t: "settings", settings, updatedAt });
  }
  requestState(): void {
    this.send({ t: "request-state" });
  }
  /** HOST only: open/close the room to anonymous read-only listeners (the broadcast plane).
   *  The broadcast IS the recording-in-flight — going live starts the capture, ending it
   *  finalizes the set (capture-by-default; G1a). */
  goPublic(on: boolean): void {
    this.send({ t: "public", on });
    if (on) this.ensureCapturing();
    else this.finalizeCapture();
  }
  /** Start the recording if it isn't already running — idempotent, so it fires on the
   *  go-live edge AND when a host (re)connects into an already-public room (a mid-set
   *  reload), without wiping an in-progress capture. */
  ensureCapturing(): void {
    if (!this.capture.capturing) this.capture.start();
  }
  /** HOST: tag the captured set's tracklist when the now-playing track changes (G1a). */
  markTrack(track: { videoId: string; title?: string; artist?: string }): void {
    this.capture.mark(track);
  }
  /** Stop the capture + hand the recipe to the persistence layer (idempotent). */
  private finalizeCapture(): void {
    const set = this.capture.stop();
    if (set) this.h.setCaptured?.(set);
  }
  /** LISTENER: raise a hand to step up onto a deck (the host approves). */
  requestStage(deck: DeckId): void {
    this.send({ t: "stage", deck });
  }
  /** Cancel a pending request, or step a stage DJ back down to the floor (same wire msg). */
  stepDown(): void {
    this.send({ t: "stage", deck: null });
  }
  /** HOST: bring a hand-raising listener up onto a deck. */
  approveStage(to: string, deck: DeckId): void {
    this.send({ t: "stage-approve", to, deck });
  }
  /** HOST: decline a request, or send a stage DJ back to the floor. */
  denyStage(to: string): void {
    this.send({ t: "stage-deny", to });
  }
  /** HOST: set how the crowd reaches the decks (request / open / closed). */
  setStageGate(mode: StageGate): void {
    this.send({ t: "stageGate", mode });
  }
  /** Tap a crowd reaction (F4). Fire-and-forget; the server aggregates + rate-limits. */
  react(emoji: string): void {
    this.send({ t: "react", emoji });
  }
  /** Ask the DJ for a song (F1). Rate-limited server-side. */
  requestSong(text: string): void {
    this.send({ t: "request", text });
  }
  /** Upvote a song request (F3). Idempotent server-side (one per device per request). */
  voteRequest(id: string): void {
    this.send({ t: "request-vote", id });
  }
  /** Send a chat line (F5). Rate-limited + slow-moded server-side. */
  sendChat(text: string): void {
    this.send({ t: "chat", text });
  }
  /** HOST: set chat slow-mode (<0 = off, 0 = normal, >0 = N-second gate). */
  setChatSlow(seconds: number): void {
    this.send({ t: "chat-slow", seconds });
  }
  /** HOST: toggle followers-only chat (only the host's followers + host/stage may post). */
  setChatFollowers(on: boolean): void {
    this.send({ t: "chat-followers", on });
  }
  /** HOST: mute/unmute a device's chat, or ban it (evict + block re-entry). */
  muteDevice(to: string, on: boolean): void {
    this.send({ t: "mute", to, on });
  }
  banDevice(to: string): void {
    this.send({ t: "ban", to });
  }
  /** HOST: dismiss one song request / clear them all. */
  dismissRequest(id: string): void {
    this.send({ t: "request-dismiss", id });
  }
  clearRequests(): void {
    this.send({ t: "request-clear" });
  }
  /** Update this device's account accent and broadcast it (the room vibe / roster swatch). */
  setColor(color: string): void {
    if (color === this.color) return;
    this.color = color;
    this.send({ t: "color", color });
  }

  /** True when the room's reconstruction engine (the anchor's) differs from ours (D5) — a stale
   *  bundle on either side, so the locally-rebuilt mix can't be trusted bit-exact. Listener-facing. */
  engineStale(): boolean {
    return this.roomEngineVersion > 0 && this.roomEngineVersion !== ENGINE_VERSION;
  }

  // Record the room's engine version off welcome/presence and notify (only when it actually
  // changes, so a per-presence frame doesn't re-fire the handler each tick).
  private applyEngineVersion(v: number | undefined): void {
    if (v === undefined) return;
    if (v === this.roomEngineVersion) return;
    this.roomEngineVersion = v;
    this.h.engine?.(this.engineStale(), v);
  }
  // The room vibe (host accent) off welcome/presence — fired on change so a crowd listener (no
  // roster) still inherits the host's colour. Empty string is a valid "no host colour" signal.
  private applyHostColor(c: string | undefined): void {
    if (c === undefined || c === this.roomHostColor) return;
    this.roomHostColor = c;
    this.h.hostColor?.(c);
  }

  private open(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ device: this.you, name: this.name, kind: this.kind });
    if (this.listenHandle) params.set("room", this.listenHandle); // public read-only listener
    else if (this.joinCode) params.set("join", this.joinCode);
    if (this.color) params.set("color", this.color);
    params.set("ev", String(ENGINE_VERSION)); // D5: report our reconstruction-engine version
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
    ws.onclose = (ev) => {
      this.ws = null;
      // App-level TERMINAL closes (4001 kicked, 4002 broadcast ended, 4003 room full) carry their
      // reason via a `kicked` message just before the close — DON'T reconnect into them, or a
      // whole crowd storms a room that just told them to leave (E10 / broadcast-end).
      const terminal = ev.code >= 4000 && ev.code < 4100;
      if (terminal) this.setStatus("offline");
      else if (!this.closed) {
        this.setStatus("offline");
        this.scheduleReconnect();
      }
    };
    ws.onerror = () => this.setStatus("error");
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    // Exponential backoff with JITTER (50–100% of the cap): when a DO eviction / deploy
    // drops every listener at once, fixed delays would reconnect the whole crowd in
    // lockstep and thundering-herd the room. Spreading them over the window smooths it.
    const cap = Math.min(1000 * 2 ** this.retry, 15000);
    const delay = cap / 2 + Math.random() * (cap / 2);
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
        this.listenerCount = msg.listeners ?? 0;
        this.roomPublic = !!msg.public;
        this.stageReqs = msg.stage ?? [];
        this.stageGate = msg.stageGate ?? this.stageGate;
        this.h.presence?.(msg.peers);
        this.h.role?.(msg.anchorId);
        this.h.listeners?.(this.listenerCount, this.roomPublic);
        this.h.stage?.(this.stageReqs);
        this.h.stageGate?.(this.stageGate);
        this.applyEngineVersion(msg.engineVersion);
        this.applyHostColor(msg.hostColor);
        if (msg.requests) this.h.requests?.(msg.requests);
        if (msg.chatSlow !== undefined) this.h.chatSlow?.(msg.chatSlow);
        if (msg.chatFollowers !== undefined) this.h.chatFollowers?.(msg.chatFollowers);
        if (msg.muted) this.h.mutedList?.(msg.muted);
        // A PUBLIC read-only listener is auto-joined server-side and never drives — skip the
        // engage restore entirely (it has no switches to assert).
        if (this.listenHandle) {
          if (msg.anchorId) this.requestState();
          break;
        }
        // Auto-engage: restore the EXACT switch state we had (survives reconnect + page
        // refresh), or, for a fresh invite link, join HEARING the mix but not driving.
        // Capture the wants first since join()/control()/listen() mutate them.
        {
          const wj = this.wantJoined || !!this.joinCode;
          const wc = this.wantControl;
          // A fresh invite-link guest (joinCode present, nothing persisted) hears the mix
          // by default; a restored session keeps whatever it had (it may have self-muted).
          const wl = this.wantListen || (!!this.joinCode && !this.wantJoined);
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
        this.listenerCount = msg.listeners ?? this.listenerCount;
        this.roomPublic = msg.public ?? this.roomPublic;
        this.stageReqs = msg.stage ?? this.stageReqs;
        this.stageGate = msg.stageGate ?? this.stageGate;
        this.h.presence?.(msg.peers);
        this.h.listeners?.(this.listenerCount, this.roomPublic);
        this.h.stage?.(this.stageReqs);
        this.h.stageGate?.(this.stageGate);
        this.applyEngineVersion(msg.engineVersion);
        this.applyHostColor(msg.hostColor);
        if (msg.chatSlow !== undefined) this.h.chatSlow?.(msg.chatSlow);
        if (msg.chatFollowers !== undefined) this.h.chatFollowers?.(msg.chatFollowers);
        if (msg.muted) this.h.mutedList?.(msg.muted);
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
      case "lyrics":
        this.h.lyrics?.(msg.deck, msg.videoId, msg.lines, msg.source);
        break;
      case "automix":
        this.h.automix?.(msg.state);
        break;
      case "stemview":
        this.h.stemview?.(msg.deck, msg.view);
        break;
      case "settings":
        this.h.settings?.(msg.settings, msg.updatedAt);
        break;
      case "stage-self":
        this.h.stageSelf?.(msg.status);
        break;
      case "reactions":
        this.h.reactions?.(msg.counts, msg.hype);
        break;
      case "requests":
        this.h.requests?.(msg.list);
        break;
      case "chat":
        this.h.chat?.(msg.msg);
        break;
      case "chat-history":
        this.h.chatHistory?.(msg.list);
        break;
      case "muted":
        this.h.muted?.(msg.on);
        break;
      case "kicked":
        // Denied entry or removed by the host. Forget our intent to be in (and the invite
        // code) so the imminent socket close + reconnect doesn't immediately re-knock.
        this.wantJoined = false;
        this.wantControl = false;
        this.wantListen = false;
        this.joinCode = null;
        saveEngage(false, false, false);
        this.h.kicked?.(msg.reason);
        break;
      case "error":
        this.h.error?.(msg.message);
        break;
    }
  }

  private send(msg: ClientMsg): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    this.capture.record(msg); // G1a tee — cheap no-op unless this host is live + capturing
  }
}
