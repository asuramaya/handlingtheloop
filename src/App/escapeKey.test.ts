import { describe, expect, it } from "vitest";
import { escapeAction, trackOpenOrder } from "./escapeKey";

const none = { library: false, settings: false, people: false, session: false };

describe("Escape on the board", () => {
  it("nothing open: opens Settings", () => {
    expect(escapeAction(false, [])).toEqual({ kind: "openSettings" });
  });
  it("closes the MOST RECENTLY opened panel, one per press", () => {
    let order = trackOpenOrder([], { ...none, library: true });
    order = trackOpenOrder(order, { ...none, library: true, settings: true });
    expect(escapeAction(false, order)).toEqual({ kind: "close", panel: "settings" });
    order = trackOpenOrder(order, { ...none, library: true });
    expect(escapeAction(false, order)).toEqual({ kind: "close", panel: "library" });
  });
  it("re-opening a panel moves it back to the top", () => {
    let order = trackOpenOrder([], { ...none, settings: true, library: true });
    order = trackOpenOrder(order, { ...none, library: true });
    order = trackOpenOrder(order, { ...none, library: true, settings: true });
    expect(order.at(-1)).toBe("settings");
  });
  it("CONTROL: a dialog, menu or text field that claimed Escape wins; the board does nothing", () => {
    expect(escapeAction(true, ["settings"])).toEqual({ kind: "none" });
    expect(escapeAction(true, [])).toEqual({ kind: "none" });
  });
});
