import { useCallback, useEffect, useRef, useState } from "react";
import { AudioEngine } from "./audio/AudioEngine";
import { analyzeTrack } from "./audio/analyze";
import { DeckView, type DeckMeta } from "./components/DeckView";
import {
  fetchYouTubeAudio,
  fileToArrayBuffer,
  parseYouTubeId,
} from "./youtube/source";

type DeckId = "A" | "B";

const EMPTY_META: DeckMeta = {
  name: "",
  bpm: null,
  duration: 0,
  peaks: null,
};

const ACCENT: Record<DeckId, string> = {
  A: "#36c2ff",
  B: "#ff5d73",
};

export function App() {
  // The engine is imperative and lives for the whole session.
  const engineRef = useRef<AudioEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new AudioEngine();
  const engine = engineRef.current;

  const [meta, setMeta] = useState<Record<DeckId, DeckMeta>>({
    A: EMPTY_META,
    B: EMPTY_META,
  });
  const [loading, setLoading] = useState<Record<DeckId, boolean>>({
    A: false,
    B: false,
  });
  const [status, setStatus] = useState<Record<DeckId, string | null>>({
    A: null,
    B: null,
  });
  const [crossfade, setCrossfade] = useState(0);
  const [, setTick] = useState(0);

  // Drive playhead repaint while either deck is playing.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (engine.deckA.playing || engine.deckB.playing) setTick((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  const loadBuffer = useCallback(
    async (id: DeckId, data: ArrayBuffer, name: string) => {
      const deck = engine.deck(id);
      await deck.loadArrayBuffer(data);
      const analysis = deck.buffer
        ? analyzeTrack(deck.buffer)
        : { peaks: null, bpm: null };
      setMeta((m) => ({
        ...m,
        [id]: {
          name,
          bpm: analysis.bpm,
          duration: deck.duration,
          peaks: analysis.peaks,
        },
      }));
    },
    [engine],
  );

  const onLoadFile = useCallback(
    async (id: DeckId, file: File) => {
      engine.resume();
      setStatus((s) => ({ ...s, [id]: null }));
      setLoading((l) => ({ ...l, [id]: true }));
      try {
        const data = await fileToArrayBuffer(file);
        await loadBuffer(id, data, file.name);
      } catch (e) {
        setStatus((s) => ({ ...s, [id]: `Load failed: ${String(e)}` }));
      } finally {
        setLoading((l) => ({ ...l, [id]: false }));
      }
    },
    [engine, loadBuffer],
  );

  const onLoadYouTube = useCallback(
    async (id: DeckId, input: string) => {
      engine.resume();
      const videoId = parseYouTubeId(input);
      if (!videoId) {
        setStatus((s) => ({ ...s, [id]: "Unrecognized YouTube URL or id" }));
        return;
      }
      setStatus((s) => ({ ...s, [id]: "Fetching audio…" }));
      setLoading((l) => ({ ...l, [id]: true }));
      try {
        const data = await fetchYouTubeAudio(videoId, (p) => {
          const pct =
            p.totalBytes != null
              ? ` ${Math.round((p.receivedBytes / p.totalBytes) * 100)}%`
              : ` ${Math.round(p.receivedBytes / 1024)}kb`;
          setStatus((s) => ({ ...s, [id]: `Downloading…${pct}` }));
        });
        setStatus((s) => ({ ...s, [id]: "Decoding…" }));
        await loadBuffer(id, data, videoId);
        setStatus((s) => ({ ...s, [id]: null }));
      } catch (e) {
        setStatus((s) => ({ ...s, [id]: String(e) }));
      } finally {
        setLoading((l) => ({ ...l, [id]: false }));
      }
    },
    [engine, loadBuffer],
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="logo">xxit</h1>
        <span className="tagline">youtube · rekordbox-style · serverless</span>
      </header>

      <main className="decks">
        <DeckView
          id="A"
          deck={engine.deckA}
          accent={ACCENT.A}
          meta={meta.A}
          position={engine.deckA.position()}
          loading={loading.A}
          status={status.A}
          onLoadFile={(f) => onLoadFile("A", f)}
          onLoadYouTube={(u) => onLoadYouTube("A", u)}
        />
        <DeckView
          id="B"
          deck={engine.deckB}
          accent={ACCENT.B}
          meta={meta.B}
          position={engine.deckB.position()}
          loading={loading.B}
          status={status.B}
          onLoadFile={(f) => onLoadFile("B", f)}
          onLoadYouTube={(u) => onLoadYouTube("B", u)}
        />
      </main>

      <footer className="mixer">
        <div className="crossfader">
          <span className="xf-end">A</span>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.01}
            value={crossfade}
            onChange={(e) => {
              const v = Number(e.target.value);
              setCrossfade(v);
              engine.setCrossfade(v);
            }}
          />
          <span className="xf-end">B</span>
        </div>
      </footer>
    </div>
  );
}
