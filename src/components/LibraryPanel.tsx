import { useMemo, useState } from "react";
import type { Library } from "@htl/library";
import type { TrackMeta } from "@htl/library";
import { getCachedTrack } from "@htl/audio";
import { fetchPlaylist } from "@htl/media";
import { Explorer } from "./Explorer";
import { TrackTable } from "./TrackTable";

// Show a tempo for any track that's been analyzed this session, even if it was
// saved before it was first loaded to a deck.
function withCachedBpm(t: TrackMeta): TrackMeta {
  if (t.bpm != null) return t;
  const bpm = getCachedTrack(t.videoId)?.analysis.bpm;
  return bpm != null ? { ...t, bpm } : t;
}

interface LibraryPanelProps {
  library: Library;
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  loadedIds: Set<string>;
  onOpenSettings: () => void;
}

type View = "explorer" | "collection" | { playlistId: string };

export function LibraryPanel({ library, onLoad, loadedIds, onOpenSettings }: LibraryPanelProps) {
  const [view, setView] = useState<View>("explorer");
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const byId = useMemo(() => {
    const m = new Map<string, TrackMeta>();
    for (const t of library.collection) m.set(t.videoId, t);
    return m;
  }, [library.collection]);

  const inCollection = (videoId: string) => byId.has(videoId);

  const isPlaylist = typeof view === "object";
  const activePlaylistId = isPlaylist ? view.playlistId : null;

  async function importPlaylist() {
    const url = importUrl.trim();
    if (!url) return;
    setImporting(true);
    setImportMsg("Importing…");
    try {
      const { title, tracks } = await fetchPlaylist(url);
      if (tracks.length === 0) throw new Error("no tracks found");
      const id = library.createPlaylist(title);
      for (const t of tracks) library.addToPlaylist(id, t);
      setImportUrl("");
      setImportMsg(`Imported ${tracks.length} tracks`);
      setView({ playlistId: id });
    } catch (e) {
      setImportMsg(`Import failed: ${(e as Error).message}`);
    } finally {
      setImporting(false);
    }
  }

  function createPlaylist() {
    const name = window.prompt("Playlist name", "New playlist");
    if (name) setView({ playlistId: library.createPlaylist(name) });
  }

  return (
    <div className="library">
      <aside className="lib-sidebar">
        <button
          className={`lib-nav ${view === "explorer" ? "active" : ""}`}
          onClick={() => setView("explorer")}
        >
          <span className="lib-nav-ico">🔎</span> Explorer
        </button>
        <button
          className={`lib-nav ${view === "collection" ? "active" : ""}`}
          onClick={() => setView("collection")}
        >
          <span className="lib-nav-ico">💿</span> Collection
          <span className="lib-count">{library.collection.length}</span>
        </button>
        <button className="lib-nav lib-settings-nav" onClick={onOpenSettings} title="Settings">
          <span className="lib-nav-ico">⚙</span> Settings
        </button>

        <div className="lib-section">
          <span>PLAYLISTS</span>
          <button className="lib-add" title="New playlist" onClick={createPlaylist}>
            +
          </button>
        </div>
        <div className="lib-playlists">
          {library.playlists.map((p) => (
            <button
              key={p.id}
              className={`lib-nav small ${activePlaylistId === p.id ? "active" : ""}`}
              onClick={() => setView({ playlistId: p.id })}
            >
              <span className="lib-nav-ico">🎵</span>
              <span className="lib-pl-name" title={p.name}>
                {p.name}
              </span>
              <span className="lib-count">{p.trackIds.length}</span>
              <span
                className="lib-del"
                title="Delete playlist"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete playlist "${p.name}"?`)) {
                    library.deletePlaylist(p.id);
                    if (activePlaylistId === p.id) setView("collection");
                  }
                }}
              >
                ✕
              </span>
            </button>
          ))}
        </div>

        <div className="lib-import">
          <input
            className="yt-input"
            placeholder="Import playlist URL…"
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && importPlaylist()}
          />
          <button className="btn small" disabled={importing || !importUrl.trim()} onClick={importPlaylist}>
            {importing ? "…" : "Import"}
          </button>
          {importMsg && <div className="lib-import-msg">{importMsg}</div>}
        </div>
      </aside>

      <div className="lib-main">
        {view === "explorer" && (
          <Explorer onLoad={onLoad} onAdd={library.addTrack} inCollection={inCollection} />
        )}
        {view === "collection" && (
          <TrackTable
            tracks={library.collection.map(withCachedBpm)}
            onLoad={onLoad}
            onRemove={library.removeTrack}
            removeTitle="Remove from collection"
            emptyHint="Your collection is empty. Find tracks in the Explorer and add them with +."
            loadedIds={loadedIds}
          />
        )}
        {isPlaylist &&
          (() => {
            const pl = library.playlists.find((p) => p.id === activePlaylistId);
            if (!pl) return <div className="lib-empty">Playlist not found.</div>;
            const tracks = pl.trackIds
              .map((id) => byId.get(id))
              .filter((t): t is TrackMeta => t !== undefined)
              .map(withCachedBpm);
            return (
              <TrackTable
                tracks={tracks}
                onLoad={onLoad}
                onRemove={(vid) => library.removeFromPlaylist(pl.id, vid)}
                removeTitle="Remove from playlist"
                emptyHint="Empty playlist. Add tracks from the Explorer or Collection."
                loadedIds={loadedIds}
              />
            );
          })()}
      </div>
    </div>
  );
}
