import { useCallback, useEffect, useRef, useState } from "react";
import { DeckLane, type DeckMeta } from "./components/DeckLane";
import { DeckControls } from "./components/DeckControls";
import { ChannelStrip } from "./components/ChannelStrip";
import { MixCenter } from "./components/MixCenter";
import { LibraryPanel } from "./components/LibraryPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { RoomBar } from "./components/RoomBar";
import { useRoom, type Intent, type TickDecks } from "@htl/room";
import {
  AudioEngine,
  type Deck,
  EQ_MIN_DB,
  EQ_MAX_DB,
  analyzeTrack,
  decodeAudio,
  getCachedTrack,
  setCachedTrack,
  useLibrary,
  type TrackMeta,
  fetchYouTubeAudio,
  fileToArrayBuffer,
  resolvePlayable,
  fetchCaptions,
  type CaptionCue,
  fetchCommunity,
  postAnalysis,
  applySettings,
  surfaceColor,
  loadSettings,
  saveSettings,
  useSettingsSync,
  mergeBindings,
  bindingIndex,
  TEMPO_RANGES,
  PITCH_RANGES,
  nextSkip,
  type Settings,
  type DeckSnapshot,
  type SessionSnapshot,
  loadSession,
  saveSession,
  getAudio,
  putAudio,
  loadStems,
  loadStemsLocal,
  dspStems,
  getStemModel,
  modelSupport,
  isMobileDevice,
  fetchStemManifest,
  initGpuCrashGuard,
  armGpu,
  disarmGpu,
  stemTrace,
  DEFAULT_STEM_MODEL,
  type Stems,
  type StemModel,
} from "@htl";

type DeckId = "A" | "B";

// Stem-separation status for a deck. `detail` is the full human sentence (shown in
// Settings ▸ Stems); the deck lane shows only the terse form from `terseStem`.
// "cached"      = stems came straight from the local IndexedDB cache (instant).
// "downloading" = fetching the shared result from R2. Both are CACHE FETCHES (green).
// "separating"  = actually crunching the model on-device (yellow — real work).
// "promoted"    = DSP was auto-upgraded to a neural result already in the cache,
//                 WITHOUT changing the user's selected model (a free quality win).
// `src` is the short source label (e.g. "Demucs") shown as the persistent chip.
export type StemPhase =
  | "cached"
  | "downloading"
  | "separating"
  | "ready"
  | "promoted"
  | "failed"
  | "unavailable";
export interface StemStatus {
  phase: StemPhase;
  pct?: number; // 0–100, while downloading/separating
  detail: string;
  src?: string; // short engine label for the persistent chip ("Demucs" / "Open-Unmix")
}

// Visual tone for the deck-lane badge: a cache FETCH reads green, on-device
// PROCESSING reads yellow — so a song that's already done is obvious at a glance.
export type StemTone = "fetch" | "process" | "ok" | "fail" | "idle";
export interface StemBadge {
  text: string;
  tone: StemTone;
}

// Terse badge for the deck lane. The ACTIVE-stems states (cached/ready/promoted)
// render a persistent green "✦ <engine>" chip so the DJ always sees what they're
// hearing; progress + transient states are percentages / one-word flags.
function terseStem(s: StemStatus | null | undefined): StemBadge | null {
  if (!s) return null;
  switch (s.phase) {
    case "cached":
      return { text: s.src ? `✦ ${s.src}` : "✦ Cached", tone: "ok" };
    case "ready":
      return { text: s.src ? `✦ ${s.src}` : "✓ Done", tone: "ok" };
    case "promoted":
      return { text: `✦ ${s.src ?? "Enhanced"}`, tone: "ok" };
    case "downloading":
      return { text: s.pct != null ? `↓ ${s.pct}%` : "↓ Cache", tone: "fetch" };
    case "separating":
      return { text: s.pct != null ? `⚙ ${s.pct}%` : "⚙ …", tone: "process" };
    case "failed":
      return { text: "Failed", tone: "fail" };
    case "unavailable":
      return { text: "DSP", tone: "idle" };
  }
}

// Short engine label for the deck chip: "HT-Demucs (GPU)"/"(CPU)" → "Demucs",
// "Open-Unmix" stays, anything else → its label. (DSP never shows a chip.)
function stemSrcLabel(modelId: string): string {
  if (modelId.startsWith("htdemucs")) return "Demucs";
  if (modelId.startsWith("umx")) return "Open-Unmix";
  return getStemModel(modelId).label;
}

// Neural models to auto-promote a DSP deck to, best quality first: cached HT-Demucs
// (GPU) result, else Open-Unmix.
const PROMOTE_ORDER = ["htdemucs-onnx", "umxl-int8"];

const EMPTY_META: DeckMeta = { name: "", artist: "", bpm: null, duration: 0, pyramid: null };

// Wait until the browser is idle (with a timeout) so the heavy stem pass runs
// AFTER the freshly-loaded deck UI has painted, instead of stalling the load.
function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (typeof ric === "function") ric(() => resolve(), { timeout: 600 });
    else setTimeout(resolve, 60);
  });
}

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
    fxOn: deck.fxOn,
    keylock: deck.keylock,
    pitchSemis: deck.pitch,
    quantize: deck.quantizing,
    skipBeats: deck.skipBeats,
    cuePoint: deck.cuePoint,
    hotCues: [...deck.hotCues],
    hotLoops: deck.hotLoops.map((l) => (l ? { ...l } : null)),
    loop: deck.loop ? { ...deck.loop } : null,
    loopInPoint: deck.loopInPoint,
    position: deck.position(),
    playing: deck.playing,
    stemGains: { drums: deck.stemLevel("drums"), bass: deck.stemLevel("bass"), vocals: deck.stemLevel("vocals"), other: deck.stemLevel("other") },
    stemMutes: { drums: !deck.stemActive("drums"), bass: !deck.stemActive("bass"), vocals: !deck.stemActive("vocals"), other: !deck.stemActive("other") },
  };
}

// Stem names in the fixed deck order — for snapshot apply.
const STEM_KEYS = ["drums", "bass", "vocals", "other"] as const;

// Apply per-stem mixer state from a snapshot. The deck stores gain/mute even
// before its stems exist, so it takes effect the moment separation finishes.
function applyDeckStems(deck: Deck, s: DeckSnapshot) {
  for (const name of STEM_KEYS) {
    if (s.stemGains && s.stemGains[name] != null) deck.setStemGain(name, s.stemGains[name]);
    if (s.stemMutes) deck.setStemMute(name, !!s.stemMutes[name]);
  }
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
  deck.setFx(s.fxOn ?? true);
  deck.setKeylock(s.keylock);
  deck.setPitch(s.pitchSemis ?? 0);
  deck.setQuantize(s.quantize);
  deck.skipBeats = s.skipBeats ?? 4;
  deck.cuePoint = s.cuePoint;
  deck.hotCues = [...s.hotCues];
  deck.hotLoops = (s.hotLoops ?? []).map((l) => (l ? { ...l } : null));
  if (deck.hotLoops.length < deck.hotCues.length) {
    deck.hotLoops = [...deck.hotLoops, ...new Array(deck.hotCues.length - deck.hotLoops.length).fill(null)];
  }
  deck.loop = s.loop ? { ...s.loop } : null;
  deck.loopInPoint = s.loopInPoint;
  applyDeckStems(deck, s);
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
  const [status, setStatus] = useState<Record<DeckId, StemStatus | null>>({ A: null, B: null });
  const [crossfade, setCrossfade] = useState(0);
  const [zoom, setZoom] = useState<Record<DeckId, number>>({ A: 8, B: 8 }); // per-deck waveform zoom (real seconds)
  const setZoomFor = useCallback((id: DeckId, next: number) => {
    setZoom((z) => ({ ...z, [id]: next }));
  }, []);
  const [loaded, setLoaded] = useState<Record<DeckId, string | null>>({ A: null, B: null });
  const [captions, setCaptions] = useState<Record<DeckId, CaptionCue[]>>({ A: [], B: [] });
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  // WebGPU crash-loop guard: if the last GPU separation took the tab down, disable
  // GPU separation and bounce the selected model back to a safe one so a reload
  // doesn't immediately crash again. `gpuCrashed` drives a one-time notice.
  // The value isn't read here (the Settings ▸ Stems banner gates on isGpuBlocked());
  // we keep the setter so the guard + re-enable flow stay wired.
  const [, setGpuCrashed] = useState(false);
  useEffect(() => {
    if (initGpuCrashGuard()) {
      setGpuCrashed(true);
      setSettings((s) => (getStemModel(s.stemModel).tier === "gpu" ? { ...s, stemModel: DEFAULT_STEM_MODEL } : s));
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Dock open-state persists across reloads on DESKTOP (the docks share the screen
  // there, so it's a layout preference). On mobile they're full-screen modals, so we
  // always start closed regardless of what was stored.
  const [libOpen, setLibOpen] = useState(() => window.innerWidth >= 769 && localStorage.getItem("htl:libOpen") === "1");
  const [searchOpen, setSearchOpen] = useState(() => window.innerWidth >= 769 && localStorage.getItem("htl:searchOpen") === "1");
  useEffect(() => {
    try {
      localStorage.setItem("htl:libOpen", libOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [libOpen]);
  useEffect(() => {
    try {
      localStorage.setItem("htl:searchOpen", searchOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [searchOpen]);
  const [dockSwapped, setDockSwapped] = useState(false); // desktop: swap which side each dock sits on
  const [shiftLatched, setShiftLatched] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const shift = shiftLatched || shiftHeld;
  // Which deck the keyboard drives (Tab toggles it; the focused deck is ringed).
  const [focused, setFocused] = useState<DeckId>("A");
  const ACCENT: Record<DeckId, string> = { A: settings.accentA, B: settings.accentB };

  // Shared-session intent emitters, reached through refs so the keyboard handler
  // (set up before the room wiring below) can broadcast its actions too. Assigned
  // each render once `emit` / `emitDeckControls` exist.
  const emitRef = useRef<(intent: Intent) => void>(() => {});
  const emitDeckRef = useRef<(id: DeckId) => void>(() => {});
  // followRef: this device is a participant → apply inbound control (always from other
  // controllers). lockedRef: a participant NOT allowed to drive (watch-only) → block the
  // local controls. (Audio is separate again: see the mute effect.)
  const followRef = useRef(false);
  const lockedRef = useRef(false);
  // snapFollowRef: apply inbound full-board SNAPSHOTS only when we're a participant AND
  // NOT driving. A controller holds the live board, so a republished snapshot (e.g. when
  // a peer toggles its mute) must never stomp its in-progress edits — intents/ticks still
  // flow (followRef), but snapshots are catch-up only, for followers. See bug #1.
  const snapFollowRef = useRef(false);
  // Jog/scrub streaming: while we're locally scrubbing a deck, ignore the master's
  // inbound ticks for it (so they don't fight the scrub) and coalesce our streamed
  // seeks to one per animation frame.
  const scrubbing = useRef<Record<DeckId, boolean>>({ A: false, B: false });
  const jogDelta = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  const jogRaf = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  // The videoId we've already kicked off a room-driven load for (per deck), so a
  // repeated snapshot never aborts + restarts an in-flight decode.
  const roomLoadTarget = useRef<Record<DeckId, string | null>>({ A: null, B: null });
  // The last board snapshot we received, kept so that once a remote-driven track finishes
  // DECODING we can apply its discrete state (cue/loop/hot-cues/stems/fx) — the snapshot
  // that carried it was skipped while the decode was still in flight. `reconciledTarget`
  // dedupes so we reconcile a given videoId once (live edits after that flow via intents).
  const lastSnapshotRef = useRef<SessionSnapshot | null>(null);
  const reconciledTarget = useRef<Record<DeckId, string | null>>({ A: null, B: null });

  const cycleTempoRange = useCallback(() => {
    const i = TEMPO_RANGES.indexOf(settings.tempoRange);
    const next = TEMPO_RANGES[(i + 1) % TEMPO_RANGES.length];
    setSettings((s) => ({ ...s, tempoRange: next }));
    emitRef.current({ kind: "tempoRange", value: next }); // share it (the range scales the tempo fader)
  }, [settings.tempoRange]);
  // SHIFT-F: cycle the KEY knob's ± semitone range (local only for now).
  const cyclePitchRange = useCallback(() => {
    const i = PITCH_RANGES.indexOf(settings.pitchRange);
    const next = PITCH_RANGES[(i + 1) % PITCH_RANGES.length];
    setSettings((s) => ({ ...s, pitchRange: next }));
  }, [settings.pitchRange]);

  // "dB" gain-match: nudge this deck's TRIM so its trimmed loudness equals the
  // other deck's, clamped to the trim knob's range so a near-silent track can't
  // demand absurd gain. Loudness is the cached integrated RMS of each buffer.
  const MIN_TRIM = Math.pow(10, EQ_MIN_DB / 20);
  const MAX_TRIM = Math.pow(10, EQ_MAX_DB / 20);
  const matchGain = useCallback(
    (id: DeckId) => {
      const self = engine.deck(id);
      const other = engine.deck(id === "A" ? "B" : "A");
      if (!self.buffer || !other.buffer) return;
      const sl = self.loudness;
      const ol = other.loudness;
      if (sl <= 0 || ol <= 0) return;
      const trim = Math.max(MIN_TRIM, Math.min(MAX_TRIM, (other.loudness * other.trim) / sl));
      self.setTrim(trim);
      refresh();
    },
    [engine, refresh, MIN_TRIM, MAX_TRIM],
  );

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

  // Keyboard control surface. Tab toggles the focused deck; the focused deck's
  // bank/lane is ringed and every performance key drives it. The actions mirror
  // the on-screen buttons EXACTLY, reading the live `shift` so a held/latched
  // Shift remaps each key the same way it remaps the buttons (e.g. C → CUE, but
  // Shift+C → START). Bails while typing in a field or with a modal panel open.
  //   space play/pause · c cue · q/w/e loop in/out/exit · u/i/o/p loop sizes ·
  //   a/s/d/f sync/key/fx/dB · 1–8 hot-cue·loop pads · ←/→ nudge a beat ·
  //   ↓/↑ jump back/forward by the skip size. (Shift on any of these applies the
  //   button's shifted action: move-loop, big loops, pitch/channel reset, save loop.)
  useEffect(() => {
    const resetChannel = (deck: ReturnType<typeof engine.deck>) => {
      deck.setTempo(0);
      deck.setFilter(0);
      deck.setTrim(1);
      deck.setEqLow(0);
      deck.setEqMid(0);
      deck.setEqHigh(0);
      deck.setPitch(0);
      deck.resetStems(); // also reset the stem faders (→ unity) and un-mute all stems
    };

    // Per-action behaviour, keyed by action id (see @htl keybinds). Each runs on the
    // FOCUSED deck; `s` is the live Shift modifier (held key or on-screen latch) that
    // selects the shifted variant. Mirrors the on-screen buttons + emits to co-DJs.
    type DeckRef = ReturnType<typeof engine.deck>;
    const TEMPO_NUDGE = 0.5;
    const beatLoop = (deck: DeckRef, id: DeckId, s: boolean, i: number) => {
      const beats = (s ? [1, 2, 4, 8] : [0.5, 0.25, 0.125, 0.0625])[i];
      deck.setBeatLoop(beats);
      emitRef.current({ kind: "loop", deck: id, action: "beat", beats });
    };
    const jogBy = (deck: DeckRef, id: DeckId, s: boolean, beats: number) => {
      if (s) deck.moveLoop(beats);
      else {
        deck.beatJump(beats);
        emitRef.current({ kind: "transport", deck: id, action: "seek", position: deck.position() });
      }
    };
    const stem = (deck: DeckRef, id: DeckId, name: "drums" | "bass" | "vocals" | "other") => {
      if (!deck.hasStems) return;
      deck.toggleStem(name);
      emitRef.current({ kind: "stem", deck: id, stem: name, on: deck.stemActive(name) });
    };
    const hotcue = (deck: DeckRef, id: DeckId, s: boolean, slot: number) => {
      if (s) {
        if (deck.loop && !deck.slotIsSet(slot)) {
          deck.saveLoop(slot);
          emitRef.current({ kind: "hotcue", deck: id, slot, action: "save" });
        } else {
          deck.clearHotCue(slot);
          emitRef.current({ kind: "hotcue", deck: id, slot, action: "clear" });
        }
      } else {
        deck.hotCue(slot);
        emitRef.current({ kind: "hotcue", deck: id, slot, action: "press" });
      }
    };
    const HANDLERS: Record<string, (deck: DeckRef, id: DeckId, s: boolean) => void> = {
      play: (deck, id, s) => {
        if (s) {
          deck.seek(deck.cuePoint);
          if (!deck.playing) deck.play();
          emitRef.current({ kind: "transport", deck: id, action: "seek", position: deck.position() });
          emitRef.current({ kind: "transport", deck: id, action: "play" });
        } else {
          deck.togglePlay();
          emitRef.current({ kind: "transport", deck: id, action: deck.playing ? "play" : "pause" });
        }
      },
      cue: (deck, id, s) => {
        if (s) {
          deck.seek(0);
          emitRef.current({ kind: "transport", deck: id, action: "seek", position: 0 });
        } else if (deck.playing) {
          deck.jumpToCue();
          emitRef.current({ kind: "transport", deck: id, action: "seek", position: deck.position() });
        } else {
          deck.setCue();
          emitRef.current({ kind: "cue", deck: id, position: deck.cuePoint });
        }
      },
      sync: (deck, id, s) => {
        if (s) {
          deck.setTempo(0);
          emitRef.current({ kind: "control", deck: id, param: "tempo", value: 0 });
        } else {
          engine.sync(id);
          emitDeckRef.current(id);
        }
      },
      keyMatch: (deck, id, s) => {
        if (s) {
          resetChannel(deck);
          emitDeckRef.current(id);
        } else {
          engine.matchKey(id);
          emitRef.current({ kind: "control", deck: id, param: "pitch", value: deck.pitch });
        }
      },
      fx: (deck, id) => {
        deck.setFx(!deck.fxOn);
        emitRef.current({ kind: "toggle", deck: id, param: "fx", value: deck.fxOn });
      },
      tempoRange: (deck, id, s) => {
        if (s) {
          matchGain(id);
          emitRef.current({ kind: "control", deck: id, param: "trim", value: deck.trim });
        } else cycleTempoRange();
      },
      grid: (deck, id, s) => {
        if (s) deck.skipBeats = nextSkip(deck.skipBeats);
        else {
          deck.setQuantize(!deck.quantizing);
          emitRef.current({ kind: "toggle", deck: id, param: "quantize", value: deck.quantizing });
        }
      },
      pitchDown: (deck, id, s) => {
        if (s) deck.setTempo(deck.tempo - TEMPO_NUDGE);
        else deck.setPitch(deck.pitch - 1);
        emitRef.current({ kind: "control", deck: id, param: s ? "tempo" : "pitch", value: s ? deck.tempo : deck.pitch });
      },
      pitchUp: (deck, id, s) => {
        if (s) deck.setTempo(deck.tempo + TEMPO_NUDGE);
        else deck.setPitch(deck.pitch + 1);
        emitRef.current({ kind: "control", deck: id, param: s ? "tempo" : "pitch", value: s ? deck.tempo : deck.pitch });
      },
      loopIn: (deck, id) => {
        deck.loopIn();
        emitRef.current({ kind: "loop", deck: id, action: "in" });
      },
      loopOut: (deck, id) => {
        deck.loopOut();
        emitRef.current({ kind: "loop", deck: id, action: "out" });
      },
      loopExit: (deck, id) => {
        if (deck.loop?.active) {
          deck.exitLoop();
          emitRef.current({ kind: "loop", deck: id, action: "exit" });
        } else {
          deck.reloop();
          emitRef.current({ kind: "loop", deck: id, action: "reloop" });
        }
      },
      beatLoop0: (deck, id, s) => beatLoop(deck, id, s, 0),
      beatLoop1: (deck, id, s) => beatLoop(deck, id, s, 1),
      beatLoop2: (deck, id, s) => beatLoop(deck, id, s, 2),
      beatLoop3: (deck, id, s) => beatLoop(deck, id, s, 3),
      muteDrums: (deck, id) => stem(deck, id, "drums"),
      muteBass: (deck, id) => stem(deck, id, "bass"),
      muteVocals: (deck, id) => stem(deck, id, "vocals"),
      muteInst: (deck, id) => stem(deck, id, "other"),
      jogBackBeat: (deck, id, s) => jogBy(deck, id, s, -1),
      jogFwdBeat: (deck, id, s) => jogBy(deck, id, s, 1),
      jogBack: (deck, id, s) => jogBy(deck, id, s, -deck.skipBeats),
      jogFwd: (deck, id, s) => jogBy(deck, id, s, deck.skipBeats),
    };
    for (let i = 0; i < 8; i++) HANDLERS[`hotcue${i + 1}`] = (deck, id, s) => hotcue(deck, id, s, i);
    const keyIndex = bindingIndex(mergeBindings(settings.keyBindings));

    const onKey = (e: KeyboardEvent) => {
      // Never hijack typing or a modal that owns the screen.
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      // Only a true centered modal (Settings) swallows the performance keys. The
      // Library/Search DOCKS share the screen on desktop, so keys keep driving the
      // decks while you browse — typing in the search box is already handled by the
      // input-focus guard just above.
      if (settingsOpen) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A watch-only participant (control revoked) can't drive the decks.
      if (lockedRef.current) return;

      const actionId = keyIndex.get(e.code);
      if (!actionId) return;
      e.preventDefault();
      if (actionId === "focusToggle") {
        setFocused((f) => (f === "A" ? "B" : "A"));
        return;
      }
      const id = focused;
      const deck = engine.deck(id);
      // Read Shift off the event too: a fast Shift+key combo can fire before the
      // on-screen latch state commits; `shift` folds that latch in.
      const s = shift || e.shiftKey;
      HANDLERS[actionId]?.(deck, id, s);
      refresh();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, shift, focused, matchGain, cycleTempoRange, refresh, settingsOpen, searchOpen, libOpen, settings.keyBindings]);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
    engine.deckA.setJogPhysics(settings.jogWeight, settings.jogDrag);
    engine.deckB.setJogPhysics(settings.jogWeight, settings.jogDrag);
  }, [settings, engine]);

  // Mirror settings to the account when signed in (last-write-wins by timestamp), so
  // theme/stem/keybind prefs follow the user across devices.
  useSettingsSync(settings, setSettings);


  const loadedIds = new Set([loaded.A, loaded.B].filter((v): v is string => v !== null));

  // NOTE: no global per-frame re-render here. Each DeckLane self-animates its
  // own waveform + time readout via its own rAF, so playback never re-renders the
  // whole tree (mixers, controls, knobs) 60×/s — the main thread stays free for
  // audio + UX. The rest of the UI re-renders only on interaction (refresh).

  const setStatusFor = useCallback((id: DeckId, st: StemStatus | null) => {
    setStatus((s) => ({ ...s, [id]: st }));
  }, []);

  // The selected stem model, via a ref so the load callbacks read it fresh without
  // re-creating (and so model changes don't churn the load path).
  const stemModelRef = useRef(settings.stemModel);
  stemModelRef.current = settings.stemModel;

  // In-flight neural jobs, keyed by `${videoId}:${modelId}` and SHARED across decks
  // (both decks on the same track+model await ONE separation). The entry is removed
  // when the job settles — so revisiting a model (e.g. switching A→B→A in Settings)
  // re-runs the cache-first loadStems and re-applies the stems, instead of being
  // permanently skipped (the old per-deck guard never cleared on success, which left
  // the deck stuck on the DSP split after any model round-trip).
  const stemJobs = useRef<Map<string, Promise<Stems>>>(new Map());

  // Auto-promotion: when the deck is on DSP (the default), look for a neural result
  // that ALREADY exists for this track — first on local disk, then in the shared R2
  // cache — and silently swap it in over the DSP split. It's a pure cache read (no
  // separation, never crashes), best-quality-first, and it does NOT change the
  // user's selected model. If nothing is cached anywhere, the DSP split just stays.
  const promoteCachedStems = useCallback(
    async (id: DeckId, videoId: string, mix: AudioBuffer, stale?: () => boolean) => {
      // 1. Local disk first (instant, offline): the best neural stems we already have.
      for (const mid of PROMOTE_ORDER) {
        const local = await loadStemsLocal(engine.ctx, videoId, mid);
        if (stale?.()) return false;
        if (local) {
          engine.deck(id).setStems(local);
          refresh();
          setStatusFor(id, {
            phase: "promoted",
            src: stemSrcLabel(mid),
            detail: `Auto-enhanced with ${getStemModel(mid).label} (cached on disk) — your stem setting stays DSP.`,
          });
          return true;
        }
      }
      // 2. Shared R2 cache: probe candidates best-first; first complete one wins.
      for (const mid of PROMOTE_ORDER) {
        const man = await fetchStemManifest(videoId, mid).catch(() => null);
        if (stale?.()) return false;
        if (!man?.complete) continue;
        const m = getStemModel(mid);
        const src = stemSrcLabel(mid);
        stemTrace(`promote ${id}:download`, mid); // crash here ⇒ downloading/decoding a cached neural set OOMs
        setStatusFor(id, { phase: "downloading", src, detail: `Enhanced stems found (${m.label}) — downloading…` });
        try {
          const key = `${videoId}:${mid}`;
          let job = stemJobs.current.get(key);
          if (!job) {
            job = loadStems(engine.ctx, videoId, mix, m, (pct) => {
              const p = Math.round(pct * 100);
              setStatusFor(id, { phase: "downloading", src, pct: p, detail: `Enhancing with ${m.label}… ${p}%` });
            });
            stemJobs.current.set(key, job);
            void job.finally(() => {
              if (stemJobs.current.get(key) === job) stemJobs.current.delete(key);
            });
          }
          const neural = await job;
          if (stale?.()) return false;
          engine.deck(id).setStems(neural);
          refresh();
          setStatusFor(id, {
            phase: "promoted",
            src,
            detail: `Auto-enhanced with ${m.label} (from the shared cache) — your stem setting stays DSP.`,
          });
          return true; // applied a cached neural set (one set — safe on mobile)
        } catch {
          /* promotion is best-effort — caller falls back to the DSP split */
          return false;
        }
      }
      // Nothing cached anywhere → caller shows the DSP split.
      return false;
    },
    [engine, refresh, setStatusFor],
  );

  // Resolve a deck's stems: light the buttons instantly with the DSP split, then —
  // if a neural model is selected — separate (R2 cache → on-device ONNX) in the
  // background and swap the cleaner stems in. Both sum to the mix, so it's seamless.
  // `stale()` (when given) drops results if the deck moved on to another track.
  const deriveStems = useCallback(
    async (id: DeckId, videoId: string, mix: AudioBuffer, stale?: () => boolean) => {
      const model = getStemModel(stemModelRef.current);
      // Let the deck's UI render first — the stem split is background work.
      await whenIdle();
      if (stale?.()) return;

      // MEMORY DISCIPLINE (the iPhone crash fix). A stem SET = 4 full-length stereo
      // float32 buffers (~424 MB for a 5-min track). iOS Safari's ~1–1.5 GB per-tab
      // budget holds ONE set but not TWO — holding the DSP set AND a neural set at
      // once is what jetsam-killed the tab (even Open-Unmix, even a plain cache
      // download). So on MOBILE we never pre-make the DSP split when a neural set is
      // coming: decode/separate exactly one set. Desktop has headroom and keeps the
      // instant DSP-then-swap UX. `applyDsp` is the shared one-set DSP fallback.
      const mobile = isMobileDevice();
      // On mobile, drop this deck's CURRENT stems before building a new set. On a
      // model switch / re-analyze / cache-enhance there's no setBuffer to free them,
      // so the old set (~424 MB) would be held through the whole new build → OOM. The
      // buttons go inactive for the brief build; we'd rather that than a tab reload.
      if (mobile) {
        engine.deck(id).setStems(null);
        refresh();
      }
      stemTrace(`derive ${id}`, `${model.id}${mobile ? " mobile" : ""}`);
      const applyDsp = async () => {
        try {
          stemTrace(`dsp ${id}`); // crash here ⇒ the instant DSP split (424 MB) itself OOMs
          const dsp = await dspStems(mix);
          if (stale?.()) return;
          engine.deck(id).setStems(dsp);
          refresh();
        } catch {
          /* DSP is best-effort */
        }
      };

      // Refresh-fast path: for a neural model, if THIS track's stems are already
      // persisted in IndexedDB (from a previous separation/download), decode them
      // straight from disk and apply — NO DSP reprocess, NO R2 re-download, NO
      // re-separation. This is what stops a page refresh from redoing the work.
      if (model.kind !== "dsp") {
        const local = await loadStemsLocal(engine.ctx, videoId, model.id);
        if (local) {
          if (stale?.()) return;
          engine.deck(id).setStems(local);
          refresh();
          // Make a cache hit OBVIOUS (green), so it reads differently from a fresh
          // separation — these stems came straight off disk, no work was done. The
          // chip persists (it's the active-stems indicator), clearing on next load.
          setStatusFor(id, {
            phase: "cached",
            src: stemSrcLabel(model.id),
            detail: `${model.label} — cached (loaded from disk).`,
          });
          return;
        }
      }

      // DSP selected (the default). On DESKTOP, silently UPGRADE to any neural result
      // already cached for this track (local or shared R2) — a free quality win.
      // On MOBILE, DO NOT auto-enhance: auto-materializing a ~424 MB cached neural set
      // on every track load OOM-crashes iPhone Safari (worse with both decks loaded).
      // Phones get the instant DSP split; neural is OPT-IN (the user selects a model
      // or hits Re-analyze, accepting the memory cost), and that path frees the old
      // set first so it stays single-set.
      if (model.kind === "dsp") {
        await applyDsp();
        if (!mobile) await promoteCachedStems(id, videoId, mix, stale);
        return;
      }
      const key = `${videoId}:${model.id}`;
      const support = modelSupport(model); // "runs" here | "desktop" | "needs-gpu"

      // Is this model's result already shared in R2? If so, ANY device — phone
      // included — can DOWNLOAD it, even when it can't separate locally.
      const manifest = await fetchStemManifest(videoId, model.id).catch(() => null);
      if (stale?.()) return;
      const cached = !!manifest?.complete;

      // Can't separate here and nobody has yet → keep DSP and say exactly why,
      // instead of a silent fallback or a "Separating…" that never finishes.
      // (Light int8 models already report support==="runs" on phones, so phones
      // DO contribute those; heavy fp32 / GPU stay desktop-gated — forcing them on
      // mobile OOM-kills the tab, and loadStems would just return DSP anyway,
      // faking a "ready" that's really the DSP split.)
      if (!cached && support !== "runs") {
        await applyDsp();
        const detail =
          support === "blocked"
            ? `${model.label}: GPU separation was disabled after a crash. Re-enable it in Settings ▸ Stems, or pick a CPU model. Using DSP.`
            : `${model.label}: separate on ${support === "needs-gpu" ? "a GPU desktop" : "a desktop"} first — using DSP for now.`;
        setStatusFor(id, { phase: "unavailable", detail });
        setTimeout(() => !stale?.() && setStatusFor(id, null), 6000);
        return;
      }

      // Desktop: show the instant DSP split now, then swap the neural set in when
      // ready. Mobile: skip it — decode/separate the single neural set only, so we
      // never hold two ~424 MB sets at once (the iPhone OOM). The stem buttons simply
      // wait for the neural result instead of lighting up on a throwaway DSP split.
      if (!mobile) await applyDsp();

      // cached → DOWNLOAD the shared stems (any device); else → SEPARATE on-device.
      const phase: StemPhase = cached ? "downloading" : "separating";
      const verb = cached ? "Downloading" : "Separating with";
      // Actual on-device GPU work (not a cached download) can HARD-crash the tab —
      // arm the crash guard so a reload doesn't re-attempt and loop. Disarmed in
      // `finally` (success or caught error both mean the tab survived).
      // Any on-device GPU separation (legacy Burn "demucs" OR the ORT-WebGPU
      // "demucs-core") can hard-crash the tab — on iPhone Safari especially (the
      // ORT JSEP WebGPU memory leak). Guard the whole gpu tier so a crash can't loop.
      const gpuSeparate = !cached && model.tier === "gpu";
      if (gpuSeparate) armGpu(model.id);
      setStatusFor(id, { phase, pct: 0, detail: `${verb} ${model.label}…` });
      try {
        // Share one job per (track, model): a model toggle, a StrictMode re-fire,
        // or both decks on the same track reuse it instead of stacking heavy work.
        let job = stemJobs.current.get(key);
        if (!job) {
          job = loadStems(engine.ctx, videoId, mix, model, (pct) => {
            const p = Math.round(pct * 100);
            setStatusFor(id, { phase, pct: p, detail: `${verb} ${model.label}… ${p}%` });
          });
          stemJobs.current.set(key, job);
          void job.finally(() => {
            if (stemJobs.current.get(key) === job) stemJobs.current.delete(key);
          });
        }
        const neural = await job;
        if (stale?.()) return;
        engine.deck(id).setStems(neural);
        refresh();
        // Persistent active-stems chip (clears on next track load).
        setStatusFor(id, { phase: "ready", src: stemSrcLabel(model.id), detail: `${model.label} ready.` });
      } catch (e) {
        console.warn("[htl] neural stems failed:", e);
        // The neural attempt is over (its memory freed) → now it's safe to put DSP in.
        await applyDsp();
        setStatusFor(id, { phase: "failed", detail: `${model.label} failed — using DSP. See console for details.` });
        setTimeout(() => !stale?.() && setStatusFor(id, null), 6000);
      } finally {
        if (gpuSeparate) disarmGpu();
      }
    },
    [engine, refresh, setStatusFor, promoteCachedStems],
  );

  // Latest UI state for snapshotting from intervals / unload without stale closures.
  const latest = useRef({ meta, loaded, crossfade, zoom, tempoRange: settings.tempoRange });
  latest.current = { meta, loaded, crossfade, zoom, tempoRange: settings.tempoRange };

  // Periodic session save. The write is a SYNCHRONOUS localStorage.setItem of the
  // serialized snapshot — on the main thread it's a classic frame-jank source, and
  // a stall there can starve the audio buffer (audible as a choke over Bluetooth).
  // So: (1) run the periodic write during IDLE time so it never lands on a render
  // frame, and (2) skip it entirely when the snapshot hasn't changed (the common
  // paused/idle case → zero writes). `immediate` forces a synchronous write for
  // tab-hide/close, where there's no idle window left.
  // Build a full session snapshot from the live engine + UI state. Shared by the
  // periodic localStorage save AND the shared-session publish (master → co-DJs).
  const buildSnapshot = useCallback((): SessionSnapshot => {
    const { meta, loaded, crossfade, zoom, tempoRange } = latest.current;
    return {
      decks: {
        A: deckSnapshot(engine.deckA, meta.A, loaded.A),
        B: deckSnapshot(engine.deckB, meta.B, loaded.B),
      },
      crossfade,
      zoom,
      tempoRange,
    };
  }, [engine]);

  const persistPending = useRef(false);
  const lastPersist = useRef<string>("");
  const persistSession = useCallback((immediate = false) => {
    const doSave = () => {
      const snap = buildSnapshot();
      const json = JSON.stringify(snap);
      if (json === lastPersist.current) return; // unchanged → no write, no jank
      lastPersist.current = json;
      saveSession(snap);
    };
    if (immediate) {
      doSave();
      return;
    }
    if (persistPending.current) return; // a save is already queued for the next idle
    persistPending.current = true;
    void whenIdle().then(() => {
      persistPending.current = false;
      doSave();
    });
  }, [buildSnapshot]);

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
      // Free the OUTGOING track's stem set (~300–424 MB) up front, BEFORE we decode
      // the new track and build its stems. Otherwise the old set + the new mix + the
      // new stem set briefly coexist on this deck (plus the other deck's set) and
      // OOM-reload iPhone Safari on a track switch. The stems get re-derived anyway.
      stemTrace(`load ${id}:start`, track.title?.slice(0, 40));
      engine.deck(id).setStems(null);
      setCaptions((c) => ({ ...c, [id]: [] })); // drop the old track's captions
      setLoading((l) => ({ ...l, [id]: true }));
      try {
        // Resolve to a decodable YouTube id. YouTube tracks pass straight through;
        // a track sourced from another catalog (Spotify/Tidal) is matched via the
        // id system. Everything downstream keys off this resolved `vid`.
        let vid = track.videoId;
        if (!vid) {
          setStatusFor(id, { phase: "downloading", detail: "Matching…" });
          const playable = await resolvePlayable(
            {
              title: track.title,
              artist: track.artist,
              duration: track.duration,
              videoId: track.videoId,
              isrc: track.isrc,
              provider: track.provider,
              providerId: track.providerId,
            },
            ctrl.signal,
          );
          if (stale()) return;
          vid = playable.videoId;
        }
        // Captions ride the same player response the stream uses — fetch in the
        // background and drop them onto the deck's ribbon (empty for most music).
        void fetchCaptions(vid).then((cues) => {
          if (!stale() && cues.length) setCaptions((c) => ({ ...c, [id]: cues }));
        });
        let cached = getCachedTrack(vid);
        if (!cached) {
          let data: ArrayBuffer;
          const stored = await getAudio(vid);
          if (stale()) return;
          if (stored) {
            data = stored.bytes;
          } else {
            data = await fetchYouTubeAudio(
              vid,
              (p) => {
                if (stale()) return;
                const pct = p.totalBytes != null ? Math.round((p.receivedBytes / p.totalBytes) * 100) : undefined;
                const label = pct != null ? `${pct}%` : `${Math.round(p.receivedBytes / 1024)}kb`;
                setStatusFor(id, { phase: "downloading", pct, detail: `Downloading… ${label}` });
              },
              ctrl.signal,
            );
            void putAudio(vid, data.slice(0)); // cache for next refresh
          }
          if (stale()) return;
          setStatusFor(id, { phase: "downloading", detail: "Decoding…" });
          const buffer = await decodeAudio(engine.ctx, data);
          if (stale()) return;
          cached = { buffer, analysis: analyzeTrack(buffer) };
          setCachedTrack(vid, cached);
        }
        if (stale()) return;
        engine.deck(id).setBuffer(cached.buffer, cached.analysis.beatgrid);
        engine.deck(id).key = cached.analysis.key;
        if (restore) applyDeckControls(engine.deck(id), restore);
        setLoaded((l) => ({ ...l, [id]: vid }));
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
        if (track.videoId && cached.analysis.bpm) library.setBpm(track.videoId, cached.analysis.bpm);
        if (track.videoId && cached.analysis.key) library.setKey(track.videoId, cached.analysis.key.camelot);
        // Contribute this analysis to the shared dataset (BPM/key/grid — facts, no audio).
        if (track.videoId) {
          void postAnalysis({
            videoId: track.videoId,
            bpm: cached.analysis.bpm,
            key: cached.analysis.key?.camelot ?? null,
            keyName: cached.analysis.key?.name ?? null,
            beatOffset: cached.analysis.beatgrid?.firstBeat ?? null,
            duration: Math.round(cached.buffer.duration),
          });
        }
        // Stems: light the buttons instantly with the DSP split, then (if a neural
        // model is selected) separate in the background and swap the cleaner stems
        // in. Both sum to the mix, so the swap is seamless. stale() guards re-loads.
        // Keyed by the resolved id so the R2 stem cache lines up with the stream.
        void deriveStems(id, vid, cached!.buffer, stale);
      } catch (e) {
        if ((e as Error).name === "AbortError" || stale()) return;
        setStatusFor(id, { phase: "failed", detail: (e as Error).message ?? String(e) });
      } finally {
        if (!stale()) setLoading((l) => ({ ...l, [id]: false }));
      }
    },
    [engine, library, setStatusFor, refresh, deriveStems],
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
        engine.deck(id).key = analysis.key;
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
        void deriveStems(id, file.name, buffer);
      } catch (e) {
        setStatusFor(id, { phase: "failed", detail: `Load failed: ${(e as Error).message}` });
      } finally {
        setLoading((l) => ({ ...l, [id]: false }));
      }
    },
    [engine, setStatusFor, refresh, deriveStems],
  );

  // Force a FRESH on-device separation of one deck with `model`, overwriting any
  // cached result (the Settings "Re-analyze" action). `force` makes loadStems skip
  // the R2 download and re-compute. Only meaningful where the device can run it.
  const forceSeparate = useCallback(
    async (id: DeckId, videoId: string, mix: AudioBuffer, model: StemModel, stale?: () => boolean) => {
      if (model.kind === "dsp") return;
      if (modelSupport(model) !== "runs") {
        setStatusFor(id, { phase: "unavailable", detail: `${model.label}: can't re-analyze on this device.` });
        setTimeout(() => !stale?.() && setStatusFor(id, null), 6000);
        return;
      }
      // Free the existing stems before re-separating (esp. on mobile) so the old set
      // and the freshly-computed one don't coexist and OOM the tab.
      if (isMobileDevice()) {
        engine.deck(id).setStems(null);
        refresh();
      }
      const gpuSeparate = model.tier === "gpu";
      if (gpuSeparate) armGpu(model.id);
      setStatusFor(id, { phase: "separating", pct: 0, detail: `Re-analyzing with ${model.label}…` });
      try {
        const stems = await loadStems(
          engine.ctx,
          videoId,
          mix,
          model,
          (pct) => {
            const p = Math.round(pct * 100);
            setStatusFor(id, { phase: "separating", pct: p, detail: `Re-analyzing with ${model.label}… ${p}%` });
          },
          true, // force a re-compute, ignore + overwrite the cache
        );
        if (stale?.()) return;
        engine.deck(id).setStems(stems);
        refresh();
        setStatusFor(id, { phase: "ready", src: stemSrcLabel(model.id), detail: `${model.label} ready (re-analyzed).` });
      } catch (e) {
        console.warn("[htl] re-analyze failed:", e);
        setStatusFor(id, { phase: "failed", detail: `${model.label} re-analyze failed — see console.` });
        setTimeout(() => !stale?.() && setStatusFor(id, null), 6000);
      } finally {
        if (gpuSeparate) disarmGpu();
      }
    },
    [engine, refresh, setStatusFor],
  );

  // "Re-analyze loaded track(s)" with `modelId` from Settings: switch to that model
  // and force a fresh separation on every loaded deck (ignoring any cached result).
  const reanalyze = useCallback(
    (modelId: string) => {
      const model = getStemModel(modelId);
      if (model.kind === "dsp") return;
      setSettings((s) => ({ ...s, stemModel: modelId }));
      for (const id of ["A", "B"] as DeckId[]) {
        const vid = loaded[id];
        const deck = engine.deck(id);
        if (!vid || !deck.buffer) continue;
        void forceSeparate(id, vid, deck.buffer, model);
      }
    },
    [engine, loaded, forceSeparate],
  );

  // Re-derive stems for any loaded deck when the chosen model changes, so the
  // switch takes effect on the tracks already on the decks (not just the next load).
  useEffect(() => {
    let cancelled = false;
    for (const id of ["A", "B"] as DeckId[]) {
      const vid = loaded[id];
      const deck = engine.deck(id);
      if (!vid || !deck.buffer) continue;
      void deriveStems(id, vid, deck.buffer, () => cancelled);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.stemModel]);

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

  // --- Shared session (rooms) ------------------------------------------------
  // A received snapshot mirrors the master's set: (re)load decks whose track
  // changed (with all controls), and for an already-loaded deck mirror the master's
  // loop / cue / hot-cue STATE (absolute positions, so exact regardless of our own
  // playhead). Crossfade + zoom always track; faders + playhead arrive via intents
  // + ticks, so we don't reset them here.
  // Mirror a deck's DISCRETE state from a snapshot (loop / cue / hot-cues / stem mutes+
  // levels / fx / keylock / quantize). Absolute positions, so exact regardless of our own
  // playhead. Continuous main faders + playhead come via intents + ticks (not touched here,
  // so a live drag isn't fought).
  const reconcileDeckState = useCallback(
    (id: DeckId, d: DeckSnapshot) => {
      const deck = engine.deck(id);
      deck.cuePoint = d.cuePoint;
      deck.hotCues = [...d.hotCues];
      deck.hotLoops = (d.hotLoops ?? []).map((l) => (l ? { ...l } : null));
      deck.loop = d.loop ? { ...d.loop } : null;
      deck.loopInPoint = d.loopInPoint;
      applyDeckStems(deck, d);
      if (deck.fxOn !== (d.fxOn ?? true)) deck.setFx(d.fxOn ?? true);
      if (deck.keylock !== d.keylock) deck.setKeylock(d.keylock);
      if (deck.quantizing !== d.quantize) deck.setQuantize(d.quantize);
    },
    [engine],
  );

  // Kick off a room-driven load with a SELF-HEALING dedupe guard. roomLoadTarget is set
  // optimistically (so a duplicate snapshot/intent doesn't load the same track twice), but
  // if the load fails / aborts / is superseded WITHOUT landing the track, we clear the guard
  // so the next snapshot or intent can retry — otherwise the deck stays stuck on the old
  // track and the session silently drifts out of sync.
  const runRoomLoad = useCallback(
    (id: DeckId, videoId: string, track: TrackMeta, restore?: DeckSnapshot) => {
      roomLoadTarget.current[id] = videoId;
      reconciledTarget.current[id] = null; // re-arm the post-decode discrete-state reconcile
      void loadTrackToDeck(id, track, restore)
        .catch(() => {})
        .finally(() => {
          if (roomLoadTarget.current[id] === videoId && latest.current.loaded[id] !== videoId) {
            roomLoadTarget.current[id] = null;
          }
        });
    },
    [loadTrackToDeck],
  );

  const applyRoomSnapshot = useCallback(
    (snapshot: unknown) => {
      if (!snapFollowRef.current) return; // solo, OR a driver holding the live board → ignore catch-up snapshots
      const snap = snapshot as SessionSnapshot | null;
      if (!snap || !snap.decks) return;
      lastSnapshotRef.current = snap; // keep for the post-decode reconcile (effect below)
      setCrossfade(snap.crossfade);
      engine.setCrossfade(snap.crossfade);
      if (snap.tempoRange != null) setSettings((s) => (s.tempoRange === snap.tempoRange ? s : { ...s, tempoRange: snap.tempoRange! }));
      (["A", "B"] as DeckId[]).forEach((id) => {
        const d = snap.decks[id];
        if (!d) return;
        const loadedId = latest.current.loaded[id];
        if (d.videoId && d.videoId !== loadedId && d.videoId !== roomLoadTarget.current[id]) {
          // New track for this deck → load it ONCE (self-healing dedupe). Both decks load
          // concurrently so neither waits on the other; each is guarded so a failed decode
          // can't crash the tree. (Stem sets, not base decodes, are the iOS memory hog and
          // never run on phones — canSeparate — so concurrent base decodes are safe.) The
          // freshly-loaded track's discrete state lands via the post-decode effect.
          if (snap.zoom?.[id] != null) setZoomFor(id, snap.zoom[id]);
          const track: TrackMeta = {
            videoId: d.videoId,
            title: d.name,
            artist: d.artist,
            duration: d.duration,
            thumbnail: null,
            views: null,
            bpm: d.bpm,
          };
          runRoomLoad(id, d.videoId, track, d);
        } else if (d.videoId && d.videoId === loadedId) {
          reconcileDeckState(id, d);
          reconciledTarget.current[id] = d.videoId;
        }
      });
      refresh();
    },
    [engine, runRoomLoad, reconcileDeckState, refresh, setZoomFor],
  );

  // Once a remote-driven track finishes DECODING (loaded[id] catches up to the target),
  // apply that track's discrete state from the last snapshot — the snapshot that carried
  // it was skipped while the decode was mid-flight, so the cue/loop/hot-cues/stems/fx would
  // otherwise never land. Followers only; deduped per videoId so live intent edits after
  // aren't stomped.
  useEffect(() => {
    if (!snapFollowRef.current) return;
    const snap = lastSnapshotRef.current;
    if (!snap) return;
    let any = false;
    (["A", "B"] as DeckId[]).forEach((id) => {
      const d = snap.decks[id];
      if (d?.videoId && d.videoId === loaded[id] && reconciledTarget.current[id] !== d.videoId) {
        reconcileDeckState(id, d);
        reconciledTarget.current[id] = d.videoId;
        any = true;
      }
    });
    if (any) refresh();
  }, [loaded, reconcileDeckState, refresh]);

  // Apply ONE control intent to the local engine — used for both inbound remote
  // intents and our own actions. Pure local effect, no network.
  const applyIntent = useCallback(
    (intent: Intent) => {
      if (intent.kind === "crossfade") {
        setCrossfade(intent.value);
        engine.setCrossfade(intent.value);
        return;
      }
      if (intent.kind === "tempoRange") {
        setSettings((s) => (s.tempoRange === intent.value ? s : { ...s, tempoRange: intent.value }));
        return;
      }
      const deck = engine.deck(intent.deck);
      switch (intent.kind) {
        case "control":
          if (intent.param === "tempo") deck.setTempo(intent.value);
          else if (intent.param === "trim") deck.setTrim(intent.value);
          else if (intent.param === "level") deck.setLevel(intent.value);
          else if (intent.param === "eqLow") deck.setEqLow(intent.value);
          else if (intent.param === "eqMid") deck.setEqMid(intent.value);
          else if (intent.param === "eqHigh") deck.setEqHigh(intent.value);
          else if (intent.param === "filter") deck.setFilter(intent.value);
          else if (intent.param === "pitch") deck.setPitch(Math.round(intent.value));
          break;
        case "toggle":
          if (intent.param === "fx") deck.setFx(intent.value);
          else if (intent.param === "keylock") deck.setKeylock(intent.value);
          else deck.setQuantize(intent.value);
          break;
        case "stemGain":
          if (deck.hasStems) deck.setStemGain(intent.stem, intent.value);
          break;
        case "stem":
          if (deck.hasStems) deck.setStemMute(intent.stem, !intent.on);
          break;
        case "transport":
          if (intent.action === "play") {
            if (!deck.playing) {
              engine.resume(); // a co-DJ's deck must advance (silently) to track the master
              deck.play();
            }
          } else if (intent.action === "pause") {
            if (deck.playing) deck.pause();
          } else if (intent.action === "seek") deck.seek(intent.position ?? 0);
          break;
        case "cue":
          deck.cuePoint = intent.position;
          break;
        case "jog":
          // Drive the platter physics locally (audible scratch on the master, silent
          // on co-DJs). Suppress tick-follow for this deck during the remote scrub.
          if (intent.phase === "start") {
            scrubbing.current[intent.deck] = true;
            engine.resume();
            deck.scrubBegin();
          } else if (intent.phase === "move") {
            deck.scrubMove(intent.delta ?? 0);
          } else {
            deck.scrubEnd();
            setTimeout(() => (scrubbing.current[intent.deck] = false), 250);
          }
          break;
        case "loop":
          if (intent.action === "in") deck.loopIn();
          else if (intent.action === "out") deck.loopOut();
          else if (intent.action === "exit") deck.exitLoop();
          else if (intent.action === "reloop") deck.reloop();
          else deck.setBeatLoop(intent.beats ?? 0.5);
          break;
        case "hotcue":
          if (intent.action === "press") deck.hotCue(intent.slot);
          else if (intent.action === "save") deck.saveLoop(intent.slot);
          else deck.clearHotCue(intent.slot);
          break;
        case "load":
          // A co-DJ handed us a track → WE load/decode/play it (the master is the
          // real audio source). Minimal meta; loadTrackToDeck fetches + analyses by id.
          // Dedupe vs the snapshot path so we don't load it twice.
          if (intent.videoId !== latest.current.loaded[intent.deck] && intent.videoId !== roomLoadTarget.current[intent.deck]) {
            runRoomLoad(intent.deck, intent.videoId, { videoId: intent.videoId, title: intent.name ?? "", artist: intent.artist ?? "", duration: 0, thumbnail: null, views: null, bpm: null });
          }
          break;
      }
    },
    [engine, runRoomLoad],
  );

  // Inbound control intent from a co-DJ → apply locally + repaint. Never re-emit.
  const onRoomIntent = useCallback(
    (intent: Intent) => {
      if (!followRef.current) return; // not following → ignore the controller's intents
      applyIntent(intent);
      refresh();
    },
    [applyIntent, refresh],
  );

  // Inbound master playhead tick (we're a co-DJ): mirror play state + correct drift. A
  // LISTENING follower renders its own AUDIBLE stream, and a hard seek rebuilds the audio
  // source (an audible skip), so we must seek sparingly: a tick is a STALE snapshot of a
  // moving clock, so a playing follower naturally runs ~network-latency ahead of t.pos — a
  // tight threshold would seek every tick (the "skipping / drops" bug). So only correct a
  // LARGE desync while playing; align tightly only when paused (silent → no skip) and do a
  // clean catch-up seek on a play/pause flip.
  const onRoomTick = useCallback(
    (decks: TickDecks) => {
      if (!followRef.current) return; // not following → our playhead is our own
      let flipped = false;
      (["A", "B"] as DeckId[]).forEach((id) => {
        const t = decks[id];
        const deck = engine.deck(id);
        if (!t || !deck.buffer || scrubbing.current[id]) return; // don't fight a local scrub
        const drift = Math.abs(deck.position() - t.pos);
        if (t.playing && !deck.playing) {
          engine.resume(); // iOS starts suspended
          if (drift > 0.05) deck.seek(t.pos); // catch up cleanly BEFORE the source starts
          deck.play();
          flipped = true;
        } else if (!t.playing && deck.playing) {
          deck.pause();
          if (drift > 0.05) deck.seek(t.pos); // land on the master's paused position
          flipped = true;
        } else if (deck.playing) {
          if (drift > 0.6) deck.seek(t.pos); // steady audible playback → only fix a real desync
        } else {
          if (drift > 0.12) deck.seek(t.pos); // both paused → tight align is silent, no skip
        }
      });
      if (flipped) refresh();
    },
    [engine, refresh],
  );

  const room = useRoom({ onState: applyRoomSnapshot, onIntent: onRoomIntent, onTick: onRoomTick });

  // Our own actions broadcast as intents (the controls also apply locally first, so
  // this is purely the network echo). Any CONTROLLING participant drives (shared
  // co-DJ) — a no-op for a watch-only listener or a solo device.
  const emit = useCallback(
    (intent: Intent) => {
      if (room.controlling) room.sendIntent(intent);
    },
    [room.controlling, room.sendIntent],
  );

  // Re-broadcast a deck's whole control state after a computed multi-param action
  // (SYNC / KEY-reset / gain-match) the buttons apply locally in one shot.
  const emitDeckControls = useCallback(
    (id: DeckId) => {
      if (!room.controlling) return;
      const d = engine.deck(id);
      emit({ kind: "control", deck: id, param: "tempo", value: d.tempo });
      emit({ kind: "control", deck: id, param: "trim", value: d.trim });
      emit({ kind: "control", deck: id, param: "level", value: d.level });
      emit({ kind: "control", deck: id, param: "eqLow", value: d.eqLow });
      emit({ kind: "control", deck: id, param: "eqMid", value: d.eqMid });
      emit({ kind: "control", deck: id, param: "eqHigh", value: d.eqHigh });
      emit({ kind: "control", deck: id, param: "filter", value: d.filterValue });
      emit({ kind: "control", deck: id, param: "pitch", value: d.pitch });
    },
    [engine, emit, room.controlling],
  );
  emitRef.current = emit;
  emitDeckRef.current = emitDeckControls;
  // Apply inbound control whenever we're a participant — intents are always from
  // OTHER controllers (the DO never echoes our own), so it never fights us.
  followRef.current = room.enabled;
  // Snapshots only catch us up when we're NOT driving — a controller's live board must
  // never be stomped by a republished snapshot (bug #1).
  snapFollowRef.current = room.enabled && !room.controlling;
  // Locked out of driving (a watch-only listener) → block the keys + show the overlay.
  lockedRef.current = room.enabled && !room.controlling;

  // Scrub streamed over WS as START / MOVE(delta) / END jog events. The receiver
  // drives its OWN platter physics (deck.scrubBegin/scrubMove/scrubEnd) — smooth
  // scratch audio, one grain per frame — instead of re-seeking 60×/s (which tears
  // down + respawns the source and breaks the audio). Move deltas are summed per
  // animation frame. Tick-follow for the deck is suppressed until just after release.
  const onJogStart = useCallback(
    (id: DeckId) => {
      scrubbing.current[id] = true;
      emit({ kind: "jog", deck: id, phase: "start" });
    },
    [emit],
  );
  const emitJog = useCallback(
    (id: DeckId, delta: number) => {
      jogDelta.current[id] += delta;
      if (jogRaf.current[id]) return;
      jogRaf.current[id] = requestAnimationFrame(() => {
        jogRaf.current[id] = 0;
        const d = jogDelta.current[id];
        jogDelta.current[id] = 0;
        if (d !== 0) emit({ kind: "jog", deck: id, phase: "move", delta: d });
      });
    },
    [emit],
  );
  const onJogEnd = useCallback(
    (id: DeckId) => {
      emit({ kind: "jog", deck: id, phase: "end" });
      setTimeout(() => (scrubbing.current[id] = false), 250);
    },
    [emit],
  );
  // A tap-seek (needle drop) is a one-shot jump — fine as a single seek intent.
  const emitSeekTo = useCallback((id: DeckId, pos: number) => emit({ kind: "transport", deck: id, action: "seek", position: pos }), [emit]);
  // A user picking a track hands it to the audio master via a load intent (the master
  // does the real streaming / decode / playback / stems); we also load locally for our
  // own waveform. Remote-driven loads go through applyIntent and DON'T re-emit.
  const loadAndShare = useCallback(
    (id: DeckId, track: TrackMeta) => {
      if (track.videoId) {
        roomLoadTarget.current[id] = track.videoId; // so the master's echo snapshot doesn't reload it
        emit({ kind: "load", deck: id, videoId: track.videoId, name: track.title, artist: track.artist });
      }
      void loadTrackToDeck(id, track);
    },
    [emit, loadTrackToDeck],
  );

  // The audio master publishes the authoritative set so a joiner (or a device that
  // just became master) mirrors it. EVENT-DRIVEN ONLY — on peer-join (someone new to
  // catch up) or a loaded-track change. There is deliberately NO periodic heartbeat:
  // every live change already flows as an intent, and a 1s re-publish would re-trigger
  // an in-flight track load (aborting its decode) and fight live local controls.
  // Signature of who's actually JOINED — changes only when a device joins/leaves, NOT
  // when one flips its own mute/drive. Republishing on every presence tick (incl. a mute
  // toggle) is what let a stale snapshot stomp a live mix (bug #1b).
  const joinedSig = room.peers
    .filter((p) => p.joined)
    .map((p) => p.id)
    .sort()
    .join(",");
  useEffect(() => {
    if (room.isAnchor && room.status === "online") room.publishState(buildSnapshot());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.isAnchor, room.status, joinedSig, loaded, room.publishState, buildSnapshot]);

  // The MOMENT we join an existing session (and we're not the clock), pull the current
  // set so decks/waveforms/transport snap into place immediately. followRef is already
  // true here, so the snapshot applies. Covers joining late + invited guests.
  useEffect(() => {
    if (room.enabled && !room.isAnchor && room.status === "online") room.requestState();
  }, [room.enabled, room.isAnchor, room.status, room.requestState]);

  // The anchor streams its real playhead (~12 Hz) so every participant's waveforms +
  // own audio stream stay locked to one reference clock (even with shared control).
  useEffect(() => {
    if (!(room.isAnchor && room.status === "online")) return;
    const iv = setInterval(() => {
      room.sendTick({
        A: { pos: engine.deckA.position(), playing: engine.deckA.playing },
        B: { pos: engine.deckB.position(), playing: engine.deckB.playing },
      });
    }, 80);
    return () => clearInterval(iv);
  }, [engine, room.isAnchor, room.status, room.sendTick]);

  // INVERTED audio: every joined participant renders its OWN stream (decode + sync run
  // on all of them), so a session is a listening party — not one speaker. We mute ONLY
  // when this device turned its own audio off. Solo (not in a session) → full output.
  useEffect(() => {
    const silent = room.enabled && room.status === "online" && !room.listening;
    engine.setMaster(silent ? 0 : 1);
    if (!silent) {
      try {
        engine.resume();
      } catch {
        /* audio context may need a direct gesture on mobile — non-fatal */
      }
    }
  }, [engine, room.enabled, room.status, room.listening]);

  // Leaving a session must not BLAST the session's last track: when joined falls true→
  // false the mute lifts (setMaster→1), so pause both decks on that edge and let the
  // user hit play on their own solo board (bug #6).
  const wasEnabledRef = useRef(false);
  useEffect(() => {
    const was = wasEnabledRef.current;
    wasEnabledRef.current = room.enabled;
    // Only a genuine leave drops `enabled` while still ONLINE; a reconnect blip drops the
    // status too (and self-heals on the next tick) so we skip it.
    if (was && !room.enabled && room.status === "online") {
      engine.deckA.pause();
      engine.deckB.pause();
      refresh();
    }
  }, [room.enabled, room.status, engine, refresh]);

  // Anonymous first run: nothing saved + empty collection → drop 2 random
  // community tracks onto the decks so a new user lands on something playable.
  const didSeed = useRef(false);
  useEffect(() => {
    if (didSeed.current) return;
    didSeed.current = true;
    const snap = loadSession();
    if (snap?.decks.A.videoId || snap?.decks.B.videoId || library.collection.length > 0) return;
    fetchCommunity(120)
      .then(async (tracks) => {
        if (tracks.length === 0) return;
        const pick = [...tracks].sort(() => Math.random() - 0.5).slice(0, 2);
        // Serialize the two loads — running both decodes concurrently can race on the
        // shared fetch/decode pipeline and drop one deck.
        if (pick[0]) await loadTrackToDeck("A", pick[0]);
        if (pick[1]) await loadTrackToDeck("B", pick[1]);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const t = window.setInterval(() => persistSession(), 2000);
    const onHide = () => persistSession(true); // tab hiding/closing — write synchronously now
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [persistSession]);

  return (
    <div className={`app ${dockSwapped ? "dock-swapped" : ""}`}>
      {/* Top chin: the three panel launchers, reserving their own row at the top
          so they never overlap the board. */}
      <nav className="chin">
        <button className={`chin-btn chin-library ${libOpen ? "active" : ""}`} onClick={() => setLibOpen((v) => !v)} aria-label="Library">
          <span className="chin-label">Library</span>
        </button>
        <button className={`chin-btn chin-search ${searchOpen ? "active" : ""}`} onClick={() => setSearchOpen((v) => !v)} aria-label="Search">
          <span className="chin-label">Search</span>
        </button>
        {/* Swap which side the docks (and these two launchers) sit on. Desktop only. */}
        <button
          className="chin-btn chin-swap"
          onClick={() => setDockSwapped((v) => !v)}
          aria-label="Swap panel sides"
          title="Swap panel sides"
        >
          <span className="chin-swap-i" aria-hidden="true">⇄</span>
        </button>
        <button
          className={`chin-btn chin-settings ${settingsOpen ? "active" : ""}`}
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          title="Settings"
        >
          <span className="chin-gear" aria-hidden="true">⚙</span>
          <span className="chin-label">Settings</span>
        </button>
        <RoomBar room={room} onActivate={() => engine.resume()} />
      </nav>

      {/* Workspace: on desktop a flex ROW so the Library/Search docks SHARE the
          width with the board (push it, don't overlay). On mobile a column with the
          docks as centered modals. */}
      <div className="workspace">
      <main className="stage">
        {/* Locked out (joined but not driving): the deck stays fully visible, we just
            swallow pointer input. The "listening" marker lives in the session menu. */}
        {room.enabled && !room.controlling && (
          <div className="stage-lock" aria-hidden="true" title="Listening — controls are with the host (open the session menu to take control)" />
        )}
        <div className="lanes">
          {(["A", "B"] as DeckId[]).map((id) => (
            <DeckLane
              key={id}
              id={id}
              deck={engine.deck(id)}
              accent={ACCENT[id]}
              focused={focused === id}
              onFocus={() => setFocused(id)}
              background={surfaceColor(settings.bgColor)}
              selectorColor={settings.selectorColor}
              loopColor={settings.loopColor}
              markerColor={settings.markerColor}
              stripColor={settings.stripColor}
              meta={meta[id]}
              status={terseStem(status[id])}
              captions={captions[id]}
              windowSec={zoom[id]}
              onZoom={(next) => setZoomFor(id, next)}
              refresh={refresh}
              onLoadFile={(f) => onLoadFile(id, f)}
              onJogStart={() => onJogStart(id)}
              onJog={(delta) => emitJog(id, delta)}
              onJogEnd={() => onJogEnd(id)}
              onSeek={(pos) => emitSeekTo(id, pos)}
            />
          ))}
        </div>

        {/* Middle third: the two decks' button banks side by side. */}
        <div className="decks-row">
          <DeckControls
            id="A"
            deck={engine.deckA}
            accent={ACCENT.A}
            focused={focused === "A"}
            onFocus={() => setFocused("A")}
            mirror={false}
            shift={shift}
            tempoRange={settings.tempoRange}
            pitchRange={settings.pitchRange}
            onCycleTempoRange={cycleTempoRange}
            onCyclePitchRange={cyclePitchRange}
            onToggleShift={() => setShiftLatched((v) => !v)}
            onSync={() => { engine.sync("A"); refresh(); }}
            onKey={() => { engine.matchKey("A"); refresh(); }}
            refresh={refresh}
            emit={emit}
            emitControls={emitDeckControls}
          />
          <DeckControls
            id="B"
            deck={engine.deckB}
            accent={ACCENT.B}
            focused={focused === "B"}
            onFocus={() => setFocused("B")}
            mirror={false}
            shift={shift}
            tempoRange={settings.tempoRange}
            pitchRange={settings.pitchRange}
            onCycleTempoRange={cycleTempoRange}
            onCyclePitchRange={cyclePitchRange}
            onToggleShift={() => setShiftLatched((v) => !v)}
            onSync={() => { engine.sync("B"); refresh(); }}
            onKey={() => { engine.matchKey("B"); refresh(); }}
            refresh={refresh}
            emit={emit}
            emitControls={emitDeckControls}
          />
        </div>

        {/* Bottom third: the two channel mixers with the A↔B crossfader standing
            vertically between them. */}
        <div className="mix-row">
          <div className="mixer-box">
            <div className="channels">
              <ChannelStrip
                id="A"
                deck={engine.deckA}
                accent={ACCENT.A}
                onFocus={() => setFocused("A")}
                refresh={refresh}
                emit={emit}
              />
              <MixCenter
                deckA={engine.deckA}
                deckB={engine.deckB}
                accentA={ACCENT.A}
                accentB={ACCENT.B}
                levelA={engine.deckA.level}
                levelB={engine.deckB.level}
                crossfade={crossfade}
                onLevelA={(v) => { engine.deckA.setLevel(v); refresh(); emit({ kind: "control", deck: "A", param: "level", value: v }); }}
                onLevelB={(v) => { engine.deckB.setLevel(v); refresh(); emit({ kind: "control", deck: "B", param: "level", value: v }); }}
                onCrossfade={(v) => { setCrossfade(v); engine.setCrossfade(v); if (room.controlling) room.sendIntent({ kind: "crossfade", value: v }); }}
              />
              <ChannelStrip
                id="B"
                deck={engine.deckB}
                accent={ACCENT.B}
                mirror
                onFocus={() => setFocused("B")}
                refresh={refresh}
                emit={emit}
              />
            </div>
          </div>
        </div>
      </main>

      <LibraryPanel
        library={library}
        onLoad={loadAndShare}
        loadedIds={loadedIds}
        open={libOpen}
        onOpenChange={setLibOpen}
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
      />

      </div>

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
          loadedVideoIds={Array.from(loadedIds)}
          stemStatus={status}
          onReanalyze={reanalyze}
          onGpuReenable={() => {
            setGpuCrashed(false);
            refresh();
          }}
        />
      )}

    </div>
  );
}
