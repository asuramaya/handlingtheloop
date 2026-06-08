import { useRef, useState } from "react";
import type { Deck } from "../audio/Deck";
import type { Peak } from "../audio/analyze";
import { EQ_MAX_DB, EQ_MIN_DB } from "../audio/Eq3";
import { Knob } from "./Knob";
import { Waveform } from "./Waveform";

export interface DeckMeta {
  name: string;
  bpm: number | null;
  duration: number;
  peaks: Peak[] | null;
}

interface DeckViewProps {
  id: "A" | "B";
  deck: Deck;
  accent: string;
  meta: DeckMeta;
  position: number; // seconds, driven by parent rAF tick
  loading: boolean;
  status: string | null;
  onLoadFile: (file: File) => void;
  onLoadYouTube: (url: string) => void;
}

export function DeckView({
  id,
  deck,
  accent,
  meta,
  position,
  loading,
  status,
  onLoadFile,
  onLoadYouTube,
}: DeckViewProps) {
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const [tempo, setTempo] = useState(0);
  const [url, setUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const progress = meta.duration > 0 ? position / meta.duration : 0;
  const effectiveBpm =
    meta.bpm != null ? meta.bpm * (1 + tempo / 100) : null;

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
        <span className="deck-title">{meta.name || "—"}</span>
        <span className="deck-bpm">
          {effectiveBpm != null ? `${effectiveBpm.toFixed(1)} BPM` : "-- BPM"}
        </span>
      </header>

      <Waveform
        peaks={meta.peaks}
        progress={progress}
        accent={accent}
        onSeek={(f) => {
          deck.seek(f * meta.duration);
          rerender();
        }}
      />

      <div className="deck-time">
        <span>{fmt(position)}</span>
        <span className="muted">/ {fmt(meta.duration)}</span>
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
        </div>

        <div className="eq-stack">
          <Knob
            label="HI"
            value={0}
            min={EQ_MIN_DB}
            max={EQ_MAX_DB}
            defaultValue={0}
            onChange={(v) => deck.setEqHigh(v)}
            format={(v) => `${v.toFixed(0)}`}
          />
          <Knob
            label="MID"
            value={0}
            min={EQ_MIN_DB}
            max={EQ_MAX_DB}
            defaultValue={0}
            onChange={(v) => deck.setEqMid(v)}
            format={(v) => `${v.toFixed(0)}`}
          />
          <Knob
            label="LOW"
            value={0}
            min={EQ_MIN_DB}
            max={EQ_MAX_DB}
            defaultValue={0}
            onChange={(v) => deck.setEqLow(v)}
            format={(v) => `${v.toFixed(0)}`}
          />
        </div>

        <div className="pitch">
          <input
            className="pitch-fader"
            type="range"
            min={-8}
            max={8}
            step={0.1}
            value={tempo}
            onChange={(e) => {
              const t = Number(e.target.value);
              setTempo(t);
              deck.setTempo(t);
            }}
          />
          <span className="pitch-label">
            {tempo > 0 ? "+" : ""}
            {tempo.toFixed(1)}%
          </span>
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
        <input
          className="yt-input"
          placeholder="YouTube URL or id"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) onLoadYouTube(url);
          }}
        />
        <button
          className="btn small"
          disabled={!url.trim() || loading}
          onClick={() => onLoadYouTube(url)}
        >
          {loading ? "…" : "Load"}
        </button>
      </footer>
      {status && <div className="deck-status">{status}</div>}
    </section>
  );
}

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
