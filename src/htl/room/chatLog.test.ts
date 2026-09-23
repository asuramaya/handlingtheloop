import { describe, test, expect } from "vitest";
import { mergeChatHistory, CHAT_LOG_MAX } from "./chatLog";
import type { ChatMsg } from "./protocol";

const m = (seq: number, text = `line ${seq}`): ChatMsg => ({ id: `c${seq}`, dev: "d1", name: "Someone", text });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => m(from + i));
const ids = (l: ChatMsg[]) => l.map((x) => x.id);

describe("a resync must not cost the conversation", () => {
  test("★ the lines the server's backlog does not carry SURVIVE", () => {
    // The defect: chat-history arrives on every socket accept AND every request-state — a routine
    // resync the watchdog fires on a stale tick. A device holding 120 lines was handed the server's
    // 30 and kept only those, dropping 90 for a reason with nothing to do with chat.
    const held = range(1, 120);
    const backlog = range(91, 120); // the server's Chat.HISTORY window
    const out = mergeChatHistory(held, backlog);
    expect(out).toHaveLength(120);
    expect(ids(out)[0]).toBe("c1");
  });

  test("nothing is duplicated where the two overlap", () => {
    const out = mergeChatHistory(range(1, 40), range(31, 40));
    expect(ids(out)).toEqual(ids(range(1, 40)));
  });

  test("lines the server has and we missed are taken", () => {
    // We were disconnected while c41-c45 were said; the backlog is how we learn them.
    const out = mergeChatHistory(range(1, 40), range(36, 45));
    expect(ids(out)).toEqual(ids(range(1, 45)));
  });

  test("order is by sequence — a gap we missed is filled IN PLACE, not appended", () => {
    // ★ MY FIRST VERSION OF THIS TEST WAS THE UNREALISTIC ONE, not the code. I fed it an existing
    // log of [c3, c1] and it failed — correctly: max-seq went backwards, which is the restarted-room
    // signal, so it replaced. An existing log cannot be out of order (live lines append in arrival
    // order, and the server fans out over one socket in sequence). The real case is a GAP: we were
    // disconnected while c2 was said, so the backlog carries it and it belongs BETWEEN what we hold.
    const out = mergeChatHistory([m(1), m(3)], [m(2), m(3), m(4)]);
    expect(ids(out)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  test("the cap still holds", () => {
    const out = mergeChatHistory(range(1, CHAT_LOG_MAX), range(CHAT_LOG_MAX + 1, CHAT_LOG_MAX + 10));
    expect(out).toHaveLength(CHAT_LOG_MAX);
    expect(ids(out).at(-1)).toBe(`c${CHAT_LOG_MAX + 10}`); // the newest survive, not the oldest
  });
});

describe("★ the case that makes the naive merge WRONG — a restarted room", () => {
  // Ids are `c${seq}` from a counter in the Durable Object's MEMORY (server/roomCrowd.ts). A restart
  // resets it, so a new `c1` can collide with an old `c1` this device still holds. A merge that
  // deduped by id would swallow the new live line — trading a cosmetic loss for a dropped message,
  // which is a strictly worse bug than the one being fixed.
  test("a backlog whose sequence went BACKWARDS replaces, it does not merge", () => {
    const held = range(1, 120); // a long-lived session
    const afterRestart = range(1, 3).map((x) => ({ ...x, text: `NEW ${x.id}` }));
    const out = mergeChatHistory(held, afterRestart);
    expect(out).toHaveLength(3);
    expect(out.map((x) => x.text)).toEqual(["NEW c1", "NEW c2", "NEW c3"]);
  });

  test("…and the merge is NOT skipped merely because the backlog is short", () => {
    // The discriminator is the SEQUENCE going backwards, not the size. A small backlog from the same
    // life must still merge, or the fix only works for rooms that happen to be busy.
    const out = mergeChatHistory(range(1, 40), [m(40)]);
    expect(ids(out)).toEqual(ids(range(1, 40)));
  });

  test("an id we cannot read makes us refuse to reason about ordering at all", () => {
    // A future id format must not be silently ordered as 0, which would bury it at the top and
    // claim a comparison we did not make.
    const out = mergeChatHistory(range(1, 5), [{ id: "x9", dev: "d", name: "n", text: "future" }]);
    expect(ids(out)).toEqual(["x9"]);
  });
});

describe("the boring ends", () => {
  test("no history yet → take the backlog", () => {
    expect(ids(mergeChatHistory([], range(1, 3)))).toEqual(["c1", "c2", "c3"]);
  });
  test("an empty backlog changes nothing", () => {
    expect(ids(mergeChatHistory(range(1, 3), []))).toEqual(["c1", "c2", "c3"]);
  });
});

describe("the call site routes through it", () => {
  test("useRoom merges rather than replacing", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./useRoom.ts", import.meta.url), "utf8");
    expect(src).toMatch(/mergeChatHistory\(/);
    expect(src, "useRoom is replacing the chat log again").not.toMatch(/chatHistory: \(list\) => setChatLog\(list\)/);
  });
});
