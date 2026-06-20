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
import { canDriveIntent } from "../src/htl/room/protocol";
import {
  type Attachment,
  type Ws,
  type DurableObjectState,
  type RoomView,
  isMobileKind,
  pubMayChange,
  peerOf,
  welcomeFor,
  presenceFor,
} from "./roomState";
import { Reactions, Requests, Chat } from "./roomCrowd";

// The DjRoom Durable Object: socket lifecycle, membership transitions, the anchor (clock),
// relay/presence fan-out, and persistence. The PURE state model (Attachment, roles, the pub
// allowlist, the presence/welcome payload shapes) lives in ./roomState so it's testable on its
// own; this file is the stateful plumbing around it. WebSocketPair is a runtime global.
declare const WebSocketPair: { new (): { 0: Ws; 1: Ws } };

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
  // The crowd→DJ side-channels (reactions/hype + song requests) — self-contained units that
  // own their own windows/timers/rate buckets (see roomCrowd.ts). Reactions broadcasts each
  // aggregated frame via the DO's fan-out.
  private reactions = new Reactions((m) => this.broadcast(m));
  private songRequests = new Requests();
  // Chat (F5) + moderation (L1). `chat` buffers + rate-limits the text; the DO owns slow-mode
  // (host setting, persisted) and the session-ephemeral `muted`/`banned` device sets.
  private chat = new Chat();
  private chatSlow = 0; // <0 chat off, 0 normal, >0 slow-mode seconds
  private muted = new Set<string>();
  private banned = new Set<string>();

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
    this.chatSlow = (await this.state.storage.get<number>("chatSlow")) ?? 0;
    // Moderation (L1) survives a DO eviction — a ban that evaporated when the room idled wasn't
    // a ban. Mute persists too so a re-muted spammer stays muted across a cold restart.
    this.muted = new Set((await this.state.storage.get<string[]>("muted")) ?? []);
    this.banned = new Set((await this.state.storage.get<string[]>("banned")) ?? []);
    this.loaded = true;
  }

  private async saveGrants(): Promise<void> {
    await this.state.storage.put("grants", [...this.grants]);
  }

  private async saveMuted(): Promise<void> {
    await this.state.storage.put("muted", [...this.muted]);
  }

  private async saveBanned(): Promise<void> {
    await this.state.storage.put("banned", [...this.banned]);
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
    const ev = Math.max(0, Math.min(9999, Number(url.searchParams.get("ev")) || 0)); // reconstruction-engine version (D5)

    // A host-banned device can't re-enter the session (L1). Device ids are non-secret, so this
    // is best-effort — the same posture as the rest of this anon system.
    if (this.banned.has(device)) {
      return new Response("you were removed from this room", { status: 403 });
    }
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
      ? { device, name, kind, host: false, joined: true, listening: true, controlling: false, pending: false, pub: true, decks: "", stageReq: "", stage: false, joinedAt: Date.now(), color, ev }
      : { device, name, kind, host, joined: false, listening: false, controlling: granted, pending: false, pub: false, decks: granted ? "AB" : "", stageReq: "", stage: false, joinedAt: 0, color, ev };
    server.serializeAttachment(att);
    this.state.acceptWebSocket(server, [device]);

    server.send(JSON.stringify(welcomeFor(device, this.roomView(), pub, this.songRequests.list)));
    this.sendChatHistory(server); // recent chat backlog so a joiner has context
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
    if (att?.pub && !pubMayChange(msg.t)) return; // crowd listeners may only send the allowlisted messages

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
        // A crowd reaction (F4) — the Reactions unit validates the emoji, rate-limits per
        // device, accumulates, and flushes the aggregated frame. Fire-and-forget.
        this.reactions.tap(self, msg.emoji);
        break;
      }
      case "request": {
        // A song request (F1). The Requests unit trims/caps/dedupes + rate-limits; on success
        // we push the new list to participants, else surface the reason to the asker.
        const a = ws.deserializeAttachment() as Attachment | null;
        const r = this.songRequests.add(self, a?.name || "Someone", msg.text);
        if (r.ok) this.relayRequests();
        else if (r.error) ws.send(JSON.stringify({ t: "error", message: r.error } satisfies ServerMsg));
        break;
      }
      case "request-vote": {
        // Upvote a request (F3). Idempotent per device; on a real vote, re-relay the re-ranked list.
        if (this.songRequests.vote(self, msg.id)) this.relayRequests();
        break;
      }
      case "request-dismiss": {
        if (!this.isHostDevice(self)) break;
        if (this.songRequests.dismiss(msg.id)) this.relayRequests();
        break;
      }
      case "request-clear": {
        if (!this.isHostDevice(self)) break;
        if (this.songRequests.clear()) this.relayRequests();
        break;
      }
      case "chat": {
        // A chat line (F5). Refused if chat is off / this device is muted; else the Chat unit
        // rate-limits + slow-modes, and a passing line fans out to everyone.
        const a = ws.deserializeAttachment() as Attachment | null;
        if (!a) break;
        if (this.chatSlow < 0) {
          ws.send(JSON.stringify({ t: "error", message: "Chat is off." } satisfies ServerMsg));
          break;
        }
        if (this.muted.has(self)) {
          ws.send(JSON.stringify({ t: "error", message: "You're muted." } satisfies ServerMsg));
          break;
        }
        const r = this.chat.post(self, a.name, msg.text, this.chatSlow);
        if (r.ok) this.broadcast({ t: "chat", msg: r.msg });
        else if (r.error) ws.send(JSON.stringify({ t: "error", message: r.error } satisfies ServerMsg));
        break;
      }
      case "chat-slow": {
        // HOST sets slow-mode (<0 = chat off). Persisted; rides presence so every client adapts.
        if (!this.isHostDevice(self)) break;
        const s = Math.max(-1, Math.min(60, Math.floor(msg.seconds)));
        if (s === this.chatSlow) break;
        this.chatSlow = s;
        await this.state.storage.put("chatSlow", s);
        this.broadcastPresence();
        break;
      }
      case "mute": {
        // HOST mutes/unmutes a device's chat (L1). Tell the device so its composer reflects it.
        if (!this.isHostDevice(self)) break;
        const to = (msg.to || "").slice(0, 64);
        if (!to || this.isHostDevice(to)) break;
        if (msg.on) this.muted.add(to);
        else this.muted.delete(to);
        await this.saveMuted();
        for (const w of this.state.getWebSockets(to)) {
          try {
            w.send(JSON.stringify({ t: "muted", on: !!msg.on } satisfies ServerMsg));
          } catch {
            /* socket gone */
          }
        }
        this.broadcastPresence(); // refresh the host's muted list so the row flips mute⇄unmute
        break;
      }
      case "ban": {
        // HOST bans a device (L1): remember it (re-entry blocked in fetch) + evict it now.
        if (!this.isHostDevice(self)) break;
        const to = (msg.to || "").slice(0, 64);
        if (!to || to === self || this.isHostDevice(to)) break;
        this.banned.add(to);
        await this.saveBanned();
        if (this.muted.delete(to)) await this.saveMuted();
        this.evict(to, "You were removed by the host.");
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
        this.sendChatHistory(ws);
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
        if (msg.on) {
          this.isPublic = true;
          await this.state.storage.put("public", true);
          this.broadcastPresence();
        } else {
          await this.endBroadcast("The host ended the public broadcast.");
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
      // Host back + live + joined → its reconnect already re-anchored; leave it.
      if (this.anchorId === droppedAnchor && !(this.isLive(droppedAnchor) && this.isJoined(droppedAnchor))) {
        const next = this.nextAnchor(droppedAnchor);
        if (!next && this.isPublic) {
          // E7: the host ABANDONED a public broadcast (gone past grace, no one else can hold the
          // clock). Don't strand the crowd on a frozen mix — END the broadcast so they're told
          // and released, exactly as an explicit "stop" would. (The D1 directory row ages out via
          // the freshness filter once the host's heartbeat stops.)
          await this.endBroadcast("The host left.");
        } else {
          await this.setAnchor(next); // private room (or a handoff target) → release/hand the clock
        }
      }
    }, DjRoom.ANCHOR_GRACE_MS);
  }

  // End the public broadcast: clear the flag (persisted) + evict the anonymous crowd AND any
  // stage DJs they brought up, with a reason. Shared by the host's explicit stop and E7's
  // host-abandonment grace expiry.
  private async endBroadcast(reason: string): Promise<void> {
    this.isPublic = false;
    await this.state.storage.put("public", false);
    for (const w of this.state.getWebSockets()) {
      const a = w.deserializeAttachment() as Attachment | null;
      if (!a?.pub && !a?.stage) continue;
      try {
        w.send(JSON.stringify({ t: "kicked", reason } satisfies ServerMsg));
      } catch {
        /* socket already gone */
      }
      w.close(4002, "broadcast ended");
    }
    this.broadcastPresence();
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

  // The room's authoritative reconstruction-engine version (D5) = the ANCHOR's reported `ev`
  // (the device producing the recipe everyone rebuilds). 0 until an anchor with a known
  // version is live. Clients compare it to their local ENGINE_VERSION to spot an unfaithful mix.
  private engineVersion(): number {
    if (!this.anchorId) return 0;
    for (const ws of this.state.getWebSockets(this.anchorId)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a) return a.ev || 0;
    }
    return 0;
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
  // Hand a socket the recent chat backlog (F5), so a joiner drops into context mid-conversation.
  private sendChatHistory(ws: Ws): void {
    if (this.chat.history.length) {
      ws.send(JSON.stringify({ t: "chat-history", list: this.chat.history } satisfies ServerMsg));
    }
  }

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
      if (a && !a.pub) out.push(peerOf(a, this.anchorId)); // public listeners are a count, not a roster row
    }
    return out;
  }

  // Snapshot the shared room state both welcome + presence are built from — one place to add a
  // new broadcast field (see welcomeFor / presenceFor in roomState.ts).
  private roomView(): RoomView {
    return {
      anchorId: this.anchorId,
      peers: this.peers(),
      listeners: this.listenerCount(),
      isPublic: this.isPublic,
      stageGate: this.stageGate,
      stage: this.stageReqs(),
      chatSlow: this.chatSlow,
      muted: [...this.muted],
      engineVersion: this.engineVersion(),
    };
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

  // The ONE fan-out primitive: stringify once, send to every socket whose attachment passes
  // `pred`. A dead socket is skipped, never thrown out of (the inconsistency the old
  // hand-rolled loops had — some try/caught, some didn't). Every relay/broadcast helper below
  // is just a named predicate over this, so "who receives what" reads in one line each.
  private sendTo(pred: (a: Attachment | null, ws: Ws) => boolean, msg: ServerMsg): void {
    const json = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!pred(a, ws)) continue;
      try {
        ws.send(json);
      } catch {
        /* socket gone — skip it, never break the fan-out */
      }
    }
  }

  // Relay to everyone except the sender. `skipListeners` omits the anonymous read-only
  // (public) crowd — used for gestural messages they can't reconstruct (see the jog case).
  private relay(from: string, msg: ServerMsg, skipListeners = false): void {
    this.sendTo((a) => (a?.device ?? null) !== from && !(skipListeners && a?.pub), msg);
  }

  // Send ONLY to the anonymous read-only (public) listener crowd. The digest path uses this.
  private relayToListeners(msg: ServerMsg): void {
    this.sendTo((a) => !!a?.pub, msg);
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

  // Push the current (re-ranked) song-request list to EVERYONE — participants act on it, and
  // the crowd needs it to upvote (F3). It's a public board for a public lobby.
  private relayRequests(): void {
    this.sendTo(() => true, { t: "requests", list: this.songRequests.list });
  }

  // Relay a message ONLY to the session-owner's own devices (a.host) — never to invited
  // guests on other accounts. For account-private live sync (settings) that must not leak.
  private relayToOwnDevices(from: string, msg: ServerMsg): void {
    this.sendTo((a) => !!a?.host && a.device !== from, msg);
  }

  private broadcast(msg: ServerMsg, except?: Ws): void {
    this.sendTo((_a, ws) => ws !== except, msg);
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
    // Participants get the full roster (+ pending hand-raises); the crowd gets the count-only
    // lite frame (the big roster never fans to hundreds). Both shapes live in presenceFor.
    const { full, lite } = presenceFor(this.roomView());
    const fullJson = JSON.stringify(full);
    const liteJson = JSON.stringify(lite);
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      try {
        ws.send(a?.pub ? liteJson : fullJson);
      } catch {
        /* socket gone — ignore */
      }
    }
  }
}
