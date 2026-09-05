import { useMemo, useState, type DragEvent } from "react";
import type { Library } from "@htl";
import {
  type AutoMixStatus,
  type EnergyArc,
  type AutoMixMirror,
  type MixQueue,
  type TrackMeta,
  pickTransition,
  transitionLabel,
  planTier,
} from "@htl";
import { TRACK_DND_MIME, TrackTable } from "./TrackTable";

// The auto-mix "up next" panel: curate the queue, see how each pair will transition,
// and drive the auto-DJ (mix now / skip / hold). Radio mode tops itself up from the
// playing track; playlist mode seeds from a saved library playlist. The upcoming list
// renders through the shared TrackTable (same look/columns/sort as the library +
// search) — this component owns only the queue-specific chrome: the now-playing strip,
// the seed dropdown, the per-pair transition badge column, and the transport controls.

interface Props {
  queue: MixQueue;
  status: AutoMixStatus;
  library: Library;
  mirror?: AutoMixMirror | null; // in a session, the HOST's queue/status — render its tracks
  // Queue mutations route through one authority (host local, or remote → intent → host).
  // In a session the panel renders the host's mirror but edits flow back as intents, so a
  // controlling remote can add/remove/move even while mirroring.
  edit: {
    add: (t: TrackMeta) => void;
    addNext: (t: TrackMeta) => void;
    remove: (videoId: string) => void;
    move: (from: number, to: number) => void;
  };
  canEdit: boolean; // host/solo, or a controlling remote — may mutate the queue
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  deckLoaded?: { A: string | null; B: string | null };
  deckColors?: { A: string; B: string };
  onToggleAuto: () => void;
  onMixNow: () => void;
  onSkip: () => void;
  onHold: () => void;
  onClose: () => void;
  embedded?: boolean; // rendered inside the library content area (not a floater)
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

export function MixQueuePanel({ queue, status, library, mirror, edit, canEdit, onLoad, deckLoaded, deckColors, onToggleAuto, onMixNow, onSkip, onHold, onClose, embedded }: Props) {
  // `mirror` only chooses the DISPLAY source (a session renders the host's queue). Editing
  // is gated separately by `canEdit`: a controlling remote mutates the host's queue via
  // intents (routed through `edit`), so it can add/remove/move while still mirroring. Seed
  // + mode stay host-only (the radio engine), shown only when we own the queue (`!mirror`).
  const ownsSeed = !mirror; // seed/mode dropdown only where the local queue is the source
  const [dropping, setDropping] = useState(false);

  // Drag a track in from the library / search / a deck to append it to the queue. The
  // payload is the shared TRACK_DND_MIME track array. Intra-list reorder drags also carry
  // ROW_INDEX_MIME and are handled by the rows themselves — skip those here so a row move
  // doesn't double as an add. Routed through `edit` so a remote's add reaches the host.
  const onDropTracks = (e: DragEvent) => {
    setDropping(false);
    if (!canEdit || e.dataTransfer.types.includes("application/x-htl-row-index")) return;
    const raw = e.dataTransfer.getData(TRACK_DND_MIME);
    if (!raw) return;
    e.preventDefault();
    try {
      const tracks = JSON.parse(raw) as TrackMeta[];
      for (const t of tracks) if (t?.videoId) edit.add(t);
    } catch {
      /* malformed payload — ignore */
    }
  };
  const st = mirror?.status ?? status;
  const mode = mirror?.mode ?? queue.mode;
  const current = mirror ? mirror.current : queue.current;
  const upcoming = mirror ? mirror.upcoming : queue.upcoming;
  const enabled = st.enabled;

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

  // The queue-specific chrome that sits ABOVE the shared table: the seed dropdown +
  // the now-playing strip with its mix-in countdown.
  const topSlot = (
    <>
      {ownsSeed && (
        <div className="mixq-seed">
          <select
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__radio__") queue.loadTracks([], { mode: "radio" });
              else if (v) seedPlaylist(v);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              {mode === "playlist" ? "Playlist loaded — switch…" : "Radio — suggesting from what you play"}
            </option>
            <option value="__radio__">↺ Radio — auto-suggest from what you play</option>
            {library.playlists.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.trackIds.length})
              </option>
            ))}
          </select>
          {/* THE ARC — the difference between a sequence of compatible tracks and a set that goes
              somewhere. It re-scores the pool rather than re-fetching it, so switching is instant;
              the queued tail is dropped so the new shape starts on the NEXT track rather than after
              the four already-chosen ones have played out. */}
          <select
            className="mixq-arc"
            value={queue.arc}
            onChange={(e) => queue.setArc(e.target.value as EnergyArc)}
            title="Energy arc — how the set's intensity moves over time"
            aria-label="Energy arc"
          >
            <option value="ride">↔ Ride</option>
            <option value="build">↗ Build</option>
            <option value="journey">∿ Journey</option>
          </select>
        </div>
      )}
      <div className="mixq-now">
        {current ? <TrackRow t={current} /> : <div className="mixq-empty">{mirror ? "Host isn’t playing yet" : "Play a track to begin"}</div>}
        {st.countdownSec != null && st.phase !== "idle" && (
          <span className="mixq-countdown">{st.phase === "mixing" ? "mixing…" : `mix in ${fmtCountdown(st.countdownSec)}`}</span>
        )}
      </div>
    </>
  );

  // The per-pair transition badge ("Blend 24", "Cut"…) as the table's trailing column.
  const extraCol = {
    header: "Mix",
    render: (t: TrackMeta, i: number) => {
      const prev = i === 0 ? current : upcoming[i - 1];
      const plan = prev ? pickTransition(prev, t) : null;
      if (!plan) return null;
      return (
        <span
          className={`mixq-badge tier-${planTier(plan)}`}
          title={plan.confident ? `mixability ${Math.round(plan.score * 100)}%` : "not yet analysed — provider-suggested order"}
        >
          {transitionLabel(plan)}
        </span>
      );
    },
  };

  const footer = (
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
  );

  return (
    <div
      className={`mixq ${embedded ? "embedded" : ""} ${dropping ? "drop-active" : ""}`}
      role={embedded ? undefined : "dialog"}
      aria-label="Auto-mix queue"
      onDragOver={(e) => {
        if (!canEdit || e.dataTransfer.types.includes("application/x-htl-row-index") || !e.dataTransfer.types.includes(TRACK_DND_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={onDropTracks}
    >
      {/* Floating dialog keeps its own AUTO + close. Embedded in the library the header
          carries AUTO and the sidebar tabs handle "back to songs" — so no extra chrome. */}
      {!embedded && (
        <header className="mixq-head">
          <button className={`mixq-auto ${enabled ? "on" : ""}`} onClick={onToggleAuto} aria-pressed={enabled}>
            AUTO
          </button>
          <button className="mixq-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
      )}
      <TrackTable
        tracks={upcoming}
        onLoad={onLoad}
        deckLoaded={deckLoaded}
        deckColors={deckColors}
        onRemove={canEdit ? edit.remove : undefined}
        removeTitle="Remove from queue"
        onReorder={canEdit ? edit.move : undefined}
        extraCol={extraCol}
        topSlot={topSlot}
        footer={footer}
        emptyHint={
          canEdit
            ? mode === "radio"
              ? "Suggestions appear as you play — or drop tracks here"
              : "Drop tracks here, or load a playlist"
            : mirror
              ? "Host’s queue is empty"
              : mode === "radio"
                ? "Suggestions appear as you play"
                : "Load a playlist to queue tracks"
        }
      />
    </div>
  );
}
