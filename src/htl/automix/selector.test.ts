import { describe, test, expect } from "vitest";
import {
  anchorWeight,
  artistKey,
  artistPenalty,
  bpmFit,
  energyFit,
  isEligible,
  keyFit,
  pickBest,
  radioSeeds,
  scoreCandidate,
  targetEnergy,
  type Candidate,
} from "./selector";
import type { RadioContext } from "./types";
import type { TrackMeta } from "../library/types";

const t = (videoId: string, over: Partial<TrackMeta> = {}): TrackMeta => ({
  videoId,
  title: videoId,
  artist: "",
  duration: 200,
  thumbnail: null,
  views: null,
  ...over,
});
const cand = (track: TrackMeta, rel = 0.5, at = 0): Candidate => ({ track, rel, from: "seed0000001", at });
const ctx = (over: Partial<RadioContext> = {}): RadioContext => ({
  anchor: null,
  current: null,
  anchorAge: 0,
  played: 0,
  arc: "ride",
  ...over,
});
const opts = (over: Partial<Parameters<typeof scoreCandidate>[2]> = {}) => ({
  nearby: [] as TrackMeta[],
  playedRecently: [] as string[],
  target: 0.5,
  ...over,
});

describe("artistKey — one act, however YouTube spells the channel", () => {
  test("collapses the channel-name variants of a single artist", () => {
    const k = artistKey("Burial");
    expect(artistKey("Burial - Topic")).toBe(k);
    expect(artistKey("BurialVEVO")).toBe(k);
    expect(artistKey("Burial Official")).toBe(k);
    expect(artistKey("  burial  ")).toBe(k);
  });

  test("distinct artists stay distinct", () => {
    expect(artistKey("Burial")).not.toBe(artistKey("Boards of Canada"));
  });

  test("missing artist metadata → empty key (no cooldown to apply)", () => {
    expect(artistKey("")).toBe("");
    expect(artistKey(null)).toBe("");
    expect(artistKey(undefined)).toBe("");
  });
});

describe("artistPenalty — the fix for five tracks by one artist in a row", () => {
  const near = (...artists: string[]) => artists.map((a, i) => t(`v${i}`.padEnd(11, "x"), { artist: a }));

  test("an artist playing within the hard window is fully blocked", () => {
    expect(artistPenalty(t("cand0000001", { artist: "Burial" }), near("Burial", "Other"))).toBe(1);
    expect(artistPenalty(t("cand0000001", { artist: "Burial" }), near("Other", "Burial"))).toBe(1);
  });

  test("the block sees through channel-name variants", () => {
    expect(artistPenalty(t("cand0000001", { artist: "Burial - Topic" }), near("BurialVEVO"))).toBe(1);
  });

  test("the penalty fades with distance and reaches zero past the soft window", () => {
    const a = artistPenalty(t("c", { artist: "X" }), near("a", "b", "X"));
    const b = artistPenalty(t("c", { artist: "X" }), near("a", "b", "c", "d", "X"));
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(0);
    expect(artistPenalty(t("c", { artist: "X" }), near("a", "b", "c", "d", "e", "f", "g", "X"))).toBe(0);
  });

  test("an unseen artist is never penalised", () => {
    expect(artistPenalty(t("c", { artist: "Fresh" }), near("a", "b", "c"))).toBe(0);
  });

  test("a candidate with no artist metadata is never penalised (nothing to space out)", () => {
    expect(artistPenalty(t("c", { artist: "" }), near("", "", ""))).toBe(0);
  });
});

// ★ The regression this whole module exists to prevent. `mixability` returns a NEUTRAL 0.5 for an
// unknown key/tempo — correct when describing a transition, catastrophic when ranking, because
// fresh radio candidates never carry analysis and the term became a constant across the pool.
describe("keyFit / bpmFit — 'unknown' is a state, not a middling score", () => {
  test("an unknown key reports known:false and contributes nothing", () => {
    expect(keyFit(t("a"), t("b"))).toEqual({ v: 0, known: false });
    expect(keyFit(t("a", { key: "8A" }), t("b"))).toEqual({ v: 0, known: false });
  });

  test("a perfect key match scores 1 and is known", () => {
    expect(keyFit(t("a", { key: "8A" }), t("b", { key: "8A" }))).toEqual({ v: 1, known: true });
  });

  test("harmonic adjacency beats a clash", () => {
    const adj = keyFit(t("a", { key: "8A" }), t("b", { key: "9A" })).v;
    const clash = keyFit(t("a", { key: "8A" }), t("b", { key: "2A" })).v;
    expect(adj).toBeGreaterThan(clash);
  });

  test("an unknown tempo reports known:false; a folded octave match scores 1", () => {
    expect(bpmFit(t("a", { bpm: 140 }), t("b"))).toEqual({ v: 0, known: false });
    const folded = bpmFit(t("a", { bpm: 140 }), t("b", { bpm: 70 }));
    expect(folded.known).toBe(true);
    expect(folded.v).toBeCloseTo(1, 6);
  });
});

describe("scoreCandidate — what actually decides the pick", () => {
  const prev = t("prev0000001", { key: "8A", bpm: 128, energy: 0.5, artist: "Prev" });

  test("an analysed, harmonically matched candidate beats an unanalysed one at equal relatedness", () => {
    const good = scoreCandidate(cand(t("good0000001", { key: "8A", bpm: 128 })), prev, opts());
    const blind = scoreCandidate(cand(t("blnd0000001")), prev, opts());
    expect(good.total).toBeGreaterThan(blind.total);
    expect(good.analysed).toBeGreaterThan(blind.analysed);
  });

  // The point of the analysed bonus: it rewards being KNOWN, not being good.
  test("a known-poor match still beats a total unknown at equal relatedness", () => {
    const poor = scoreCandidate(cand(t("poor0000001", { key: "2A", bpm: 175 })), prev, opts());
    const blind = scoreCandidate(cand(t("blnd0000001")), prev, opts());
    expect(poor.total).toBeGreaterThan(blind.total);
  });

  test("relatedness still leads — a strong provider signal beats a weak one, all else equal", () => {
    const strong = scoreCandidate(cand(t("a0000000001", { key: "8A", bpm: 128 }), 1), prev, opts());
    const weak = scoreCandidate(cand(t("b0000000001", { key: "8A", bpm: 128 }), 0.1), prev, opts());
    expect(strong.total).toBeGreaterThan(weak.total);
  });

  test("the artist block outweighs a perfect provider signal", () => {
    const blocked = scoreCandidate(
      cand(t("a0000000001", { key: "8A", bpm: 128, artist: "Same" }), 1),
      prev,
      opts({ nearby: [t("n0000000001", { artist: "Same" })] }),
    );
    const clean = scoreCandidate(cand(t("b0000000001", { artist: "Other" }), 0.2), prev, opts());
    expect(blocked.total).toBeLessThan(clean.total);
  });

  test("energy nearest the arc target scores higher", () => {
    const onTarget = scoreCandidate(cand(t("a0000000001", { energy: 0.8 })), prev, opts({ target: 0.8 }));
    const offTarget = scoreCandidate(cand(t("b0000000001", { energy: 0.2 })), prev, opts({ target: 0.8 }));
    expect(onTarget.energy).toBeGreaterThan(offTarget.energy);
  });

  test("the decomposition sums to the total (so the trace log is trustworthy)", () => {
    const p = scoreCandidate(cand(t("a0000000001", { key: "9A", bpm: 130, energy: 0.6, artist: "Q" })), prev, opts());
    expect(p.rel + p.key + p.bpm + p.energy + p.analysed - p.artistPenalty - p.repeatPenalty).toBeCloseTo(p.total, 10);
  });
});

describe("pickBest", () => {
  test("returns null for an empty pool rather than throwing", () => {
    expect(pickBest([], null, opts())).toBeNull();
  });

  test("picks the highest total", () => {
    const prev = t("prev0000001", { key: "8A", bpm: 128 });
    const pool = [cand(t("bad00000001", { key: "2A", bpm: 175 }), 0.3), cand(t("goo00000001", { key: "8A", bpm: 128 }), 0.9)];
    expect(pickBest(pool, prev, opts())?.candidate.track.videoId).toBe("goo00000001");
  });

  test("ties break toward the OLDER pool entry — it has had longest to be analysed", () => {
    const a = cand(t("aaa00000001"), 0.5, 100);
    const b = cand(t("bbb00000001"), 0.5, 500);
    expect(pickBest([b, a], null, opts())?.candidate.track.videoId).toBe("aaa00000001");
  });
});

describe("anchorWeight — the vibe fades, it never vanishes", () => {
  test("a fresh anchor counts fully", () => {
    expect(anchorWeight(0)).toBe(1);
  });

  test("it decays as the set moves on", () => {
    expect(anchorWeight(4)).toBeLessThan(anchorWeight(0));
    expect(anchorWeight(8)).toBeLessThan(anchorWeight(4));
  });

  test("it floors at 0.25 — the set never forgets where it started", () => {
    expect(anchorWeight(50)).toBe(0.25);
    expect(anchorWeight(1000)).toBe(0.25);
  });
});

// ★ THE REPETITION FIX. The old scheme seeded from a 3-wide sliding window over recent plays, so
// two of three seeds were always unchanged; now there are two STABLE seeds that only move when the
// vibe actually moves.
describe("radioSeeds — two stable seeds, not a sliding window", () => {
  const A = t("Atrack00001");
  const B = t("Btrack00002");
  const C = t("Ctrack00003");

  test("anchor + current, with the anchor weighted by its age", () => {
    const s = radioSeeds(ctx({ anchor: A, current: B, anchorAge: 0 }), null);
    expect(s.map((x) => x.track.videoId)).toEqual(["Btrack00002", "Atrack00001"]);
    expect(s[0].weight).toBe(1);
    expect(s[1].weight).toBe(1);
  });

  test("an aged anchor still seeds, but counts for less than what is playing", () => {
    const s = radioSeeds(ctx({ anchor: A, current: B, anchorAge: 6 }), null);
    expect(s[1].weight).toBeLessThan(s[0].weight);
    expect(s[1].weight).toBeGreaterThan(0);
  });

  test("a manual 'play next' pick is the freshest seed, at full strength", () => {
    const s = radioSeeds(ctx({ anchor: A, current: B }), C);
    expect(s[0].track.videoId).toBe("Ctrack00003");
    expect(s[0].weight).toBe(1);
  });

  test("anchor === current collapses to one seed", () => {
    expect(radioSeeds(ctx({ anchor: A, current: A }), null)).toHaveLength(1);
  });

  test("nothing to seed from → no seeds (the caller must not fetch)", () => {
    expect(radioSeeds(ctx(), null)).toEqual([]);
  });

  // The stability property the old sliding window violated: the seed set must not move just
  // because another track played, only because the VIBE moved.
  test("STABILITY: the seed set is unchanged while only anchorAge advances", () => {
    const ids = (age: number) => radioSeeds(ctx({ anchor: A, current: B, anchorAge: age }), null).map((s) => s.track.videoId).join(",");
    expect(ids(0)).toBe(ids(3));
    expect(ids(3)).toBe(ids(7));
  });
});

describe("targetEnergy — the arc", () => {
  test("ride holds the level the user established", () => {
    expect(targetEnergy("ride", 0.7, 0)).toBeCloseTo(0.7, 6);
    expect(targetEnergy("ride", 0.7, 25)).toBeCloseTo(0.7, 6);
  });

  test("build climbs across a run of tracks", () => {
    expect(targetEnergy("build", 0.4, 5)).toBeGreaterThan(targetEnergy("build", 0.4, 1));
  });

  test("journey comes back down — it is a curve, not a ramp", () => {
    const peak = targetEnergy("journey", 0.5, 2);
    const trough = targetEnergy("journey", 0.5, 7);
    expect(peak).toBeGreaterThan(trough);
  });

  test("every arc stays inside 0..1", () => {
    for (const arc of ["ride", "build", "journey"] as const) {
      for (let p = 0; p < 30; p++) {
        const v = targetEnergy(arc, 0.95, p);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("energyFit", () => {
  test("an unanalysed candidate reports known:false, not a neutral score", () => {
    expect(energyFit(t("a"), 0.5)).toEqual({ v: 0, known: false });
  });

  test("closer to the target scores higher, and a far miss floors at 0", () => {
    expect(energyFit(t("a", { energy: 0.5 }), 0.5).v).toBe(1);
    expect(energyFit(t("a", { energy: 0.6 }), 0.5).v).toBeGreaterThan(energyFit(t("a", { energy: 0.8 }), 0.5).v);
    expect(energyFit(t("a", { energy: 0.05 }), 0.95).v).toBe(0);
  });
});

describe("isEligible", () => {
  const bans = { played: new Set(["played00001"]), ids: new Set(["queued00001"]), cores: new Set(["danza kuduro"]) };

  test("rejects already-played, already-queued and empty ids", () => {
    expect(isEligible(t("played00001"), bans)).toBe(false);
    expect(isEligible(t("queued00001"), bans)).toBe(false);
    expect(isEligible(t(""), bans)).toBe(false);
  });

  // Song-level identity, not video-level: a different upload of the same song is the same song.
  test("rejects another upload of a song we already know about", () => {
    expect(isEligible(t("other000001", { title: "Danza Kuduro (Original Mix)" }), bans)).toBe(false);
    expect(isEligible(t("other000001", { title: "Danza Kuduro - Official Video" }), bans)).toBe(false);
  });

  test("accepts a genuinely new track", () => {
    expect(isEligible(t("fresh000001", { title: "Something Else" }), bans)).toBe(true);
  });
});

// ★ REGRESSIONS FROM A LIVE RUN. With "Teardrop" playing, the radio queued "AURORA covers Massive
// Attack 'Teardrop' for Like A Version" and "Massive Attack - Dissolved Girl (cover by Nb Music)".
// Neither was catchable by the original rules: the song name is buried mid-sentence rather than at
// the head of the title, and the uploading CHANNEL is not the artist.
describe("covers, tributes and fan re-uploads", () => {
  const nowPlaying = t("seed0000001", { title: "Teardrop (Remastered 2019)", artist: "Massive Attack - Topic" });
  const bans = { played: new Set<string>(), ids: new Set<string>(), cores: new Set(["teardrop"]) };

  test("a cover of the playing track is rejected even when the title is a sentence", () => {
    expect(isEligible(t("aur00000001", { title: "AURORA covers Massive Attack 'Teardrop' for Like A Version" }), bans)).toBe(false);
  });

  test("a different song by the playing artist is penalised via the artist named in the title", () => {
    const p = artistPenalty(t("dis00000001", { title: "Massive Attack - Dissolved Girl (Bass & Guitar cover by Nb Music)", artist: "Nb Music" }), [nowPlaying]);
    expect(p).toBe(1);
  });

  // ★ The other half: this must not become a filter that eats the whole pool.
  test("an unrelated track by an unrelated uploader is untouched", () => {
    expect(isEligible(t("ok000000001", { title: "Portishead - Roads" }), bans)).toBe(true);
    expect(artistPenalty(t("ok000000001", { title: "Portishead - Roads", artist: "Portishead" }), [nowPlaying])).toBe(0);
  });

  test("a short key cannot match by accident — only names long enough to be distinctive", () => {
    const shortBans = { played: new Set<string>(), ids: new Set<string>(), cores: new Set(["go", "rain"]) };
    expect(isEligible(t("any00000001", { title: "Somewhere In The Rain Tonight" }), shortBans)).toBe(true);
  });

  test("the song key must be a whole phrase, not a fragment", () => {
    const b = { played: new Set<string>(), ids: new Set<string>(), cores: new Set(["teardrop"]) };
    expect(isEligible(t("any00000001", { title: "Teardrops On My Guitar" }), b)).toBe(true);
  });
});
