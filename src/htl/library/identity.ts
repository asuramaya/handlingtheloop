// Track identity + dedupe. A "track" reaches the collection from several paths (a bare
// id, a pasted URL, a YouTube search hit, an unresolved catalog row from Spotify/Tidal),
// so comparing raw `videoId` strings double-adds the same recording — or, worse, COLLAPSES
// two distinct catalog tracks that both carry an empty videoId until they're resolved.
// `trackKey` gives one stable identity for all of those forms.
import type { TrackMeta } from "./types";

const BARE_ID = /^[\w-]{11}$/;

/** Canonical YouTube id from a raw value: a bare 11-char id (case PRESERVED — YouTube ids
 *  are case-sensitive base64url, lowercasing would corrupt them) or the id extracted from
 *  any youtube.com / youtu.be / shorts / embed URL. Returns "" when the input isn't a
 *  YouTube id (e.g. an unresolved catalog track) so the caller falls back to an anchor. */
export function canonicalVideoId(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (BARE_ID.test(s)) return s;
  try {
    const url = new URL(s);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1);
      return BARE_ID.test(id) ? id : "";
    }
    if (url.hostname.endsWith("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v && BARE_ID.test(v)) return v;
      const m = url.pathname.match(/\/(?:shorts|embed)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* not a URL — fall through */
  }
  return "";
}

type Anchored = Pick<TrackMeta, "videoId" | "isrc" | "provider" | "providerId" | "title" | "artist">;

/** Stable identity for a track across the app's id forms. A real YouTube id wins
 *  (canonicalized); an unresolved catalog track (empty videoId) falls back to its
 *  cross-service anchor — ISRC, else `provider:providerId` — mirroring resolvePlayable's
 *  anchorKey so the catalog and library layers agree on identity. Last resort is a
 *  normalized title|artist, so two genuinely-identical catalog rows still dedupe while
 *  DISTINCT ones never collide on a shared empty videoId (the old `videoId === videoId`
 *  bug, which silently dropped the second Spotify/Tidal add). */
export function trackKey(t: Anchored): string {
  const id = canonicalVideoId(t.videoId);
  if (id) return `yt:${id}`;
  if (t.isrc) return `isrc:${t.isrc.toUpperCase()}`;
  if (t.provider && t.providerId) return `${t.provider}:${t.providerId}`;
  return `q:${(t.artist ?? "").trim().toLowerCase()}|${(t.title ?? "").trim().toLowerCase()}`;
}

/** A copy of the track with its videoId canonicalized (URL/whitespace forms collapsed to
 *  the bare id). Leaves an unresolved catalog track's empty videoId untouched. */
export function canonicalizeTrack<T extends TrackMeta>(t: T): T {
  const id = canonicalVideoId(t.videoId);
  return id && id !== t.videoId ? { ...t, videoId: id } : t;
}

/** True when two tracks are the same recording by `trackKey`. */
export function sameTrack(a: Anchored, b: Anchored): boolean {
  return trackKey(a) === trackKey(b);
}
