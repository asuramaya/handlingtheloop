import { useEffect, useMemo, useState } from "react";
import { fetchMyPlaylists } from "@htl/media";
import type { Library, TrackMeta } from "@htl/library";
import {
  type Candidate,
  type Confidence,
  type Me,
  type MatchRow,
  type Service,
  type ServicePlaylist,
  type SourceTrack,
  fetchSpotifyPlaylists,
  fetchTidalPlaylists,
  friendlySyncError as friendly,
  syncAdd,
  syncCreate,
  syncMatch,
  syncReadSource,
  syncSearch,
} from "@htl/account";

// Source can be either connected service OR the in-app library ("htl"): your
// Collection and htl playlists, pushed straight out to a streaming service.
type SyncSource = "htl" | Service;
const LABEL: Record<SyncSource, string> = { htl: "htl", youtube: "YouTube", spotify: "Spotify", tidal: "TIDAL" };
const MATCH_SLICE = 15; // tracks matched per request (Worker subrequest budget)
const COLLECTION_ID = "__collection__"; // sentinel: the whole htl Collection
const fmtDur = (s: number) => (s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "");

const CONF: Record<Confidence, { label: string; cls: string }> = {
  high: { label: "Match", cls: "c-high" },
  medium: { label: "Likely", cls: "c-medium" },
  low: { label: "Weak", cls: "c-low" },
  none: { label: "Not found", cls: "c-none" },
};

type Step = "pick" | "matching" | "review" | "committing" | "done";
interface Pick {
  id: string | null; // chosen candidate id (videoId/uri), or null = skip
  include: boolean;
}

// Fullscreen, review-before-commit playlist transfer. Source is a streaming
// service OR the in-app htl library; destination is a streaming service. Pick a
// source playlist, match every track on the destination, REVIEW and fix matches,
// then write only what you confirmed. Tracks that already carry the destination's
// stream id (your htl/YouTube collection → YouTube) match instantly, no search.
export function SyncPanel({
  me,
  library,
  onClose,
  embedded = false,
}: {
  me: Me;
  library: Library;
  onClose: () => void;
  embedded?: boolean; // render inline (taking over its parent), not as a full-screen modal
}) {
  const hasYouTube = me.connections.includes("google");
  const hasSpotify = me.connections.includes("spotify");
  const hasTidal = me.connections.includes("tidal");
  const connected = useMemo<Service[]>(
    () => [
      ...(hasYouTube ? (["youtube"] as const) : []),
      ...(hasSpotify ? (["spotify"] as const) : []),
      ...(hasTidal ? (["tidal"] as const) : []),
    ],
    [hasYouTube, hasSpotify, hasTidal],
  );

  const [step, setStep] = useState<Step>("pick");
  // Default to pushing your own library out — that's the new capability and it's
  // always available; otherwise start from whichever service is connected.
  const [source, setSource] = useState<SyncSource>("htl");
  const [dest, setDest] = useState<Service>(connected[0] ?? "youtube");
  const destOptions = useMemo(() => connected.filter((s) => s !== source), [connected, source]);

  // Keep the destination valid as the source changes (can't sync into the source).
  useEffect(() => {
    if (!destOptions.includes(dest)) setDest(destOptions[0] ?? dest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, destOptions]);

  // Native (htl) source lists: the Collection plus every htl playlist.
  const nativeLists = useMemo<ServicePlaylist[]>(
    () => [
      { id: COLLECTION_ID, title: "Collection", count: library.collection.length, thumbnail: null },
      ...library.playlists.map((p) => ({ id: p.id, title: p.name, count: p.trackIds.length, thumbnail: null })),
    ],
    [library],
  );

  const [playlists, setPlaylists] = useState<ServicePlaylist[]>([]);
  const [plState, setPlState] = useState<"idle" | "loading" | "error">("idle");
  const [plErr, setPlErr] = useState("");
  const [selected, setSelected] = useState<ServicePlaylist | null>(null);
  const [name, setName] = useState("");

  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [picks, setPicks] = useState<Record<number, Pick>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  // Per-row free-text re-search: query text + returned candidates, keyed by row.
  const [searchText, setSearchText] = useState<Record<number, string>>({});
  const [searchHits, setSearchHits] = useState<Record<number, Candidate[]>>({});
  const [searchBusy, setSearchBusy] = useState<number | null>(null);
  const [report, setReport] = useState<{ url: string; added: number; total: number } | null>(null);
  const [err, setErr] = useState("");
  const [writeNeeded, setWriteNeeded] = useState(false); // YouTube needs the manage scope → prompt incremental auth
  const [reloadNonce, setReloadNonce] = useState(0); // bump to re-fetch the source playlists after an error

  const lists = source === "htl" ? nativeLists : playlists;

  async function reSearch(index: number) {
    const q = (searchText[index] ?? "").trim();
    if (!q) return;
    setSearchBusy(index);
    try {
      const hits = await syncSearch(dest, q);
      setSearchHits((h) => ({ ...h, [index]: hits }));
    } catch (e) {
      setErr(friendly((e as Error).message));
    } finally {
      setSearchBusy(null);
    }
  }

  // Load the chosen source's playlists (service sources only — native lists are
  // derived synchronously above).
  useEffect(() => {
    setSelected(null);
    if (source === "htl") {
      setPlState("idle");
      setPlErr("");
      return;
    }
    let cancelled = false;
    setPlState("loading");
    setPlErr("");
    const load =
      source === "youtube" ? fetchMyPlaylists() : source === "tidal" ? fetchTidalPlaylists() : fetchSpotifyPlaylists();
    load
      .then((pls) => !cancelled && (setPlaylists(pls), setPlState("idle")))
      .catch((e) => !cancelled && (setPlErr(friendly((e as Error).message)), setPlState("error")));
    return () => {
      cancelled = true;
    };
  }, [source, reloadNonce]);

  const includedCount = useMemo(
    () => Object.values(picks).filter((p) => p.include && p.id).length,
    [picks],
  );

  // Native source tracks → SourceTrack shape (videoId is the YouTube stream id).
  function nativeSourceTracks(listId: string): SourceTrack[] {
    let metas: TrackMeta[];
    if (listId === COLLECTION_ID) {
      metas = library.collection;
    } else {
      const pl = library.playlists.find((p) => p.id === listId);
      const byId = new Map(library.collection.map((t) => [t.videoId, t]));
      metas = (pl?.trackIds ?? []).map((id) => byId.get(id)).filter((t): t is TrackMeta => !!t);
    }
    return metas.map((t) => ({
      title: t.title,
      artist: t.artist,
      duration: t.duration,
      thumbnail: t.thumbnail,
      isrc: null,
      spotifyId: null,
      videoId: t.videoId,
    }));
  }

  // A track that already carries the destination's stream id (htl/YouTube → YouTube)
  // is a guaranteed match — no search, no quota.
  function directRow(index: number, t: SourceTrack): MatchRow {
    const cand: Candidate = {
      id: t.videoId as string,
      kind: "video",
      title: t.title,
      artist: t.artist,
      duration: t.duration,
      thumbnail: t.thumbnail,
    };
    return { index, source: t, best: cand, confidence: "high", alternatives: [cand] };
  }

  async function findMatches() {
    if (!selected || !dest) return;
    setErr("");
    setStep("matching");
    try {
      const srcTracks =
        source === "htl" ? nativeSourceTracks(selected.id) : (await syncReadSource(source, selected.id)).tracks;
      if (srcTracks.length === 0) {
        setErr(`“${selected.title}” has no tracks to sync.`);
        setStep("pick");
        return;
      }
      setProgress({ done: 0, total: srcTracks.length });

      const rowsOut: MatchRow[] = [];
      const pending: { track: SourceTrack; index: number }[] = [];
      srcTracks.forEach((t, i) => {
        if (dest === "youtube" && t.videoId) rowsOut.push(directRow(i, t));
        else pending.push({ track: t, index: i });
      });
      setProgress({ done: rowsOut.length, total: srcTracks.length });

      for (let i = 0; i < pending.length; i += MATCH_SLICE) {
        const slice = pending.slice(i, i + MATCH_SLICE);
        const r = await syncMatch(dest, slice.map((s) => s.track), 0);
        r.forEach((row, k) => rowsOut.push({ ...row, index: slice[k].index }));
        setProgress({ done: rowsOut.length, total: srcTracks.length });
      }
      rowsOut.sort((a, b) => a.index - b.index);

      const initial: Record<number, Pick> = {};
      for (const row of rowsOut) {
        initial[row.index] = { id: row.best?.id ?? null, include: !!row.best && row.confidence !== "none" };
      }
      setRows(rowsOut);
      setPicks(initial);
      setStep("review");
    } catch (e) {
      setErr(friendly((e as Error).message));
      setStep("pick");
    }
  }

  const setPick = (index: number, patch: Partial<Pick>) =>
    setPicks((p) => ({ ...p, [index]: { ...p[index], ...patch } }));

  async function commit() {
    setErr("");
    setWriteNeeded(false);
    setStep("committing");
    try {
      const ids = rows
        .filter((r) => picks[r.index]?.include && picks[r.index]?.id)
        .map((r) => picks[r.index].id as string);
      const { playlistId, url } = await syncCreate(dest, name.trim() || `${selected?.title} · via htl`);
      const chunk = dest === "youtube" ? 10 : 100;
      let added = 0;
      for (let i = 0; i < ids.length; i += chunk) {
        added += await syncAdd(dest, playlistId, ids.slice(i, i + chunk));
        setProgress({ done: Math.min(i + chunk, ids.length), total: ids.length });
      }
      setReport({ url, added, total: rows.length });
      setStep("done");
    } catch (e) {
      const msg = (e as Error).message;
      // Writing to YouTube needs the manage scope; the Worker returns this when the
      // user only granted read-only sign-in. Offer the one-click grant instead of a
      // raw error (the destination playlist may already exist as an empty shell —
      // re-running Transfer after granting fills it).
      if (/youtube_write_required/.test(msg)) setWriteNeeded(true);
      else setErr(friendly(msg));
      setStep("review");
    }
  }

  const noDest = destOptions.length === 0;

  const inner = (
      <div
        className={`sync-full ${embedded ? "embedded" : ""}`}
        onPointerDown={embedded ? undefined : (e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <h2>
            Sync playlists{" "}
            <span className="sync-dir-chip">
              {LABEL[source]} → {dest ? LABEL[dest] : "—"}
            </span>
          </h2>
          <button className="mini x" onClick={onClose} aria-label={embedded ? "Back to library" : "Close"}>
            ✕
          </button>
        </div>

        {connected.length === 0 ? (
          <p className="settings-hint">
            Connect <strong>YouTube</strong> or <strong>Spotify</strong> in your <strong>Profile</strong> (🌐) to transfer
            playlists.
          </p>
        ) : step === "pick" ? (
          <div className="sync-body">
            <div className="sync-dir">
              <label className="sync-from">
                From
                <select value={source} onChange={(e) => setSource(e.target.value as SyncSource)}>
                  <option value="htl">htl (Collection &amp; playlists)</option>
                  {hasYouTube && <option value="youtube">YouTube</option>}
                  {hasSpotify && <option value="spotify">Spotify</option>}
                  {hasTidal && <option value="tidal">TIDAL</option>}
                </select>
              </label>
              <span className="sync-arrow">→</span>
              {destOptions.length > 1 ? (
                <label className="sync-from">
                  To
                  <select value={dest} onChange={(e) => setDest(e.target.value as Service)}>
                    {destOptions.map((s) => (
                      <option key={s} value={s}>
                        {LABEL[s]}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="sync-to">
                  To <strong>{destOptions[0] ? LABEL[destOptions[0]] : "—"}</strong>
                </span>
              )}
            </div>
            {noDest ? (
              <p className="settings-hint">
                Connect a second service to sync into — {source === "spotify" ? "YouTube" : "Spotify"} isn't linked yet.
              </p>
            ) : (
              <>
                <div className="sync-picker">
                  {plState === "loading" && <div className="lib-mine-msg">Loading {LABEL[source]} playlists…</div>}
                  {plState === "error" && (
                    <div className="lib-mine-msg lib-mine-err">
                      {plErr}
                      <button className="link-btn" onClick={() => setReloadNonce((n) => n + 1)}>
                        Retry
                      </button>
                    </div>
                  )}
                  {plState === "idle" && lists.length === 0 && <div className="lib-mine-msg">No playlists found.</div>}
                  {plState !== "error" &&
                    lists.map((p) => (
                      <button
                        key={p.id}
                        className={`sync-pl ${selected?.id === p.id ? "active" : ""}`}
                        onClick={() => {
                          setSelected(p);
                          setName(`${p.title} · via htl`);
                        }}
                      >
                        {p.thumbnail && <img className="sync-pl-thumb" src={p.thumbnail} alt="" />}
                        <span className="sync-pl-name">{p.title}</span>
                        {p.ownedByMe === false && (
                          <span
                            className="sync-pl-tag"
                            title={`Shared with you${p.ownerName ? ` by ${p.ownerName}` : ""} — Spotify may not let us read its tracks. If it errors, save your own copy and sync that.`}
                          >
                            shared
                          </span>
                        )}
                        {p.count > 0 && <span className="lib-count">{p.count}</span>}
                      </button>
                    ))}
                </div>
                {err && <p className="signin-err">{err}</p>}
                <div className="sync-run">
                  <input
                    className="yt-input"
                    placeholder={`New ${LABEL[dest]} playlist name…`}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!selected}
                  />
                  <button className="hw-btn signin" onClick={findMatches} disabled={!selected}>
                    Find matches →
                  </button>
                </div>
              </>
            )}
          </div>
        ) : step === "matching" ? (
          <div className="sync-body sync-center">
            <p>Matching tracks on {LABEL[dest]}…</p>
            <div className="sync-progress">
              <div className="sync-progress-bar" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
            <p className="settings-hint">
              {progress.done} / {progress.total}
            </p>
          </div>
        ) : step === "committing" ? (
          <div className="sync-body sync-center">
            <p>Adding to {LABEL[dest]}…</p>
            <div className="sync-progress">
              <div className="sync-progress-bar" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
            <p className="settings-hint">
              {progress.done} / {progress.total}
            </p>
          </div>
        ) : step === "done" && report ? (
          <div className="sync-body sync-center">
            <div className="sync-done-check">✓</div>
            <p>
              Added <strong>{report.added}</strong> of {report.total} tracks to {LABEL[dest]}.
            </p>
            <a className="hw-btn signin" href={report.url} target="_blank" rel="noreferrer noopener">
              Open in {LABEL[dest]}
            </a>
            <button className="link-btn" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          // review
          <>
            <div className="sync-review-head">
              <span>
                {includedCount} of {rows.length} will transfer — fix or skip any below.
              </span>
              <button className="hw-btn signin" onClick={commit} disabled={includedCount === 0}>
                Transfer {includedCount} →
              </button>
            </div>
            {writeNeeded && (
              <div className="sync-write-prompt">
                <span>YouTube needs your permission to create &amp; edit playlists.</span>
                <a className="hw-btn signin" href="/api/auth/google/start?write=1">
                  Grant access →
                </a>
              </div>
            )}
            {err && <p className="signin-err">{err}</p>}
            <div className="sync-review">
              {rows.map((row) => {
                const pick = picks[row.index] ?? { id: null, include: false };
                const chosen: Candidate | null =
                  row.alternatives.find((c) => c.id === pick.id) ?? (pick.id === row.best?.id ? row.best : null);
                return (
                  <div key={row.index} className={`sync-row ${pick.include ? "" : "skipped"}`}>
                    <input
                      type="checkbox"
                      checked={pick.include}
                      onChange={(e) => setPick(row.index, { include: e.target.checked })}
                      title="Include in transfer"
                    />
                    <div className="sync-src">
                      <div className="sync-tt" title={row.source.title}>
                        {row.source.title}
                      </div>
                      <div className="sync-ar">
                        {row.source.artist} {fmtDur(row.source.duration) && `· ${fmtDur(row.source.duration)}`}
                      </div>
                    </div>
                    <span className="sync-arrow2">→</span>
                    <div className="sync-dst">
                      {chosen ? (
                        <>
                          <div className="sync-tt" title={chosen.title}>
                            {chosen.title}
                          </div>
                          <div className="sync-ar">
                            {chosen.artist} {fmtDur(chosen.duration) && `· ${fmtDur(chosen.duration)}`}
                          </div>
                        </>
                      ) : (
                        <div className="sync-ar">No match selected</div>
                      )}
                    </div>
                    <span className={`sync-badge ${CONF[row.confidence].cls}`}>{CONF[row.confidence].label}</span>
                    <button
                      className="link-btn sync-change"
                      onClick={() => setExpanded(expanded === row.index ? null : row.index)}
                    >
                      {expanded === row.index ? "close" : "change"}
                    </button>
                    {expanded === row.index && (
                      <div className="sync-alts">
                        <div className="sync-research">
                          <input
                            className="yt-input"
                            value={searchText[row.index] ?? `${row.source.artist} ${row.source.title}`}
                            onChange={(e) => setSearchText((s) => ({ ...s, [row.index]: e.target.value }))}
                            onKeyDown={(e) => e.key === "Enter" && reSearch(row.index)}
                            placeholder={`Search ${LABEL[dest]}…`}
                          />
                          <button
                            className="hw-btn small"
                            onClick={() => reSearch(row.index)}
                            disabled={searchBusy === row.index}
                          >
                            {searchBusy === row.index ? "…" : "Search"}
                          </button>
                        </div>
                        {(searchHits[row.index] ?? row.alternatives).map((c) => (
                          <button
                            key={c.id}
                            className={`sync-alt ${pick.id === c.id ? "active" : ""}`}
                            onClick={() => {
                              setPick(row.index, { id: c.id, include: true });
                              setExpanded(null);
                            }}
                          >
                            {c.thumbnail && <img src={c.thumbnail} alt="" />}
                            <span>
                              {c.title} <em>{c.artist}</em> {fmtDur(c.duration)}
                            </span>
                          </button>
                        ))}
                        {(searchHits[row.index] ?? row.alternatives).length === 0 && (
                          <div className="lib-mine-msg">No results — try a different search.</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
  );
  return embedded ? (
    inner
  ) : (
    <div className="modal-backdrop" onPointerDown={onClose}>
      {inner}
    </div>
  );
}
