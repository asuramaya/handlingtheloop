import { useCallback, useEffect, useRef, useState } from "react";
import { AudioEngine } from "./audio/AudioEngine";
import { analyzeTrack } from "./audio/analyze";
import { decodeAudio } from "./audio/decode";
import { getCachedTrack, setCachedTrack } from "./audio/trackCache";
import { DeckLane, type DeckMeta } from "./components/DeckLane";
import { DeckControls } from "./components/DeckControls";
import { ChannelStrip } from "./components/ChannelStrip";
import { LibraryPanel } from "./components/LibraryPanel";
import { useLibrary } from "./library/useLibrary";
import type { TrackMeta } from "./library/types";
import { fetchYouTubeAudio, fileToArrayBuffer } from "./youtube";

type DeckId = "A" | "B";

const EMPTY_META: DeckMeta = { name: "", artist: "", bpm: null, duration: 0, pyramid: null };
const ACCENT: Record<DeckId, string> = { A: "#36c2ff", B: "#ff5d73" };

export function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new AudioEngine();
  const engine = engineRef.current;

  const library = useLibrary();

  const [meta, setMeta] = useState<Record<DeckId, DeckMeta>>({ A: EMPTY_META, B: EMPTY_META });
  const [loading, setLoading] = useState<Record<DeckId, boolean>>({ A: false, B: false });
  const [status, setStatus] = useState<Record<DeckId, string | null>>({ A: null, B: null });
  const [crossfade, setCrossfade] = useState(0);
  const [loaded, setLoaded] = useState<Record<DeckId, string | null>>({ A: null, B: null });
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const loadedIds = new Set([loaded.A, loaded.B].filter((v): v is string => v !== null));

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (engine.deckA.playing || engine.deckB.playing) setTick((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  const setStatusFor = useCallback((id: DeckId, msg: string | null) => {
    setStatus((s) => ({ ...s, [id]: msg }));
  }, []);

  // Core load path: cache hit → instant; miss → fetch + decode + analyze + cache.
  const loadTrackToDeck = useCallback(
    async (id: DeckId, track: TrackMeta) => {
      engine.resume();
      setStatusFor(id, null);
      setLoading((l) => ({ ...l, [id]: true }));
      try {
        let cached = getCachedTrack(track.videoId);
        if (!cached) {
          const data = await fetchYouTubeAudio(track.videoId, (p) => {
            const pct =
              p.totalBytes != null
                ? `${Math.round((p.receivedBytes / p.totalBytes) * 100)}%`
                : `${Math.round(p.receivedBytes / 1024)}kb`;
            setStatusFor(id, `Downloading… ${pct}`);
          });
          setStatusFor(id, "Decoding…");
          const buffer = await decodeAudio(engine.ctx, data);
          cached = { buffer, analysis: analyzeTrack(buffer) };
          setCachedTrack(track.videoId, cached);
        }
        engine.deck(id).setBuffer(cached.buffer, cached.analysis.beatgrid);
        setLoaded((l) => ({ ...l, [id]: track.videoId }));
        setMeta((m) => ({
          ...m,
          [id]: {
            name: track.title,
            artist: track.artist,
            bpm: cached!.analysis.bpm ?? track.bpm ?? null,
            duration: cached!.buffer.duration,
            pyramid: cached!.analysis.pyramid,
          },
        }));
        setStatusFor(id, null);
        if (cached.analysis.bpm) library.setBpm(track.videoId, cached.analysis.bpm);
      } catch (e) {
        setStatusFor(id, (e as Error).message ?? String(e));
      } finally {
        setLoading((l) => ({ ...l, [id]: false }));
      }
    },
    [engine, library, setStatusFor],
  );

  const onLoadFile = useCallback(
    async (id: DeckId, file: File) => {
      engine.resume();
      setStatusFor(id, null);
      setLoading((l) => ({ ...l, [id]: true }));
      try {
        const data = await fileToArrayBuffer(file);
        const buffer = await decodeAudio(engine.ctx, data);
        const analysis = analyzeTrack(buffer);
        engine.deck(id).setBuffer(buffer, analysis.beatgrid);
        setMeta((m) => ({
          ...m,
          [id]: {
            name: file.name,
            artist: "",
            bpm: analysis.bpm,
            duration: buffer.duration,
            pyramid: analysis.pyramid,
          },
        }));
      } catch (e) {
        setStatusFor(id, `Load failed: ${(e as Error).message}`);
      } finally {
        setLoading((l) => ({ ...l, [id]: false }));
      }
    },
    [engine, setStatusFor],
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="logo">htl</h1>
        <span className="tagline">handling the loop · serverless youtube dj</span>
      </header>

      <main className="stage">
        <div className="lanes">
          {(["A", "B"] as DeckId[]).map((id) => (
            <DeckLane
              key={id}
              id={id}
              deck={engine.deck(id)}
              accent={ACCENT[id]}
              meta={meta[id]}
              position={engine.deck(id).position()}
              status={status[id]}
              refresh={refresh}
              onLoadFile={(f) => onLoadFile(id, f)}
            />
          ))}
        </div>

        <div className="board">
          <DeckControls
            id="A"
            deck={engine.deckA}
            accent={ACCENT.A}
            loading={loading.A}
            mirror={false}
            onSync={() => { engine.sync("A"); refresh(); }}
            onLoadFile={(f) => onLoadFile("A", f)}
            refresh={refresh}
          />

          <div className="mixer-center">
            <div className="channels">
              <ChannelStrip id="A" deck={engine.deckA} accent={ACCENT.A} refresh={refresh} />
              <ChannelStrip id="B" deck={engine.deckB} accent={ACCENT.B} refresh={refresh} />
            </div>
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
          </div>

          <DeckControls
            id="B"
            deck={engine.deckB}
            accent={ACCENT.B}
            loading={loading.B}
            mirror={true}
            onSync={() => { engine.sync("B"); refresh(); }}
            onLoadFile={(f) => onLoadFile("B", f)}
            refresh={refresh}
          />
        </div>
      </main>

      <LibraryPanel library={library} onLoad={loadTrackToDeck} loadedIds={loadedIds} />
    </div>
  );
}
