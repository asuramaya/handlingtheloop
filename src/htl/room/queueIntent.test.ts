import { describe, test, expect } from "vitest";
import { applyQueueIntent, type QueueTarget } from "./queueIntent";
import type { Intent, QueuedTrack } from "./protocol";

// bb03b26e listed "queue edits" as untested and waiting on two real devices. It was not waiting on
// devices — it was waiting on being reachable. The rule sat in a closure inside useSessionSync's
// useCallback, which is the same place applyIntent sat before it was lifted out, for the same
// reason and with the same consequence: nothing could call it, so nobody asked it anything.

const track = (videoId: string): QueuedTrack => ({ videoId, title: videoId, artist: "", duration: 0, thumbnail: null, views: null });
const q = (i: Partial<Intent> & { action: string }): Extract<Intent, { kind: "queue" }> => ({ kind: "queue", ...i }) as Extract<Intent, { kind: "queue" }>;

/** A queue that records what was done to it, in order. */
function spy() {
  const calls: string[] = [];
  const target: QueueTarget = {
    enqueue: (t) => calls.push(`enqueue:${t.videoId}`),
    enqueueNext: (t) => calls.push(`enqueueNext:${t.videoId}`),
    remove: (id) => calls.push(`remove:${id}`),
    moveById: (id, to) => calls.push(`moveById:${id}:${to}`),
  };
  return { calls, target };
}

describe("a queue edit from the wire", () => {
  test("all four actions reach the queue, each by its own method", () => {
    const { calls, target } = spy();
    applyQueueIntent(q({ action: "add", track: track("a") }), target, { mirroring: false });
    applyQueueIntent(q({ action: "addNext", track: track("b") }), target, { mirroring: false });
    applyQueueIntent(q({ action: "remove", videoId: "c" }), target, { mirroring: false });
    applyQueueIntent(q({ action: "move", videoId: "d", to: 3 }), target, { mirroring: false });
    expect(calls).toEqual(["enqueue:a", "enqueueNext:b", "remove:c", "moveById:d:3"]);
  });

  test("a move is ID-based, never index-based — the sender's from-index may be stale", () => {
    const { calls, target } = spy();
    applyQueueIntent(q({ action: "move", videoId: "x", to: 0 }), target, { mirroring: false });
    expect(calls).toEqual(["moveById:x:0"]);
  });
});

describe("★ the authority rule — only one device owns the canonical queue", () => {
  // A MIRRORING remote's local queue is unused, and applying here forks a second copy that then
  // diverges silently. The authority re-streams afterwards so everyone converges 1:1 on its copy.
  test("a mirroring device refuses every action, even holding a perfectly good queue", () => {
    const { calls, target } = spy();
    for (const a of [q({ action: "add", track: track("a") }), q({ action: "remove", videoId: "b" }), q({ action: "move", videoId: "c", to: 1 })]) {
      expect(applyQueueIntent(a, target, { mirroring: true })).toBe("mirroring");
    }
    expect(calls, "a mirror applied a queue edit — its copy has now forked from the authority's").toEqual([]);
  });

  test("★ the mirror check comes FIRST, before the queue check", () => {
    // Order is the rule, not an implementation detail: a mirroring device may also HAVE a queue, so
    // testing for the queue first would let exactly the dangerous case through. The witness is what
    // makes this assertable at all — both orders leave `calls` empty.
    expect(applyQueueIntent(q({ action: "add", track: track("a") }), spy().target, { mirroring: true })).toBe("mirroring");
    expect(applyQueueIntent(q({ action: "add", track: track("a") }), null, { mirroring: true })).toBe("mirroring");
  });

  test("no queue at all is a different outcome from refusing — and both are silent", () => {
    expect(applyQueueIntent(q({ action: "add", track: track("a") }), null, { mirroring: false })).toBe("no-queue");
  });

  test("an action from a newer peer is dropped, not guessed at", () => {
    const { calls, target } = spy();
    expect(applyQueueIntent(q({ action: "shuffle" }), target, { mirroring: false })).toBe("unknown-action");
    expect(calls).toEqual([]);
  });
});

describe("the call site still routes through it", () => {
  // The rule being pure buys nothing if useSessionSync goes back to doing it inline — the shape
  // duckTap.test.ts pins for duckTapWanted. Asserted as a CALLER, not by re-testing the logic.
  test("useSessionSync calls applyQueueIntent rather than touching the queue directly", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../App/useSessionSync.ts", import.meta.url), "utf8");
    expect(src).toMatch(/applyQueueIntent\(/);
    expect(src, "useSessionSync is mutating the queue inline again").not.toMatch(/queue\.enqueue\(/);
  });
});
