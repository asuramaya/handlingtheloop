import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Deck } from "@htl/audio";
import type { Pyramid } from "@htl/analysis";
import type { CaptionCue } from "@htl/media";
import { gridLabel, stepSkip } from "@htl/state";
import { WaveformViewport } from "./WaveformViewport";
import { CaptionBar } from "./CaptionBar";
import { fmtTime } from "../util/format";
import type { StemBadge, StemStatus } from "../App";

export interface DeckMeta {
  name: string;
  artist: string;
  bpm: number | null;
  duration: number;
  pyramid: Pyramid | null;
}

interface DeckLaneProps {
  id: "A" | "B";
  deck: Deck;
  accent: string;
  focused: boolean;
  onFocus: () => void;
  background: string;
  selectorColor: string;
  loopColor: string;
  markerColor: string;
  stripColor: string;
  stemColors: Record<string, string>;
  meta: DeckMeta;
  status: StemBadge | null;
  stemStatus: StemStatus | null; // full status for the on-waveform processing overlay
  captions: CaptionCue[];
  windowSec: number;
  expanded: boolean; // this lane is maximized to single-deck view
  collapsed: boolean; // the OTHER lane is maximized → this one is hidden
  onToggleExpand: () => void;
  onZoom: (next: number) => void;
  refresh: () => void;
  onLoadFile: (file: File) => void;
  // Shared session: stream the scrub as start / move(delta) / end so a co-DJ drives
  // the master's platter physics; onSeek is the one-shot tap (needle drop).
  onJogStart?: () => void;
  onJog?: (deltaSeconds: number) => void;
  onJogEnd?: () => void;
  onSeek?: (position: number) => void;
}

// Just the time readout, self-animating via its own rAF. Isolating it here means
// playback updates ONE tiny text node per frame instead of re-rendering the whole
// lane (and its waveform) through React — the waveform animates itself imperatively.
function LaneTime({ deck, duration }: { deck: Deck; duration: number }) {
  const [, bump] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (deck.playing || deck.jogging) bump((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [deck]);
  return (
    <>
      {fmtTime(deck.position())} <span className="muted">/ {fmtTime(duration)}</span>
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
export function DeckLane({ id, deck, accent, focused, onFocus, background, selectorColor, loopColor, markerColor, stripColor, stemColors, meta, status, stemStatus, captions, windowSec, expanded, collapsed, onToggleExpand, onZoom, refresh, onLoadFile, onJogStart, onJog, onJogEnd, onSeek }: DeckLaneProps) {
  // The deck is showing the single mix waveform while a NEURAL split is computed or
  // fetched — surface that transition right on the lane so it's obvious stems are
  // coming (vs. just "stuck" on the big waveform). DSP/idle states show nothing.
  const stemBusy =
    stemStatus != null &&
    (stemStatus.phase === "separating" || (stemStatus.phase === "downloading" && !!stemStatus.src));
  return (
    <section
      className={`lane ${focused ? "focused" : ""} ${expanded ? "expanded" : ""} ${collapsed ? "collapsed" : ""}`}
      style={{ ["--accent" as string]: accent }}
      onPointerDownCapture={onFocus}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) onLoadFile(f);
      }}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="lane-info">
        {/* DECK id + scrolling title — its own full-width row on mobile. */}
        <div className="lane-head">
          <button
            className={`lane-id ${expanded ? "on" : ""}`}
            onClick={onToggleExpand}
            title={expanded ? "Restore both decks" : "Expand to single-deck view"}
            aria-pressed={expanded}
          >
            DECK {id}
          </button>
          <LaneTitle name={meta.name} artist={meta.artist} />
        </div>
        <span className="lane-time">
          <LaneTime deck={deck} duration={meta.duration} />
        </span>
        <span className="lane-bpm">{deck.effectiveBpm != null ? `${deck.effectiveBpm.toFixed(1)}` : "--"} BPM</span>
        {deck.effectiveKey && (
          <span
            className="lane-key"
            title={`Key ${deck.effectiveKey.name}${deck.pitch ? ` · pitch ${deck.pitch > 0 ? "+" : ""}${deck.pitch}` : ""}`}
          >
            {deck.effectiveKey.camelot} {deck.effectiveKey.name}
          </span>
        )}
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
        {status && <span className={`lane-status tone-${status.tone}`}>{status.text}</span>}
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
        stemColors={stemColors}
        gridSize={deck.skipBeats}
        windowSec={windowSec}
        onZoom={onZoom}
        onScrubStart={() => {
          if (deck.adjusting) return; // boundary-adjust mode: no platter scrub
          deck.scrubBegin();
          onJogStart?.();
        }}
        onScrub={(d) => {
          if (deck.adjusting) return void deck.adjustBy(d); // move the loop edge; rAF redraws (deck.adjusting)
          deck.scrubMove(d); // deck.jogging drives the viewport's own rAF — no React churn
          onJog?.(d); // stream the finger delta so the receiver scrubs its own platter
        }}
        onScrubEnd={() => {
          if (deck.adjusting) return;
          deck.scrubEnd();
          onJogEnd?.();
        }}
        onNeedleDrop={(d) => {
          if (deck.adjusting) return void deck.adjustStep(Math.sign(d)); // scroll/tap steps the edge one notch; rAF redraws
          deck.needleDrop(d);
          refresh(); // a paused tap-seek isn't "jogging" — nudge one redraw
          onSeek?.(deck.position());
        }}
      />
      {stemBusy && stemStatus && (
        <div className={`stem-busy ${stemStatus.phase === "separating" ? "process" : "fetch"}`} aria-live="polite">
          <span className="stem-busy-spin" />
          <span className="stem-busy-text">{stemStatus.detail}</span>
          {stemStatus.pct != null && (
            <span className="stem-busy-bar">
              <span style={{ width: `${stemStatus.pct}%` }} />
            </span>
          )}
        </div>
      )}
      <CaptionBar deck={deck} accent={accent} cues={captions} />
    </section>
  );
}
