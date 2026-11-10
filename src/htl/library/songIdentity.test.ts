import { describe, expect, it } from "vitest";
import type { TrackMeta } from "./types";
import {
  cleanliness,
  collapseVersions,
  compareVersions,
  groupVersions,
  recordingKey,
  sameRecording,
  songKey,
  uploadKind,
  versionLabel,
  versionTags,
} from "./songIdentity";

let n = 0;
const t = (title: string, artist: string, duration = 216, extra: Partial<TrackMeta> & { explicit?: boolean } = {}): TrackMeta & { explicit?: boolean } => ({
  videoId: `vid${String(n++).padStart(8, "0")}`,
  title,
  artist,
  duration,
  thumbnail: null,
  views: null,
  ...extra,
});

describe("songIdentity — the operator's Headlock rows (2026-11-10)", () => {
  // Three rows of "Headlock — Imogen Heap", 3:36 / 3:35 / 3:35: a Topic upload, an official one and
  // a lyric page's. One song, one recording.
  const topic = t("Headlock", "Imogen Heap - Topic", 216);
  const official = t("Imogen Heap - Headlock (Official Video)", "ImogenHeapVEVO", 215);
  const lyric = t("Imogen Heap - Headlock (Lyrics)", "7clouds", 215, { bpm: 120.4, key: "6A" });

  it("all three are the same recording", () => {
    expect(sameRecording(topic, official)).toBe(true);
    expect(sameRecording(topic, lyric)).toBe(true);
    expect(sameRecording(official, lyric)).toBe(true);
  });

  it("collapse to one row, the Topic upload, with the other two as versions", () => {
    const g = groupVersions([lyric, official, topic]);
    expect(g).toHaveLength(1);
    expect(g[0].best).toBe(topic);
    expect(g[0].others).toEqual([official, lyric]);
  });

  it("a pinned (loaded) version stays the visible row", () => {
    const g = groupVersions([lyric, official, topic], { pin: (x) => x === lyric });
    expect(g[0].best).toBe(lyric);
    expect(g[0].others).toEqual([topic, official]);
  });
});

describe("songKey / recordingKey — decorations are the same recording", () => {
  const base = t("Teardrop", "Massive Attack - Topic", 330);
  it.each([
    ["Massive Attack - Teardrop (Official Video)", "MassiveAttackVEVO"],
    ["Massive Attack - Teardrop [Official Music Video]", "Massive Attack"],
    ["Teardrop (Official Audio)", "Massive Attack"],
    ["Massive Attack - Teardrop (Lyrics)", "Lyrical Lemonade Archive"],
    ["Teardrop (Remastered 2019)", "Massive Attack - Topic"],
    ["Teardrop (Clean)", "Massive Attack"],
    ["Teardrop (Explicit)", "Massive Attack"],
    ["Massive Attack - Teardrop (Radio Edit)", "Massive Attack"],
    ["Teardrop (Album Version)", "Massive Attack"],
    ["Teardrop (Clean Version)", "Massive Attack Official"],
  ])("%s / %s", (title, artist) => {
    const other = t(title, artist, 331);
    expect(recordingKey(other)).toBe(recordingKey(base));
    expect(sameRecording(base, other)).toBe(true);
  });

  it.each([
    ["Teardrop (Mad Professor Remix)"],
    ["Teardrop (Live at Glastonbury)"],
    ["Teardrop - Live"],
    ["Teardrop (Acoustic)"],
    ["Teardrop (Instrumental)"],
    ["Teardrop (Sped Up)"],
    ["Teardrop (Extended Mix)"],
    ["Teardrop x Angel"],
  ])("%s is a different recording", (title) => {
    const other = t(title, "Massive Attack", 330);
    expect(songKey(other)).toBe(songKey(base)); // same SONG (the automix's never-into-itself)
    expect(sameRecording(base, other)).toBe(false); // not the same RECORDING (the lists keep it)
  });

  it("two remixes are two recordings", () => {
    expect(sameRecording(t("Headlock (Club Mix)", "Imogen Heap"), t("Headlock (Ron van den Beuken Mix)", "Imogen Heap"))).toBe(false);
  });

  it("the same song name by another act is not merged", () => {
    expect(sameRecording(t("Hold On", "Wilson Phillips"), t("Hold On", "Chord Overstreet"))).toBe(false);
  });

  it("the same act and name but lengths 3 s+ apart are different songs", () => {
    expect(sameRecording(t("Intro", "The xx", 128), t("Intro", "The xx", 200))).toBe(false);
    expect(sameRecording(t("Intro", "The xx", 128), t("Intro", "The xx", 131))).toBe(true);
    expect(sameRecording(t("Intro", "The xx", 128), t("Intro", "The xx", 0))).toBe(true); // unknown length
  });

  it("a radio edit is excused its shorter length", () => {
    expect(sameRecording(t("Titanium", "David Guetta", 245), t("Titanium (Radio Edit)", "David Guetta", 205))).toBe(true);
  });

  // Both from the production Community pool, 2026-11-10.
  it("a radio edit of a LIVE album is the live recording, not the studio one", () => {
    const studio = t("Harder, Better, Faster, Stronger", "Daft Punk - Topic", 226);
    expect(sameRecording(studio, t("Harder, Better, Faster, Stronger (Alive Radio Edit 2007)", "Daft Punk - Topic", 205))).toBe(false);
    expect(sameRecording(studio, t("Harder, Better, Faster, Stronger (Radio Edit)", "Daft Punk - Topic", 205))).toBe(true);
  });
  it("accents do not split an act or a title", () => {
    expect(sameRecording(t("Venus as a Boy", "Björk - Topic", 283), t("Bjork - Venus As A Boy", "BjorkVEVO", 284))).toBe(true);
    expect(sameRecording(t("Te Boté (Remix)", "Nio Garcia - Topic", 418), t("Te Bote (Remix)", "Nio Garcia", 418))).toBe(true);
    expect(uploadKind(t("Björk - Venus As A Boy", "BjorkVEVO"))).toBe("artist");
  });

  it("feat. credits do not split a recording", () => {
    const a = t("WAP (feat. Megan Thee Stallion)", "Cardi B", 188);
    const b = t("Cardi B - WAP feat. Megan Thee Stallion [Official Music Video]", "Cardi B", 190);
    expect(sameRecording(a, b)).toBe(true);
  });

  it("Taylor's Version is its own recording", () => {
    expect(sameRecording(t("Love Story", "Taylor Swift", 235), t("Love Story (Taylor's Version)", "Taylor Swift", 236))).toBe(false);
  });

  it("an unknown act or title never groups", () => {
    expect(songKey(t("Teardrop", ""))).toBe("");
    expect(sameRecording(t("Teardrop", ""), t("Teardrop", ""))).toBe(false);
  });
});

describe("versionTags", () => {
  it("is empty for the original, whatever the promo copy", () => {
    expect(versionTags("Teardrop (Official Video) [HD]")).toBe("");
    expect(versionTags("Teardrop (Remastered 2019)")).toBe("");
    expect(versionTags("Teardrop (Clean)")).toBe("");
    expect(versionTags("Teardrop (Radio Edit)")).toBe("");
    expect(versionTags("Teardrop (Original Mix)")).toBe("");
  });
  it("names the version", () => {
    expect(versionTags("Teardrop (Mad Professor Remix)")).toBe("mad professor remix");
    expect(versionTags("Teardrop - Extended Mix")).toBe("extended mix");
    expect(versionTags("Teardrop Live at Glastonbury")).toBe("live at glastonbury");
  });
});

describe("cleanliness", () => {
  it("the YouTube Music explicit badge is explicit", () => {
    expect(cleanliness({ title: "WAP (feat. Megan Thee Stallion)", explicit: true })).toBe("explicit");
  });
  it.each([
    ["Nicki Minaj - Moment 4 Life (Clean Version) (Official Music Video) ft. Drake"],
    ["WAP (Clean)"],
    ["WAP [Clean]"],
    ["Without Me (Radio Edit)"],
    ["Without Me (Edited)"],
    ["Eminem - Without Me (Censored)"],
    ["Without Me - Clean"],
  ])("%s is censored", (title) => expect(cleanliness({ title })).toBe("censored"));
  it.each([["WAP (Explicit)"], ["Without Me (Uncensored)"], ["Gasolina (Dirty Version)"], ["Get Low [Dirty]"]])(
    "%s is explicit",
    (title) => expect(cleanliness({ title })).toBe("explicit"),
  );
  it.each([["Clean"], ["Squeaky Clean"], ["Dirty Little Secret"], ["Headlock"], ["Teardrop (Official Video)"]])(
    "%s says nothing either way",
    (title) => expect(cleanliness({ title })).toBe("unknown"),
  );
});

describe("uploadKind", () => {
  it("reads the upload", () => {
    expect(uploadKind(t("Headlock", "Imogen Heap - Topic"))).toBe("topic");
    expect(uploadKind(t("Imogen Heap - Headlock (Official Audio)", "Imogen Heap"))).toBe("audio");
    expect(uploadKind(t("Imogen Heap - Headlock (Official Video)", "ImogenHeapVEVO"))).toBe("video");
    expect(uploadKind(t("Headlock", "Imogen Heap"))).toBe("artist");
    expect(uploadKind(t("Imogen Heap - Headlock (Lyrics)", "7clouds"))).toBe("other");
  });
});

describe("versionLabel", () => {
  it("names what an upload is, for a menu where the titles truncate alike", () => {
    expect(versionLabel(t("One More Time", "Daft Punk - Topic"))).toBe("Album audio");
    expect(versionLabel(t("Daft Punk - One More Time (Official Video)", "Daft Punk"))).toBe("Video");
    expect(versionLabel(t("Daft Punk - One More Time (Lyrics)", "LyricsZone"))).toBe("Lyric upload");
    expect(versionLabel(t("WAP (Clean)", "Cardi B - Topic"))).toBe("Album audio · clean");
    expect(versionLabel(t("WAP", "Cardi B", 188, { explicit: true }))).toBe("Artist upload · explicit");
  });
});

describe("compareVersions — uncensored first, then the album audio", () => {
  it("explicit > unknown > censored, before anything else", () => {
    const clean = t("WAP (Clean)", "Cardi B - Topic", 188);
    const plain = t("Cardi B - WAP [Lyrics]", "Lyrics Hub", 188);
    const badge = t("WAP (feat. Megan Thee Stallion)", "Cardi B", 188, { explicit: true });
    expect([clean, plain, badge].sort(compareVersions)).toEqual([badge, plain, clean]);
  });
  it("Topic > official audio > the act's own plain upload > music video > lyric/fan", () => {
    const vid = t("Imogen Heap - Headlock (Official Video)", "ImogenHeapVEVO");
    const lyr = t("Imogen Heap - Headlock (Lyrics)", "7clouds");
    const aud = t("Headlock (Official Audio)", "Imogen Heap");
    const top = t("Headlock", "Imogen Heap - Topic");
    const own = t("Headlock", "Imogen Heap");
    expect([vid, lyr, aud, top, own].sort(compareVersions)).toEqual([top, aud, own, vid, lyr]);
  });
  it("then analysed, then views", () => {
    const a = t("Headlock (Lyrics)", "fan one", 216, { views: 5 });
    const b = t("Headlock (Lyrics)", "fan two", 216, { views: 500 });
    const c = t("Headlock (Lyrics)", "fan three", 216, { views: 1, bpm: 120, key: "6A" });
    expect([a, b, c].sort(compareVersions)).toEqual([c, b, a]);
  });
});

describe("collapseVersions — search results", () => {
  it("keeps one row per recording, in first-appearance order, and the censored one only when alone", () => {
    const wapExplicit = t("WAP (feat. Megan Thee Stallion)", "Cardi B", 188, { explicit: true });
    const wapClean = t("WAP (feat. Megan Thee Stallion)", "Cardi B", 188);
    const wapCleanTitled = t("Cardi B - WAP (Clean) ft. Megan Thee Stallion", "Cardi B", 187);
    const onlyClean = t("Get Up 10 (Clean)", "Cardi B", 232);
    const remix = t("WAP (Remix)", "Cardi B", 200);
    const out = collapseVersions([wapClean, onlyClean, wapCleanTitled, remix, wapExplicit]);
    expect(out).toEqual([wapExplicit, onlyClean, remix]);
  });
  it("keeps every track exactly once across best + others", () => {
    const list = [t("A", "x"), t("A (Lyrics)", "x"), t("B", "x"), t("A (Live)", "x"), t("A", "y")];
    const g = groupVersions(list);
    const all = g.flatMap((x) => [x.best, ...x.others]);
    expect(all).toHaveLength(list.length);
    expect(new Set(all).size).toBe(list.length);
    expect(g).toHaveLength(4);
  });
});
