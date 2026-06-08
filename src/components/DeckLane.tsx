import type { Deck } from "../audio/Deck";
import type { Pyramid } from "../audio/analyze";
import { WaveformViewport } from "./WaveformViewport";
import { fmtTime } from "../util/format";

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
  meta: DeckMeta;
  position: number;
  status: string | null;
  refresh: () => void;
  onLoadFile: (file: File) => void;
}

// A full-width waveform lane. Deck A's lane sits directly above deck B's so the
// beat grids line up vertically — that's what makes aligning the two obvious.
export function DeckLane({ id, deck, accent, meta, position, status, refresh, onLoadFile }: DeckLaneProps) {
  return (
    <section
      className="lane"
      style={{ ["--accent" as string]: accent }}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) onLoadFile(f);
      }}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="lane-info">
        <span className="lane-id">DECK {id}</span>
        <span className="lane-title" title={meta.name}>
          {meta.name || "—"}
          {meta.artist && <span className="lane-artist"> — {meta.artist}</span>}
        </span>
        <span className="lane-time">
          {fmtTime(position)} <span className="muted">/ {fmtTime(meta.duration)}</span>
        </span>
        <span className="lane-bpm">{deck.effectiveBpm != null ? `${deck.effectiveBpm.toFixed(1)}` : "--"} BPM</span>
        {status && <span className="lane-status">{status}</span>}
      </div>
      <WaveformViewport
        pyramid={meta.pyramid}
        buffer={deck.buffer}
        position={position}
        duration={meta.duration}
        beatgrid={deck.beatgrid}
        loop={deck.loop ? { start: deck.loop.start, end: deck.loop.end } : null}
        cuePoint={deck.cuePoint}
        hotCues={deck.hotCues}
        loopInPoint={deck.loopInPoint}
        accent={accent}
        onScrub={(d) => {
          deck.seek(deck.position() + d);
          refresh();
        }}
      />
    </section>
  );
}
