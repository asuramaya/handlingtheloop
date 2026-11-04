import { displayArtist } from "../util/format";
import { useMemo, useState, type DragEvent } from "react";
import type { Library } from "@htl";
import { trackKey } from "@htl/library";
import {
  type AutoMixStatus,
  type EnergyArc,
  type AutoMixMirror,
  type MixQueue,
  type TrackMeta,
  type QueueSource,
  pickTransition,
  transitionLabel,
  planTier,
} from "@htl";
import { TRACK_DND_MIME, TrackTable, type TrackTableHandle } from "./TrackTable";
import type { Ref } from "react";
import { autoLine } from "./automixStatus";

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
  /** May this device ARM auto-mix? Host only (operator ruling, thread cb9000d2). Auto-mix drives
   *  both decks AND the crossfader, so a seat that cannot move the board could never complete a
   *  transition — and the automix intent carries no deck, so the server refuses it outright. Say
   *  so on the control rather than letting it look live and do nothing. */
  canAuto: boolean;
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  deckLoaded?: { A: string | null; B: string | null };
  deckColors?: { A: string; B: string };
  onToggleAuto: () => void;
  onMixNow: () => void;
  onSkip: () => void;
  onHold: () => void;
  onClose: () => void;
  embedded?: boolean; // rendered inside the library content area (not a floater)
  /** The library's handle on the visible table, so the board's browse encoder and LOAD buttons
   *  work on the queue too (they reach the table through this). */
  tableRef?: Ref<TrackTableHandle>;
}


function TrackRow({ t }: { t: TrackMeta }) {
  return (
    <div className="mixq-track">
      {t.thumbnail && <img src={t.thumbnail} alt="" loading="lazy" />}
      <div className="mixq-track-text">
        <span className="mixq-title">{t.title || t.videoId}</span>
        <span className="mixq-artist">
          {displayArtist(t.artist)}
          {t.key ? ` · ${t.key}` : ""}
          {t.bpm ? ` · ${Math.round(t.bpm)}` : ""}
        </span>
      </div>
    </div>
  );
}

export function MixQueuePanel({ queue, status, library, mirror, edit, canEdit, canAuto, onLoad, deckLoaded, deckColors, onToggleAuto, onMixNow, onSkip, onHold, onClose, embedded, tableRef }: Props) {
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

  // Resolve each playlist's trackKeys against the collection so we can seed the queue.
  const byKey = useMemo(() => {
    const m = new Map<string, TrackMeta>();
    for (const t of library.collection) m.set(trackKey(t), t);
    return m;
  }, [library.collection]);

  const seedPlaylist = (playlistId: string) => {
    const pl = library.playlists.find((p) => p.id === playlistId);
    if (!pl) return;
    const tracks = pl.trackKeys.map((k) => byKey.get(k)).filter((t): t is TrackMeta => !!t);
    if (!tracks.length) return;
    queue.loadTracks(tracks, { smartSort: queue.smartSort, mode: "playlist" });
  };

  // ★ THE QUEUE, REDESIGNED AROUND ONE QUESTION: WHAT IS AUTO DOING? (operator, 2026-11-04: "the
  // auto mode is a bit broken and confusing ... possibly a redesign"). Top to bottom:
  //   1. NOW / NEXT: the playing track, the one AUTO mixes into, and a sentence saying what happens
  //      next and when (automixStatus.ts), with the mix progress while it mixes.
  //   2. The three actions, always in the same place, each saying what it does. Hold is a toggle.
  //   3. Where the queue comes from (Radio or a playlist, showing the CURRENT choice; the old menu's
  //      label never changed) and the set's shape, as labelled buttons instead of "↔ Ride".
  const next = upcoming[0] ?? null;
  const line = autoLine(st, next ? next.title || next.videoId : null);
  const progress = st.phase === "mixing" && st.mixProgress != null ? st.mixProgress : null;
  const mixAt = st.mixOutTime != null && st.liveDuration ? Math.min(1, st.mixOutTime / st.liveDuration) : null;
  const topSlot = (
    <>
      <div className={`mixq-status tone-${line.tone}`} aria-live="polite">
        <div className="mixq-pair">
          <div className="mixq-slot">
            <span className="mixq-slot-label">Now</span>
            {current ? <TrackRow t={current} /> : <div className="mixq-empty">{mirror ? "Host isn’t playing yet" : "Nothing playing"}</div>}
          </div>
          <span className="mixq-arrow" aria-hidden="true">→</span>
          <div className="mixq-slot">
            <span className="mixq-slot-label">Next</span>
            {next ? <TrackRow t={next} /> : <div className="mixq-empty">Queue empty</div>}
          </div>
        </div>
        <div className="mixq-line">
          <span className="mixq-headline">{line.headline}</span>
          {line.detail && <span className="mixq-detail">{line.detail}</span>}
        </div>
        {(progress != null || mixAt != null) && (
          <div className="mixq-bar" aria-hidden="true">
            {progress != null ? <span className="mixq-bar-fill" style={{ width: `${progress * 100}%` }} /> : <span className="mixq-bar-mark" style={{ left: `${(mixAt ?? 0) * 100}%` }} />}
          </div>
        )}
      </div>
      <div className="mixq-controls">
        <button onClick={onMixNow} disabled={!enabled || !next} title="Start the mix into the next track now, from here">
          Mix now
        </button>
        <button onClick={onSkip} disabled={!enabled || !next} title="Drop the next track from the queue; the one after it moves up">
          Skip next
        </button>
        <button
          className={st.held ? "on" : ""}
          onClick={onHold}
          disabled={!enabled}
          aria-pressed={!!st.held}
          title={st.held ? "Stop holding: AUTO mixes at the usual point again" : "Stay on this track: no mix until you press Hold again or Mix now"}
        >
          {st.held ? "Holding" : "Hold"}
        </button>
      </div>
      {ownsSeed && (
        <div className="mixq-seed">
          <label className="mixq-field">
            <span className="mixq-field-label">From</span>
            <select
              value={mode === "playlist" ? "__playlist__" : "__radio__"}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__radio__") queue.loadTracks([], { mode: "radio" });
                else if (v !== "__playlist__") seedPlaylist(v);
              }}
              aria-label="Where the queue comes from"
            >
              <option value="__radio__">Radio (suggests from what is playing)</option>
              {mode === "playlist" && <option value="__playlist__">Playlist (loaded)</option>}
              {library.playlists.length > 0 && (
                <optgroup label="Load a playlist">
                  {library.playlists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.trackKeys.length})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          {/* THE ARC: how the set's energy moves. Re-scores the pool; the radio-drawn tail is
              replaced so the new shape starts on the next track (your own rows are kept). */}
          <div className="mixq-field">
            <span className="mixq-field-label">Shape</span>
            <span className="seg-group mixq-arc" role="group" aria-label="Energy shape of the set">
              {(
                [
                  ["ride", "Steady", "Keep the energy where it is"],
                  ["build", "Build", "Raise the energy track by track"],
                  ["journey", "Journey", "Rise to a peak, then come back down"],
                ] as const
              ).map(([v, label, tip]) => (
                <button key={v} className={`hw-btn small ${queue.arc === v ? "on" : ""}`} aria-pressed={queue.arc === v} title={tip} onClick={() => queue.setArc(v as EnergyArc)}>
                  {label}
                </button>
              ))}
            </span>
          </div>
        </div>
      )}
    </>
  );

  // The per-pair transition. Shown only when the pair is ANALYSED: for an unanalysed pair the old
  // badge printed a guess ("Filter 12?") on nearly every radio row, and that guess was not even
  // what would play (the gesture is re-picked at mix start). Unanalysed rows say where they came
  // from instead, so "you added this" is visible next to radio's picks.
  const extraCol = {
    header: "Mix",
    render: (t: TrackMeta & { source?: QueueSource }, i: number) => {
      const prev = i === 0 ? current : upcoming[i - 1];
      const plan = prev ? pickTransition(prev, t) : null;
      if (plan && plan.confident) {
        return (
          <span className={`mixq-badge tier-${planTier(plan)}`} title={`mixability ${Math.round(plan.score * 100)}%`}>
            {transitionLabel(plan)}
          </span>
        );
      }
      const src = t.source;
      return src ? <span className={`mixq-src src-${src}`}>{src === "user" ? "added" : src}</span> : null;
    },
  };

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
          <button
            className={`mixq-auto ${enabled ? "on" : ""}`}
            onClick={onToggleAuto}
            aria-pressed={enabled}
            disabled={!canAuto}
            title={canAuto ? undefined : "Auto-mix runs on the host's rig — it drives both decks and the crossfader, which this seat cannot move."}
          >
            AUTO
          </button>
          <button className="mixq-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
      )}
      <TrackTable
        ref={tableRef}
        tracks={upcoming}
        onLoad={onLoad}
        deckLoaded={deckLoaded}
        deckColors={deckColors}
        // The queue's remove is a room INTENT: its videoId crosses the wire to other devices, so
        // it keeps that id space deliberately. Take the videoId from the track here rather than
        // widening a synced protocol to carry a second kind of id.
        onRemove={canEdit ? (t) => edit.remove(t.videoId) : undefined}
        removeTitle="Remove from queue"
        onReorder={canEdit ? edit.move : undefined}
        extraCol={extraCol}
        topSlot={topSlot}
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
