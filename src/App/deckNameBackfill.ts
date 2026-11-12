import type { DeckSnapshot } from "@htl";

// A deck can arrive on a track WITHOUT its name.
//
// The follower's tick-resync starts a load from a tick, and a tick carries only a videoId — so
// useSessionSync builds a TrackMeta with `title: ""`, `artist: ""` and loads that. The audio, the
// beatgrid, the BPM and the duration all come out of the decode and are correct; the header reads
// "—". Nothing ever fixed it afterwards: when the authoritative snapshot arrives, the deck already
// HOLDS that videoId, so the snapshot's action is "reconcile", and reconcile applied every control
// field on the deck and never the name sitting right beside them (thread 47468bb9 — observed once
// on a listener, titles blank while duration/BPM/key were right, which is exactly this shape).
//
// So the fix belongs at the snapshot, not at the one load path that happens to lack a name: whoever
// put the track there, the board that owns the track says what it is called. Only blanks are
// filled — a name already on screen is never overwritten by a snapshot echo.

export interface DeckNaming {
  videoId?: string | null;
  name: string;
  artist: string;
  bpm: number | null;
  duration: number;
}

/** The fields this snapshot should fill in on a deck that is missing them, or null if there is
 *  nothing to do. Never renames a deck that already has a name, and never names the wrong track. */
export function deckNamePatch(current: DeckNaming, snap: DeckSnapshot): Partial<DeckNaming> | null {
  if (!snap.videoId || snap.videoId !== current.videoId) return null; // a different track — not ours to name
  const patch: Partial<DeckNaming> = {};
  if (!current.name.trim() && snap.name.trim()) patch.name = snap.name;
  if (!current.artist.trim() && snap.artist.trim()) patch.artist = snap.artist;
  if (current.bpm == null && snap.bpm != null) patch.bpm = snap.bpm;
  if (!current.duration && snap.duration) patch.duration = snap.duration;
  return Object.keys(patch).length ? patch : null;
}

// ★ AND A DECK THAT NOBODY NAMES (operator, 2026-11-12: "a startup bug where song names are not
// completely loaded or partially loaded and the id leaks"). The snapshot backfill above needs a
// board that knows the name. A blank name that got SAVED (the session snapshot is built from the
// deck, so a nameless deck saves a nameless track) comes back on every reload with nobody left to
// say what it is called, and the boot restore never carried a thumbnail at all. So a deck holding
// a catalog id with a blank name, artist or cover asks the library row, then /api/meta. Blanks only,
// and only for the track it was asked about.
export interface DeckLook extends DeckNaming {
  thumbnail?: string | null;
}
export interface TrackLook {
  videoId?: string | null;
  title?: string | null;
  artist?: string | null;
  duration?: number | null;
  thumbnail?: string | null;
}

/** Does this deck hold a catalog track that is missing something a lookup could fill? */
export function deckNeedsLook(d: DeckLook): boolean {
  return !!d.videoId && (!d.name.trim() || !d.artist.trim() || !d.thumbnail);
}

/** The blanks `found` fills on the deck, or null. Never renames, never names the wrong track. */
export function deckLookPatch(current: DeckLook, found: TrackLook): Partial<DeckLook> | null {
  if (!current.videoId || found.videoId !== current.videoId) return null;
  const patch: Partial<DeckLook> = {};
  if (!current.name.trim() && found.title?.trim()) patch.name = found.title;
  if (!current.artist.trim() && found.artist?.trim()) patch.artist = found.artist;
  if (!current.thumbnail && found.thumbnail) patch.thumbnail = found.thumbnail;
  if (!current.duration && found.duration) patch.duration = found.duration;
  return Object.keys(patch).length ? patch : null;
}
