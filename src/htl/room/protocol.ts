// Wire protocol for the shared DJ session (the "room"). One Durable Object per
// SESSION (server/room.ts) fans these messages out between the session's participants.
// A session is keyed by a host account; the host's own devices join by default, and
// guests on OTHER accounts join via an invite code (the Worker resolves the code to
// the host's session before the upgrade — see worker/index.ts).
//
// Role model (the party primitive). DISCOVERY (signed-in devices seeing each other) is
// NOT a session — you must JOIN to establish sync. Once joined, two INDEPENDENT switches:
//   • controlling — 🎛️ this device may DRIVE the decks. SHARED: any number at once.
//   • listening   — 🔊 this device renders its OWN audio stream (hears the mix).
// They never affect each other. `joined` is explicit (join/leave). On join: listening ON
// (you joined to hear), controlling OFF (opt in to driving). One joined device is the
// invisible ANCHOR (playhead clock + snapshot authority); it's plumbing, not a role.
//
// The DO treats `snapshot` OPAQUELY — it only relays it — so this file stays
// dependency-free. The client casts snapshots back to SessionSnapshot.
// See docs/shared-session.md for the full design.

export type DeckId = "A" | "B";

// The reconstruction-engine version (D5). A listener rebuilds the host's mix locally from the
// recipe stream, so bit-exactness requires BOTH sides run the same engine semantics. BUMP this
// whenever a change alters deterministic reconstruction (DSP math, intent semantics, default
// values a `sync`/`key` leans on). Recordings (Epic G) stamp it so replay can pin or refuse;
// live joins compare it (a mismatch = "refresh to hear the set faithfully"). A stale cached
// bundle is the usual cause of divergence between a host and a listener.
export const ENGINE_VERSION = 1;

// Crowd reactions (F4) + hype (F2). A listener taps one of a FIXED set of emojis; the DO
// AGGREGATES them (never fans out each tap — a 500-person room would storm) into a periodic
// frame of per-emoji counts plus a decaying HYPE level (0..1) the DJ reads as crowd energy.
export const REACTIONS = ["🔥", "🙌", "🎶", "❤️", "😮", "💀"] as const;
export type Reaction = (typeof REACTIONS)[number];
export function isReaction(s: unknown): s is Reaction {
  return typeof s === "string" && (REACTIONS as readonly string[]).includes(s);
}

export interface Peer {
  id: string;
  name: string;
  kind: string; // device type (iPhone / Mac / Linux …) — for the roster icon, independent of name
  host: boolean; // a device on the SESSION-OWNER's account (vs an invited guest)?
  joined: boolean; // in the session (a participant/guest)?
  listening: boolean; // rendering its own audio stream?
  controlling: boolean; // allowed to drive the decks (shared — many at once)?
  anchor: boolean; // the playhead-clock / snapshot authority (invisible plumbing)?
  pending: boolean; // a GUEST who knocked (opened an invite) and is awaiting the host's approval
  decks: string; // which decks this device may DRIVE: "" | "A" | "B" | "AB" ("AB" = full; the host/granted hold both)
  stage: boolean; // STEPPED UP from the broadcast floor (drives one deck, never anchors; reverts to a listener on step-down)
  joinedAt: number; // epoch ms this device became a participant (0 until joined) — for "joined 3m ago"
  color: string; // this device's account accent (hex) — the room's "vibe" is the host's
}

// How a public-lobby LISTENER may get onto the decks (E6). The host picks the gate:
//   • request — raise a hand, the host approves (default; the controlled door)
//   • open    — grab any FREE deck instantly, no approval (first-come b2b)
//   • closed  — the crowd can't step up at all (host + private invitees only)
export type StageGate = "request" | "open" | "closed";

// One chat line (F5). `dev` is the sender's device id — non-secret (like every device id) and
// carried so the host can mute/ban straight from a message. Fanned out to everyone present.
export interface ChatMsg {
  id: string;
  dev: string;
  name: string;
  text: string;
}

// A song the crowd asks the DJ to play (F1). Free text — the DJ reads it and pulls the
// track themselves (maps onto the library/queue). Surfaced to PARTICIPANTS only.
export interface SongRequest {
  id: string;
  name: string; // who asked (display label)
  text: string; // the ask, e.g. "Rosé — APT"
  votes: number; // crowd upvotes (F3); the asker auto-votes, so this is ≥1. The list sorts by it.
}

// A broadcast LISTENER raising a hand to step up to the decks (the floor→stage request).
// Surfaced ONLY to participants (the host approves it); the anonymous crowd otherwise
// stays a count, never a roster row — so a request is the one time a listener gets named.
export interface StageReq {
  id: string;
  name: string;
  deck: DeckId;
}

export interface DeckTick {
  pos: number; // playhead position in seconds (the anchor's real clock)
  playing: boolean;
  // Compact AUTHORITATIVE per-stem mixer state from the anchor, piggybacked on the tick
  // only when it CHANGED or on a ~1 Hz heartbeat — so stem mute/gain self-heals a dropped
  // intent without re-sending it every tick. g = gains, m = mutes, both length-4 in the
  // fixed stem order [drums, bass, vocals, other]. Absent on most ticks.
  stems?: { g: number[]; m: boolean[] };
}
export type TickDecks = Record<DeckId, DeckTick>;

// Every intent is an ABSOLUTE setpoint, never a delta or a bare toggle, so the
// shared state converges even when messages are reordered or dropped (last-write-
// wins per target). See the intent→engine table in docs/shared-session.md.
export type ControlParam =
  | "tempo"
  | "trim"
  | "level"
  | "eqLow"
  | "eqMid"
  | "eqHigh"
  | "eqLowFreq"
  | "eqMidFreq"
  | "eqHighFreq"
  | "eqMidQ"
  | "eqLowQ"
  | "eqHighQ"
  | "eqLowShape"
  | "eqMidShape"
  | "eqHighShape"
  | "eqHpFreq"
  | "eqHpQ"
  | "eqLpFreq"
  | "eqLpQ"
  | "filter"
  | "pitch";
export type ToggleParam = "fx" | "keylock" | "quantize" | "eqBypass";
export type StemName = "drums" | "bass" | "vocals" | "other";
// Sampler voice behaviour (mirrors SampleMode in the audio engine; inlined so this wire
// file stays import-free, exactly like StemName above).
export type SampleMode = "oneshot" | "gate" | "loop" | "bounce";

// One channel-strip effect AFTER the EQ (delay/reverb/chorus…) — see src/htl/audio/Fx.ts.
// The EQ is NOT here: it keeps its dedicated ControlParams above. Devices ride the wire
// opaquely as {kind, bypassed, params}; a receiver reconstructs the kinds it knows and
// ignores the rest (forward-compatible). `kind` is a string (not a closed union) on the
// wire so a newer client's effect doesn't break an older one — it just stores the slot.
export interface FxSlot {
  kind: string; // "delay" | "reverb" | "chorus" … (matches FxKind in the audio engine)
  bypassed: boolean;
  params: Record<string, number>;
}

// A track carried whole inside a queue-mutation intent, so the queue authority (the
// host running the auto-mixer) can enqueue a remote's pick with full metadata
// (thumbnail/bpm/key) and re-broadcast it 1:1 in the automix stream. Structurally a
// superset of TrackMeta's serializable fields — kept inline so this protocol file
// stays import-free (the Worker only pulls ClientMsg/ServerMsg/Peer from here).
export interface QueuedTrack {
  videoId: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
  views: number | null;
  bpm?: number | null;
  key?: string | null;
  isrc?: string | null;
  provider?: string;
  providerId?: string | null;
}

export type Intent =
  | { kind: "crossfade"; value: number }
  | { kind: "tempoRange"; value: number } // global tempo-fader range (±%)
  | { kind: "control"; deck: DeckId; param: ControlParam; value: number }
  | { kind: "toggle"; deck: DeckId; param: ToggleParam; value: boolean }
  | { kind: "stemGain"; deck: DeckId; stem: StemName; value: number }
  | { kind: "stem"; deck: DeckId; stem: StemName; on: boolean }
  | { kind: "sync"; slave: DeckId | null } // beat-sync: which deck follows (null = off); for the button
  | { kind: "key"; slave: DeckId | null } // key-match: which deck is shifted (null = off); for the button
  | { kind: "skip"; deck: DeckId; beats: number } // jog / beat-jump resolution (absolute)
  | { kind: "reqStems"; deck: DeckId; model: string } // a remote asks the audio host to separate stems + stream the view
  | { kind: "loopBounds"; deck: DeckId; start: number; end: number; active: boolean } // absolute loop region (fine-adjust / move)
  | { kind: "transport"; deck: DeckId; action: "play" | "pause" | "seek"; position?: number }
  | { kind: "jog"; deck: DeckId; phase: "start" | "move" | "end"; delta?: number } // continuous scrub → platter physics
  | { kind: "cue"; deck: DeckId; position: number } // set the cue point
  | { kind: "loop"; deck: DeckId; action: "in" | "out" | "exit" | "reloop" | "beat"; beats?: number }
  | { kind: "hotcue"; deck: DeckId; slot: number; action: "press" | "save" | "clear" }
  // A sampler pad fired in a session. SELF-CONTAINED so a guest reconstructs WITHOUT the
  // host's local pad store: a REGION pad (route A/B) carries its slice — the guest plays it
  // off its OWN decoded copy of that deck's track, so no audio crosses the wire — and `rate`
  // tempo-syncs the voice to the deck. A GLOBAL pad (route master) carries the server
  // `sampleId`; the guest fetches the clip's bytes (same-account today, cross-account once
  // session-scoped audio access lands). Triggers are DISCRETE — never coalesced (D1 digest).
  // Has no top-level `deck`, so canDriveIntent treats it as board-wide (host/granted only).
  | {
      kind: "sample";
      pad: number;
      route: "A" | "master" | "B";
      // trigger/release/stop = fire a voice; assign/clear/mode/gain/stem = pad CONFIG changes
      // (so a watcher/replay sees a region grabbed, a pad cleared, a mode/gain/stem badge change —
      // the audio itself always rides the self-contained trigger above).
      action: "trigger" | "release" | "stop" | "assign" | "clear" | "mode" | "gain" | "stem";
      region?: { start: number; end: number; mode: SampleMode; gain: number; rate?: number; stem?: StemName };
      sampleId?: string;
      name?: string;
      mode?: SampleMode;
      gain?: number;
      stem?: StemName; // for action:"stem" — which stem a region pad chops (undefined = full mix)
    }
  // Channel-strip effects (post-EQ). `slot` indexes the EFFECT list (0 = first effect
  // after the EQ), NOT the full rack. fxParam/fxBypass are the high-frequency live moves;
  // fxRack carries the whole effect list (add/remove/reorder + late-joiner catch-up).
  | { kind: "fxParam"; deck: DeckId; slot: number; param: string; value: number }
  | { kind: "fxBypass"; deck: DeckId; slot: number; value: boolean }
  | { kind: "fxRack"; deck: DeckId; rack: FxSlot[] }
  // BOARD-AGNOSTIC gesture. The protocol deliberately does NOT enumerate specific buttons
  // (pad modes, FX-pad throws, future performance controls) — the board owns the semantics via
  // a registry (src/htl/board/boardActions.ts), so new pads/effects sync + replay by REGISTERING
  // an apply fn, not by editing the protocol or applyIntent. `id` = a board-namespaced action key
  // ("padMode", "fxPad", …); `phase` covers momentary hold gestures (down/up); `arg` is an
  // optional scalar payload (a mode name, a pad slot). Deck-scoped (gated like any per-deck intent).
  | { kind: "board"; deck: DeckId; id: string; phase?: "down" | "up"; arg?: string | number }
  | { kind: "automix"; action: "toggle" | "skip" | "mixnow" | "hold" } // remote drives the auto-DJ
  // Queue is first-class, host-authoritative room state: a remote mutates it by intent,
  // the host (queue authority) applies it to its single canonical queue, and the automix
  // stream re-broadcasts the result so every device converges 1:1. `add`/`addNext` carry
  // the whole track; `remove` keys by videoId (stable); `move` uses indices into the
  // shared upcoming list (which is the host's queue verbatim, so they line up).
  | { kind: "queue"; action: "add" | "addNext"; track: QueuedTrack }
  | { kind: "queue"; action: "remove"; videoId: string }
  // Move is ID-BASED (not from-index): the sender's indices are computed against a stale
  // mirror, and the host's canonical queue shifts under it (radio refill / advance), so a
  // from-index would reorder the WRONG track. `videoId` pins the track; `to` is the target slot.
  | { kind: "queue"; action: "move"; videoId: string; to: number }
  | { kind: "load"; deck: DeckId; videoId: string; name?: string; artist?: string };

export type ClientMsg =
  | { t: "join" } // establish sync — become a participant (host: immediate; unapproved guest: knocks → pending)
  | { t: "leave" } // back to your own solo decks
  | { t: "control"; on: boolean } // 🎛️ my OWN drive switch — INDEPENDENT of audio (guests: host grants it)
  | { t: "listen"; on: boolean } // 🔊 my OWN sound switch — INDEPENDENT of control
  | { t: "grant"; to: string; on: boolean } // HOST grants/revokes another device's control
  | { t: "approve"; to: string } // HOST lets a knocking guest in (the handshake)
  | { t: "deny"; to: string } // HOST turns a knocking guest away (before they're in)
  | { t: "kick"; to: string } // HOST removes a guest who is already in
  // The floor→stage channel (E3–E6). A broadcast LISTENER raises a hand for a deck; the
  // same message with deck:null cancels a pending request OR steps a stage DJ back down.
  | { t: "stage"; deck: DeckId | null }
  | { t: "stage-approve"; to: string; deck: DeckId } // HOST brings a listener up onto a deck
  | { t: "stage-deny"; to: string } // HOST declines a request, or sends a stage DJ back to the floor
  | { t: "stageGate"; mode: StageGate } // HOST sets how the crowd reaches the decks (request/open/closed)
  | { t: "react"; emoji: string } // a listener/participant taps a reaction (F4) — server-aggregated, rate-limited
  | { t: "request"; text: string } // a listener asks the DJ for a song (F1) — rate-limited
  | { t: "request-vote"; id: string } // upvote a song request (F3) — idempotent, one per device per request
  | { t: "request-dismiss"; id: string } // HOST removes one song request
  | { t: "request-clear" } // HOST clears the whole request list
  | { t: "chat"; text: string } // send a chat line (F5) — rate-limited + slow-moded
  | { t: "chat-slow"; seconds: number } // HOST: slow-mode interval (<0 = chat off, 0 = normal, >0 = N-second gate)
  | { t: "mute"; to: string; on: boolean } // HOST: mute/unmute a device's chat (L1)
  | { t: "ban"; to: string } // HOST: ban a device — evict + block re-entry for the session (L1)
  | { t: "intent"; intent: Intent }
  | { t: "tick"; decks: TickDecks }
  | { t: "state"; snapshot: unknown }
  | { t: "automix"; state: unknown } // host streams the auto-DJ queue + status → guests (opaque)
  | { t: "stemview"; deck: DeckId; view: unknown } // per-deck stem waveform envelopes (opaque; for remote display)
  | { t: "lyrics"; deck: DeckId; videoId: string; lines: unknown; source: string } // host streams word-timed lyrics → guests
  | { t: "color"; color: string } // update this device's account accent (re-broadcast in presence)
  | { t: "settings"; settings: unknown; updatedAt: number } // ACCOUNT-PRIVATE: my colour/theme settings → my OTHER signed-in devices (host-only relay)
  | { t: "public"; on: boolean } // HOST opens/closes the room to anonymous read-only listeners (broadcast plane)
  | { t: "request-state" };

export type ServerMsg =
  // `listeners` = count of anonymous read-only (public) listeners, who are NOT in
  // `peers` (the roster stays the writers/guests; the crowd is just a number). `public`
  // = whether the room is open to anon listeners (the host's broadcast toggle).
  // `engineVersion` = the room's authoritative reconstruction-engine version (the anchor's;
  // D5). A client compares it to its local ENGINE_VERSION to detect a mix it can't faithfully
  // rebuild (stale bundle on either side).
  | { t: "welcome"; you: string; anchorId: string | null; peers: Peer[]; listeners?: number; public?: boolean; pub?: boolean; stage?: StageReq[]; stageGate?: StageGate; requests?: SongRequest[]; chatSlow?: number; muted?: string[]; engineVersion?: number; hostColor?: string }
  // The live song-request list (F1), sent to PARTICIPANTS (the DJ acts on them).
  | { t: "requests"; list: SongRequest[] }
  // `stage` = the pending floor→stage hand-raises (listeners asking to play), sent to
  // PARTICIPANTS only (the host acts on them); the anonymous crowd gets the lite payload.
  // `stageGate`/`chatSlow` ride BOTH payloads — a listener needs them to step up / chat.
  | { t: "presence"; peers: Peer[]; listeners?: number; public?: boolean; stage?: StageReq[]; stageGate?: StageGate; chatSlow?: number; muted?: string[]; engineVersion?: number; hostColor?: string }
  // Direct, per-socket feedback to a hand-raising LISTENER on the fate of its request — the
  // crowd's lite presence carries no stage data, so a decline is signalled here explicitly.
  | { t: "stage-self"; status: "declined" }
  // Chat (F5): a live line to everyone, the recent backlog on join, and a private "you were
  // muted/unmuted" signal to the affected device.
  | { t: "chat"; msg: ChatMsg }
  | { t: "chat-history"; list: ChatMsg[] }
  | { t: "muted"; on: boolean }
  // Aggregated reactions (F4) + hype level (F2), flushed to EVERYONE on a ~1 Hz timer:
  // `counts` = per-emoji taps in the window (drives the floating burst), `hype` = the
  // decaying crowd-energy level 0..1 (drives the meter).
  | { t: "reactions"; counts: Record<string, number>; hype: number }
  | { t: "role"; anchorId: string | null } // the anchor (clock) moved
  | { t: "intent"; from: string; seq: number; intent: Intent }
  | { t: "tick"; decks: TickDecks }
  | { t: "state"; snapshot: unknown }
  | { t: "automix"; state: unknown } // host's auto-DJ queue + status, relayed to remotes
  | { t: "stemview"; deck: DeckId; view: unknown } // host's per-deck stem envelopes, relayed to remotes
  | { t: "lyrics"; deck: DeckId; videoId: string; lines: unknown; source: string } // host's word-timed lyrics, relayed to remotes
  | { t: "settings"; settings: unknown; updatedAt: number } // a same-account device's colour/theme settings, relayed to the owner's OTHER devices
  | { t: "kicked"; reason?: string } // you were denied entry or removed — drop sync + show why
  | { t: "error"; message: string };

// May a device holding `decks` (its drive permission, "" | "A" | "B" | "AB") drive this
// intent? A deck-scoped intent needs that deck; a deck-LESS move (crossfader, tempo range,
// sync/key, automix, queue — they touch the whole board) needs FULL control. This is the
// per-deck gate that lets a stepped-up listener push exactly one deck and nothing else,
// while the host/granted ("AB") drive everything exactly as before. Pure so it's testable.
export function canDriveIntent(decks: string, intent: Intent): boolean {
  if (!decks) return false;
  const deck = (intent as { deck?: unknown }).deck;
  if (deck === "A" || deck === "B") return decks.includes(deck);
  return decks.includes("A") && decks.includes("B"); // deck-less → must hold both
}
