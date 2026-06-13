import { useMemo } from "react";
import type { Library } from "@htl";
import {
  type AutoMixStatus,
  type MixQueue,
  type TrackMeta,
  pickTransition,
  transitionLabel,
  mixabilityTier,
} from "@htl";

// The auto-mix "up next" panel: curate the queue, see how each pair will transition,
// and drive the auto-DJ (mix now / skip / hold). Radio mode tops itself up from the
// playing track; playlist mode seeds from a saved library playlist.

interface Props {
  queue: MixQueue;
  status: AutoMixStatus;
  library: Library;
  onToggleAuto: () => void;
  onMixNow: () => void;
  onSkip: () => void;
  onHold: () => void;
  onClose: () => void;
}

function fmtCountdown(sec: number): string {
  if (sec >= 60) return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
  return `${Math.ceil(sec)}s`;
}

function TrackRow({ t }: { t: TrackMeta }) {
  return (
    <div className="mixq-track">
      {t.thumbnail && <img src={t.thumbnail} alt="" loading="lazy" />}
      <div className="mixq-track-text">
        <span className="mixq-title">{t.title || t.videoId}</span>
        <span className="mixq-artist">
          {t.artist}
          {t.key ? ` · ${t.key}` : ""}
          {t.bpm ? ` · ${Math.round(t.bpm)}` : ""}
        </span>
      </div>
    </div>
  );
}

export function MixQueuePanel({ queue, status, library, onToggleAuto, onMixNow, onSkip, onHold, onClose }: Props) {
  const enabled = status.enabled;

  // Resolve each playlist's videoIds against the collection so we can seed the queue.
  const byId = useMemo(() => {
    const m = new Map<string, TrackMeta>();
    for (const t of library.collection) m.set(t.videoId, t);
    return m;
  }, [library.collection]);

  const seedPlaylist = (playlistId: string) => {
    const pl = library.playlists.find((p) => p.id === playlistId);
    if (!pl) return;
    const tracks = pl.trackIds.map((id) => byId.get(id)).filter((t): t is TrackMeta => !!t);
    if (!tracks.length) return;
    queue.loadTracks(tracks, { smartSort: queue.smartSort, mode: "playlist" });
  };

  return (
    <div className="mixq" role="dialog" aria-label="Auto-mix queue">
      <header className="mixq-head">
        <button className={`mixq-auto ${enabled ? "on" : ""}`} onClick={onToggleAuto} aria-pressed={enabled}>
          AUTO
        </button>
        <div className="mixq-mode" role="tablist">
          <button role="tab" aria-selected={queue.mode === "playlist"} onClick={() => queue.setMode("playlist")}>
            Playlist
          </button>
          <button role="tab" aria-selected={queue.mode === "radio"} onClick={() => queue.setMode("radio")}>
            Radio
          </button>
        </div>
        <button className="mixq-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {queue.mode === "playlist" && (
        <div className="mixq-seed">
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) seedPlaylist(e.target.value);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              Load a playlist…
            </option>
            {library.playlists.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.trackIds.length})
              </option>
            ))}
          </select>
          <label className="mixq-smart">
            <input type="checkbox" checked={queue.smartSort} onChange={(e) => queue.setSmartSort(e.target.checked)} />
            Smart sort
          </label>
        </div>
      )}

      <div className="mixq-now">
        {queue.current ? <TrackRow t={queue.current} /> : <div className="mixq-empty">Play a track to begin</div>}
        {status.countdownSec != null && status.phase !== "idle" && (
          <span className="mixq-countdown">
            {status.phase === "mixing" ? "mixing…" : `mix in ${fmtCountdown(status.countdownSec)}`}
          </span>
        )}
      </div>

      <ul className="mixq-list">
        {queue.upcoming.map((t, i) => {
          const prev = i === 0 ? queue.current : queue.upcoming[i - 1];
          const plan = prev ? pickTransition(prev, t) : null;
          return (
            <li key={`${t.videoId}:${i}`} className="mixq-item">
              {plan && (
                <span className={`mixq-badge tier-${mixabilityTier(plan.score)}`} title={`mixability ${Math.round(plan.score * 100)}%`}>
                  {transitionLabel(plan)}
                </span>
              )}
              <TrackRow t={t} />
              <div className="mixq-item-actions">
                <button onClick={() => queue.reorder(i, i - 1)} disabled={i === 0} aria-label="Move up">
                  ↑
                </button>
                <button onClick={() => queue.reorder(i, i + 1)} disabled={i === queue.upcoming.length - 1} aria-label="Move down">
                  ↓
                </button>
                <button onClick={() => queue.remove(t.videoId)} aria-label="Remove">
                  ✕
                </button>
              </div>
            </li>
          );
        })}
        {queue.upcoming.length === 0 && (
          <li className="mixq-empty">
            {queue.mode === "radio" ? "Suggestions appear as you play" : "Load a playlist to queue tracks"}
          </li>
        )}
      </ul>

      <footer className="mixq-controls">
        <button onClick={onMixNow} disabled={!enabled}>
          Mix now
        </button>
        <button onClick={onSkip} disabled={!enabled}>
          Skip
        </button>
        <button onClick={onHold} disabled={!enabled}>
          Hold
        </button>
      </footer>
    </div>
  );
}
