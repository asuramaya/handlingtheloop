// What Escape does on the board, as a rule that can be tested rather than a branch in a handler.
//
// Operator, 2026-11-02: "work on the broken escape shortcut to launch settings and exit from open
// tabs". Escape had no board meaning at all: the global key handler only used it to blur a text
// field. So:
//   1. something LOCAL claims it first (a dialog, a menu, an ⓘ bubble, a key being rebound, a text
//      field to blur): those handlers call preventDefault, and the board leaves it alone;
//   2. otherwise, if any panel is open, close the one opened MOST RECENTLY (Escape walks back out,
//      one panel per press, the way it does in every app with stacked surfaces);
//   3. nothing open: open Settings.
import type { PanelKey } from "@htl";

export type EscapeAction = { kind: "close"; panel: PanelKey } | { kind: "openSettings" } | { kind: "none" };

export function escapeAction(claimedLocally: boolean, openOrder: readonly PanelKey[]): EscapeAction {
  if (claimedLocally) return { kind: "none" };
  const top = openOrder[openOrder.length - 1];
  return top ? { kind: "close", panel: top } : { kind: "openSettings" };
}

/** Keep `order` in step with which panels are open: drop closed ones, append newly opened ones at
 *  the end (= most recent), keep everyone else's relative order. */
export function trackOpenOrder(order: readonly PanelKey[], open: Record<PanelKey, boolean>): PanelKey[] {
  const next = order.filter((k) => open[k]);
  for (const k of Object.keys(open) as PanelKey[]) if (open[k] && !next.includes(k)) next.push(k);
  return next;
}
