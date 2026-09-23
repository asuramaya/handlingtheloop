import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { initDecodeCrashGuard, armDecode, disarmDecode } from "./decodeCrashGuard";
import { clearRing, dumpRing } from "../debug/trace";

// The operator reports iOS crashing on large tracks. A tab that dies inside decodeAudioData leaves
// NO exception, NO rejection and NO onerror — the process is gone and the next boot looks normal.
// This is the only record that survives it, so its rules are load-bearing: it must report exactly
// once, it must not report a decode that merely THREW (that is a codec error, not a crash), and it
// must never throw or block, because a track load is not optional.

class FakeStorage {
  map = new Map<string, string>();
  throwOn: "get" | "set" | "remove" | null = null;
  getItem(k: string) {
    if (this.throwOn === "get") throw new Error("blocked");
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.throwOn === "set") throw new Error("blocked");
    this.map.set(k, v);
  }
  removeItem(k: string) {
    if (this.throwOn === "remove") throw new Error("blocked");
    this.map.delete(k);
  }
}
let store: FakeStorage;

describe("decode crash guard", () => {
  beforeEach(() => {
    store = new FakeStorage();
    vi.stubGlobal("localStorage", store);
    clearRing();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a completed decode leaves nothing behind", () => {
    armDecode(9_400_000);
    disarmDecode();
    expect(initDecodeCrashGuard()).toBeNull();
    expect(dumpRing().filter((e) => e.ch === "decode-crash")).toHaveLength(0);
  });

  it("an armed-but-never-disarmed decode IS the crash, and carries its size", () => {
    armDecode(9_400_000);
    const rec = initDecodeCrashGuard();
    expect(rec?.bytes).toBe(9_400_000);
    expect(dumpRing().filter((e) => e.ch === "decode-crash")).toHaveLength(1);
  });

  it("reports ONCE — a sticky crash state would accuse every later boot", () => {
    armDecode(1234);
    expect(initDecodeCrashGuard()).not.toBeNull();
    expect(initDecodeCrashGuard()).toBeNull();
  });

  it("survives blocked storage in every direction — it must never break a load", () => {
    store.throwOn = "set";
    expect(() => armDecode(1)).not.toThrow();
    store.throwOn = "remove";
    expect(() => disarmDecode()).not.toThrow();
    store.throwOn = "get";
    expect(() => initDecodeCrashGuard()).not.toThrow();
    expect(initDecodeCrashGuard()).toBeNull();
  });

  it("ignores a malformed record rather than reporting a crash that did not happen", () => {
    store.map.set("htl:decodeArm", "{not json");
    expect(initDecodeCrashGuard()).toBeNull();
    store.map.set("htl:decodeArm", JSON.stringify({ nope: true }));
    expect(initDecodeCrashGuard()).toBeNull();
  });

  it("CONTROL: the fake storage actually persists, or every case above passes vacuously", () => {
    armDecode(77);
    expect(store.map.get("htl:decodeArm")).toContain("77");
  });
});
