import { describe, it, expect } from "vitest";
import { groupActivity, isActionable, dayKey, dayLabel, ROLLUP_MIN } from "./activityGroups";
import type { NotifEvent } from "./index";

let seq = 0;
const ev = (kind: string, createdAt: number): NotifEvent => ({
  id: ++seq, kind, createdAt,
  actor: { handle: `u${seq}`, displayName: null, avatar: null },
  payload: null, followsBack: false,
});
// A fixed local-noon "now", so day bucketing is exercised away from a midnight boundary.
const NOW = new Date(2026, 8, 4, 12, 0, 0).getTime();
const DAY = 86_400_000;

describe("isActionable", () => {
  it("knows what asks something of you", () => {
    expect(isActionable(ev("invite", NOW))).toBe(true);
    expect(isActionable(ev("follow_request", NOW))).toBe(true);
    expect(isActionable(ev("follow", NOW))).toBe(false);
    expect(isActionable(ev("mention", NOW))).toBe(false);
  });

  // `kind` is open-ended server-side. An unknown kind must NOT be able to claim the top slot.
  it("defaults an UNKNOWN kind to informational", () => {
    expect(isActionable(ev("some_future_kind", NOW))).toBe(false);
  });
});

describe("groupActivity", () => {
  it("lifts actionable events out of the timeline entirely", () => {
    const a = groupActivity([ev("follow", NOW - 1000), ev("invite", NOW - 90_000)], 0, NOW);
    expect(a.needsYou.map((e) => e.kind)).toEqual(["invite"]);
    // and it is NOT also left in the day groups
    expect(a.days.flatMap((d) => d.events.map((e) => e.kind))).toEqual(["follow"]);
  });

  it("keeps an OLD request above NEW news — a request does not age out of needing you", () => {
    const a = groupActivity([ev("follow", NOW), ev("invite", NOW - 5 * DAY)], 0, NOW);
    expect(a.needsYou).toHaveLength(1);
    expect(a.needsYou[0].kind).toBe("invite"); // still top-level despite being 5 days old
  });

  it("orders needsYou newest first", () => {
    const old = ev("invite", NOW - DAY);
    const recent = ev("invite", NOW - 60_000);
    expect(groupActivity([old, recent], 0, NOW).needsYou.map((e) => e.id)).toEqual([recent.id, old.id]);
  });

  it("groups the rest by LOCAL day, newest day first", () => {
    const a = groupActivity([ev("mention", NOW), ev("mention", NOW - DAY), ev("mention", NOW - 2 * DAY)], 0, NOW);
    expect(a.days.map((d) => d.label)).toEqual(["Today", "Yesterday", dayLabel(dayKey(NOW - 2 * DAY), NOW)]);
  });

  it("rolls up follows at the threshold, and NOT below it", () => {
    const few = groupActivity(Array.from({ length: ROLLUP_MIN - 1 }, () => ev("follow", NOW)), 0, NOW);
    expect(few.days[0].rollups).toEqual([]);
    expect(few.days[0].events).toHaveLength(ROLLUP_MIN - 1); // shown individually

    const many = groupActivity(Array.from({ length: 12 }, () => ev("follow", NOW)), 0, NOW);
    expect(many.days[0].rollups).toEqual([expect.objectContaining({ kind: "follow", count: 12 })]);
    expect(many.days[0].events).toHaveLength(0); // the rolled rows are removed, not duplicated
  });

  it("never rolls up MENTIONS — each one is a different thing somebody said", () => {
    const a = groupActivity(Array.from({ length: 20 }, () => ev("mention", NOW)), 0, NOW);
    expect(a.days[0].rollups).toEqual([]);
    expect(a.days[0].events).toHaveLength(20);
  });

  it("rolls up PER DAY, not across the whole feed", () => {
    const a = groupActivity(
      [...Array.from({ length: 5 }, () => ev("follow", NOW)), ...Array.from({ length: 4 }, () => ev("follow", NOW - DAY))],
      0,
      NOW,
    );
    expect(a.days.map((d) => d.rollups[0]?.count)).toEqual([5, 4]);
  });

  it("counts unread per day against the cursor", () => {
    const a = groupActivity([ev("mention", NOW), ev("mention", NOW - 60_000), ev("mention", NOW - DAY)], NOW - 30_000, NOW);
    expect(a.days[0].unread).toBe(1); // only the newest beats the cursor
    expect(a.days[1].unread).toBe(0);
  });

  it("handles an empty feed without inventing groups", () => {
    expect(groupActivity([], 0, NOW)).toEqual({ needsYou: [], days: [] });
  });
});
