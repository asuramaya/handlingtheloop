import { describe, it, expect } from "vitest";
import {
  createKeyProfile,
  duplicateKeyProfile,
  exportKeyProfile,
  parseKeyProfile,
  keyBindingCount,
} from "./keyProfiles";
import type { KeyBindings } from "./keybinds";

const bindings: KeyBindings = {
  play: { primary: "Space", secondary: "Enter" },
  cue: { primary: "KeyC", secondary: "" },
  sync: { primary: "", secondary: "" },
};

describe("createKeyProfile", () => {
  it("assigns an id, trims the name, clones bindings, stamps updatedAt", () => {
    const p = createKeyProfile("  My Keys  ", bindings);
    expect(p.id).toBeTruthy();
    expect(p.name).toBe("My Keys");
    expect(p.bindings).toEqual(bindings);
    expect(p.bindings).not.toBe(bindings);
    expect(typeof p.updatedAt).toBe("number");
  });

  it("falls back to 'Untitled keys' for a blank name", () => {
    expect(createKeyProfile("  ", bindings).name).toBe("Untitled keys");
  });
});

describe("duplicateKeyProfile", () => {
  it("fresh id + ' copy' name, preserves bindings", () => {
    const orig = createKeyProfile("Layout", bindings);
    const dup = duplicateKeyProfile(orig);
    expect(dup.id).not.toBe(orig.id);
    expect(dup.name).toBe("Layout copy");
    expect(dup.bindings).toEqual(orig.bindings);
    expect(dup.bindings).not.toBe(orig.bindings);
  });
});

describe("exportKeyProfile / parseKeyProfile round-trip", () => {
  it("preserves bindings and name; assigns a fresh id on import", () => {
    const orig = createKeyProfile("RT", bindings);
    const parsed = parseKeyProfile(exportKeyProfile(orig));
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("RT");
    expect(parsed!.bindings).toEqual(bindings);
    expect(parsed!.id).not.toBe(orig.id);
    expect(parsed!.id).toBeTruthy();
  });

  it("normalizes a well-shaped binding entry, coercing missing fields to ''", () => {
    // An entry that's an object but missing `secondary` gets secondary:"".
    const text = JSON.stringify({ name: "n", bindings: { play: { primary: "Space" } } });
    const parsed = parseKeyProfile(text);
    expect(parsed!.bindings.play).toEqual({ primary: "Space", secondary: "" });
  });

  it("drops a malformed (non-object) binding entry", () => {
    // NOTE: a binding value that is not an object (e.g. a string) is skipped entirely
    // — it does not appear in the parsed bindings at all.
    const text = JSON.stringify({
      name: "n",
      bindings: { play: { primary: "Space", secondary: "" }, bad: "not-an-object", alsoBad: 42 },
    });
    const parsed = parseKeyProfile(text);
    expect(parsed!.bindings.play).toEqual({ primary: "Space", secondary: "" });
    expect("bad" in parsed!.bindings).toBe(false);
    expect("alsoBad" in parsed!.bindings).toBe(false);
  });

  it("coerces non-string primary/secondary to '' (an entry with only junk fields → both empty)", () => {
    // NOTE: an object entry with non-string primary AND secondary is KEPT but emptied
    // to {primary:"", secondary:""} — it is NOT dropped. So a binding with garbage
    // values survives as an empty (unbound) slot rather than being filtered out.
    const text = JSON.stringify({
      name: "n",
      bindings: { play: { primary: 123, secondary: { x: 1 } } },
    });
    const parsed = parseKeyProfile(text);
    expect(parsed!.bindings.play).toEqual({ primary: "", secondary: "" });
  });

  it("mismatched kind → null", () => {
    const text = JSON.stringify({ kind: "htl-not-key", version: 1, profile: createKeyProfile("A", bindings) });
    expect(parseKeyProfile(text)).toBeNull();
  });

  it("bare-payload backcompat: a raw profile object imports", () => {
    const bare = JSON.stringify(createKeyProfile("Bare", bindings));
    const parsed = parseKeyProfile(bare);
    expect(parsed).not.toBeNull();
    expect(parsed!.bindings).toEqual(bindings);
  });

  it("missing/null bindings → null", () => {
    expect(parseKeyProfile(JSON.stringify({ name: "n", bindings: null }))).toBeNull();
    expect(parseKeyProfile(JSON.stringify({ name: "n" }))).toBeNull();
  });

  it("garbage string → null (not a throw)", () => {
    expect(parseKeyProfile("][ nope")).toBeNull();
    expect(parseKeyProfile("")).toBeNull();
  });

  it("missing name falls back to 'Imported keys'", () => {
    const parsed = parseKeyProfile(JSON.stringify({ bindings: { play: { primary: "Space", secondary: "" } } }));
    expect(parsed!.name).toBe("Imported keys");
  });
});

describe("keyBindingCount", () => {
  it("counts slots with primary OR secondary set", () => {
    // play: both set, cue: primary only, sync: neither → 2
    const p = createKeyProfile("n", bindings);
    expect(keyBindingCount(p)).toBe(2);
  });

  it("a slot with only secondary set still counts", () => {
    const p = createKeyProfile("n", { jump: { primary: "", secondary: "KeyJ" } });
    expect(keyBindingCount(p)).toBe(1);
  });

  it("zero when every slot is empty", () => {
    const p = createKeyProfile("n", { a: { primary: "", secondary: "" } });
    expect(keyBindingCount(p)).toBe(0);
  });
});
