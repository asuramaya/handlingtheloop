import { useEffect, useMemo, useRef, useState } from "react";
import type { Library, Playlist } from "@htl/library";
import type { TrackMeta } from "@htl/library";
import { getCachedTrack } from "@htl/audio";
import {
  fetchPlaylist,
  fetchMyPlaylists,
  fetchCommunity,
  fetchMeta,
  putCommunityMeta,
  type MyPlaylist,
} from "@htl/media";
import {
  fetchMe,
  fetchSpotifyPlaylists,
  syncReadSource,
  syncMatch,
  type Me,
  type ServicePlaylist,
} from "@htl/account";
import { Store } from "@htl/persistence";

// Backfilled metadata for community (legacy-cached) tracks, persisted so titles
// survive reloads and we don't re-hit /api/meta on every library open.
type CachedMeta = { title: string; artist: string; duration: number; thumbnail: string | null };
const communityMeta = new Store<Record<string, CachedMeta>>("community-meta", {}, 1);
import { SearchModal } from "./SearchModal";
import { SyncPanel } from "./SyncPanel";
import { TRACK_DND_MIME, TrackTable } from "./TrackTable";
import { ConfirmModal, PromptModal } from "./Dialog";
import { DockResizer } from "./DockResizer";

// In-app dialog state (replaces window.prompt / window.confirm).
type DialogState =
  | { kind: "prompt"; title: string; initial: string; submitLabel: string; onSubmit: (v: string) => void }
  | { kind: "confirm"; title: string; message: string; confirmLabel: string; onConfirm: () => void }
  | null;

// Strip the "· via htl" marker htl appends to playlists it syncs out to a service,
// so the same playlist reads the same on either side and dedups by name.
function cleanPlaylistName(title: string): string {
  return title.replace(/\s*·\s*via htl\s*$/i, "").trim();
}

// Show tempo + key for any track analyzed this session, even if it was saved
// before it was first loaded to a deck (persisted values win once they exist).
function withCached(t: TrackMeta): TrackMeta {
  if (t.bpm != null && t.key != null) return t;
  const a = getCachedTrack(t.videoId)?.analysis;
  if (!a) return t;
  return {
    ...t,
    bpm: t.bpm ?? a.bpm ?? null,
    key: t.key ?? a.key?.camelot ?? null,
  };
}

interface LibraryPanelProps {
  library: Library;
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  loadedIds: Set<string>;
  open?: boolean; // the floating library panel is shown (defaults to visible)
  onOpenChange?: (open: boolean) => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
}

type View = "collection" | "community" | { playlistId: string };

export function LibraryPanel({
  library,
  onLoad,
  loadedIds,
  open = true,
  onOpenChange = () => {},
  searchOpen,
  onSearchOpenChange,
}: LibraryPanelProps) {
  const [view, setView] = useState<View>("collection");
  const [syncOpen, setSyncOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // The signed-in user's own YouTube playlists.
  const [mine, setMine] = useState<MyPlaylist[]>([]);
  const [mineState, setMineState] = useState<"idle" | "loading" | "error">("idle");
  const [mineErr, setMineErr] = useState("");

  // The signed-in user's Spotify playlists.
  const [spotMine, setSpotMine] = useState<ServicePlaylist[]>([]);
  const [spotState, setSpotState] = useState<"idle" | "loading" | "error">("idle");
  const [, setSpotErr] = useState("");

  // htl account (server session) — its Google connection is what reaches the
  // user's YouTube playlists. A login cookie (SAPISID) is a fallback path.
  const [me, setMe] = useState<Me | null>(null);
  const ytConnected = !!me?.connections.includes("google");
  const spotifyConnected = !!me?.connections.includes("spotify");

  // The shared community pool (tracks already cached — load instantly, no resolve).
  const [community, setCommunity] = useState<TrackMeta[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchCommunity(120)
      .then((tracks) => {
        if (cancelled) return;
        // Apply any titles we backfilled on a previous visit straight away.
        const cache = communityMeta.get();
        const seeded = tracks.map((t) => (t.title ? t : { ...t, ...(cache[t.videoId] ?? {}) }));
        setCommunity(seeded);
        // Legacy tracks (cached before metadata was stored) still have no title —
        // backfill from /api/meta with a small concurrency pool, persisting each so
        // it's instant next time and we never re-hammer the resolver.
        const missing = seeded.filter((t) => !t.title).slice(0, 80);
        let idx = 0;
        const worker = async () => {
          while (!cancelled && idx < missing.length) {
            const t = missing[idx++];
            try {
              const m = await fetchMeta(t.videoId);
              if (cancelled) return;
              communityMeta.set({
                ...communityMeta.get(),
                [t.videoId]: { title: m.title, artist: m.artist, duration: m.duration, thumbnail: m.thumbnail },
              });
              // Persist it to the shared pool so every future visitor gets it too.
              void putCommunityMeta({
                videoId: t.videoId,
                title: m.title,
                artist: m.artist,
                duration: m.duration,
                thumbnail: m.thumbnail,
              });
              setCommunity((cur) => cur.map((x) => (x.videoId === t.videoId ? { ...x, ...m } : x)));
            } catch {
              /* leave the thumbnail-only row */
            }
          }
        };
        void Promise.all(Array.from({ length: Math.min(5, missing.length) }, worker));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMine() {
    setMineState("loading");
    setMineErr("");
    try {
      setMine(await fetchMyPlaylists());
      setMineState("idle");
    } catch (e) {
      setMineErr((e as Error).message);
      setMineState("error");
    }
  }
  useEffect(() => {
    fetchMe().then(setMe);
  }, []);
  useEffect(() => {
    if (ytConnected) loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytConnected]);

  async function loadSpotify() {
    setSpotState("loading");
    setSpotErr("");
    try {
      setSpotMine(await fetchSpotifyPlaylists());
      setSpotState("idle");
    } catch (e) {
      setSpotErr((e as Error).message);
      setSpotState("error");
    }
  }
  useEffect(() => {
    if (spotifyConnected) loadSpotify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotifyConnected]);

  // Import a Spotify playlist INTO the library: read its tracks, match each to a
  // playable YouTube video (paged to stay under the Worker subrequest cap), then
  // file the best matches into a local playlist tagged with the Spotify source so it
  // lives under MY SPOTIFY. Auto-picks the top match (use Sync for review/fixups).
  async function importSpotifyPlaylist(sp: ServicePlaylist) {
    setImporting(true);
    setImportMsg(`Reading “${sp.title}” from Spotify…`);
    try {
      const { name, tracks } = await syncReadSource("spotify", sp.id);
      if (!tracks.length) throw new Error("empty playlist");
      const matched: TrackMeta[] = [];
      for (let i = 0; i < tracks.length; ) {
        const rows = await syncMatch("youtube", tracks, i);
        if (!rows.length) break;
        for (const r of rows) {
          if (r.best && r.best.kind === "video") {
            matched.push({
              videoId: r.best.id,
              title: r.best.title,
              artist: r.best.artist,
              duration: r.best.duration,
              thumbnail: r.best.thumbnail,
              views: null,
            });
          }
        }
        i += rows.length;
        setImportMsg(`Matching ${Math.min(i, tracks.length)}/${tracks.length}…`);
      }
      if (!matched.length) throw new Error("no YouTube matches found");
      const cleanTitle = cleanPlaylistName(name || sp.title);
      const existing =
        library.playlists.find((p) => p.sourceListId === sp.id) ??
        library.playlists.find((p) => p.sourceService === "spotify" && cleanPlaylistName(p.name) === cleanTitle);
      const id = existing?.id ?? library.createPlaylist(cleanTitle, sp.id, "spotify");
      if (existing && !existing.sourceListId) library.linkSource(existing.id, sp.id, "spotify");
      for (const t of matched) library.addToPlaylist(id, t);
      setView({ playlistId: id });
      setImportMsg(null);
    } catch (e) {
      setImportMsg(`Spotify import failed: ${(e as Error).message}`);
    } finally {
      setImporting(false);
    }
  }

  const byId = useMemo(() => {
    const m = new Map<string, TrackMeta>();
    for (const t of library.collection) m.set(t.videoId, t);
    return m;
  }, [library.collection]);

  const inCollection = (videoId: string) => byId.has(videoId);

  const isPlaylist = typeof view === "object";
  const activePlaylistId = isPlaylist ? view.playlistId : null;

  // Pull a YouTube playlist into the library. Re-importing the same source list does
  // NOT duplicate it: we reuse the existing playlist (matched by its sourceListId OR
  // by normalized name) and merge in any new tracks (addToPlaylist already dedups).
  // The "· via htl" suffix htl stamps onto playlists it syncs OUT to a service is
  // stripped here, so a playlist synced out as "X · via htl" merges back into the
  // local "X" instead of forking a copy — and that local playlist gets linked to the
  // source so subsequent clicks match directly. Throws on failure so callers can
  // surface it (Search modal inline; MY YOUTUBE sidebar toast).
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

  const [dialog, setDialog] = useState<DialogState>(null);

  function createPlaylist() {
    setDialog({
      kind: "prompt",
      title: "New playlist",
      initial: "New playlist",
      submitLabel: "Create",
      onSubmit: (name) => setView({ playlistId: library.createPlaylist(name) }),
    });
  }

  // Lightweight refs for the per-track "add to playlist" menu in the table.
  const playlistRefs = library.playlists.map((p) => ({ id: p.id, name: p.name }));
  function createPlaylistWith(tracks: TrackMeta[]) {
    if (!tracks.length) return;
    setDialog({
      kind: "prompt",
      title: tracks.length > 1 ? `New playlist with ${tracks.length} tracks` : "New playlist",
      initial: "New playlist",
      submitLabel: "Create",
      onSubmit: (name) => {
        const id = library.createPlaylist(name);
        tracks.forEach((t) => library.addToPlaylist(id, t));
      },
    });
  }
  function renamePlaylist(id: string, current: string) {
    setDialog({
      kind: "prompt",
      title: "Rename playlist",
      initial: current,
      submitLabel: "Rename",
      onSubmit: (name) => name !== current && library.renamePlaylist(id, name),
    });
  }
  function deletePlaylist(id: string, name: string) {
    setDialog({
      kind: "confirm",
      title: "Delete playlist?",
      message: `“${name}” will be removed. Tracks stay in your collection.`,
      confirmLabel: "Delete",
      onConfirm: () => {
        library.deletePlaylist(id);
        if (activePlaylistId === id) setView("collection");
      },
    });
  }

  // Right-click / long-press menu for a sidebar playlist (rename / delete).
  const [plMenu, setPlMenu] = useState<{ x: number; y: number; id: string; name: string } | null>(null);
  const plLongPress = useRef<number | undefined>(undefined);
  const plSuppress = useRef(false); // a long-press opened the menu → swallow the click
  useEffect(() => {
    if (!plMenu) return;
    const close = () => setPlMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPlMenu(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [plMenu]);

  // Drag tracks from a table onto a sidebar playlist (or Collection) to file them.
  // `dragPl` is the highlighted drop target ("collection" or a playlist id).
  const [dragPl, setDragPl] = useState<string | null>(null);
  function droppedTracks(e: React.DragEvent): TrackMeta[] {
    const raw = e.dataTransfer.getData(TRACK_DND_MIME);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      // New payload = full metas; tolerate the legacy id-array payload too.
      if (Array.isArray(parsed) && typeof parsed[0] === "string") {
        return (parsed as string[]).map((id) => byId.get(id)).filter((t): t is TrackMeta => !!t);
      }
      return (parsed as TrackMeta[]).filter((t) => t && t.videoId);
    } catch {
      return [];
    }
  }
  function dropOnPlaylist(e: React.DragEvent, playlistId: string) {
    e.preventDefault();
    setDragPl(null);
    for (const t of droppedTracks(e)) library.addToPlaylist(playlistId, t);
  }
  function dropOnCollection(e: React.DragEvent) {
    e.preventDefault();
    setDragPl(null);
    for (const t of droppedTracks(e)) library.addTrack(t);
  }

  // One sidebar playlist row — used for both the local PLAYLISTS section and the
  // synced playlists that live under their service section (MY YOUTUBE / …). Click =
  // view, right-click / long-press = rename·delete menu, and it's a drag drop-target.
  const renderPlaylistItem = (p: Playlist) => (
    <button
      key={p.id}
      className={`lib-nav small ${activePlaylistId === p.id ? "active" : ""} ${dragPl === p.id ? "drag-over" : ""}`}
      onClick={() => {
        if (plSuppress.current) {
          plSuppress.current = false;
          return;
        }
        setView({ playlistId: p.id });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setPlMenu({ x: e.clientX, y: e.clientY, id: p.id, name: p.name });
      }}
      onTouchStart={(e) => {
        const touch = e.touches[0];
        plLongPress.current = window.setTimeout(() => {
          plSuppress.current = true;
          setPlMenu({ x: touch.clientX, y: touch.clientY, id: p.id, name: p.name });
        }, 480);
      }}
      onTouchEnd={() => clearTimeout(plLongPress.current)}
      onTouchMove={() => clearTimeout(plLongPress.current)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TRACK_DND_MIME)) {
          e.preventDefault();
          setDragPl(p.id);
        }
      }}
      onDragLeave={() => setDragPl((d) => (d === p.id ? null : d))}
      onDrop={(e) => dropOnPlaylist(e, p.id)}
    >
      <span className="lib-nav-ico">🎵</span>
      <span
        className="lib-pl-name"
        title={`${p.name} — double-click to rename`}
        onDoubleClick={(e) => {
          e.stopPropagation();
          renamePlaylist(p.id, p.name);
        }}
      >
        {cleanPlaylistName(p.name) || p.name}
      </span>
      {p.sourceListId && (
        <span className="lib-pl-src" title={`Synced with ${p.sourceService === "spotify" ? "Spotify" : "YouTube"}`}>
          ⇄
        </span>
      )}
      <span className="lib-count">{p.trackIds.length}</span>
      <span
        className="lib-del"
        title="Delete playlist"
        onClick={(e) => {
          e.stopPropagation();
          deletePlaylist(p.id, p.name);
        }}
      >
        ✕
      </span>
    </button>
  );
  // Local playlists split by where they belong: untethered ones in PLAYLISTS, ones
  // synced to a service under that service's section. (Only YouTube sources exist
  // today; Spotify/Tidal sections slot in here when those imports land.)
  const localPlaylists = library.playlists.filter((p) => !p.sourceListId);
  const youtubePlaylists = library.playlists.filter((p) => p.sourceListId && p.sourceService !== "spotify");
  const spotifyPlaylists = library.playlists.filter((p) => p.sourceService === "spotify");

  // Header label for the current view: name + where it's "from".
  const headInfo: { name: string; from: string | null } = (() => {
    if (view === "collection") return { name: "Collection", from: null };
    if (view === "community") return { name: "Community", from: "shared pool" };
    const p = library.playlists.find((pl) => pl.id === activePlaylistId);
    if (!p) return { name: "Playlist", from: null };
    const from = p.sourceService === "spotify" ? "Spotify" : p.sourceListId ? "YouTube" : "local playlist";
    return { name: cleanPlaylistName(p.name) || p.name, from };
  })();

  return (
    <>
      {open && (
        <div className="modal-backdrop dock-left" onPointerDown={() => onOpenChange(false)}>
          <DockResizer varName="--dock-w-left" grow="right" measure="parent" />
          <div className="panel lib-panel" onPointerDown={(e) => e.stopPropagation()}>
            <div className="settings-head">
              <div className="lib-head">
                <span className="lib-head-name" title={headInfo.name}>
                  {headInfo.name}
                </span>
                {headInfo.from && <span className="lib-head-from">from {headInfo.from}</span>}
              </div>
              <button className="mini x" onClick={() => onOpenChange(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="library">
            <aside className="lib-sidebar">
        <button
          className={`lib-nav ${view === "collection" ? "active" : ""} ${dragPl === "collection" ? "drag-over" : ""}`}
          onClick={() => setView("collection")}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(TRACK_DND_MIME)) {
              e.preventDefault();
              setDragPl("collection");
            }
          }}
          onDragLeave={() => setDragPl((d) => (d === "collection" ? null : d))}
          onDrop={dropOnCollection}
        >
          <span className="lib-nav-ico">💿</span> Collection
          <span className="lib-count">{library.collection.length}</span>
        </button>
        <button
          className={`lib-nav ${view === "community" ? "active" : ""}`}
          onClick={() => setView("community")}
          title="Tracks already cached on htl — load instantly, no download"
        >
          <span className="lib-nav-ico">🌐</span> Community
          {community.length > 0 && <span className="lib-count">{community.length}</span>}
        </button>
        {me?.user && (
          <button
            className="lib-nav lib-sync-nav"
            onClick={() => setSyncOpen(true)}
            title="Sync playlists between YouTube and Spotify"
          >
            <span className="lib-nav-ico">⇄</span> Sync
          </button>
        )}

        <div className="lib-section">
          <span>PLAYLISTS</span>
          <button className="lib-add" title="New playlist" onClick={createPlaylist}>
            +
          </button>
        </div>
        <div className="lib-playlists">
          {localPlaylists.length === 0 && <div className="lib-mine-msg">No local playlists yet.</div>}
          {localPlaylists.map(renderPlaylistItem)}
        </div>

        {/* MY YOUTUBE: playlists synced to YouTube live here (whether or not you're
            currently connected — they're local data), plus your remaining YouTube
            playlists to import when connected. */}
        {(ytConnected || youtubePlaylists.length > 0) && (
          <>
            <div className="lib-section">
              <span>MY YOUTUBE</span>
              {ytConnected && (
                <button className="lib-add" title="Refresh" onClick={loadMine} disabled={mineState === "loading"}>
                  ⟳
                </button>
              )}
            </div>
            <div className="lib-playlists">
              {/* Synced playlists (have a YouTube source) — full local rows. */}
              {youtubePlaylists.map(renderPlaylistItem)}
              {/* Your other YouTube playlists, not yet imported. */}
              {ytConnected && (
                <>
                  {mineState === "loading" && <div className="lib-mine-msg">Loading…</div>}
                  {mineState === "error" && (
                    <div className="lib-mine-msg lib-mine-err">{mineErr || "Couldn't load."} — tap ⟳ to retry.</div>
                  )}
                  {mine
                    .filter((p) => !library.playlists.some((pl) => pl.sourceListId === p.id))
                    .map((p) => (
                      <button
                        key={p.id}
                        className="lib-nav small"
                        title={`Import “${p.title}” into your library`}
                        disabled={importing}
                        onClick={() => importPlaylistId(p.id, p.title)}
                      >
                        <span className="lib-nav-ico">▶</span>
                        <span className="lib-pl-name">{cleanPlaylistName(p.title)}</span>
                        {p.count > 0 && <span className="lib-count">{p.count}</span>}
                      </button>
                    ))}
                </>
              )}
            </div>
          </>
        )}

        {/* MY SPOTIFY: imported Spotify playlists (as local rows) + the rest to
            import. If browsing isn't available (the Spotify app needs an approved
            premium owner — a 403), we just hide the import list rather than surface a
            raw error; the section disappears entirely when nothing's been imported. */}
        {(spotifyPlaylists.length > 0 || (spotifyConnected && spotState !== "error")) && (
          <>
            <div className="lib-section">
              <span>MY SPOTIFY</span>
              {spotifyConnected && (
                <button className="lib-add" title="Refresh" onClick={loadSpotify} disabled={spotState === "loading"}>
                  ⟳
                </button>
              )}
            </div>
            <div className="lib-playlists">
              {spotifyPlaylists.map(renderPlaylistItem)}
              {spotifyConnected && spotState === "loading" && <div className="lib-mine-msg">Loading…</div>}
              {spotifyConnected &&
                spotState === "idle" &&
                spotMine
                  .filter((p) => !library.playlists.some((pl) => pl.sourceListId === p.id))
                  .map((p) => (
                    <button
                      key={p.id}
                      className="lib-nav small"
                      title={`Import “${p.title}” from Spotify (matches tracks to YouTube)`}
                      disabled={importing}
                      onClick={() => importSpotifyPlaylist(p)}
                    >
                      <span className="lib-nav-ico">♫</span>
                      <span className="lib-pl-name">{cleanPlaylistName(p.title)}</span>
                      {p.count > 0 && <span className="lib-count">{p.count}</span>}
                    </button>
                  ))}
            </div>
          </>
        )}

        {importMsg && <div className="lib-import-msg">{importMsg}</div>}
      </aside>

      <DockResizer varName="--lib-side-w" grow="right" measure="prev" />

      <div className="lib-main">
        {view === "collection" && (
          <TrackTable
            tracks={library.collection.map(withCached)}
            onLoad={onLoad}
            onRemove={library.removeTrack}
            removeTitle="Remove from collection"
            emptyHint="Your collection is empty. Tap “Search YouTube” to find tracks and add them with +."
            loadedIds={loadedIds}
            playlists={playlistRefs}
            onAddToPlaylist={library.addToPlaylist}
            onCreatePlaylistWith={createPlaylistWith}
          />
        )}
        {view === "community" && (
          <TrackTable
            tracks={community.map(withCached)}
            onLoad={onLoad}
            emptyHint="No community tracks yet — they appear here as people load and cache songs. (Production only.)"
            loadedIds={loadedIds}
            playlists={playlistRefs}
            onAddToPlaylist={library.addToPlaylist}
            onCreatePlaylistWith={createPlaylistWith}
            onAddToCollection={library.addTrack}
            inCollection={inCollection}
          />
        )}
        {isPlaylist &&
          (() => {
            const pl = library.playlists.find((p) => p.id === activePlaylistId);
            if (!pl) return <div className="lib-empty">Playlist not found.</div>;
            const tracks = pl.trackIds
              .map((id) => byId.get(id))
              .filter((t): t is TrackMeta => t !== undefined)
              .map(withCached);
            return (
              <TrackTable
                tracks={tracks}
                onLoad={onLoad}
                onRemove={(vid) => library.removeFromPlaylist(pl.id, vid)}
                removeTitle="Remove from playlist"
                emptyHint="Empty playlist. Add tracks from Search or your Collection."
                loadedIds={loadedIds}
                playlists={playlistRefs.filter((p) => p.id !== pl.id)}
                onAddToPlaylist={library.addToPlaylist}
                onCreatePlaylistWith={createPlaylistWith}
              />
            );
          })()}
            </div>
          </div>
          </div>
        </div>
      )}

      {searchOpen && (
        <SearchModal
          onClose={() => onSearchOpenChange(false)}
          onLoad={onLoad}
          onAdd={library.addTrack}
          inCollection={inCollection}
          onIngestPlaylist={async (listId) => {
            await ingestPlaylist(listId, "Imported playlist");
            onSearchOpenChange(false); // jump to the freshly imported playlist
          }}
          playlists={playlistRefs}
          onAddToPlaylist={library.addToPlaylist}
          onCreatePlaylistWith={createPlaylistWith}
        />
      )}
      {plMenu && (
        <>
          <div className="ctx-backdrop" onClick={() => setPlMenu(null)} onContextMenu={(e) => e.preventDefault()} />
          <div
            className="ctx-menu"
            style={{ left: Math.min(plMenu.x, window.innerWidth - 200), top: Math.min(plMenu.y, window.innerHeight - 120) }}
          >
            <button
              onClick={() => {
                renamePlaylist(plMenu.id, plMenu.name);
                setPlMenu(null);
              }}
            >
              ✎ Rename
            </button>
            <div className="ctx-sep" />
            <button
              className="ctx-danger"
              onClick={() => {
                deletePlaylist(plMenu.id, plMenu.name);
                setPlMenu(null);
              }}
            >
              ✕ Delete playlist
            </button>
          </div>
        </>
      )}
      {syncOpen && me?.user && (
        <SyncPanel me={me} library={library} onClose={() => setSyncOpen(false)} />
      )}
      {dialog?.kind === "prompt" && (
        <PromptModal
          title={dialog.title}
          initial={dialog.initial}
          submitLabel={dialog.submitLabel}
          onSubmit={dialog.onSubmit}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "confirm" && (
        <ConfirmModal
          title={dialog.title}
          message={dialog.message}
          confirmLabel={dialog.confirmLabel}
          onConfirm={dialog.onConfirm}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
