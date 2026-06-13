import { useCallback, useEffect, useRef, useState } from "react";
import { DeckLane, type DeckMeta } from "./components/DeckLane";
import { DeckControls } from "./components/DeckControls";
import { Crossfader, crossfadeGainsDb } from "./components/Crossfader";
import { LibraryPanel } from "./components/LibraryPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { RoomBar } from "./components/RoomBar";
import { ProfileScreen } from "./components/ProfileScreen";
import { SocialScreen } from "./components/SocialScreen";
import { type Me, fetchMe, logPlay } from "@htl/account";
import { useRoom, type Intent, type TickDecks, type DeckTick } from "@htl/room";
import { useMidi, type MidiEvent, type DeckFeedback } from "@htl/midi";
import {
  AudioEngine,
  type Deck,
  type StemView,
  EQ_MIN_DB,
  EQ_MAX_DB,
  analyzeTrackAsync,
  decodeAudio,
  getCachedTrack,
  setCachedTrack,
  useLibrary,
  type TrackMeta,
  fetchYouTubeAudio,
  fileToArrayBuffer,
  resolvePlayable,
  fetchCommunity,
  postAnalysis,
  applySettings,
  surfaceColor,
  FREQ_LOW_DEFAULT,
  FREQ_MID_DEFAULT,
  FREQ_HIGH_DEFAULT,
  stretchConfig,
  stemConfig,
  setDemucsQuality,
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
  getStemModel,
  modelSupport,
  deviceSupportsModel,
  isMobileDevice,
  isIOSDevice,
  isChromium,
  fetchStemManifest,
  initGpuCrashGuard,
  armGpu,
  disarmGpu,
  initStemCrashGuard,
  stemTrace,
  DEFAULT_STEM_MODEL,
  type Stems,
  type StemModel,
} from "@htl";
import { resolveLyrics, cacheRemoteLyrics, type LyricsSource, type LyricsLine } from "@htl/lyrics";

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

// One labelled group of live diagnostics for the Settings → Debug tab (audio engine,
// shared session, device, per-deck). Polled by the panel while that tab is open.
export interface DebugSection {
  title: string;
  rows: [string, string][];
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
    eqLowFreq: deck.eqLowFreq,
    eqMidFreq: deck.eqMidFreq,
    eqHighFreq: deck.eqHighFreq,
    eqMidQ: deck.eqMidQ,
    eqHpFreq: deck.eqHpFreq,
    eqHpQ: deck.eqHpQ,
    eqLpFreq: deck.eqLpFreq,
    eqLpQ: deck.eqLpQ,
    eqBypass: deck.eqBypassed,
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
    // So a stem-less remote (mobile) lights up its mixer cells for this deck. Don't
    // advertise REMOTE-only stems back out — only this device's OWN stems count.
    hasStems: deck.hasStems && !deck.remoteStems,
    stemsNeural: deck.stemsNeural && !deck.remoteStems,
  };
}

// Stem names in the fixed deck order — for snapshot apply.
const STEM_KEYS = ["drums", "bass", "vocals", "other"] as const;
// The 8 beat-loop sizes, ascending — pad/key index → beats (shared by the keyboard
// handlers and the MIDI pad dispatch so a loop pad can match the active loop's size).
const LOOP_BEATS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8];

// Apply per-stem mixer state from a snapshot. The deck stores gain/mute even
// before its stems exist, so it takes effect the moment separation finishes.
function applyDeckStems(deck: Deck, s: DeckSnapshot) {
  // A stem-less remote (mobile) marks the SOURCE device's stems present so its mixer
  // cells light up and drive them — without holding any local buffers (mix-only
  // audio). Desktops separate locally, so they never take the remote path.
  if (isMobileDevice()) deck.markRemoteStems(!!s.hasStems, !!s.stemsNeural);
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
  if (s.eqLowFreq != null) deck.setEqLowFreq(s.eqLowFreq);
  if (s.eqMidFreq != null) deck.setEqMidFreq(s.eqMidFreq);
  if (s.eqHighFreq != null) deck.setEqHighFreq(s.eqHighFreq);
  if (s.eqMidQ != null) deck.setEqMidQ(s.eqMidQ);
  // Filter drives the EQ HP/LP nodes, so apply it BEFORE the explicit HP/LP positions
  // — otherwise a centred filter would reset manually-dragged cut handles.
  deck.setFilter(s.filter ?? 0);
  deck.setFx(s.fxOn ?? true);
  if (s.eqHpFreq != null) deck.setEqHpFreq(s.eqHpFreq);
  if (s.eqHpQ != null) deck.setEqHpQ(s.eqHpQ);
  if (s.eqLpFreq != null) deck.setEqLpFreq(s.eqLpFreq);
  if (s.eqLpQ != null) deck.setEqLpQ(s.eqLpQ);
  deck.setEqBypass(!!s.eqBypass);
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
  // SYNC toggle: engage/flip/release the master-slave lock. On ENGAGE (this deck
  // became the slave) also match its zoom to the master's — with tempos locked and
  // both centered playheads phase-aligned, a shared pixel-scale overlays the two
  // grids on screen, not just in the audio.
  const doSync = useCallback(
    (id: DeckId) => {
      engine.toggleSync(id);
      if (engine.syncRole(id) === "slave") {
        const other: DeckId = id === "A" ? "B" : "A";
        setZoom((z) => ({ ...z, [id]: z[other] }));
      }
    },
    [engine],
  );
  const [loaded, setLoaded] = useState<Record<DeckId, string | null>>({ A: null, B: null });
  const [captions, setCaptions] = useState<Record<DeckId, LyricsLine[]>>({ A: [], B: [] });
  // Where each deck's ribbon text came from — Whisper (vocal stem) / pool / YouTube — for the
  // little source tag on the caption bar. null = none shown yet.
  const [captionSource, setCaptionSource] = useState<Record<DeckId, LyricsSource | null>>({ A: null, B: null });
  // Lyric processing/failure tell per deck (model download %, "Transcribing…", "unavailable").
  const [lyricStatus, setLyricStatus] = useState<Record<DeckId, string | null>>({ A: null, B: null });
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [socialOpen, setSocialOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [kickedNotice, setKickedNotice] = useState<string | null>(null);
  // Read in loadTrackToDeck (defined above the room hook) to gate play-logging on sign-in.
  const signedInRef = useRef(false);
  signedInRef.current = !!me?.user;
  // Refresh account state on mount + whenever the Profile screen closes (a sign-in/out
  // there changes connections, which the Sync screen + chin gating read).
  useEffect(() => {
    fetchMe().then(setMe).catch(() => {});
  }, [profileOpen]);
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
    // Mobile best-stems crash guard: if a prior auto-enhance took the tab down, the
    // next loads stay on the safe DSP split instead of crash-looping (see deriveStems).
    initStemCrashGuard();
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
  // Chin launchers. On desktop the two docks share the row so both can be open at
  // once; on a NARROW screen they're stacked full-screen modals, so opening one must
  // close the other (else both show "active" and overlap — the mobile bug).
  const toggleLib = () => {
    const next = !libOpen;
    setLibOpen(next);
    if (next && window.matchMedia("(max-width: 768px)").matches) setSearchOpen(false);
  };
  const toggleSearch = () => {
    const next = !searchOpen;
    setSearchOpen(next);
    if (next && window.matchMedia("(max-width: 768px)").matches) setLibOpen(false);
  };
  const [dockSwapped, setDockSwapped] = useState(false); // desktop: swap which side each dock sits on
  const [shiftLatched, setShiftLatched] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  // A controller SHIFT button is held, per deck (the FLX4 has one SHIFT per side).
  const [midiShift, setMidiShift] = useState<Record<DeckId, boolean>>({ A: false, B: false });
  // A deckless / focus-model SHIFT (the Starrypad's latching RECORD toggle): it isn't tied
  // to a side, so it applies to whatever deck is FOCUSED — and FOLLOWS focus while it's on.
  const [focusShift, setFocusShift] = useState(false);
  // Which deck the keyboard drives (Tab toggles it; the focused deck is ringed).
  const [focused, setFocused] = useState<DeckId>("A");
  // Keyboard/on-screen shift is a property of the FOCUSED deck — never both. A deck's
  // shift is on when the keyboard Shift / latch (or a focus-model latch) is active AND
  // it's focused, OR that deck's own controller SHIFT button is held.
  const bankShift = (id: DeckId) => midiShift[id] || ((shiftLatched || shiftHeld || focusShift) && focused === id);
  const shift = bankShift(focused); // shift for whatever the keyboard is driving
  const [expandedLane, setExpandedLane] = useState<DeckId | null>(null); // single-deck (maximized) view
  const ACCENT: Record<DeckId, string> = { A: settings.accentA, B: settings.accentB };
  // Post-crossfade attenuation per deck, so the bottom level-fader meters fade with the crossfader.
  const levelGainsDb = crossfadeGainsDb(crossfade);

  // Shared-session intent emitters, reached through refs so the keyboard handler
  // (set up before the room wiring below) can broadcast its actions too. Assigned
  // each render once `emit` / `emitDeckControls` exist.
  const emitRef = useRef<(intent: Intent) => void>(() => {});
  const emitDeckRef = useRef<(id: DeckId) => void>(() => {});
  // A remote's "make these stems" request, routed to the host handler (assigned once the
  // room + separation wiring exist below). Lets onRoomIntent call it without an ordering cycle.
  const stemReqRef = useRef<(id: DeckId, model: string) => void>(() => {});
  // Per-deck timers that revert a remote's "Requesting…" chip if the host never delivers
  // (e.g. the host can't separate that model) — cleared when its stem view arrives.
  const stemReqTimers = useRef<Partial<Record<DeckId, ReturnType<typeof setTimeout>>>>({});
  // Host-side: the (videoId:model) currently being separated for a remote request, so
  // duplicate requests don't kick off concurrent separations on the host.
  const reqSepGuard = useRef<Partial<Record<DeckId, string>>>({});
  // Reliable stem-state sync over the session: the anchor piggybacks per-deck stem
  // mute/gain on its tick when it changes (+ a ~1 Hz heartbeat); followers apply it,
  // skipping any stem they themselves just touched (local-echo suppression).
  const tickN = useRef(0);
  const lastStemKey = useRef<Record<DeckId, string>>({ A: "", B: "" });
  const stemTouch = useRef<Record<DeckId, Record<string, number>>>({ A: {}, B: {} });
  // The keyboard action table (built inside the keydown effect) is mirrored here so
  // the MIDI engine can fire the exact same button behaviours (see onMidiEvent).
  const handlersRef = useRef<Record<string, (deck: Deck, id: DeckId, s: boolean) => void>>({});
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
  // deferDecodeRef: a MUTED passenger (joined, not listening, not driving, not the clock)
  // renders no audio — so it must NOT decode the session's tracks. Decoding two tracks
  // into AudioBuffers is what OOM-crashed iOS Safari when a desktop started a session
  // (bug #2). We stash the target tracks instead and decode them only once the user turns
  // 🔊 on (or otherwise needs audio: gains control / becomes the anchor).
  const deferDecodeRef = useRef(false);
  const pendingRoomLoad = useRef<Record<DeckId, { videoId: string; track: TrackMeta; restore?: DeckSnapshot } | null>>({ A: null, B: null });
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
  // Graceful follower sync: when we last did a follow-driven seek (so the steady-state drift
  // corrector doesn't fire back-to-back and "skip/repeat"), and when we last saw a tick per
  // deck (so the post-decode fallback doesn't start from the now-stale snapshot position when
  // a tick is about to seek to the live one).
  const followSeekAt = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  const lastTickAt = useRef<Record<DeckId, number>>({ A: 0, B: 0 });

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
      deck.resetEq(); // gains → 0 dB and every band node back to its default frequency
      deck.setPitch(0);
      deck.setLevel(1); // channel fader back to unity — match the on-screen RESET button
      deck.resetStems(); // also reset the stem faders (→ unity) and un-mute all stems
    };

    // Per-action behaviour, keyed by action id (see @htl keybinds). Each runs on the
    // FOCUSED deck; `s` is the live Shift modifier (held key or on-screen latch) that
    // selects the shifted variant. Mirrors the on-screen buttons + emits to co-DJs.
    type DeckRef = ReturnType<typeof engine.deck>;
    const TEMPO_NUDGE = 0.5;
    // Beat-loop trigger (index = key order U I O P H J K L). Re-triggering the ACTIVE
    // size exits the loop; a different size resizes it (setBeatLoop keeps the start);
    // otherwise set. One toggle shared by keyboard, MIDI pads, and on-screen buttons.
    const beatLoop = (deck: DeckRef, id: DeckId, i: number) => {
      const beats = LOOP_BEATS[i];
      if (deck.loop?.active && deck.loop.beats === beats) {
        deck.exitLoop();
        emitRef.current({ kind: "loop", deck: id, action: "exit" });
      } else {
        deck.setBeatLoop(beats);
        emitRef.current({ kind: "loop", deck: id, action: "beat", beats });
      }
    };
    const jogBy = (deck: DeckRef, id: DeckId, s: boolean, beats: number) => {
      if (deck.adjusting) {
        // Boundary-adjust mode: arrows step the loop edge; lock follows the grid
        // magnet (snap to beats when on, fine sub-beat nudge when off).
        deck.adjustStep(beats);
        return;
      }
      if (s) deck.moveLoop(beats);
      else {
        deck.beatJump(beats);
        emitRef.current({ kind: "transport", deck: id, action: "seek", position: deck.position() });
      }
    };
    const STEMS = ["drums", "bass", "vocals", "other"] as const;
    const stem = (deck: DeckRef, id: DeckId, name: (typeof STEMS)[number], s: boolean) => {
      if (!deck.hasStems) return;
      if (s) {
        deck.soloStem(name); // Shift: solo this stem (mute the rest); same key un-solos
        STEMS.forEach((n) => emitRef.current({ kind: "stem", deck: id, stem: n, on: deck.stemActive(n) }));
      } else {
        deck.toggleStem(name);
        emitRef.current({ kind: "stem", deck: id, stem: name, on: deck.stemActive(name) });
      }
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
          resetChannel(deck); // Shift+Space = reset the channel (tempo/pitch/EQ/filter/level/stems)
          emitDeckRef.current(id);
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
          doSync(id);
          emitDeckRef.current(id);
          emitRef.current({ kind: "sync", slave: engine.syncSlave }); // mirror the button on peers
        }
      },
      keyMatch: (deck, id, s) => {
        if (s) return; // KEY is a toggle — no shift action (channel reset is on Shift+Space)
        engine.toggleKey(id);
        emitRef.current({ kind: "control", deck: id, param: "pitch", value: deck.pitch });
        emitRef.current({ kind: "key", slave: engine.keySlave }); // mirror the button on peers
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
      pitchRange: (_deck, _id, s) => {
        if (!s) cyclePitchRange();
      },
      grid: (deck, id, s) => {
        if (s) {
          deck.skipBeats = nextSkip(deck.skipBeats);
          emitRef.current({ kind: "skip", deck: id, beats: deck.skipBeats });
        } else {
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
      loopIn: (deck, id, s) => {
        // Shift arms fine-adjust; a plain tap while already armed disarms it (so you
        // don't have to re-hold Shift to release the lock).
        if (s || deck.adjusting === "in") return void deck.toggleAdjust("in");
        deck.loopIn();
        emitRef.current({ kind: "loop", deck: id, action: "in" });
      },
      loopOut: (deck, id, s) => {
        if (s || deck.adjusting === "out") return void deck.toggleAdjust("out");
        deck.loopOut();
        emitRef.current({ kind: "loop", deck: id, action: "out" });
      },
      loopExit: (deck, id, s) => {
        if (s) {
          deck.clearLoop(); // Shift: wipe the loop outright
          emitRef.current({ kind: "loop", deck: id, action: "exit" });
        } else if (deck.loop?.active) {
          deck.exitLoop();
          emitRef.current({ kind: "loop", deck: id, action: "exit" });
        } else {
          deck.reloop();
          emitRef.current({ kind: "loop", deck: id, action: "reloop" });
        }
      },
      beatLoop0: (deck, id) => beatLoop(deck, id, 0),
      beatLoop1: (deck, id) => beatLoop(deck, id, 1),
      beatLoop2: (deck, id) => beatLoop(deck, id, 2),
      beatLoop3: (deck, id) => beatLoop(deck, id, 3),
      beatLoop4: (deck, id) => beatLoop(deck, id, 4),
      beatLoop5: (deck, id) => beatLoop(deck, id, 5),
      beatLoop6: (deck, id) => beatLoop(deck, id, 6),
      beatLoop7: (deck, id) => beatLoop(deck, id, 7),
      muteDrums: (deck, id, s) => stem(deck, id, "drums", s),
      muteBass: (deck, id, s) => stem(deck, id, "bass", s),
      muteVocals: (deck, id, s) => stem(deck, id, "vocals", s),
      muteInst: (deck, id, s) => stem(deck, id, "other", s),
      jogBackBeat: (deck, id, s) => jogBy(deck, id, s, -1),
      jogFwdBeat: (deck, id, s) => jogBy(deck, id, s, 1),
      jogBack: (deck, id, s) => jogBy(deck, id, s, -deck.skipBeats),
      jogFwd: (deck, id, s) => jogBy(deck, id, s, deck.skipBeats),
      phraseBack: (deck, id) => {
        deck.phraseJump(-1);
        emitRef.current({ kind: "transport", deck: id, action: "seek", position: deck.position() });
      },
      phraseFwd: (deck, id) => {
        deck.phraseJump(1);
        emitRef.current({ kind: "transport", deck: id, action: "seek", position: deck.position() });
      },
    };
    for (let i = 0; i < 8; i++) HANDLERS[`hotcue${i + 1}`] = (deck, id, s) => hotcue(deck, id, s, i);
    handlersRef.current = HANDLERS; // expose to the MIDI dispatcher (same button behaviours)
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
  }, [engine, doSync, shift, focused, matchGain, cycleTempoRange, cyclePitchRange, refresh, settingsOpen, searchOpen, libOpen, settings.keyBindings]);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
    engine.deckA.setJogPhysics(settings.jogWeight, settings.jogDrag);
    engine.deckB.setJogPhysics(settings.jogWeight, settings.jogDrag);
    engine.setStretchConfig(stretchConfig(settings.stretchQuality));
    setDemucsQuality(stemConfig(settings.stemQuality)); // desktop demucs-GPU quality knobs
  }, [settings, engine]);

  // Route the mix to the chosen output device (only re-applies when it changes, so a
  // theme tweak never re-routes audio). "" = system default.
  useEffect(() => {
    void engine.setSinkId(settings.audioOutputId);
  }, [engine, settings.audioOutputId]);

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

  // In a session as a CONTROLLING remote (not the audio host/anchor) that can't make
  // these stems locally, ask the host to separate them and stream the 4-lane view back.
  // Returns true when it delegated to the host (so the caller skips its local dead-end).
  const requestStemsFromHost = useCallback(
    (id: DeckId, model: StemModel): boolean => {
      const r = roomRef.current;
      if (!r || r.status !== "online" || !r.controlling || r.isAnchor || model.kind === "dsp") return false;
      emitRef.current({ kind: "reqStems", deck: id, model: model.id });
      setStatusFor(id, { phase: "downloading", detail: `Requesting ${model.label} stems from the session host…` });
      // Don't spin forever if the host can't make them — revert with a clear message after
      // a grace period. Cleared the moment the host's stem view lands (onRoomStemView).
      if (stemReqTimers.current[id]) clearTimeout(stemReqTimers.current[id]);
      stemReqTimers.current[id] = setTimeout(() => {
        setStatusFor(id, { phase: "unavailable", detail: "The session host can't make stems for this track." });
        setTimeout(() => setStatusFor(id, null), 6000);
      }, 20000);
      return true;
    },
    [setStatusFor],
  );

  // The selected stem model, via a ref so the load callbacks read it fresh without
  // re-creating (and so model changes don't churn the load path).
  const stemModelRef = useRef(settings.stemModel);
  stemModelRef.current = settings.stemModel;
  // Auto-enhance (desktop): read fresh in the load callbacks without re-creating them.
  const autoEnhanceRef = useRef(settings.autoEnhance);
  autoEnhanceRef.current = settings.autoEnhance;
  // Lyrics settings, read inside the load callback (which isn't re-created per keystroke).
  const lyricsAutoRef = useRef(settings.lyricsAuto);
  lyricsAutoRef.current = settings.lyricsAuto;
  const lyricsModelRef = useRef(settings.lyricsModel);
  lyricsModelRef.current = settings.lyricsModel;
  // Idempotency guard so deriveStems can't loop: the last (videoId:model) actually
  // derived per deck. A repeat call with the SAME pairing is a no-op — this is what
  // stops the "DSP ↔ enhance" cycle (whatever re-fires the effect, the work runs once).
  // Cleared on a fresh track load so reloading the same track still re-derives.
  const deriveGuard = useRef<Record<DeckId, string>>({ A: "", B: "" });
  // What neural stems are ACTUALLY on each deck now (`${videoId}:${modelId}`). deriveGuard is
  // cleared by the model/auto-enhance effect to force a re-derive, but a re-derive must NOT
  // re-separate stems the deck already holds — that's the "runs demucs again on an already-
  // processed track" bug (the local IndexedDB persist lags the separation by the encode time,
  // so loadStemsLocal misses in that window). This tracks the real state and short-circuits.
  const stemLoadedKey = useRef<Record<DeckId, string>>({ A: "", B: "" });

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
          engine.deck(id).setStems(local, true); // neural → per-stem lanes
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
          engine.deck(id).setStems(neural, true); // neural → per-stem lanes
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
      // Idempotency: skip a repeat derive of the exact same (track, model) on this deck.
      // deriveStems is re-fired by several effects; without this, a desktop load could
      // cycle promote → setStems → promote… A fresh track load clears the guard (see
      // loadTrackToDeck), and a model switch changes the key, so both still re-derive.
      const guardKey = `${videoId}:${model.id}`;
      if (deriveGuard.current[id] === guardKey) return;
      deriveGuard.current[id] = guardKey;

      // "Single" — the plain mix, no stem mixer. This is the no-stems path (the old DSP
      // band/centre split was dropped: it's a poor approximation, so it's single OR neural).
      // On DESKTOP, if auto-enhance is on and a neural set already exists for this track (on
      // disk or pooled in R2), silently promote it — a free quality win with no separation.
      // Otherwise the deck just plays the mix (lightest path, no 424 MB stem set held).
      if (model.id === "off") {
        if (!isMobileDevice() && autoEnhanceRef.current) {
          await whenIdle();
          if (stale?.()) return;
          const enhanced = await promoteCachedStems(id, videoId, mix, stale);
          if (stale?.()) return;
          if (enhanced) return; // cached neural applied
        }
        engine.deck(id).setStems(null);
        refresh();
        setStatusFor(id, null);
        return;
      }

      // Let the deck's UI render first — the stem split is background work.
      await whenIdle();
      if (stale?.()) return;

      // MEMORY DISCIPLINE (the iPhone crash fix). A stem SET = 4 full-length stereo
      // float32 buffers (~424 MB for a 5-min track). iOS Safari's ~1–1.5 GB per-tab
      // budget holds ONE set but not TWO — holding the OLD set AND a new neural set at
      // once is what jetsam-killed the tab. So on MOBILE we drop the current set before
      // building a new one: decode/separate exactly one set at a time.
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

      // MOBILE = PLAIN MIX ONLY. Decoding a ~424 MB stem set (neural OR DSP) for two
      // decks at once OOM-crash-loops iOS, so phones never build stems locally. Stems
      // appear only when this device is a REMOTE controller for a host that has them:
      // the session marks them present (markRemoteStems) and streams the host's stem
      // envelopes for the display. Local audio is always the plain mix → no OOM.
      if (mobile) {
        engine.deck(id).setStems(null);
        refresh();
        // Phones never separate locally. For a neural model: if we're a controlling remote,
        // ask the host to make + stream them; otherwise say so plainly instead of silently
        // leaving the user with no stems (dead end). ("Single" already returned above.)
        if (!requestStemsFromHost(id, model)) {
          setStatusFor(id, {
            phase: "unavailable",
            detail: "Stems need a desktop — open htl on a computer, or join a session hosted by one.",
          });
        }
        return;
      }

      // Refresh-fast path: if THIS track's neural stems are already persisted in IndexedDB
      // (from a previous separation/download), decode them straight from disk and apply —
      // NO R2 re-download, NO re-separation. This is what stops a page refresh from redoing
      // the work. (Every selectable model here is neural — "single" returned above.)
      // Already separated + still on this deck (e.g. the model/auto-enhance effect cleared the
      // guard, or the local persist hasn't landed yet) → DON'T re-separate; it's already here.
      if (engine.deck(id).hasStems && stemLoadedKey.current[id] === guardKey) {
        setStatusFor(id, null);
        return;
      }

      // Refresh-fast path: if THIS track's neural stems are already persisted in IndexedDB
      // (from a previous separation/download), decode them straight from disk and apply —
      // NO R2 re-download, NO re-separation. This is what stops a page refresh from redoing
      // the work. (Every selectable model here is neural — "single" returned above.)
      {
        const local = await loadStemsLocal(engine.ctx, videoId, model.id);
        if (local) {
          if (stale?.()) return;
          engine.deck(id).setStems(local, true); // neural → per-stem lanes
          stemLoadedKey.current[id] = guardKey;
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

      const key = `${videoId}:${model.id}`;
      const support = modelSupport(model); // "runs" here | "desktop" | "needs-gpu"

      // Is this model's result already shared in R2? If so, ANY device — phone
      // included — can DOWNLOAD it, even when it can't separate locally.
      const manifest = await fetchStemManifest(videoId, model.id).catch(() => null);
      if (stale?.()) return;
      const cached = !!manifest?.complete;

      // Can't separate here and nobody has yet → stay on the plain mix and say exactly why,
      // instead of a silent fallback or a "Separating…" that never finishes.
      // (Light int8 models already report support==="runs" on phones, so phones DO
      // contribute those; heavy fp32 / GPU stay desktop-gated — forcing them on mobile
      // OOM-kills the tab.)
      if (!cached && support !== "runs") {
        engine.deck(id).setStems(null); // no stems → plain mix
        // In a session, a controlling remote that can't make these (no GPU, etc.) asks the
        // host to separate + stream them instead of a dead end.
        if (requestStemsFromHost(id, model)) return;
        const detail =
          support === "blocked"
            ? `${model.label}: GPU separation was disabled after a crash. Re-enable it in Settings ▸ Stems, or pick a CPU model. Playing the mix.`
            : `${model.label}: separate on ${support === "needs-gpu" ? "a GPU desktop" : "a desktop"} first — playing the mix for now.`;
        setStatusFor(id, { phase: "unavailable", detail });
        setTimeout(() => !stale?.() && setStatusFor(id, null), 6000);
        return;
      }

      // The deck stays on the single mix waveform while the neural set downloads/separates
      // (the "stems incoming" overlay communicates it); the per-stem lanes swap in when the
      // set is ready. No throwaway split is shown first — single OR neural, nothing between.

      // cached → DOWNLOAD the shared stems (any device); else → SEPARATE on-device.
      const phase: StemPhase = cached ? "downloading" : "separating";
      const verb = cached ? "Downloading" : "Separating with";
      // Actual on-device GPU work (not a cached download) can HARD-crash the tab —
      // arm the crash guard so a reload doesn't re-attempt and loop. Disarmed in
      // `finally` (success or caught error both mean the tab survived).
      // Any on-device GPU separation (legacy Burn "demucs" OR the ORT-WebGPU
      // "demucs-core") can hard-crash the tab — on iPhone Safari especially (the
      // ORT JSEP WebGPU memory leak). Guard the whole gpu tier so a crash can't loop.
      // GPU work can hard-crash the tab — but ONLY the Chromium WebGPU path runs on the
      // GPU; Safari/Firefox separate this same model on the stable wasm EP (no GPU, no
      // crash class), so the GPU crash guard must not arm there or it would falsely
      // block them after an interrupted (merely slow) wasm run.
      const gpuSeparate = !cached && model.tier === "gpu" && isChromium();
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
        engine.deck(id).setStems(neural, true); // neural → per-stem lanes
        stemLoadedKey.current[id] = guardKey; // remember it's loaded → never re-separate it
        refresh();
        // Persistent active-stems chip (clears on next track load).
        setStatusFor(id, { phase: "ready", src: stemSrcLabel(model.id), detail: `${model.label} ready.` });
      } catch (e) {
        console.warn("[htl] neural stems failed:", e);
        // The neural attempt is over (its memory freed) → fall back to the plain mix.
        engine.deck(id).setStems(null);
        setStatusFor(id, { phase: "failed", detail: `${model.label} failed — playing the mix. See console for details.` });
        setTimeout(() => !stale?.() && setStatusFor(id, null), 6000);
      } finally {
        if (gpuSeparate) disarmGpu();
      }
    },
    [engine, refresh, setStatusFor, promoteCachedStems, requestStemsFromHost],
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
      syncSlave: engine.syncSlave,
      keySlave: engine.keySlave,
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
      deriveGuard.current[id] = ""; // new load → allow a fresh derive even for the same track
      stemLoadedKey.current[id] = ""; // new track → the old deck stems are gone
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
        // Lyrics, Whisper-first: community pool → on-device Whisper over the neural vocal
        // stem (desktop GPU, then contributed back) → YouTube captions as the fallback /
        // instant placeholder. The resolver polls the deck for neural vocals on its own, so
        // it's decoupled from the stem pipeline; it cancels via stale() on the next load.
        setCaptionSource((s) => ({ ...s, [id]: null }));
        setLyricStatus((s) => ({ ...s, [id]: null }));
        void resolveLyrics({
          videoId: vid,
          deck: engine.deck(id),
          model: lyricsModelRef.current === "small" ? "small" : "base",
          engine: lyricsModelRef.current === "youtube" ? "youtube" : "whisper",
          enabled: lyricsAutoRef.current,
          sampleRate: engine.ctx.sampleRate,
          stale,
          onCues: (cues, source) => {
            if (stale()) return;
            setCaptions((c) => ({ ...c, [id]: cues }));
            setCaptionSource((s) => ({ ...s, [id]: source }));
          },
          // The visible "tell" for lyric processing: model download %, transcribing, or a
          // transient failure pill on the deck's caption bar (so it's never silent).
          onStatus: (msg) => {
            if (!stale()) setLyricStatus((s) => ({ ...s, [id]: msg }));
          },
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
          const analysis = await analyzeTrackAsync(buffer);
          if (stale()) return;
          cached = { buffer, analysis };
          setCachedTrack(vid, cached);
        }
        if (stale()) return;
        engine.deck(id).setBuffer(cached.buffer, cached.analysis.beatgrid);
        engine.deck(id).key = cached.analysis.key;
        if (restore) applyDeckControls(engine.deck(id), restore);
        engine.reassertSync(id); // re-lock if this deck is in a sync pair
        engine.reassertKey(id);
        setLoaded((l) => ({ ...l, [id]: vid }));
        // Feed the profile's top-songs stats — genuine user/session loads only, never a
        // page-refresh restore (which would inflate counts on every reload).
        if (signedInRef.current && !restore) {
          logPlay({ videoId: vid, title: track.title, artist: track.artist, thumbnail: track.thumbnail });
        }
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
        const analysis = await analyzeTrackAsync(buffer);
        engine.deck(id).setBuffer(buffer, analysis.beatgrid);
        engine.deck(id).key = analysis.key;
        engine.reassertSync(id);
        engine.reassertKey(id);
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
        deriveGuard.current[id] = ""; // fresh file → allow a re-derive
        stemLoadedKey.current[id] = "";
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
      const gpuSeparate = model.tier === "gpu" && isChromium(); // GPU guard: Chromium-only path
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
      deriveGuard.current[id] = ""; // model or auto-enhance toggled → a deliberate re-derive
      void deriveStems(id, vid, deck.buffer, () => cancelled);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.stemModel, settings.autoEnhance]);

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
  // Mirror a deck's full state from a snapshot — the INITIAL alignment for a pure follower.
  // Deduped per videoId by the caller, so it runs once per (re)load, NOT on every republished
  // snapshot. Adopts CONTINUOUS controls too (tempo / pitch / levels / EQ / filter): a guest
  // must never keep a stale local tempo (e.g. +8%) that desyncs its own playback from the host
  // on join. Safe because applyRoomSnapshot only runs for non-driving followers, which have no
  // live drag of their own to fight; ongoing host changes still cross as intents. Playhead is
  // left to ticks/transport (no seek here — that would skip).
  const reconcileDeckState = useCallback(
    (id: DeckId, d: DeckSnapshot) => {
      const deck = engine.deck(id);
      deck.setTempo(d.tempo);
      deck.setTrim(d.trim);
      deck.setLevel(d.level);
      deck.setEqLow(d.eqLow);
      deck.setEqMid(d.eqMid);
      deck.setEqHigh(d.eqHigh);
      if (d.eqLowFreq != null) deck.setEqLowFreq(d.eqLowFreq);
      if (d.eqMidFreq != null) deck.setEqMidFreq(d.eqMidFreq);
      if (d.eqHighFreq != null) deck.setEqHighFreq(d.eqHighFreq);
      if (d.eqMidQ != null) deck.setEqMidQ(d.eqMidQ);
      deck.setFilter(d.filter ?? 0);
      if (d.eqHpFreq != null) deck.setEqHpFreq(d.eqHpFreq);
      if (d.eqHpQ != null) deck.setEqHpQ(d.eqHpQ);
      if (d.eqLpFreq != null) deck.setEqLpFreq(d.eqLpFreq);
      if (d.eqLpQ != null) deck.setEqLpQ(d.eqLpQ);
      deck.setEqBypass(!!d.eqBypass);
      deck.setPitch(d.pitchSemis ?? 0);
      // Discrete state — absolute, so exact regardless of our own playhead.
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
      // Muted passenger → don't build an audio graph (iOS OOM, bug #2). Stash the target;
      // the flush effect decodes it when this device starts rendering audio.
      if (deferDecodeRef.current) {
        pendingRoomLoad.current[id] = { videoId, track, restore };
        return;
      }
      pendingRoomLoad.current[id] = null;
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
      // Mirror the SYNC/KEY button state (display only — tempo/pitch arrive as intents).
      if (snap.syncSlave !== undefined) engine.mirrorSyncDisplay(snap.syncSlave);
      if (snap.keySlave !== undefined) engine.mirrorKeyDisplay(snap.keySlave);
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
          // Waveform zoom is LOCAL view state (not a synced control) — each device keeps its
          // own, so we don't apply snap.zoom here.
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
        } else if (d.videoId && d.videoId === loadedId && reconciledTarget.current[id] !== d.videoId) {
          // Reconcile a loaded track's discrete state ONCE (deduped per videoId) — so a
          // republished snapshot can't stomp a non-anchor controller's live cue/loop/stem
          // edits; ongoing changes cross as intents.
          reconcileDeckState(id, d);
          reconciledTarget.current[id] = d.videoId;
        }
      });
      refresh();
    },
    [engine, runRoomLoad, reconcileDeckState, refresh],
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
        // Make a freshly-decoded follower actually SOUND: honor the snapshot transport.
        // Ticks also do this, but a late joiner can sit decoded-but-paused if no tick flips
        // it — so this is the FALLBACK. When the anchor IS ticking this deck, let onRoomTick
        // start playback at the LIVE position (its flip branch seeks fresh): starting here
        // from the now-stale snapshot position would get yanked forward an instant later —
        // the audible skip on join. Only start from the snapshot when no tick is driving.
        const deck = engine.deck(id);
        const tickDriving = performance.now() - (lastTickAt.current[id] ?? 0) < 1000;
        if (d.playing && !deck.playing && !tickDriving) {
          engine.resume();
          deck.seek(d.position);
          deck.play();
          followSeekAt.current[id] = performance.now();
        }
        any = true;
      }
    });
    if (any) refresh();
  }, [engine, loaded, reconcileDeckState, refresh]);

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
      // SYNC / KEY role: mirror the button(s) only — the master's tempo/pitch already
      // crosses as control intents, so we don't re-run the engine on the follower.
      if (intent.kind === "sync") {
        engine.mirrorSyncDisplay(intent.slave);
        refresh();
        return;
      }
      if (intent.kind === "key") {
        engine.mirrorKeyDisplay(intent.slave);
        refresh();
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
          else if (intent.param === "eqLowFreq") deck.setEqLowFreq(intent.value);
          else if (intent.param === "eqMidFreq") deck.setEqMidFreq(intent.value);
          else if (intent.param === "eqHighFreq") deck.setEqHighFreq(intent.value);
          else if (intent.param === "eqMidQ") deck.setEqMidQ(intent.value);
          else if (intent.param === "eqHpFreq") deck.setEqHpFreq(intent.value);
          else if (intent.param === "eqHpQ") deck.setEqHpQ(intent.value);
          else if (intent.param === "eqLpFreq") deck.setEqLpFreq(intent.value);
          else if (intent.param === "eqLpQ") deck.setEqLpQ(intent.value);
          else if (intent.param === "filter") deck.setFilter(intent.value);
          else if (intent.param === "pitch") deck.setPitch(Math.round(intent.value));
          break;
        case "toggle":
          if (intent.param === "fx") deck.setFx(intent.value);
          else if (intent.param === "keylock") deck.setKeylock(intent.value);
          else if (intent.param === "eqBypass") deck.setEqBypass(intent.value);
          else deck.setQuantize(intent.value);
          break;
        case "stemGain":
          // Apply regardless of local stems — the deck holds gain/mute state buffer-
          // free, so a mix-only remote stays in sync and reflects it on its cells.
          deck.setStemGain(intent.stem, intent.value);
          break;
        case "stem":
          deck.setStemMute(intent.stem, !intent.on);
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
        case "skip":
          deck.skipBeats = intent.beats; // jog / beat-jump resolution
          break;
        case "loopBounds":
          deck.applyLoopRegion(intent.start, intent.end, intent.active); // fine-adjust / move
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
      // A remote asked the audio host to make stems for a deck — handled specially (the
      // host separates + streams the view back); it's not a local control to apply.
      if (intent.kind === "reqStems") {
        stemReqRef.current(intent.deck, intent.model);
        return;
      }
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
      const now = performance.now();
      (["A", "B"] as DeckId[]).forEach((id) => {
        const t = decks[id];
        const deck = engine.deck(id);
        if (!t) return;
        lastTickAt.current[id] = now; // the anchor is ticking this deck (used by the join fallback)
        if (!deck.buffer || scrubbing.current[id]) return; // don't fight a local scrub
        const drift = Math.abs(deck.position() - t.pos);
        if (t.playing && !deck.playing) {
          engine.resume(); // iOS starts suspended
          if (drift > 0.05) deck.seek(t.pos); // catch up cleanly BEFORE the source starts
          deck.play();
          followSeekAt.current[id] = now;
          flipped = true;
        } else if (!t.playing && deck.playing) {
          deck.pause();
          if (drift > 0.05) deck.seek(t.pos); // land on the master's paused position
          followSeekAt.current[id] = now;
          flipped = true;
        } else if (deck.playing) {
          // Steady audible playback → only fix a real desync, and NEVER back-to-back: a
          // freshly-joined follower settles instead of skip/repeating. 1.2s grace after any
          // seek lets the audio glide back into tolerance on its own.
          if (drift > 0.6 && now - followSeekAt.current[id] > 1200) {
            deck.seek(t.pos);
            followSeekAt.current[id] = now;
          }
        } else {
          if (drift > 0.12) deck.seek(t.pos); // both paused → tight align is silent, no skip
        }
        // Reliable stem-state convergence: apply the anchor's authoritative per-stem mute/
        // gain when present, but SKIP a stem we ourselves touched in the last 400 ms so our
        // own in-flight change isn't briefly stomped by a slightly-stale echo. Idempotent —
        // only repaint when a value actually moved.
        if (t.stems) {
          const touched = stemTouch.current[id];
          STEM_KEYS.forEach((n, i) => {
            if (now - (touched[n] ?? 0) < 400) return;
            const g = t.stems!.g[i];
            const muted = !!t.stems!.m[i];
            if (g != null && deck.stemLevel(n) !== g) {
              deck.setStemGain(n, g);
              flipped = true;
            }
            if (deck.stemActive(n) === muted) {
              deck.setStemMute(n, muted);
              flipped = true;
            }
          });
        }
        // Feed the follower visual clock: the waveform glides at the display rate off a
        // wall-clock extrapolation of this tick, even when the local audio clock is
        // frozen (muted passenger / suspended mobile context). See Deck.visualPosition.
        deck.followTick(t.pos, t.playing);
      });
      if (flipped) refresh();
    },
    [engine, refresh],
  );

  // A peer's stem waveform envelopes arrived (the host streams them) → rebuild this
  // deck's 4-lane display from them, even though we hold no local stem PCM (mobile).
  const onRoomStemView = useCallback(
    (deck: DeckId, view: unknown) => {
      try {
        engine.deck(deck).setRemoteStemView(view as StemView);
        // The host's stems are now displayed here — cancel any pending "couldn't deliver"
        // timer, clear the "Requesting…" chip, and show the view is live from the host.
        if (stemReqTimers.current[deck]) {
          clearTimeout(stemReqTimers.current[deck]);
          stemReqTimers.current[deck] = undefined;
        }
        setStatusFor(deck, { phase: "ready", src: "host", detail: "Stems from the session host." });
        refresh();
      } catch {
        /* malformed view — ignore */
      }
    },
    [engine, refresh, setStatusFor],
  );

  // The host streams its resolved, word-timed lyrics → apply them to this deck's caption ribbon
  // (and persist), so a guest gets the SAME playhead-accurate captions the host sees — even on a
  // phone (no GPU) or with the YouTube engine. The host's stream wins over any local fallback.
  const onRoomLyrics = useCallback(
    (deck: DeckId, videoId: string, lines: unknown, source: string) => {
      const ls = lines as LyricsLine[];
      if (!Array.isArray(ls) || ls.length === 0) return;
      const src = (source as LyricsSource) || "whisper";
      setCaptions((c) => ({ ...c, [deck]: ls }));
      setCaptionSource((s) => ({ ...s, [deck]: src }));
      cacheRemoteLyrics(videoId, ls, src);
    },
    [],
  );

  const room = useRoom(
    {
      onState: applyRoomSnapshot,
      onIntent: onRoomIntent,
      onTick: onRoomTick,
      onStemView: onRoomStemView,
      onLyrics: onRoomLyrics,
      onKicked: (reason) => setKickedNotice(reason || "You left the session."),
    },
    settings.accentA, // our account accent → synced so the room can take the host's vibe
  );

  // Contextual room colour: while CONNECTED to a session (and opted in), wear the HOST's
  // accent so the whole room shares a vibe. Gated on being connected (status online) rather
  // than fully joined, so a guest catches the vibe the moment they're in the room — even
  // mid-handshake — instead of only after approval. Override ONLY the global --accent (not
  // the per-deck colours) and revert to our own the moment we're solo or opt out. (Note:
  // same-account devices share an accent, so there's correctly nothing to inherit there —
  // the vibe is visible when a guest on a DIFFERENT account has a different accent.)
  useEffect(() => {
    const root = document.documentElement;
    const vibe =
      room.status === "online" && settings.inheritRoomColor && room.hostColor && room.hostColor !== settings.accentA;
    if (vibe) root.style.setProperty("--accent", room.hostColor!);
    else root.style.removeProperty("--accent");
    return () => {
      root.style.removeProperty("--accent");
    };
  }, [room.status, room.hostColor, settings.inheritRoomColor, settings.accentA]);

  // The kicked/denied notice is transient — clear it after a few seconds.
  useEffect(() => {
    if (!kickedNotice) return;
    const t = setTimeout(() => setKickedNotice(null), 6000);
    return () => clearTimeout(t);
  }, [kickedNotice]);

  // Publish THIS device's stem envelopes to the session (host side) so stem-less
  // remotes can render the 4-lane display. Via a ref so the deck callback below reads
  // live room state without re-binding on every change.
  const roomRef = useRef(room);
  roomRef.current = room;
  const sendHostStemView = useCallback(
    (id: DeckId) => {
      const r = roomRef.current;
      // Stream from whichever device actually holds the stems and speaks for the board
      // (the clock OR any controller). extractStemView returns null unless this deck has
      // REAL local stems, so a stem-less remote can never publish here.
      if (r.status !== "online" || (!r.controlling && !r.isAnchor)) return;
      const v = engine.deck(id).extractStemView();
      if (v) r.sendStemView(id, v);
    },
    [engine],
  );

  // HOST streams its resolved, word-timed lyrics to the room (the lyric twin of stem-view
  // streaming). Read via refs so the broadcast effect below isn't a dependency knot; reference-
  // equality on the lines array (fresh per resolve) sends ONCE per resolution, and `force`
  // re-sends to a newly-joined guest even when nothing changed.
  const captionsRef = useRef(captions);
  captionsRef.current = captions;
  const captionSourceRef = useRef(captionSource);
  captionSourceRef.current = captionSource;
  const lastLyricsSent = useRef<Record<DeckId, LyricsLine[] | null>>({ A: null, B: null });
  const sendHostLyrics = useCallback((id: DeckId, force = false) => {
    const r = roomRef.current;
    if (r.status !== "online" || (!r.controlling && !r.isAnchor)) return;
    const lines = captionsRef.current[id];
    if (!lines || !lines.length) return;
    if (!force && lines === lastLyricsSent.current[id]) return;
    lastLyricsSent.current[id] = lines;
    r.sendLyrics(id, latest.current.loaded[id] || "", lines, captionSourceRef.current[id] || "whisper");
  }, []);
  // Broadcast whenever a deck's captions change and we're the board authority.
  useEffect(() => {
    sendHostLyrics("A");
    sendHostLyrics("B");
  }, [captions, captionSource, room.status, room.controlling, room.isAnchor, sendHostLyrics]);

  // HOST side of a remote's stem request: only the audio authority (anchor) fulfills it —
  // separate the deck with the asked-for model, which fires onStemsReady → streams the
  // 4-lane view back to the requester. If we already have neural stems, just (re)stream.
  const handleStemRequest = useCallback(
    (id: DeckId, modelId: string) => {
      if (!roomRef.current.isAnchor) return;
      const vid = latest.current.loaded[id];
      const deck = engine.deck(id);
      if (!vid || !deck.buffer) return;
      if (deck.hasStems && deck.stemsNeural) {
        sendHostStemView(id);
        return;
      }
      const model = getStemModel(modelId);
      if (model.kind === "dsp" || !deviceSupportsModel(model)) return; // host can't make these
      const key = `${vid}:${model.id}`;
      if (reqSepGuard.current[id] === key) return; // already separating this for a request
      reqSepGuard.current[id] = key;
      void forceSeparate(id, vid, deck.buffer, model).finally(() => {
        if (reqSepGuard.current[id] === key) reqSepGuard.current[id] = undefined;
      });
    },
    [engine, forceSeparate, sendHostStemView],
  );
  stemReqRef.current = handleStemRequest;

  useEffect(() => {
    engine.deckA.onStemsReady = () => sendHostStemView("A");
    engine.deckB.onStemsReady = () => sendHostStemView("B");
    // Loop fine-adjust / move → broadcast the absolute region (emitRef no-ops unless
    // controlling). in/out/exit/beat already emit their own loop intents.
    const loopEdit = (id: DeckId) => () => {
      const r = engine.deck(id).loopRegion();
      if (r) emitRef.current({ kind: "loopBounds", deck: id, start: r.start, end: r.end, active: r.active });
    };
    engine.deckA.onLoopEdit = loopEdit("A");
    engine.deckB.onLoopEdit = loopEdit("B");
    return () => {
      engine.deckA.onStemsReady = undefined;
      engine.deckB.onStemsReady = undefined;
      engine.deckA.onLoopEdit = undefined;
      engine.deckB.onLoopEdit = undefined;
    };
  }, [engine, sendHostStemView]);

  // Our own actions broadcast as intents (the controls also apply locally first, so
  // this is purely the network echo). Any CONTROLLING participant drives (shared
  // co-DJ) — a no-op for a watch-only listener or a solo device.
  const emit = useCallback(
    (intent: Intent) => {
      // Remember when WE last drove a stem, so the anchor's authoritative stem state
      // (echoed back on the tick) doesn't briefly stomp our own in-flight change.
      if (intent.kind === "stem" || intent.kind === "stemGain") {
        stemTouch.current[intent.deck][intent.stem] = performance.now();
      }
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
      emit({ kind: "control", deck: id, param: "eqLowFreq", value: d.eqLowFreq });
      emit({ kind: "control", deck: id, param: "eqMidFreq", value: d.eqMidFreq });
      emit({ kind: "control", deck: id, param: "eqHighFreq", value: d.eqHighFreq });
      emit({ kind: "control", deck: id, param: "eqMidQ", value: d.eqMidQ });
      emit({ kind: "control", deck: id, param: "eqHpFreq", value: d.eqHpFreq });
      emit({ kind: "control", deck: id, param: "eqHpQ", value: d.eqHpQ });
      emit({ kind: "control", deck: id, param: "eqLpFreq", value: d.eqLpFreq });
      emit({ kind: "control", deck: id, param: "eqLpQ", value: d.eqLpQ });
      emit({ kind: "toggle", deck: id, param: "eqBypass", value: d.eqBypassed });
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
  // Catch-up snapshots apply to everyone EXCEPT the anchor (the authoritative board / its
  // own source of truth). A non-anchor CONTROLLER — e.g. a same-account "control extension"
  // device that joined with empty decks — still needs the snapshot to load the host's deck
  // songs; gating on !controlling left it driving a blank board (deck songs never synced).
  // Re-stomping a controller's live edits is prevented by the per-videoId reconcile dedupe.
  snapFollowRef.current = room.enabled && !room.isAnchor;
  // Locked out of driving (a watch-only listener) → block the keys + show the overlay.
  lockedRef.current = room.enabled && !room.controlling;
  // Defer decode while we're a pure muted passenger — enabled but rendering no audio and
  // holding no authority. The moment any of those change (🔊 on, granted control, became
  // the clock) we render audio, so we decode the stashed session tracks (flush effect).
  deferDecodeRef.current = room.enabled && !room.listening && !room.controlling && !room.isAnchor;

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

  // --- USB-MIDI controller routing ---
  // Sub-integer carry for relative encoders that drive an INTEGER param (pitch): a
  // single detent is a fraction of a semitone, so accumulate until it crosses ±1.
  const knobAcc = useRef<Record<string, number>>({});
  // Soft-takeover state for ABSOLUTE pickup knobs (Starrypad), keyed by target. Each is
  // "caught" only once the knob value sweeps through the param's current value, so it
  // never jumps. Reset on focus change so re-grabbing the new deck re-catches (no jump).
  const knobPickup = useRef<Record<string, { caught: boolean; last: number }>>({});
  useEffect(() => void (knobPickup.current = {}), [focused]);
  // A decoded MidiEvent is fanned out to the SAME handlers the keyboard/buttons use,
  // so a hardware board has full feature + session-sync parity. value is 0..1; we
  // scale it to each control's real range here (where the live tempo range lives).
  const onMidiEvent = useCallback(
    (ev: MidiEvent) => {
      if (lockedRef.current) return; // a watch-only participant can't drive the decks
      // Map a 0..1 knob to dB with a centre detent at 0 dB (DJ EQ convention).
      const eqDb = (v: number) => (v < 0.5 ? EQ_MIN_DB * (0.5 - v) * 2 : EQ_MAX_DB * (v - 0.5) * 2);
      const SEC_PER_TICK = 0.0025; // ~33⅓ rpm platter feel (720 ticks ≈ 1.8 s)
      switch (ev.type) {
        case "shift": {
          // A per-deck controller SHIFT (FLX4) → that deck's shift. A DECKLESS shift
          // (the Starrypad's latching RECORD toggle) → a focus-following latch, so it
          // moves to whichever deck is focused while it's on. Scoped per deck, never both.
          if (ev.deck) {
            const d = ev.deck;
            setMidiShift((m) => (m[d] === ev.down ? m : { ...m, [d]: ev.down }));
          } else {
            setFocusShift(ev.down);
          }
          break;
        }
        case "focus": {
          // A pad-style board (one control set, no per-deck duplication) switches which
          // deck it drives — make ev.deck the focused deck (same ring the keyboard uses).
          setFocused(ev.deck);
          break;
        }
        case "button": {
          // Deck omitted (focus-model board) → drive the focused deck. The effective
          // shift folds in HTL's shift state so e.g. the Starrypad PLAY honours the
          // record-latch (shift) → reset, even though its CC carries no shift bit.
          const id = ev.deck ?? focused;
          const deck = engine.deck(id);
          const sh = ev.shift || midiShift[id] || (focused === id && (focusShift || shiftLatched || shiftHeld));
          // Pad workflow: triggering an EXISTING hot cue or a beat loop WHILE PAUSED drops
          // into playback (a pad press "launches"). Velocity-sensitive: a SOFT tap just
          // jumps (audition the spot, stay paused), a FIRM hit plays. Saving a new cue
          // (empty slot) or a shifted action (clear) never plays. Velocity-less buttons
          // (CC) treat as firm. Scoped to the controller — keyboard unchanged.
          const wasPaused = !deck.playing;
          const cueSlot = /^hotcue(\d)$/.exec(ev.action);
          const hadCue = cueSlot ? deck.hotCues[Number(cueSlot[1]) - 1] != null : false;
          const isLoop = /^beatLoop\d$/.test(ev.action);
          const firm = (ev.velocity ?? 127) >= 40; // soft tap < 40 = jump only
          handlersRef.current[ev.action]?.(deck, id, sh); // sets / resizes / EXITS the loop (shared toggle)
          // Triggering an existing cue, or NEWLY engaging a loop, while paused launches
          // playback (firm hit only). EXITING a loop (now inactive) must not start it.
          if (wasPaused && !sh && firm && !deck.playing && (hadCue || (isLoop && deck.loop?.active))) {
            deck.play();
            emitRef.current({ kind: "transport", deck: id, action: "play" });
          }
          refresh();
          break;
        }
        case "beatjump": {
          const deck = engine.deck(ev.deck);
          deck.beatJump(ev.beats);
          emitSeekTo(ev.deck, deck.position());
          refresh();
          break;
        }
        case "fader": {
          if (ev.target === "crossfader") {
            const x = (ev.value - 0.5) * 2;
            setCrossfade(x);
            engine.setCrossfade(x);
            if (room.controlling) room.sendIntent({ kind: "crossfade", value: x });
            break;
          }
          const id = ev.deck ?? focused;
          const deck = engine.deck(id);
          const ctl = emitRef.current;
          // Soft-takeover for an ABSOLUTE pickup knob (Starrypad): don't move the param
          // until the knob value sweeps THROUGH its current value — so switching focus /
          // first touch never jumps. Once caught it tracks 1:1 (and reaches 0/max).
          if (ev.pickup) {
            const t = ev.target;
            let cur01: number | null = null;
            if (t === "level") cur01 = deck.level / 2;
            else if (t === "trim") cur01 = deck.trim / 2;
            else if (t === "pitch") cur01 = (deck.pitch + 12) / 24;
            else if (t === "tempo") cur01 = deck.tempo / settings.tempoRange / 2 + 0.5;
            else if (t === "stemDrums") cur01 = deck.stemLevel("drums") / 1.5;
            else if (t === "stemBass") cur01 = deck.stemLevel("bass") / 1.5;
            else if (t === "stemVocals") cur01 = deck.stemLevel("vocals") / 1.5;
            else if (t === "stemOther") cur01 = deck.stemLevel("other") / 1.5;
            else if (t === "filterHp") cur01 = deck.hpAmount;
            else if (t === "filterLp") cur01 = deck.lpAmount;
            if (cur01 != null) {
              const st = knobPickup.current[t];
              const caught = st?.caught === true || (st != null && ((st.last <= cur01 && ev.value >= cur01) || (st.last >= cur01 && ev.value <= cur01)));
              knobPickup.current[t] = { caught, last: ev.value };
              if (!caught) break; // not caught yet → ignore so it never jumps
            }
          }
          switch (ev.target) {
            case "tempo": {
              const pct = (ev.value - 0.5) * 2 * settings.tempoRange;
              deck.setTempo(pct);
              ctl({ kind: "control", deck: id, param: "tempo", value: deck.tempo });
              break;
            }
            case "level":
              // The on-screen channel fader spans 0..2 (unity at centre), so map the
              // physical fader 1:1 across that whole range — top of throw = full boost.
              deck.setLevel(ev.value * 2);
              ctl({ kind: "control", deck: id, param: "level", value: deck.level });
              break;
            case "trim":
              deck.setTrim(ev.value * 2);
              ctl({ kind: "control", deck: id, param: "trim", value: deck.trim });
              break;
            case "eqHi":
              deck.setEqHigh(eqDb(ev.value));
              ctl({ kind: "control", deck: id, param: "eqHigh", value: deck.eqHigh });
              break;
            case "eqMid":
              deck.setEqMid(eqDb(ev.value));
              ctl({ kind: "control", deck: id, param: "eqMid", value: deck.eqMid });
              break;
            case "eqLow":
              deck.setEqLow(eqDb(ev.value));
              ctl({ kind: "control", deck: id, param: "eqLow", value: deck.eqLow });
              break;
            case "filter":
              deck.setFilter((ev.value - 0.5) * 2);
              ctl({ kind: "control", deck: id, param: "filter", value: deck.filterValue });
              break;
            case "filterHp":
              deck.setHpAmount(ev.value);
              ctl({ kind: "control", deck: id, param: "filter", value: deck.filterValue });
              break;
            case "filterLp":
              deck.setLpAmount(ev.value);
              ctl({ kind: "control", deck: id, param: "filter", value: deck.filterValue });
              break;
            case "pitch":
              deck.setPitch(Math.round((ev.value - 0.5) * 24));
              ctl({ kind: "control", deck: id, param: "pitch", value: deck.pitch });
              break;
            case "stemDrums":
            case "stemBass":
            case "stemVocals":
            case "stemOther": {
              const stem = ({ stemDrums: "drums", stemBass: "bass", stemVocals: "vocals", stemOther: "other" } as const)[ev.target];
              deck.setStemGain(stem, ev.value * 1.5);
              ctl({ kind: "stemGain", deck: id, stem, value: deck.stemLevel(stem) });
              break;
            }
          }
          refresh();
          break;
        }
        case "knob": {
          // A relative encoder (endless knob) → nudge the target on the focused deck
          // from its CURRENT value by `delta` (a signed fraction of the full range).
          const id = ev.deck ?? focused;
          const deck = engine.deck(id);
          const ctl = emitRef.current;
          const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
          const d = ev.delta;
          switch (ev.target) {
            case "level":
              deck.setLevel(clamp(deck.level + d * 2, 0, 2));
              ctl({ kind: "control", deck: id, param: "level", value: deck.level });
              break;
            case "trim":
              deck.setTrim(clamp(deck.trim + d * 2, 0, 2));
              ctl({ kind: "control", deck: id, param: "trim", value: deck.trim });
              break;
            case "filter":
              // One bipolar filter shared by two directional knobs: HP knob nudges +
              // (high-pass), the LP knob is inverted so it nudges − (low-pass).
              deck.setFilter(clamp(deck.filterValue + d, -1, 1));
              ctl({ kind: "control", deck: id, param: "filter", value: deck.filterValue });
              break;
            case "tempo": {
              const r = settings.tempoRange;
              deck.setTempo(clamp(deck.tempo + d * 2 * r, -r, r));
              ctl({ kind: "control", deck: id, param: "tempo", value: deck.tempo });
              break;
            }
            case "pitch": {
              // Integer semitones: carry the fractional part across detents (±12 over a
              // full sweep) so slow turns still resolve to whole-semitone steps.
              const k = `${id}:pitch`;
              const acc = (knobAcc.current[k] ?? 0) + d * 24;
              const step = Math.trunc(acc);
              knobAcc.current[k] = acc - step;
              if (step) {
                deck.setPitch(deck.pitch + step);
                ctl({ kind: "control", deck: id, param: "pitch", value: deck.pitch });
              }
              break;
            }
            case "stemDrums":
            case "stemBass":
            case "stemVocals":
            case "stemOther": {
              const stem = ({ stemDrums: "drums", stemBass: "bass", stemVocals: "vocals", stemOther: "other" } as const)[ev.target];
              deck.setStemGain(stem, clamp(deck.stemLevel(stem) + d * 1.5, 0, 1.5));
              ctl({ kind: "stemGain", deck: id, stem, value: deck.stemLevel(stem) });
              break;
            }
          }
          refresh();
          break;
        }
        case "jogTouch": {
          const deck = engine.deck(ev.deck);
          if (ev.down) {
            deck.scrubBegin();
            onJogStart(ev.deck);
          } else {
            deck.scrubEnd();
            onJogEnd(ev.deck);
          }
          break;
        }
        case "jogTurn": {
          // The gripped top of the platter SCRATCHES (position); turning it without a
          // grip (or a board with no touch sensor) BENDS the tempo — deck.bend self-
          // routes to a frame-search when paused. One decision, shared with the ring.
          const deck = engine.deck(ev.deck);
          const sec = ev.delta * SEC_PER_TICK;
          if (deck.scrubbing) {
            deck.scrubMove(sec);
            emitJog(ev.deck, sec);
          } else {
            deck.bend(sec);
          }
          break;
        }
        case "jogBend": {
          // Outer ring (never touched) → momentary pitch-bend / paused frame-search.
          engine.deck(ev.deck).bend(ev.delta * SEC_PER_TICK);
          break;
        }
        case "selector":
          // Browse-encoder press → open/close the library panel.
          setLibOpen((v) => !v);
          break;
        case "load":
        case "browse":
          // Library cursor nav (move selection / load selected) — wired separately.
          break;
      }
    },
    [engine, refresh, settings.tempoRange, emitSeekTo, onJogStart, onJogEnd, emitJog, room, focused, midiShift, focusShift, shiftLatched, shiftHeld],
  );

  const midi = useMidi({
    enabled: settings.midiEnabled,
    learn: settings.midiBindings,
    onEvent: onMidiEvent,
    onLearnChange: (next) => setSettings((s) => ({ ...s, midiBindings: next })),
  });

  // Light the controller from deck state (play/cue/sync/loop + hot-cue pads). Polled
  // at ~7 Hz; the engine diffs each lamp so only changes are actually sent. The mute
  // SysEx keep-alive is handled inside MidiEngine.
  useEffect(() => {
    if (!settings.midiEnabled || midi.status.state !== "connected") return;
    const push = () => {
      (["A", "B"] as DeckId[]).forEach((id) => {
        const d = engine.deck(id);
        const fb: DeckFeedback = {
          play: d.playing,
          cue: !d.playing, // cue lamp lit while stopped (sitting on the cue), per DJ convention
          sync: d.syncRole === "slave",
          loop: !!d.loop?.active,
          hotcues: Array.from({ length: 8 }, (_, i) => d.hotCues[i] != null),
        };
        midi.setFeedback(id, fb);
      });
    };
    push();
    const iv = setInterval(push, 150);
    return () => clearInterval(iv);
  }, [engine, settings.midiEnabled, midi.status.state, midi.setFeedback]);
  // A user picking a track hands it to the audio master via a load intent (the master
  // does the real streaming / decode / playback / stems); we also load locally for our
  // own waveform. Remote-driven loads go through applyIntent and DON'T re-emit.
  const loadAndShare = useCallback(
    (id: DeckId, track: TrackMeta) => {
      // A watch-only passenger (joined but not driving) MIRRORS the session — it must
      // not load locally. Doing so both diverges its deck from the session AND poisons
      // roomLoadTarget so the snapshot can never restore the correct track (the "Deck B
      // stuck on a different track" desync). The library lives outside the stage-lock
      // overlay, so this is the one place that input still reaches us — gate it here.
      if (room.enabled && !room.controlling) return;
      if (track.videoId) {
        roomLoadTarget.current[id] = track.videoId; // so the master's echo snapshot doesn't reload it
        emit({ kind: "load", deck: id, videoId: track.videoId, name: track.title, artist: track.artist });
      }
      void loadTrackToDeck(id, track);
    },
    [emit, loadTrackToDeck, room.enabled, room.controlling],
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
    if (room.isAnchor && room.status === "online") {
      room.publishState(buildSnapshot());
      // Re-publish stem envelopes too (covers session start / a track load / a peer
      // joining) so a remote's 4-lane display fills in alongside the board snapshot.
      sendHostStemView("A");
      sendHostStemView("B");
      // …and the word-timed lyrics (forced) so a fresh joiner's caption ribbon fills in too.
      sendHostLyrics("A", true);
      sendHostLyrics("B", true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.isAnchor, room.status, joinedSig, loaded, room.publishState, buildSnapshot, sendHostStemView, sendHostLyrics]);

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
    // Build a deck's tick: always pos/playing; piggyback the authoritative stem mixer
    // state only when it CHANGED since the last send, or on a ~1 Hz heartbeat (tick % 13).
    const buildTick = (deck: Deck, id: DeckId): DeckTick => {
      const g = STEM_KEYS.map((n) => deck.stemLevel(n));
      const m = STEM_KEYS.map((n) => !deck.stemActive(n));
      const key = `${g.map((x) => x.toFixed(3)).join(",")}|${m.map((x) => (x ? 1 : 0)).join("")}`;
      const include = lastStemKey.current[id] !== key || tickN.current % 13 === 0;
      lastStemKey.current[id] = key;
      const tick: DeckTick = { pos: deck.position(), playing: deck.playing };
      if (include) tick.stems = { g, m };
      return tick;
    };
    const iv = setInterval(() => {
      tickN.current++;
      room.sendTick({ A: buildTick(engine.deckA, "A"), B: buildTick(engine.deckB, "B") });
    }, 80);
    return () => clearInterval(iv);
  }, [engine, room.isAnchor, room.status, room.sendTick]);

  // Only a non-anchor co-DJ mirrors the anchor's clock for drawing. When this device
  // is solo, or it IS the anchor (its own real playhead is the reference), drop the
  // follower visual clock so the waveform draws from the local transport again.
  useEffect(() => {
    if (room.enabled && room.status === "online" && !room.isAnchor) return;
    engine.deckA.endFollow();
    engine.deckB.endFollow();
  }, [engine, room.enabled, room.status, room.isAnchor]);

  // Flush deferred decodes: a muted passenger doesn't decode (bug #2), so when it starts
  // rendering audio — 🔊 on, granted control, or promoted to the clock — decode the stashed
  // session tracks now (deferDecodeRef is already false this render, so runRoomLoad decodes).
  useEffect(() => {
    if (deferDecodeRef.current) return; // still a muted passenger → keep deferring
    (["A", "B"] as DeckId[]).forEach((id) => {
      const p = pendingRoomLoad.current[id];
      if (!p) return;
      pendingRoomLoad.current[id] = null;
      roomLoadTarget.current[id] = null; // let runRoomLoad re-arm the guard + actually load
      runRoomLoad(id, p.videoId, p.track, p.restore);
    });
  }, [room.enabled, room.listening, room.controlling, room.isAnchor, runRoomLoad]);

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
      // Clear all the session load guards so a later re-join can't mis-dedupe its first
      // snapshot against a stale target/reconcile/pending entry from the previous session.
      roomLoadTarget.current = { A: null, B: null };
      reconciledTarget.current = { A: null, B: null };
      pendingRoomLoad.current = { A: null, B: null };
      lastSnapshotRef.current = null;
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

  // Browsers start the audio context suspended; UNLOCK it on the first gesture (a
  // silent-buffer primer, not just resume) so iOS opens the output route. Critical for
  // LISTEN mode, where the first real sound starts later from a network tick — never
  // from a tap — so without an in-gesture primer iOS keeps the listener silent.
  useEffect(() => {
    const unlock = () => {
      engine.unlock();
      // iOS: from this gesture, bridge output through a media element so playback
      // survives lock / app-switch / Bluetooth / CarPlay handoffs (see AudioEngine).
      if (isIOSDevice()) engine.enableBackgroundAudio();
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [engine]);

  // Keep the sound alive across handoffs. (1) RESUME the output whenever we return to
  // the foreground or the audio route changes — iOS pauses the context / keep-alive
  // element on lock, a call, or a BT/CarPlay switch, and without a re-resume it stays
  // dead. (2) MEDIA SESSION so the lock screen / CarPlay / Bluetooth head unit see a
  // media app and can drive transport (this is usually why CarPlay "refuses" — no
  // session = nothing to show or control). Metadata follows the focused deck.
  useEffect(() => {
    const resume = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") engine.resumeOutput();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    const ms = navigator.mediaSession;
    if (ms) {
      const d = meta[focused];
      try {
        ms.metadata = new MediaMetadata({
          title: d?.name || "Handling The Loop",
          artist: d?.artist || "",
          album: "Handling The Loop",
        });
      } catch {
        /* MediaMetadata unsupported — handlers below still help */
      }
      const wrap = (fn: () => void) => () => {
        engine.resumeOutput();
        fn();
        refresh();
      };
      try {
        // Two decks → one CarPlay transport: pause stops the mix, play resumes any
        // loaded deck (deck.play()/pause() are no-ops on an empty/already-matching deck).
        ms.setActionHandler("play", wrap(() => { engine.deckA.play(); engine.deckB.play(); }));
        ms.setActionHandler("pause", wrap(() => { engine.deckA.pause(); engine.deckB.pause(); }));
        ms.playbackState = engine.deckA.playing || engine.deckB.playing ? "playing" : "paused";
      } catch {
        /* setActionHandler unsupported — ignore */
      }
    }
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume);
    };
  }, [engine, meta, focused, refresh]);

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

  // Live diagnostics for Settings → Debug (replaces the old green ctx overlay). Read
  // fresh each poll from the engine + session + device — the panel calls this on an
  // interval only while the Debug tab is open, so it costs nothing the rest of the time.
  const collectDebug = (): DebugSection[] => {
    const e = engine;
    const fmt = (n: number | null | undefined, d = 2) => (n == null ? "—" : n.toFixed(d));
    const deckRows = (id: DeckId): DebugSection => {
      const dk = e.deck(id);
      const h = dk.lastDiag;
      return {
        title: `Deck ${id}`,
        rows: [
          ["loaded", dk.buffer ? `${dk.buffer.duration.toFixed(1)}s` : "—"],
          ["playing", String(dk.playing)],
          ["position", `${fmt(dk.position())} (vis ${fmt(dk.visualPosition())})`],
          ["tempo", `${dk.tempo.toFixed(2)}%  rate ${dk.rate.toFixed(3)}`],
          ["pitch", `${dk.pitch > 0 ? "+" : ""}${dk.pitch} st`],
          ["bpm / key", `${fmt(dk.effectiveBpm, 1)} / ${dk.effectiveKey?.camelot ?? "—"} ${dk.effectiveKey?.name ?? ""}`.trim()],
          ["sync / key role", `${dk.syncRole} / ${dk.keyRole}`],
          ["loop", dk.loop ? `${dk.loop.active ? "on" : "off"} ${fmt(dk.loop.start)}–${fmt(dk.loop.end)} (${dk.loop.beats}b)` : "—"],
          ["stems", dk.hasStems ? (dk.stemsNeural ? "neural (4-lane)" : "dsp") : "none"],
          ["stretch attached", String(dk.stretchAttached)],
          ["worklet heartbeat", h ? `ld${h.loaded} pl${h.playing} fifo${h.fifo} pk${Number(h.peak ?? 0).toFixed(2)} g${Number(h.gain ?? 0).toFixed(2)} end${h.ended}` : "none"],
        ],
      };
    };
    const role = room.isAnchor ? "anchor" : room.controlling ? "controller" : room.listening ? "listener" : room.joined ? "watcher" : "—";
    return [
      {
        title: "Audio context",
        rows: [
          ["state", e.ctx.state],
          ["sample rate", `${e.ctx.sampleRate} Hz`],
          ["base latency", `${((e.ctx.baseLatency ?? 0) * 1000).toFixed(1)} ms`],
          ["clock", `${e.ctx.currentTime.toFixed(1)} s`],
          ["worklet error", e.workletError || "none"],
        ],
      },
      {
        title: "Shared session",
        rows: [
          ["enabled", String(room.enabled)],
          ["status", room.status],
          ["role", role],
          ["listening / controlling", `${room.listening} / ${room.controlling}`],
          ["anchor", `${room.isAnchor}${room.anchorId ? ` (${room.anchorId.slice(0, 6)})` : ""}`],
          ["guest / host", `${room.isGuest} / ${room.host}`],
          ["peers", String(room.peers?.length ?? 0)],
          ["error", room.error || "none"],
        ],
      },
      {
        title: "Device",
        rows: [
          ["mobile", String(isMobileDevice())],
          ["cores", String(navigator.hardwareConcurrency ?? "?")],
          ["mem (GB)", String((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? "?")],
          ["pixel ratio", String(window.devicePixelRatio)],
          ["viewport", `${window.innerWidth}×${window.innerHeight}`],
          ["online", String(navigator.onLine)],
          ["agent", navigator.userAgent],
        ],
      },
      {
        title: "MIDI",
        rows: [
          ["enabled", String(settings.midiEnabled)],
          ["supported", String(midi.supported)],
          ["secure context", String(typeof isSecureContext !== "undefined" ? isSecureContext : "?")],
          [
            "status",
            midi.status.state === "connected"
              ? `connected — ${midi.status.device ?? "?"} ${midi.status.profile ? `[${midi.status.profile}]` : "[generic]"}`
              : midi.status.state === "denied"
                ? `denied — ${midi.status.reason ?? ""}`
                : midi.status.state,
          ],
          ["learned bindings", String(Object.keys(settings.midiBindings).length)],
          ["learning", midi.learningId ?? "—"],
          ["last error", midi.info().error],
          ["perm midi / sysex", `${midi.info().permMidi} / ${midi.info().permSysex}`],
          ["cross-origin isolated", String(midi.info().crossOriginIsolated)],
        ],
      },
      deckRows("A"),
      deckRows("B"),
    ];
  };

  return (
    <div className={`app ${dockSwapped ? "dock-swapped" : ""}`}>
      {/* Top chin: the three panel launchers, reserving their own row at the top
          so they never overlap the board. */}
      <nav className="chin">
        <button className={`chin-btn chin-library ${libOpen ? "active" : ""}`} onClick={toggleLib} aria-label="Library">
          <span className="chin-label">Library</span>
        </button>
        <button className={`chin-btn chin-search ${searchOpen ? "active" : ""}`} onClick={toggleSearch} aria-label="Search">
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
        <button
          className={`chin-btn chin-profile ${profileOpen ? "active" : ""}`}
          onClick={() => setProfileOpen(true)}
          aria-label="Profile"
          title="Your profile"
        >
          <span className="chin-globe" aria-hidden="true">🌐</span>
        </button>
        <RoomBar room={room} onExpand={() => setSocialOpen(true)} />
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
              background={surfaceColor(settings.bgColor, settings.uiContrast)}
              selectorColor={settings.selectorColor}
              loopColor={settings.loopColor}
              markerColor={settings.markerColor}
              stripColor={settings.stripColor}
              freqColors={settings.freqColors}
              freqLow={settings.freqLowColor || FREQ_LOW_DEFAULT}
              freqMid={settings.freqMidColor || FREQ_MID_DEFAULT}
              freqHigh={settings.freqHighColor || FREQ_HIGH_DEFAULT}
              vividness={settings.freqVividness}
              glow={settings.glow}
              stemColors={{ drums: settings.stemDrumsColor, bass: settings.stemBassColor, vocals: settings.stemVocalsColor, other: settings.stemOtherColor }}
              meta={meta[id]}
              status={terseStem(status[id])}
              stemStatus={status[id]}
              captions={captions[id]}
              captionSource={captionSource[id]}
              lyricStatus={lyricStatus[id]}
              expanded={expandedLane === id}
              collapsed={expandedLane != null && expandedLane !== id}
              onToggleExpand={() => setExpandedLane((e) => (e === id ? null : id))}
              windowSec={zoom[id]}
              onZoom={(next) => setZoomFor(id, next)}
              refresh={refresh}
              onLoadFile={(f) => onLoadFile(id, f)}
              onLoadTrack={(track) => loadAndShare(id, track)}
              onJogStart={() => onJogStart(id)}
              onJog={(delta) => emitJog(id, delta)}
              onJogEnd={() => onJogEnd(id)}
              onSeek={(pos) => emitSeekTo(id, pos)}
            />
          ))}
        </div>

        {/* Middle third: the A↔B crossfader across the top, then the two decks'
            button banks side by side beneath it. */}
        <div className="decks-third">
          <Crossfader
            deckA={engine.deckA}
            deckB={engine.deckB}
            accentA={ACCENT.A}
            accentB={ACCENT.B}
            crossfade={crossfade}
            onCrossfade={(v) => { setCrossfade(v); engine.setCrossfade(v); if (room.controlling) room.sendIntent({ kind: "crossfade", value: v }); }}
          />
          <div className="decks-row">
          <DeckControls
            id="A"
            deck={engine.deckA}
            accent={ACCENT.A}
            otherDeck={engine.deckB}
            otherAccent={ACCENT.B}
            focused={focused === "A"}
            onFocus={() => setFocused("A")}
            expanded={expandedLane === "A"}
            collapsed={expandedLane != null && expandedLane !== "A"}
            mirror={false}
            shift={bankShift("A")}
            tempoRange={settings.tempoRange}
            pitchRange={settings.pitchRange}
            levelGainDb={levelGainsDb.a}
            onCycleTempoRange={cycleTempoRange}
            onCyclePitchRange={cyclePitchRange}
            onToggleShift={() => setShiftLatched((v) => !v)}
            onSync={() => { doSync("A"); emit({ kind: "sync", slave: engine.syncSlave }); refresh(); }}
            onKey={() => { engine.toggleKey("A"); emit({ kind: "key", slave: engine.keySlave }); refresh(); }}
            refresh={refresh}
            emit={emit}
            emitControls={emitDeckControls}
          />
          <DeckControls
            id="B"
            deck={engine.deckB}
            accent={ACCENT.B}
            otherDeck={engine.deckA}
            otherAccent={ACCENT.A}
            focused={focused === "B"}
            onFocus={() => setFocused("B")}
            expanded={expandedLane === "B"}
            collapsed={expandedLane != null && expandedLane !== "B"}
            mirror={false}
            shift={bankShift("B")}
            tempoRange={settings.tempoRange}
            pitchRange={settings.pitchRange}
            levelGainDb={levelGainsDb.b}
            onCycleTempoRange={cycleTempoRange}
            onCyclePitchRange={cyclePitchRange}
            onToggleShift={() => setShiftLatched((v) => !v)}
            onSync={() => { doSync("B"); emit({ kind: "sync", slave: engine.syncSlave }); refresh(); }}
            onKey={() => { engine.toggleKey("B"); emit({ kind: "key", slave: engine.keySlave }); refresh(); }}
            refresh={refresh}
            emit={emit}
            emitControls={emitDeckControls}
          />
          </div>
        </div>

        {/* Bottom third dissolved — EQ moved into each deck bank's foot. */}
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
          outputSupported={engine.canSetSink}
          debug={collectDebug}
          midi={midi}
        />
      )}

      {profileOpen && <ProfileScreen onClose={() => setProfileOpen(false)} />}

      {socialOpen && (
        <SocialScreen room={room} onClose={() => setSocialOpen(false)} onActivate={() => engine.unlock()} />
      )}

      {kickedNotice && (
        <div className="kicked-toast" onClick={() => setKickedNotice(null)} role="status">
          {kickedNotice}
        </div>
      )}

    </div>
  );
}
