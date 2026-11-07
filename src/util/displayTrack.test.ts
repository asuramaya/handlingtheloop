import { describe, expect, it } from "vitest";
import { displayArtist, displayTrack } from "./format";

// Real titles from the operator's queue (2026-11-04). Display only — stored data is untouched.
describe("displayTrack", () => {
  const d = (title: string, artist: string) => displayTrack(title, artist);

  it("drops the artist prefix when the channel IS the artist, and the upload clutter", () => {
    expect(d("Nicki Minaj - Moment 4 Life (Clean Version) (Official Music Video) ft. Drake", "Nicki Minaj")).toEqual({
      title: "Moment 4 Life (Clean Version) ft. Drake", // Clean matters to a DJ; "Official Music Video" does not
      artist: "Nicki Minaj",
    });
    expect(d("Katy Perry - Last Friday Night (T.G.I.F.) (Official Music Video)", "Katy Perry")).toEqual({
      title: "Last Friday Night (T.G.I.F.)",
      artist: "Katy Perry",
    });
  });

  it("takes the real artist from the title when the channel is a label or a lyrics page", () => {
    expect(d("T.I. - Whatever You Like (Official Video)", "Atlantic Records")).toEqual({ title: "Whatever You Like", artist: "T.I." });
    expect(d("Imogen Heap - Headlock (Lyrics)", "Lyrical Lemonade Fan")).toEqual({ title: "Headlock", artist: "Imogen Heap" });
    expect(d("Grimes | Oblivion", "4AD")).toEqual({ title: "Oblivion", artist: "Grimes" });
  });

  it("strips bare trailing clutter and wrapping quotes", () => {
    expect(d("Red Flags (ft. Montaigne) OFFICIAL VIDEO", "Mashd N Kutcher")).toEqual({ title: "Red Flags (ft. Montaigne)", artist: "Mashd N Kutcher" });
    expect(d('Blackway & Black Caviar - "What\'s Up Danger" (Spider-Man: Into the Spider-Verse)', "Blackway").title).toBe(
      "What's Up Danger (Spider-Man: Into the Spider-Verse)",
    );
  });

  it("keeps what a DJ needs to tell versions apart", () => {
    expect(d("Titanium - Extended Mix", "David Guetta")).toEqual({ title: "Titanium - Extended Mix", artist: "David Guetta" });
    expect(d("Levels (Avicii Remix) [Official Audio]", "Avicii").title).toBe("Levels (Avicii Remix)");
    expect(d("Hold On (Live)", "Alabama Shakes").title).toBe("Hold On (Live)");
  });

  it("does not split when the right-hand side is only clutter (the song is on the left)", () => {
    expect(d("Danza Kuduro - Official Video", "Don Omar")).toEqual({ title: "Danza Kuduro", artist: "Don Omar" });
  });

  it("reads a 'Song - Artist' upload the right way round when the channel names the right side", () => {
    expect(d("Bad Romance - Lady Gaga", "Lady Gaga")).toEqual({ title: "Bad Romance", artist: "Lady Gaga" });
  });

  it("never blanks a title, and leaves a plain one alone", () => {
    expect(d("Official Video", "X")).toEqual({ title: "Official Video", artist: "X" });
    expect(d("Washing Machine Heart", "Mitski")).toEqual({ title: "Washing Machine Heart", artist: "Mitski" });
    expect(d("", "")).toEqual({ title: "", artist: "" });
  });
});

describe("displayArtist and VEVO", () => {
  it("drops a VEVO suffix the way it drops ' - Topic'", () => {
    expect(displayArtist("RihannaVEVO")).toBe("Rihanna");
    expect(displayArtist("KatyPerryVEVO")).toBe("KatyPerry");
    expect(displayArtist("VEVO")).toBe("VEVO");
  });
});
