// roomState — the pure, framework-free core of the DjRoom state machine (server/room.ts).
// Everything here is a plain type / derivation / payload builder with NO `this`, NO sockets,
// NO storage — so the membership model can be reasoned about and unit-tested in isolation
// (server/room.test.ts), and so the DO file stays focused on socket + storage plumbing.
import type { ClientMsg, ServerMsg, Peer, StageReq, StageGate, SongRequest } from "../src/htl/room/protocol";

// --- Minimal Cloudflare runtime types (no @cloudflare/workers-types installed). Shared by
// the DO and the crowd helpers so they all speak the same socket shape. ---
export interface Ws {
  send(msg: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export interface DurableObjectState {
  acceptWebSocket(ws: Ws, tags?: string[]): void;
  getWebSockets(tag?: string): Ws[];
  storage: DurableObjectStorage;
}

// The per-socket attachment IS the device's state. The flags are NOT free-floating — they
// encode one of a small set of roles (see roleOf). Invariants the mutators must preserve:
//   • pub ⇒ joined && listening && !controlling && !stage && decks===""   (anon crowd, read-only)
//   • stage ⇒ !pub && joined && controlling && decks∈{"A","B"}            (stepped up from the floor)
//   • controlling ⇒ joined && decks≠""                                    (you can't drive without a seat+grant)
//   • pending ⇒ !joined                                                    (knocking, not in yet)
//   • host is orthogonal (which account owns the room), set un-forgeably by the Worker.
export interface Attachment {
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

// The single derived "what is this device" — used for the roster, debugging, and tests. host
// is reported separately (it's orthogonal to the role). Keeps the flag checks in ONE place so
// a new feature can't quietly invent a sixth interpretation of the flags.
export type Role = "crowd" | "stage" | "pending" | "present" | "controller" | "listener";
export function roleOf(a: Attachment): Role {
  if (a.pub) return "crowd";
  if (a.stage) return "stage";
  if (a.pending) return "pending";
  if (!a.joined) return "present";
  return a.controlling ? "controller" : "listener";
}

// The ClientMsg kinds an anonymous (pub) crowd listener may send. Everything else is a
// writer action and is dropped. A DECLARATIVE allowlist — adding a crowd feature means
// adding one entry here, and there's no way to "forget the `&&`" and leak a writer message.
export const PUB_ALLOWED: ReadonlySet<ClientMsg["t"]> = new Set<ClientMsg["t"]>([
  "request-state",
  "leave",
  "stage", // raise a hand to step up (the host still gates it)
  "react", // crowd reaction
  "request", // song request
  "request-vote", // upvote a song request (F3)
  "chat", // chat line (F5)
]);
export function pubMayChange(t: ClientMsg["t"]): boolean {
  return PUB_ALLOWED.has(t);
}

// Device kinds (from the client's `kind` param) that are phones/tablets. The anchor (clock)
// prefers a DESKTOP among the owner's devices, so a desktop refresh doesn't hand the clock to
// a phone for good. (iPadOS Safari reports "Mac" — fine, it then counts as a capable desktop.)
export const MOBILE_KINDS = new Set(["iPhone", "iPad", "Android"]);
export const isMobileKind = (kind: string): boolean => MOBILE_KINDS.has(kind);

// One attachment → its roster row (participants only; the crowd is a count, never a row).
export function peerOf(a: Attachment, anchorId: string | null): Peer {
  return {
    id: a.device,
    name: a.name,
    kind: a.kind || "Device",
    host: !!a.host,
    joined: !!a.joined,
    listening: !!a.listening,
    controlling: !!a.controlling,
    anchor: a.device === anchorId,
    pending: !!a.pending,
    decks: a.decks || "",
    stage: !!a.stage,
    joinedAt: a.joinedAt || 0,
    color: a.color || "",
  };
}

// What the room looks like right now — the shared bits both welcome + presence carry.
export interface RoomView {
  anchorId: string | null;
  peers: Peer[];
  listeners: number;
  isPublic: boolean;
  stageGate: StageGate;
  stage: StageReq[]; // pending hand-raises (participants only)
  chatSlow: number; // chat slow-mode: <0 off, 0 normal, >0 N-second gate
}

// The welcome frame for a joining socket. A participant sees the roster + pending hand-raises;
// the anonymous crowd sees neither (just the count + the gate). BOTH get the song-request list
// — the crowd needs it to upvote (F3). Centralised so a new role-scoped field is added once.
export function welcomeFor(you: string, view: RoomView, pub: boolean, requests: SongRequest[]): ServerMsg {
  const base = { you, anchorId: view.anchorId, listeners: view.listeners, public: view.isPublic, stageGate: view.stageGate, chatSlow: view.chatSlow, requests } as const;
  return pub
    ? { t: "welcome", ...base, peers: [], pub: true }
    : { t: "welcome", ...base, peers: view.peers, stage: view.stage };
}

// The two presence payloads: the FULL roster (+ hand-raises) for participants, and the LITE
// count-only frame for the crowd (so the big roster never fans out to hundreds of listeners).
export function presenceFor(view: RoomView): { full: ServerMsg; lite: ServerMsg } {
  return {
    full: { t: "presence", peers: view.peers, listeners: view.listeners, public: view.isPublic, stage: view.stage, stageGate: view.stageGate, chatSlow: view.chatSlow },
    lite: { t: "presence", peers: [], listeners: view.listeners, public: view.isPublic, stageGate: view.stageGate, chatSlow: view.chatSlow },
  };
}
