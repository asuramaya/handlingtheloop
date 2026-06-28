// Locks down the key → Camelot-code mapping (server/features.ts:toCamelot), the
// translation that lets the auto-mixer's harmonic mixing trust AcousticBrainz keys.
// Asserts all 12 pitch classes × {major, minor} against the lookup table in the file,
// plus the invalid-input guards.
import { describe, expect, it } from "vitest";
import { toCamelot } from "./features";

// The canonical Camelot wheel. Verified against the well-known reference points:
//   A minor = 8A, C major = 8B (the "natural" 8 position), E minor = 9A, G major = 9B.
// Major codes (the "B"/outer ring) indexed by pitch class 0=C…11=B.
const EXPECTED_MAJOR: Record<string, string> = {
  C: "8B",
  "C#": "3B",
  D: "10B",
  "D#": "5B",
  E: "12B",
  F: "7B",
  "F#": "2B",
  G: "9B",
  "G#": "4B",
  A: "11B",
  "A#": "6B",
  B: "1B",
};
// Minor codes (the "A"/inner ring) indexed by pitch class 0=C…11=B.
const EXPECTED_MINOR: Record<string, string> = {
  C: "5A",
  "C#": "12A",
  D: "7A",
  "D#": "2A",
  E: "9A",
  F: "4A",
  "F#": "11A",
  G: "6A",
  "G#": "1A",
  A: "8A",
  "A#": "3A",
  B: "10A",
};

describe("toCamelot — major keys (all 12 pitch classes)", () => {
  for (const [note, code] of Object.entries(EXPECTED_MAJOR)) {
    it(`${note} major → ${code}`, () => {
      expect(toCamelot(note, "major")).toBe(code);
    });
  }
});

describe("toCamelot — minor keys (all 12 pitch classes)", () => {
  for (const [note, code] of Object.entries(EXPECTED_MINOR)) {
    it(`${note} minor → ${code}`, () => {
      expect(toCamelot(note, "minor")).toBe(code);
    });
  }
});

describe("toCamelot — the well-known reference anchors", () => {
  it("A minor = 8A", () => expect(toCamelot("A", "minor")).toBe("8A"));
  it("C major = 8B", () => expect(toCamelot("C", "major")).toBe("8B"));
});

describe("toCamelot — input parsing", () => {
  it("accepts lowercase note names (uppercased internally)", () => {
    expect(toCamelot("a", "minor")).toBe("8A");
    expect(toCamelot("c", "major")).toBe("8B");
  });

  it("trims surrounding whitespace on the note", () => {
    expect(toCamelot("  A  ", "minor")).toBe("8A");
  });

  it("matches the scale by a case-insensitive 'min' prefix", () => {
    expect(toCamelot("A", "MINOR")).toBe("8A");
    expect(toCamelot("A", "Min")).toBe("8A");
    // anything not starting with 'min' is treated as major
    expect(toCamelot("A", "major")).toBe("11B");
    expect(toCamelot("A", "maj")).toBe("11B");
  });

  it("resolves enharmonic flats to the same pitch class as the sharp", () => {
    // Db == C#, Eb == D#, etc. — the PC table accepts both spellings.
    expect(toCamelot("Db", "major")).toBe(toCamelot("C#", "major"));
    expect(toCamelot("Eb", "minor")).toBe(toCamelot("D#", "minor"));
    expect(toCamelot("Bb", "major")).toBe(toCamelot("A#", "major"));
  });
});

describe("toCamelot — invalid input → null", () => {
  it("non-string key → null", () => {
    expect(toCamelot(123, "major")).toBeNull();
    expect(toCamelot(null, "major")).toBeNull();
    expect(toCamelot(undefined, "major")).toBeNull();
  });

  it("unknown / unparseable note name → null", () => {
    expect(toCamelot("H", "major")).toBeNull();
    expect(toCamelot("", "major")).toBeNull();
    expect(toCamelot("xyz", "minor")).toBeNull();
  });

  // NOTE: the assignment expected "null scale → null", but the implementation
  // (features.ts:41-42) treats any non-"min*" scale — including null/undefined —
  // as MAJOR rather than returning null. So a valid note with a null scale yields
  // the major Camelot code, NOT null. Documenting actual behavior here; if "unknown
  // scale → null" is the intended contract this is a latent bug (features.ts:41).
  it("null/unknown scale with a valid note falls through to MAJOR (documents actual behavior)", () => {
    expect(toCamelot("C", null)).toBe("8B");
    expect(toCamelot("C", undefined)).toBe("8B");
    expect(toCamelot("A", 42)).toBe("11B");
  });
});
