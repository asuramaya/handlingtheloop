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
