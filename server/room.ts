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
import type { ClientMsg, ServerMsg, Peer, Intent, StageReq, StageGate } from "../src/htl/room/protocol";
import { canDriveIntent, isReaction } from "../src/htl/room/protocol";

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
  pending: boolean; // a guest who knocked and is waiting on the host's approval (the handshake)
  pub: boolean; // a PUBLIC anon read-only listener (broadcast plane): hears the mix, never drives, never anchors, not in the roster
  decks: string; // which decks this device may DRIVE: "" | "A" | "B" | "AB" ("AB" = full — host/granted). The per-deck gate.
  stageReq: string; // a pub LISTENER's pending hand-raise: "" | "A" | "B" (the deck it wants to step up to)
  stage: boolean; // STEPPED UP from the floor: drives one deck, never anchors, reverts to a pub listener on step-down
  joinedAt: number; // epoch ms this device last became a participant (0 until joined) — for "joined Nm ago"
  color: string; // this device's account accent (hex) — the room "vibe" is the host's color
}

// Device kinds (from the client's `kind` param, see deviceName) that are phones/tablets. The
// anchor (clock) prefers a DESKTOP over these among the owner's own devices, so a desktop refresh
// doesn't hand the clock to a phone for good. (iPadOS Safari often reports "Mac" — fine, it then
// counts as a desktop, which is the capable-DJ-surface behaviour we want anyway.)
const MOBILE_KINDS = new Set(["iPhone", "iPad", "Android"]);
const isMobileKind = (kind: string): boolean => MOBILE_KINDS.has(kind);

export class DjRoom {
  private state: DurableObjectState;
  private anchorId: string | null = null;
  // Whether the host has opened this room to anonymous read-only listeners (the
  // broadcast plane). Off by default — a private session never admits the public.
  private isPublic = false;
  // How a public-lobby listener reaches the decks (E6): "request" (raise a hand, host approves
  // — the default), "open" (grab a free deck instantly), or "closed" (crowd can't step up).
  private stageGate: StageGate = "request";
  private loaded = false;
  private seq = 0;
  private lastSnapshot: unknown;
  // Per-deck stem waveform envelopes (opaque), from whoever has the stems — so a
  // stem-less remote (a phone) can render the 4-lane display. Stored so a late joiner
  // gets them on request-state, like the snapshot.
  private lastStemView: Record<string, unknown> = {};
  // Per-(sender·deck) last-relay timestamp → server-side rate limit on stemview, so a
  // buggy/abusive peer can't amplify the ~70 KB envelope to every device on a tight loop
  // (the client self-throttles, but the relay must not trust that). See the stemview case.
  private stemViewRate: Record<string, number> = {};
  // Last per-deck word-timed lyrics the host streamed, so a late guest's caption ribbon fills in.
  private lastLyrics: Record<string, { videoId: string; lines: unknown; source: string }> = {};
  // Last auto-DJ queue + status the host streamed, so a joining guest sees what's coming.
  private lastAutomix: unknown;
  // Device ids the host has granted control. Persisted so a granted guest survives a
  // page refresh with its control intact instead of silently dropping to a listener (#10).
  private grants = new Set<string>();
  // Guest device ids the host has approved into the session (the handshake). Persisted so
  // an approved guest who refreshes re-enters without knocking again. Cleared on deny/kick.
  private approved = new Set<string>();
  // Coalesce storage WRITES. A busy session updates snapshot/stemview/lyrics many times a second;
  // persisting EACH one burned the DO write quota (it blew Cloudflare's free-tier daily cap). The
  // in-memory copies are always current for live relay + catch-up; disk is only a cold-restart
  // fallback (and a present host re-publishes everything on join), so a few seconds of on-disk lag
  // is fine. Throttle each cache to at most one write per PERSIST_MIN_MS.
  private static PERSIST_MIN_MS = 10_000;
  private snapAt = 0;
  private stemAt = 0;
  private lyricAt = 0;
  // Public-room hardening. MAX_LISTENERS caps the anonymous crowd one DO admits (the
  // single-threaded fan-out ceiling — beyond this a relay tier is needed). ANCHOR_GRACE_MS
  // holds the clock through a host network blip instead of yanking it (→ a frozen room +
  // anchor flap) when the host is the only controller and just dropped momentarily.
  private static MAX_LISTENERS = 500;
  private static ANCHOR_GRACE_MS = 8000;
  private anchorGraceTimer: ReturnType<typeof setTimeout> | null = null;
  // Digest roll-up (D1): WRITERS get every intent immediately (instant mixing feel); the
  // LISTENER crowd gets a curated stream — gestural jog dropped, continuous SWEEPS coalesced
  // to ~20Hz (last value per control), discrete events passed straight through. As the FX
  // rack grows, this stops each new param's sweep from multiplying listener fan-out.
  private static COALESCE_KINDS: ReadonlySet<string> = new Set(["control", "crossfade", "stemGain", "fxParam"]);
  private static DIGEST_FLUSH_MS = 50; // ~20 Hz
  private digest = new Map<string, ServerMsg>();
  private digestTimer: ReturnType<typeof setTimeout> | null = null;
  // Crowd reactions (F4) + hype (F2). Taps accumulate in a window and flush ONCE per
  // REACT_FLUSH_MS as one aggregated frame (per-emoji counts) — never per tap, so a big room
  // can't storm the fan-out. `hype` is a decaying 0..1 energy level (EMA of the window total)
  // the DJ reads as crowd vibe; the flush keeps ticking (even with no new taps) until hype
  // settles back to ~0, then idles. Per-device token bucket caps a single spammer.
  private static REACT_FLUSH_MS = 1000;
  private static HYPE_DECAY = 0.82; // per flush; ~settles over ~15s after a burst
  private static HYPE_GAIN = 0.14; // window-total → hype contribution
  private static REACT_RATE_MAX = 10; // taps per REACT_RATE_WINDOW per device
  private static REACT_RATE_WINDOW = 2000;
  private reactWindow: Record<string, number> = {};
  private hype = 0;
  private reactFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private reactRate: Record<string, { t: number; n: number }> = {};

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  // The anchor assignment is the only durable bit — load it lazily.
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.anchorId = (await this.state.storage.get<string>("anchor")) ?? null;
    this.lastSnapshot = await this.state.storage.get("snapshot");
    this.lastStemView = (await this.state.storage.get<Record<string, unknown>>("stemviews")) ?? {};
    this.lastLyrics = (await this.state.storage.get<Record<string, { videoId: string; lines: unknown; source: string }>>("lyrics")) ?? {};
    this.grants = new Set((await this.state.storage.get<string[]>("grants")) ?? []);
    this.approved = new Set((await this.state.storage.get<string[]>("approved")) ?? []);
    this.isPublic = (await this.state.storage.get<boolean>("public")) ?? false;
    this.stageGate = (await this.state.storage.get<StageGate>("stageGate")) ?? "request";
    this.loaded = true;
  }

  private async saveGrants(): Promise<void> {
    await this.state.storage.put("grants", [...this.grants]);
  }

  private async saveApproved(): Promise<void> {
    await this.state.storage.put("approved", [...this.approved]);
  }

  // Best-effort persistence of the per-deck stem envelopes. They can be large; stay well
  // under the DO's 128 KiB per-value cap (oversized ones live in memory only — the host
  // re-streams on the next join / track change anyway) and never throw.
  private async persistStemViews(): Promise<void> {
    const now = Date.now();
    if (now - this.stemAt < DjRoom.PERSIST_MIN_MS) return; // throttled — in-memory copy stays live
    try {
      if (JSON.stringify(this.lastStemView).length > 120_000) return;
      this.stemAt = now;
      await this.state.storage.put("stemviews", this.lastStemView);
    } catch {
      /* best-effort — a failed persist must never tear down a socket */
    }
  }

  // Same best-effort contract as the stem envelopes: a long track's word list can be sizeable,
  // so cap it well under the 128 KiB per-value limit (oversized stays in memory + re-streams).
  private async persistLyrics(): Promise<void> {
    const now = Date.now();
    if (now - this.lyricAt < DjRoom.PERSIST_MIN_MS) return; // throttled — in-memory copy stays live
    try {
      if (JSON.stringify(this.lastLyrics).length > 120_000) return;
      this.lyricAt = now;
      await this.state.storage.put("lyrics", this.lastLyrics);
    } catch {
      /* best-effort — never tear down a socket over a persist */
    }
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
    const pub = url.searchParams.get("pub") === "1"; // anon read-only listener (un-forgeable; the Worker sets it)
    const color = (url.searchParams.get("color") || "").slice(0, 9); // account accent (hex) for the room vibe

    // A public listener may only enter an OPEN room, and only ever as read-only audio.
    if (pub && !this.isPublic) {
      return new Response("this room isn't public", { status: 403 });
    }
    // Capacity valve: one DO can only fan out to so many sockets before the relay tier is
    // needed. Cap the anonymous CROWD (not participants — they're a small set). A reconnect
    // of an already-counted device is exempt (it owns a slot already).
    if (pub && this.listenerCount() >= DjRoom.MAX_LISTENERS && this.state.getWebSockets(device).length === 0) {
      return new Response("this room is full", { status: 503 });
    }

    // A device reconnecting replaces its stale socket(s) — keep one per device.
    for (const old of this.state.getWebSockets(device)) old.close(1000, "replaced");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Non-pub connect = PRESENT only, both switches off; flipping either (or an invite/
    // reconnect auto-engaging) puts the device in, and a host-granted device keeps its
    // drive right across a refresh (#10). A PUBLIC listener skips the knock entirely:
    // straight into listen-only, never controlling, never anchor, not in the roster.
    const granted = this.grants.has(device);
    const att: Attachment = pub
      ? { device, name, kind, host: false, joined: true, listening: true, controlling: false, pending: false, pub: true, decks: "", stageReq: "", stage: false, joinedAt: Date.now(), color }
      : { device, name, kind, host, joined: false, listening: false, controlling: granted, pending: false, pub: false, decks: granted ? "AB" : "", stageReq: "", stage: false, joinedAt: 0, color };
    server.serializeAttachment(att);
    this.state.acceptWebSocket(server, [device]);

    server.send(
      JSON.stringify({
        t: "welcome",
        you: device,
        anchorId: this.anchorId,
        peers: pub ? [] : this.peers(), // the crowd doesn't need the roster
        listeners: this.listenerCount(),
        public: this.isPublic,
        stageGate: this.stageGate, // every listener needs the gate to show the right step-up affordance
        ...(pub ? { pub: true } : { stage: this.stageReqs() }), // participants see pending hand-raises
      } satisfies ServerMsg),
    );
    // Hand a public listener the current board immediately so it can render without a round-trip.
    if (pub) this.sendCatchUp(server);
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

    // Public listeners are strictly READ-ONLY: they may only ask for catch-up, leave, or
    // RAISE A HAND to step up (`stage`). Drop any other writer-ish message so an anon socket
    // can never knock, drive, or anchor — defense-in-depth behind the Worker's un-forgeable
    // `pub`. The hand-raise is the one sanctioned floor→stage door; the host still gates it.
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.pub && msg.t !== "request-state" && msg.t !== "leave" && msg.t !== "stage" && msg.t !== "react") return;

    switch (msg.t) {
      case "join": {
        // Establish sync. Default: SILENT + not driving — joining mirrors the board only.
        // You opt into sound (🔊, self-only) and the host opts you into control (🎛️). The
        // session-starter turns both on itself (client startSession). Granted control (the
        // `grants` set) is preserved across this patch.
        //
        // THE HANDSHAKE: the host's own devices (a.host) and already-approved guests enter
        // immediately; any other guest only KNOCKS — they sit `pending` until the host
        // approves (case "approve"). This is the door to the session.
        const aj = ws.deserializeAttachment() as Attachment | null;
        if (!aj) break;
        if (aj.host || this.approved.has(self)) {
          this.patch(ws, { joined: true, pending: false, joinedAt: aj.joinedAt || Date.now() });
          await this.settle(self);
        } else {
          // A guest knocking. Mark pending (not joined) so the host's roster shows the
          // request; broadcast so every host device sees it. Anchor is untouched.
          this.patch(ws, { pending: true, joined: false });
          this.broadcastPresence();
        }
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
        // A host's own drive = FULL control (both decks); off clears the permission.
        this.patch(ws, { controlling: !!msg.on, decks: msg.on ? "AB" : "" });
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
        // A host grant = FULL control (both decks), same as a host's own drive.
        for (const t of this.state.getWebSockets(target)) this.patch(t, { controlling: !!msg.on, decks: msg.on ? "AB" : "" });
        if (msg.on) this.grants.add(target);
        else this.grants.delete(target);
        await this.saveGrants();
        await this.settle(target);
        break;
      }
      case "approve": {
        // HOST opens the door for a knocking guest (the handshake). They come in HEARING the
        // mix (listening on) but not driving — control is a separate grant. Approval persists
        // so a refresh re-enters without re-knocking.
        if (!this.isHostDevice(self)) break;
        const target = (msg.to || "").slice(0, 64);
        if (!target || !this.isLive(target) || this.isHostDevice(target)) break;
        this.approved.add(target);
        await this.saveApproved();
        for (const t of this.state.getWebSockets(target)) {
          this.patch(t, { joined: true, pending: false, listening: true, joinedAt: Date.now() });
          // Hand the freshly-approved guest the current board immediately — the snapshot
          // (decks/stems/controls) + the host's stem envelopes — so its display + mixer
          // fill in without waiting on a client-side request round-trip.
          this.sendCatchUp(t);
        }
        await this.settle(target);
        break;
      }
      case "deny": {
        // HOST turns a knocking guest away BEFORE they're in — close them out with a reason.
        if (!this.isHostDevice(self)) break;
        const target = (msg.to || "").slice(0, 64);
        if (!target || this.isHostDevice(target)) break;
        this.evict(target, "The host didn't let you in.");
        break;
      }
      case "kick": {
        // HOST removes a guest who is already in. Drop their approval + any granted control,
        // tell them why, and close the socket. Hosts can't kick their own account's devices.
        if (!this.isHostDevice(self)) break;
        const target = (msg.to || "").slice(0, 64);
        if (!target || target === self || this.isHostDevice(target)) break;
        let dirty = false;
        if (this.approved.delete(target)) dirty = true;
        if (dirty) await this.saveApproved();
        if (this.grants.delete(target)) await this.saveGrants();
        this.evict(target, "You were removed from the session.");
        break;
      }
      case "stage": {
        // The floor→stage channel (E3–E6). A broadcast LISTENER (pub) asks for a deck; the
        // SAME message with deck:null cancels a pending request OR — from someone already on
        // the decks — steps them back down to the floor. What a deck-ask DOES depends on the
        // host's gate (E6): closed → refused; open → instant grab of a free deck; request →
        // raise a hand for the host to approve.
        const a = ws.deserializeAttachment() as Attachment | null;
        if (!a) break;
        const deck = msg.deck;
        if (deck === "A" || deck === "B") {
          if (!a.pub) break; // a seated participant already plays
          if (this.stageGate === "closed") {
            this.refuseStage(ws, "The host has closed the decks.");
          } else if (this.stageGate === "open") {
            if (this.deckHeldByStage(deck)) this.refuseStage(ws, `Deck ${deck} is taken.`);
            else await this.promoteToStage(self, deck); // grab a free deck instantly, no approval
          } else {
            this.patch(ws, { stageReq: deck }); // request mode → raise a hand
            this.broadcastPresence(); // surface the request to the host's roster
          }
        } else if (a.stage) {
          this.returnToFloor(self); // a stage DJ steps down → back into the anonymous crowd
        } else if (a.pub && a.stageReq) {
          this.patch(ws, { stageReq: "" }); // a listener cancels its pending request
          this.broadcastPresence();
        }
        break;
      }
      case "stage-approve": {
        // HOST brings a hand-raising listener up onto a deck (request mode). They leave the
        // anonymous crowd, enter the roster as a real participant, and drive exactly that deck.
        if (!this.isHostDevice(self)) break;
        const target = (msg.to || "").slice(0, 64);
        const deck = msg.deck === "A" || msg.deck === "B" ? msg.deck : null;
        if (!target || !deck || !this.isLive(target)) break;
        await this.promoteToStage(target, deck);
        break;
      }
      case "stage-deny": {
        // HOST declines a pending request, OR sends a stage DJ back to the floor. Either way
        // the device reverts to an anonymous read-only listener (it's never disconnected).
        if (!this.isHostDevice(self)) break;
        const target = (msg.to || "").slice(0, 64);
        if (!target || target === self || this.isHostDevice(target)) break;
        for (const t of this.state.getWebSockets(target)) this.refuseStage(t, "The host didn't bring you up.");
        this.returnToFloor(target);
        break;
      }
      case "react": {
        // A crowd reaction (F4). Validate against the fixed emoji set, rate-limit per device
        // (a token bucket), accumulate into the window, and schedule the aggregated flush.
        if (!isReaction(msg.emoji)) break;
        const now = Date.now();
        const rl = this.reactRate[self];
        if (!rl || now - rl.t >= DjRoom.REACT_RATE_WINDOW) {
          this.reactRate[self] = { t: now, n: 1 };
        } else {
          if (rl.n >= DjRoom.REACT_RATE_MAX) break; // over budget → drop silently (reactions are fire-and-forget)
          rl.n++;
        }
        this.reactWindow[msg.emoji] = (this.reactWindow[msg.emoji] ?? 0) + 1;
        this.scheduleReactFlush();
        break;
      }
      case "stageGate": {
        // HOST sets how the crowd reaches the decks. Persisted (survives a cold restart).
        // Closing the decks doesn't evict current stage DJs — the host ⬇-floors them by hand;
        // it only stops NEW ones. The mode rides presence so every listener's UI adapts.
        if (!this.isHostDevice(self)) break;
        const m = msg.mode;
        if (m !== "request" && m !== "open" && m !== "closed") break;
        if (m === this.stageGate) break;
        this.stageGate = m;
        await this.state.storage.put("stageGate", m);
        this.broadcastPresence();
        break;
      }
      case "leave": {
        this.patch(ws, { controlling: false, listening: false, joined: false, decks: "", stage: false, stageReq: "" });
        // A full leave drops any granted drive right too — the host re-grants on return.
        if (this.grants.delete(self)) await this.saveGrants();
        await this.settle(self);
        break;
      }
      case "intent": {
        // ANY controller drives, but only the DECKS they hold: the host/granted drive
        // everything ("AB"); a STEPPED-UP listener drives exactly their one deck and nothing
        // else (a deck-less move — crossfader, automix, queue — needs full control). The
        // sender already applied it locally; an out-of-lane intent is silently dropped here
        // so the authoritative board never moves under an unauthorised hand.
        if (!this.canDrive(self, msg.intent)) break;
        const out = { t: "intent", from: self, seq: ++this.seq, intent: msg.intent } satisfies ServerMsg;
        // WRITERS + invited guests get EVERY intent immediately (instant mixing feel; they
        // may be driving / mirroring the platter). skipListeners=true → non-pub only.
        this.relay(self, out, true);
        // The LISTENER crowd (digest roll-up): jog is gestural + non-reconstructable → drop
        // (they hold position from the tick, resync at the next anchor). Continuous SWEEPS
        // are coalesced (~20Hz, last value per control) so a rack of FX sweeps doesn't fan
        // out at input rate. Everything else (load/cue/loop/transport/hotcue/sync/fxRack/…)
        // passes straight through.
        const kind = msg.intent.kind;
        if (kind === "jog") break;
        if (DjRoom.COALESCE_KINDS.has(kind)) this.queueDigest(msg.intent, out);
        else this.relayToListeners(out);
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
          this.relay(self, { t: "state", snapshot: msg.snapshot });
          // Persist THROTTLED + best-effort — the in-memory copy above already serves live relay
          // and catch-up; disk is just the cold-restart fallback, so one write per PERSIST_MIN_MS
          // is plenty (was: a write on EVERY control change, which blew the free-tier write cap).
          const now = Date.now();
          if (now - this.snapAt >= DjRoom.PERSIST_MIN_MS) {
            this.snapAt = now;
            try {
              await this.state.storage.put("snapshot", msg.snapshot);
            } catch {
              /* keep the in-memory snapshot; persistence is non-critical */
            }
          }
        }
        break;
      }
      case "stemview": {
        // Whoever speaks for the board + has the stems streams its per-deck waveform
        // envelopes: any controller OR the anchor (snapshot authority). Keep in memory +
        // relay (what remotes actually need); persistence is BEST-EFFORT and must never
        // throw out of here — a long track's envelope can exceed the DO's 128 KiB
        // per-value storage cap, and a rejected put would close this socket (1006) into a
        // reconnect flap that reads as "stuck connecting".
        if ((this.isControlling(self) || self === this.anchorId) && (msg.deck === "A" || msg.deck === "B")) {
          // Trust nothing about size or cadence. A malformed/oversized envelope must not
          // be fanned out to every peer (memory pressure), and the sender is rate-limited
          // per deck so a tight re-publish loop can't amplify. Both are server-enforced —
          // the client's own throttle is an optimisation, not a guarantee.
          const size = JSON.stringify(msg.view ?? null).length;
          const now = Date.now();
          const rk = `${self}:${msg.deck}`;
          const tooSoon = now - (this.stemViewRate[rk] ?? 0) < 2000;
          if (size <= 400_000 && !tooSoon) {
            this.stemViewRate[rk] = now;
            this.lastStemView[msg.deck] = msg.view;
            this.relay(self, { t: "stemview", deck: msg.deck, view: msg.view });
            void this.persistStemViews();
          }
        }
        break;
      }
      case "lyrics": {
        // The board's authority (controller / anchor) streams the deck's word-timed lyrics so
        // stem-less or YouTube-engine guests still get accurate, playhead-aligned captions. Same
        // best-effort persistence contract as stemview (never throw out of here).
        if ((this.isControlling(self) || self === this.anchorId) && (msg.deck === "A" || msg.deck === "B")) {
          this.lastLyrics[msg.deck] = { videoId: msg.videoId, lines: msg.lines, source: msg.source };
          this.relay(self, { t: "lyrics", deck: msg.deck, videoId: msg.videoId, lines: msg.lines, source: msg.source });
          void this.persistLyrics();
        }
        break;
      }
      case "automix": {
        // The board's authority (controller / anchor) streams the auto-DJ queue + status.
        // In-memory + relay only — it regenerates, so not worth the DO storage-cap risk.
        if (this.isControlling(self) || self === this.anchorId) {
          this.lastAutomix = msg.state;
          this.relay(self, { t: "automix", state: msg.state });
        }
        break;
      }
      case "request-state": {
        this.sendCatchUp(ws);
        break;
      }
      case "color": {
        // This device's account accent changed → update + re-broadcast presence so the
        // room "vibe" (the host's colour) and the roster swatches sync instantly.
        this.patch(ws, { color: (msg.color || "").slice(0, 9) });
        this.broadcastPresence();
        break;
      }
      case "settings": {
        // ACCOUNT-PRIVATE live theme sync: a signed-in device's colour/theme settings changed
        // → fan out to the OWNER's OTHER devices ONLY (a.host, set un-forgeably by the Worker).
        // Guests on other accounts must never send OR receive this, so gate on the sender being
        // a host device and relay only to host devices. NOT persisted — D1 (/api/me/settings) is
        // the durable store; this is purely the instant nudge (the poll backstop covers misses).
        if (this.isHostDevice(self)) {
          this.relayToOwnDevices(self, { t: "settings", settings: msg.settings, updatedAt: msg.updatedAt });
        }
        break;
      }
      case "public": {
        // Only the HOST opens/closes the broadcast plane. Persisted so the room stays
        // public across a cold restart. Closing it evicts the anonymous listeners.
        if (!this.isHostDevice(self)) break;
        this.isPublic = !!msg.on;
        await this.state.storage.put("public", this.isPublic);
        if (!this.isPublic) {
          for (const w of this.state.getWebSockets()) {
            const a = w.deserializeAttachment() as Attachment | null;
            if (!a?.pub && !a?.stage) continue; // drop the crowd AND anyone they brought up onto the decks
            try {
              w.send(JSON.stringify({ t: "kicked", reason: "The host ended the public broadcast." } satisfies ServerMsg));
            } catch {
              /* socket already gone */
            }
            w.close(4002, "broadcast ended");
          }
        }
        this.broadcastPresence();
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
    if (dev && dev === this.anchorId) {
      const next = this.nextAnchor(dev, ws);
      if (next) {
        await this.setAnchor(next, ws); // another participant can hold the clock → hand over now
      } else {
        // No other eligible anchor (e.g. a public room whose ONLY controller is the host).
        // Don't yank the clock on a momentary blip — that freezes the room AND flaps the
        // anchor on every reconnect. Hold the anchor for a grace window; if the host comes
        // back (same device id), it resumes ticking seamlessly. Only clear if it stays gone.
        this.scheduleAnchorGrace(dev);
      }
    } else {
      this.broadcastPresence(ws);
    }
  }

  private scheduleAnchorGrace(droppedAnchor: string): void {
    if (this.anchorGraceTimer) return;
    this.anchorGraceTimer = setTimeout(async () => {
      this.anchorGraceTimer = null;
      await this.load();
      // Host back + live + joined → its reconnect already re-anchored; leave it. Still gone
      // → release the clock (nextAnchor is likely null here, which clears it for the crowd).
      if (this.anchorId === droppedAnchor && !(this.isLive(droppedAnchor) && this.isJoined(droppedAnchor))) {
        await this.setAnchor(this.nextAnchor(droppedAnchor));
      }
    }, DjRoom.ANCHOR_GRACE_MS);
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

  // A phone/tablet (by its reported device kind). Used only to bias the clock toward a desktop.
  private isMobile(device: string | null): boolean {
    if (!device) return false;
    for (const ws of this.state.getWebSockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && isMobileKind(a.kind)) return true;
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
    // A stepped-up listener drives a deck but never holds the clock — so its join/control
    // transitions never move the anchor. Just refresh presence (the roster gained/changed it).
    if (this.isStage(self)) {
      this.broadcastPresence();
      return;
    }
    const anchorActive = !!this.anchorId && this.isLive(this.anchorId) && this.isJoined(this.anchorId);
    const anchorControls = !!this.anchorId && this.isControlling(this.anchorId);
    const anchorIsHost = !!this.anchorId && this.isHostDevice(this.anchorId);
    if (this.isJoined(self) && !anchorActive) {
      await this.setAnchor(self);
    } else if (anchorActive && !anchorControls && this.isControlling(self) && self !== this.anchorId) {
      await this.setAnchor(self); // a driver took over → make it the board's source of truth
    } else if (anchorActive && !anchorControls && !anchorIsHost && this.isHostDevice(self) && this.isJoined(self) && self !== this.anchorId) {
      await this.setAnchor(self); // owner joined → reclaim authority from a lone guest anchor (#7)
    } else if (
      anchorActive &&
      this.isHostDevice(self) && this.isJoined(self) && self !== this.anchorId &&
      !this.isMobile(self) && this.isMobile(this.anchorId) && anchorIsHost &&
      (this.isControlling(self) || !anchorControls)
    ) {
      // The owner's DESKTOP reclaims the clock from its own phone/tablet. When the desktop (the
      // anchor) refreshes, its socket close hands the clock to the mobile (nextAnchor); on the
      // desktop's return it should take it BACK — the phone only held it because the desktop
      // dropped. Guard: don't steal from a mobile that's actively DRIVING while we're idle.
      await this.setAnchor(self);
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

  // May this device drive THIS intent? Resolves the device's strongest deck permission across
  // its sockets and defers to the pure per-deck gate (canDriveIntent): the host/granted ("AB")
  // drive everything; a stepped-up listener drives only their one deck. Replaces the old
  // any-controller check on the hot intent path so a single-deck guest can't move the rest.
  private canDrive(device: string, intent: Intent): boolean {
    let decks = "";
    for (const ws of this.state.getWebSockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.joined && a?.controlling && a.decks.length > decks.length) decks = a.decks;
    }
    return canDriveIntent(decks, intent);
  }

  // Did this device step up from the broadcast floor? Stage devices drive a deck but must
  // NEVER hold the clock (the host/broadcast origin stays the anchor) — settle + nextAnchor
  // exclude them so a stepped-up phone can't become the room's playhead authority.
  private isStage(device: string | null): boolean {
    if (!device) return false;
    for (const ws of this.state.getWebSockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.stage) return true;
    }
    return false;
  }

  // The next anchor other than `except`. Preference: a CONTROLLING participant (holds the
  // real board) › a HOST device (the session owner, authoritative even while only
  // listening — keeps a lone guest from freezing the board, #7) › any joined participant.
  private nextAnchor(except: string, exceptWs?: Ws): string | null {
    let ctrlDesktop: string | null = null;
    let ctrlAny: string | null = null;
    let hostDesktop: string | null = null;
    let hostAny: string | null = null;
    let anyJoined: string | null = null;
    for (const ws of this.state.getWebSockets()) {
      if (ws === exceptWs) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a || !a.joined || a.device === except || a.pub || a.stage) continue; // a public listener / stepped-up guest never anchors
      const mobile = isMobileKind(a.kind);
      if (a.controlling) {
        if (!mobile && !ctrlDesktop) ctrlDesktop = a.device;
        if (!ctrlAny) ctrlAny = a.device;
      }
      if (a.host) {
        if (!mobile && !hostDesktop) hostDesktop = a.device;
        if (!hostAny) hostAny = a.device;
      }
      if (!anyJoined) anyJoined = a.device;
    }
    // Preference: a controlling DESKTOP › any controller › a host DESKTOP › any host › anyone.
    // Desktops outrank phones/tablets so the clock lands on the natural DJ machine, not a phone
    // that only happened to be the last one standing.
    return ctrlDesktop ?? ctrlAny ?? hostDesktop ?? hostAny ?? anyJoined;
  }

  private patch(ws: Ws, fields: Partial<Attachment>): void {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    ws.serializeAttachment({ ...a, ...fields } satisfies Attachment);
  }

  // Forcibly remove a device (deny a knock / kick a guest): tell each of its sockets WHY,
  // then close them. webSocketClose reconciles the anchor + presence as they drop; we nudge
  // once here so the roster updates promptly even if the runtime defers those callbacks.
  private evict(device: string, reason: string): void {
    for (const ws of this.state.getWebSockets(device)) {
      try {
        ws.send(JSON.stringify({ t: "kicked", reason } satisfies ServerMsg));
      } catch {
        /* socket already gone */
      }
      ws.close(4001, "removed");
    }
    if (device === this.anchorId) void this.setAnchor(this.nextAnchor(device));
    else this.broadcastPresence();
  }

  // Promote a floor listener onto a deck: out of the anonymous crowd, into the roster as a
  // real participant driving exactly that one deck. Shared by request-mode approval and the
  // open-mode instant grab. The socket is kept — we just rewrite the attachment.
  private async promoteToStage(device: string, deck: "A" | "B"): Promise<void> {
    let promoted = false;
    for (const t of this.state.getWebSockets(device)) {
      const a = t.deserializeAttachment() as Attachment | null;
      if (!a?.pub) continue; // only a floor listener steps up
      this.patch(t, { pub: false, joined: true, listening: true, controlling: true, decks: deck, stage: true, stageReq: "", joinedAt: Date.now() });
      // Hand them the full board as a driver — they had only the curated digest as a listener.
      this.sendCatchUp(t);
      promoted = true;
    }
    if (promoted) await this.settle(device); // stage devices never anchor — settle just re-broadcasts presence
  }

  // Is a deck currently held by a stepped-up (stage) DJ? Gates the open-mode grab so two
  // listeners can't seize the same deck. The host's own full control ("AB") doesn't count —
  // the host can always co-drive; this only blocks a second CROWD member on the same deck.
  private deckHeldByStage(deck: string): boolean {
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.stage && a.decks === deck) return true;
    }
    return false;
  }

  // Tell a listener its step-up didn't happen: clear its optimistic pending state (stage-self)
  // AND surface the human reason (error). Used for closed/taken/declined.
  private refuseStage(ws: Ws, reason: string): void {
    try {
      ws.send(JSON.stringify({ t: "stage-self", status: "declined" } satisfies ServerMsg));
      ws.send(JSON.stringify({ t: "error", message: reason } satisfies ServerMsg));
    } catch {
      /* socket gone */
    }
  }

  // Send a device back to the broadcast floor: a hand-raising or stepped-up listener reverts
  // to an anonymous read-only (pub) listener — out of the roster, back into the crowd count,
  // its deck permission and stage flag cleared. Used for cancel / step-down / host send-down.
  // The socket is never closed; the listener keeps hearing the mix, just no longer drives.
  private returnToFloor(device: string): void {
    for (const ws of this.state.getWebSockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      this.patch(ws, { pub: true, joined: true, listening: true, controlling: false, decks: "", stage: false, stageReq: "" });
    }
    if (this.grants.delete(device)) void this.saveGrants();
    // A stage device should never have been the anchor, but reassign defensively if so.
    if (device === this.anchorId) void this.setAnchor(this.nextAnchor(device));
    else this.broadcastPresence();
  }

  // Catch a single socket up on the authoritative board: the last snapshot
  // (decks/stems/controls) + the host's per-deck stem envelopes (so a stem-less
  // remote's 4-lane display fills in). Used on request-state AND right after a guest
  // is approved, so it doesn't depend on the client asking at the right moment.
  private sendCatchUp(ws: Ws): void {
    if (this.lastSnapshot !== undefined) {
      ws.send(JSON.stringify({ t: "state", snapshot: this.lastSnapshot } satisfies ServerMsg));
    }
    if (this.lastAutomix !== undefined) {
      ws.send(JSON.stringify({ t: "automix", state: this.lastAutomix } satisfies ServerMsg));
    }
    for (const d of ["A", "B"] as const) {
      if (this.lastStemView[d] !== undefined) {
        ws.send(JSON.stringify({ t: "stemview", deck: d, view: this.lastStemView[d] } satisfies ServerMsg));
      }
      const ly = this.lastLyrics[d];
      if (ly) {
        ws.send(JSON.stringify({ t: "lyrics", deck: d, videoId: ly.videoId, lines: ly.lines, source: ly.source } satisfies ServerMsg));
      }
    }
  }

  // Count of distinct anonymous read-only (public) listeners — the crowd surfaced as
  // a number, never an individual roster entry (privacy + fan-out cost at scale).
  private listenerCount(): number {
    const seen = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.pub) seen.add(a.device);
    }
    return seen.size;
  }

  // The pending floor→stage hand-raises (listeners asking to play) — surfaced ONLY to
  // participants so the host can approve/deny. Deduped by device (one request per listener).
  private stageReqs(): StageReq[] {
    const out: StageReq[] = [];
    const seen = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.pub && (a.stageReq === "A" || a.stageReq === "B") && !seen.has(a.device)) {
        seen.add(a.device);
        out.push({ id: a.device, name: a.name, deck: a.stageReq });
      }
    }
    return out;
  }

  private peers(except?: Ws): Peer[] {
    const out: Peer[] = [];
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && !a.pub) // public listeners are a count, not a roster row
        out.push({
          id: a.device,
          name: a.name,
          kind: a.kind || "Device",
          host: !!a.host,
          joined: !!a.joined,
          listening: !!a.listening,
          controlling: !!a.controlling,
          anchor: a.device === this.anchorId,
          pending: !!a.pending,
          decks: a.decks || "",
          stage: !!a.stage,
          joinedAt: a.joinedAt || 0,
          color: a.color || "",
        });
    }
    return out;
  }

  private async setAnchor(device: string | null, except?: Ws): Promise<void> {
    // No-op if the anchor isn't actually changing — skip the storage write AND the role broadcast.
    // (A reconnect storm can call this repeatedly with the same device; each used to write a row.)
    if (device === this.anchorId) {
      this.broadcastPresence(except);
      return;
    }
    this.anchorId = device;
    await this.state.storage.put("anchor", device);
    this.broadcast({ t: "role", anchorId: device }, except);
    this.broadcastPresence(except);
  }

  // Relay to everyone except the sender. `skipListeners` omits the anonymous read-only
  // (public) crowd — used for gestural messages they can't reconstruct (see the jog case).
  private relay(from: string, msg: ServerMsg, skipListeners = false): void {
    const json = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (this.deviceOf(ws) === from) continue;
      if (skipListeners) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a?.pub) continue;
      }
      ws.send(json);
    }
  }

  // Send ONLY to the anonymous read-only (public) listener crowd. The digest path uses this.
  private relayToListeners(msg: ServerMsg): void {
    const json = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a?.pub) continue;
      try {
        ws.send(json);
      } catch {
        /* socket gone */
      }
    }
  }

  // What makes a sweep "the same control" — so last-value-wins coalescing replaces, not
  // queues: kind + deck + the param/stem/slot it targets.
  private static digestKey(i: Intent): string {
    const a = i as unknown as Record<string, unknown>;
    return `${i.kind}:${a.deck ?? ""}:${a.param ?? a.stem ?? a.slot ?? ""}`;
  }

  // Buffer a continuous sweep for the listener crowd, keeping only the latest value per
  // control, and flush the batch at ~DIGEST_FLUSH_MS. During an active sweep the DO is awake
  // (it's processing the intents), so the timer fires; an idle room never queues anything.
  private queueDigest(intent: Intent, msg: ServerMsg): void {
    this.digest.set(DjRoom.digestKey(intent), msg);
    if (this.digestTimer) return;
    this.digestTimer = setTimeout(() => {
      this.digestTimer = null;
      const batch = [...this.digest.values()];
      this.digest.clear();
      for (const m of batch) this.relayToListeners(m);
    }, DjRoom.DIGEST_FLUSH_MS);
  }

  // Crowd reactions: flush the accumulated window ONCE per tick as a single aggregated frame
  // (counts + the updated hype level), to EVERYONE. The timer keeps ticking — decaying hype
  // even with no new taps — until energy settles, then idles (no taps + hype≈0 → stop). This
  // is the F4/F2 spine: O(N) fan-out per SECOND, never per tap.
  private scheduleReactFlush(): void {
    if (this.reactFlushTimer) return;
    this.reactFlushTimer = setTimeout(() => {
      this.reactFlushTimer = null;
      const counts = this.reactWindow;
      this.reactWindow = {};
      const total = Object.values(counts).reduce((s, n) => s + n, 0);
      // EMA: decay the standing energy, add this window's contribution, clamp to [0,1].
      this.hype = Math.min(1, this.hype * DjRoom.HYPE_DECAY + total * DjRoom.HYPE_GAIN);
      if (this.hype < 0.01) this.hype = 0;
      this.broadcast({ t: "reactions", counts, hype: this.hype });
      // Keep ticking while there's energy to decay or fresh taps arrived; else go idle.
      if (this.hype > 0) this.scheduleReactFlush();
    }, DjRoom.REACT_FLUSH_MS);
  }

  // Relay a message ONLY to the session-owner's own devices (a.host) — never to invited
  // guests on other accounts. For account-private live sync (settings) that must not leak.
  private relayToOwnDevices(from: string, msg: ServerMsg): void {
    const json = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a?.host || a.device === from) continue;
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

  // Presence is the storm at scale: every join/leave is a "change", and fanning the full
  // roster to every socket on each one is O(N²) on a join burst — the real ceiling well
  // before the audio fan-out. Two fixes: (1) COALESCE (leading-edge throttle — a sparse
  // change still flushes instantly, so a small session has no added latency; a burst
  // collapses into one trailing flush), and (2) SPLIT (only PARTICIPANTS get the roster;
  // the anonymous LISTENER crowd gets just the count — they're not in the roster anyway).
  // `except` is now moot (the throttled flush reads live sockets), kept for call-site parity.
  private static PRESENCE_COALESCE_MS = 1000;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presencePending = false;

  private broadcastPresence(_except?: Ws): void {
    if (this.presenceTimer) {
      this.presencePending = true; // a change arrived mid-window → flush once more at window end
      return;
    }
    this.flushPresence();
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      if (this.presencePending) {
        this.presencePending = false;
        this.broadcastPresence();
      }
    }, DjRoom.PRESENCE_COALESCE_MS);
  }

  private flushPresence(): void {
    const peers = this.peers();
    const listeners = this.listenerCount();
    // Participants get the roster + the pending floor→stage hand-raises (the host acts on them).
    const full = JSON.stringify({ t: "presence", peers, listeners, public: this.isPublic, stage: this.stageReqs(), stageGate: this.stageGate } satisfies ServerMsg);
    // The crowd isn't in the roster, so it gets the count only — half the payload, no stage
    // list — but it DOES need the gate mode to show the right step-up affordance.
    const lite = JSON.stringify({ t: "presence", peers: [], listeners, public: this.isPublic, stageGate: this.stageGate } satisfies ServerMsg);
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      try {
        ws.send(a?.pub ? lite : full);
      } catch {
        /* socket gone — ignore */
      }
    }
  }
}
