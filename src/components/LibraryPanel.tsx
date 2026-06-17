import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Library, Playlist, TrackMeta } from "@htl/library";
import { fetchMyPlaylists, type MyPlaylist } from "@htl/media";
import {
  fetchMe,
  fetchSpotifyPlaylists,
  fetchTidalPlaylists,
  usePlaylistSource,
  type Me,
  type ServicePlaylist,
} from "@htl/account";
import { isMobileDevice, type AutoMixStatus, type AutoMixMirror, type MixQueue } from "@htl";
import { MixQueuePanel } from "./MixQueuePanel";
import { Explorer } from "./Explorer";
import { SyncPanel } from "./SyncPanel";
import { TRACK_DND_MIME, TrackTable } from "./TrackTable";
import { ConfirmModal, PromptModal } from "./Dialog";
import { DockResizer } from "./DockResizer";
import { cleanPlaylistName, withCached } from "./lib/libraryUtils";
import { useCommunityPool } from "./lib/useCommunityPool";
import { useLibraryImport } from "./lib/useLibraryImport";

// In-app dialog state (replaces window.prompt / window.confirm).
type DialogState =
  | { kind: "prompt"; title: string; initial: string; submitLabel: string; onSubmit: (v: string) => void }
  | { kind: "confirm"; title: string; message: string; confirmLabel: string; onConfirm: () => void }
  | null;

interface LibraryPanelProps {
  library: Library;
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  loadedIds: Set<string>;
  deckLoaded: { A: string | null; B: string | null }; // videoIds on each deck → A/B chips in the lists
  deckColors: { A: string; B: string }; // deck accent colours for the chips
  open?: boolean; // the floating library panel is shown (defaults to visible)
  onOpenChange?: (open: boolean) => void;
  // Auto-mix (auto-DJ) controls, surfaced in the library header; the queue view
  // takes over the song-list area (like Sync) rather than floating.
  auto?: {
    status: AutoMixStatus;
    queue: MixQueue;
    queueCount: number;
    queueOpen: boolean;
    mirror?: AutoMixMirror | null; // session: the host's queue/status (read-only mirror)
    // Queue mutations route through one authority (host local / remote → intent → host).
    edit: {
      add: (t: TrackMeta) => void;
      addNext: (t: TrackMeta) => void;
      remove: (videoId: string) => void;
      move: (from: number, to: number) => void;
    };
    canEdit: boolean; // host/solo, or a controlling remote
    onToggle: () => void;
    onToggleQueue: () => void;
    onMixNow: () => void;
    onSkip: () => void;
    onHold: () => void;
  };
}

type View = "collection" | "community" | { playlistId: string };

export function LibraryPanel({
  library,
  onLoad,
  loadedIds,
  deckLoaded,
  deckColors,
  open = true,
  onOpenChange = () => {},
  auto,
}: LibraryPanelProps) {
  // The open library tab (Collection / Community / a playlist / Search / Sync) is
  // remembered across reloads. One JSON blob holds all three so the right tab reopens.
  // A persisted playlist that no longer exists falls back to Collection.
  const persistedView = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("htl:libView") || "null") as
        | { view?: unknown; search?: boolean; sync?: boolean }
        | null;
    } catch {
      return null;
    }
  }, []);
  const [view, setView] = useState<View>(() => {
    const v = persistedView?.view;
    if (v === "community") return "community";
    if (v && typeof v === "object" && typeof (v as { playlistId?: unknown }).playlistId === "string") {
      const id = (v as { playlistId: string }).playlistId;
      if (library.playlists.some((p) => p.id === id)) return { playlistId: id };
    }
    return "collection";
  });
  // Search is baked into the library now (no separate dock): selecting it shows the
  // Explorer (its own search bar + results) in the main content area, like Sync.
  const [searchView, setSearchView] = useState(persistedView?.search === true);
  // Sidebar (nav) collapse — toggled by the ☰ hamburger. Persisted; defaults open on
  // desktop and collapsed on a phone so the track table fills the full-screen panel.
  const [navOpen, setNavOpen] = useState(() => {
    const saved = localStorage.getItem("htl:libNav");
    if (saved != null) return saved === "1";
    return window.innerWidth >= 769;
  });
  useEffect(() => {
    try {
      localStorage.setItem("htl:libNav", navOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [navOpen]);
  // Collapsible sidebar sections (PLAYLISTS / MY YOUTUBE / MY SPOTIFY / MY TIDAL) — the
  // header row toggles; persisted so a tidied sidebar stays tidied across reloads.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem("htl:libSections") || "[]"));
    } catch {
      return new Set<string>();
    }
  });
  const toggleSection = (key: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      try {
        localStorage.setItem("htl:libSections", JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  // A section header that doubles as a collapse toggle (caret + label), keeping its
  // optional action button (＋ new / ⟳ refresh) on the right.
  const sectionHead = (key: string, label: string, action?: ReactNode) => (
    <div className="lib-section">
      <button
        className="lib-section-toggle"
        onClick={() => toggleSection(key)}
        aria-expanded={!collapsedSections.has(key)}
        title={collapsedSections.has(key) ? "Expand" : "Collapse"}
      >
        <span className="lib-section-caret" aria-hidden="true">{collapsedSections.has(key) ? "▸" : "▾"}</span>
        <span>{label}</span>
      </button>
      {action}
    </div>
  );
  const [syncOpen, setSyncOpen] = useState(persistedView?.sync === true);
  // Picking any library view (Collection / Community / a playlist) exits the Sync
  // subsection — they share the main content area. SKIP the mount run, or it would wipe
  // the Search/Sync tab we just restored from localStorage.
  const viewMounted = useRef(false);
  useEffect(() => {
    if (!viewMounted.current) {
      viewMounted.current = true;
      return;
    }
    setSyncOpen(false);
    setSearchView(false);
  }, [view]);
  // Remember the open tab across reloads (view + which overlay, if any).
  useEffect(() => {
    try {
      localStorage.setItem("htl:libView", JSON.stringify({ view, search: searchView, sync: syncOpen }));
    } catch {
      /* ignore */
    }
  }, [view, searchView, syncOpen]);
  // Playlist import / re-sync engine (owns the importing/importMsg status).
  const { importing, importMsg, importServicePlaylist, resyncPlaylist, ingestPlaylist, importPlaylistId } =
    useLibraryImport(library, setView);

  // Selecting any library section (Collection / Community / a playlist…) returns to the
  // song list by leaving every overlay view — the queue, Search, and Sync are all just
  // tabs now (no explicit "← Songs" button). We clear searchView/syncOpen HERE rather than
  // leaning on the [view] effect, because clicking the view you're already on (e.g.
  // Collection while Search overlays it) is a no-op setView → the effect never fires →
  // Search/Sync stay stuck. Callers that WANT search/sync set their flag true afterwards.
  const closeQueue = () => {
    if (auto?.queueOpen) auto.onToggleQueue();
    setSearchView(false);
    setSyncOpen(false);
  };

  // htl account (server session) — its Google connection is what reaches the
  // user's YouTube playlists. A login cookie (SAPISID) is a fallback path.
  const [me, setMe] = useState<Me | null>(null);
  const ytConnected = !!me?.connections.includes("google");
  const spotifyConnected = !!me?.connections.includes("spotify");
  const tidalConnected = !!me?.connections.includes("tidal");

  // First sign-in with an empty library: auto-open the Sync tab (import lives there now —
  // pick a connected service as the source, Library as the destination). Openable any time
  // from the sidebar's Sync entry.
  useEffect(() => {
    // Desktop only — a full-screen panel auto-popping on a phone reads as a freeze.
    if (me?.user && !isMobileDevice() && library.playlists.length === 0 && !localStorage.getItem("htl:wizardSeen")) {
      localStorage.setItem("htl:wizardSeen", "1");
      onOpenChange(true);
      setSearchView(false);
      setSyncOpen(true);
    }
  }, [me?.user, library.playlists.length, onOpenChange]);

  // Provider playlist LISTS via the smart cache: shown instantly from the last
  // result, only refetched when stale (5 min) or when ⟳ forces it — no redundant
  // hammering on every library open.
  const ytSrc = usePlaylistSource<MyPlaylist>("youtube", fetchMyPlaylists, ytConnected);
  const spotSrc = usePlaylistSource<ServicePlaylist>("spotify", fetchSpotifyPlaylists, spotifyConnected);
  const tidalSrc = usePlaylistSource<ServicePlaylist>("tidal", fetchTidalPlaylists, tidalConnected);
  const mine = ytSrc.items;
  const mineState = ytSrc.state;
  const mineErr = ytSrc.err;
  const loadMine = ytSrc.refresh;
  const spotMine = spotSrc.items;
  const spotState = spotSrc.state;
  const loadSpotify = spotSrc.refresh;
  const tidalMine = tidalSrc.items;
  const tidalState = tidalSrc.state;
  const loadTidal = tidalSrc.refresh;

  // The shared community pool (tracks already cached — load instantly, no resolve).
  const community = useCommunityPool();

  useEffect(() => {
    fetchMe().then(setMe);
  }, []);

  // The not-yet-imported service playlists, split so the main list stays clean: ones you
  // OWN (importable) show inline; ones only SHARED with you (ownedByMe === false) — which
  // the provider's API blocks third-party apps from reading (a 403), so importing them
  // dead-ends — are tucked into a collapsed disclosure with how-to-fix guidance instead of
  // cluttering the list with rows that fail. (TIDAL doesn't report ownership, so its rows
  // are all treated as owned; its large-playlist failures are 429s, handled by retry.)
  const renderImportList = (service: "spotify" | "tidal", mine: ServicePlaylist[]) => {
    const pending = mine.filter((p) => !library.playlists.some((pl) => pl.sourceListId === p.id));
    const owned = pending.filter((p) => p.ownedByMe !== false);
    const shared = pending.filter((p) => p.ownedByMe === false);
    const label = service === "tidal" ? "TIDAL" : "Spotify";
    const importBtn = (p: ServicePlaylist) => (
      <button
        key={p.id}
        className="lib-nav small"
        title={`Import “${p.title}” from ${label} (matches tracks to YouTube)`}
        disabled={importing}
        onClick={() => importServicePlaylist(service, p)}
      >
        <span className="lib-nav-ico">♫</span>
        <span className="lib-pl-name">{cleanPlaylistName(p.title)}</span>
        {p.count > 0 && <span className="lib-count">{p.count}</span>}
      </button>
    );
    return (
      <>
        {owned.map(importBtn)}
        {shared.length > 0 && (
          <details className="lib-shared">
            <summary>Shared with you · {shared.length}</summary>
            <div className="lib-shared-note">
              {label} blocks apps from reading playlists you don’t own. Open one in {label}, add it to your
              own library (or duplicate it), then import that copy. Importing here will just report this.
            </div>
            {shared.map(importBtn)}
          </details>
        )}
      </>
    );
  };

  const byId = useMemo(() => {
    const m = new Map<string, TrackMeta>();
    for (const t of library.collection) m.set(t.videoId, t);
    return m;
  }, [library.collection]);

  const inCollection = (videoId: string) => byId.has(videoId);

  const isPlaylist = typeof view === "object";
  const activePlaylistId = isPlaylist ? view.playlistId : null;

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
      className={`lib-nav small ${!auto?.queueOpen && activePlaylistId === p.id ? "active" : ""} ${dragPl === p.id ? "drag-over" : ""}`}
      onClick={() => {
        if (plSuppress.current) {
          plSuppress.current = false;
          return;
        }
        closeQueue();
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
        <span
          className="lib-pl-src"
          role="button"
          tabIndex={0}
          title={`Re-sync from ${p.sourceService === "spotify" ? "Spotify" : p.sourceService === "tidal" ? "TIDAL" : "YouTube"}${p.lastSynced ? ` — last synced ${new Date(p.lastSynced).toLocaleString()}` : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            void resyncPlaylist(p);
          }}
        >
          {importing ? "⟳" : "⇄"}
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
  const youtubePlaylists = library.playlists.filter(
    (p) => p.sourceListId && p.sourceService !== "spotify" && p.sourceService !== "tidal",
  );
  const spotifyPlaylists = library.playlists.filter((p) => p.sourceService === "spotify");
  const tidalPlaylists = library.playlists.filter((p) => p.sourceService === "tidal");

  // Header label for the current view: name + where it's "from".
  const headInfo: { name: string; from: string | null } = (() => {
    if (view === "collection") return { name: "Collection", from: null };
    if (view === "community") return { name: "Community", from: "shared pool" };
    const p = library.playlists.find((pl) => pl.id === activePlaylistId);
    if (!p) return { name: "Playlist", from: null };
    const from =
      p.sourceService === "spotify"
        ? "Spotify"
        : p.sourceService === "tidal"
          ? "TIDAL"
          : p.sourceListId
            ? "YouTube"
            : "local playlist";
    return { name: cleanPlaylistName(p.name) || p.name, from };
  })();

  return (
    <>
      {open && (
        <div className="modal-backdrop dock-left" onPointerDown={() => onOpenChange(false)}>
          <DockResizer varName="--dock-w-left" measure="parent" />
          <div className="panel lib-panel" onPointerDown={(e) => e.stopPropagation()}>
            <div className="settings-head">
              {/* The title text IS the sidebar toggle (no separate ☰): tap it to open/close
                  the sections menu. A caret marks it as a disclosure. */}
              <button
                className={`lib-head lib-head-toggle ${navOpen ? "on" : ""}`}
                onClick={() => setNavOpen((v) => !v)}
                aria-pressed={navOpen}
                aria-label={navOpen ? "Hide sections" : "Show sections"}
                title={navOpen ? "Hide sections" : "Show sections"}
              >
                <span className="lib-head-caret" aria-hidden="true">{navOpen ? "▾" : "▸"}</span>
                <span className="lib-head-name" title={headInfo.name}>
                  {headInfo.name}
                </span>
                {headInfo.from && <span className="lib-head-from">from {headInfo.from}</span>}
              </button>
              {auto && (
                <div className="automix-bar">
                  <button
                    className={`automix-toggle ${auto.status.enabled ? "on" : ""}`}
                    onClick={auto.onToggle}
                    aria-pressed={auto.status.enabled}
                    title="Auto-mix: beatmatch and blend each track into the next"
                  >
                    AUTO
                    {auto.status.enabled && auto.status.countdownSec != null && auto.status.phase !== "idle" && (
                      <span className="automix-count">
                        {auto.status.phase === "mixing" ? "mixing" : `${Math.ceil(auto.status.countdownSec)}s`}
                      </span>
                    )}
                  </button>
                </div>
              )}
              {/* No ✕: the Library is a dock you close with its chin button (this matches
                  Settings/Profile/Session + the embedded tabs — exit by opening another). */}
            </div>
            <div className={`library ${navOpen ? "" : "nav-collapsed"}`}>
            {navOpen && (
            <>
            <aside className="lib-sidebar">
        {auto && (
          <button
            className={`lib-nav lib-queue-nav ${auto.queueOpen ? "active" : ""}`}
            onClick={() => {
              // Opening the Queue must leave the other exclusive views, or two nav rows
              // light up at once (the double-select bug): Search/Sync stay "active" while
              // the queue takes over the content area.
              if (!auto.queueOpen) {
                setSearchView(false);
                setSyncOpen(false);
              }
              auto.onToggleQueue();
            }}
            aria-pressed={auto.queueOpen}
            title="Auto-mix queue — up-next suggestions and playlist"
          >
            <span className="lib-nav-ico">☰</span> Queue
            {auto.queueCount ? <span className="lib-count">{auto.queueCount}</span> : null}
          </button>
        )}
        <button
          className={`lib-nav lib-search-nav ${searchView && !auto?.queueOpen ? "active" : ""}`}
          onClick={() => {
            closeQueue();
            setSyncOpen(false);
            setSearchView(true);
          }}
          title="Search YouTube and add tracks to your library"
        >
          <span className="lib-nav-ico">🔍</span> Search
        </button>
        <button
          className={`lib-nav ${view === "collection" && !searchView && !syncOpen && !auto?.queueOpen ? "active" : ""} ${dragPl === "collection" ? "drag-over" : ""}`}
          onClick={() => {
            closeQueue();
            setView("collection");
          }}
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
          className={`lib-nav ${view === "community" && !searchView && !syncOpen && !auto?.queueOpen ? "active" : ""}`}
          onClick={() => {
            closeQueue();
            setView("community");
          }}
          title="Tracks already cached on htl — load instantly, no download"
        >
          <span className="lib-nav-ico">🌐</span> Community
          {community.length > 0 && <span className="lib-count">{community.length}</span>}
        </button>
        {me?.user && (
          <button
            className={`lib-nav lib-sync-nav ${syncOpen ? "active" : ""}`}
            onClick={() => {
              closeQueue();
              setSyncOpen(true);
            }}
            title="Sync &amp; import playlists — pull a service playlist into your Library, or push between services"
          >
            <span className="lib-nav-ico">⇄</span> Sync
          </button>
        )}

        {sectionHead(
          "local",
          "PLAYLISTS",
          <button className="lib-add" title="New playlist" onClick={createPlaylist}>
            +
          </button>,
        )}
        {!collapsedSections.has("local") && (
          <div className="lib-playlists">
            {localPlaylists.length === 0 && <div className="lib-mine-msg">No local playlists yet.</div>}
            {localPlaylists.map(renderPlaylistItem)}
          </div>
        )}

        {/* MY YOUTUBE: playlists synced to YouTube live here (whether or not you're
            currently connected — they're local data), plus your remaining YouTube
            playlists to import when connected. */}
        {(ytConnected || youtubePlaylists.length > 0) && (
          <>
            {sectionHead(
              "youtube",
              "MY YOUTUBE",
              ytConnected && (
                <button className="lib-add" title="Refresh" onClick={loadMine} disabled={mineState === "loading"}>
                  ⟳
                </button>
              ),
            )}
            {!collapsedSections.has("youtube") && (
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
            )}
          </>
        )}

        {/* MY SPOTIFY: imported Spotify playlists (as local rows) + the rest to
            import. If browsing isn't available (the Spotify app needs an approved
            premium owner — a 403), we just hide the import list rather than surface a
            raw error; the section disappears entirely when nothing's been imported. */}
        {(spotifyPlaylists.length > 0 || (spotifyConnected && spotState !== "error")) && (
          <>
            {sectionHead(
              "spotify",
              "MY SPOTIFY",
              spotifyConnected && (
                <button className="lib-add" title="Refresh" onClick={loadSpotify} disabled={spotState === "loading"}>
                  ⟳
                </button>
              ),
            )}
            {!collapsedSections.has("spotify") && (
              <div className="lib-playlists">
                {spotifyPlaylists.map(renderPlaylistItem)}
                {spotifyConnected && spotState === "loading" && <div className="lib-mine-msg">Loading…</div>}
                {spotifyConnected && spotState === "idle" && renderImportList("spotify", spotMine)}
              </div>
            )}
          </>
        )}

        {/* MY TIDAL: imported TIDAL playlists + the rest to import. Mirrors MY
            SPOTIFY; audio is still the matched YouTube stream (TIDAL is DRM-locked,
            catalog-only). Hidden unless connected or something's already imported. */}
        {(tidalPlaylists.length > 0 || (tidalConnected && tidalState !== "error")) && (
          <>
            {sectionHead(
              "tidal",
              "MY TIDAL",
              tidalConnected && (
                <button className="lib-add" title="Refresh" onClick={loadTidal} disabled={tidalState === "loading"}>
                  ⟳
                </button>
              ),
            )}
            {!collapsedSections.has("tidal") && (
              <div className="lib-playlists">
                {tidalPlaylists.map(renderPlaylistItem)}
                {tidalConnected && tidalState === "loading" && <div className="lib-mine-msg">Loading…</div>}
                {tidalConnected && tidalState === "idle" && renderImportList("tidal", tidalMine)}
              </div>
            )}
          </>
        )}

        {importMsg && <div className="lib-import-msg">{importMsg}</div>}
      </aside>

      <DockResizer varName="--lib-side-w" measure="prev" />
      </>
      )}

      <div className="lib-main">
        {auto?.queueOpen ? (
          // The auto-mix queue takes over the song-list area (embedded, not floating).
          <MixQueuePanel
            embedded
            queue={auto.queue}
            status={auto.status}
            mirror={auto.mirror}
            edit={auto.edit}
            canEdit={auto.canEdit}
            library={library}
            onLoad={onLoad}
            deckLoaded={deckLoaded}
            deckColors={deckColors}
            onToggleAuto={auto.onToggle}
            onMixNow={auto.onMixNow}
            onSkip={auto.onSkip}
            onHold={auto.onHold}
            onClose={auto.onToggleQueue}
          />
        ) : searchView ? (
          // Search baked into the library: the Explorer (its own search bar + results)
          // takes over the content area — no separate dock anymore.
          <Explorer
            onLoad={onLoad}
            onAdd={library.addTrack}
            inCollection={inCollection}
            deckLoaded={deckLoaded}
            deckColors={deckColors}
            onIngestPlaylist={async (listId) => {
              await ingestPlaylist(listId, "Imported playlist");
              setSearchView(false); // jump to the freshly imported playlist
            }}
            playlists={playlistRefs}
            onAddToPlaylist={library.addToPlaylist}
            onCreatePlaylistWith={createPlaylistWith}
          />
        ) : syncOpen && me?.user ? (
          // Sync is a SUBSECTION of the library — it takes over this content area
          // (embedded, no separate modal) so the top chin stays clean. Import lives here
          // too: pick a connected service as the source and "Library" as the destination.
          <SyncPanel embedded me={me} library={library} onClose={() => setSyncOpen(false)} />
        ) : (
        <>
        {view === "collection" && (
          <TrackTable
            tracks={library.collection.map(withCached)}
            onLoad={onLoad}
            onRemove={library.removeTrack}
            removeTitle="Remove from collection"
            emptyHint="Your collection is empty. Tap “Search YouTube” to find tracks and add them with +."
            loadedIds={loadedIds}
            deckLoaded={deckLoaded}
            deckColors={deckColors}
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
            deckLoaded={deckLoaded}
            deckColors={deckColors}
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
                deckLoaded={deckLoaded}
                deckColors={deckColors}
                playlists={playlistRefs.filter((p) => p.id !== pl.id)}
                onAddToPlaylist={library.addToPlaylist}
                onCreatePlaylistWith={createPlaylistWith}
              />
            );
          })()}
        </>
        )}
            </div>
          </div>
          </div>
        </div>
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
