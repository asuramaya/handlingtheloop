import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Library, Playlist } from "@htl/library";
import type { TrackMeta } from "@htl/library";
import { getCachedMeta } from "@htl/audio";
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
  fetchTidalPlaylists,
  friendlySyncError,
  syncReadSource,
  syncMatch,
  usePlaylistSource,
  type Me,
  type ServicePlaylist,
} from "@htl/account";
import { Store } from "@htl/persistence";
import { isMobileDevice, type AutoMixStatus, type AutoMixMirror, type MixQueue } from "@htl";
import { MixQueuePanel } from "./MixQueuePanel";

// Backfilled metadata for community (legacy-cached) tracks, persisted so titles
// survive reloads and we don't re-hit /api/meta on every library open.
type CachedMeta = { title: string; artist: string; duration: number; thumbnail: string | null };
const communityMeta = new Store<Record<string, CachedMeta>>("community-meta", {}, 1);
import { Explorer } from "./Explorer";
import { SyncPanel } from "./SyncPanel";
import { SetupWizard } from "./SetupWizard";
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
  // Read the LIGHT bpm/key cache, not getCachedTrack — the heavy decoded-buffer cache is now
  // LRU-bounded (mobile OOM fix), so its entry may have been evicted, but the scalar bpm/key
  // is kept for the whole session so the columns stay filled.
  const m = getCachedMeta(t.videoId);
  if (!m) return t;
  return {
    ...t,
    bpm: t.bpm ?? m.bpm ?? null,
    key: t.key ?? m.key ?? null,
  };
}

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
  const [view, setView] = useState<View>("collection");
  // Search is baked into the library now (no separate dock): selecting it shows the
  // Explorer (its own search bar + results) in the main content area, like Sync.
  const [searchView, setSearchView] = useState(false);
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
  const [syncOpen, setSyncOpen] = useState(false);
  // Picking any library view (Collection / Community / a playlist) exits the Sync
  // subsection — they share the main content area.
  useEffect(() => {
    setSyncOpen(false);
    setSearchView(false);
  }, [view]);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // Selecting any library section (Collection / Community / a playlist…) returns to the
  // song list by closing the auto-mix queue view — the queue is just another tab now, so
  // there's no explicit "← Songs" button.
  const closeQueue = () => {
    if (auto?.queueOpen) auto.onToggleQueue();
  };

  // htl account (server session) — its Google connection is what reaches the
  // user's YouTube playlists. A login cookie (SAPISID) is a fallback path.
  const [me, setMe] = useState<Me | null>(null);
  const ytConnected = !!me?.connections.includes("google");
  const spotifyConnected = !!me?.connections.includes("spotify");
  const tidalConnected = !!me?.connections.includes("tidal");

  // Setup/import wizard: auto-launch once on first sign-in with an empty library;
  // also openable any time from the sidebar.
  const [wizardOpen, setWizardOpen] = useState(false);
  useEffect(() => {
    // Desktop only — a full-screen wizard auto-popping on a phone reads as a freeze.
    if (me?.user && !isMobileDevice() && library.playlists.length === 0 && !localStorage.getItem("htl:wizardSeen")) {
      localStorage.setItem("htl:wizardSeen", "1");
      setWizardOpen(true);
    }
  }, [me?.user, library.playlists.length]);

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

  useEffect(() => {
    fetchMe().then(setMe);
  }, []);

  // Import a streaming-service playlist INTO the library: read its tracks, match
  // each to a playable YouTube video (paged to stay under the Worker subrequest
  // cap), then file the best matches into a local playlist tagged with the source
  // service so it lives under MY SPOTIFY / MY TIDAL. Auto-picks the top match (use
  // Sync for review/fixups). Provider-agnostic — Spotify and TIDAL share it.
  async function importServicePlaylist(service: "spotify" | "tidal", sp: ServicePlaylist) {
    const label = service === "tidal" ? "TIDAL" : "Spotify";
    setImporting(true);
    setImportMsg(`Reading “${sp.title}” from ${label}…`);
    try {
      const { name, tracks } = await syncReadSource(service, sp.id);
      if (!tracks.length) throw new Error("empty playlist");
      const matched: TrackMeta[] = [];
      // Match in slices: each track is one YouTube search subrequest, and the Worker
      // caps a single /api/sync/match call (a whole playlist in one call 413s and was
      // the "stuck / can't import" bug). Paging also gives real per-slice progress.
      const SLICE = 15;
      for (let i = 0; i < tracks.length; i += SLICE) {
        const rows = await syncMatch("youtube", tracks.slice(i, i + SLICE), i);
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
        setImportMsg(`Matching ${Math.min(i + SLICE, tracks.length)}/${tracks.length} from ${label}…`);
      }
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

  // Re-sync an already-imported playlist: re-read the provider's CURRENT tracks and
  // merge any new ones into the local copy (provider playlists have no change hooks).
  // Removed tracks are pruned only for exact-id YouTube sources — matched (Spotify/
  // TIDAL) playlists can re-match to a different video, so we never prune those.
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
              <button className="mini x" onClick={() => onOpenChange(false)} aria-label="Close">
                ✕
              </button>
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
          className={`lib-nav ${view === "collection" && !searchView && !auto?.queueOpen ? "active" : ""} ${dragPl === "collection" ? "drag-over" : ""}`}
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
          className={`lib-nav ${view === "community" && !auto?.queueOpen ? "active" : ""}`}
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
            title="Sync playlists between YouTube and Spotify"
          >
            <span className="lib-nav-ico">⇄</span> Sync
          </button>
        )}
        <button
          className="lib-nav"
          onClick={() => {
            closeQueue();
            setWizardOpen(true);
          }}
          title="Connect a service and import playlists"
        >
          <span className="lib-nav-ico">⤓</span> Import
        </button>

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
          // (embedded, no separate modal) so the top chin stays clean.
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

      {wizardOpen && (
        <SetupWizard
          me={me}
          library={library}
          ytPlaylists={mine}
          spotifyPlaylists={spotMine}
          tidalPlaylists={tidalMine}
          onClose={() => setWizardOpen(false)}
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
