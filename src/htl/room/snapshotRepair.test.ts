import { describe, it, expect } from "vitest";
import { decideSnapshotDeck } from "./sessionFollow";
import {
  OWN_LOAD_CONFIRM_GRACE_MS,
  OWN_LOAD_WINDOW_MS,
  PENDING_AUDIBLE_MAX_MS,
  REPUBLISH_DEBOUNCE_MS,
  REPUBLISH_HEARTBEAT_MS,
  REPUBLISH_LOAD_HOLD_MAX_MS,
  REPUBLISH_MAX_WAIT_MS,
  TOUCH_GRACE_MS,
  boardFingerprint,
  decideOwnLoad,
  decideRepublish,
  drainAudible,
  fieldHeld,
  fieldsTouchedBy,
  nextRev,
  queueAudible,
  snapshotOrder,
  touchField,
  type TouchMap,
} from "./snapshotRepair";
import type { Intent } from "./protocol";

// Operator, 2026-11-11: session sync audit — the snapshot now REPAIRS a follower.

describe("snapshotOrder — a follower never applies an older board", () => {
  it("an older anchor's unversioned snapshot keeps today's behaviour", () => {
    expect(snapshotOrder({}, null)).toBe("unversioned");
    expect(snapshotOrder({ rev: 5 }, { rev: 1, by: "h" })).toBe("unversioned");
  });
  it("orders by rev within one anchor", () => {
    expect(snapshotOrder({ rev: 10, by: "h" }, null)).toBe("newer");
    expect(snapshotOrder({ rev: 11, by: "h" }, { rev: 10, by: "h" })).toBe("newer");
    expect(snapshotOrder({ rev: 10, by: "h" }, { rev: 10, by: "h" })).toBe("same");
  });
  it("STALE CATCH-UP: a reconnect's request-state answer older than what we applied is ignored", () => {
    expect(snapshotOrder({ rev: 9, by: "h" }, { rev: 10, by: "h" })).toBe("stale");
  });
  it("a new anchor's counter is not compared with the old one's", () => {
    expect(snapshotOrder({ rev: 1, by: "guest" }, { rev: 1e12, by: "host" })).toBe("newer");
  });
  it("nextRev grows monotonically and survives a reload (wall-clock seeded)", () => {
    expect(nextRev(0, 1000)).toBe(1000);
    expect(nextRev(1000, 1000)).toBe(1001);
    expect(nextRev(1001, 999)).toBe(1002); // a clock step back never lowers it
    expect(nextRev(0, 5000)).toBeGreaterThan(1002); // a reloaded page restarts above
  });
});

describe("decideSnapshotDeck — repair on every NEWER snapshot, not once per videoId", () => {
  const base = { snapVideoId: "v", loadedId: "v", roomLoadTarget: null, loadingVid: "", reconciledTarget: "v" };
  it("already reconciled + newer snapshot → reconcile again", () => {
    expect(decideSnapshotDeck({ ...base, repair: true })).toBe("reconcile");
  });
  it("already reconciled + same/unversioned snapshot → skip (old rule)", () => {
    expect(decideSnapshotDeck({ ...base, repair: false })).toBe("skip");
    expect(decideSnapshotDeck(base)).toBe("skip");
  });
  it("repair never reconciles a track that is not loaded yet", () => {
    expect(decideSnapshotDeck({ ...base, loadedId: "old", roomLoadTarget: "v", repair: true })).toBe("skip");
  });
});

describe("touch grace — a snapshot never stomps this device's own in-flight edit", () => {
  it("maps local gestures onto snapshot fields", () => {
    expect(fieldsTouchedBy({ kind: "control", deck: "A", param: "tempo", value: 2 })).toEqual({ key: "A", fields: ["tempo"] });
    expect(fieldsTouchedBy({ kind: "control", deck: "B", param: "eqLow", value: -6 })).toEqual({ key: "B", fields: ["eq"] });
    expect(fieldsTouchedBy({ kind: "toggle", deck: "A", param: "keylock", value: true })?.fields).toEqual(["keylock"]);
    expect(fieldsTouchedBy({ kind: "loop", deck: "A", action: "beat", beats: 4 })?.fields).toEqual(["loop"]);
    expect(fieldsTouchedBy({ kind: "hotcue", deck: "A", slot: 1, action: "save" })?.fields).toEqual(["hotCues"]);
    expect(fieldsTouchedBy({ kind: "skip", deck: "A", beats: 8 })?.fields).toEqual(["skipBeats"]);
    expect(fieldsTouchedBy({ kind: "crossfade", value: 0.2 })).toEqual({ key: "board", fields: ["crossfade"] });
    expect(fieldsTouchedBy({ kind: "transport", deck: "A", action: "play" })).toBeNull();
  });
  it("held within the grace, free after it", () => {
    const m: TouchMap = { A: {}, B: {}, board: {} };
    touchField(m, { kind: "control", deck: "A", param: "filter", value: 0.3 }, 1000);
    expect(m.A.filter).toBe(1000);
    expect(m.A.eq).toBe(1000);
    expect(fieldHeld({ touchedAt: m.A.filter, now: 1000 + TOUCH_GRACE_MS - 1, own: null, snapVid: "v" })).toBe(true);
    expect(fieldHeld({ touchedAt: m.A.filter, now: 1000 + TOUCH_GRACE_MS, own: null, snapVid: "v" })).toBe(false);
    expect(fieldHeld({ touchedAt: undefined, now: 5, own: null, snapVid: "v" })).toBe(false);
  });
  it("edits made since our own shared load are held until the anchor confirms (plus a short grace)", () => {
    const own = { vid: "new", at: 1000 };
    // an edit 5 s after sharing, read 6 s after: past the touch grace but the anchor has not landed it
    expect(fieldHeld({ touchedAt: 6000, now: 12000, own, snapVid: "new" })).toBe(true);
    // a different track's snapshot is not protected by it
    expect(fieldHeld({ touchedAt: 6000, now: 12000, own, snapVid: "old" })).toBe(false);
    // an edit from BEFORE the load is not protected either
    expect(fieldHeld({ touchedAt: 500, now: 12000, own, snapVid: "new" })).toBe(false);
    const confirmed = { ...own, confirmedAt: 20000 };
    expect(fieldHeld({ touchedAt: 6000, now: 20000 + OWN_LOAD_CONFIRM_GRACE_MS - 1, own: confirmed, snapVid: "new" })).toBe(true);
    expect(fieldHeld({ touchedAt: 6000, now: 20000 + OWN_LOAD_CONFIRM_GRACE_MS, own: confirmed, snapVid: "new" })).toBe(false);
  });
});

describe("decideOwnLoad — a guest's own shared load is not reverted by the anchor's old tick", () => {
  const own = { vid: "new", at: 0 };
  it("holds while we hold our pick and the anchor still names the old track", () => {
    expect(decideOwnLoad({ own, tickVid: "old", loadedId: "new", now: 5000 })).toBe("hold");
  });
  it("lets the deck drive while it still holds the old (matching) track", () => {
    expect(decideOwnLoad({ own, tickVid: "old", loadedId: "old", now: 5000 })).toBe("none");
  });
  it("confirms once the anchor's tick names our track, and then gets out of the way", () => {
    expect(decideOwnLoad({ own, tickVid: "new", loadedId: "new", now: 5000 })).toBe("confirm");
    expect(decideOwnLoad({ own: { ...own, confirmedAt: 5000 }, tickVid: "new", loadedId: "new", now: 6000 })).toBe("none");
    // after confirmation the normal resync rules apply again, whatever the tick says
    expect(decideOwnLoad({ own: { ...own, confirmedAt: 5000 }, tickVid: "other", loadedId: "new", now: 7000 })).toBe("none");
  });
  it("expires after the window: the tick's word wins again", () => {
    expect(decideOwnLoad({ own, tickVid: "old", loadedId: "new", now: OWN_LOAD_WINDOW_MS })).toBe("expire");
  });
  it("no own load / an old anchor without vid → normal rules", () => {
    expect(decideOwnLoad({ own: null, tickVid: "old", loadedId: "new", now: 1 })).toBe("none");
    expect(decideOwnLoad({ own, tickVid: undefined, loadedId: "new", now: 1 })).toBe("none");
  });
});

describe("anchor pending-intent queue — audible intents for an incoming track are kept, not dropped", () => {
  const play: Intent = { kind: "transport", deck: "A", action: "play" };
  const pause: Intent = { kind: "transport", deck: "A", action: "pause" };
  const seek: Intent = { kind: "transport", deck: "A", action: "seek", position: 30 };
  const hot: Intent = { kind: "hotcue", deck: "A", slot: 2, action: "press" };
  it("queues and drains on landing, in arrival order", () => {
    let q = queueAudible([], seek, "new", 0);
    q = queueAudible(q, play, "new", 10);
    expect(drainAudible(q, "old", 20)).toEqual({ apply: [], keep: q });
    const out = drainAudible(q, "new", 20);
    expect(out.apply).toEqual([seek, play]);
    expect(out.keep).toEqual([]);
  });
  it("newest wins per slot (run / position), bounded", () => {
    let q = queueAudible([], play, "new", 0);
    q = queueAudible(q, pause, "new", 1);
    q = queueAudible(q, seek, "new", 2);
    q = queueAudible(q, hot, "new", 3); // a hot-cue press replaces the seek: both set the position
    expect(q.map((e) => e.intent)).toEqual([pause, hot]);
  });
  it("a different incoming track drops the old one's entries; expired entries are dropped", () => {
    let q = queueAudible([], play, "first", 0);
    q = queueAudible(q, seek, "second", 1);
    expect(q.map((e) => e.vid)).toEqual(["second"]);
    expect(drainAudible(q, "second", 1 + PENDING_AUDIBLE_MAX_MS).apply).toEqual([]);
  });
  it("ignores non-audible intents", () => {
    expect(queueAudible([], { kind: "cue", deck: "A", position: 3 }, "new", 0)).toEqual([]);
  });
});

describe("decideRepublish — the anchor republishes after a change, debounced, plus a heartbeat", () => {
  const base = { fp: "x", publishedFp: "x", changedAt: null, lastChangeAt: null, lastPublishAt: 0, peersJoined: true, loadingForMs: null, now: 1000 };
  it("nothing changed, heartbeat not due → wait", () => {
    expect(decideRepublish(base)).toBe("wait");
  });
  it("heartbeat while peers are joined, never alone", () => {
    expect(decideRepublish({ ...base, now: REPUBLISH_HEARTBEAT_MS })).toBe("publish");
    expect(decideRepublish({ ...base, now: REPUBLISH_HEARTBEAT_MS, peersJoined: false })).toBe("wait");
  });
  it("trailing debounce on a change", () => {
    const changed = { ...base, fp: "y", changedAt: 1000, lastChangeAt: 1000 };
    expect(decideRepublish({ ...changed, now: 1000 + REPUBLISH_DEBOUNCE_MS - 1 })).toBe("wait");
    expect(decideRepublish({ ...changed, now: 1000 + REPUBLISH_DEBOUNCE_MS })).toBe("publish");
  });
  it("a change that never settles still goes out (max wait)", () => {
    const sweeping = { ...base, fp: "z", changedAt: 1000, lastChangeAt: 1000 + REPUBLISH_MAX_WAIT_MS - 10 };
    expect(decideRepublish({ ...sweeping, now: 1000 + REPUBLISH_MAX_WAIT_MS })).toBe("publish");
  });
  it("held while a deck is mid-load (its board names the old track), but not forever", () => {
    const changed = { ...base, fp: "y", changedAt: 0, lastChangeAt: 0, now: 5000 };
    expect(decideRepublish({ ...changed, loadingForMs: 1000 })).toBe("wait");
    expect(decideRepublish({ ...changed, loadingForMs: REPUBLISH_LOAD_HOLD_MAX_MS })).toBe("publish");
  });
  it("the fingerprint ignores the playheads and the stamp", () => {
    const deck = (pos: number, playing: boolean) => ({ videoId: "v", tempo: 1, position: pos, playing });
    const a = boardFingerprint({ decks: { A: deck(1, true), B: deck(2, false) }, crossfade: 0, rev: 1, by: "h" });
    const b = boardFingerprint({ decks: { A: deck(9, false), B: deck(3, true) }, crossfade: 0, rev: 2, by: "h" });
    expect(a).toBe(b);
    const c = boardFingerprint({ decks: { A: { ...deck(1, true), tempo: 2 }, B: deck(2, false) }, crossfade: 0 });
    expect(c).not.toBe(a);
  });
});
