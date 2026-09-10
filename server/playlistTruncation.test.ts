import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPlaylistData } from "./ytdata";
import { getTidalPlaylistTracks, getTidalPlaylistName } from "./tidalData";
import { getSpotifyPlaylistName } from "./spotifyData";
import { playlistTruncated } from "./innertube";

// THE `truncated` FLAGS HAVE NEVER BEEN SEEN TO FIRE (thread fefb7f01, item 2).
//
// They were filed as un-verifiable because "you need a genuinely oversized playlist" — a real
// 600+ track YouTube list or a 1200-track TIDAL one, against the operator's own accounts. That is
// true of an END-TO-END check and false of the flag itself: what decides `truncated` is whether a
// page cursor is still in hand when the loop stops, and a stub can hand back cursors all day.
//
// ★ WHY THIS FLAG IS WORTH REAL TESTS RATHER THAN A GLANCE. It is not cosmetic — it is a SAFETY
// INTERLOCK. resync prunes anything it does not see, so a read that stopped early and reported
// itself complete would delete the entire unread tail of the user's playlist. The failure is
// silent, destructive, and lands on the largest playlists (the ones that page), which are exactly
// the ones a user would least like emptied. A flag that fails CLOSED (says truncated when it is
// not) costs a skipped prune; failing OPEN costs the data.

afterEach(() => vi.unstubAllGlobals());

/** Serve a scripted queue of JSON bodies to whatever calls fetch, in order. */
function serve(bodies: unknown[]) {
  let i = 0;
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const body = bodies[Math.min(i++, bodies.length - 1)];
      // ytdata's helper reads .json(); tidalData's reads .text() and parses. Serve both, so the
      // stub does not quietly decide which module it supports.
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }),
  );
  return calls;
}

const ytPage = (ids: string[], next?: string) => ({
  items: ids.map((id) => ({ snippet: { title: id, resourceId: { videoId: id } } })),
  ...(next ? { nextPageToken: next } : {}),
});
const vid = (n: number) => `v${String(n).padStart(10, "0")}`; // 11 chars, matches the id guard

describe("YouTube playlist paging reports a short read", () => {
  it("stops at MAX_ITEM_PAGES with a token still in hand → truncated", async () => {
    // 12 pages is the cap. Every page hands back a next-token, so the loop exits on the COUNT
    // while a cursor is still live — the exact state the flag exists to report.
    const pages = Array.from({ length: 13 }, (_, p) => ytPage([vid(p)], `tok${p + 1}`));
    serve([{ items: [{ snippet: { title: "Big list" } }] }, ...pages, { items: [] }]);
    const r = await fetchPlaylistData("t", "PL1");
    expect(r.truncated).toBe(true);
  });

  it("runs out of pages naturally → NOT truncated", async () => {
    // The other half, and the one that matters for prune safety in the opposite direction: a
    // complete read must not claim to be partial, or re-sync never prunes anything again.
    serve([
      { items: [{ snippet: { title: "Small list" } }] },
      ytPage([vid(1), vid(2)]), // no nextPageToken → the list ended
      { items: [] }, // the videos.list enrichment call
    ]);
    const r = await fetchPlaylistData("t", "PL2");
    expect(r.truncated).toBe(false);
    expect(r.tracks).toHaveLength(2);
  });

  it("an EMPTY playlist is complete, not truncated", async () => {
    // The dangerous edge for a destructive consumer: "I saw nothing" must mean the list is empty,
    // never "I could not finish reading". Both produce zero tracks; only the flag tells them apart.
    serve([{ items: [{ snippet: { title: "Empty" } }] }, ytPage([]), { items: [] }]);
    const r = await fetchPlaylistData("t", "PL3");
    expect(r.tracks).toHaveLength(0);
    expect(r.truncated).toBe(false);
  });
});

describe("TIDAL playlist paging reports a short read", () => {
  const tidalPage = (ids: string[], next?: string | null) => ({
    data: ids.map((id) => ({ type: "tracks", id })),
    included: ids.map((id) => ({
      type: "tracks",
      id,
      attributes: { title: `T${id}`, duration: "PT3M", isrc: `ISRC${id}` },
    })),
    links: { next: next ?? null },
  });

  it("trips the 60-page guard with a next link still set → truncated", async () => {
    // Every page points at another page, forever. The guard stops it; `url` is still non-null,
    // which is precisely how this one decides.
    serve([tidalPage(["1"], "https://openapi.tidal.com/v2/next")]);
    const r = await getTidalPlaylistTracks("t", "p1");
    expect(r.truncated).toBe(true);
    expect(r.tracks).toHaveLength(60); // 60 pages x 1 track — the guard's own count, not a guess
  });

  it("a last page with links.next null → NOT truncated", async () => {
    serve([tidalPage(["1", "2"], null)]);
    const r = await getTidalPlaylistTracks("t", "p2");
    expect(r.truncated).toBe(false);
    expect(r.tracks).toHaveLength(2);
  });
});

describe("the innertube rule: a pending continuation, never the declared count", () => {
  it("has_continuation true → truncated", () => {
    expect(playlistTruncated({ has_continuation: true })).toBe(true);
  });

  it("IGNORES total_items — the trap that would mark a finished playlist truncated forever", () => {
    // The live-API shape from 2026-09-01: a 13-item playlist that hands back 10 available videos
    // with no continuation. The three missing ones are deleted/private and still counted in the
    // total. Any implementation comparing tracks-read against total_items says "truncated" here,
    // forever, on every re-read — and `truncated` gates pruning, so the user's local copy would
    // keep tracks that were deleted at the source permanently.
    expect(playlistTruncated({ has_continuation: false, total_items: "13 videos" })).toBe(false);
  });

  it("is not fooled by a numeric total either", () => {
    // The string form killed the ORIGINAL check (typeof total === "number" never fired). Fixing
    // the type would not fix the rule — the count is wrong for this purpose in any representation.
    expect(playlistTruncated({ has_continuation: false, total_items: 13 })).toBe(false);
  });

  it("fails CLOSED on a malformed or missing tail", () => {
    // Deliberate asymmetry. Defaulting to `true` on garbage looks conservative and is the worse
    // bug: truncated means never-prune, which is silent and permanent. "We finished" at worst
    // prunes a tail we did read.
    expect(playlistTruncated(undefined)).toBe(false);
    expect(playlistTruncated(null)).toBe(false);
    expect(playlistTruncated({})).toBe(false);
    expect(playlistTruncated({ has_continuation: undefined })).toBe(false);
  });

  it("demands exactly true — no truthy coercion", () => {
    // has_continuation arrives from an untyped third-party object; "false" and 1 are both things
    // a JSON shape can hand you, and `=== true` is what keeps either from deciding a prune.
    expect(playlistTruncated({ has_continuation: "true" as unknown as boolean })).toBe(false);
    expect(playlistTruncated({ has_continuation: 1 as unknown as boolean })).toBe(false);
  });
});

describe("playlist NAME endpoints parse the shape they were written against", () => {
  it("Spotify: fields=name returns a top-level string", async () => {
    // VERIFIED 2026-09-10 against developer.spotify.com's own Get Playlist reference:
    // GET /playlists/{id}?fields=name → {"name": "..."}, name a top-level string. The endpoint
    // shape in this repo was written from code, never from a live response (thread fefb7f01);
    // this is the doc-confirmed shape, pinned.
    serve([{ name: "Late night" }]);
    expect(await getSpotifyPlaylistName("t", "37i9")).toBe("Late night");
  });

  it("Spotify: a shape with no name degrades to \"\", never undefined", async () => {
    // sync.ts hands this straight to the client as the playlist's display name. `undefined` there
    // would render as the string "undefined" in the library; "" is what triggers the intended
    // fallback to the title the client already holds.
    serve([{}]);
    expect(await getSpotifyPlaylistName("t", "37i9")).toBe("");
  });

  it("TIDAL: accepts `name` OR `title`, and `data` as object OR array", async () => {
    // NOT doc-verified: TIDAL's developer portal renders its reference client-side, so neither the
    // portal nor the published API-reference mirror could be read as text on 2026-09-10. What is
    // testable is that the parser is deliberately CATHOLIC about the shape — which is why the
    // unverified endpoint has never mattered in practice. Four shapes, one answer.
    serve([{ data: { attributes: { name: "Mix A" } } }]);
    expect(await getTidalPlaylistName("t", "p")).toBe("Mix A");
    serve([{ data: { attributes: { title: "Mix B" } } }]);
    expect(await getTidalPlaylistName("t", "p")).toBe("Mix B");
    serve([{ data: [{ attributes: { name: "Mix C" } }] }]);
    expect(await getTidalPlaylistName("t", "p")).toBe("Mix C");
    serve([{ data: {} }]);
    expect(await getTidalPlaylistName("t", "p")).toBe("");
  });
});
