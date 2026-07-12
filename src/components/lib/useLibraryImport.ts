import { useCallback, useRef, useState } from "react";
import { reconcileResync, resyncNeedsMatch, sourceTrackKey, type Library, type Playlist, type TrackMeta } from "@htl/library";
import { fetchPlaylist } from "@htl/media";
import {
  friendlySyncError,
  syncReadSource,
  syncMatch,
  type ServicePlaylist,
  type SourceTrack,
} from "@htl/account";
import { cleanPlaylistName } from "./libraryUtils";

// Navigate to a freshly imported playlist. Narrow stand-in for the panel's setView so the
// hook doesn't need the full View union.
type ViewToPlaylist = (v: { playlistId: string }) => void;

// The library's playlist import / re-sync engine: pull a YouTube or streaming-service
// playlist into the local library, matching service tracks to playable YouTube videos
// (paged to stay under the Worker subrequest cap). Owns the importing/importMsg status the
// sidebar surfaces. Behaviour identical to the inline version it replaced.
export function useLibraryImport(library: Library, setView: ViewToPlaylist) {
  const [importing, setImporting] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null); // the playlist whose ⇄ resync is in flight (per-row spinner, not a global one)
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const msgTimer = useRef<number | null>(null);

  // Set the status line. `ttl` (ms) auto-clears it — but only if it's STILL the same message, so a
  // newer status started meanwhile is never clobbered; any prior auto-clear timer is cancelled first.
  // Terminal messages (success / "kept local" / failures) pass a ttl; in-flight ones don't (they're
  // replaced by the next flash).
  const flash = useCallback((msg: string, ttl?: number) => {
    if (msgTimer.current != null) {
      clearTimeout(msgTimer.current);
      msgTimer.current = null;
    }
    setImportMsg(msg);
    if (ttl) {
      msgTimer.current = window.setTimeout(() => {
        msgTimer.current = null;
        setImportMsg((m) => (m === msg ? null : m));
      }, ttl);
    }
  }, []);

  // Match provider source-tracks to playable YouTube videos (paged to stay under the Worker
  // subrequest cap). Returns each match paired with its SOURCE row so callers can key the
  // sourceMatch map. Shared by import + re-sync.
  async function matchTracksToYouTube(
    tracks: SourceTrack[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ track: TrackMeta; source: SourceTrack }[]> {
    const matched: { track: TrackMeta; source: SourceTrack }[] = [];
    const SLICE = 15;
    for (let i = 0; i < tracks.length; i += SLICE) {
      const rows = await syncMatch("youtube", tracks.slice(i, i + SLICE), i);
      for (const r of rows) {
        if (r.best && r.best.kind === "video") {
          matched.push({
            track: { videoId: r.best.id, title: r.best.title, artist: r.best.artist, duration: r.best.duration, thumbnail: r.best.thumbnail, views: null },
            source: r.source,
          });
        }
      }
      onProgress?.(Math.min(i + SLICE, tracks.length), tracks.length);
    }
    return matched;
  }

  // Import a streaming-service playlist INTO the library: read its tracks, match each to a
  // playable YouTube video (paged), then file the best matches into a local playlist tagged
  // with the source service so it lives under MY SPOTIFY / MY TIDAL. Auto-picks the top
  // match (use Sync for review/fixups). Provider-agnostic — Spotify and TIDAL share it.
  async function importServicePlaylist(service: "spotify" | "tidal", sp: ServicePlaylist) {
    const label = service === "tidal" ? "TIDAL" : "Spotify";
    setImporting(true);
    setImportMsg(`Reading “${sp.title}” from ${label}…`);
    try {
      const { name, tracks } = await syncReadSource(service, sp.id);
      if (!tracks.length) throw new Error("empty playlist");
      const matched = await matchTracksToYouTube(tracks, (done, total) =>
        setImportMsg(`Matching ${done}/${total} from ${label}…`),
      );
      if (!matched.length) throw new Error("no YouTube matches found");
      const cleanTitle = cleanPlaylistName(name || sp.title);
      // Reuse a playlist ONLY if it's the same source list, or an UNLINKED local playlist of this
      // service with the same name (the "link my local copy to its source" case). Never fold into a
      // playlist already linked to a DIFFERENT source — otherwise two distinct source playlists that
      // share a generic name ("Playlist", ".", "Untitled") collapse into one.
      const existing =
        library.playlists.find((p) => p.sourceListId === sp.id) ??
        library.playlists.find(
          (p) => !p.sourceListId && p.sourceService === service && cleanPlaylistName(p.name) === cleanTitle,
        );
      const id = existing?.id ?? library.createPlaylist(cleanTitle, sp.id, service);
      if (existing && !existing.sourceListId) library.linkSource(existing.id, sp.id, service);
      const map: Record<string, string> = { ...(existing?.sourceMatch ?? {}) };
      for (const { track, source } of matched) {
        library.addToPlaylist(id, track);
        map[sourceTrackKey(source)] = track.videoId;
      }
      library.setSourceMatch(id, map);
      setView({ playlistId: id });
      // Unmatched source tracks are dropped silently otherwise — surface the shortfall so a partial
      // import (and any resulting under-count) is visible, not a mystery.
      const dropped = tracks.length - matched.length;
      if (dropped > 0) flash(`Imported ${matched.length} of ${tracks.length} from ${label} — ${dropped} had no YouTube match.`, 5000);
      else setImportMsg(null);
    } catch (e) {
      flash(`${label} import failed — ${friendlySyncError((e as Error).message)}`, 6000);
    } finally {
      setImporting(false);
    }
  }

  // Re-sync an already-imported playlist: re-read the provider's CURRENT tracks and merge
  // any new ones into the local copy (provider playlists have no change hooks). Removed
  // tracks are pruned only for exact-id YouTube sources — matched (Spotify/TIDAL) playlists
  // can re-match to a different video, so we never prune those.
  async function resyncPlaylist(pl: Playlist) {
    if (!pl.sourceListId || !pl.sourceService) return;
    if (importing) {
      flash("Hang on — a sync is already running.", 2500); // don't silently swallow the click
      return;
    }
    const service = pl.sourceService;
    setImporting(true);
    setSyncingId(pl.id);
    setImportMsg(`Re-syncing “${cleanPlaylistName(pl.name)}”…`);
    try {
      // An EMPTY source read — private / deleted / region-blocked, or a transient 200 with no
      // tracks — must NEVER be read as "the playlist is now empty": that would prune a curated copy
      // to nothing. Keep what we have; a genuinely-emptied source is indistinguishable from a failed
      // read here, and not destroying local data is the safe default.
      const keptLocal = () => flash(`Couldn’t read “${cleanPlaylistName(pl.name)}” — kept your local copy.`, 4000);
      const have = new Set(pl.trackIds);
      let added = 0;
      let removed = 0;

      if (service === "youtube") {
        // Exact-id source: the fetched list IS the playlist, so it's authoritative — add new, prune gone.
        const fresh = (await fetchPlaylist(pl.sourceListId)).tracks;
        if (!fresh.length) { keptLocal(); return; }
        for (const t of fresh) if (!have.has(t.videoId)) { library.addToPlaylist(pl.id, t); added++; }
        const freshIds = new Set(fresh.map((t) => t.videoId));
        for (const vid of pl.trackIds) if (!freshIds.has(vid)) { library.removeFromPlaylist(pl.id, vid); removed++; }
      } else if (service === "spotify" || service === "tidal") {
        // Spotify / TIDAL: fuzzy-matched. Follow each song by SOURCE identity (the sourceMatch map),
        // so a re-match that drifts to a different video keeps the song once instead of accreting a
        // duplicate, and only a song actually gone from the source is pruned.
        const { tracks: sources, truncated } = await syncReadSource(service, pl.sourceListId);
        if (!sources.length) { keptLocal(); return; }
        const oldMap = pl.sourceMatch ?? {};
        // Only (re)match songs we don't already carry a live video for — a carried song keeps its
        // exact video, so nothing drifts or churns. Every identity/prune DECISION below is pure and
        // unit-tested (src/htl/library/resync.ts); this just does the network and applies the result.
        const toMatch = resyncNeedsMatch(sources, sourceTrackKey, oldMap, have);
        const pairs = await matchTracksToYouTube(toMatch, (d, n) => setImportMsg(`Matching ${d}/${n}…`));
        const matched: Record<string, string> = {};
        const trackByVid = new Map<string, TrackMeta>();
        for (const { track, source } of pairs) {
          matched[sourceTrackKey(source)] = track.videoId;
          trackByVid.set(track.videoId, track);
        }
        const { newMap, addIds, removeIds } = reconcileResync({
          oldMap,
          currentIds: have,
          sourceKeys: sources.map(sourceTrackKey),
          matched,
          truncated: !!truncated,
        });
        for (const vid of addIds) {
          const t = trackByVid.get(vid);
          if (t) { library.addToPlaylist(pl.id, t); added++; }
        }
        for (const vid of removeIds) { library.removeFromPlaylist(pl.id, vid); removed++; } // always [] on a truncated read
        library.setSourceMatch(pl.id, newMap);
        if (truncated) {
          // The source was too large to read in full (provider page guard) — this is NOT the whole
          // playlist, so NOTHING was pruned (a prune would delete tracks the user never removed).
          library.markSynced(pl.id, Date.now());
          flash(`Synced “${cleanPlaylistName(pl.name)}”: +${added} · playlist too large to read fully — nothing removed.`, 6000);
          return;
        }
      } else {
        return; // unknown service — nothing to re-sync
      }

      library.markSynced(pl.id, Date.now());
      // Make removals EXPLICIT and give them time to read — a re-sync can legitimately nuke a
      // playlist (the source was emptied) and that must never be a silent surprise.
      const summary = added || removed
        ? `Synced “${cleanPlaylistName(pl.name)}”: +${added}${removed ? ` · removed ${removed} no longer in the source` : ""}`
        : "Already up to date";
      flash(summary, removed ? 6000 : 2500);
    } catch (e) {
      flash(`Re-sync failed: ${(e as Error).message}`, 6000);
    } finally {
      setImporting(false);
      setSyncingId(null);
    }
  }

  // Pull a YouTube playlist into the library. Re-importing the same source list does NOT
  // duplicate it: we reuse the existing playlist (matched by its sourceListId OR by
  // normalized name) and merge in any new tracks (addToPlaylist already dedups). The
  // "· via htl" suffix htl stamps onto playlists it syncs OUT to a service is stripped
  // here, so a playlist synced out as "X · via htl" merges back into the local "X" instead
  // of forking a copy — and that local playlist gets linked to the source so subsequent
  // clicks match directly. Throws on failure so callers can surface it (Search modal
  // inline; MY YOUTUBE sidebar toast).
  async function ingestPlaylist(listId: string, fallbackTitle: string): Promise<void> {
    const { title, tracks } = await fetchPlaylist(listId);
    if (tracks.length === 0) throw new Error("no tracks found");
    const cleanTitle = cleanPlaylistName(title || fallbackTitle);
    // Same rule as the service import: reuse the same source list, else an UNLINKED local/YouTube
    // playlist of the same name — never a playlist already linked elsewhere (which would fold a
    // YouTube list into a Spotify/TIDAL one that happens to share a name).
    const existing =
      library.playlists.find((p) => p.sourceListId === listId) ??
      library.playlists.find(
        (p) => !p.sourceListId && (!p.sourceService || p.sourceService === "youtube") && cleanPlaylistName(p.name) === cleanTitle,
      );
    const id = existing?.id ?? library.createPlaylist(cleanTitle, listId, "youtube");
    if (existing && !existing.sourceListId) library.linkSource(existing.id, listId, "youtube");
    for (const t of tracks) library.addToPlaylist(id, t);
    setView({ playlistId: id });
  }

  async function importPlaylistId(listId: string, fallbackTitle: string) {
    setImporting(true);
    setImportMsg(`Importing “${fallbackTitle}”…`);
    try {
      await ingestPlaylist(listId, fallbackTitle);
      setImportMsg(null);
    } catch (e) {
      flash(`Import failed: ${(e as Error).message}`, 6000);
    } finally {
      setImporting(false);
    }
  }

  return { importing, syncingId, importMsg, importServicePlaylist, resyncPlaylist, ingestPlaylist, importPlaylistId };
}
