import { useRef, useState } from "react";
import type { TrackMeta } from "@htl/library";
import { searchYouTube } from "@htl/media";
import { fmtTime, fmtViews } from "../util/format";

interface ExplorerProps {
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  onAdd: (track: TrackMeta) => void;
  inCollection: (videoId: string) => boolean;
}

// Live YouTube search. Results stream straight into the decks (A/B) or get
// saved to the collection — no leaving the app.
export function Explorer({ onLoad, onAdd, inCollection }: ExplorerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TrackMeta[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const abort = useRef<AbortController | null>(null);

  async function run() {
    const q = query.trim();
    if (!q) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setSearching(true);
    setError(null);
    setSearched(true);
    try {
      const r = await searchYouTube(q, 30, ctrl.signal);
      if (!ctrl.signal.aborted) setResults(r);
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ctrl.signal.aborted) setSearching(false);
    }
  }

  return (
    <div className="explorer">
      <div className="search-bar">
        <input
          className="search-input"
          placeholder="Search YouTube — tracks, artists, sets…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          autoFocus
        />
        <button className="btn" onClick={run} disabled={searching || !query.trim()}>
          {searching ? "…" : "Search"}
        </button>
      </div>

      {error && <div className="lib-empty error">{error}</div>}
      {!error && searched && !searching && results.length === 0 && (
        <div className="lib-empty">No results.</div>
      )}
      {!searched && !error && (
        <div className="lib-empty">Search YouTube to find tracks, then load or save them.</div>
      )}

      <div className="result-list">
        {results.map((t) => (
          <div className="result-row" key={t.videoId} onDoubleClick={() => onLoad("A", t)}>
            <div className="thumb">
              {t.thumbnail && <img src={t.thumbnail} alt="" loading="lazy" />}
              <span className="thumb-time">{fmtTime(t.duration)}</span>
            </div>
            <div className="result-meta">
              <div className="result-title" title={t.title}>
                {t.title}
              </div>
              <div className="result-sub">
                {t.artist}
                {t.views != null && <span className="dot">·</span>}
                {t.views != null && `${fmtViews(t.views)} views`}
              </div>
            </div>
            <div className="result-actions">
              <button className="mini a" title="Load to deck A" onClick={() => onLoad("A", t)}>
                A
              </button>
              <button className="mini b" title="Load to deck B" onClick={() => onLoad("B", t)}>
                B
              </button>
              <button
                className="mini add"
                title={inCollection(t.videoId) ? "In collection" : "Add to collection"}
                disabled={inCollection(t.videoId)}
                onClick={() => onAdd(t)}
              >
                {inCollection(t.videoId) ? "✓" : "+"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
