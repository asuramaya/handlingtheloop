import { describe, it, expect } from "vitest";
import { createMap, duplicateMap, exportMap, parseMap, bindingCount } from "./maps";
import type { MidiLearnMap } from "./types";

const learn: MidiLearnMap = {
  "deck.play.A": { status: 0x90, data: 0x0b, type: "note", control: { kind: "action", action: "play" }, deck: "A" },
  "deck.tempo.A": { status: 0xb0, data: 0x00, type: "cc", control: { kind: "fader", target: "tempo" }, deck: "A" },
};

describe("createMap", () => {
  it("assigns id, trims name, defaults device/basedOn to null, clones bindings, stamps updatedAt", () => {
    const m = createMap("  My Map  ");
    expect(m.id).toBeTruthy();
    expect(m.name).toBe("My Map");
    expect(m.device).toBeNull();
    expect(m.basedOn).toBeNull();
    expect(m.bindings).toEqual({});
    expect(typeof m.updatedAt).toBe("number");
  });

  it("carries through device / basedOn / bindings opts and clones bindings", () => {
    const m = createMap("X", { device: "FLX4", basedOn: "flx4-builtin", bindings: learn });
    expect(m.device).toBe("FLX4");
    expect(m.basedOn).toBe("flx4-builtin");
    expect(m.bindings).toEqual(learn);
    expect(m.bindings).not.toBe(learn); // cloned
  });

  it("falls back to 'Untitled map' for a blank name", () => {
    expect(createMap("   ").name).toBe("Untitled map");
  });
});

describe("duplicateMap", () => {
  it("fresh id + ' copy' name, preserves bindings/device/basedOn", () => {
    const orig = createMap("Board", { device: "Starrypad", basedOn: null, bindings: learn });
    const dup = duplicateMap(orig);
    expect(dup.id).not.toBe(orig.id);
    expect(dup.name).toBe("Board copy");
    expect(dup.device).toBe("Starrypad");
    expect(dup.bindings).toEqual(orig.bindings);
    expect(dup.bindings).not.toBe(orig.bindings);
  });
});

describe("exportMap / parseMap round-trip", () => {
  it("preserves name, device, basedOn and bindings; assigns a fresh id", () => {
    const orig = createMap("RT", { device: "FLX4", basedOn: "flx4-builtin", bindings: learn });
    const parsed = parseMap(exportMap(orig));
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("RT");
    expect(parsed!.device).toBe("FLX4");
    expect(parsed!.basedOn).toBe("flx4-builtin");
    expect(parsed!.bindings).toEqual(learn);
    expect(parsed!.id).not.toBe(orig.id);
    expect(parsed!.id).toBeTruthy();
  });

  it("coerces a non-string device/basedOn to null on import", () => {
    const text = JSON.stringify({ name: "n", device: 5, basedOn: {}, bindings: {} });
    const parsed = parseMap(text);
    expect(parsed!.device).toBeNull();
    expect(parsed!.basedOn).toBeNull();
  });

  it("mismatched kind → null", () => {
    // wrong kind → sanitize sees the OUTER {kind,version,map} object, which has no
    // `.bindings` object at top level → null.
    const text = JSON.stringify({ kind: "htl-not-midi", version: 1, map: createMap("A", { bindings: learn }) });
    expect(parseMap(text)).toBeNull();
  });

  it("bare-payload backcompat: a raw map object imports", () => {
    const bare = JSON.stringify(createMap("Bare", { bindings: learn }));
    const parsed = parseMap(bare);
    expect(parsed).not.toBeNull();
    expect(parsed!.bindings).toEqual(learn);
  });

  it("missing / null bindings → null", () => {
    expect(parseMap(JSON.stringify({ name: "n", bindings: null }))).toBeNull();
    expect(parseMap(JSON.stringify({ name: "n" }))).toBeNull();
  });

  it("garbage / non-JSON string → null (not a throw)", () => {
    expect(parseMap("not json {")).toBeNull();
    expect(parseMap("")).toBeNull();
  });

  it("missing name falls back to 'Imported map'", () => {
    const parsed = parseMap(JSON.stringify({ bindings: {} }));
    expect(parsed!.name).toBe("Imported map");
  });

  it("NOTE: parseMap does NOT validate individual binding entries — junk inside bindings survives", () => {
    // POSSIBLE BUG / silent-data-loss inverse: unlike parseKeyProfile, parseMap casts
    // `m.bindings as MidiLearnMap` wholesale with no per-entry shape check. So a
    // malformed binding (missing status/data/control, wrong types) is passed through
    // verbatim rather than being dropped or rejected. We assert the OBSERVED behaviour
    // (it survives) so the test documents the gap rather than pretending it's filtered.
    const text = JSON.stringify({
      name: "n",
      bindings: { good: learn["deck.play.A"], garbage: { not: "a binding" }, alsoJunk: 42 },
    });
    const parsed = parseMap(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.bindings.good).toEqual(learn["deck.play.A"]);
    // junk passes straight through (no validation):
    expect(parsed!.bindings.garbage).toEqual({ not: "a binding" });
    expect((parsed!.bindings as Record<string, unknown>).alsoJunk).toBe(42);
  });
});

describe("bindingCount", () => {
  it("counts the keys in the bindings map", () => {
    expect(bindingCount(createMap("n", { bindings: learn }))).toBe(2);
    expect(bindingCount(createMap("n"))).toBe(0);
  });
});
