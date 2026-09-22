import { describe, test, expect } from "vitest";
import { initialDock } from "./initialDock";

describe("initialDock", () => {
  test("restores the panel the user left open", () => {
    expect(initialDock("settings", null, true)).toBe("settings");
    expect(initialDock("social", null, true)).toBe("social");
  });

  test("a followed @handle link outranks a remembered panel — the bug that had no door", () => {
    expect(initialDock("settings", "hostdeck", true)).toBe(null);
    expect(initialDock("social", "hostdeck", true)).toBe(null);
  });

  test("the stored value is only ignored for that load — nothing here writes it away", () => {
    // The function is pure; this pins the contract that callers must not clear the key.
    expect(initialDock("settings", "hostdeck", true)).toBe(null);
    expect(initialDock("settings", null, true)).toBe("settings");
  });

  test("phones start closed whatever is stored (the docks are full-screen modals there)", () => {
    expect(initialDock("settings", null, false)).toBe(null);
    expect(initialDock("settings", "hostdeck", false)).toBe(null);
  });

  test("an unknown or absent value opens nothing", () => {
    expect(initialDock(null, null, true)).toBe(null);
    expect(initialDock("", null, true)).toBe(null);
    expect(initialDock("library", null, true)).toBe(null);
  });
});
