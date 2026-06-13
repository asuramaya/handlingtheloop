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
  joinedAt: number; // epoch ms this device became a participant (0 until joined) — for "joined 3m ago"
  color: string; // this device's account accent (hex) — the room's "vibe" is the host's
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
  | "eqHpFreq"
  | "eqHpQ"
  | "eqLpFreq"
  | "eqLpQ"
  | "filter"
  | "pitch";
export type ToggleParam = "fx" | "keylock" | "quantize" | "eqBypass";
export type StemName = "drums" | "bass" | "vocals" | "other";

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
  | { t: "intent"; intent: Intent }
  | { t: "tick"; decks: TickDecks }
  | { t: "state"; snapshot: unknown }
  | { t: "stemview"; deck: DeckId; view: unknown } // per-deck stem waveform envelopes (opaque; for remote display)
  | { t: "lyrics"; deck: DeckId; videoId: string; lines: unknown; source: string } // host streams word-timed lyrics → guests
  | { t: "color"; color: string } // update this device's account accent (re-broadcast in presence)
  | { t: "settings"; settings: unknown; updatedAt: number } // ACCOUNT-PRIVATE: my colour/theme settings → my OTHER signed-in devices (host-only relay)
  | { t: "request-state" };

export type ServerMsg =
  | { t: "welcome"; you: string; anchorId: string | null; peers: Peer[] }
  | { t: "presence"; peers: Peer[] }
  | { t: "role"; anchorId: string | null } // the anchor (clock) moved
  | { t: "intent"; from: string; seq: number; intent: Intent }
  | { t: "tick"; decks: TickDecks }
  | { t: "state"; snapshot: unknown }
  | { t: "stemview"; deck: DeckId; view: unknown } // host's per-deck stem envelopes, relayed to remotes
  | { t: "lyrics"; deck: DeckId; videoId: string; lines: unknown; source: string } // host's word-timed lyrics, relayed to remotes
  | { t: "settings"; settings: unknown; updatedAt: number } // a same-account device's colour/theme settings, relayed to the owner's OTHER devices
  | { t: "kicked"; reason?: string } // you were denied entry or removed — drop sync + show why
  | { t: "error"; message: string };
