// RoomClient — the browser end of the shared session. Opens a WebSocket to
// /api/room (the htl_session cookie rides along, same-origin, so the Worker can
// authenticate the upgrade + resolve which session to join), tracks the participant
// list + the control baton, and reconnects with backoff. Pure transport: it exposes
// send helpers + an `on` handler bag; the React layer (useRoom) wires the behavior.
import { ClockSync } from "./clockSync";
import type { ClientMsg, ServerMsg, Peer, Intent, TickDecks, DeckId, StageReq, StageGate, SongRequest, ChatMsg } from "./protocol";
import { ENGINE_VERSION } from "./protocol";
import { republishSnapshot } from "./republish";
import { event } from "../debug/trace";
import { SetCapture, type CapturedSet } from "./setCapture";
import { IntentOutbox } from "./outbox";
import { livenessVerdict, type LivenessVerdict } from "./liveness";
import { DeviceIdClaim, type ClaimChannel, type IdStore } from "./deviceClaim";

export type RoomStatus = "offline" | "connecting" | "online" | "error";

export interface RoomHandlers {
  status?: (s: RoomStatus) => void;
  presence?: (peers: Peer[]) => void;
  role?: (anchorId: string | null) => void;
  intent?: (intent: Intent, from: string, seq: number, at?: number) => void;
  tick?: (decks: TickDecks) => void;
  state?: (snapshot: unknown) => void;
  /** Called when the ROOM asks this device to republish (it just took the anchor slot). Returns the
   *  board as it stands now, or undefined when the app has nothing to say yet. See the `republish`
   *  case: without a provider the ask is answered from a cached publish, which a freshly loaded page
   *  does not have. */
  snapshot?: () => unknown;
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
  /** The room refused an intent this device sent (session sync audit): its move was NOT shared. */
  refused?: (kind: string, reason: string) => void;
  /** This tab's socket was replaced by a newer socket of the SAME device id (another tab): it stops. */
  replaced?: () => void;
  error?: (message: string) => void;
}

export interface RoomOptions {
  name?: string; // friendly participant label (account name) — falls back to the device
  joinCode?: string; // invite code → the Worker routes us into that host's session
  color?: string; // this device's account accent (hex) — the room vibe is the host's
  listenHandle?: string; // tune into a PUBLIC room by the host's @handle (read-only listener, no invite)
  jamHandle?: string; // PARTICIPATE in a FRIEND's session by their @handle (mutual-gated; knock or auto-admit)
}

const DEVICE_KEY = "htl_device_id";

/** Stable, non-secret per-TAB device id. Stored in sessionStorage (not localStorage) so
 *  each browser tab/window is its OWN participant: opening htl twice in one browser yields
 *  two devices that see + sync with each other, instead of sharing one id — which made the
 *  room treat them as the same device and forcibly close one socket when the other
 *  connected (a connect/disconnect flap that looked like a hang). It survives a same-tab
 *  refresh (sessionStorage persists across reloads); a fresh tab / browser restart starts
 *  a new id, and the ENGAGE auto-rejoin (localStorage) covers re-entry into a live set. */
/** ★ DUPLICATE TAB (operator, 2026-11-11: session sync audit): Duplicate Tab copies sessionStorage,
 *  so the copy arrived wearing this tab's id and the two replaced each other's socket forever. The
 *  claim (deviceClaim.ts) asks the other tabs on startup and re-mints for the newcomer; connect()
 *  waits for that answer before opening. */
export function deviceId(): string {
  return deviceClaim().id;
}
let claimSingleton: DeviceIdClaim | null = null;
function deviceClaim(): DeviceIdClaim {
  if (claimSingleton) return claimSingleton;
  const store: IdStore = {
    get: () => {
      try {
        return sessionStorage.getItem(DEVICE_KEY);
      } catch {
        return null;
      }
    },
    set: (id) => {
      try {
        sessionStorage.setItem(DEVICE_KEY, id);
      } catch {
        /* storage unavailable — the id lives for this page */
      }
    },
  };
  let channel: ClaimChannel | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const bc = new BroadcastChannel("htl_device_id");
      (bc as unknown as { unref?: () => void }).unref?.(); // Node (tests): never hold the process open
      channel = bc as unknown as ClaimChannel;
    }
  } catch {
    channel = null;
  }
  claimSingleton = new DeviceIdClaim(store, channel);
  return claimSingleton;
}
/** Tests only: install a claim (e.g. one with no channel) so deviceId() is deterministic. */
export function __setDeviceClaimForTests(c: DeviceIdClaim | null): void {
  claimSingleton = c;
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
  /** This tab's device id (settled by the duplicate-tab claim before the first connect). */
  get you(): string {
    return deviceId();
  }
  readonly name: string;
  readonly kind = deviceName(); // device TYPE (iPhone / Mac / Linux …), separate from the label
  private joinCode: string | null;
  private color: string;
  // When set, this client is a PUBLIC read-only listener tuned into someone's @handle —
  // it never drives, never auto-engages the join/control switches.
  private readonly listenHandle: string | null;
  // When set, we're participating in a friend's session by their @handle (not a passive listen) —
  // auto-engages join like an invite-link guest (→ knock, or auto-admit if the host invited us).
  private readonly jamHandle: string | null;
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
  // Half-open-socket watchdog: a flaky 4G link can STALL a socket (no data) without ever firing
  // `onclose`, so the client believes it's online while silently dropping everything the host
  // sends — the guest then drives a stale board. A joined follower hears the anchor's 4/s tick, so
  // no inbound traffic for STALE_MS means the socket is dead → force a clean reconnect → resync.
  private static STALE_MS = 6000;
  private static WATCHDOG_MS = 2000;
  private lastRecvAt = 0; // wall-clock of the last inbound message (0 = none yet this connection)
  // ★ PONG LIVENESS FOR EVERY ROLE (operator, 2026-11-11: session sync audit; see liveness.ts). A
  // ping unanswered for PONG_TIMEOUT_MS (two steady-state ping intervals) means the link is dead —
  // the anchor included, which the old follower-only watchdog never checked.
  static readonly PONG_TIMEOUT_MS = 2 * 5_000;
  private pingOutstandingSince = 0; // Date.now() of the oldest unanswered ping (0 = none)
  private ticksSeen = false; // the anchor's ticks have reached this connection (inbound silence then means something)
  private lastWatchdogAt = 0;
  // ★ THE OUTBOX (outbox.ts): intents made while disconnected or before the room has processed our
  // join are held and flushed once it confirms (`joined`), instead of being dropped at the socket.
  private outbox = new IntentOutbox();
  private joinAcked = false; // the room has processed this connection's join (or approved our knock)
  private replaced = false; // a newer socket of this device id (another tab) took over → stay down
  // ★ THE ROOM CLOCK (clockSync.ts): pings on connect in a quick burst, then every PING_MS, so a
  // tick can say WHEN its playhead was true and a follower can tell lag from latency.
  readonly clock = new ClockSync();
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  static readonly PING_MS = 5_000;
  static readonly PING_BURST = 8;
  /** Room-server time (ms) now, or null until the first pong. */
  serverNow(): number | null {
    // A sleep / suspend discontinuity drops the estimate (clockSync.ts) — re-burst pings at once.
    if (this.clock.checkContinuity(performance.now(), Date.now())) this.schedulePing(0);
    return this.clock.toServer(performance.now());
  }
  private schedulePing(delay: number): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN || this.closed) return;
      ws.send(JSON.stringify({ t: "ping", c: performance.now() } satisfies ClientMsg)); // not captured: not set data
      if (this.pingOutstandingSince === 0) this.pingOutstandingSince = Date.now();
      this.schedulePing(this.clock.count < RoomClient.PING_BURST ? 300 : RoomClient.PING_MS);
    }, delay);
  }
  private watchdog: ReturnType<typeof setInterval> | null = null;
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
    this.jamHandle = opts.jamHandle ?? null;
    const e = loadEngage();
    this.wantJoined = e.joined;
    this.wantControl = e.control;
    this.wantListen = e.listen;
  }

  /** Does the USER still want to be in the session? False only after an explicit leave (or a kick
   *  that dropped the engage). A reconnect keeps it true while the roster briefly says not-joined. */
  get wantsJoined(): boolean {
    return this.wantJoined;
  }
  get isAnchor(): boolean {
    return this.anchorId !== null && this.anchorId === this.you;
  }

  on(h: RoomHandlers): void {
    this.h = { ...this.h, ...h };
  }

  connect(): void {
    this.closed = false;
    this.replaced = false;
    if (!this.watchdog) this.watchdog = setInterval(() => this.checkLiveness(), RoomClient.WATCHDOG_MS);
    // Wait for the duplicate-tab claim (≤ ~250 ms, usually already settled while /api/me loaded) so
    // a duplicated tab never connects wearing its sibling's id.
    void deviceClaim().ready.then(() => {
      if (!this.closed && !this.ws) this.open();
    });
  }

  close(): void {
    this.closed = true;
    this.outbox.clear();
    this.finalizeCapture(); // teardown mid-broadcast still keeps the set (best-effort; G1a)
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
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
    this.outbox.clear(); // nothing held is owed to a session we just left
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
    // Stamp WHEN (room clock) so a receiver can carry a landed position across the transit.
    const at = this.serverNow();
    const msg: ClientMsg = at != null ? { t: "intent", intent, at: Math.round(at) } : { t: "intent", intent };
    if (this.canDeliver()) {
      this.flushOutbox(); // anything held goes first, so the order the DJ made them is kept
      this.send(msg);
      return;
    }
    // ★ HELD, NOT DROPPED (operator, 2026-11-11: session sync audit). A session member whose socket
    // is down, or up but not yet re-joined, used to lose this at the socket (or at the room, which
    // refuses an un-joined sender). Outside a session (solo / a tuned-in listener) nothing is owed.
    if (this.wantJoined && !this.listenHandle) {
      this.outbox.push(intent, Date.now());
      this.capture.record(msg); // the recipe keeps the gesture's real moment
      return;
    }
    this.send(msg);
  }
  /** Socket open AND (the room has processed our join, or we are not in a session at all). */
  private canDeliver(): boolean {
    const open = !!this.ws && this.ws.readyState === WebSocket.OPEN && this.status === "online";
    return open && (this.joinAcked || !this.wantJoined || !!this.listenHandle);
  }
  private flushOutbox(): void {
    if (this.outbox.size === 0 || !this.canDeliver()) return;
    const held = this.outbox.drain(Date.now());
    if (held.length || this.outbox.dropped) event("room.outbox", { flushed: held.length, dropped: this.outbox.dropped });
    this.outbox.dropped = 0;
    for (const intent of held) this.ws!.send(JSON.stringify({ t: "intent", intent } satisfies ClientMsg)); // already captured when held
  }
  sendTick(decks: TickDecks): void {
    this.send({ t: "tick", decks });
  }
  publishState(snapshot: unknown): void {
    // Kept so the room can ask for it again — see the `republish` case. This is the board as the app
    // last described it, which is exactly what a freshly-claimed anchor owes the room.
    this.lastPublished = snapshot;
    this.send({ t: "state", snapshot });
  }
  private lastPublished: unknown = undefined;
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
    else if (this.jamHandle) params.set("jam", this.jamHandle); // participate in a friend's session
    else if (this.joinCode) params.set("join", this.joinCode);
    if (this.color) params.set("color", this.color);
    params.set("ev", String(ENGINE_VERSION)); // D5: report our reconstruction-engine version
    const url = `${proto}://${location.host}/api/room?${params.toString()}`;
    this.detachSocket(); // never two live sockets with handlers: a stale one's close must not clobber this one
    this.setStatus("connecting");
    this.joinAcked = false; // a fresh socket starts un-joined on the server
    this.pingOutstandingSince = 0;
    this.ticksSeen = false;
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
      this.lastRecvAt = Date.now(); // give the fresh connection a full STALE_MS window for `welcome`
      this.setStatus("online");
      this.clock.reset(); // a new route may have a new delay
      this.schedulePing(50);
    };
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // a socket we already gave up on — its close is not news
      this.ws = null;
      // ★ REPLACED BY ANOTHER TAB OF THIS DEVICE (4004; operator, 2026-11-11: session sync audit).
      // The room keeps one socket per device id, so reconnecting here would kick the other tab, which
      // would kick this one, forever. Stop, and say why through the existing status/error path.
      if (ev.code === 4004) {
        this.replaced = true;
        event("room.replaced", {});
        this.setStatus("offline");
        this.h.replaced?.();
        this.h.error?.("This session is open in another tab — this tab stopped syncing. Reload it to take over.");
        return;
      }
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
    ws.onerror = () => {
      if (this.ws === ws) this.setStatus("error");
    };
  }

  /** Forget the current socket: its handlers are detached first, so nothing it does later (a close
   *  that lands seconds afterwards on a half-open link) can touch the connection that replaces it. */
  private detachSocket(): void {
    const old = this.ws;
    this.ws = null;
    if (!old) return;
    old.onopen = null;
    old.onmessage = null;
    old.onclose = null;
    old.onerror = null;
    try {
      old.close();
    } catch {
      /* close can throw on some states — it is detached either way */
    }
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

  // Detect a half-open socket: it looks "online" but no data has arrived for STALE_MS. Only a
  // JOINED FOLLOWER can rely on a steady inbound stream (the anchor ticks 4/s + presence) — the
  // anchor itself, a lone session, or a passive listener may legitimately be quiet, so we don't
  // reconnect them on silence. Force-closing fires `onclose` → scheduleReconnect → welcome →
  // requestState, which re-syncs the current track + board (closing the 4G-stall divergence).
  // ★ NOW EVERY ROLE, PONG-BASED (operator, 2026-11-11: session sync audit; liveness.ts). The anchor
  // is checked too — a dead anchor socket is what froze rooms — and inbound silence only counts for a
  // follower that has actually been receiving ticks on this connection (it was tripping on one slow
  // pong when no ticks were flowing, churning the anchor).
  private notOpenSince = 0; // when the socket left OPEN while status still said online (0 = open)
  private checkLiveness(): void {
    const now = Date.now();
    // A watchdog that ran late by a lot means this page was frozen (an iPhone locked, a discarded
    // tab): probe the link at once rather than waiting out the ping cadence.
    const frozen = this.lastWatchdogAt > 0 && now - this.lastWatchdogAt > 3 * RoomClient.WATCHDOG_MS;
    this.lastWatchdogAt = now;
    if (frozen && this.status === "online" && !this.closed) this.schedulePing(0);
    const follower = (this.wantJoined || !!this.listenHandle) && this.anchorId !== null && this.anchorId !== this.you;
    const ws = this.ws;
    if (ws && this.status === "online" && ws.readyState !== WebSocket.OPEN) {
      if (!this.notOpenSince) this.notOpenSince = now;
    } else this.notOpenSince = 0;
    const verdict = livenessVerdict({
      notOpenSince: this.notOpenSince,
      now,
      online: this.status === "online",
      hasSocket: !!this.ws && !this.closed,
      pingOutstandingSince: this.pingOutstandingSince,
      pongTimeoutMs: RoomClient.PONG_TIMEOUT_MS,
      ticksExpected: follower && this.ticksSeen,
      lastRecvAt: this.lastRecvAt,
      staleMs: RoomClient.STALE_MS,
    });
    if (verdict !== "ok") this.revive(verdict);
  }

  // ★ DON'T WAIT FOR onclose (operator, 2026-11-11: session sync audit). On a half-open link the
  // close handshake can take a long time, and meanwhile status said "online" while send dropped
  // everything. Detach the dead socket, say offline, and open a new one NOW; the welcome on the new
  // socket re-joins and re-syncs, and the outbox flushes once the room confirms the join.
  private revive(verdict: LivenessVerdict): void {
    event("room.liveness", { verdict, anchor: this.isAnchor, outbox: this.outbox.size });
    this.notOpenSince = 0;
    this.detachSocket();
    this.setStatus("offline");
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.closed && !this.replaced) this.open();
  }

  private onMessage(ev: MessageEvent): void {
    this.lastRecvAt = Date.now(); // any inbound proves the socket is alive (watchdog liveness)
    let msg: ServerMsg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as ServerMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case "pong":
        this.pingOutstandingSince = 0; // the link answered (liveness.ts)
        this.clock.add(msg.c, msg.s, performance.now(), Date.now());
        break;
      case "joined":
        // The room has processed our join (or approved our knock): release what we held.
        this.joinAcked = true;
        this.flushOutbox();
        break;
      case "refused":
        // ★ The room refused one of our intents (operator, 2026-11-11: session sync audit) — the
        // move happened here and NOWHERE else. Recorded, and surfaced through the room's error path.
        event("room.refused", { kind: msg.kind, reason: msg.reason });
        this.h.refused?.(msg.kind, msg.reason);
        break;
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
          const wj = this.wantJoined || !!this.joinCode || !!this.jamHandle;
          const wc = this.wantControl;
          // A fresh invite-link guest OR a friend jamming in (nothing persisted) hears the mix
          // by default; a restored session keeps whatever it had (it may have self-muted).
          const wl = this.wantListen || ((!!this.joinCode || !!this.jamHandle) && !this.wantJoined);
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
        // An older room never sends `joined`: our own roster row saying joined is the same fact.
        if (!this.joinAcked && msg.peers.some((p) => p.id === this.you && p.joined && !p.pending)) {
          this.joinAcked = true;
          this.flushOutbox();
        }
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
      case "republish": {
        // The room has just handed us the anchor slot and is asking what is on our board.
        //
        // ★ ASK THE APP FIRST, and fall back to the last thing we published. The first version only
        // had the fallback, which made the frame silent in the case that matters most: a FRESHLY
        // LOADED page has published nothing yet, so a reload answered the ask with nothing at all
        // (Deckard caught this on the rig — my code did exactly what it said, and what it said was
        // not enough). A provider answers with the board as it stands RIGHT NOW, which is also more
        // truthful than a cached copy whenever the two differ.
        // ★ ASK THE APP ONCE. The provider builds a WHOLE session snapshot — both decks, both FX
        // racks, every control — so calling it again just to label the log would double that work on
        // every ask AND could disagree with the first call if anything changed in between, labelling
        // an app answer as a cache one. An instrument must not re-run the thing it is measuring.
        const fresh = this.h.snapshot?.();
        const snap = republishSnapshot(fresh, this.lastPublished);
        // ★ SAY THAT THE ASK ARRIVED, AND WHETHER WE ANSWERED. Without this line the frame is
        // unverifiable from outside: taking the anchor slot ALSO re-runs App's own publish effect,
        // so the server sees a `state` either way and "it works" and "it does nothing" produce the
        // same log. The ring is the only place that can tell an answered ask from a coincidence.
        event("room.republish", { answered: snap !== undefined, from: fresh !== undefined ? "app" : snap !== undefined ? "cache" : "none" });
        if (snap !== undefined) {
          this.lastPublished = snap;
          this.send({ t: "state", snapshot: snap });
        }
        break;
      }
      case "role":
        if (msg.anchorId !== this.anchorId) this.ticksSeen = false; // a new anchor: wait for ITS ticks before judging silence
        this.anchorId = msg.anchorId;
        this.peers = this.peers.map((p) => ({ ...p, anchor: p.id === msg.anchorId }));
        this.h.role?.(msg.anchorId);
        break;
      case "intent":
        this.h.intent?.(msg.intent, msg.from, msg.seq, msg.at);
        break;
      case "tick":
        this.ticksSeen = true;
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
