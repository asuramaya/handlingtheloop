import type { TrackMeta } from "@htl/library";
import { fmtTime } from "../util/format";

interface TrackTableProps {
  tracks: TrackMeta[];
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  onRemove?: (videoId: string) => void;
  removeTitle?: string;
  emptyHint: string;
  loadedIds?: Set<string>;
}

// rekordbox-style track list: artwork, #, Title, Artist, BPM, Key, Time + load
// actions. Tracks currently on a deck are tinted green (as rekordbox does).
// Double-click a row loads it to deck A (the rekordbox default gesture).
export function TrackTable({
  tracks,
  onLoad,
  onRemove,
  removeTitle,
  emptyHint,
  loadedIds,
}: TrackTableProps) {
  if (tracks.length === 0) {
    return <div className="lib-empty">{emptyHint}</div>;
  }
  return (
    <table className="track-table">
      <thead>
        <tr>
          <th className="col-num">#</th>
          <th className="col-thumb"></th>
          <th className="col-title">Title</th>
          <th className="col-artist">Artist</th>
          <th className="col-bpm">BPM</th>
          <th className="col-key">Key</th>
          <th className="col-time">Time</th>
          <th className="col-act"></th>
        </tr>
      </thead>
      <tbody>
        {tracks.map((t, i) => (
          <tr
            key={t.videoId}
            className={loadedIds?.has(t.videoId) ? "loaded" : ""}
            onDoubleClick={() => onLoad("A", t)}
          >
            <td className="col-num">{i + 1}</td>
            <td className="col-thumb">
              {t.thumbnail && <img src={t.thumbnail} alt="" loading="lazy" />}
            </td>
            <td className="col-title" title={t.title}>
              {t.title}
            </td>
            <td className="col-artist" title={t.artist}>
              {t.artist}
            </td>
            <td className="col-bpm">{t.bpm != null ? t.bpm.toFixed(1) : "—"}</td>
            <td className="col-key">—</td>
            <td className="col-time">{fmtTime(t.duration)}</td>
            <td className="col-act">
              <button className="mini a" title="Load to deck A" onClick={() => onLoad("A", t)}>
                A
              </button>
              <button className="mini b" title="Load to deck B" onClick={() => onLoad("B", t)}>
                B
              </button>
              {onRemove && (
                <button
                  className="mini x"
                  title={removeTitle ?? "Remove"}
                  onClick={() => onRemove(t.videoId)}
                >
                  ✕
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
