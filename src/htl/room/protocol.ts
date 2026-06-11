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
}

export interface DeckTick {
  pos: number; // playhead position in seconds (the anchor's real clock)
  playing: boolean;
}
export type TickDecks = Record<DeckId, DeckTick>;

// Every intent is an ABSOLUTE setpoint, never a delta or a bare toggle, so the
// shared state converges even when messages are reordered or dropped (last-write-
// wins per target). See the intent→engine table in docs/shared-session.md.
export type ControlParam = "tempo" | "trim" | "level" | "eqLow" | "eqMid" | "eqHigh" | "filter" | "pitch";
export type ToggleParam = "fx" | "keylock" | "quantize";
export type StemName = "drums" | "bass" | "vocals" | "other";

export type Intent =
  | { kind: "crossfade"; value: number }
  | { kind: "tempoRange"; value: number } // global tempo-fader range (±%)
  | { kind: "control"; deck: DeckId; param: ControlParam; value: number }
  | { kind: "toggle"; deck: DeckId; param: ToggleParam; value: boolean }
  | { kind: "stemGain"; deck: DeckId; stem: StemName; value: number }
  | { kind: "stem"; deck: DeckId; stem: StemName; on: boolean }
  | { kind: "transport"; deck: DeckId; action: "play" | "pause" | "seek"; position?: number }
  | { kind: "jog"; deck: DeckId; phase: "start" | "move" | "end"; delta?: number } // continuous scrub → platter physics
  | { kind: "cue"; deck: DeckId; position: number } // set the cue point
  | { kind: "loop"; deck: DeckId; action: "in" | "out" | "exit" | "reloop" | "beat"; beats?: number }
  | { kind: "hotcue"; deck: DeckId; slot: number; action: "press" | "save" | "clear" }
  | { kind: "load"; deck: DeckId; videoId: string; name?: string; artist?: string };

export type ClientMsg =
  | { t: "join" } // establish sync — become a participant (listening on, control off)
  | { t: "leave" } // back to your own solo decks
  | { t: "control"; on: boolean } // 🎛️ my OWN drive switch — INDEPENDENT of audio (guests: host grants it)
  | { t: "listen"; on: boolean } // 🔊 my OWN sound switch — INDEPENDENT of control
  | { t: "grant"; to: string; on: boolean } // HOST grants/revokes another device's control
  | { t: "intent"; intent: Intent }
  | { t: "tick"; decks: TickDecks }
  | { t: "state"; snapshot: unknown }
  | { t: "request-state" };

export type ServerMsg =
  | { t: "welcome"; you: string; anchorId: string | null; peers: Peer[] }
  | { t: "presence"; peers: Peer[] }
  | { t: "role"; anchorId: string | null } // the anchor (clock) moved
  | { t: "intent"; from: string; seq: number; intent: Intent }
  | { t: "tick"; decks: TickDecks }
  | { t: "state"; snapshot: unknown }
  | { t: "error"; message: string };
