import { describe, it, expect } from "vitest";
import { uid, exportEnvelope, parseEnvelope } from "./profiles";

const KIND = "htl-test-kind";
const VERSION = 1;
const KEY = "payload";

// A trivial sanitize that keeps a known field and drops the rest, so we can observe
// the envelope/parse plumbing without per-type noise.
const sanitize = (raw: unknown) => {
  const r = raw as { keep?: unknown } | null;
  if (!r || typeof r !== "object") return null;
  if (typeof r.keep !== "string") return null;
  return { keep: r.keep };
};

describe("uid", () => {
  it("returns a non-empty string", () => {
    expect(typeof uid()).toBe("string");
    expect(uid().length).toBeGreaterThan(0);
  });

  it("two calls differ", () => {
    expect(uid()).not.toBe(uid());
  });

  it("accepts a prefix arg (used only in the non-crypto fallback path)", () => {
    expect(typeof uid("x")).toBe("string");
  });
});

describe("exportEnvelope / parseEnvelope round-trip", () => {
  it("wraps a payload under {kind, version, [payloadKey]} and survives parse", () => {
    const text = exportEnvelope(KIND, VERSION, KEY, { keep: "hello" });
    const parsed = JSON.parse(text);
    expect(parsed.kind).toBe(KIND);
    expect(parsed.version).toBe(VERSION);
    expect(parsed[KEY]).toEqual({ keep: "hello" });

    const round = parseEnvelope(KIND, KEY, text, sanitize);
    expect(round).toEqual({ keep: "hello" });
  });

  it("mismatched kind → falls back to treating the WHOLE object as the payload", () => {
    // NOTE: parseEnvelope only uses the inner payload when BOTH o.kind === kind AND
    // o[payloadKey] != null; otherwise it passes the ENTIRE parsed object to sanitize.
    // So a wrong-kind envelope does NOT immediately return null — sanitize sees the
    // outer {kind, version, payload} object. Here that object has no top-level `keep`,
    // so sanitize returns null. We assert the observed behaviour.
    const text = exportEnvelope("some-other-kind", VERSION, KEY, { keep: "hello" });
    expect(parseEnvelope(KIND, KEY, text, sanitize)).toBeNull();
  });

  it("mismatched kind but a top-level payload-shaped object still sanitizes (bare-path behaviour)", () => {
    // Demonstrates the fallback explicitly: wrong kind, but the outer object itself
    // happens to carry a valid `keep` field at top level → sanitize accepts it.
    const text = JSON.stringify({ kind: "wrong", keep: "world" });
    expect(parseEnvelope(KIND, KEY, text, sanitize)).toEqual({ keep: "world" });
  });

  it("version is NOT checked by parseEnvelope — an older/newer version still parses", () => {
    // NOTE: parseEnvelope ignores the `version` field entirely; only `kind` and the
    // presence of payloadKey gate the inner-vs-outer choice. There is no version arg.
    // So a v999 envelope round-trips fine. This is the codec's intended behaviour
    // (forward/back compat is handled by the per-type sanitize, not the version).
    const text = exportEnvelope(KIND, 999, KEY, { keep: "future" });
    expect(parseEnvelope(KIND, KEY, text, sanitize)).toEqual({ keep: "future" });
  });

  it("bare payload (no envelope) backcompat path is accepted", () => {
    const text = JSON.stringify({ keep: "bare" });
    expect(parseEnvelope(KIND, KEY, text, sanitize)).toEqual({ keep: "bare" });
  });

  it("garbage / non-JSON string → null (not a throw)", () => {
    expect(parseEnvelope(KIND, KEY, "}{not json", sanitize)).toBeNull();
    expect(parseEnvelope(KIND, KEY, "", sanitize)).toBeNull();
  });

  it("valid JSON that sanitize rejects → null", () => {
    const text = exportEnvelope(KIND, VERSION, KEY, { keep: 123 });
    expect(parseEnvelope(KIND, KEY, text, sanitize)).toBeNull();
  });

  it("correct kind but missing payloadKey → falls back to the outer object", () => {
    // o.kind matches but o[payloadKey] is absent → inner = outer object.
    const text = JSON.stringify({ kind: KIND, version: VERSION, keep: "top" });
    expect(parseEnvelope(KIND, KEY, text, sanitize)).toEqual({ keep: "top" });
  });
});
