import { useRef, useState } from "react";
import type { Deck } from "../audio/Deck";
import { HOT_CUE_COUNT } from "../audio/Deck";
import type { Pyramid } from "../audio/analyze";
import { EQ_MAX_DB, EQ_MIN_DB } from "../audio/Eq3";
import { Knob } from "./Knob";
import { WaveformViewport } from "./WaveformViewport";
import { fmtTime } from "../util/format";

export interface DeckMeta {
  name: string;
  artist: string;
  bpm: number | null;
  duration: number;
  pyramid: Pyramid | null;
}

interface DeckViewProps {
  id: "A" | "B";
  deck: Deck;
  accent: string;
  meta: DeckMeta;
  position: number;
  loading: boolean;
  status: string | null;
  onLoadFile: (file: File) => void;
  onSync: () => void;
}

const LOOP_SIZES = [1, 2, 4, 8];

export function DeckView({ id, deck, accent, meta, position, loading, status, onLoadFile, onSync }: DeckViewProps) {
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const fileInput = useRef<HTMLInputElement>(null);

  const loopRegion = deck.loop ? { start: deck.loop.start, end: deck.loop.end } : null;

  return (
    <section
      className="deck"
      style={{ ["--accent" as string]: accent }}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) onLoadFile(f);
      }}
      onDragOver={(e) => e.preventDefault()}
    >
      <header className="deck-header">
        <span className="deck-id">DECK {id}</span>
        <span className="deck-title" title={meta.name}>
          {meta.name || "—"}
          {meta.artist && <span className="deck-artist"> — {meta.artist}</span>}
        </span>
        <span className="deck-bpm">
          {deck.effectiveBpm != null ? `${deck.effectiveBpm.toFixed(1)} BPM` : "-- BPM"}
        </span>
      </header>

      <WaveformViewport
        pyramid={meta.pyramid}
        buffer={deck.buffer}
        position={position}
        duration={meta.duration}
        beatgrid={deck.beatgrid}
        loop={loopRegion}
        accent={accent}
        onScrub={(d) => {
          deck.seek(deck.position() + d);
          rerender();
        }}
      />

      <div className="deck-time">
        <span>{fmtTime(position)}</span>
        <span className="muted">/ {fmtTime(meta.duration)}</span>
      </div>

      <div className="deck-body">
        <div className="transport">
          <button
            className="btn cue"
            onPointerDown={() => {
              if (!deck.playing) deck.setCue();
              else deck.jumpToCue();
              rerender();
            }}
          >
            CUE
          </button>
          <button
            className="btn play"
            onClick={() => {
              deck.togglePlay();
              rerender();
            }}
          >
            {deck.playing ? "❚❚" : "▶"}
          </button>
          <button className="btn sync" onClick={() => { onSync(); rerender(); }}>
            SYNC
          </button>
          <button
            className={`btn keylock ${deck.keylock ? "on" : ""}`}
            title="Key lock (master tempo)"
            onClick={() => { deck.setKeylock(!deck.keylock); rerender(); }}
          >
            KEY
          </button>
        </div>

        <div className="eq-stack">
          <Knob label="HI" value={0} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={0} onChange={(v) => deck.setEqHigh(v)} />
          <Knob label="MID" value={0} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={0} onChange={(v) => deck.setEqMid(v)} />
          <Knob label="LOW" value={0} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={0} onChange={(v) => deck.setEqLow(v)} />
        </div>

        <div className="pitch">
          <input
            className="pitch-fader"
            type="range"
            min={-8}
            max={8}
            step={0.05}
            value={deck.tempo}
            onChange={(e) => {
              deck.setTempo(Number(e.target.value));
              rerender();
            }}
          />
          <span className="pitch-label">
            {deck.tempo > 0 ? "+" : ""}
            {deck.tempo.toFixed(1)}%
          </span>
        </div>
      </div>

      <div className="jog">
        <button className="jog-btn" title="Jump back a bar" onClick={() => { deck.beatJump(-4); rerender(); }}>
          ◀◀
        </button>
        <button className="jog-btn" title="Jump back a beat" onClick={() => { deck.beatJump(-1); rerender(); }}>
          ◀
        </button>
        <button
          className={`jog-btn mag ${deck.quantizing ? "on" : ""}`}
          title="Quantize — snap cues/loops/jumps to the grid"
          onClick={() => { deck.setQuantize(!deck.quantizing); rerender(); }}
        >
          ⌗ SNAP
        </button>
        <button className="jog-btn" title="Jump forward a beat" onClick={() => { deck.beatJump(1); rerender(); }}>
          ▶
        </button>
        <button className="jog-btn" title="Jump forward a bar" onClick={() => { deck.beatJump(4); rerender(); }}>
          ▶▶
        </button>
      </div>

      <div className="pads">
        <div className="hotcues">
          {Array.from({ length: HOT_CUE_COUNT }, (_, i) => {
            const set = deck.hotCues[i] != null;
            return (
              <button
                key={i}
                className={`pad ${set ? "set" : ""}`}
                onClick={(e) => {
                  if (e.shiftKey && set) deck.clearHotCue(i);
                  else deck.hotCue(i);
                  rerender();
                }}
              >
                {i + 1}
                {set && (
                  <span
                    className="pad-clear"
                    onClick={(e) => {
                      e.stopPropagation();
                      deck.clearHotCue(i);
                      rerender();
                    }}
                  >
                    ✕
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="loops">
          <button className={`loop-btn ${deck.loopInPoint != null ? "armed" : ""}`} onClick={() => { deck.loopIn(); rerender(); }}>
            IN
          </button>
          <button className="loop-btn" onClick={() => { deck.loopOut(); rerender(); }}>
            OUT
          </button>
          <button
            className={`loop-btn ${deck.loop?.active ? "on" : ""}`}
            disabled={!deck.loop}
            onClick={() => { deck.loop?.active ? deck.exitLoop() : deck.reloop(); rerender(); }}
          >
            {deck.loop && !deck.loop.active ? "RELOOP" : "EXIT"}
          </button>
          <span className="loop-sep" />
          {LOOP_SIZES.map((n) => (
            <button
              key={n}
              className={`loop-btn ${deck.loop?.active && deck.loop.beats === n ? "on" : ""}`}
              onClick={() => { deck.setBeatLoop(n); rerender(); }}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <footer className="deck-load">
        <input
          ref={fileInput}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onLoadFile(f);
          }}
        />
        <button className="btn small" onClick={() => fileInput.current?.click()}>
          Load file
        </button>
        <span className="deck-hint">{loading ? "loading…" : "drag a file, or load from the library below"}</span>
      </footer>
      {status && <div className="deck-status">{status}</div>}
    </section>
  );
}
