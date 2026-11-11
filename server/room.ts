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
import { digestKey } from "../src/htl/room/digestKey";
import { MAX_STEMVIEW_BYTES, MAX_STEMVIEW_RECORD_BYTES } from "../src/htl/audio/stemViewBudget";
import { DO_VALUE_CAP } from "../src/htl/room/doLimits";
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
  drivesAnything,
} from "./roomState";
import { Reactions, Requests, Chat } from "./roomCrowd";

// The DjRoom Durable Object: socket lifecycle, membership transitions, the anchor (clock),
// relay/presence fan-out, and persistence. The PURE state model (Attachment, roles, the pub
// allowlist, the presence/welcome payload shapes) lives in ./roomState so it's testable on its
// own; this file is the stateful plumbing around it. WebSocketPair is a runtime global.
declare const WebSocketPair: { new (): { 0: Ws; 1: Ws } };

// D2: the RelayRoom namespace + shard count the master needs to fan out the crowd to shards.
interface RelayStub {
  fetch(req: Request | string, init?: RequestInit): Promise<Response>;
}
interface RelayNs {
  idFromName(name: string): { readonly name?: string };
  get(id: { readonly name?: string }): RelayStub;
}
interface RoomEnv {
  RELAY?: RelayNs;
  RELAY_SHARDS?: string | number;
  INTERNAL_SECRET?: string; // bearer for the DO→Worker bridge (Epic I, Slice 7)
  TOKEN_ENC_KEY?: string; // …falling back to the at-rest key, which is how the bridge shipped
  /** The Worker origin the bridge may POST to. The connect URL supplies it when this is unset —
   *  see the note on `origin`. */
  PUBLIC_ORIGIN?: string;
}
// Map a crowd frame to its catch-up cache key (so a late joiner on a relay rebuilds `now`).
// ★ TOTAL, ON PURPOSE. This used to be a switch with `default: return "live"`, which meant a NEW
// ServerMsg type was silently ephemeral: nothing failed, nothing warned, and a late joiner on a
// relay shard simply never saw it — a bug that only shows up on a sharded room with a listener
// who joined late. As a Record keyed by ServerMsg["t"] the compiler now demands an answer for
// every frame, and the answer for a genuinely ephemeral one is an explicit "live".
export type CacheKind = "welcome" | "state" | "automix" | "stemview" | "lyrics" | "live";
const CACHE_KIND: Record<ServerMsg["t"], CacheKind> = {
  // Cached: the last of each IS the board a fresh listener has to be handed.
  welcome: "welcome",
  state: "state",
  automix: "automix",
  stemview: "stemview",
  lyrics: "lyrics",
  // "live": true of the moment and meaningless after it — a tick superseded by the next tick, a
  // reaction burst, a chat line already in chat-history, a per-socket verdict. Not cached.
  requests: "live",
  presence: "live",
  "stage-self": "live",
  // A per-socket ASK, addressed to one device at one instant — replaying it to a late joiner on a
  // relay shard would ask the wrong device for a board it does not own.
  republish: "live",
  chat: "live",
  "chat-history": "live",
  muted: "live",
  reactions: "live",
  role: "live",
  intent: "live",
  tick: "live",
  pong: "live", // one socket's clock reading
  settings: "live",
  kicked: "live",
  joined: "live", // a per-socket ack
  refused: "live", // a per-socket verdict
  error: "live",
};
function cacheKindOf(msg: ServerMsg): CacheKind {
  return CACHE_KIND[msg.t];
}

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
  private lyricTooBigAt = 0; // last time an over-cap lyrics record was logged (rate limit)
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
  private snapTooBigAt = 0; // throttles the not-persisted warning; 0 = nothing wrong right now
  // ★ PER DECK, not per record. These throttle a write whose VALUE covers both decks, so a single
  // timestamp made deck B's publish collide with deck A's and vanish: leading-edge throttle, no
  // trailing flush, and a deck publishes its envelope roughly once per track load — so there is no
  // following write to carry the update in. Memory kept both decks, disk kept one, permanently,
  // with nothing reporting it. Measured by Deckard on the real sqlite: a room parked with two decks
  // held one, 60,032 bytes for a single deck's stem set.
  // Keying by deck costs at most ONE extra write per window (there are two decks), which is a
  // bounded price for a record that is otherwise silently half-written. A trailing setTimeout would
  // have been the other fix and a worse one: the flush lands up to PERSIST_MIN_MS later, by which
  // time an idle DO may have been evicted, so the write that repairs the record is exactly the one
  // most likely never to run.
  // ★ AND NOW IT IS BOTH (operator, 2026-11-11: session sync audit): per-deck keys stay, and the
  // leading-edge throttle gains a trailing write (throttledPersist). Measured against the worry
  // above: a pending setTimeout keeps the DO resident (it is not eligible to hibernate while one is
  // armed), and dropping was the CERTAIN loss where a deferred write is at worst the same loss.
  private persistAt = new Map<string, number>();
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** A legacy single-record `lyrics` value was loaded; the next successful per-deck write retires it. */
  private lyricsNeedSplit = false;
  // Public-room hardening. MAX_LISTENERS caps the anonymous crowd one DO admits (the
  // single-threaded fan-out ceiling — beyond this a relay tier is needed). ANCHOR_GRACE_MS
  // holds the clock through a host network blip instead of yanking it (→ a frozen room +
  // anchor flap) when the host is the only controller and just dropped momentarily.
  private static MAX_LISTENERS = 500;
  private static ANCHOR_GRACE_MS = 8000;
  private anchorGraceTimer: ReturnType<typeof setTimeout> | null = null;
  // ★ A HOST ANCHOR IS HELD THROUGH A BLIP EVEN WHEN SOMEONE ELSE COULD TAKE IT (operator,
  // 2026-11-11: session sync audit). The clock used to move the instant the host's socket closed,
  // to anyone joined — a listen-only guest included — and the blipped host came back to adopt the
  // guest's board. A host anchor now gets this long to come back before the slot moves; a guest
  // anchor still hands over at once (it is only ever a stand-in).
  private static HOST_HANDOVER_GRACE_MS = 4000;
  /** The anchor device the running grace timer is holding the slot for, and whether it is a host's. */
  private graceFor: { device: string; host: boolean } | null = null;
  // ★ SILENT-ANCHOR EVICTION. A half-open socket (or an iOS anchor locked mid-set) never closes, so
  // the slot stayed on a device ticking into nothing and the whole room froze. The anchor ticks 4/s,
  // so silence past this long while others are connected is treated exactly like a close.
  private static ANCHOR_SILENT_MS = 4000;
  /** Last inbound message per socket (in memory: a ticking anchor keeps the DO awake; after a wake a
   *  socket with no entry is stamped "now" on first look, so eviction never fires on stale memory). */
  private lastSeen = new WeakMap<Ws, number>();
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sockets this room has already given up on (replaced, evicted for silence, closing). Excluded from
   *  every lookup: a closing socket can linger in getWebSockets, and a half-open replaced one made
   *  hasOtherSocket skip the NEW socket's later close (no handover, no presence). */
  private dead = new WeakSet<Ws>();
  /** Per-socket·kind last refusal, so a refused sweep answers once a second, not at input rate. */
  private refusedAt = new Map<string, number>();
  // Social presence: when a user's LAST socket here drops we don't declare them offline to their
  // friends immediately (a refresh would flap) — we arm the DO alarm and bridge "offline" up to
  // the Worker only if they're still gone after the grace. Separate concern from the 8s anchor
  // grace above (that's the clock); this is the first real storage alarm in the codebase.
  private static PRESENCE_GRACE_MS = 20_000;
  // Digest roll-up (D1): WRITERS get every intent immediately (instant mixing feel); the
  // LISTENER crowd gets a curated stream — gestural jog dropped, continuous SWEEPS coalesced
  // to ~20Hz (last value per control), discrete events passed straight through. As the FX
  // rack grows, this stops each new param's sweep from multiplying listener fan-out.
  private static COALESCE_KINDS: ReadonlySet<string> = new Set(["control", "crossfade", "stemGain", "fxParam"]);
  // ★ Intents the anonymous crowd never receives. TWO REASONS, opposite in kind, same conclusion:
  //  • jog — gestural and non-reconstructable; a listener holds position from the tick instead.
  //  • reqStems, stemsAck — ADDRESSED TO ONE DEVICE and meaningless to the crowd. A listener cannot
  //    issue a stem request (requestStemsFromHost requires `controlling`) and so has no pending
  //    request for an ack to resolve. These used to fall through to relayToListeners uncoalesced,
  //    because nothing named them — a per-requester signal broadcast to a population that cannot
  //    use it. Harmless at ~2 frames per request; the moment stemsAck carries separation progress
  //    it becomes one frame per segment per shift, fanned to the whole crowd at a rate set by the
  //    WORK rather than by anyone's need, which is the lyrics storm's exact shape. So this is
  //    closed FIRST, before progress is forwarded — the order is the fix.
  private static LISTENER_DROP_KINDS: ReadonlySet<string> = new Set(["jog", "reqStems", "stemsAck"]);
  private static DIGEST_FLUSH_MS = 50; // ~20 Hz
  // Captions are read by eye; a few hundred ms of coalescing is imperceptible against an 18 KB
  // payload arriving 165 times a second. Deliberately far slower than DIGEST_FLUSH_MS: a knob
  // sweep must feel continuous, a caption line does not.
  private static LYRICS_FLUSH_MS = 400;
  private lyricsPending = new Map<string, { msg: ServerMsg; from: string }>();
  private lyricsTimer: ReturnType<typeof setTimeout> | null = null;
  // Ordinary hygiene, not cover for a designed-in divergence: a dropped envelope means remote
  // waveforms go absent, and that should be a readable fact rather than something only a
  // byte-level capture could reveal.
  // The count is the cheap aggregate; the LOG beside its increment is what makes it answerable.
  // It spent its whole life as a tally nothing read — instrumentation with no instrument.
  private stemViewDropped = 0;
  private stemViewDropAt = 0; // last time an oversized stemview was logged (rate limit)
  private stateDropAt = 0; // last time a dropped `state` publish was logged (rate limit)
  private stateOkAt = 0; // …and the last time an ACCEPTED one was
  private stateOkFp = ""; // the last accepted snapshot's fingerprint — a CHANGE is never throttled
  private static readonly STATE_DROP_LOG_MS = 5_000;
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
  private chatFollowers = false; // followers-only chat: only host followers (+ host/stage) may post
  private muted = new Set<string>();
  private banned = new Set<string>();

  // D2 relay tier (off unless RELAY_SHARDS>0). When on, the crowd lives on R RelayRoom shards;
  // the master pushes each crowd frame to them (O(R)) + aggregates their counts. See relayRoom.ts.
  private readonly relayShards: number;
  private readonly relayNs?: RelayNs;
  private roomHostId = ""; // this room's host account id (Worker passes ?rid=) — to address relays
  private relayCounts = new Map<number, number>(); // shard idx → listener count (aggregate = the crowd)
  // ★ WHERE THE BRIDGE POSTS, and why it is worth being careful about. This is captured from the
  // first connect URL and then PINNED in durable storage, and every mention/presence POST carries
  // the internal secret to it. A request URL's host comes from the Host header; Cloudflare only
  // routes a hostname it owns to this Worker, so a forged one does not arrive — but "an attacker
  // cannot influence this" is a claim about the edge's routing table, not about this code, and it
  // is pinned forever after one write. PUBLIC_ORIGIN removes the question entirely where it is
  // set; the connect URL remains the fallback so nothing needs configuring to work.
  private origin = "";
  private notifySecret = ""; // INTERNAL_SECRET, else TOKEN_ENC_KEY; empty → the bridge is inert

  constructor(state: DurableObjectState, env?: RoomEnv) {
    this.state = state;
    this.relayShards = Math.max(0, Math.min(64, Number(env?.RELAY_SHARDS) || 0));
    this.relayNs = env?.RELAY;
    this.notifySecret = env?.INTERNAL_SECRET || env?.TOKEN_ENC_KEY || "";
    this.origin = (env?.PUBLIC_ORIGIN ?? "").replace(/\/+$/, ""); // configured wins over captured
  }
  private get relayOn(): boolean {
    return this.relayShards > 0 && !!this.relayNs;
  }

  // The anchor assignment is the only durable bit — load it lazily.
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.anchorId = (await this.state.storage.get<string>("anchor")) ?? null;
    this.lastSnapshot = await this.state.storage.get("snapshot");
    this.lastAutomix = await this.state.storage.get("automix");
    this.lastStemView = (await this.state.storage.get<Record<string, unknown>>("stemviews")) ?? {};
    // ★ LYRICS ARE PER-DECK KEYS NOW, with a one-read migration from the old single record.
    // Both decks under one key coupled them: Deckard measured a real hip-hop track (Rap God, 1542
    // words) at 64.3 KB on ONE deck and 128.6 KB on BOTH — 98.1% of the cap, passing with ~2.4 KB
    // to spare. Nothing in the client bounds a word list, so that margin is a floor, not a budget.
    // Split, the worst single deck has 2.0x headroom and one wordy track can no longer stop the
    // OTHER deck's captions from persisting. The legacy record is read when neither new key exists
    // and is deleted only after the split has been written, so a half-done migration loses nothing.
    const lyricEntry = async (d: string) =>
      await this.state.storage.get<{ videoId: string; lines: unknown; source: string }>(`lyrics:${d}`);
    const perDeck = { A: await lyricEntry("A"), B: await lyricEntry("B") };
    this.lastLyrics = {};
    for (const [d, v] of Object.entries(perDeck)) if (v) this.lastLyrics[d] = v;
    if (!perDeck.A && !perDeck.B) {
      const legacy = await this.state.storage.get<Record<string, { videoId: string; lines: unknown; source: string }>>("lyrics");
      if (legacy) {
        this.lastLyrics = legacy;
        this.lyricsNeedSplit = true; // written by the next persist, which then drops the old key
      }
    }
    this.grants = new Set((await this.state.storage.get<string[]>("grants")) ?? []);
    this.approved = new Set((await this.state.storage.get<string[]>("approved")) ?? []);
    this.isPublic = (await this.state.storage.get<boolean>("public")) ?? false;
    this.stageGate = (await this.state.storage.get<StageGate>("stageGate")) ?? "request";
    this.chatSlow = (await this.state.storage.get<number>("chatSlow")) ?? 0;
    this.chatFollowers = (await this.state.storage.get<boolean>("chatFollowers")) ?? false;
    // Moderation (L1) survives a DO eviction — a ban that evaporated when the room idled wasn't
    // a ban. Mute persists too so a re-muted spammer stays muted across a cold restart.
    this.muted = new Set((await this.state.storage.get<string[]>("muted")) ?? []);
    this.banned = new Set((await this.state.storage.get<string[]>("banned")) ?? []);
    // Persisted so the presence-offline alarm can still reach the Worker after a DO eviction (the
    // alarm fires exactly when all sockets are gone, i.e. when the in-memory origin would be lost).
    if (!this.origin) this.origin = (await this.state.storage.get<string>("origin")) ?? "";
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

  // Best-effort persistence of the per-deck stem envelopes, as ONE value holding both decks.
  // The oversized-lives-in-memory-only path is now unreachable by construction (the per-deck
  // admission bound is derived down from this record budget), but it is deliberately left in
  // place: retiring it is a separate change that wants measuring, not reasoning.
  // ★ THE THROTTLE DROPS, IT DOES NOT DEFER — so the same deck publishing twice inside one window
  // still loses the second write. Reachable: App.tsx publishes on onStemsReady and useStemViewSync
  // re-streams on a remote's stem request, so a listener arriving just after stems are ready
  // clusters two publishes of one deck. It is benign ONLY because those clustered republishes
  // carry the SAME envelope, so the dropped write is a duplicate — per-deck keying narrowed the
  // collision, content idempotence is what makes the remainder harmless. That distinction predicts
  // where this shape bites next: ANY throttled cache whose successive writes are not idempotent.
  // ★ NOW DEFERRED (operator, 2026-11-11: session sync audit): the note above predicted it — a new
  // track's envelope inside the window is NOT idempotent with the old one, and since a new track is
  // admitted at once (see the stemview case) that collision became reachable. Trailing write per deck.
  /** The track an (opaque) stem envelope belongs to — extractStemView stamps `videoId`; older peers don't. */
  private static stemViewVid(view: unknown): string | undefined {
    const v = (view as { videoId?: unknown } | null | undefined)?.videoId;
    return typeof v === "string" ? v : undefined;
  }
  private stemViewPending = new Map<string, { from: string; deck: "A" | "B"; view: unknown; timer: ReturnType<typeof setTimeout> }>();
  /** Drop every held frame for a deck (from any sender): a newer admitted frame supersedes them. */
  private clearStemViewPending(deck: string): void {
    for (const [k, p] of this.stemViewPending) {
      if (p.deck !== deck) continue;
      clearTimeout(p.timer);
      this.stemViewPending.delete(k);
    }
  }
  private admitStemView(from: string, deck: "A" | "B", view: unknown, rk: string, now: number): void {
    this.stemViewRate[rk] = now;
    this.lastStemView[deck] = view;
    this.relay(from, { t: "stemview", deck, view });
    void this.persistStemViews(deck);
  }
  // Hold the latest same-track frame inside the rate window; it lands when the window ends.
  private deferStemView(from: string, deck: "A" | "B", view: unknown, rk: string, now: number): void {
    const prev = this.stemViewPending.get(rk);
    if (prev) {
      prev.view = view; // trailing-LATEST: the armed timer carries the newest frame
      return;
    }
    const wait = Math.max(0, (this.stemViewRate[rk] ?? 0) + 2000 - now);
    const timer = setTimeout(() => {
      const p = this.stemViewPending.get(rk);
      this.stemViewPending.delete(rk);
      if (p) this.admitStemView(p.from, p.deck, p.view, rk, Date.now());
    }, wait);
    this.stemViewPending.set(rk, { from, deck, view, timer });
  }

  private async persistStemViews(deck: string): Promise<void> {
    await this.throttledPersist(`stemviews:${deck}`, () => this.writeStemViews());
  }
  private async writeStemViews(): Promise<void> {
    try {
      // Derived, not hand-written — and note the DENOMINATOR: this measures the WHOLE RECORD
      // (both decks under one key), where the admission gate above measures ONE deck. Those are
      // different quantities, and conflating them is how the first version of stemViewBudget.ts
      // claimed a property it did not have. Because the per-deck bound is now derived DOWN from
      // this record budget, two admitted envelopes always fit — so this guard is defence in depth
      // rather than a live gate, and should never fire.
      if (JSON.stringify(this.lastStemView).length > MAX_STEMVIEW_RECORD_BYTES) return;
      await this.state.storage.put("stemviews", this.lastStemView);
    } catch {
      /* best-effort — a failed persist must never tear down a socket */
    }
  }

  // Same best-effort contract as the stem envelopes: a long track's word list can be sizeable,
  // so cap it well under the 128 KiB per-value limit (oversized stays in memory + re-streams).
  private async persistLyrics(deck: string): Promise<void> {
    // Same trailing rule as the snapshot (operator, 2026-11-11: session sync audit): a new track's
    // captions inside the window used to be dropped from disk; they now land at the window's end.
    await this.throttledPersist(`lyrics:${deck}`, () => this.writeLyrics(deck));
  }
  private async writeLyrics(deck: string): Promise<void> {
    const now = Date.now();
    try {
      // Derived from the platform cap, not hand-written. NOTE WHAT IS DIFFERENT HERE: stemview has
      // a client-side clamp (Deck.ts caps the bucket COUNT), so its bound can be derived DOWN from
      // this record budget and the two can be proven to agree. LYRICS HAVE NO SUCH CLAMP — nothing
      // in the client bounds a word list — so this cap is the ONLY thing bounding the record, and
      // an over-long track's captions simply stop persisting. That absence is a finding, not an
      // oversight of this line: there is no ceiling in the code to derive one from.
      // ★ AND IT SAYS SO WHEN IT REFUSES. This returned in silence, which is the same defect the
      // snapshot had (ddf28822): captions keep relaying perfectly from memory while disk holds an
      // older set, so nothing looks wrong until a cold restart serves stale captions or none.
      //
      // MEASURED against real synced lyrics from the source the client itself uses (LRCLIB), built
      // into the exact shape this record persists — BOTH DECKS UNDER ONE KEY:
      //   Bohemian Rhapsody   372 words   16.3 KB      One More Time  383 words  19.6 KB
      //   Rap God            1542 words   64.3 KB   ← a real track, 49.1% of the cap on ONE deck
      //   Rap God on both decks          128.6 KB   ← 98.1% of the cap, and it PASSES
      // Mean 45.6 bytes per word. So the realistic worst case is not a determined user, it is a
      // hip-hop set — and it currently fits, with about 2.4 KB to spare. That margin is the whole
      // finding: nothing in the client bounds a word list, real per-word timings are wordier than
      // the uniform ones measured here, and a longer or denser track walks straight through it.
      // ★ ONE DECK, ONE KEY, ONE BUDGET. This measured the WHOLE record and wrote the WHOLE record,
      // so a wordy track on deck A could stop deck B's captions reaching disk — two decks sharing
      // one cap with no relationship to each other. Per deck, the worst real case Deckard measured
      // (Rap God, 64.3 KB) has 2.0x headroom instead of 1.02x.
      const entry = this.lastLyrics[deck];
      if (!entry) return; // nothing to write for this deck
      const bytes = JSON.stringify(entry).length;
      if (bytes > DO_VALUE_CAP) {
        if (now - this.lyricTooBigAt >= 60_000) {
          this.lyricTooBigAt = now;
          console.warn(
            `[htl-room] lyrics NOT persisted for deck ${deck} (${bytes} bytes, cap ${DO_VALUE_CAP}): ` +
              `captions are served from memory and a cold restart will serve OLDER captions or none for that deck —`,
          );
        }
        return;
      }
      await this.state.storage.put(`lyrics:${deck}`, entry);
      // The legacy record is retired only AFTER a split key has landed, so a migration interrupted
      // between the two leaves the old value intact and the next boot simply migrates again.
      if (this.lyricsNeedSplit) {
        const other = deck === "A" ? "B" : "A";
        if (this.lastLyrics[other]) await this.state.storage.put(`lyrics:${other}`, this.lastLyrics[other]);
        await this.state.storage.delete("lyrics");
        this.lyricsNeedSplit = false;
      }
      this.lyricTooBigAt = 0; // a write landed → the next failure is news, not a repeat
    } catch {
      /* best-effort — never tear down a socket over a persist */
    }
  }

  // ★ LEADING WRITE NOW, TRAILING WRITE AT THE WINDOW'S END (operator, 2026-11-11: session sync
  // audit). At most one write per key per PERSIST_MIN_MS, and the LAST value inside a window always
  // reaches disk: `write` reads the in-memory record when it runs, so the trailing write carries the
  // newest value whatever arrived in between. The leading write is awaited (callers and tests see it
  // land in the same turn); the trailing one is fire-and-forget and best-effort like every persist.
  private async throttledPersist(key: string, write: () => Promise<void>): Promise<void> {
    const now = Date.now();
    const last = this.persistAt.get(key) ?? 0;
    if (this.persistTimers.has(key)) return; // a trailing write is armed and will carry this value
    if (now - last >= DjRoom.PERSIST_MIN_MS) {
      this.persistAt.set(key, now);
      await write();
      return;
    }
    this.persistTimers.set(
      key,
      setTimeout(() => {
        this.persistTimers.delete(key);
        this.persistAt.set(key, Date.now());
        void write().catch(() => {});
      }, last + DjRoom.PERSIST_MIN_MS - now),
    );
  }

  private async writeSnapshot(): Promise<void> {
    const snapshot = this.lastSnapshot;
    try {
      await this.state.storage.put("snapshot", snapshot);
      this.snapTooBigAt = 0;
    } catch (e) {
      // ★ SAY SO. The catch is right — a persist must never cost a socket — but it was
      // SILENT, and the failure it swallows is invisible from the outside: the board keeps
      // relaying perfectly from memory while disk holds an older one, so the room looks
      // healthy right up until a cold restart serves the stale board. Measured (ddf28822):
      // a two-deck board is ~2.6 KB plus ~1.7 KB per stem chain per deck, so reaching the
      // 128 KiB value cap takes about 39 chains on a deck — not normal use, and NOTHING in
      // the client bounds chain count. Throttled to once a minute per room: the publish
      // that fails will fail again in ten seconds and a log nobody can read is as useless
      // as no log.
      const now = Date.now();
      const bytes = JSON.stringify(snapshot ?? null).length;
      if (now - this.snapTooBigAt >= 60_000) {
        this.snapTooBigAt = now;
        console.warn(
          `[htl-room] snapshot NOT persisted (${bytes} bytes, cap ${DO_VALUE_CAP}): the live board is served from memory and a cold restart will serve an OLDER one —`,
          e,
        );
      }
    }
  }

  private async writeAutomix(): Promise<void> {
    try {
      await this.state.storage.put("automix", this.lastAutomix);
    } catch {
      /* best-effort — an oversized queue stays in memory; never tear down a socket over a persist */
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // D2: a relay shard reporting its listener count (DO-to-DO). Aggregate → refresh presence.
    if (url.pathname === "/internal/relay-count") {
      const idx = Number(url.searchParams.get("idx")) || 0;
      const count = Math.max(0, Number(url.searchParams.get("count")) || 0);
      this.relayCounts.set(idx, count);
      await this.load();
      this.broadcastPresence();
      return new Response(null, { status: 204 });
    }
    // The AUTHORITATIVE live listener count (L4 anti-sybil). The directory announce reads it
    // straight from the DO instead of trusting the host client's self-reported number, which a
    // tampered client could inflate to climb Discover / the follows-are-live ranking.
    if (url.pathname === "/internal/count") {
      await this.load();
      return new Response(JSON.stringify({ listeners: this.listenerCount(), public: this.isPublic }), {
        headers: { "content-type": "application/json" },
      });
    }
    // Is a given ACCOUNT a JOINED participant of this room? Lets the Worker authorize a session
    // GUEST fetching the HOST's global sample clip (#48) without making the clip public. The acct is
    // un-forgeable (the Worker stamps it on every socket from the authed session — roomState.ts).
    if (url.pathname === "/internal/ismember") {
      const acct = (url.searchParams.get("acct") || "").slice(0, 64);
      return new Response(JSON.stringify({ member: this.isAccountMember(acct) }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    await this.load();

    if (url.searchParams.get("rid")) this.roomHostId = url.searchParams.get("rid")!.slice(0, 64); // host account id → address relays
    const device = (url.searchParams.get("device") || "").slice(0, 64) || `anon-${this.seq++}`;
    const name = (url.searchParams.get("name") || "Guest").slice(0, 48);
    const kind = (url.searchParams.get("kind") || "Device").slice(0, 24);
    const host = url.searchParams.get("host") === "1"; // set by the Worker from the authed identity
    const pub = url.searchParams.get("pub") === "1"; // anon read-only listener (un-forgeable; the Worker sets it)
    const color = (url.searchParams.get("color") || "").slice(0, 9); // account accent (hex) for the room vibe
    const ev = Math.max(0, Math.min(9999, Number(url.searchParams.get("ev")) || 0)); // reconstruction-engine version (D5)
    const follows = url.searchParams.get("fol") === "1"; // this account follows the host (Worker-resolved, un-forgeable)
    const acct = (url.searchParams.get("acct") || "").slice(0, 64); // this device's account id (server-only; mention attribution)
    const invited = url.searchParams.get("invited") === "1"; // a push-invite grant was consumed → auto-admit (Worker-set, un-forgeable)
    if (!this.origin) {
      this.origin = url.origin; // base for the notify/presence bridge (same Worker)
      void this.state.storage.put("origin", this.origin); // survive eviction (presence alarm needs it)
    }

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
    if (pub && this.listenerCount() >= DjRoom.MAX_LISTENERS && this.sockets(device).length === 0) {
      // At capacity (E10). A rejected WS upgrade gives the browser no readable reason, so accept
      // the socket just long enough to TELL the listener why + close with a terminal code (4003)
      // the client won't reconnect into — instead of a silent retry storm.
      const full = new WebSocketPair();
      this.state.acceptWebSocket(full[1], [device]);
      try {
        full[1].send(JSON.stringify({ t: "kicked", reason: "This room is full — try again soon." } satisfies ServerMsg));
      } catch {
        /* socket already gone */
      }
      full[1].close(4003, "room full");
      return new Response(null, { status: 101, webSocket: full[0] } as unknown as ResponseInit);
    }

    // A device reconnecting replaces its stale socket(s) — keep one per device.
    // ★ 4004, NOT 1000 (operator, 2026-11-11: session sync audit). A duplicated browser tab shares
    // its device id, and 'replaced' with a normal close made the two tabs kick each other forever. A
    // 4xxx code is terminal to the client: the tab that was replaced stops and says so, instead of
    // reconnecting into the other. The replaced socket is dead to this room from this moment, so a
    // half-open one can never make the new socket's own close look like a stale duplicate.
    let replacedAnchor: boolean | null = null; // null = not the anchor; else whether it is a host's
    for (const old of this.sockets(device)) {
      if (device === this.anchorId) replacedAnchor = !!(old.deserializeAttachment() as Attachment | null)?.host || !!replacedAnchor;
      this.dead.add(old);
      try {
        old.close(4004, "replaced");
      } catch {
        /* already gone */
      }
    }
    // ★ THE GAP BETWEEN A REPLACED SOCKET AND ITS JOIN. The new socket starts un-joined, and the next
    // settle from anyone else read that as a vacant slot and took it. Hold the slot for the device
    // while it rejoins; the grace timer hands it on only if the join never comes.
    if (replacedAnchor !== null) this.scheduleAnchorGrace(device, DjRoom.HOST_HANDOVER_GRACE_MS, replacedAnchor);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Non-pub connect = PRESENT only, both switches off; flipping either (or an invite/
    // reconnect auto-engaging) puts the device in, and a host-granted device keeps its
    // drive right across a refresh (#10). A PUBLIC listener skips the knock entirely:
    // straight into listen-only, never controlling, never anchor, not in the roster.
    const granted = this.grants.has(device);
    const att: Attachment = pub
      ? { device, name, kind, host: false, joined: true, listening: true, pending: false, pub: true, decks: "", stageReq: "", stage: false, joinedAt: Date.now(), color, ev, follows, acct, invited: false }
      : { device, name, kind, host, joined: false, listening: false, pending: false, pub: false, decks: granted ? "AB" : "", stageReq: "", stage: false, joinedAt: 0, color, ev, follows, acct, invited };
    server.serializeAttachment(att);
    this.state.acceptWebSocket(server, [device]);

    // ★ WHO ACTUALLY TUNED IN, named. A pub socket exists ONLY after a tune-in: the client sets
    // `room=<handle>` only when listenHandle is set (client.ts:385), and the Worker turns that into
    // pub=1. So this line is the unambiguous server-side witness that a listener arrived — and it
    // names the DEVICE, which is what separates "my automation tuned in" from "a tab I left open
    // an hour ago reconnected". Browser-side evidence could not make that distinction (thread
    // d4a56d30: a click that hit a lyric, and a tab that had never reloaded, both read as success).
    if (pub) console.warn(`[htl-room] listener tuned in: device=${device} listeners=${this.listenerCount()}`);
    server.send(JSON.stringify(welcomeFor(device, this.roomView(), pub, this.songRequests.list)));
    this.sendChatHistory(server); // recent chat backlog so a joiner has context
    // Hand a public listener the current board immediately so it can render without a round-trip.
    if (pub) this.sendCatchUp(server, "connect:pub");
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
    if (this.dead.has(ws)) return; // a replaced / evicted socket speaks for nobody any more
    // ★ Liveness bookkeeping (operator, 2026-11-11: session sync audit): any inbound message proves
    // this socket alive. The anchor's own ticks re-arm the silence check; anyone else's message is a
    // free moment to audit the anchor (followers ping every 5 s, so a frozen anchor is noticed even
    // after a wake from hibernation lost the timer).
    const seenAt = Date.now();
    this.lastSeen.set(ws, seenAt);
    if (self === this.anchorId) this.armSilenceCheck();
    else await this.auditAnchor(seenAt);

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
        if (aj.host || this.approved.has(self) || aj.invited) {
          this.patch(ws, { joined: true, pending: false, joinedAt: aj.joinedAt || Date.now() });
          // ★ AN INVITE ADMITS FOR GOOD, NOT ONCE (operator, 2026-11-11: session sync audit). The
          // Worker consumes the push-invite grant on first use, so `invited` is true on exactly one
          // connect; every reconnect after it came back as a knock. Admission is recorded the same
          // way the host's own approve records it, and cleared the same way (deny/kick/ban).
          if (aj.invited && !aj.host && !this.approved.has(self)) {
            this.approved.add(self);
            await this.saveApproved();
          }
          // Tell the socket its join has landed — it holds its intents until it hears this.
          this.ack(ws);
          // ★ HAND THE JOINER THE BOARD, exactly as "approve" does one case below. Only two paths
          // used to: a PUBLIC listener at connect, and a guest at the moment the host approves it.
          // Everyone arriving through THIS door — an already-approved guest returning after a
          // refresh, an invited friend auto-joining, the host's own second device — got `welcome`
          // and `role` and no snapshot at all, so their decks kept whatever they already held until
          // the host happened to publish again. That is "a listener does not adopt the host's board"
          // (thread d4a56d30) for every re-entry, and it is why approve's own comment exists: the
          // display should fill in without waiting on a round-trip. Idempotent — a snapshot the
          // client already has applies to the same state.
          this.sendCatchUp(ws, "join");
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
        // ★ A PERSISTED GRANT IS AN ANSWER, NOT A REFUSAL (operator, 2026-11-11: session sync audit).
        // A granted guest's client re-asserts control(true) on every welcome; the grant had already
        // survived the reconnect, yet each one drew "Only the host can hand you the decks".
        if (msg.on && !a.host && !this.grants.has(self)) {
          // A guest can't self-grant — tell them so instead of silently dropping it (bug #10).
          ws.send(JSON.stringify({ t: "error", message: "Only the host can hand you the decks." } satisfies ServerMsg));
          break;
        }
        // A host's own drive = FULL control (both decks); off clears the permission.
        this.patch(ws, { decks: msg.on ? "AB" : "" }); // `controlling` is derived from `decks` now — one field, nothing to keep in step
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
        if (!target) break;
        // A host grant = FULL control (both decks), same as a host's own drive.
        for (const t of this.sockets(target)) this.patch(t, { decks: msg.on ? "AB" : "" });
        if (msg.on) this.grants.add(target);
        else this.grants.delete(target);
        await this.saveGrants();
        // ★ A GRANT AIMED AT A DEVICE MID-RECONNECT IS KEPT (operator, 2026-11-11: session sync
        // audit). It was dropped in silence when the target was not live + joined at that instant;
        // it is now stored, and fetch() applies it ("granted") when that device's socket arrives.
        if (this.isLive(target) && this.isJoined(target)) await this.settle(target);
        else this.broadcastPresence();
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
        for (const t of this.sockets(target)) {
          this.patch(t, { joined: true, pending: false, listening: true, joinedAt: Date.now() });
          this.ack(t); // the knock has become a join — release whatever the guest queued
          // Hand the freshly-approved guest the current board immediately — the snapshot
          // (decks/stems/controls) + the host's stem envelopes — so its display + mixer
          // fill in without waiting on a client-side request round-trip.
          this.sendCatchUp(t, "approve");
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
        for (const t of this.sockets(target)) this.refuseStage(t, "The host didn't bring you up.");
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
        // Followers-only chat (uses the Worker-resolved follow flag on the attachment — the DO
        // has no DB). The host and stage performers are always allowed; everyone else must follow.
        if (this.chatFollowers && !(a.host || a.stage || a.follows)) {
          ws.send(JSON.stringify({ t: "error", message: "Followers-only chat — follow the host to join in." } satisfies ServerMsg));
          break;
        }
        const r = this.chat.post(self, a.name, msg.text, this.chatSlow);
        if (r.ok) {
          this.broadcast({ t: "chat", msg: r.msg });
          this.bridgeMentions(r.msg.text, a.acct); // notify any @mentioned accounts (Slice 7)
        } else if (r.error) {
          ws.send(JSON.stringify({ t: "error", message: r.error } satisfies ServerMsg));
        }
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
      case "chat-followers": {
        // HOST toggles followers-only chat. Persisted; rides presence so every client reflects it.
        if (!this.isHostDevice(self)) break;
        const on = !!msg.on;
        if (on === this.chatFollowers) break;
        this.chatFollowers = on;
        await this.state.storage.put("chatFollowers", on);
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
        for (const w of this.sockets(to)) {
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
        this.patch(ws, { listening: false, joined: false, decks: "", stage: false, stageReq: "" });
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
        // ★ A REFUSAL IS ANSWERED (operator, 2026-11-11: session sync audit): the sender already
        // applied the move locally, so a silent drop left its board quietly different from the room.
        if (!this.canDrive(self, msg.intent)) {
          this.refuse(ws, msg.intent, this.refusalReason(self, msg.intent));
          break;
        }
        // ★ AND AUTOMIX IS HOST ONLY ON TOP OF THAT (ruling 34075fae). canDriveIntent refuses this
        // intent today only because it carries no `deck` and a deck-less move needs BOTH — which is
        // the right answer for the wrong reason, and it ADMITS a granted guest holding "AB". The
        // host bit is not expressible in canDriveIntent, whose whole input is a decks string, so the
        // extra condition lives here beside the attachment that owns it rather than corrupting the
        // shared pure rule with a field it cannot see.
        if (msg.intent.kind === "automix" && !this.isHostDevice(self)) {
          this.refuse(ws, msg.intent, "Only the host drives the auto-DJ.");
          break;
        }
        // `at` (the sender's room-clock moment) rides through untouched: receivers carry a landed
        // position across the transit with it.
        const out = { t: "intent", from: self, seq: ++this.seq, intent: msg.intent, ...(typeof msg.at === "number" && Number.isFinite(msg.at) ? { at: msg.at } : {}) } satisfies ServerMsg;
        // WRITERS + invited guests get EVERY intent immediately (instant mixing feel; they
        // may be driving / mirroring the platter). skipListeners=true → non-pub only.
        this.relay(self, out, true);
        // The LISTENER crowd (digest roll-up): LISTENER_DROP_KINDS never reach them — jog because
        // it is gestural, the stem request/ack pair because they are addressed to one device (see
        // the set's comment). Continuous SWEEPS
        // are coalesced (~20Hz, last value per control) so a rack of FX sweeps doesn't fan
        // out at input rate. Everything else (load/cue/loop/transport/hotcue/sync/fxRack/…)
        // passes straight through.
        const kind = msg.intent.kind;
        if (DjRoom.LISTENER_DROP_KINDS.has(kind)) break;
        if (DjRoom.COALESCE_KINDS.has(kind)) this.queueDigest(msg.intent, out);
        else {
          // ★ FLUSH THE HELD SWEEPS FIRST (operator, 2026-11-11: session sync audit). A sweep waits
          // up to DIGEST_FLUSH_MS while a discrete intent went out at once, so a listener could get
          // fxRack's reorder BEFORE the fxParam that preceded it (landing on the wrong slot), or a
          // load before the crossfade that came first. Order is kept by sending what is held now.
          this.flushDigest();
          this.relayToListeners(out);
        }
        break;
      }
      case "ping": {
        // Clock sync (src/htl/room/clockSync.ts): answer at once with the server clock, to this
        // socket only. Any device may ask; it costs one small message per ask.
        if (typeof msg.c === "number") ws.send(JSON.stringify({ t: "pong", c: msg.c, s: Date.now() } satisfies ServerMsg));
        break;
      }
      case "tick": {
        // Only the anchor's clock ticks (one reference playhead).
        if (self === this.anchorId) this.relay(self, { t: "tick", decks: msg.decks });
        break;
      }
      case "state": {
        // ★ A DROPPED PUBLISH IS THE ONE THAT NEEDS SAYING SO. If the publisher is not the anchor
        // and the slot is not vacant, this snapshot is discarded in silence — and nothing asks for a
        // republish, so the room keeps whatever the previous session left and EVERY later joiner
        // adopts that instead of the host's real board. That is the leading hypothesis for
        // "a listener does not adopt the host's board" (thread d4a56d30), and it was unobservable:
        // the counter next to it (stemViewDropped) has no reader anywhere in the codebase, so
        // another silent tally would answer nobody. A log line is readable from `wrangler tail` and
        // from the dev worker's own output, which is where the live two-party rig can catch it.
        // Rate-limited, because a publisher that keeps trying must not become the log.
        if (!(self === this.anchorId || this.anchorId === null)) {
          const now = Date.now();
          if (now - this.stateDropAt >= DjRoom.STATE_DROP_LOG_MS) {
            this.stateDropAt = now;
            console.warn(
              `[htl-room] state publish DROPPED: publisher=${self} anchor=${this.anchorId ?? "none"} — ` +
                `the room keeps its previous snapshot and joiners will adopt that (thread d4a56d30)`,
            );
          }
        }
        // The anchor (or, while vacant, anyone) defines the authoritative set.
        if (self === this.anchorId || this.anchorId === null) {
          // ★ AND AN ACCEPTED ONE SAYS SO TOO. Logging only the DROP made silence ambiguous: it
          // could mean "published and accepted" or "never published at all", which are opposite
          // diagnoses with the same evidence (thread d4a56d30 — the rig read a silent log as health
          // when the client's publish effect had simply never run). The FINGERPRINT is what the
          // snapshot actually carries, because the third case is "accepted, but the content is
          // stale", and a line that only said "accepted" could not tell that one either.
          // ★ RATE-LIMIT THE REPEATS, NEVER THE CHANGES. The first version throttled this line by
          // TIME alone, which quietly rebuilt the ambiguity it was added to remove: a host that
          // publishes an empty board and then the real one ~1 s later showed only the empty line,
          // and the silence after it could mean "never republished" or "republished inside the
          // window" — opposite diagnoses again (Deckard nearly read it the first way; only the
          // listener's catch-up CONTENT settled it). A publish whose fingerprint DIFFERS from the
          // last one is news and always prints; only an identical repeat is throttled.
          const now0 = Date.now();
          const fp = DjRoom.snapshotFingerprint(msg.snapshot);
          if (fp !== this.stateOkFp || now0 - this.stateOkAt >= DjRoom.STATE_DROP_LOG_MS) {
            this.stateOkAt = now0;
            this.stateOkFp = fp;
            console.warn(`[htl-room] state publish accepted: publisher=${self} ${fp}`);
          }
          this.lastSnapshot = msg.snapshot;
          this.relay(self, { t: "state", snapshot: msg.snapshot });
          // Persist THROTTLED + best-effort — the in-memory copy above already serves live relay
          // and catch-up; disk is just the cold-restart fallback, so one write per PERSIST_MIN_MS
          // is plenty (was: a write on EVERY control change, which blew the free-tier write cap).
          // ★ THROTTLED, BUT WITH A TRAILING WRITE (operator, 2026-11-11: session sync audit). The
          // throttle used to DROP every publish inside the window, so the board on disk was whatever
          // came first in it and a wake from hibernation served that older board. The last publish
          // in a window now lands at the window's end — still at most one write per PERSIST_MIN_MS,
          // which keeps the anchor's republish heartbeat inside the storage write budget.
          await this.throttledPersist("snapshot", () => this.writeSnapshot());
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
          // ★ ONE THRESHOLD, DERIVED, GOVERNING RELAY AND CACHE TOGETHER. This was a hand-written
          // 400_000 — a number encoding something the CLIENT owns (how big an envelope
          // extractStemView can produce, set by its bucket clamp). MAX_STEMVIEW_BYTES derives that
          // from the clamp itself, so the two cannot drift.
          // It governs BOTH because the same `if` admits to lastStemView, and lastStemView is
          // replayed by sendCatchUp to every arrival forever with no rate limit — so one frame
          // passing this gate once sets a per-arrival tax on everyone after it. Splitting the
          // threshold (cache small, relay large) would institutionalise a band of sizes where an
          // arrival's view permanently differs from a live peer's, invisibly to both.
          // FAILS CLOSED on purpose: an over-large envelope is dropped for everyone, so a remote
          // waveform goes visibly ABSENT and gets reported — where a stale same-song envelope is
          // silently WRONG and never does. See stemViewBudget.ts for the two-phase deploy rule.
          // ★ AND SAY SO. This used to only increment stemViewDropped, a counter NOTHING in this
          // codebase reads — so the one failure this gate's own comment calls "visibly ABSENT and
          // reported" was, on the server side, invisible. The count is still kept (it is the cheap
          // aggregate); the line is what makes a missing remote waveform diagnosable from a log
          // instead of from a user saying a lane looked empty. Rate-limited like the others: a
          // client republishing an oversized envelope must not become the log.
          if (size > MAX_STEMVIEW_BYTES) {
            this.stemViewDropped++;
            if (now - this.stemViewDropAt >= DjRoom.STATE_DROP_LOG_MS) {
              this.stemViewDropAt = now;
              console.warn(
                `[htl-room] stemview DROPPED (too large): device=${self} deck=${msg.deck} bytes=${size} cap=${MAX_STEMVIEW_BYTES} dropped=${this.stemViewDropped} — that deck's remote lanes stay empty`,
              );
            }
          }
          // ★ A NEW TRACK IS NEVER "TOO SOON", AND A THROTTLED FRAME IS DEFERRED, NOT DROPPED
          // (operator, 2026-11-11: session sync audit). A deck loaded within 2 s of its previous
          // envelope had the NEW track's envelope thrown away and the OLD one kept in the cache, so
          // every remote and every later arrival drew the wrong song's lanes. A frame for a different
          // track is admitted at once; a same-track repeat inside the window is held and the latest
          // one lands when the window ends (trailing-latest), so the cache always ends on the newest.
          const newTrack = DjRoom.stemViewVid(msg.view) !== DjRoom.stemViewVid(this.lastStemView[msg.deck]);
          if (size <= MAX_STEMVIEW_BYTES && (!tooSoon || newTrack)) {
            this.clearStemViewPending(msg.deck);
            this.admitStemView(self, msg.deck, msg.view, rk, now);
          } else if (size <= MAX_STEMVIEW_BYTES) {
            this.deferStemView(self, msg.deck, msg.view, rk, now);
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
          // COALESCE THE RELAY, not just the disk write. Measured on a two-party local run:
          // 4,090 inbound lyrics frames in 24.8 s — 165/s at ~18 KB each, 70 MB, 99% of ALL room
          // traffic. The caption payload is last-value-wins state (the line above overwrites
          // lastLyrics wholesale), so re-sending it at input rate buys nothing and on a phone over
          // 4G saturates the link by itself.
          // The write-throttle directly below this handler already learned exactly this lesson for
          // STORAGE (PERSIST_MIN_MS, after a busy session blew the free-tier daily write cap) and
          // it was never applied to the WIRE — the same knowledge in two layers with one updated.
          // Throttled rather than deduped on purpose: a dedupe has to decide whether two payloads
          // are "the same", and a re-resolution with better timings is a real change that a cheap
          // signature could drop forever. Last-value-wins with a trailing flush cannot lose the
          // final state, only the intermediate frames nobody can read at 165/s anyway.
          this.queueLyrics(msg.deck, { t: "lyrics", deck: msg.deck, videoId: msg.videoId, lines: msg.lines, source: msg.source }, self);
          void this.persistLyrics(msg.deck);
        }
        break;
      }
      case "automix": {
        // ★ HOST ONLY — operator ruling 34075fae, and this is the SECOND door to it. Metron's
        // 55c0028 took the client control and named the INTENT path; this is the state STREAM, and
        // it admitted two seats the ruling excludes. `isControlling` is drivesAnything(), so a
        // fully-granted guest holding "AB" passed it — the exact seat the operator called out
        // beyond my own lean. And `self === this.anchorId` admitted a NON-HOST anchor: the clock
        // preference is "a controlling DESKTOP › any controller › a host DESKTOP › …", so a granted
        // guest outranks a host for the anchor and would have carried the auto-DJ with it.
        //
        // `a.host` is set un-forgeably by the Worker (see the fan-out note below), which is why the
        // durable gate belongs here rather than on the surface — a client-side control is the thing
        // this session has spent its length removing.
        if (this.isHostDevice(self)) {
          this.lastAutomix = msg.state;
          this.relay(self, { t: "automix", state: msg.state });
          // ★ Persisted under the snapshot's rule (operator, 2026-11-11: session sync audit): it was
          // memory-only, so a wake from hibernation handed joiners no queue at all.
          await this.throttledPersist("automix", () => this.writeAutomix());
        }
        break;
      }
      case "request-state": {
        this.sendCatchUp(ws, "request-state");
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
    await this.socketGone(ws);
  }

  // ★ ONE PATH FOR "THIS SOCKET IS GONE" (operator, 2026-11-11: session sync audit): a real close, an
  // error, and a silent anchor the room gave up on all land here. The closing socket is marked dead
  // FIRST, so every lookup below (hasOtherSocket, nextAnchor, presence) excludes it explicitly — the
  // runtime may still list a closing socket, and presence used to carry the device that just left.
  private async socketGone(ws: Ws): Promise<void> {
    this.dead.add(ws);
    this.lastSeen.delete(ws);
    const dev = this.deviceOf(ws);
    const closing = ws.deserializeAttachment() as Attachment | null;
    // A reconnect REPLACES the old socket: if the device still has another live socket,
    // this close is just the stale one — ignore it (don't churn presence / the anchor).
    // Compared by SOCKET: a replaced half-open socket is dead already and never counts as "other".
    if (dev && this.hasOtherSocket(dev, ws)) return;
    // Social presence: if this was the LAST socket of a signed-in account here, that account may
    // have just gone offline. Don't decide now (a refresh would flap) — arm the alarm; it bridges
    // "offline" to the Worker only if they're still gone after the grace.
    if (closing?.acct && !this.acctHasLiveSocket(closing.acct, ws)) {
      await this.schedulePresenceOffline(closing.acct);
    }
    if (dev && dev === this.anchorId) await this.anchorLost(dev, !!closing?.host);
    else this.broadcastPresence();
  }

  // The anchor device has no live socket (or went silent). Who holds the clock now?
  //  • a GUEST anchor with someone else eligible → hand over at once (a guest is only a stand-in);
  //  • a HOST anchor with someone else eligible → hold the slot HOST_HANDOVER_GRACE_MS first, so a
  //    blip does not hand the board to a guest the host then has to adopt;
  //  • nobody else eligible → hold ANCHOR_GRACE_MS (the original blip grace), then release.
  // Presence goes out in every branch: the roster has lost a device either way.
  private async anchorLost(dev: string, wasHost: boolean): Promise<void> {
    const next = this.nextAnchor(dev);
    if (next && !wasHost) {
      await this.setAnchor(next); // another participant can hold the clock → hand over now
      return;
    }
    // Don't yank the clock on a momentary blip — that freezes the room AND flaps the anchor on
    // every reconnect. If the device comes back (same device id), it resumes ticking seamlessly.
    this.scheduleAnchorGrace(dev, next ? DjRoom.HOST_HANDOVER_GRACE_MS : DjRoom.ANCHOR_GRACE_MS, wasHost);
    this.broadcastPresence();
  }

  private scheduleAnchorGrace(droppedAnchor: string, ms: number = DjRoom.ANCHOR_GRACE_MS, host = false): void {
    if (this.anchorGraceTimer) {
      if (this.graceFor?.device === droppedAnchor) return; // already holding the slot for it
      clearTimeout(this.anchorGraceTimer);
    }
    this.graceFor = { device: droppedAnchor, host };
    this.anchorGraceTimer = setTimeout(async () => {
      this.anchorGraceTimer = null;
      this.graceFor = null;
      await this.load();
      // Back + live + joined → its reconnect already re-anchored; leave it.
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
    }, ms);
  }

  // Re-arm the silence check from the anchor's own traffic (4 ticks/s). One timer, reset per tick:
  // it only fires once the anchor has been quiet for the whole window.
  private armSilenceCheck(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      void this.auditAnchor(Date.now());
    }, DjRoom.ANCHOR_SILENT_MS + 250);
  }

  // Is the anchor still there? Two failures are caught here:
  //  • its device has NO live socket and nothing is holding the slot for it (a grace timer lost to a
  //    hibernation wake, say) → handle it as the close the room never saw;
  //  • its socket is open but SILENT past ANCHOR_SILENT_MS while others are connected → a half-open
  //    link or a suspended phone. Give up on that socket (close it so a live client reconnects) and
  //    handle it exactly like a close: grace for a host, then hand over.
  private async auditAnchor(now: number): Promise<void> {
    const dev = this.anchorId;
    if (!dev || this.anchorGraceTimer) return;
    const mine = this.sockets(dev);
    const others = this.sockets().some((w) => this.deviceOf(w) !== dev);
    if (!others) return;
    if (mine.length === 0) {
      await this.anchorLost(dev, this.graceFor?.host ?? false);
      return;
    }
    let newest = 0;
    for (const w of mine) {
      let seen = this.lastSeen.get(w);
      if (seen === undefined) this.lastSeen.set(w, (seen = now)); // no memory of it (a wake) → start the clock now
      newest = Math.max(newest, seen);
    }
    if (now - newest <= DjRoom.ANCHOR_SILENT_MS) return;
    const host = this.isHostDevice(dev);
    console.warn(`[htl-room] anchor ${dev} silent for ${now - newest} ms — treating it as gone`);
    for (const w of mine) {
      this.dead.add(w);
      try {
        w.close(1001, "silent"); // NOT terminal: a client that is alive after all reconnects + rejoins
      } catch {
        /* already gone */
      }
    }
    await this.anchorLost(dev, host);
  }

  // Is `acct` still attached here (any socket other than `except`)? An account may hold several
  // devices; presence is per-account, so the offline check is per-account, not per-device.
  private acctHasLiveSocket(acct: string, except?: Ws): boolean {
    for (const ws of this.sockets()) {
      if (except && ws === except) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.acct === acct) return true;
    }
    return false;
  }

  // Queue an account for an offline sweep and arm the alarm (if not already pending). The alarm
  // re-checks live sockets before bridging, so a quick reconnect cancels the offline. Inert if the
  // bridge isn't configured (no Worker origin / secret) — same posture as the mention bridge.
  private async schedulePresenceOffline(acct: string): Promise<void> {
    if (!this.notifySecret || !this.origin) return;
    const pending = (await this.state.storage.get<Record<string, number>>("presenceOff")) ?? {};
    pending[acct] = Date.now();
    await this.state.storage.put("presenceOff", pending);
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now() + DjRoom.PRESENCE_GRACE_MS);
    }
  }

  // The DO's first real storage alarm: sweep accounts whose last socket dropped and, for any STILL
  // gone, bridge "offline" to the Worker (which has D1). The Worker's write is LWW-guarded on the
  // close timestamp, so an account that reconnected on another DO can't be stomped offline.
  async alarm(): Promise<void> {
    await this.load();
    // Guard BEFORE the delete. Unreachable today (schedulePresenceOffline bails on the same
    // condition before it ever writes the key), but deleting a queue and then discovering you
    // cannot drain it loses it silently — and the only thing keeping that safe is a check in a
    // different method. Order it so the code is correct on its own terms.
    if (!this.notifySecret || !this.origin) return;
    const pending = (await this.state.storage.get<Record<string, number>>("presenceOff")) ?? {};
    await this.state.storage.delete("presenceOff");
    for (const [acct, closedAt] of Object.entries(pending)) {
      if (this.acctHasLiveSocket(acct)) continue; // reconnected here → still online, skip
      void fetch(`${this.origin}/internal/presence`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-htl-internal": this.notifySecret },
        body: JSON.stringify({ acct, closedAt }),
      }).catch(() => {});
    }
  }

  // End the public broadcast: clear the flag (persisted) + evict the anonymous crowd AND any
  // stage DJs they brought up, with a reason. Shared by the host's explicit stop and E7's
  // host-abandonment grace expiry.
  private async endBroadcast(reason: string): Promise<void> {
    this.isPublic = false;
    await this.state.storage.put("public", false);
    for (const w of this.sockets()) {
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
  /** The room's sockets (optionally one device's), minus the ones it has already given up on. Every
   *  lookup goes through here so a closing / replaced / silent-evicted socket is excluded everywhere. */
  private sockets(tag?: string): Ws[] {
    const all = tag === undefined ? this.state.getWebSockets() : this.state.getWebSockets(tag);
    return all.filter((w) => !this.dead.has(w));
  }

  /** Ack a processed join to that socket (it releases the intents it queued while re-joining). */
  private ack(ws: Ws): void {
    try {
      ws.send(JSON.stringify({ t: "joined" } satisfies ServerMsg));
    } catch {
      /* socket gone */
    }
  }

  /** Answer a refused intent, to the sender only, at most once a second per kind per socket. */
  private refuse(ws: Ws, intent: Intent, reason: string): void {
    const key = `${this.deviceOf(ws) ?? "?"}:${intent.kind}`;
    const now = Date.now();
    if (now - (this.refusedAt.get(key) ?? 0) < 1000) return;
    this.refusedAt.set(key, now);
    if (this.refusedAt.size > 256) this.refusedAt.clear(); // bounded; a lost throttle entry costs one extra frame
    try {
      ws.send(JSON.stringify({ t: "refused", kind: intent.kind, reason } satisfies ServerMsg));
    } catch {
      /* socket gone */
    }
  }

  /** Why canDrive said no, in words the sender can act on. */
  private refusalReason(device: string, intent: Intent): string {
    if (!this.isJoined(device)) return "You're not in the session yet — that move wasn't shared.";
    let decks = "";
    for (const w of this.sockets(device)) {
      const a = w.deserializeAttachment() as Attachment | null;
      if (a?.joined && a.decks.length > decks.length) decks = a.decks;
    }
    if (!decks) return "You don't have the decks — that move wasn't shared.";
    const deck = (intent as { deck?: unknown }).deck;
    if (deck === "A" || deck === "B") return `You only drive deck ${decks} — that move wasn't shared.`;
    return "That needs both decks — it wasn't shared.";
  }

  private deviceOf(ws: Ws): string | null {
    const a = ws.deserializeAttachment() as Attachment | null;
    return a?.device ?? null;
  }

  private isLive(device: string | null): boolean {
    return !!device && this.sockets(device).length > 0;
  }

  private isJoined(device: string): boolean {
    for (const ws of this.sockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.joined) return true;
    }
    return false;
  }

  // Membership by ACCOUNT (across that account's devices): any JOINED socket carrying this acct.
  // Used to authorize a session guest fetching the host's global sample (#48). "" acct → never.
  private isAccountMember(acct: string): boolean {
    if (!acct) return false;
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.joined && a.acct === acct) return true;
    }
    return false;
  }

  private isHostDevice(device: string): boolean {
    for (const ws of this.sockets(device)) {
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
    for (const ws of this.sockets(this.anchorId)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a) return a.ev || 0;
    }
    return 0;
  }

  // The room "vibe" colour = the anchor's account accent (or, failing that, any host device's).
  // Rides every welcome/presence so even a crowd LISTENER (no roster) inherits it.
  private hostColor(): string {
    if (this.anchorId) {
      for (const ws of this.sockets(this.anchorId)) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a?.color) return a.color;
      }
    }
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.host && a.color) return a.color;
    }
    return "";
  }

  // A phone/tablet (by its reported device kind). Used only to bias the clock toward a desktop.
  private isMobile(device: string | null): boolean {
    if (!device) return false;
    for (const ws of this.sockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && isMobileKind(a.kind)) return true;
    }
    return false;
  }

  private hasOtherSocket(device: string, except: Ws): boolean {
    for (const ws of this.sockets(device)) if (ws !== except) return true;
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
    // The held anchor came back and joined → the slot is its again; stop the grace timer.
    if (this.graceFor?.device === self && self === this.anchorId && this.isJoined(self) && this.anchorGraceTimer) {
      clearTimeout(this.anchorGraceTimer);
      this.anchorGraceTimer = null;
      this.graceFor = null;
    }
    const anchorActive = !!this.anchorId && this.isLive(this.anchorId) && this.isJoined(this.anchorId);
    const anchorControls = !!this.anchorId && this.isControlling(this.anchorId);
    const anchorIsHost = !!this.anchorId && this.isHostDevice(this.anchorId);
    // ★ A HELD SLOT IS NOT A VACANT ONE (operator, 2026-11-11: session sync audit). While a grace
    // timer holds the anchor for a device that dropped or is mid-rejoin, its absence used to read as
    // "no anchor" and the next joiner's settle took the slot. Only a HOST device may claim a held
    // slot (it is the owner); a guest may claim one held for another guest only after the grace.
    const held = !!this.graceFor && this.graceFor.device === this.anchorId && self !== this.anchorId;
    const heldAgainstSelf = held && !this.isHostDevice(self) && (this.graceFor!.host || this.isLive(this.anchorId));
    if (this.isJoined(self) && !anchorActive && !heldAgainstSelf) {
      await this.setAnchor(self);
    } else if (
      anchorActive && !anchorIsHost && this.isHostDevice(self) && this.isJoined(self) && self !== this.anchorId &&
      !this.isStage(this.anchorId)
    ) {
      // ★ THE OWNER RECLAIMS FROM ANY GUEST ANCHOR (operator, 2026-11-11: session sync audit). This
      // used to need the guest anchor to be idle (`!anchorControls`), so a host that blipped while a
      // granted guest drove came back to find the guest holding the clock and adopted the GUEST's
      // board. A guest anchor is only ever a stand-in for the host.
      await this.setAnchor(self);
    } else if (anchorActive && !anchorControls && !anchorIsHost && this.isControlling(self) && self !== this.anchorId) {
      // A driver took over from an idle GUEST anchor → make it the board's source of truth. Never
      // from a host device: the host's board is the room's, driven or not.
      await this.setAnchor(self);
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
    for (const ws of this.sockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.joined && drivesAnything(a)) return true;
    }
    return false;
  }

  // May this device drive THIS intent? Resolves the device's strongest deck permission across
  // its sockets and defers to the pure per-deck gate (canDriveIntent): the host/granted ("AB")
  // drive everything; a stepped-up listener drives only their one deck. Replaces the old
  // any-controller check on the hot intent path so a single-deck guest can't move the rest.
  private canDrive(device: string, intent: Intent): boolean {
    let decks = "";
    for (const ws of this.sockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.joined && drivesAnything(a) && a.decks.length > decks.length) decks = a.decks;
    }
    return canDriveIntent(decks, intent);
  }

  // Did this device step up from the broadcast floor? Stage devices drive a deck but must
  // NEVER hold the clock (the host/broadcast origin stays the anchor) — settle + nextAnchor
  // exclude them so a stepped-up phone can't become the room's playhead authority.
  private isStage(device: string | null): boolean {
    if (!device) return false;
    for (const ws of this.sockets(device)) {
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
    let hostCtrlDesktop: string | null = null;
    let hostCtrlAny: string | null = null;
    let hostDesktop: string | null = null;
    let hostAny: string | null = null;
    let anyJoined: string | null = null;
    for (const ws of this.sockets()) {
      if (ws === exceptWs) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a || !a.joined || a.device === except || a.pub || a.stage) continue; // a public listener / stepped-up guest never anchors
      const mobile = isMobileKind(a.kind);
      if (drivesAnything(a)) {
        if (!mobile && !ctrlDesktop) ctrlDesktop = a.device;
        if (!ctrlAny) ctrlAny = a.device;
        if (a.host && !mobile && !hostCtrlDesktop) hostCtrlDesktop = a.device;
        if (a.host && !hostCtrlAny) hostCtrlAny = a.device;
      }
      if (a.host) {
        if (!mobile && !hostDesktop) hostDesktop = a.device;
        if (!hostAny) hostAny = a.device;
      }
      if (!anyJoined) anyJoined = a.device;
    }
    // ★ HOST DEVICES FIRST (operator, 2026-11-11: session sync audit) — the same rule settle() now
    // enforces on a host's rejoin, applied at handover so the two cannot disagree: a guest only
    // holds the clock when no host device can. Within each side: a controlling DESKTOP › a desktop
    // (host) › any controller › anyone. Desktops outrank phones/tablets so the clock lands on the
    // natural DJ machine, not a phone that only happened to be the last one standing.
    return hostCtrlDesktop ?? hostDesktop ?? hostCtrlAny ?? hostAny ?? ctrlDesktop ?? ctrlAny ?? anyJoined;
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
    for (const ws of this.sockets(device)) {
      try {
        ws.send(JSON.stringify({ t: "kicked", reason } satisfies ServerMsg));
      } catch {
        /* socket already gone */
      }
      ws.close(4001, "removed");
      this.dead.add(ws); // excluded from presence + anchor choice now, not when the runtime gets round to it
    }
    if (device === this.anchorId) void this.setAnchor(this.nextAnchor(device));
    else this.broadcastPresence();
  }

  // Promote a floor listener onto a deck: out of the anonymous crowd, into the roster as a
  // real participant driving exactly that one deck. Shared by request-mode approval and the
  // open-mode instant grab. The socket is kept — we just rewrite the attachment.
  private async promoteToStage(device: string, deck: "A" | "B"): Promise<void> {
    let promoted = false;
    for (const t of this.sockets(device)) {
      const a = t.deserializeAttachment() as Attachment | null;
      if (!a?.pub) continue; // only a floor listener steps up
      this.patch(t, { pub: false, joined: true, listening: true, decks: deck, stage: true, stageReq: "", joinedAt: Date.now() });
      // Hand them the full board as a driver — they had only the curated digest as a listener.
      this.sendCatchUp(t, "stage-promote");
      promoted = true;
    }
    if (promoted) await this.settle(device); // stage devices never anchor — settle just re-broadcasts presence
  }

  // Is a deck currently held by a stepped-up (stage) DJ? Gates the open-mode grab so two
  // listeners can't seize the same deck. The host's own full control ("AB") doesn't count —
  // the host can always co-drive; this only blocks a second CROWD member on the same deck.
  private deckHeldByStage(deck: string): boolean {
    for (const ws of this.sockets()) {
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
    for (const ws of this.sockets(device)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      this.patch(ws, { pub: true, joined: true, listening: true, decks: "", stage: false, stageReq: "" });
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

  /** What a board snapshot IS, in one short line — the two decks' track ids. Enough to tell a stale
   *  cached board from a fresh one in a log, without printing a room's contents wholesale. */
  private static snapshotFingerprint(snap: unknown): string {
    const decks = (snap as { decks?: Record<string, { videoId?: string | null } | undefined> } | null)?.decks;
    const at = (d: string) => decks?.[d]?.videoId ?? "—";
    return `A=${at("A")} B=${at("B")}`;
  }

  private sendCatchUp(ws: Ws, why = "?"): void {
    // ★ SAY WHAT WAS SERVED, TO WHOM, AND WHY. "The listener adopted a stale board" and "the
    // listener was served nothing" look identical from the client, and both produce a device still
    // showing its own tracks. The DEVICE and the REASON are here because the first live run printed
    // seventeen of these against ONE tune-in (thread d4a56d30): five call sites reach this, one of
    // them a client-driven `request-state` that nothing rate-limits, so an unlabelled line could not
    // say whether that was five devices arriving or one socket being re-served sixteen times — and
    // those are different problems, one of them a fan-out cost that scales with the crowd.
    // ★ AND SAY WHAT IT COST. Catch-up is the most expensive thing this room does per arrival —
    // the board, the automix state, BOTH stem envelopes and BOTH lyric sets — and 3e2e6d6 added a
    // fifth caller by giving every `join` one, which was right (a joiner with no board is the bug it
    // fixed) but not free. The size is a fact nobody had: it scales with the crowd, it is paid on
    // every arrival AND on every client-driven request-state, and a stem envelope alone can run to
    // tens of KB. Measured here rather than estimated, so a deploy decision has a number under it.
    let bytes = 0;
    const serve = (msg: ServerMsg): void => {
      const body = JSON.stringify(msg);
      bytes += body.length;
      ws.send(body);
    };
    if (this.lastSnapshot !== undefined) serve({ t: "state", snapshot: this.lastSnapshot });
    if (this.lastAutomix !== undefined) serve({ t: "automix", state: this.lastAutomix });
    for (const d of ["A", "B"] as const) {
      if (this.lastStemView[d] !== undefined) serve({ t: "stemview", deck: d, view: this.lastStemView[d] });
      const ly = this.lastLyrics[d];
      if (ly) serve({ t: "lyrics", deck: d, videoId: ly.videoId, lines: ly.lines, source: ly.source });
    }
    console.warn(
      `[htl-room] catch-up served: device=${this.deviceOf(ws) ?? "?"} why=${why} bytes=${bytes} ${this.lastSnapshot === undefined ? "NO SNAPSHOT (the room has never held one)" : DjRoom.snapshotFingerprint(this.lastSnapshot)}`,
    );
  }

  // Count of distinct anonymous read-only (public) listeners — the crowd surfaced as
  // a number, never an individual roster entry (privacy + fan-out cost at scale).
  private listenerCount(): number {
    // D2: with the relay tier on, the crowd lives on the shards — sum their reported counts.
    if (this.relayOn) {
      let total = 0;
      for (const c of this.relayCounts.values()) total += c;
      return total;
    }
    const seen = new Set<string>();
    for (const ws of this.sockets()) {
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
    for (const ws of this.sockets()) {
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
    for (const ws of this.sockets()) {
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
      chatFollowers: this.chatFollowers,
      muted: [...this.muted],
      engineVersion: this.engineVersion(),
      hostColor: this.hostColor(),
    };
  }

  private async setAnchor(device: string | null, except?: Ws): Promise<void> {
    // No-op if the anchor isn't actually changing — skip the storage write AND the role broadcast.
    // (A reconnect storm can call this repeatedly with the same device; each used to write a row.)
    if (device === this.anchorId) {
      this.broadcastPresence(except);
      return;
    }
    // ★ WHO HOLDS THE SLOT, every time it moves. `state` is accepted only from the anchor, so a
    // publish that never happens and a publish refused by a slot the client does not know it lacks
    // are the same silence on the client side. This line is the other half of that question.
    console.warn(`[htl-room] anchor: ${this.anchorId ?? "none"} -> ${device ?? "none"}`);
    this.anchorId = device;
    // A new anchor gets a full silence window from NOW: as a follower it only pinged every 5 s, so
    // its last message can already be older than ANCHOR_SILENT_MS at the moment it takes the slot.
    if (device) {
      const now = Date.now();
      for (const w of this.sockets(device)) this.lastSeen.set(w, now);
      this.armSilenceCheck();
    }
    await this.state.storage.put("anchor", device);
    // ★ ASK THE NEW ANCHOR WHAT IS ON ITS BOARD. `state` is accepted only from the anchor, so a
    // publish this device made a moment before the slot arrived was DROPPED here in silence, and
    // nothing has ever asked for it again — the room then serves that staleness to every later
    // joiner. Measured window: a host's first ~4 s (thread d4a56d30). Idempotent and cheap: the
    // client answers with the snapshot it already holds, or stays quiet if it has never published.
    if (device) for (const t of this.sockets(device)) t.send(JSON.stringify({ t: "republish" } satisfies ServerMsg));
    this.broadcast({ t: "role", anchorId: device }, except);
    // ★ THE SHARDED CROWD HEARS IT TOO (operator, 2026-11-11: session sync audit). `role` was a
    // local broadcast only, so a listener on a relay shard kept the old anchor id forever (its
    // follower logic keys on it). `republish` stays local: it is addressed to the new anchor, which
    // is never a relay listener.
    this.pushToRelays({ t: "role", anchorId: device });
    this.broadcastPresence(except);
  }

  // The ONE fan-out primitive: stringify once, send to every socket whose attachment passes
  // `pred`. A dead socket is skipped, never thrown out of (the inconsistency the old
  // hand-rolled loops had — some try/caught, some didn't). Every relay/broadcast helper below
  // is just a named predicate over this, so "who receives what" reads in one line each.
  private sendTo(pred: (a: Attachment | null, ws: Ws) => boolean, msg: ServerMsg): void {
    const json = JSON.stringify(msg);
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!pred(a, ws)) continue;
      try {
        ws.send(json);
      } catch {
        /* socket gone — skip it, never break the fan-out */
      }
    }
  }

  // Notify any accounts @mentioned in a chat line. The DB-less DO can't write a notification,
  // so it bridges the event back to the Worker (which has D1). Best-effort + fire-and-forget +
  // secret-guarded; deduped and capped so one line can't fan out a storm. Inert if the sender is
  // anon (no acct) or the bridge secret isn't configured. The Worker enforces blocks + no-self.
  private bridgeMentions(text: string, actorId: string): void {
    if (!this.notifySecret || !this.origin || !actorId) return;
    const handles = new Set<string>();
    for (const m of text.matchAll(/@([a-z0-9_]{3,20})/gi)) {
      handles.add(m[1].toLowerCase());
      if (handles.size >= 3) break; // cap the per-line fan-out
    }
    for (const h of handles) {
      void fetch(`${this.origin}/internal/notify`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-htl-internal": this.notifySecret },
        body: JSON.stringify({ toHandle: h, actorId, kind: "mention" }),
      }).catch(() => {});
    }
  }

  // Relay to everyone except the sender. `skipListeners` omits the anonymous read-only
  // (public) crowd — used for gestural messages they can't reconstruct (see the jog case).
  private relay(from: string, msg: ServerMsg, skipListeners = false): void {
    if (!skipListeners) this.pushToRelays(msg); // D2: the crowd's copy goes to the shards
    this.sendTo((a) => (a?.device ?? null) !== from && !(skipListeners && a?.pub), msg);
  }

  // Send ONLY to the anonymous read-only (public) listener crowd. The digest path uses this.
  // D2: push ONE crowd frame to every relay shard (O(R)); each shard fans out to its slice
  // (O(N/R)). Fire-and-forget — a slow/dead relay never stalls the master's tick loop. No-op
  // when the relay tier is off (the local sendTo paths handle the crowd then).
  // ★ IN ORDER, PER SHARD (operator, 2026-11-11: session sync audit). Each frame used to be its own
  // fire-and-forget fetch, and independent fetches carry no ordering guarantee — but a relay
  // listener APPLIES what it is pushed (load, transport, loop, fxRack…: order-sensitive), so a
  // crossfade could land before the load it followed. Now each shard has one fetch in flight at a
  // time and everything queued behind it rides the next one as a single ordered batch. Bounded: a
  // stalled shard sheds its OLDEST frames past RELAY_QUEUE_MAX rather than growing without limit.
  private static RELAY_QUEUE_MAX = 500;
  private relayQueue = new Map<number, { frame: ServerMsg; cache: CacheKind; cacheOnly: boolean }[]>();
  private relayBusy = new Set<number>();
  private pushToRelays(msg: ServerMsg, cacheOnly = false): void {
    if (!this.relayOn || !this.roomHostId) return;
    const item = { frame: msg, cache: cacheKindOf(msg), cacheOnly };
    for (let i = 0; i < this.relayShards; i++) {
      const q = this.relayQueue.get(i) ?? [];
      q.push(item);
      if (q.length > DjRoom.RELAY_QUEUE_MAX) q.splice(0, q.length - DjRoom.RELAY_QUEUE_MAX);
      this.relayQueue.set(i, q);
      this.pumpRelay(i);
    }
  }
  private pumpRelay(i: number): void {
    if (this.relayBusy.has(i)) return;
    const q = this.relayQueue.get(i);
    if (!q || q.length === 0) return;
    this.relayQueue.set(i, []);
    this.relayBusy.add(i);
    const body = JSON.stringify({ frames: q, hostId: this.roomHostId });
    const stub = this.relayNs!.get(this.relayNs!.idFromName(`relay:${this.roomHostId}:${i}`));
    void stub
      .fetch("https://relay/push", { method: "POST", body })
      .catch(() => {})
      .finally(() => {
        this.relayBusy.delete(i);
        this.pumpRelay(i);
      });
  }
  private relayToListeners(msg: ServerMsg): void {
    this.pushToRelays(msg); // D2: crowd is sharded → relays (no-op when off)
    this.sendTo((a) => !!a?.pub, msg);
  }

  // What makes a sweep "the same control" — so last-value-wins coalescing replaces, not
  // merges, two different controls — now lives in src/htl/room/digestKey.ts, pure and tested.
  // It was keyed on the bare `param`, which collided every FX device sharing a name (`mix` is
  // the generic wet/dry on all of them), so one device froze for listeners while another moved.

  // Coalesce the LYRICS relay the same way, and for the same reason the digest exists: a
  // high-frequency last-value-wins payload should cross at a rate a human can perceive, not at
  // the rate the producer emits. One timer per room, latest-per-deck, trailing flush — so the
  // final caption state always lands even if every intermediate frame is dropped.
  private queueLyrics(deck: string, msg: ServerMsg, from: string): void {
    this.lyricsPending.set(deck, { msg, from });
    if (this.lyricsTimer) return;
    this.lyricsTimer = setTimeout(() => {
      this.lyricsTimer = null;
      const batch = [...this.lyricsPending.values()];
      this.lyricsPending.clear();
      for (const e of batch) this.relay(e.from, e.msg);
    }, DjRoom.LYRICS_FLUSH_MS);
  }

  // Buffer a continuous sweep for the listener crowd, keeping only the latest value per
  // control, and flush the batch at ~DIGEST_FLUSH_MS. During an active sweep the DO is awake
  // (it's processing the intents), so the timer fires; an idle room never queues anything.
  private queueDigest(intent: Intent, msg: ServerMsg): void {
    // Delete-then-set moves the key to the END of the Map's order, so the held batch goes out in the
    // order each control's LATEST value arrived, not the order each control first moved.
    const k = digestKey(intent);
    this.digest.delete(k);
    this.digest.set(k, msg);
    if (this.digestTimer) return;
    this.digestTimer = setTimeout(() => this.flushDigest(), DjRoom.DIGEST_FLUSH_MS);
  }

  /** Send the held sweeps now (the timer, or a discrete intent that must not overtake them). */
  private flushDigest(): void {
    if (this.digestTimer) {
      clearTimeout(this.digestTimer);
      this.digestTimer = null;
    }
    if (this.digest.size === 0) return;
    const batch = [...this.digest.values()];
    this.digest.clear();
    for (const m of batch) this.relayToListeners(m);
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
    const view = this.roomView();
    const { full, lite } = presenceFor(view);
    const fullJson = JSON.stringify(full);
    const liteJson = JSON.stringify(lite);
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      try {
        ws.send(a?.pub ? liteJson : fullJson);
      } catch {
        /* socket gone — ignore */
      }
    }
    // D2: the crowd lives on the shards → push their presence + refresh the cached crowd-welcome
    // a fresh listener catches up from.
    if (this.relayOn) {
      this.pushToRelays(lite); // fan the count to the crowd
      this.pushToRelays(welcomeFor("", view, true, this.songRequests.list), true); // refresh catch-up cache ONLY
    }
  }
}
