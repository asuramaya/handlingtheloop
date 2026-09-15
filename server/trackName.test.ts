import { describe, expect, it } from "vitest";
import { resolveTrackName, artistFromChannel, stripUploadNoise } from "./trackName";

// EVERY CASE BELOW IS A REAL ROW FROM THE PROFILE THAT PROMPTED THIS, not an invented example.
// The screenshot showed twelve top songs: three rendering a raw video id, four showing the
// uploader's filename as a song name, and five that were already right and must STAY right.

describe("the leak: a video id is not a name", () => {
  it("never returns an id, even knowing nothing at all", () => {
    // Rows 1, 2 and 5 of the real profile: "2PpBU7EfiEY", "kxu9HLroggQ", "ZIw0P1JGpIE".
    const r = resolveTrackName({});
    expect(r.title).toBe("Unknown track");
    expect(r.title).not.toMatch(/^[\w-]{11}$/);
  });

  it("still names the artist when only the channel is known", () => {
    expect(resolveTrackName({ artist: "Kanye West - Topic" })).toEqual({
      title: "Unknown track",
      artist: "Kanye West",
    });
  });
});

describe("the fingerprinted identity wins, unparsed", () => {
  it("uses track_identity verbatim and does no guessing", () => {
    // The whole point: this is the answer, so nothing below it should run. A MusicBrainz title
    // containing a dash must NOT be split.
    expect(
      resolveTrackName({
        identityArtist: "deadmau5",
        identityTitle: "HR 8938 Cephei",
        title: "Deadmau5 - HR 8938 Cephei (1080p) || HD",
        artist: "TheOtherMau5",
      }),
    ).toEqual({ title: "HR 8938 Cephei", artist: "deadmau5" });
  });

  it("ignores a HALF identity — one field is not an answer", () => {
    // artist without title (or the reverse) would otherwise produce a confident half-wrong row.
    const r = resolveTrackName({ identityArtist: "Grimes", title: "Grimes - Genesis", artist: "Grimes" });
    expect(r).toEqual({ title: "Genesis", artist: "Grimes" });
  });
});

describe("a `- Topic` channel is YouTube Music's own metadata", () => {
  it("takes the artist from the channel and leaves the title alone", () => {
    // Rows 9-12, already correct in the screenshot, and the ones most likely to be broken by a
    // careless fix.
    expect(resolveTrackName({ title: "On Sight", artist: "Kanye West - Topic" })).toEqual({
      title: "On Sight",
      artist: "Kanye West",
    });
    expect(resolveTrackName({ title: "Eyes on Fire", artist: "Blue Foundation - Topic" })).toEqual({
      title: "Eyes on Fire",
      artist: "Blue Foundation",
    });
  });

  it("does NOT dash-split a Topic title — the dash is part of the song's name", () => {
    // "Higher - Remastered" is one title. Splitting it would invent an artist called "Higher".
    expect(resolveTrackName({ title: "Higher - Remastered", artist: "Creed - Topic" })).toEqual({
      title: "Higher - Remastered",
      artist: "Creed",
    });
  });
});

describe("the uploader's own strings, parsed by YouTube's conventions", () => {
  it("splits Artist - Title, and the TITLE beats the channel", () => {
    // Row 3. "TheOtherMau5" is a fan channel; the title says who made it.
    expect(
      resolveTrackName({ title: "Deadmau5 - HR 8938 Cephei (1080p) || HD", artist: "TheOtherMau5" }),
    ).toEqual({ title: "HR 8938 Cephei", artist: "Deadmau5" });
  });

  it("strips upload noise and the VEVO suffix", () => {
    // Row 7.
    expect(
      resolveTrackName({
        title: "Drake - Knife Talk (Official Video) ft. 21 Savage, Project Pat",
        artist: "DrakeVEVO",
      }),
    ).toEqual({ title: "Knife Talk ft. 21 Savage, Project Pat", artist: "Drake" });
  });

  it("handles a plain Artist - Title with a matching channel", () => {
    // Row 6.
    expect(resolveTrackName({ title: "Grimes - Genesis", artist: "Grimes" })).toEqual({
      title: "Genesis",
      artist: "Grimes",
    });
  });

  it("keeps a dashless title and cleans the channel", () => {
    // Row 4 — 'tricot "potage" MV' by "tricot Official Channel". No dash to split, so the title
    // stands (minus the MV tag) and the channel gives the artist.
    expect(resolveTrackName({ title: 'tricot "potage" MV', artist: "tricot Official Channel" })).toEqual({
      title: 'tricot "potage"',
      artist: "tricot",
    });
  });
});

describe("the cleaners, on their own", () => {
  it("artistFromChannel strips network suffixes, not names", () => {
    expect(artistFromChannel("Kanye West - Topic")).toBe("Kanye West");
    expect(artistFromChannel("DrakeVEVO")).toBe("Drake");
    expect(artistFromChannel("tricot Official Channel")).toBe("tricot");
    expect(artistFromChannel("deadmau5")).toBe("deadmau5"); // untouched
    expect(artistFromChannel("MGMT - Topic")).toBe("MGMT");
    expect(artistFromChannel("")).toBe("");
  });

  it("stripUploadNoise never strips a title to nothing", () => {
    // A title that is ENTIRELY a bracketed phrase is a real name, not noise. Returning "" here
    // would put "Unknown track" over a song that told us what it was called.
    expect(stripUploadNoise("(Sandy) Alex G")).toBe("Alex G");
    expect(stripUploadNoise("[Untitled]")).toBe("[Untitled]");
    expect(stripUploadNoise("Song (Official Video) [HD]")).toBe("Song");
  });
});
