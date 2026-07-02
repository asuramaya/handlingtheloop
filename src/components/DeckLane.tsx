import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Deck } from "@htl/audio";
import type { Pyramid, Palette } from "@htl/analysis";
import type { LyricsSource, LyricsLine } from "@htl/lyrics";
import type { TrackMeta } from "@htl/library";
import { gridLabel, stepSkip } from "@htl/state";
import { WaveformViewport } from "./WaveformViewport";
import { CaptionBar } from "./CaptionBar";
import { TRACK_DND_MIME } from "./TrackTable";
import { fmtTime } from "../util/format";
import type { StemBadge, StemStatus } from "../App";

export interface DeckMeta {
  name: string;
  artist: string;
  bpm: number | null;
  duration: number;
  pyramid: Pyramid | null;
  videoId?: string | null; // the loaded catalog track's id (null for local files) — drag-to-add source
  thumbnail?: string | null;
  palette?: Palette | null; // colours extracted from the album art → per-track theming (accent + band hues)
}

interface DeckLaneProps {
  id: "A" | "B";
  deck: Deck;
  accent: string;
  focused: boolean;
  onFocus: () => void;
  background: string;
  artBackdrop?: boolean; // opt-in: blurred album art bleeds through the deck chrome, dissolving A↔B with the crossfader
  selectorColor: string;
  loopColor: string;
  markerColor: string;
  stripColor: string;
  freqColors: boolean;
  freqLow: string;
  freqMid: string;
  freqHigh: string;
  vividness: number;
  debrick: boolean;
  glow: boolean;
  markerThickness: number;
  stemColors: Record<string, string>;
  meta: DeckMeta;
  status: StemBadge | null;
  stemStatus: StemStatus | null; // full status for the on-waveform processing overlay
  captions: LyricsLine[];
  captionSource?: LyricsSource | null; // provenance tag on the ribbon (whisper / pool / youtube)
  lyricStatus?: string | null; // lyric processing/failure tell shown on the caption bar
  windowSec: number;
  expanded: boolean; // this lane is maximized to single-deck view
  collapsed: boolean; // the OTHER lane is maximized → this one is hidden
  onToggleExpand: () => void;
  onZoom: (next: number) => void;
  wheelSeeks?: boolean; // mouse wheel over the waveform: false = zoom (default), true = seek/scrub
  refresh: () => void;
  onLoadFile: (file: File) => void;
  // Drag a track row from the library/search onto a lane to load it to that deck.
  onLoadTrack?: (track: TrackMeta) => void;
  // Shared session: stream the scrub as start / move(delta) / end so a co-DJ drives
  // the master's platter physics; onSeek is the one-shot tap (needle drop).
  onJogStart?: () => void;
  onJog?: (deltaSeconds: number) => void;
  onJogEnd?: () => void;
  onSeek?: (position: number) => void;
  // Watch-only: this deck isn't ours to drive (a follower, or a stepped-up DJ's OFF deck).
  // Blocks scrub / needle-drop / bend (control) but NOT zoom or expand — those stay live so a
  // listener can still inspect the waveform.
  locked?: boolean;
  onReprocessLyrics?: (engine: "whisper" | "youtube") => void;
}

// Just the time readout, self-animating via its own rAF. Isolating it here means
// playback updates ONE tiny text node per frame instead of re-rendering the whole
// lane (and its waveform) through React — the waveform animates itself imperatively.
function LaneTime({ deck, duration }: { deck: Deck; duration: number }) {
  const [, bump] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (deck.visualPlaying || deck.jogging) bump((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [deck]);
  return (
    <>
      {fmtTime(deck.visualPosition())} <span className="muted">/ {fmtTime(duration)}</span>
    </>
  );
}

// Song title that auto-scrolls (a ticker) when it's wider than the space available
// — otherwise it sits static (truncated with an ellipsis if it only just overflows).
// Re-measures on container resize and whenever the title/artist change. This is what
// makes a long title readable in the cramped iPhone lane header.
function LaneTitle({ name, artist }: { name: string; artist: string }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [scroll, setScroll] = useState(0); // px the text overflows the box (0 = fits)
  useEffect(() => {
    const measure = () => {
      const box = boxRef.current;
      const inner = innerRef.current;
      if (!box || !inner) return;
      const over = inner.scrollWidth - box.clientWidth;
      setScroll(over > 6 ? over : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (boxRef.current) ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [name, artist]);
  const style = scroll > 0 ? ({ "--scroll": `${scroll}px`, "--ticker-dur": `${Math.max(5, scroll / 45 + 2).toFixed(1)}s` } as CSSProperties) : undefined;
  return (
    <span ref={boxRef} className={`lane-title ${scroll > 0 ? "ticker" : ""}`} title={name}>
      <span ref={innerRef} className="lane-title-inner" style={style}>
        {name || "—"}
        {artist && <span className="lane-artist"> — {artist}</span>}
      </span>
    </span>
  );
}

// A full-width waveform lane. Deck A's lane sits directly above deck B's so the
// beat grids line up vertically — that's what makes aligning the two obvious.
export function DeckLane({ id, deck, accent, focused, onFocus, background, artBackdrop, selectorColor, loopColor, markerColor, stripColor, freqColors, freqLow, freqMid, freqHigh, vividness, debrick, glow, markerThickness, stemColors, meta, status, stemStatus, captions, captionSource, lyricStatus, windowSec, expanded, collapsed, onToggleExpand, onZoom, wheelSeeks, locked, refresh, onLoadFile, onLoadTrack, onJogStart, onJog, onJogEnd, onSeek, onReprocessLyrics }: DeckLaneProps) {
  // The deck is showing the single mix waveform while a NEURAL split is computed or
  // fetched — surface that transition right on the lane so it's obvious stems are
  // coming (vs. just "stuck" on the big waveform). DSP/idle states show nothing.
  const stemBusy =
    stemStatus != null &&
    (stemStatus.phase === "separating" || (stemStatus.phase === "downloading" && !!stemStatus.src));
  // GPU-job tells live in the deck HEADER now (no floating bubbles): stem separation/fetch %
  // takes the slot first (it gates lyrics), then the lyric transcription %. Both are plain
  // header text with a small spinner dot, on the SAME axis as BPM/key/grid.
  const procText = stemBusy && stemStatus
    ? `${stemStatus.phase === "separating" ? "Separating" : "Fetching stems"}${stemStatus.pct != null ? ` ${Math.round(stemStatus.pct)}%` : "…"}`
    : lyricStatus || null;
  const procTitle = stemBusy && stemStatus ? stemStatus.detail : lyricStatus || undefined;
  // Highlight the lane while a library/search track row is dragged over it.
  const [dropActive, setDropActive] = useState(false);

  // Drag the deck header OUT to a library playlist / Collection to file the loaded
  // track — the same TRACK_DND_MIME payload the table rows carry, so the existing
  // LibraryPanel drop targets accept it. Only catalog tracks (with a videoId) can be
  // filed; local-file loads have none.
  const canDrag = !!meta.videoId;
  function onHeaderDragStart(e: React.DragEvent) {
    if (!meta.videoId) {
      e.preventDefault();
      return;
    }
    const track: TrackMeta = {
      videoId: meta.videoId,
      title: meta.name,
      artist: meta.artist,
      duration: meta.duration,
      thumbnail: meta.thumbnail ?? null,
      views: null,
      bpm: meta.bpm ?? undefined,
    };
    e.dataTransfer.setData(TRACK_DND_MIME, JSON.stringify([track]));
    e.dataTransfer.effectAllowed = "copy";
  }

  return (
    <section
      className={`lane ${focused ? "focused" : ""} ${expanded ? "expanded" : ""} ${collapsed ? "collapsed" : ""} ${dropActive ? "drop-target" : ""}`}
      style={{ ["--accent" as string]: accent }}
      onPointerDownCapture={onFocus}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        // A dragged track row (full TrackMeta JSON) → load it to this deck.
        const raw = e.dataTransfer.getData(TRACK_DND_MIME);
        if (raw && onLoadTrack) {
          try {
            const parsed = JSON.parse(raw);
            const first = (Array.isArray(parsed) ? parsed[0] : parsed) as TrackMeta | undefined;
            if (first && first.videoId) {
              onLoadTrack(first);
              return;
            }
          } catch {
            /* fall through to a file drop */
          }
        }
        const f = e.dataTransfer.files[0];
        if (f) onLoadFile(f);
      }}
      onDragOver={(e) => {
        // Accept both track-row drags and audio files; mark the row drag for the cue.
        if (e.dataTransfer.types.includes(TRACK_DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropActive(true);
        } else {
          e.preventDefault();
        }
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the lane (not on inner children).
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false);
      }}
    >
      {/* Opt-in ambient backdrop: the album art, blurred, bleeding through the deck chrome. Opacity
          rides the crossfade CSS var (--art-a / --art-b on .lanes) → dissolves A↔B with the fader. */}
      {artBackdrop && meta.thumbnail && (
        <div className="lane-art" aria-hidden="true" style={{ backgroundImage: `url(${meta.thumbnail})`, opacity: `var(--art-${id === "A" ? "a" : "b"})` }} />
      )}
      <div className="lane-info">
        {/* DECK id + scrolling title — its own full-width row on mobile. Drag the
            header (or the grip) onto a playlist to file the loaded track. */}
        <div
          className={`lane-head ${canDrag ? "draggable" : ""}`}
          draggable={canDrag}
          onDragStart={onHeaderDragStart}
          title={canDrag ? "Drag to a playlist to add this track" : undefined}
        >
          <button
            className={`lane-id ${expanded ? "on" : ""}`}
            onClick={onToggleExpand}
            title={expanded ? "Restore both decks" : "Expand to single-deck view"}
            aria-pressed={expanded}
          >
            DECK {id}
          </button>
          <LaneTitle name={meta.name} artist={meta.artist} />
          {canDrag && (
            <span className="lane-drag" aria-hidden="true" title="Drag to a playlist to add this track">
              ⠿
            </span>
          )}
        </div>
        <span className="lane-time">
          <LaneTime deck={deck} duration={meta.duration} />
        </span>
        <span className="lane-bpm">{deck.effectiveBpm != null ? `${deck.effectiveBpm.toFixed(1)}` : "--"} BPM</span>
        {deck.liveKey && (() => {
          // Live sounding key — tracks the keylock-off pitch glide (Smart Fader / vinyl), with the
          // sub-semitone drift shown in cents so the continuous shift `pitch` hides is visible.
          const semis = deck.livePitchSemis;
          const cents = Math.round((semis - Math.round(semis)) * 100);
          return (
            <span
              className={`lane-key${cents !== 0 ? " gliding" : ""}`}
              title={`Key ${deck.liveKey.name} · pitch ${semis >= 0 ? "+" : ""}${semis.toFixed(2)} st`}
            >
              {deck.liveKey.camelot} {deck.liveKey.name}
              {cents !== 0 && <span className="lane-key-cents"> {cents > 0 ? "+" : ""}{cents}¢</span>}
            </span>
          );
        })()}
        {/* Beat-grid size — also the beat-jump / loop-move resolution. */}
        <span className="lane-grid" title="Beat-grid size (− / +)">
          <button
            className="grid-btn"
            onClick={() => {
              deck.skipBeats = stepSkip(deck.skipBeats, -1);
              refresh();
            }}
            aria-label="Smaller grid"
          >
            −
          </button>
          <span className="grid-val">⊞ {gridLabel(deck.skipBeats)}</span>
          <button
            className="grid-btn"
            onClick={() => {
              deck.skipBeats = stepSkip(deck.skipBeats, 1);
              refresh();
            }}
            aria-label="Larger grid"
          >
            +
          </button>
        </span>
        {/* One processing indicator: while stems are separating/fetching, procText owns
            the slot ("Separating 8%"); the terse stem badge (✦ Cached / ✓ Done / Failed)
            shows only when nothing's in progress, so they never double up. */}
        {status && !procText && <span className={`lane-status tone-${status.tone}`}>{status.text}</span>}
        {procText && (
          <span className="lane-proc" aria-live="polite" title={procTitle}>
            <span className="lane-proc-dot" />
            {procText}
          </span>
        )}
      </div>
      <WaveformViewport
        deck={deck}
        pyramid={meta.pyramid}
        accent={accent}
        background={background}
        selectorColor={selectorColor}
        loopColor={loopColor}
        markerColor={markerColor}
        stripColor={stripColor}
        freqColors={freqColors}
        freqLow={freqLow}
        freqMid={freqMid}
        freqHigh={freqHigh}
        vividness={vividness}
        debrick={debrick}
        markerThickness={markerThickness}
        glow={glow}
        stemColors={stemColors}
        gridSize={deck.skipBeats}
        separating={
          stemStatus && (stemStatus.phase === "separating" || stemStatus.phase === "downloading")
            ? stemStatus.pct ?? 0
            : null
        }
        windowSec={windowSec}
        onZoom={onZoom}
        wheelSeeks={wheelSeeks}
        onScrubStart={() => {
          if (locked || deck.adjusting) return; // watch-only / boundary-adjust: no platter scrub
          deck.scrubBegin();
          onJogStart?.();
        }}
        onScrub={(d) => {
          if (locked) return; // watch-only: the drag does nothing (zoom + expand still work)
          if (deck.adjusting) return void deck.adjustBy(d); // move the loop edge; rAF redraws (deck.adjusting)
          deck.scrubMove(d); // deck.jogging drives the viewport's own rAF — no React churn
          onJog?.(d); // stream the finger delta so the receiver scrubs its own platter
        }}
        onScrubEnd={() => {
          if (locked || deck.adjusting) return;
          deck.scrubEnd();
          onJogEnd?.();
        }}
        onNeedleDrop={(d) => {
          if (locked) return; // watch-only: no needle-drop seek (wheel-zoom still routes via onZoom)
          if (deck.adjusting) return void deck.adjustStep(Math.sign(d)); // scroll/tap steps the edge one notch; rAF redraws
          deck.needleDrop(d);
          refresh(); // a paused tap-seek isn't "jogging" — nudge one redraw
          onSeek?.(deck.position());
        }}
        onBend={(d) => {
          if (locked) return; // watch-only: no pitch-bend
          // Shift+wheel → pitch-bend. deck.bend self-routes (playing = tempo nudge that
          // auto-reverts; paused = frame-search). deck.jogging drives the rAF while a
          // bend rides, so the playhead redraws; paused search still wants one nudge.
          deck.bend(d);
          if (!deck.playing) {
            refresh();
            onSeek?.(deck.position());
          }
        }}
      />
      <CaptionBar deck={deck} accent={accent} cues={captions} source={captionSource} windowSec={windowSec} onSeek={onSeek} onReprocess={onReprocessLyrics} />
    </section>
  );
}
