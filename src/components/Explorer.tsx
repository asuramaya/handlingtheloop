import { useEffect, useRef, useState } from "react";
import type { TrackMeta } from "@htl/library";
import { searchYouTube, fetchMeta, parseVideoId, parsePlaylistId } from "@htl/media";
import { loadSearchState, saveSearchState } from "@htl/state";
import { TrackTable } from "./TrackTable";

interface ExplorerProps {
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  onAdd: (track: TrackMeta) => void;
  inCollection: (videoId: string) => boolean;
  // Paste a playlist link/id → pull it straight into the library.
  onIngestPlaylist: (listId: string) => Promise<void>;
  playlists: { id: string; name: string }[];
  onAddToPlaylist: (playlistId: string, track: TrackMeta) => void;
  onCreatePlaylistWith: (tracks: TrackMeta[]) => void;
  deckLoaded?: { A: string | null; B: string | null };
  deckColors?: { A: string; B: string };
}

// Live YouTube search that also ingests pasted links: a video URL/id resolves to a
// single result, a playlist URL/id is pulled straight into the library. Only YouTube —
// there's no arbitrary-URL import, so nothing untrusted gets fetched. Results render
// through the shared TrackTable (same look/sort/columns as the library + queue); this
// component just owns the search request + the persisted dig session.
export function Explorer({ onLoad, onAdd, inCollection, onIngestPlaylist, playlists, onAddToPlaylist, onCreatePlaylistWith, deckLoaded, deckColors }: ExplorerProps) {
  const saved = useRef(loadSearchState()).current;
  const [results, setResults] = useState<TrackMeta[]>(saved.results);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(saved.searched);
  const [lastQuery, setLastQuery] = useState(saved.query);
  const abort = useRef<AbortController | null>(null);

  // Persist the dig-session (not the transient request/error state) so a dig survives a
  // reopen. Filter/sort now live in the TrackTable, so only the query + results matter.
  useEffect(() => {
    saveSearchState({ ...saved, query: lastQuery, results, searched });
  }, [saved, lastQuery, results, searched]);

  async function run(q: string) {
    q = q.trim();
    if (!q) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setSearching(true);
    setError(null);
    setSearched(true);
    setLastQuery(q);
    // A pasted video link resolves to a single result; a playlist link is pulled into
    // the library; anything else is a normal text search. (Video wins over a trailing
    // &list= so "watch?v=…&list=…" loads the video you clicked.)
    const vid = parseVideoId(q);
    const list = vid ? null : parsePlaylistId(q);
    try {
      if (vid) {
        const meta = await fetchMeta(vid, ctrl.signal);
        if (!ctrl.signal.aborted) setResults([meta]);
      } else if (list) {
        await onIngestPlaylist(list); // jumps to the freshly imported playlist
      } else {
        const r = await searchYouTube(q, 30, ctrl.signal);
        if (!ctrl.signal.aborted) setResults(r);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ctrl.signal.aborted) setSearching(false);
    }
  }

  const emptyHint =
    searched && !searching
      ? "No results."
      : "Search YouTube to find tracks, then load or save them — or paste a video or playlist link to pull it in.";

  return (
    <TrackTable
      tracks={results}
      onLoad={onLoad}
      onAddToCollection={onAdd}
      inCollection={inCollection}
      playlists={playlists}
      onAddToPlaylist={onAddToPlaylist}
      onCreatePlaylistWith={onCreatePlaylistWith}
      onSubmitSearch={run}
      searching={searching}
      initialQuery={saved.query}
      searchPlaceholder="Search YouTube, or paste a video / playlist link…"
      emptyHint={emptyHint}
      deckLoaded={deckLoaded}
      deckColors={deckColors}
      topSlot={error ? <div className="lib-empty error">{error}</div> : undefined}
    />
  );
}
