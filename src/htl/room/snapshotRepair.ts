// snapshotRepair — the pure decisions behind "the board snapshot REPAIRS a follower", not just
// initialises it (operator, 2026-11-11: session sync audit).
//
// Before this, a follower reconciled a deck's state from the snapshot ONCE per videoId. Everything
// after that was supposed to arrive as intents, so any intent lost in a reconnect blip stayed lost for
// the rest of the track, and the auto-DJ's direct deck moves (EQ kills, filter sweeps, tempo resets,
// loop rolls) never reached a guest at all because they are not intents. Now:
//   • the anchor stamps every publish with a growing `rev` and its own id (`by`), and republishes after
//     any board change (debounced) plus a slow heartbeat while peers are joined;
//   • a follower applies every NEWER snapshot, never an older one, field by field, idempotently;
//   • and never over a field this device itself changed in the last second (its own in-flight edit).
// The engine-touching halves live in useSessionSync / deckApply; these are the decisions only.
import type { DeckId, Intent } from "./protocol";

// ── Ordering ─────────────────────────────────────────────────────────────────────────────────────
export interface RevStamp {
  rev?: number;
  by?: string;
}
export type SnapshotOrder =
  | "unversioned" // an older anchor: no rev → today's behaviour (reconcile once per videoId)
  | "newer" //       apply it
  | "same" //        the one we already applied (a catch-up echo) → only first-time work
  | "stale"; //      older than one already applied from this anchor → ignore entirely

export function snapshotOrder(snap: RevStamp, last: { rev: number; by: string } | null): SnapshotOrder {
  if (typeof snap.rev !== "number" || !Number.isFinite(snap.rev) || typeof snap.by !== "string" || !snap.by) return "unversioned";
  if (!last || last.by !== snap.by) return "newer"; // first one, or a new anchor: its counter is its own
  if (snap.rev > last.rev) return "newer";
  return snap.rev === last.rev ? "same" : "stale";
}

/** The next publish revision. Wall-clock seeded so a reloaded anchor (same device id, counter
 *  reset) still publishes revisions above the ones it published before the reload. */
export function nextRev(prev: number, nowMs: number): number {
  return Math.max(prev + 1, Math.floor(nowMs));
}

// ── Anchor republish cadence ─────────────────────────────────────────────────────────────────────
export const REPUBLISH_DEBOUNCE_MS = 500; //   trailing: a change that has settled this long goes out
export const REPUBLISH_MAX_WAIT_MS = 1500; //  a change that never settles (a filter sweep) still goes out
export const REPUBLISH_HEARTBEAT_MS = 8000; // while peers are joined, even with nothing changed
/** A deck mid-load publishes the OLD track's id (publishedDeckId), and a follower that already
 *  landed the new one would read that as "load the old one". Hold the republish while loading,
 *  but not forever. */
export const REPUBLISH_LOAD_HOLD_MAX_MS = 30000;

export interface RepublishInput {
  fp: string; //                the board's fingerprint now (no playhead, no rev)
  publishedFp: string; //       the fingerprint of the last publish
  changedAt: number | null; //  when fp was first seen differing from publishedFp (null = not since)
  lastChangeAt: number | null; // when fp last moved
  lastPublishAt: number; //     when we last published (any reason)
  peersJoined: boolean;
  loadingForMs: number | null; // how long a deck has been mid-load; null = none
  now: number;
}

export function decideRepublish(p: RepublishInput): "publish" | "wait" {
  if (p.loadingForMs != null && p.loadingForMs < REPUBLISH_LOAD_HOLD_MAX_MS) return "wait";
  if (p.fp !== p.publishedFp) {
    const settled = p.lastChangeAt != null && p.now - p.lastChangeAt >= REPUBLISH_DEBOUNCE_MS;
    const overdue = p.changedAt != null && p.now - p.changedAt >= REPUBLISH_MAX_WAIT_MS;
    if (settled || overdue) return "publish";
    return "wait";
  }
  if (p.peersJoined && p.now - p.lastPublishAt >= REPUBLISH_HEARTBEAT_MS) return "publish";
  return "wait";
}

/** What a board publish is ABOUT, minus what changes on its own every frame (the playheads) and
 *  minus the stamp. Two boards with the same fingerprint need no republish. */
export function boardFingerprint(snap: { decks: Record<string, unknown> } & Record<string, unknown>): string {
  const { rev: _r, by: _b, decks, ...rest } = snap;
  void _r;
  void _b;
  const d: Record<string, unknown> = {};
  for (const k of Object.keys(decks)) {
    const deck = decks[k] as Record<string, unknown> | null;
    if (!deck) {
      d[k] = deck;
      continue;
    }
    const { position: _p, playing: _pl, ...keep } = deck;
    void _p;
    void _pl;
    d[k] = keep;
  }
  return JSON.stringify({ ...rest, decks: d });
}

// ── Local-touch grace (generalised from the stems' STEM_TOUCH_GRACE_MS) ──────────────────────────
/** A field this device changed within this window is not overwritten by a snapshot: the snapshot
 *  is at least one round trip old and cannot yet contain our own gesture. Milliseconds. */
export const TOUCH_GRACE_MS = 1000;

/** The groups of snapshot state a gesture can change. */
export type SnapField =
  | "tempo"
  | "trim"
  | "level"
  | "eq"
  | "filter"
  | "pitch"
  | "keylock"
  | "quantize"
  | "skipBeats"
  | "cue"
  | "hotCues"
  | "loop"
  | "stems"
  | "fx"
  | "crossfade"
  | "tempoRange"
  | "pads";
export type TouchKey = DeckId | "board";
export type TouchMap = Record<TouchKey, Partial<Record<SnapField, number>>>;

/** Which snapshot fields a locally-originated intent changes (so the next snapshot leaves them be). */
export function fieldsTouchedBy(intent: Intent): { key: TouchKey; fields: SnapField[] } | null {
  switch (intent.kind) {
    case "crossfade":
      return { key: "board", fields: ["crossfade"] };
    case "tempoRange":
      return { key: "board", fields: ["tempoRange"] };
    case "sample":
      return { key: "board", fields: ["pads"] };
    case "control": {
      const p = intent.param;
      if (p === "tempo" || p === "trim" || p === "level" || p === "pitch") return { key: intent.deck, fields: [p] };
      if (p === "filter") return { key: intent.deck, fields: ["filter", "eq"] }; // the filter drives the EQ's cut nodes
      return { key: intent.deck, fields: ["eq"] };
    }
    case "toggle": {
      const p = intent.param;
      if (p === "eqBypass") return { key: intent.deck, fields: ["eq"] };
      return { key: intent.deck, fields: [p] }; // fx | keylock | quantize
    }
    case "stem":
    case "stemGain":
      return { key: intent.deck, fields: ["stems"] };
    case "skip":
      return { key: intent.deck, fields: ["skipBeats"] };
    case "loop":
    case "loopBounds":
      return { key: intent.deck, fields: ["loop"] };
    case "cue":
      return { key: intent.deck, fields: ["cue"] };
    case "hotcue":
      return { key: intent.deck, fields: intent.action === "press" ? ["loop"] : ["hotCues"] }; // a hot LOOP press arms a loop
    case "fxParam":
    case "fxBypass":
    case "fxRack":
      return { key: intent.deck, fields: ["fx"] };
    case "board":
      // Board gestures (pad modes, FX-pad throws, moves) are registry-defined; they can roll a loop,
      // throw an effect or gate a stem. Hold all three rather than guess which.
      return { key: intent.deck, fields: ["loop", "fx", "stems"] };
    default:
      return null;
  }
}

export function touchField(map: TouchMap, intent: Intent, now: number): void {
  const t = fieldsTouchedBy(intent);
  if (!t) return;
  const rec = (map[t.key] ??= {});
  for (const f of t.fields) rec[f] = now;
}

// ── Our own shared load (a co-DJ picked a track the anchor has not landed yet) ───────────────────
/** How long the anchor gets to land a track we shared before the tick's word wins again. */
export const OWN_LOAD_WINDOW_MS = 30000;
/** After the anchor's tick confirms our track, its first echo snapshot may still predate our edits. */
export const OWN_LOAD_CONFIRM_GRACE_MS = 2000;

export interface OwnLoad {
  vid: string;
  at: number; //           when we shared it
  confirmedAt?: number; // when the anchor's tick first named it
}

export type OwnLoadDecision =
  | "none" //    no own load in play → the normal resync rules
  | "hold" //    we hold our own pick; the anchor has not landed it yet → don't drive, don't reload
  | "confirm" // the anchor's tick now names our track → record it, then the normal rules
  | "expire"; // the window ran out → forget it, then the normal rules

/** ★ A GUEST'S OWN LOAD WAS REVERTED by the tick resync: until the anchor's copy lands its ticks
 *  still name the OLD track, so the guest (already on the new one) read itself as diverged and
 *  reloaded the old track, wiping its edits, then flipped back seconds later. A separate early clause
 *  in front of decideTickResync so that function's own rules stay as they are. */
export function decideOwnLoad(p: { own: OwnLoad | null; tickVid: string | null | undefined; loadedId: string | null; now: number }): OwnLoadDecision {
  const o = p.own;
  if (!o) return "none";
  if (p.tickVid != null && p.tickVid === o.vid) return o.confirmedAt == null ? "confirm" : "none";
  if (o.confirmedAt != null) return "none";
  if (p.now - o.at >= OWN_LOAD_WINDOW_MS) return "expire";
  if (p.tickVid == null) return "none"; // an old anchor that stamps no vid: nothing to fight
  return p.loadedId === o.vid ? "hold" : "none"; // still on the old track → it matches the tick; drive it
}

/** May a snapshot overwrite `field` on this deck right now? No when this device changed it within
 *  the touch grace, or since its own shared load of this very track while that load is unconfirmed
 *  (the anchor's echo may predate the edit). */
export function fieldHeld(p: { touchedAt: number | undefined; now: number; own: OwnLoad | null; snapVid: string | null }): boolean {
  const t = p.touchedAt;
  if (t == null) return false;
  if (p.now - t < TOUCH_GRACE_MS) return true;
  const o = p.own;
  if (!o || o.vid !== p.snapVid || t < o.at) return false;
  if (o.confirmedAt == null) return p.now - o.at < OWN_LOAD_WINDOW_MS;
  return p.now - o.confirmedAt < OWN_LOAD_CONFIRM_GRACE_MS;
}

// ── Anchor: audible intents for a track still on its way ─────────────────────────────────────────
/** ★ DROPPED IN SILENCE BEFORE: on the anchor, while a guest's shared track is still decoding, the
 *  guest's play / seek / hot-cue press fails holdsForeignTrack (it would sound the OLD track) and
 *  was simply discarded. Queue it for the incoming track instead and apply it when that lands.
 *  Bounded: one transport-run slot and one position slot per deck, newest wins, and an entry for a
 *  different track or older than the window is dropped. (Loop / cue intents are held elsewhere.) */
export const PENDING_AUDIBLE_MAX_MS = 30000;

export interface PendingAudible {
  intent: Intent;
  vid: string;
  at: number;
  slot: "run" | "pos";
}

function audibleSlot(intent: Intent): "run" | "pos" | null {
  if (intent.kind === "transport") return intent.action === "seek" ? "pos" : "run";
  if (intent.kind === "hotcue" && intent.action === "press") return "pos";
  return null;
}

export function queueAudible(q: readonly PendingAudible[], intent: Intent, vid: string, now: number): PendingAudible[] {
  const slot = audibleSlot(intent);
  if (!slot) return [...q];
  const keep = q.filter((e) => e.vid === vid && e.slot !== slot && now - e.at < PENDING_AUDIBLE_MAX_MS);
  return [...keep, { intent, vid, at: now, slot }];
}

/** Once `loadedVid` is on the deck: the intents to apply now (arrival order), and what stays queued. */
export function drainAudible(q: readonly PendingAudible[], loadedVid: string | null, now: number): { apply: Intent[]; keep: PendingAudible[] } {
  const live = q.filter((e) => now - e.at < PENDING_AUDIBLE_MAX_MS);
  if (!loadedVid) return { apply: [], keep: live };
  const apply = live.filter((e) => e.vid === loadedVid).map((e) => e.intent);
  const keep = live.filter((e) => e.vid !== loadedVid);
  return { apply, keep };
}
