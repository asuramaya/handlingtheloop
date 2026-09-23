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

  test("a backlog with NO readable id at all has no life to compare — the backlog wins", () => {
    const out = mergeChatHistory(range(1, 5), [{ id: "x9", dev: "d", name: "n", text: "future" }]);
    expect(ids(out)).toEqual(["x9"]);
  });
});

describe("★ one unreadable id must not collapse the whole fold", () => {
  // Metron's catch: `ChatMsg.id` is typed `string`, and the fold's correctness rested on a
  // convention no artifact owns — that every id is `c<n>`, true today because exactly one place
  // mints one. The moment anything else posts a line (a system notice, a moderation message, a hype
  // bridge), maxSeq returned null for the WHOLE list and every merge silently became a replace —
  // the bug this module exists to fix, back through the front door, and only in rooms where such a
  // line exists. Fixed by removing the dependency rather than the id: an unreadable id is carried,
  // it simply does not vote on which life the backlog belongs to.
  const sys = (n: number, text = `system ${n}`) => ({ id: `sys-${n}`, dev: "srv", name: "Room", text });

  test("a system line in the BACKLOG does not turn the merge into a replace", () => {
    // ★ AND MY FIRST VERSION OF THIS TEST WAS UNREALISTIC IN THE SAME WAY THE ORDERING ONE WAS.
    // I wrote a backlog topping out at c38 while the device held c40, and it took the replace branch
    // — correctly, because that IS a counter going backwards. It cannot happen in one life: the
    // server is the source, so its newest is always at least ours. Twice now I have built a state
    // the system cannot produce and read the refusal as a defect; it is the cross-product error in
    // miniature, and the cheap check is to ask which component would have had to emit this.
    const out = mergeChatHistory(range(1, 40), [m(38), sys(1), m(39), m(40), m(41)]);
    expect(ids(out).filter((i) => i.startsWith("c"))).toEqual(ids(range(1, 41)));
    expect(ids(out)).toContain("sys-1"); // carried, not dropped
  });

  test("a system line we ALREADY HOLD does not turn the merge into a replace either", () => {
    const out = mergeChatHistory([...range(1, 40), sys(1)], range(38, 42));
    expect(ids(out).filter((i) => i.startsWith("c"))).toEqual(ids(range(1, 42)));
    expect(ids(out)).toContain("sys-1");
  });

  test("★ an unplaceable line is not sorted as ZERO — that buries it at the top", () => {
    // A comparator using `seqOf(id) ?? 0` does not fail to order it, it CLAIMS a position, and the
    // position it claims is above every real message. Partitioned instead: sequenced first, the
    // rest in arrival order at the end, which in a chat log is the most-recent slot.
    const out = mergeChatHistory([m(1), m(2)], [sys(9), m(3)]);
    expect(ids(out)).toEqual(["c1", "c2", "c3", "sys-9"]);
    expect(ids(out)[0], "an unsequenced line was buried above the conversation").not.toBe("sys-9");
  });

  test("the restart detector still fires with a system line present on both sides", () => {
    // The unreadable ids must not mask a counter going backwards, which is the case they would be
    // most likely to hide.
    const out = mergeChatHistory([...range(1, 120), sys(1)], [m(1, "NEW"), sys(2)]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("NEW");
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
