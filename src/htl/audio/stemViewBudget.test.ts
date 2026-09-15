import { describe, expect, it } from "vitest";
import {
  BAND_BUCKETS,
  BANDS_PER_STEM,
  DO_VALUE_CAP,
  MAX_BUCKETS,
  MAX_STEMVIEW_BYTES,
  STEMVIEW_PAYLOAD_CEILING,
  STEM_LANES,
} from "./stemViewBudget";

const b64Len = (n: number) => Math.ceil(n / 3) * 4;

describe("stemViewBudget", () => {
  it("derives the per-deck ceiling from the client's own clamp, not from a hand-picked number", () => {
    const expected = STEM_LANES * (b64Len(2 * MAX_BUCKETS) + BANDS_PER_STEM * b64Len(BAND_BUCKETS));
    expect(STEMVIEW_PAYLOAD_CEILING).toBe(expected);
    expect(STEMVIEW_PAYLOAD_CEILING).toBe(60_288); // 4 x (12,000 + 3,072) at today's constants
  });

  // THE PROPERTY, not the coincidence. At today's numbers the derivation lands under the DO cap on
  // its own; a later bucket change could push it past, and then an admitted envelope would be one
  // the DO cannot store — reviving the "oversized lives in memory only" split this is meant to end.
  it("can never admit an envelope the Durable Object cannot store", () => {
    expect(MAX_STEMVIEW_BYTES).toBeLessThanOrEqual(DO_VALUE_CAP);
  });

  it("admits everything this client can actually produce, with headroom", () => {
    expect(MAX_STEMVIEW_BYTES).toBeGreaterThan(STEMVIEW_PAYLOAD_CEILING);
    // Two decks' worth of ceiling is what a joiner is handed by sendCatchUp; the bound must not be
    // so tight that an ordinary separation is refused.
    expect(MAX_STEMVIEW_BYTES).toBeGreaterThan(STEMVIEW_PAYLOAD_CEILING * 1.5);
  });

  it("is far below the 400 KB it replaces — that is the point", () => {
    expect(MAX_STEMVIEW_BYTES).toBeLessThan(400_000);
    // The measured join cost was 600.6 KB per arrival at a 293 KB/deck payload. Under this bound
    // the same payload is refused outright, so it can never enter lastStemView and be replayed.
    expect(293_000).toBeGreaterThan(MAX_STEMVIEW_BYTES);
  });

  it("keeps the clamp constants in ONE place so server and client cannot drift", () => {
    expect(MAX_BUCKETS).toBe(4500);
    expect(BAND_BUCKETS).toBe(768);
    expect(STEM_LANES).toBe(4);
  });
});
