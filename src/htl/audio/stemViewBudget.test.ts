import { describe, expect, it } from "vitest";
import {
  BAND_BUCKETS,
  BANDS_PER_STEM,
  DO_VALUE_CAP,
  MAX_BUCKETS,
  MAX_STEMVIEW_BYTES,
  STEMVIEW_PAYLOAD_CEILING,
  STEM_LANES,
  CLAMP_FITS_RECORD,
  DECKS_PER_RECORD,
} from "./stemViewBudget";

const b64Len = (n: number) => Math.ceil(n / 3) * 4;

describe("stemViewBudget", () => {
  it("derives the per-deck ceiling from the client's own clamp, not from a hand-picked number", () => {
    const expected = STEM_LANES * (b64Len(2 * MAX_BUCKETS) + BANDS_PER_STEM * b64Len(BAND_BUCKETS));
    expect(STEMVIEW_PAYLOAD_CEILING).toBe(expected);
    expect(STEMVIEW_PAYLOAD_CEILING).toBe(60_288); // 4 x (12,000 + 3,072) at today's constants
  });

  // ★ THE DENOMINATORS. Admission is per DECK; persistence is per RECORD (both decks, one key).
  // The first version min()'d a per-deck derivation against the per-record cap and called it a
  // property — two decks admitted at that bound produced a ~257 KB record, twice what the DO can
  // store. This is the assertion that would have caught it.
  it("two ADMITTED envelopes always fit in ONE persisted record", () => {
    const record = DECKS_PER_RECORD * MAX_STEMVIEW_BYTES + 2048; // + the record's own JSON overhead
    expect(record).toBeLessThanOrEqual(DO_VALUE_CAP);
  });

  it("admits everything this client can actually produce", () => {
    expect(MAX_STEMVIEW_BYTES).toBeGreaterThanOrEqual(STEMVIEW_PAYLOAD_CEILING);
  });

  // ★ THE CONSTRAINT THE DERIVATION EXPOSED: the DO's per-value cap is now a ceiling on the CLIENT
  // clamp. Raise MAX_BUCKETS past the point where the payload ceiling exceeds the per-deck budget
  // and the server must refuse envelopes the client legitimately produces — every remote waveform
  // goes absent, in every session, at once. This fails in CI instead.
  it("fails loudly if a clamp raise outgrows what one record can hold", () => {
    expect(CLAMP_FITS_RECORD).toBe(true);
    expect(STEMVIEW_PAYLOAD_CEILING).toBeLessThanOrEqual(MAX_STEMVIEW_BYTES);
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
