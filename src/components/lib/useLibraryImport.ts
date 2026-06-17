import { useState } from "react";
import type { Library, Playlist, TrackMeta } from "@htl/library";
import { fetchPlaylist } from "@htl/media";
import {
  friendlySyncError,
  syncReadSource,
  syncMatch,
  type ServicePlaylist,
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
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // Match provider source-tracks to playable YouTube videos (paged to stay under the
  // Worker subrequest cap). Shared by import + re-sync.
  async function matchTracksToYouTube(
    tracks: Parameters<typeof syncMatch>[1],
    onProgress?: (done: number, total: number) => void,
  ): Promise<TrackMeta[]> {
    const matched: TrackMeta[] = [];
    const SLICE = 15;
    for (let i = 0; i < tracks.length; i += SLICE) {
      const rows = await syncMatch("youtube", tracks.slice(i, i + SLICE), i);
      for (const r of rows) {
        if (r.best && r.best.kind === "video") {
          matched.push({ videoId: r.best.id, title: r.best.title, artist: r.best.artist, duration: r.best.duration, thumbnail: r.best.thumbnail, views: null });
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
      const existing =
        library.playlists.find((p) => p.sourceListId === sp.id) ??
        library.playlists.find((p) => p.sourceService === service && cleanPlaylistName(p.name) === cleanTitle);
      const id = existing?.id ?? library.createPlaylist(cleanTitle, sp.id, service);
      if (existing && !existing.sourceListId) library.linkSource(existing.id, sp.id, service);
      for (const t of matched) library.addToPlaylist(id, t);
      setView({ playlistId: id });
      setImportMsg(null);
    } catch (e) {
      setImportMsg(`${label} import failed — ${friendlySyncError((e as Error).message)}`);
    } finally {
      setImporting(false);
    }
  }

  // Re-sync an already-imported playlist: re-read the provider's CURRENT tracks and merge
  // any new ones into the local copy (provider playlists have no change hooks). Removed
  // tracks are pruned only for exact-id YouTube sources — matched (Spotify/TIDAL) playlists
  // can re-match to a different video, so we never prune those.
  async function resyncPlaylist(pl: Playlist) {
    if (!pl.sourceListId || !pl.sourceService || importing) return;
    const service = pl.sourceService;
    setImporting(true);
    setImportMsg(`Re-syncing “${cleanPlaylistName(pl.name)}”…`);
    try {
      let fresh: TrackMeta[];
      if (service === "youtube") {
        fresh = (await fetchPlaylist(pl.sourceListId)).tracks;
      } else if (service === "spotify" || service === "tidal") {
        const { tracks } = await syncReadSource(service, pl.sourceListId);
        fresh = await matchTracksToYouTube(tracks, (d, n) => setImportMsg(`Matching ${d}/${n}…`));
      } else {
        return;
      }
      const have = new Set(pl.trackIds);
      let added = 0;
      for (const t of fresh) if (!have.has(t.videoId)) { library.addToPlaylist(pl.id, t); added++; }
      let removed = 0;
      if (service === "youtube") {
        const freshIds = new Set(fresh.map((t) => t.videoId));
        for (const vid of pl.trackIds) if (!freshIds.has(vid)) { library.removeFromPlaylist(pl.id, vid); removed++; }
      }
      library.markSynced(pl.id, Date.now());
      setImportMsg(added || removed ? `Synced “${cleanPlaylistName(pl.name)}”: +${added}${removed ? ` −${removed}` : ""}` : "Already up to date");
      window.setTimeout(() => setImportMsg((m) => (m && m.startsWith("Synced") || m === "Already up to date" ? null : m)), 2500);
    } catch (e) {
      setImportMsg(`Re-sync failed: ${(e as Error).message}`);
    } finally {
      setImporting(false);
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
    const existing =
      library.playlists.find((p) => p.sourceListId === listId) ??
      library.playlists.find((p) => cleanPlaylistName(p.name) === cleanTitle);
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
      setImportMsg(`Import failed: ${(e as Error).message}`);
    } finally {
      setImporting(false);
    }
  }

  return { importing, importMsg, importServicePlaylist, resyncPlaylist, ingestPlaylist, importPlaylistId };
}
