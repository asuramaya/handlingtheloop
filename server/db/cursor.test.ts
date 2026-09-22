import { describe, test, expect } from "vitest";
import { encodeKeyset, decodeKeyset } from "./cursor";

describe("keyset cursor codec", () => {
  test("round-trips a boundary", () => {
    expect(decodeKeyset(encodeKeyset(1_700_000_000, "user-7"))).toEqual({ sortKey: 1_700_000_000, id: "user-7" });
  });

  test("an id containing the separator survives — page 2 must not decode to a truncated id", () => {
    const id = "user:with:colons";
    expect(decodeKeyset(encodeKeyset(42, id))?.id).toBe(id);
  });

  test("the encoded form is not the plaintext payload", () => {
    const enc = encodeKeyset(1_700_000_000, "user-7");
    expect(enc).not.toContain("user-7");
    expect(enc).not.toContain(":");
  });

  test("anything malformed reads as NO cursor — the first page, never a throw and never NaN", () => {
    for (const junk of [null, undefined, "", "not-base64!!", encodeKeyset(NaN, "x"), btoa(":no-key"), btoa("123"), btoa("123:")]) {
      expect(decodeKeyset(junk as string | null | undefined)).toBeNull();
    }
  });
});
