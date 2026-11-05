import { displayTrack } from "../util/format";
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
  previewPlan,
  transitionLabel,
  planTier,
} from "@htl";
import { TRACK_DND_MIME, TrackTable, type TrackTableHandle } from "./TrackTable";
import type { Ref } from "react";
import { autoLine, fmtClock } from "./automixStatus";

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


// The energy shapes, each drawn as the curve it means (flat, rising, up-and-down) — a picture says
// "Build" faster than the word does — and spelled out in a sentence under the buttons.
const ARCS: { v: EnergyArc; label: string; path: string; says: string }[] = [
  { v: "ride", label: "Steady", path: "M1 6 H21", says: "Keeps the energy about where it is now." },
  { v: "build", label: "Rising", path: "M1 10 C8 10 14 6 21 2", says: "Each track a little more energetic than the last." },
  { v: "journey", label: "Peak", path: "M1 10 C6 10 8 2 11 2 C14 2 16 10 21 10", says: "Rises to a peak, then winds back down." },
];

// One side of the stage: a deck-coloured card (the colour of the deck the track is on, when it is on
// one), cover art with the deck letter on it, the title, and the numbers a DJ reads at a glance.
function TrackCard({ t, side, deck, empty }: { t: TrackMeta | null; side: "now" | "next"; deck: "A" | "B" | null; empty: string }) {
  if (!t) {
    return (
      <div className={`mixq-card ${side} is-empty`}>
        <span className="mixq-card-kicker">{side === "now" ? "Now" : "Next"}</span>
        <span className="mixq-card-empty">{empty}</span>
      </div>
    );
  }
  const d = displayTrack(t.title, t.artist);
  return (
    <div className={`mixq-card ${side}${deck ? ` on-deck deck-${deck}` : ""}`}>
      <div className="mixq-card-art">
        {t.thumbnail ? <img src={t.thumbnail} alt="" loading="lazy" /> : <span className="mixq-card-noart" aria-hidden="true">♪</span>}
        {deck && <span className="mixq-card-deck" title={`On deck ${deck}`}>{deck}</span>}
      </div>
      <div className="mixq-card-text">
        <span className="mixq-card-kicker">{side === "now" ? "Now" : "Next"}</span>
        <span className="mixq-card-title" title={t.title}>
          {d.title || t.videoId}
        </span>
        <span className="mixq-card-meta">
          <span className="mixq-card-artist">{d.artist}</span>
          {t.bpm ? <span className="mixq-card-num">{Math.round(t.bpm)}<small>BPM</small></span> : null}
          {t.key ? <span className="mixq-card-num key">{t.key}</span> : null}
        </span>
      </div>
    </div>
  );
}

// What the middle of the stage says above the clock, in two or three words.
function kickerFor(tone: string, waitHeadline: string): string {
  switch (tone) {
    case "mix":
      return "Mixing";
    case "hold":
      return "Holding";
    case "manual":
      return "Your fader";
    case "wait":
      return waitHeadline;
    default:
      return "Mix in";
  }
}

export function MixQueuePanel({ queue, status, library, mirror, edit, canEdit, canAuto, onLoad, deckLoaded, deckColors, onToggleAuto, onMixNow, onSkip, onHold, onClose, embedded, tableRef }: Props) {
  // `mirror` only chooses the DISPLAY source (a session renders the host's queue). Editing
  // is gated separately by `canEdit`: a controlling remote mutates the host's queue via
  // intents (routed through `edit`), so it can add/remove/move while still mirroring. Seed
  // + mode stay host-only (the radio engine), shown only when we own the queue (`!mirror`).
  const ownsSeed = !mirror; // seed/mode dropdown only where the local queue is the source
  const [dropping, setDropping] = useState(false);
  // The playlist the queue was loaded from (by this panel), so the picker can NAME it; and whether
  // the user pressed "Playlist" but has not picked one yet (nothing changes until they do).
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
  const [pickingPlaylist, setPickingPlaylist] = useState(false);
  const seededName = seededFrom ? library.playlists.find((p) => p.id === seededFrom)?.name ?? null : null;

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

  // ★ THE QUEUE HEADER, AS SMALL AS IT CAN BE (operator, 2026-11-04: "all this auto off and big turn
  // auto on button is redundant, remove it. also remove text ... reorganize it so its more tracks
  // less slop and bloat"). The list is the instrument; the header is three thin lines at most:
  //   1. NOW → NEXT, one line each side.
  //   2. Only while AUTO runs: what it is doing (the explanation is the tooltip) and Mix now /
  //      Skip / Hold as small buttons on the same line, with the mix progress under it. AUTO off
  //      shows nothing here — the AUTO button in the top bar is the way in.
  //   3. Tracks (Suggestions | Playlist) and Energy on ONE row; what each means is its tooltip.
  const next = upcoming[0] ?? null;
  const line = autoLine(st, next ? displayTrack(next.title, next.artist).title || next.videoId : null);
  const progress = st.phase === "mixing" && st.mixProgress != null ? st.mixProgress : null;
  const playlistHint =
    mode === "playlist"
      ? `Plays ${seededName ? `“${seededName}”` : "the playlist"} in order${queue.augment ? ", then keeps going with suggestions" : ""}.`
      : "Pick a playlist; it replaces the suggested tracks (tracks you added stay).";
  // ★ THE STAGE (operator, 2026-11-04: "this auto mix ui/ux needs a ton of work, does not look
  // good ... redesign this make it look cool"). NOW and NEXT are cards in the colours of their decks,
  // and the gap between them is the transition itself: its name, a big clock, and a small crossfader
  // whose knob sits on NOW until the mix starts and then slides across to NEXT as the blend runs. The
  // controls live in the middle, under the clock, because that is what they act on.
  const nowDeck: "A" | "B" | null = current ? (deckLoaded?.A === current.videoId ? "A" : deckLoaded?.B === current.videoId ? "B" : null) : null;
  const nextDeck: "A" | "B" | null = next ? (deckLoaded?.A === next.videoId ? "A" : deckLoaded?.B === next.videoId ? "B" : null) : null;
  // Colour each side by its deck; a track not on a deck yet takes the deck it is heading for.
  const nowCol = nowDeck ?? st.liveDeck ?? "A";
  const nextCol = nextDeck ?? (nowCol === "A" ? "B" : "A");
  const pv = current && next ? previewPlan(current, next) : null;
  const planName = enabled && st.planLabel ? st.planLabel : pv?.plan.confident ? transitionLabel(pv.plan) : null;
  const bars = enabled && st.plan ? st.plan.bars : pv?.plan.confident ? pv.plan.bars : null;
  const tone = enabled ? line.tone : "idle";
  const clock = enabled && st.countdownSec != null && !st.held && tone !== "wait" && tone !== "manual" ? fmtClock(st.countdownSec) : null;
  // The approach: how far the live track has come toward its mix point (0 → 1), then the blend.
  const approach =
    progress != null ? 1 : st.mixOutTime != null && st.countdownSec != null && st.mixOutTime > 0 ? Math.max(0, Math.min(1, 1 - st.countdownSec / st.mixOutTime)) : 0;
  const stageStyle = {
    ["--now-col" as string]: deckColors?.[nowCol] ?? "var(--neon-cyan)",
    ["--next-col" as string]: deckColors?.[nextCol] ?? "var(--neon-pink)",
    ["--p" as string]: String(progress ?? 0),
    ["--approach" as string]: String(approach),
  };
  const topSlot = (
    <div className={`mixq-top tone-${tone}${enabled ? " is-auto" : ""}${progress != null ? " is-mixing" : ""}`} style={stageStyle} aria-live="polite">
      <div className="mixq-stage">
        <TrackCard t={current} side="now" deck={nowDeck} empty={mirror ? "Host isn’t playing yet" : "Nothing playing"} />
        <div className="mixq-bridge" data-soon={clock && (st.countdownSec ?? 99) <= 8 ? "" : undefined} title={enabled ? [line.headline, line.detail].filter(Boolean).join(" — ") : undefined}>
          <div className="mixq-bridge-head">
            {enabled ? <span className="mixq-kicker">{kickerFor(tone, line.headline)}</span> : null}
            {planName && (
              <span className="mixq-style" title={pv?.why}>
                {planName}
                {bars ? <small>{bars} bars</small> : null}
              </span>
            )}
          </div>
          {clock && <span className="mixq-clock">{clock}</span>}
          <div className="mixq-fader" aria-hidden="true">
            <span className="mixq-fader-approach" />
            <span className="mixq-fader-blend" />
            <span className="mixq-fader-knob" />
          </div>
          {enabled && (
            <div className="mixq-ctl">
              <button onClick={onMixNow} disabled={!next} title="Start the mix into the next track now, from here">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3l6 5-6 5zM8 3l6 5-6 5z" /></svg>
                Mix now
              </button>
              <button onClick={onSkip} disabled={!next} title="Drop the next track from the queue; the one after it moves up">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l7 5-7 5zM11 3h2v10h-2z" /></svg>
                Skip
              </button>
              <button
                className={st.held ? "on" : ""}
                onClick={onHold}
                aria-pressed={!!st.held}
                title={st.held ? "Stop holding: AUTO mixes at the usual point again" : "Stay on this track: no mix until you press Hold again or Mix now"}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zM9 3h3v10H9z" /></svg>
                {st.held ? "Holding" : "Hold"}
              </button>
            </div>
          )}
        </div>
        <TrackCard t={next} side="next" deck={nextDeck} empty="Queue empty" />
      </div>
      {ownsSeed && (
        <div className="mixq-seedrow">
          <span className="seg-group mixq-src-seg" role="group" aria-label="Where the next tracks come from">
            <button
              className={`hw-btn small ${mode !== "playlist" && !pickingPlaylist ? "on" : ""}`}
              aria-pressed={mode !== "playlist"}
              title="Tracks that fit what is playing, picked again as each one starts"
              onClick={() => {
                if (mode === "playlist") queue.loadTracks([], { mode: "radio" });
                setPickingPlaylist(false);
              }}
            >
              Suggestions
            </button>
            <button
              className={`hw-btn small ${mode === "playlist" || pickingPlaylist ? "on" : ""}`}
              aria-pressed={mode === "playlist"}
              disabled={!library.playlists.length}
              title={library.playlists.length ? playlistHint : "Make a playlist in the Library first"}
              onClick={() => setPickingPlaylist(true)}
            >
              Playlist
            </button>
          </span>
          {(mode === "playlist" || pickingPlaylist) && library.playlists.length > 0 && (
            <select
              className="mixq-src-pick"
              value={mode === "playlist" && seededFrom ? seededFrom : ""}
              title={playlistHint}
              onChange={(e) => {
                if (!e.target.value) return;
                seedPlaylist(e.target.value);
                setSeededFrom(e.target.value);
                setPickingPlaylist(false);
              }}
              aria-label="Which playlist"
            >
              <option value="" disabled>
                {mode === "playlist" ? "Loaded playlist" : "Choose a playlist…"}
              </option>
              {library.playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.trackKeys.length}
                </option>
              ))}
            </select>
          )}
          {mode !== "playlist" && !pickingPlaylist && (
            <span className="seg-group mixq-arc" role="group" aria-label="How the energy moves across the set">
              {ARCS.map((a) => (
                <button key={a.v} className={`hw-btn small ${queue.arc === a.v ? "on" : ""}`} aria-pressed={queue.arc === a.v} title={a.says} onClick={() => queue.setArc(a.v)}>
                  <svg className="mixq-arc-ico" viewBox="0 0 22 12" aria-hidden="true">
                    <path d={a.path} />
                  </svg>
                  {a.label}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );

  // The per-pair transition. Shown only when the pair is ANALYSED: for an unanalysed pair the old
  // badge printed a guess ("Filter 12?") on nearly every radio row, and that guess was not even
  // what would play (the gesture is re-picked at mix start). Unanalysed rows say where they came
  // from instead, so "you added this" is visible next to radio's picks.
  const extraCol = {
    header: "Mix",
    render: (t: TrackMeta & { source?: QueueSource }, i: number) => {
      const prev = i === 0 ? current : upcoming[i - 1];
      // previewPlan, not pickTransition: the badge promised "Cut" for 99 → 160 BPM, which the
      // mixer would bridge or echo out — the queue said one thing and the decks did another.
      const pv = prev ? previewPlan(prev, t) : null;
      if (pv && pv.plan.confident) {
        return (
          <span
            className={`mixq-badge tier-${pv.plan.style === "tempoBridge" || pv.plan.style === "doubleDrop" ? "move" : planTier(pv.plan)}`}
            title={pv.why}
          >
            {transitionLabel(pv.plan)}
          </span>
        );
      }
      const src = t.source;
      return src ? <span className={`mixq-src src-${src}`}>{src === "user" ? "added" : src === "radio" ? "suggested" : src}</span> : null;
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
