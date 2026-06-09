import { useCallback, useEffect, useRef, useState } from "react";
import { DeckLane, type DeckMeta } from "./components/DeckLane";
import { DeckControls } from "./components/DeckControls";
import { ChannelStrip } from "./components/ChannelStrip";
import { LibraryPanel } from "./components/LibraryPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  AudioEngine,
  type Deck,
  analyzeTrack,
  decodeAudio,
  getCachedTrack,
  setCachedTrack,
  useLibrary,
  type TrackMeta,
  fetchYouTubeAudio,
  fileToArrayBuffer,
  applySettings,
  loadSettings,
  saveSettings,
  TEMPO_RANGES,
  JUMP_RESOLUTIONS,
  jumpLabel,
  type Settings,
  type DeckSnapshot,
  type SessionSnapshot,
  loadSession,
  saveSession,
  getAudio,
  putAudio,
} from "@htl";

type DeckId = "A" | "B";

const EMPTY_META: DeckMeta = { name: "", artist: "", bpm: null, duration: 0, pyramid: null };

// --- session snapshot <-> deck ---
function deckSnapshot(deck: Deck, meta: DeckMeta, videoId: string | null): DeckSnapshot {
  return {
    videoId,
    name: meta.name,
    artist: meta.artist,
    bpm: meta.bpm,
    duration: meta.duration,
    tempo: deck.tempo,
    trim: deck.trim,
    level: deck.level,
    eqLow: deck.eqLow,
    eqMid: deck.eqMid,
    eqHigh: deck.eqHigh,
    filter: deck.filterValue,
    keylock: deck.keylock,
    quantize: deck.quantizing,
    cuePoint: deck.cuePoint,
    hotCues: [...deck.hotCues],
    hotLoops: deck.hotLoops.map((l) => (l ? { ...l } : null)),
    loop: deck.loop ? { ...deck.loop } : null,
    loopInPoint: deck.loopInPoint,
    position: deck.position(),
    playing: deck.playing,
  };
}

// Re-apply saved controls after the buffer is set (setBuffer resets them).
function applyDeckControls(deck: Deck, s: DeckSnapshot) {
  deck.setTempo(s.tempo);
  deck.setTrim(s.trim);
  deck.setLevel(s.level);
  deck.setEqLow(s.eqLow);
  deck.setEqMid(s.eqMid);
  deck.setEqHigh(s.eqHigh);
  deck.setFilter(s.filter ?? 0);
  deck.setKeylock(s.keylock);
  deck.setQuantize(s.quantize);
  deck.cuePoint = s.cuePoint;
  deck.hotCues = [...s.hotCues];
  deck.hotLoops = (s.hotLoops ?? []).map((l) => (l ? { ...l } : null));
  if (deck.hotLoops.length < deck.hotCues.length) {
    deck.hotLoops = [...deck.hotLoops, ...new Array(deck.hotCues.length - deck.hotLoops.length).fill(null)];
  }
  deck.loop = s.loop ? { ...s.loop } : null;
  deck.loopInPoint = s.loopInPoint;
  deck.seek(s.position);
  // Resume playback if it was playing — actual sound waits for the first gesture
  // (autoplay policy), but the deck comes back in the playing state + position.
  if (s.playing) deck.play();
}

export function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new AudioEngine();
  const engine = engineRef.current;

  const library = useLibrary();

  const [meta, setMeta] = useState<Record<DeckId, DeckMeta>>({ A: EMPTY_META, B: EMPTY_META });
  const [, setLoading] = useState<Record<DeckId, boolean>>({ A: false, B: false });
  const [status, setStatus] = useState<Record<DeckId, string | null>>({ A: null, B: null });
  const [crossfade, setCrossfade] = useState(0);
  const [zoom, setZoom] = useState(8); // shared waveform zoom (real seconds)
  const [loaded, setLoaded] = useState<Record<DeckId, string | null>>({ A: null, B: null });
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shiftLatched, setShiftLatched] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const shift = shiftLatched || shiftHeld;
  const ACCENT: Record<DeckId, string> = { A: settings.accentA, B: settings.accentB };

  const cycleTempoRange = useCallback(() => {
    setSettings((s) => {
      const i = TEMPO_RANGES.indexOf(s.tempoRange);
      return { ...s, tempoRange: TEMPO_RANGES[(i + 1) % TEMPO_RANGES.length] };
    });
  }, []);

  // The physical Shift key acts as a momentary modifier; the on-screen SHIFT
  // button latches it.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
  }, [settings]);

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

  // Latest UI state for snapshotting from intervals / unload without stale closures.
  const latest = useRef({ meta, loaded, crossfade, zoom });
  latest.current = { meta, loaded, crossfade, zoom };

  const persistSession = useCallback(() => {
    const { meta, loaded, crossfade, zoom } = latest.current;
    const snap: SessionSnapshot = {
      decks: {
        A: deckSnapshot(engine.deckA, meta.A, loaded.A),
        B: deckSnapshot(engine.deckB, meta.B, loaded.B),
      },
      crossfade,
      zoom,
    };
    saveSession(snap);
  }, [engine]);

  // Per-deck load guard: a monotonic token + an AbortController so that loading a
  // new track to a deck cancels any in-flight load and discards its late results
  // (rapid switching must not let an older fetch overwrite the newer track).
  const loadSeq = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  const loadAbort = useRef<Record<DeckId, AbortController | null>>({ A: null, B: null });

  // Core load path. Audio acquisition is three-tier: in-memory session cache →
  // durable IndexedDB cache (survives refresh, offline) → network resolver. A
  // `restore` snapshot re-applies saved deck controls after the buffer loads.
  const loadTrackToDeck = useCallback(
    async (id: DeckId, track: TrackMeta, restore?: DeckSnapshot) => {
      engine.resume();
      loadAbort.current[id]?.abort();
      const ctrl = new AbortController();
      loadAbort.current[id] = ctrl;
      const seq = (loadSeq.current[id] += 1);
      const stale = () => seq !== loadSeq.current[id];
      setStatusFor(id, null);
      setLoading((l) => ({ ...l, [id]: true }));
      try {
        let cached = getCachedTrack(track.videoId);
        if (!cached) {
          let data: ArrayBuffer;
          const stored = await getAudio(track.videoId);
          if (stale()) return;
          if (stored) {
            data = stored.bytes;
          } else {
            data = await fetchYouTubeAudio(
              track.videoId,
              (p) => {
                if (stale()) return;
                const pct =
                  p.totalBytes != null
                    ? `${Math.round((p.receivedBytes / p.totalBytes) * 100)}%`
                    : `${Math.round(p.receivedBytes / 1024)}kb`;
                setStatusFor(id, `Downloading… ${pct}`);
              },
              ctrl.signal,
            );
            void putAudio(track.videoId, data.slice(0)); // cache for next refresh
          }
          if (stale()) return;
          setStatusFor(id, "Decoding…");
          const buffer = await decodeAudio(engine.ctx, data);
          if (stale()) return;
          cached = { buffer, analysis: analyzeTrack(buffer) };
          setCachedTrack(track.videoId, cached);
        }
        if (stale()) return;
        engine.deck(id).setBuffer(cached.buffer, cached.analysis.beatgrid);
        if (restore) applyDeckControls(engine.deck(id), restore);
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
        refresh();
        if (cached.analysis.bpm) library.setBpm(track.videoId, cached.analysis.bpm);
      } catch (e) {
        if ((e as Error).name === "AbortError" || stale()) return;
        setStatusFor(id, (e as Error).message ?? String(e));
      } finally {
        if (!stale()) setLoading((l) => ({ ...l, [id]: false }));
      }
    },
    [engine, library, setStatusFor, refresh],
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

  // Restore the previous session once on startup: mixer + zoom immediately, then
  // re-hydrate each deck's track (IndexedDB-cached → instant) with its controls.
  const didRestore = useRef(false);
  useEffect(() => {
    if (didRestore.current) return;
    didRestore.current = true;
    const snap = loadSession();
    if (!snap) return;
    setCrossfade(snap.crossfade);
    engine.setCrossfade(snap.crossfade);
    setZoom(snap.zoom);
    (["A", "B"] as DeckId[]).forEach((id) => {
      const d = snap.decks[id];
      if (!d.videoId) return;
      const track: TrackMeta = {
        videoId: d.videoId,
        title: d.name,
        artist: d.artist,
        duration: d.duration,
        thumbnail: null,
        views: null,
        bpm: d.bpm,
      };
      void loadTrackToDeck(id, track, d);
    });
  }, [engine, loadTrackToDeck]);

  // Browsers start the audio context suspended; resume it on the first gesture so
  // a deck restored in the "playing" state actually starts sounding on first tap.
  useEffect(() => {
    const resume = () => engine.resume();
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
    return () => {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
    };
  }, [engine]);

  // Save the session periodically and when the tab is hidden / closed.
  useEffect(() => {
    const t = window.setInterval(persistSession, 2000);
    const onHide = () => persistSession();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [persistSession]);

  return (
    <div className="app">
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
              windowSec={zoom}
              onZoom={setZoom}
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
            mirror={false}
            shift={shift}
            jumpBeats={settings.jumpBeats}
            onToggleShift={() => setShiftLatched((v) => !v)}
            onSync={() => { engine.sync("A"); refresh(); }}
            refresh={refresh}
          />

          <div className="mixer-center">
            <div className="channels">
              <ChannelStrip
                id="A"
                deck={engine.deckA}
                accent={ACCENT.A}
                tempoRange={settings.tempoRange}
                onCycleTempoRange={cycleTempoRange}
                refresh={refresh}
              />
              <ChannelStrip
                id="B"
                deck={engine.deckB}
                accent={ACCENT.B}
                tempoRange={settings.tempoRange}
                mirror
                onCycleTempoRange={cycleTempoRange}
                refresh={refresh}
              />
            </div>
            <div className="mixer-foot">
              <button
                className="tempo-width"
                title="Beat-jump / skip size"
                onClick={() => {
                  const i = JUMP_RESOLUTIONS.indexOf(settings.jumpBeats);
                  setSettings({ ...settings, jumpBeats: JUMP_RESOLUTIONS[(i + 1) % JUMP_RESOLUTIONS.length] });
                }}
              >
                SKIP {jumpLabel(settings.jumpBeats)}
              </button>
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCrossfade(0);
                    engine.setCrossfade(0);
                  }}
                />
                <span className="xf-end">B</span>
              </div>
            </div>
          </div>

          <DeckControls
            id="B"
            deck={engine.deckB}
            accent={ACCENT.B}
            mirror={true}
            shift={shift}
            jumpBeats={settings.jumpBeats}
            onToggleShift={() => setShiftLatched((v) => !v)}
            onSync={() => { engine.sync("B"); refresh(); }}
            refresh={refresh}
          />
        </div>
      </main>

      <LibraryPanel library={library} onLoad={loadTrackToDeck} loadedIds={loadedIds} onOpenSettings={() => setSettingsOpen(true)} />

      {settingsOpen && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
