import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeckLane, type DeckMeta } from "./components/DeckLane";
import { DeckControls } from "./components/DeckControls";
import { Crossfader, crossfadeGainsDb } from "./components/Crossfader";
import { SamplerStrip } from "./components/SamplerStrip";
import { useSampler, deckPadBase } from "./components/useSampler";
import { FX_PADS, fireFxPad } from "./components/fxPads";
import { applyBoardAction } from "@htl/board/boardActions";
import { searchYouTube } from "@htl/media";
import { LibraryPanel, type LibraryHandle } from "./components/LibraryPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { RoomBar } from "./components/RoomBar";
import { ProfileScreen } from "./components/ProfileScreen";
import { PublicProfileScreen, handleFromPath } from "./components/PublicProfileScreen";
import { SocialScreen } from "./components/SocialScreen";
import { DiscoverScreen } from "./components/DiscoverScreen";
import { NotificationsBell } from "./components/social/NotificationsBell";
import { type Me, fetchMe, logPlay, trimSet } from "@htl/account";
import { useRoom, type Intent, type TickDecks, type DeckTick, type QueuedTrack, type NowPlaying, type ClientMsg } from "@htl/room";
import { useSetReplay } from "@htl/replay";
import { ReplayBar } from "./components/ReplayBar";
import { useMidi, type MidiEvent, type DeckFeedback } from "@htl/midi";
import { useGamepad } from "@htl/gamepad";
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
  dropCachedBuffer,
  useLibrary,
  useLibrarySync,
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
  localTs,
  stampLocal,
  snapshotColors,
  COLOR_PROFILE_KEYS,
  type ColorValue,
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
  loadStemsPackedInt16,
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
  useMixQueue,
  type MixQueue,
  useQueuePrefetch,
  AutoMixer,
  type AutoMixStatus,
  type AutoMixMirror,
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

// Stems are actively loading (fetching from cache or separating) — used to show the
// "Stems loading…" placeholder in the stem-mixer row so a deck whose stems aren't
// ready yet stays height-aligned with one whose stems are.
const stemLoading = (s: StemStatus | null | undefined): boolean =>
  !!s && (s.phase === "downloading" || s.phase === "separating");

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

const EMPTY_META: DeckMeta = { name: "", artist: "", bpm: null, duration: 0, pyramid: null, videoId: null, thumbnail: null };

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
    eqLowQ: deck.eqLowQ,
    eqHighQ: deck.eqHighQ,
    eqLowShape: deck.eqLowShape,
    eqMidShape: deck.eqMidShape,
    eqHighShape: deck.eqHighShape,
    eqHpFreq: deck.eqHpFreq,
    eqHpQ: deck.eqHpQ,
    eqLpFreq: deck.eqLpFreq,
    eqLpQ: deck.eqLpQ,
    eqBypass: deck.eqBypassed,
    filter: deck.filterValue,
    fxOn: deck.fxOn,
    fx: deck.fxSnapshot(), // post-EQ effect chain (delay/reverb…) — EQ stays in the eq* fields
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
    hasStems: deck.ownStems,
    stemsNeural: deck.stemsNeural && deck.ownStems,
  };
}

// Serialise mobile on-device DSP stem derives across decks — two full-track offline renders at
// once is the memory spike that OOM-killed the tab. Chaining keeps the transient to one at a time.
let mobileDeriveChain: Promise<unknown> = Promise.resolve();

// A stable JSON signature of just the colour/theme settings — drives the instant cross-device
// colour-sync de-dupe (an adopted change must not bounce straight back out as a fresh broadcast).
function colorSig(s: Settings): string {
  return JSON.stringify(COLOR_PROFILE_KEYS.map((k) => (s as unknown as Record<string, unknown>)[k]));
}

// Stem names in the fixed deck order — for snapshot apply.
const STEM_KEYS = ["drums", "bass", "vocals", "other"] as const;
// Cross-device contract: the phone's on-device stem budget is AGGREGATE (combined length of
// BOTH decks' stem'd tracks), NOT per-deck — so the time can be spent unevenly (one 10-min +
// one 4-min, instead of forcing 6+6). Past this combined length, the deck that would push it
// over stays mix-only. Tunable; the escalating crash-guard backstops the build PEAK (a single
// very long track's float32 transient can still spike past this on an older phone). Desktop is
// uncapped (the engine frees this.stems post-pyramid for long tracks instead).
// Raised from 14→16 min now that the WINDOWED int16 path (dspStemsWindowedInt16) bounds the
// build transient — without it a single long track OOMs at build; with it the limiter is the
// resident int16 + mix input (~half the slope), so ~16 min combined fits a typical iPhone.
// Per-track is anyway fetch-capped at 15 min (server MAX_TRACK_SECONDS), so one deck never
// exceeds that; this aggregate just stops two long tracks from co-residing past budget.
const MOBILE_MAX_COMBINED_STEM_SECONDS = 960; // 16 min combined — aggregate budget for DOWNLOADED int16 sets
// The 8 beat-loop sizes, ascending — pad/key index → beats (shared by the keyboard
// handlers and the MIDI pad dispatch so a loop pad can match the active loop's size).
const LOOP_BEATS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8];

// Apply per-stem mixer state from a snapshot. The deck stores gain/mute even
// before its stems exist, so it takes effect the moment separation finishes.
function applyDeckStems(deck: Deck, s: DeckSnapshot) {
  // A stem-less remote (mobile) marks the SOURCE device's stems present so its mixer
  // cells light up and drive them — without holding any local buffers (mix-only
  // audio). Desktops separate locally, so they never take the remote path.
  // Mirror the host's stems as a REMOTE display ONLY when this device has no real stems of its
  // own. A phone now derives a local DSP set (audible + synced) — authoritative — so don't stomp
  // it back to a remote mirror; the per-stem mixer state below still applies to the local stems.
  if (isMobileDevice() && !deck.ownStems) deck.markRemoteStems(!!s.hasStems, !!s.stemsNeural);
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
  if (s.eqLowShape != null) deck.setEqLowShape(s.eqLowShape);
  if (s.eqMidShape != null) deck.setEqMidShape(s.eqMidShape);
  if (s.eqHighShape != null) deck.setEqHighShape(s.eqHighShape);
  if (s.eqLowQ != null) deck.setEqLowQ(s.eqLowQ);
  if (s.eqHighQ != null) deck.setEqHighQ(s.eqHighQ);
  // Filter drives the EQ HP/LP nodes, so apply it BEFORE the explicit HP/LP positions
  // — otherwise a centred filter would reset manually-dragged cut handles.
  deck.setFilter(s.filter ?? 0);
  deck.setFx(s.fxOn ?? true);
  if (s.eqHpFreq != null) deck.setEqHpFreq(s.eqHpFreq);
  if (s.eqHpQ != null) deck.setEqHpQ(s.eqHpQ);
  if (s.eqLpFreq != null) deck.setEqLpFreq(s.eqLpFreq);
  if (s.eqLpQ != null) deck.setEqLpQ(s.eqLpQ);
  deck.setEqBypass(!!s.eqBypass);
  deck.applyFxSnapshot(s.fx); // FX chain (undefined = old snapshot → keep default; [] = explicitly empty)
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

  // The auto-DJ queue + status streamed from the session host (null when solo/host).
  const [remoteAutomix, setRemoteAutomix] = useState<AutoMixMirror | null>(null);

  const [meta, setMeta] = useState<Record<DeckId, DeckMeta>>({ A: EMPTY_META, B: EMPTY_META });
  const [, setLoading] = useState<Record<DeckId, boolean>>({ A: false, B: false });
  const [status, setStatus] = useState<Record<DeckId, StemStatus | null>>({ A: null, B: null });
  const [crossfade, setCrossfade] = useState(0);
  // Crossfader enabled (FLX SMART FADER toggles it). Disabled = the crossfader is ignored and
  // parked at centre (both decks full). A ref mirrors it for the MIDI fader gate.
  const [xfaderEnabled, setXfaderEnabled] = useState(true);
  const xfaderEnabledRef = useRef(true);
  useEffect(() => {
    xfaderEnabledRef.current = xfaderEnabled;
  }, [xfaderEnabled]);
  // Headphone (cue-device) master controls — display state for the buttonoids; the engine
  // holds the truth, these mirror it so the FLX 🎧 MIX knob and the on-screen cells agree.
  const [cueMix, setCueMixSt] = useState(0); // 0 = full CUE (PFL) … 1 = full MST (master)
  const [cueLevel, setCueLevelSt] = useState(1); // headphone master output level
  // The sampler-strip MIC cell owns its level state; this ref lets the FLX MIC LEVEL knob
  // push the display value into it (the knob already drives engine.setMicLevel directly).
  const micVolSetRef = useRef<((v: number) => void) | null>(null);
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
  // Which videoId each deck's CURRENT captions actually belong to — so the host broadcasts
  // the lines paired with their true id (not a momentarily-stale loaded[id]) and a guest only
  // applies streamed lyrics whose id matches the track it's showing. Prevents the cross-track
  // contamination (e.g. a 50 Cent deck showing/caching another track's lyrics).
  const captionVidRef = useRef<Record<DeckId, string>>({ A: "", B: "" });
  // Lyric processing/failure tell per deck (model download %, "Transcribing…", "unavailable").
  const [lyricStatus, setLyricStatus] = useState<Record<DeckId, string | null>>({ A: null, B: null });
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  // Which right-dock panel was open last reload — restored DESKTOP-ONLY (like libOpen
  // below; on a phone the docks are full-screen modals that always start closed). The
  // three share one slot, so one string captures it.
  const initRightDock = window.innerWidth >= 769 ? localStorage.getItem("htl:rightDock") : null;
  const [settingsOpen, setSettingsOpen] = useState(initRightDock === "settings");
  const [profileOpen, setProfileOpen] = useState(initRightDock === "profile");
  const [socialOpen, setSocialOpen] = useState(initRightDock === "social");
  const [discoverOpen, setDiscoverOpen] = useState(initRightDock === "discover");
  useEffect(() => {
    const v = settingsOpen ? "settings" : profileOpen ? "profile" : socialOpen ? "social" : discoverOpen ? "discover" : "";
    try {
      localStorage.setItem("htl:rightDock", v);
    } catch {
      /* ignore */
    }
  }, [settingsOpen, profileOpen, socialOpen, discoverOpen]);
  // The public profile (/@handle) shares the right dock — mutually exclusive with the
  // three above. URL-driven (not persisted): the path opens it, popstate follows it.
  const [publicHandle, setPublicHandle] = useState<string | null>(handleFromPath);
  useEffect(() => {
    const onPop = () => setPublicHandle(handleFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // playRecordedSet is defined far below; reach it from this on-mount effect via a ref
  // (assigned during render, so it's ready by the time this post-commit effect fires).
  const playSetRef = useRef<(id: string) => void>(() => {});
  const launchingSetRef = useRef(false); // a /set/ deep link is taking over → the boot-restore stands down
  // G4: a shared /set/:id link launches STRAIGHT into the replay (replay.play fetches the log) —
  // it used to dump you on the owner's profile to find + click the set. Clean the URL so a
  // reload doesn't re-fire, and flag the boot-restore so it doesn't flash the old board first.
  useEffect(() => {
    const m = location.pathname.match(/^\/set\/([A-Za-z0-9-]{6,40})$/);
    if (!m) return;
    launchingSetRef.current = true;
    history.replaceState(null, "", "/");
    playSetRef.current(m[1]);
  }, []);
  useEffect(() => {
    // Opening the public profile closes the own-account docks…
    if (publicHandle) {
      setSettingsOpen(false);
      setProfileOpen(false);
      setSocialOpen(false);
      setDiscoverOpen(false);
    }
  }, [publicHandle]);
  useEffect(() => {
    // …and opening any own-account dock leaves the public profile.
    if (settingsOpen || profileOpen || socialOpen || discoverOpen) setPublicHandle(null);
  }, [settingsOpen, profileOpen, socialOpen, discoverOpen]);
  const closePublic = () => {
    window.history.pushState(null, "", "/");
    setPublicHandle(null);
  };
  const [me, setMe] = useState<Me | null>(null);
  const [kickedNotice, setKickedNotice] = useState<string | null>(null);
  // Read in loadTrackToDeck (defined above the room hook) to gate play-logging on sign-in.
  const signedInRef = useRef(false);
  signedInRef.current = !!me?.user;
  // Refresh account state on mount + whenever the Profile screen CLOSES (a sign-in/out
  // there changes connections, which the Sync screen + chin gating read). Deliberately
  // NOT on open: an open-time refetch resolved a beat after the dock had already shrunk
  // the board, then `setMe` installed a fresh object ref and re-rendered the whole board
  // a second time — the profile-only "double-jump" reflow. Skip the open edge, and dedupe
  // the result so an unchanged payload keeps the same ref (React bails the re-render), so
  // closing without any account change doesn't reflow the board either.
  const profileWasOpen = useRef(profileOpen);
  const didFetchMe = useRef(false);
  useEffect(() => {
    const opening = profileOpen && !profileWasOpen.current;
    profileWasOpen.current = profileOpen;
    if (didFetchMe.current && opening) return; // dock opening → no refetch (avoids the double-jump)
    didFetchMe.current = true;
    fetchMe()
      .then((m) => setMe((prev) => (JSON.stringify(prev) === JSON.stringify(m) ? prev : m)))
      .catch(() => {});
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
  // Imperative handle into the library so a hardware browse encoder (FLX4 wheel) can step
  // a row cursor and the LOAD A/B buttons load it — see the browse/load cases in onMidiEvent.
  const libRef = useRef<LibraryHandle>(null);
  useEffect(() => {
    try {
      localStorage.setItem("htl:libOpen", libOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [libOpen]);
  // Chin launchers. Library is the LEFT dock; Settings / Profile / Session SHARE the
  // RIGHT dock (one at a time — the old Search slot). On desktop the left + right docks
  // can both be open; on a phone they're full-screen panels, so opening one closes the
  // others (else they overlap — the mobile bug).
  const onPhone = () => window.matchMedia("(max-width: 768px)").matches;
  const closeRightDock = () => {
    setSocialOpen(false);
    setProfileOpen(false);
    setSettingsOpen(false);
    setDiscoverOpen(false);
  };
  const toggleLib = () => {
    // Functional update so the keyboard (Alt) and chin button never read a stale libOpen.
    setLibOpen((v) => {
      const next = !v;
      if (next && onPhone()) closeRightDock();
      return next;
    });
  };
  // The right-dock launchers TOGGLE (press the chin button again to close — no explicit
  // ✕). Opening one closes the other two; on a phone it also closes the full-screen
  // Library. Settings / Profile / Session are the same panel, swapped by which you press.
  const toggleSocial = () => {
    setSocialOpen((v) => {
      const next = !v;
      if (next) {
        setProfileOpen(false);
        setSettingsOpen(false);
        setDiscoverOpen(false);
        if (onPhone()) setLibOpen(false);
      }
      return next;
    });
  };
  const toggleDiscover = () => {
    setDiscoverOpen((v) => {
      const next = !v;
      if (next) {
        setSocialOpen(false);
        setProfileOpen(false);
        setSettingsOpen(false);
        if (onPhone()) setLibOpen(false);
      }
      return next;
    });
  };
  const toggleProfile = () => {
    setProfileOpen((v) => {
      const next = !v;
      if (next) {
        setSocialOpen(false);
        setSettingsOpen(false);
        setDiscoverOpen(false);
        if (onPhone()) setLibOpen(false);
      }
      return next;
    });
  };
  const toggleSettings = () => {
    setSettingsOpen((v) => {
      const next = !v;
      if (next) {
        setSocialOpen(false);
        setProfileOpen(false);
        setDiscoverOpen(false);
        if (onPhone()) setLibOpen(false);
      }
      return next;
    });
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
  // Per-deck timers for the PASSIVE remote-stem path: a snapshot can light a deck's stem
  // cells (hasStems) before — or without — the host's 4-lane envelopes arriving. If they
  // never come, surface a clear tell instead of a silently-dead mixer (#3). Cleared the
  // moment the view lands (onRoomStemView) or this device grows its own stems.
  const stemViewWaitTimers = useRef<Partial<Record<DeckId, ReturnType<typeof setTimeout>>>>({});
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
  // Per-deck drive permission for the keyboard/MIDI guards (E3/E4 seat model): a full
  // controller drives both decks, a stepped-up listener only their one deck. Read through a
  // ref so the input handlers see the live value without re-subscribing.
  const canDriveDeckRef = useRef<(id: DeckId) => boolean>(() => true);
  // Per-deck "current FX" index — the device selected in each deck's FX strip, mirrored up so
  // the gamepad's bypass-current action (R3) knows which device to flip.
  const fxSelRef = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
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
  // The videoId a deck is CURRENTLY decoding (set the moment the id resolves, before the
  // async decode). `latest.current.loaded` only updates a render AFTER the load lands, so a
  // room snapshot arriving mid-decode would see the deck as "empty" and fire a SECOND,
  // competing load — re-running applyFxSnapshot with a different chain → the effects
  // load-then-unload flicker. applyRoomSnapshot dedupes against this too, so a load already
  // in flight for a track is never doubled. Cleared only on a genuine failure (so a retry
  // can proceed); on success it stays = the loaded id, which is exactly the right dedupe key.
  const loadingVid = useRef<Record<DeckId, string>>({ A: "", B: "" });
  // Jog/scrub streaming: while we're locally scrubbing a deck, ignore the master's
  // inbound ticks for it (so they don't fight the scrub) and coalesce our streamed
  // seeks to one per animation frame.
  const scrubbing = useRef<Record<DeckId, boolean>>({ A: false, B: false });
  const jogDelta = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  const jogRaf = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  // FLX4 jog mode, latched from the controller's own CC stream: the hardware VINYL
  // button switches the top-plate CC (0x22 scratch / 0x23 bend), so the arriving tick
  // tells us the mode. Gates whether a touch grabs the platter (vinyl) or is inert
  // (non-vinyl, where the top plate just bends). Seeded from settings.jogVinylDefault
  // (the saved starting mode); flips the first time a scratch/bend-stream tick reveals
  // the unit's real mode. Kept in sync by the settings effect below.
  const jogVinyl = useRef<Record<DeckId, boolean>>({ A: settings.jogVinylDefault, B: settings.jogVinylDefault });
  const jogTouched = useRef<Record<DeckId, boolean>>({ A: false, B: false });
  // Accumulated jog motion (seconds) while editing a loop edge under GRID LOCK — the
  // continuous wheel is integrated and spent one whole beat at a time (see the jogTurn
  // handler), since a per-tick adjustBy would just re-snap to the same beat and stick.
  const loopAdjAcc = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  // The videoId we've already kicked off a room-driven load for (per deck), so a
  // repeated snapshot never aborts + restarts an in-flight decode.
  const roomLoadTarget = useRef<Record<DeckId, string | null>>({ A: null, B: null });
  // The last board snapshot we received, kept so that once a remote-driven track finishes
  // DECODING we can apply its discrete state (cue/loop/hot-cues/stems/fx) — the snapshot
  // that carried it was skipped while the decode was still in flight. `reconciledTarget`
  // dedupes so we reconcile a given videoId once (live edits after that flow via intents).
  const lastSnapshotRef = useRef<SessionSnapshot | null>(null);
  const reconciledTarget = useRef<Record<DeckId, string | null>>({ A: null, B: null });
  // P2 (snapshot/restore across a rig visit): `homeAdoptAt` = when applyRoomSnapshot last
  // adopted a real board (so the return-home logic can tell "the rig's live state already
  // restored me" from "I'm solo → replay preVisit"). `preVisitRef` = my own board, captured
  // the instant I leave home to visit another rig (in-memory → can't outlive this app load).
  const homeAdoptAt = useRef(0);
  const preVisitRef = useRef<SessionSnapshot | null>(null);
  const restoreTokenRef = useRef(0); // bumped each rig→home so a stale grace timer can't fire
  const restorePendingRef = useRef(false); // true during the return-home grace → don't persist the lingering visited board
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
    // If the window loses focus while Shift is held (alt-tab, address bar, an OS shortcut, a
    // permission prompt), the Shift keyUP lands on the other surface and we never see it — so
    // shiftHeld would stay stuck on, remapping every board key to its shifted variant. Clear
    // the held modifier whenever we lose the keyboard. (The on-screen SHIFT latch is a
    // deliberate toggle, so it is intentionally NOT cleared here.)
    const clear = () => setShiftHeld(false);
    const onVis = () => {
      if (document.visibilityState === "hidden") clear();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", onVis);
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
    // Keyboard/MIDI FX pad (1-8 in fx mode): no key-up, so a hold-FX toggles. Emit the
    // resulting phase over the board bus so it syncs + records like the on-screen pad.
    const fxKey = (deck: DeckRef, id: DeckId, i: number) => {
      const on = FX_PADS[i].hold ? !(FX_PADS[i].active?.(deck) ?? false) : true;
      fireFxPad(deck, i, on);
      emitRef.current({ kind: "board", deck: id, id: "fxPad", phase: on ? "down" : "up", arg: i });
    };
    const padModeKey = (deck: DeckRef, id: DeckId, m: "cue" | "loop" | "sampler" | "fx") => {
      deck.setPadMode(m);
      emitRef.current({ kind: "board", deck: id, id: "padMode", arg: m });
    };
    const jogBy = (deck: DeckRef, id: DeckId, s: boolean, beats: number) => {
      if (deck.adjusting) {
        // Boundary-adjust mode: arrows step the loop edge; lock follows the grid
        // magnet (snap to beats when on, fine sub-beat nudge when off).
        deck.adjustStep(beats);
        return;
      }
      // With a live loop, a jog TRAVELS the whole loop (rekordbox beat-jump-with-loop)
      // rather than skipping the playhead — shift forces it too. Otherwise it's a plain
      // beat-jump by the deck's skip (beatJump moves relative, so sub-beat skips advance).
      if (s || deck.loop?.active) deck.moveLoop(beats);
      else {
        deck.beatJump(beats);
        emitRef.current({ kind: "transport", deck: id, action: "seek", position: deck.position() });
      }
    };
    const STEMS = ["drums", "bass", "vocals", "other"] as const;
    const stem = (deck: DeckRef, id: DeckId, name: (typeof STEMS)[number], s: boolean) => {
      if (!deck.stemControlsReady) return;
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
      // Toggle bypass on the FX device currently selected in this deck's FX strip (gamepad R3).
      fxBypassCur: (deck, id) => {
        const i = fxSelRef.current[id];
        const dev = deck.fxDevices[i];
        if (!dev) return;
        const next = !dev.bypassed;
        deck.setFxBypass(i, next);
        emitRef.current({ kind: "fxBypass", deck: id, slot: i, value: next });
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
      spinback: (deck) => {
        deck.spinback(); // back-spin then catch to play (local audio effect)
      },
      slip: () => {
        // SLIP is a setting now (a scrub behaviour); Z toggles it for both decks.
        setSettings((s) => ({ ...s, slip: !s.slip }));
      },
      // FLX SMART CFX → bypass/restore the colour filter on BOTH decks at once (global button).
      filterToggle: () => {
        const on = !engine.deck("A").filterBypassed;
        engine.deck("A").setFilterBypass(on);
        engine.deck("B").setFilterBypass(on);
        refresh();
      },
      // FLX SMART FADER → enable/disable the crossfader and recentre it to 50% on each press.
      xfaderToggle: () => {
        setXfaderEnabled((e) => !e);
        setCrossfade(0);
        engine.setCrossfade(0);
        emitRef.current({ kind: "crossfade", value: 0 }); // sync the recentre to a session
      },
      // Pad-mode selectors — switch what the 8 pads (keys 1-8) do on the focused deck. Emit
      // over the board bus so the bank switch syncs + records (else replay shows the wrong pads).
      padModeCue: (deck, id) => padModeKey(deck, id, "cue"),
      padModeLoop: (deck, id) => padModeKey(deck, id, "loop"),
      padModeSampler: (deck, id) => padModeKey(deck, id, "sampler"),
      padModeFx: (deck, id) => padModeKey(deck, id, "fx"),
    };
    // The 8 pads (keys 1-8) route by the deck's pad mode: Hot Cue → cue, Loop → beat-loop
    // size, Sampler → that deck's region pad (via the sampler bridge ref), FX → a Pad-FX.
    // The keyboard has no per-key keyup, so a hold-FX TOGGLES here (press on / press off) and
    // a one-shot fires once; the on-screen pads stay true momentary.
    for (let i = 0; i < 8; i++)
      HANDLERS[`hotcue${i + 1}`] = (deck, id, s) =>
        deck.padMode === "loop"
          ? beatLoop(deck, id, i)
          : deck.padMode === "sampler"
            ? samplerCtl.current?.trigger(deckPadBase(id) + i)
            : deck.padMode === "fx"
              ? fxKey(deck, id, i)
              : hotcue(deck, id, s, i);
    handlersRef.current = HANDLERS; // expose to the MIDI dispatcher (same button behaviours)
    const keyIndex = bindingIndex(mergeBindings(settings.keyBindings));

    const onKey = (e: KeyboardEvent) => {
      // Never hijack typing or a modal that owns the screen.
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        // …but give the keyboard a way OUT of a lingering field (e.g. the Library filter box,
        // which keeps focus after you click it and otherwise swallows every board key with no
        // escape). Escape blurs it → focus returns to the body and the deck keys work again.
        if (e.key === "Escape") {
          el.blur();
          e.preventDefault();
        }
        return;
      }
      // Alt (on its own) toggles the Library dock — handled before the modifier guard.
      if (e.key === "Alt" && !e.repeat) {
        e.preventDefault();
        toggleLib();
        return;
      }
      // Every dock (Settings / Profile / Session / Library) SHARES the screen — keys keep
      // driving the decks while a panel is open. The cases that genuinely need the keyboard
      // guard themselves: a focused slider/input is caught by the tagName check above, and
      // the keybind-rebind chip captures in the CAPTURE phase + stopPropagation (KeyHelp),
      // so the next key lands on the binding, not the deck. No blanket panel guard needed.
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
      // A stepped-up listener may only key their OWN deck (focus-toggle above still works,
      // so they can still look at the other one). A full controller drives both.
      if (!canDriveDeckRef.current(id)) return;
      const deck = engine.deck(id);
      // Read Shift off the event too: a fast Shift+key combo can fire before the
      // on-screen latch state commits; `shift` folds that latch in.
      const s = shift || e.shiftKey;
      HANDLERS[actionId]?.(deck, id, s);
      refresh();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, doSync, shift, focused, matchGain, cycleTempoRange, cyclePitchRange, refresh, libOpen, settings.keyBindings]);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
    engine.deckA.setJogPhysics(settings.jogWeight, settings.jogDrag);
    engine.deckB.setJogPhysics(settings.jogWeight, settings.jogDrag);
    engine.deckA.setBendStrength(settings.jogBendStrength);
    engine.deckB.setBendStrength(settings.jogBendStrength);
    for (const d of [engine.deckA, engine.deckB]) {
      d.setVinylSpeed(settings.vinylSpeed, settings.vinylBrakeTime, settings.vinylStartTime);
      d.setBackSpinLength(settings.backSpinLength);
      d.setSlip(settings.slip); // Slip is a scrub behaviour now, driven from Controls (not a per-deck button)
    }
    // Re-seed the FLX4 jog-mode latch from the saved default (the CC stream re-latches
    // it on the next turn; this just sets the starting mode before the first tick).
    jogVinyl.current.A = jogVinyl.current.B = settings.jogVinylDefault;
    engine.setStretchConfig({
      ...stretchConfig(settings.stretchQuality),
      engine: settings.stretchEngine,
      transient: settings.stretchTransient,
      aa: settings.stretchAa,
      tThresh: settings.stretchTThresh,
    });
    setDemucsQuality(stemConfig(settings.stemQuality)); // desktop demucs-GPU quality knobs
  }, [settings, engine]);

  // Route the mix to the chosen output device (only re-applies when it changes, so a
  // theme tweak never re-routes audio). "" = system default.
  useEffect(() => {
    void engine.setSinkId(settings.audioOutputId);
  }, [engine, settings.audioOutputId]);

  // Route the headphone-cue (PFL) bus to a separate device. "" = no separate cue
  // (single output) — the CUE button stays a plain cue-point button.
  useEffect(() => {
    void engine.setCueSinkId(settings.audioCueOutputId);
  }, [engine, settings.audioCueOutputId]);

  // Chosen microphone input — remembered by the engine so the next enableMic() uses it, and
  // re-acquired live if the mic is already running. "" = system default mic.
  useEffect(() => {
    void engine.setMicDevice(settings.audioInputId);
  }, [engine, settings.audioInputId]);

  // While a deck is SEPARATING stems on-device, the separator worker's per-segment CPU
  // FFT bursts crowd the audio thread → the mid-split playback stutter. Raise the stretch
  // worklet's pre-roll FIFO headroom (~64 ms) so a pressured render quantum outputs
  // pre-built grains instead of running the WSOLA/PV search and overrunning its budget;
  // drop it back to 0 the instant separation ends (zero tempo/jog latency the rest of the
  // time). Both decks share one machine, so any deck separating bumps both. Only
  // "separating" (real on-device compute) — cache downloads don't contend.
  const separating = status.A?.phase === "separating" || status.B?.phase === "separating";
  useEffect(() => {
    engine.setStretchReserve(separating ? Math.round(engine.ctx.sampleRate * 0.064) : 0);
  }, [engine, separating]);

  // #14: a high-latency WIRELESS output (Bluetooth / CarPlay) has a jittery clock that starves
  // the render thread → skips/stutter. Detect it via ctx.outputLatency (a wired sink is
  // ~10-20 ms; BT/CarPlay 80 ms+) and raise the worklet's pre-roll so a late render quantum
  // coasts on pre-built grains. Mobile-only (where wireless routing is common + the CPU is
  // tightest); polled because the route flips when BT connects/disconnects mid-session. NOTE:
  // outputLatency is under-reported on some iOS builds — if it reads 0 there this stays off and
  // the stutter would need the fifo-underrun fallback (#14). Best-effort; needs device testing.
  useEffect(() => {
    if (!isMobileDevice()) return;
    const sr = engine.ctx.sampleRate;
    const max = Math.round(sr * 0.12); // ~120 ms — covers A2DP/CarPlay clock jitter
    // Primary path: the engine auto-ramps the pre-roll from the worklet's REAL dropout count
    // (the only signal iOS gives us on Bluetooth/CarPlay — outputLatency reads 0 there).
    engine.setWirelessAuto(true);
    const probe = () => {
      // Optional manual force (Settings ▸ Audio): pin the full reserve always-on instead of
      // waiting for the auto-ramp to catch the first few skips.
      if (settings.wirelessOutput) {
        engine.setWirelessReserve(max);
        return;
      }
      // Predictive bonus where the browser is honest about it (Android Chromium): a high
      // reported outputLatency pre-buffers before any dropout. No-op on iOS (reads 0).
      const lat = (engine.ctx as unknown as { outputLatency?: number }).outputLatency ?? 0;
      const reserve = lat > 0.06 ? Math.min(Math.round(lat * sr * 1.5), max) : 0;
      engine.setWirelessReserve(reserve);
    };
    probe();
    const iv = window.setInterval(probe, 3000);
    return () => {
      window.clearInterval(iv);
      engine.setWirelessReserve(0);
      engine.setWirelessAuto(false);
    };
  }, [engine, settings.wirelessOutput]);

  // Mirror settings to the account when signed in (last-write-wins by timestamp), so
  // theme/stem/keybind prefs follow the user across devices.
  useSettingsSync(settings, setSettings);
  // Same for the Collection + Playlists — curation follows the user across devices (audio
  // itself doesn't need syncing: R2 is a shared cache and anything missing re-resolves).
  useLibrarySync(library);


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

  // MOBILE: a single global "use stems on this device" preference (Settings ▸ Stems). A phone
  // defaults to the plain mix (Single, lightest) and derives on-device stems for every loaded
  // deck only when this is on. deriveStems' mix-only gate reads this ref; AUTO additionally
  // forces stems (a stem transition needs both decks) via autoEnabledRef below. Desktop ignores
  // both (it follows the model / auto-enhance as before).
  const mobileStemsRef = useRef(settings.mobileStems);
  mobileStemsRef.current = settings.mobileStems;
  // AUTO on → force mobile stems regardless of the toggle (assigned where autoStatus exists).
  const autoEnabledRef = useRef(false);
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
          // Stamp the dedup key with the PROMOTED model so selecting that model later
          // sees "already separated" (deriveStems' hasStems guard) instead of re-running
          // a separation over the stems we just promoted. (The bug: promote never set this.)
          stemLoadedKey.current[id] = `${videoId}:${mid}`;
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
          stemLoadedKey.current[id] = `${videoId}:${mid}`; // promoted set → don't re-separate it
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
      // In a SESSION whose host is using stems, a phone derives a local DSP set even when its OWN
      // model is "Single" — otherwise a guest sees the host's stem moves but can't HEAR them (the
      // original bug). It falls through to the mobile DSP path below; everyone else treats "off" as
      // the plain no-stems mix.
      const sessionWantsStems =
        isMobileDevice() && snapFollowRef.current && !!lastSnapshotRef.current?.decks?.[id]?.hasStems;
      // LAZY MOBILE-GUEST STEMS (the OOM fix): the deck holds per-stem gain/mute state
      // buffer-free, so a phone session-follower only needs to MATERIALISE real stems once a
      // stem control actually diverges from default (the host ducked/muted one, or a local
      // touch). An idle "just listening" guest — the common case — stays mix-only and skips
      // the ~370 MB resident + ~352 MB transition-transient DSP set that was jetsam-killing
      // phones. `ensureGuestStems` re-invokes deriveStems the instant a value diverges, and
      // this gate then falls through to the on-device DSP derive below. Desktop is unchanged
      // (sessionWantsStems is mobile-only, so the second clause never fires there).
      const stemDiverged = STEM_KEYS.some(
        (n) => engine.deck(id).stemLevel(n) !== 1 || !engine.deck(id).stemActive(n),
      );
      // Mobile wants stems when the global toggle is on (Settings ▸ Stems) OR AUTO is running
      // (a stem transition needs both decks) → fall through to the on-device DSP / cached-neural
      // path regardless of the mix-only gate.
      const mobileWantStems = isMobileDevice() && (mobileStemsRef.current || autoEnabledRef.current);
      if (model.id === "off" && !mobileWantStems && (!sessionWantsStems || (isMobileDevice() && !stemDiverged))) {
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

      // MOBILE BASELINE = the on-device DSP split. Phones can't run neural separation (OOM /
      // mobile-WebGPU crash), so they used to fall back to a dead mix — the stem mixer lit up
      // but nothing drove it, and a session guest couldn't HEAR the host's stem moves. The
      // engine now holds stems as int16 with ONE shared-offset WSOLA (no per-stem stretch
      // duplication), so four stems fit in a phone's budget. Derive them locally with the
      // lightweight DSP separator (pure Web Audio, deterministic, sums back to the mix exactly):
      // the per-stem mixer works and its mute/gain INTENTS sync per device, zero extra bandwidth.
      // Neural stays a desktop/upgrade quality tier that swaps in seamlessly via setStems().
      if (mobile) {
        // MOBILE = FETCH + RENDER ONLY. Phones NEVER run on-device separation (neural or the
        // DSP split): that heavy offline render competes with the audio thread and — once it
        // packs int16 + frees the mix — can leave the deck silent if anything in the pack
        // path hiccups. Instead: if a neural set is cached in R2 (the host warmed it, or a
        // past listener), DOWNLOAD + render it; otherwise stay on the PLAIN MIX, which is
        // already in the worklet from setBuffer (so we KEEP the buffer — never releaseMixBuffer
        // on this path — and the deck just keeps playing the mix).
        setStatusFor(id, { phase: "downloading", detail: "Checking for shared stems…" });
        await whenIdle();
        if (stale?.()) return;
        try {
          // Serialise across decks (one download/decode at a time) + the AGGREGATE stem budget,
          // same as before — a 2-deck cached set is the same int16 footprint as a derived one.
          const run = mobileDeriveChain.then(async () => {
            const otherId: DeckId = id === "A" ? "B" : "A";
            const otherSec = engine.deck(otherId).hasStems ? engine.deck(otherId).duration : 0;
            if (mix.duration + otherSec > MOBILE_MAX_COMBINED_STEM_SECONDS) return { kind: "over" as const };
            // SHARED NEURAL CACHE ONLY. Probe R2 best-first; the first complete set wins and is
            // DOWNLOADED (loadStems takes the no-separation branch on a complete manifest).
            for (const mid of PROMOTE_ORDER) {
              const man = await fetchStemManifest(videoId, mid).catch(() => null);
              if (stale?.()) return { kind: "stale" as const };
              if (!man?.complete) continue;
              const m = getStemModel(mid);
              const src = stemSrcLabel(mid);
              setStatusFor(id, { phase: "downloading", src, detail: `Host's ${m.label} stems — downloading…` });
              try {
                const onPct = (pct: number) => {
                  const p = Math.round(pct * 100);
                  setStatusFor(id, { phase: "downloading", src, pct: p, detail: `Downloading ${m.label} stems… ${p}%` });
                };
                // Decode+pack ONE stem at a time (never the full float32 set) → the OOM-safe path
                // that fixes the 2-long-track crash-loop. null = cache incomplete → float32 fallback.
                const packed = await loadStemsPackedInt16(engine.ctx, videoId, m, onPct);
                if (packed) return { kind: "neuralPacked" as const, packed, mid };
                const stems = await loadStems(engine.ctx, videoId, mix, m, onPct);
                return { kind: "neural" as const, stems, mid };
              } catch {
                break; // download failed → plain mix
              }
            }
            return { kind: "none" as const }; // nothing cached → plain mix (NO on-device separation)
          });
          mobileDeriveChain = run.catch(() => undefined);
          const res = await run;
          if (stale?.() || res?.kind === "stale") return;
          if (res?.kind === "neural") {
            engine.deck(id).setStems(res.stems, true); // packs int16 + builds lanes + frees float32
            stemLoadedKey.current[id] = `${videoId}:${res.mid}`;
            // Stems are the worklet's audio source now → free the ~92 MB float32 mix.
            engine.deck(id).releaseMixBuffer();
            dropCachedBuffer(videoId);
            refresh();
            const lanes = Object.keys(engine.deck(id).stemPyramids ?? {}).length;
            setStatusFor(id, { phase: "ready", src: stemSrcLabel(res.mid), detail: `${getStemModel(res.mid).label} stems · ${lanes} lanes` });
          } else if (res?.kind === "neuralPacked") {
            engine.deck(id).loadPackedStems(res.packed, true); // int16 direct — no float32 set ever held
            stemLoadedKey.current[id] = `${videoId}:${res.mid}`;
            // Stems are the worklet's audio source now → free the ~92 MB float32 mix.
            engine.deck(id).releaseMixBuffer();
            dropCachedBuffer(videoId);
            refresh();
            const lanes = Object.keys(engine.deck(id).stemPyramids ?? {}).length;
            setStatusFor(id, { phase: "ready", src: stemSrcLabel(res.mid), detail: `${getStemModel(res.mid).label} stems · ${lanes} lanes` });
          } else {
            // No cached stems (or over budget) → PLAIN MIX. The worklet already holds it from
            // setBuffer; KEEP the buffer (do NOT releaseMixBuffer) so playback never goes silent.
            engine.deck(id).setStems(null);
            stemLoadedKey.current[id] = guardKey;
            refresh();
            setStatusFor(id, {
              phase: "unavailable",
              detail:
                res?.kind === "over"
                  ? "Both tracks exceed the on-device stem budget — this deck plays the mix."
                  : "No shared stems for this track yet — playing the mix.",
            });
            setTimeout(() => !stale?.() && setStatusFor(id, null), 5000);
          }
        } catch (e) {
          console.warn("[htl] mobile stem fetch failed:", e);
          engine.deck(id).setStems(null); // plain mix; un-latch so a re-tap / reload can retry
          deriveGuard.current[id] = "";
          setStatusFor(id, { phase: "unavailable", detail: "Couldn't load shared stems — playing the mix." });
          setTimeout(() => !stale?.() && setStatusFor(id, null), 5000);
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

  // LAZY MOBILE-GUEST STEMS trigger (pairs with the divergence gate in deriveStems above).
  // When a stem control diverges from default on a phone guest that's currently mix-only,
  // materialise its stems NOW so the divergence is audible. Idle guests never reach this and
  // stay light (the OOM fix). Held in a ref so the session intent/snapshot handlers can call
  // it without taking it as a dependency (keeps their closures — co-owned with the session
  // agent — untouched). Self-guards: no-op on desktop, when this deck already has its OWN
  // real stems, or when nothing has actually diverged.
  //
  // CRITICAL: skip on `ownStems`, NOT `hasStems || remoteStems`. When the host is mixing
  // stems it streams the per-deck envelopes, and a phone follower calls markRemoteStems →
  // `remoteStems = true` (a DISPLAY mirror, `stems` is still null). The old guard then
  // bailed because `remoteStems` was set, so the listener showed the 4-lane viz but never
  // downloaded the real stem AUDIO → the host's mute/duck did nothing and you heard the flat
  // mix. Materialising real stems OVER the mirror (setStems clears remoteStems) makes the
  // host's stem moves audible; an idle follower (no divergence) still stays light.
  const ensureGuestStemsRef = useRef<(id: DeckId) => void>(() => {});
  ensureGuestStemsRef.current = (id: DeckId) => {
    if (!isMobileDevice()) return;
    const deck = engine.deck(id);
    if (deck.ownStems) return; // already have our OWN real stems (a remote-display mirror does NOT count)
    const vid = latest.current.loaded[id];
    if (!vid || !deck.buffer) return;
    if (!STEM_KEYS.some((n) => deck.stemLevel(n) !== 1 || !deck.stemActive(n))) return; // no divergence
    deriveGuard.current[id] = ""; // allow a fresh derive even for the same (track, model)
    void deriveStems(id, vid, deck.buffer, () => latest.current.loaded[id] !== vid);
  };

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
      // P2: while VISITING another rig (or during the return-home grace, when the decks still
      // mirror the visited board) the local engine reflects THEIR board — never let it overwrite
      // my own solo board in localStorage, or a cold reopen would boot into the visited set. My
      // board stays the last thing persisted before I left.
      if (roomRef.current?.attachment.to === "rig" || restorePendingRef.current) return;
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
      let landed = false; // set once the track is on the deck → keep the loadingVid claim
      let claimedVid = ""; // the id this load claimed in loadingVid (try-scoped vid isn't visible in finally)
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
      captionVidRef.current[id] = ""; // no captions belong to the incoming track yet
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
        // No resolved id → BAIL. Everything downstream (audio/stem/analysis caches, setBuffer)
        // keys off `vid`; an empty string collides across EVERY unresolved track, so a load
        // would fetch the previous track's cached buffer while the new title shows ("plays the
        // last song"). Fail cleanly instead of corrupting the cache under "".
        if (!vid) {
          setStatusFor(id, { phase: "failed", detail: "Couldn't find a playable source for this track." });
          return;
        }
        // Claim this deck's in-flight load so a concurrent room snapshot won't double-load it.
        loadingVid.current[id] = vid;
        claimedVid = vid;
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
            captionVidRef.current[id] = vid; // these lines belong to THIS track
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
        landed = true; // the track is on the deck — keep the loadingVid claim as the dedupe key
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
            videoId: track.videoId || null,
            thumbnail: track.thumbnail ?? null,
          },
        }));
        setStatusFor(id, null);
        refresh();
        // Persist the freshly-analysed BPM/key so the LIBRARY columns fill in (and survive a
        // refresh), keyed by EVERY id this track is known under. The analysis cache + deck use
        // the resolved `vid`, but a library row may key off the ORIGINAL `track.videoId` (e.g. a
        // Spotify/Tidal row whose id resolved to a different YouTube `vid`) — so write to both,
        // AND alias the analysis cache under track.videoId so `withCached` (which reads
        // getCachedTrack(row.videoId)) backfills those rows too, not only the resolved id.
        if (track.videoId && track.videoId !== vid) setCachedTrack(track.videoId, cached);
        for (const aid of new Set([vid, track.videoId].filter(Boolean) as string[])) {
          if (cached.analysis.bpm != null) library.setBpm(aid, cached.analysis.bpm);
          if (cached.analysis.key) library.setKey(aid, cached.analysis.key.camelot);
        }
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
        if (!stale()) {
          setLoading((l) => ({ ...l, [id]: false }));
          // This load is the current one but never landed (failed) → release the in-flight
          // claim so a room snapshot / retry can load this track. On success keep it.
          if (!landed && claimedVid && loadingVid.current[id] === claimedVid) loadingVid.current[id] = "";
        }
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
            videoId: null, // local file — no catalog id, so not drag-to-add-able
            thumbnail: null,
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
    if (launchingSetRef.current) return; // a /set/ deep link owns the decks → don't flash the old board
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
      if (d.eqLowShape != null) deck.setEqLowShape(d.eqLowShape);
      if (d.eqMidShape != null) deck.setEqMidShape(d.eqMidShape);
      if (d.eqHighShape != null) deck.setEqHighShape(d.eqHighShape);
      if (d.eqLowQ != null) deck.setEqLowQ(d.eqLowQ);
      if (d.eqHighQ != null) deck.setEqHighQ(d.eqHighQ);
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
      // #3 self-heal: the snapshot may have lit this deck's stem cells (markRemoteStems)
      // without the host's 4-lane envelopes yet present. stemControlsReady already gates
      // the cells so they can't drive nothing, but don't leave them silently waiting —
      // arm a tell if the view still hasn't landed after a grace period (cleared in
      // onRoomStemView the instant it arrives, or once this device grows its own stems).
      if (isMobileDevice() && deck.remoteStems && !deck.stemPyramids) {
        if (stemViewWaitTimers.current[id]) clearTimeout(stemViewWaitTimers.current[id]);
        stemViewWaitTimers.current[id] = setTimeout(() => {
          stemViewWaitTimers.current[id] = undefined;
          const dk = engine.deck(id);
          if (dk.ownStems || dk.stemPyramids) return; // arrived / own stems → all good
          setStatusFor(id, { phase: "downloading", detail: "Waiting for the host's stems…" });
        }, 7000);
      }
      if (deck.fxOn !== (d.fxOn ?? true)) deck.setFx(d.fxOn ?? true);
      if (deck.keylock !== d.keylock) deck.setKeylock(d.keylock);
      if (deck.quantizing !== d.quantize) deck.setQuantize(d.quantize);
      // The FX RACK (Delay/Reverb/Saturator…) — reconcile it too, so a track loaded via a `load`
      // intent (no restore snapshot) gets its backing effects. Without this the ECHO/VERB/SAT
      // throws fire into an empty rack (silent) on replay AND for a guest who loaded by intent.
      // Per-videoId dedupe (reconciledTarget) means this runs once per load, not over live edits.
      if (d.fx !== undefined) deck.applyFxSnapshot(d.fx);
    },
    [engine, setStatusFor],
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
        if (d.videoId && d.videoId !== loadedId && d.videoId !== roomLoadTarget.current[id] && d.videoId !== loadingVid.current[id]) {
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
      homeAdoptAt.current = performance.now(); // P2: a real board was adopted (cancels a pending preVisit restore)
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

  // Drives the auto-mixer from a remote's "automix" intent — assigned where the mixer
  // is set up (far below); a ref so applyIntent can reach it from up here.
  const autoMixerControlRef = useRef<(action: "toggle" | "skip" | "mixnow" | "hold") => void>(() => {});
  // The single canonical auto-mix queue + whether THIS device is a queue-mirroring remote
  // (vs the authority that owns + broadcasts the queue). Refs so the high-up applyIntent
  // can reach the queue (defined far below) and gate who mutates it.
  const mixQueueRef = useRef<MixQueue | null>(null);
  const autoIsRemoteRef = useRef(false);
  // Plays a co-DJ's sampler pad fire — assigned where the sampler is set up (far below).
  const samplerApplyRef = useRef<((intent: Extract<Intent, { kind: "sample" }>) => void) | null>(null);

  // Apply ONE control intent to the local engine — used for both inbound remote
  // intents and our own actions. Pure local effect, no network.
  const applyIntent = useCallback(
    (intent: Intent) => {
      if (intent.kind === "automix") {
        autoMixerControlRef.current(intent.action);
        return;
      }
      // Board-agnostic gesture (pad mode, FX-pad throw, …) — the registry owns the semantics,
      // so new board controls sync + replay without touching this switch. onRoomIntent refreshes.
      if (intent.kind === "board") {
        applyBoardAction(engine.deck(intent.deck), intent.id, intent.phase, intent.arg);
        return;
      }
      if (intent.kind === "queue") {
        // Only the queue AUTHORITY (the device running the auto-mixer + broadcasting the
        // automix stream) mutates the canonical queue; it then re-streams so everyone
        // converges 1:1. A mirroring remote ignores it — its local queue is unused, and
        // applying here would fork a second copy. The seed/mode stay host-owned (radio
        // engine); remotes only add/remove/move individual tracks.
        const q = mixQueueRef.current;
        if (autoIsRemoteRef.current || !q) return;
        if (intent.action === "add") q.enqueue(intent.track as TrackMeta);
        else if (intent.action === "addNext") q.enqueueNext(intent.track as TrackMeta);
        else if (intent.action === "remove") q.remove(intent.videoId);
        else if (intent.action === "move") q.moveById(intent.videoId, intent.to); // id-based: the right track even if from-index was stale
        return;
      }
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
      // A co-DJ fired a sampler pad — reconstruct it locally (region off our own deck buffer,
      // global by fetching the host's clip). Has no `deck` field, so handle before that lookup.
      if (intent.kind === "sample") {
        samplerApplyRef.current?.(intent);
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
          else if (intent.param === "eqLowQ") deck.setEqLowQ(intent.value);
          else if (intent.param === "eqHighQ") deck.setEqHighQ(intent.value);
          else if (intent.param === "eqLowShape") deck.setEqLowShape(intent.value);
          else if (intent.param === "eqMidShape") deck.setEqMidShape(intent.value);
          else if (intent.param === "eqHighShape") deck.setEqHighShape(intent.value);
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
        case "fxParam":
          // A post-EQ effect knob moved on a controller — high-frequency live sync.
          deck.setFxParam(intent.slot, intent.param, intent.value);
          refresh();
          break;
        case "fxBypass":
          deck.setFxBypass(intent.slot, intent.value);
          refresh();
          break;
        case "fxRack":
          // Add/remove/reorder the effect chain (or a late joiner catching up): reconcile
          // the whole list — kinds + order rebuild, params + bypass re-applied.
          deck.applyFxSnapshot(intent.rack);
          refresh();
          break;
        case "stemGain":
          // Apply regardless of local stems — the deck holds gain/mute state buffer-
          // free, so a mix-only remote stays in sync and reflects it on its cells.
          deck.setStemGain(intent.stem, intent.value);
          ensureGuestStemsRef.current(intent.deck); // phone guest: materialise stems if this diverged
          break;
        case "stem":
          deck.setStemMute(intent.stem, !intent.on);
          ensureGuestStemsRef.current(intent.deck);
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
          // Steady audible playback. The tick is a STALE snapshot of a moving clock and REAL
          // rewinds arrive as seek INTENTS (see the transport handler) — so the tick must only
          // ever pull a follower FORWARD, when it has genuinely fallen BEHIND (decoded late /
          // drifted slow). A positive lead is just network latency, or an anchor whose audio
          // clock is momentarily FROZEN (a suspended mobile master sends a non-advancing pos
          // with playing:true); seeking BACKWARD to that stale pos — then replaying it every
          // grace window — was the "loops a ~second forever, never catches up" bug. So correct
          // only a real lag, never a lead. 1.2s grace prevents back-to-back catch-ups.
          const behind = t.pos - deck.position(); // >0 = we're behind the already-stale tick
          if (behind > 0.6 && now - followSeekAt.current[id] > 1200) {
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
          // Phone guest: if the anchor's snapshot carries a diverged stem (e.g. it was already
          // muted when we joined), materialise local stems so it's audible. No-op when nothing
          // diverged (idle session stays mix-only → the OOM fix).
          ensureGuestStemsRef.current(id);
        }
        // Feed the follower visual clock + the anchor's effective RATE: the waveform glides at
        // the display rate off a wall-clock extrapolation of this tick, and a listener's own
        // audio re-speeds to the host's rate so it stops drifting (the host's jog-bend /
        // sync-trim never cross as intents). See Deck.visualPosition / followTick.
        deck.followTick(t.pos, t.playing, t.rate);
      });
      if (flipped) refresh();
    },
    [engine, refresh],
  );

  // ── G1c: recorded-set replay ──────────────────────────────────────────────────
  // A replay drives the SAME live-listener handlers from a local clock instead of the WS.
  // replayDispatch routes a recipe message to its handler; pauseAudio halts both decks (they
  // run their own clock once a transport intent starts them). The follow gates below are
  // forced open while replay.active so the handlers don't no-op outside a session.
  const replayDispatch = useCallback(
    (m: ClientMsg) => {
      if (m.t === "state") applyRoomSnapshot(m.snapshot);
      else if (m.t === "intent") onRoomIntent(m.intent);
      else if (m.t === "tick") onRoomTick(m.decks);
      else if (m.t === "automix") setRemoteAutomix(m.state as AutoMixMirror | null);
    },
    [applyRoomSnapshot, onRoomIntent, onRoomTick],
  );
  const replay = useSetReplay({
    dispatch: replayDispatch,
    pauseAudio: () => {
      engine.deck("A").pause();
      engine.deck("B").pause();
    },
  });
  // Replay a recorded set on the decks (from Profile / Discover / a public profile). Tune out
  // of a live broadcast-listen first (only real conflict), prime audio, then close the docks so
  // the board is visible — the replay bar drives from there.
  // Replay a set. `range` plays just the curated [start,end] (the set's trim); omit for full.
  const playRecordedSet = useCallback(
    (id: string, range?: { start: number; end: number }) => {
      if (roomRef.current?.listeningTo) roomRef.current.tuneOut();
      engine.unlock();
      setTrimEdit(null);
      replay.play(id, range);
      setProfileOpen(false);
      setDiscoverOpen(false);
      setPublicHandle(null);
    },
    [engine, replay],
  );
  playSetRef.current = playRecordedSet; // wire the /set/ deep-link launcher to the real handler
  // The owner curates a set: replay the FULL recording + open trim controls (set in/out → save).
  const [trimEdit, setTrimEdit] = useState<{ id: string; start: number; end: number } | null>(null);
  const editTrim = useCallback(
    (s: { id: string; trimStart?: number | null; trimEnd?: number | null; duration: number }) => {
      if (roomRef.current?.listeningTo) roomRef.current.tuneOut();
      engine.unlock();
      replay.play(s.id); // full, so they can scrub the whole tape
      setTrimEdit({ id: s.id, start: s.trimStart ?? 0, end: s.trimEnd ?? s.duration });
      setProfileOpen(false);
      setPublicHandle(null);
    },
    [engine, replay],
  );

  // A stem view that arrived for a track this deck hasn't finished decoding yet (the
  // catch-up burst on join races the deck load) — stashed here and re-applied the moment
  // loaded[deck] catches up, so an anon/mobile listener doesn't lose stems forever.
  const pendingStemView = useRef<Record<DeckId, { videoId: string; view: StemView } | null>>({ A: null, B: null });
  // A peer's stem waveform envelopes arrived (the host streams them) → rebuild this
  // deck's 4-lane display from them, even though we hold no local stem PCM (mobile).
  const onRoomStemView = useCallback(
    (deck: DeckId, view: unknown) => {
      try {
        const d = engine.deck(deck);
        // Local stems (the on-device DSP baseline) win over a streamed remote view — keep this
        // device's display and audio consistent instead of painting the host's envelopes over
        // stems we actually play. Without local stems, mirror the host's view as before.
        if (d.ownStems) return;
        // Slot-vs-song guard: a stem view is keyed only by deck on the wire, so a view for
        // the PREVIOUS track (a racing relay / stale DO catch-up) could paint over the song
        // now loaded here. Drop it unless its videoId matches what's actually on this deck.
        // (Older peers omit videoId → render best-effort, as before.)
        const sv = view as StemView;
        const here = latest.current.loaded[deck];
        if (sv?.videoId && here && sv.videoId !== here) {
          // Track still decoding (or a different track loading) — stash, don't drop. The
          // flush effect re-applies it once loaded[deck] becomes this view's videoId.
          pendingStemView.current[deck] = { videoId: sv.videoId, view: sv };
          return;
        }
        pendingStemView.current[deck] = null;
        d.setRemoteStemView(sv);
        // The host's stems are now displayed here — cancel any pending "couldn't deliver"
        // timer, clear the "Requesting…" chip, and show the view is live from the host.
        if (stemReqTimers.current[deck]) {
          clearTimeout(stemReqTimers.current[deck]);
          stemReqTimers.current[deck] = undefined;
        }
        if (stemViewWaitTimers.current[deck]) {
          clearTimeout(stemViewWaitTimers.current[deck]);
          stemViewWaitTimers.current[deck] = undefined;
        }
        setStatusFor(deck, { phase: "ready", src: "host", detail: "Stems from the session host." });
        refresh();
      } catch {
        /* malformed view — ignore */
      }
    },
    [engine, refresh, setStatusFor],
  );

  // Flush a stashed stem view once this deck finishes decoding its matching track (the join
  // catch-up streamed the view before the deck had loaded — without this, a mobile/anon
  // listener that races the load loses the host's stems permanently). Keyed on `loaded`.
  useEffect(() => {
    (["A", "B"] as DeckId[]).forEach((id) => {
      const p = pendingStemView.current[id];
      if (!p || loaded[id] !== p.videoId) return;
      const d = engine.deck(id);
      pendingStemView.current[id] = null;
      if (d.ownStems) return; // grew its own stems meanwhile → local wins
      d.setRemoteStemView(p.view);
      if (stemViewWaitTimers.current[id]) {
        clearTimeout(stemViewWaitTimers.current[id]);
        stemViewWaitTimers.current[id] = undefined;
      }
      setStatusFor(id, { phase: "ready", src: "host", detail: "Stems from the session host." });
      refresh();
    });
  }, [loaded, engine, refresh, setStatusFor]);

  // Instant cross-device colour sync (inbound): a same-account device re-themed → adopt its
  // colours here too. The DO relays this ONLY between the owner's own devices, so it never
  // carries another account's look. LWW on the shared timestamp so a stale echo can't stomp a
  // fresher local edit; prime liveColorSig to the merged value so adopting doesn't re-broadcast.
  const liveColorSig = useRef<string | null>(null);
  const onRoomSettings = useCallback((data: unknown, updatedAt: number) => {
    if (!data || typeof data !== "object" || !(updatedAt > localTs())) return;
    const src = data as Record<string, unknown>;
    const incoming: Record<string, unknown> = {};
    for (const k of COLOR_PROFILE_KEYS) if (src[k] !== undefined) incoming[k] = src[k];
    if (Object.keys(incoming).length === 0) return;
    stampLocal(updatedAt);
    setSettings((s) => {
      const merged = { ...s, ...incoming } as Settings;
      liveColorSig.current = colorSig(merged); // so the broadcast effect sees no change → no echo
      return merged;
    });
  }, []);

  // The host streams its resolved, word-timed lyrics → apply them to this deck's caption ribbon
  // (and persist), so a guest gets the SAME playhead-accurate captions the host sees — even on a
  // phone (no GPU) or with the YouTube engine. The host's stream wins over any local fallback.
  const onRoomLyrics = useCallback(
    (deck: DeckId, videoId: string, lines: unknown, source: string) => {
      const ls = lines as LyricsLine[];
      if (!Array.isArray(ls) || ls.length === 0) return;
      // Only apply/cache the host's lyrics if THIS deck is actually showing that track —
      // otherwise a timing race (host on a different track, or mid-load) would paint and
      // persist the wrong track's lyrics (the cross-track contamination). Always cache the
      // (videoId, lines) pair though: it's correct for that id even if not for this deck now.
      const src = (source as LyricsSource) || "whisper";
      cacheRemoteLyrics(videoId, ls, src);
      if (videoId && videoId !== latest.current.loaded[deck]) return;
      captionVidRef.current[deck] = videoId;
      setCaptions((c) => ({ ...c, [deck]: ls }));
      setCaptionSource((s) => ({ ...s, [deck]: src }));
    },
    [],
  );

  // User "reprocess lyrics": wipe this deck's cached/pooled transcript and re-resolve from
  // scratch — the escape hatch for wrong/contaminated lyrics. `engineOverride` picks the
  // source: "whisper" re-decodes the vocal stem on-device; "youtube" pulls fresh captions.
  const reprocessLyrics = useCallback(
    (id: DeckId, engineOverride?: "whisper" | "youtube") => {
      const vid = latest.current.loaded[id];
      if (!vid) return;
      const seq = loadSeq.current[id];
      const stale = () => seq !== loadSeq.current[id];
      const eng = engineOverride ?? (lyricsModelRef.current === "youtube" ? "youtube" : "whisper");
      captionVidRef.current[id] = "";
      setCaptions((c) => ({ ...c, [id]: [] })); // drop the wrong lyrics immediately
      setCaptionSource((s) => ({ ...s, [id]: null }));
      setLyricStatus((s) => ({ ...s, [id]: eng === "youtube" ? "Reloading captions…" : "Reprocessing lyrics…" }));
      void resolveLyrics({
        videoId: vid,
        deck: engine.deck(id),
        model: lyricsModelRef.current === "small" ? "small" : "base",
        engine: eng,
        force: true,
        enabled: true, // explicit user action → decode even if auto-lyrics is off
        sampleRate: engine.ctx.sampleRate,
        stale,
        onCues: (cues, source) => {
          if (stale()) return;
          captionVidRef.current[id] = vid;
          setCaptions((c) => ({ ...c, [id]: cues }));
          setCaptionSource((s) => ({ ...s, [id]: source }));
        },
        onStatus: (msg) => {
          if (!stale()) setLyricStatus((s) => ({ ...s, [id]: msg }));
        },
      });
    },
    [engine],
  );

  // What the broadcast directory shows as "now playing": the loaded deck the crossfader
  // favours (so a mid-mix reads as the incoming track). Fed to the host's announce heartbeat.
  const nowPlaying = useMemo<NowPlaying | null>(() => {
    const pick: DeckId | null =
      crossfade > 0 && meta.B.videoId ? "B" : meta.A.videoId ? "A" : meta.B.videoId ? "B" : null;
    if (!pick) return null;
    const m = meta[pick];
    return m.videoId ? { title: m.name || "", artist: m.artist || "", videoId: m.videoId } : null;
  }, [meta, crossfade]);

  const room = useRoom(
    {
      onState: applyRoomSnapshot,
      onIntent: onRoomIntent,
      onAutomix: (s) => setRemoteAutomix(s as AutoMixMirror | null),
      onTick: onRoomTick,
      onStemView: onRoomStemView,
      onLyrics: onRoomLyrics,
      onSettings: onRoomSettings,
      onKicked: (reason) => setKickedNotice(reason || "You left the session."),
    },
    settings.accentA, // our account accent → synced so the room can take the host's vibe
    nowPlaying,
  );

  // The Profile dock is where a handle gets claimed; on its close, refresh the room's
  // account view so "Go live" un-gates (room.user.handle) without a page reload.
  useEffect(() => {
    if (!profileOpen) room.refreshUser();
  }, [profileOpen, room.refreshUser]);

  // Contextual room colour: while CONNECTED to a session (and opted in), wear the HOST's
  // accent so the whole room shares a vibe. Gated on being connected (status online) rather
  // than fully joined, so a guest catches the vibe the moment they're in the room — even
  // mid-handshake — instead of only after approval. Override ONLY the global --accent (not
  // the per-deck colours) and revert to our own the moment we're solo or opt out. (Note:
  // same-account devices share an accent, so there's correctly nothing to inherit there —
  // the vibe is visible when a guest on a DIFFERENT account has a different accent.)
  useEffect(() => {
    const body = document.body;
    const vibe =
      room.status === "online" && settings.inheritRoomColor && room.hostColor && room.hostColor !== settings.accentA;
    // Paint the vibe on <body>, NOT :root. applySettings owns :root's --neon-cyan/--accent and
    // rewrites them on every settings change — an override THERE gets clobbered the next time the
    // guest touches any setting. <body> sits below :root but above the whole app, so its custom-prop
    // overrides win for the entire tree while present, and removing them falls cleanly back to the
    // device's own theme. Override the PRIMARY accent (--neon-cyan) too, not just bare --accent: most
    // chrome is coloured off --neon-cyan, so an --accent-only override was nearly invisible — the
    // reported "room colour not syncing". Decks keep their identity (each bank sets --accent inline,
    // which is more specific; waveforms take their colour via props, not the CSS var).
    if (vibe) {
      body.style.setProperty("--accent", room.hostColor!);
      body.style.setProperty("--neon-cyan", room.hostColor!);
    } else {
      body.style.removeProperty("--accent");
      body.style.removeProperty("--neon-cyan");
    }
    return () => {
      body.style.removeProperty("--accent");
      body.style.removeProperty("--neon-cyan");
    };
  }, [room.status, room.hostColor, settings.inheritRoomColor, settings.accentA]);

  // Instant cross-device colour sync (outbound): the moment I re-theme, push my colours to my
  // OWN other devices over the account room (the DO relays host-only). Primed on the first
  // connected render so neither the initial theme nor a just-adopted remote change echoes back;
  // only the colour keys are hashed, so non-colour settings changes never broadcast. Gated on
  // signed-in + online — a guest in someone else's room is host=false, so the DO drops it anyway.
  useEffect(() => {
    if (!room.signedIn || room.status !== "online") return;
    const sig = colorSig(settings);
    if (liveColorSig.current === null) {
      liveColorSig.current = sig; // prime — don't broadcast the theme we loaded with
      return;
    }
    if (sig === liveColorSig.current) return;
    liveColorSig.current = sig;
    const ts = stampLocal();
    room.sendSettings(snapshotColors(settings as unknown as Record<string, ColorValue>), ts);
  }, [settings, room.signedIn, room.status, room.sendSettings]);

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
      const v = engine.deck(id).extractStemView(latest.current.loaded[id] ?? undefined);
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
    // Broadcast the videoId the lines ACTUALLY belong to (set alongside them in onCues), and
    // only when it still matches the loaded track — never a stale loaded[id] (the cross-track
    // contamination guard). If they've diverged (mid-load), skip until they reconcile.
    const lyricsVid = captionVidRef.current[id];
    if (!lyricsVid || lyricsVid !== latest.current.loaded[id]) return;
    if (!force && lines === lastLyricsSent.current[id]) return;
    lastLyricsSent.current[id] = lines;
    r.sendLyrics(id, lyricsVid, lines, captionSourceRef.current[id] || "whisper");
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
      emit({ kind: "control", deck: id, param: "eqLowQ", value: d.eqLowQ });
      emit({ kind: "control", deck: id, param: "eqHighQ", value: d.eqHighQ });
      emit({ kind: "control", deck: id, param: "eqLowShape", value: d.eqLowShape });
      emit({ kind: "control", deck: id, param: "eqMidShape", value: d.eqMidShape });
      emit({ kind: "control", deck: id, param: "eqHighShape", value: d.eqHighShape });
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
  followRef.current = room.enabled || replay.active; // G1c: replay drives the same handlers
  // Catch-up snapshots apply to everyone EXCEPT the anchor (the authoritative board / its
  // own source of truth). A non-anchor CONTROLLER — e.g. a same-account "control extension"
  // device that joined with empty decks — still needs the snapshot to load the host's deck
  // songs; gating on !controlling left it driving a blank board (deck songs never synced).
  // Re-stomping a controller's live edits is prevented by the per-videoId reconcile dedupe.
  snapFollowRef.current = (room.enabled && !room.isAnchor) || replay.active;
  // Locked out of driving (a watch-only listener, OR replay is driving the decks) → block the
  // keys + show the overlay. During replay the user must not fight the recipe.
  lockedRef.current = (room.enabled && !room.controlling) || replay.active;
  // Per-deck drive permission (E3/E4 seat model). SOLO (no session) always drives — the seat
  // rules only bind once you're IN a room: a full controller/host (myDeck null) drives both
  // decks; a stepped-up listener drives ONLY their one deck; a pure follower/listener drives
  // neither. A LOCKED deck blocks control (jog/seek/bend + the whole button bank) but never the
  // purely visual zoom + expand — a listener can still inspect either waveform. Replay locks
  // both decks (it's driving them). (Without the !enabled bypass, EVERY local control surface —
  // keyboard, MIDI, gamepad — goes dead off-session, since `controlling` is false with no rig.)
  const canDriveDeck = (id: DeckId) => !room.enabled || (room.controlling && (room.myDeck === null || room.myDeck === id));
  const deckLocked = (id: DeckId) => (room.enabled && !canDriveDeck(id)) || replay.active;
  // A whole-board move (the crossfader) needs FULL control — locked for a stage DJ, any follower,
  // and during replay.
  const boardLocked = (room.enabled && !(room.controlling && room.myDeck === null)) || replay.active;
  canDriveDeckRef.current = canDriveDeck;
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
  // The sampler is lifted to App now (shared by the global strip AND each deck's SAMPLER
  // pad-mode): 12 global pads + 8 region pads per deck.
  const sampler = useSampler(engine, loaded, me, emit);
  // A co-DJ's `sample` intent reaches applyIntent (defined far above) through this ref.
  useEffect(() => {
    samplerApplyRef.current = sampler.applyRemote;
  }, [sampler.applyRemote]);
  // Bridge to the sampler's trigger/release (set by SamplerStrip) so MIDI-learned + 1-8
  // keyboard pads fire the sampler without threading the api through the keymap effect.
  const samplerCtl = useRef<{ trigger: (i: number) => void; release: (i: number) => void } | null>(null);
  // A decoded MidiEvent is fanned out to the SAME handlers the keyboard/buttons use,
  // so a hardware board has full feature + session-sync parity. value is 0..1; we
  // scale it to each control's real range here (where the live tempo range lives).
  const onMidiEvent = useCallback(
    (ev: MidiEvent) => {
      if (lockedRef.current) return; // a watch-only participant can't drive the decks
      // A stepped-up listener may drive ONLY their own deck — block control aimed at the
      // other one (navigation/zoom stay free). A deck-less control event targets `focused`.
      const evNav = ev.type === "zoom" || ev.type === "focus" || ev.type === "browse" || ev.type === "selector";
      if (!evNav && !canDriveDeckRef.current((ev as { deck?: DeckId }).deck ?? focused)) return;
      // Map a 0..1 knob to dB with a centre detent at 0 dB (DJ EQ convention).
      const eqDb = (v: number) => (v < 0.5 ? EQ_MIN_DB * (0.5 - v) * 2 : EQ_MAX_DB * (v - 0.5) * 2);
      // ~33⅓ rpm platter feel (720 ticks ≈ 1.8 s), scaled by the user's jog sensitivity.
      const SEC_PER_TICK = 0.0025 * settings.jogSensitivity;
      // SHIFT + jog = fast track scan: a much coarser step so a flick sweeps the whole
      // track to find a cue (Mixxx uses ~×150 vs scratch; we ride sensitivity too).
      const SEARCH_SEC_PER_TICK = 0.05 * settings.jogSensitivity;
      // Jog (platter or ring) editing a loop edge. GRID LOCK on → integrate the motion and
      // spend it one beat at a time via adjustStep (a per-tick adjustBy snaps to the same
      // beat and never advances). Grid lock off → smooth continuous sub-beat adjustBy. One
      // beat per beat-interval of platter motion, so it tracks tempo.
      const loopAdjustJog = (deck: Deck, did: DeckId, sec: number) => {
        if (!deck.quantizing) {
          deck.adjustBy(sec);
          return;
        }
        const interval = deck.beatgrid?.interval || 0.5;
        const acc = (loopAdjAcc.current[did] ?? 0) + sec;
        const steps = Math.trunc(acc / interval);
        if (steps !== 0) {
          for (let k = 0; k < Math.abs(steps); k++) deck.adjustStep(Math.sign(steps));
          loopAdjAcc.current[did] = acc - steps * interval;
        } else {
          loopAdjAcc.current[did] = acc;
        }
      };
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
          // Sampler pads are global (route by position), not a deck handler — fire the
          // strip directly. pressed=false releases (gate mode).
          const smp = /^sampler(\d+)$/.exec(ev.action);
          if (smp) {
            const idx = Number(smp[1]);
            if (ev.pressed) samplerCtl.current?.trigger(idx);
            else samplerCtl.current?.release(idx);
            break;
          }
          const id = ev.deck ?? focused;
          const deck = engine.deck(id);
          // Effective shift. A DECK-ADDRESSED hardware button (FLX, ev.deck set) uses ONLY its
          // own shift (its SHIFT byte or that deck's latch) — never the focus-model/keyboard
          // shift. Otherwise a latched/held shift would silently turn the FOCUSED deck's ▶ into
          // move-loop, so "jog forward" died intermittently on whichever deck had focus (deck B).
          // The focus-model shift (focusShift/latch/keyboard) only applies to a DECKLESS board.
          const sh = ev.shift || midiShift[id] || (ev.deck == null && (focusShift || shiftLatched || shiftHeld));
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
            if (!xfaderEnabledRef.current) break; // SMART FADER disabled → ignore the crossfader
            const x = (ev.value - 0.5) * 2;
            setCrossfade(x);
            engine.setCrossfade(x);
            if (room.controlling) room.sendIntent({ kind: "crossfade", value: x });
            break;
          }
          // Global headphone / mic knobs (no deck): the FLX 🎧 MIX + 🎧 LEVEL + a mappable mic level.
          if (ev.target === "cueMix") {
            engine.setCueMix(ev.value);
            setCueMixSt(ev.value); // keep the on-screen buttonoid in step with the knob
            break;
          }
          if (ev.target === "cueLevel") {
            engine.setCueLevel(ev.value);
            setCueLevelSt(ev.value);
            break;
          }
          if (ev.target === "micLevel") {
            engine.setMicLevel(ev.value);
            micVolSetRef.current?.(ev.value); // mirror to the sampler-strip MIC cell display
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
            else if (t === "pitch") cur01 = (deck.pitch + settings.pitchRange) / (2 * settings.pitchRange);
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
              // Span the configured KEY range (±settings.pitchRange semitones), same as
              // the on-screen KEY cell — was hardcoded ±12, which capped a board's pitch
              // knob at ±12 even when the range was widened to ±24.
              deck.setPitch(Math.round((ev.value - 0.5) * 2 * settings.pitchRange));
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
              // Integer semitones: carry the fractional part across detents (±pitchRange
              // over a full sweep, matching the KEY range) so slow turns still resolve to
              // whole-semitone steps. Was hardcoded ±12.
              const k = `${id}:pitch`;
              const acc = (knobAcc.current[k] ?? 0) + d * 2 * settings.pitchRange;
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
          // Touching the top plate only GRABS the platter (stops the deck dead, vinyl
          // feel) when the unit is in vinyl/scratch mode. In non-vinyl mode the touch
          // is inert — the top plate just bends (jogTurn scratch:false handles motion),
          // so resting a finger to nudge no longer halts playback.
          const deck = engine.deck(ev.deck);
          jogTouched.current[ev.deck] = ev.down;
          if (ev.down) {
            if (jogVinyl.current[ev.deck]) {
              deck.scrubBegin();
              onJogStart(ev.deck);
            }
          } else if (deck.scrubbing) {
            deck.scrubEnd();
            onJogEnd(ev.deck);
          }
          break;
        }
        case "jogTurn": {
          // Two top-plate streams, distinguished by ev.scratch (the FLX4 hardware VINYL
          // button picks which CC it sends): the SCRATCH stream moves the platter
          // (position); the BEND stream nudges the tempo (deck.bend self-routes to a
          // frame-search when paused). Latch the mode from whichever arrives.
          const deck = engine.deck(ev.deck);
          const sec = ev.delta * SEC_PER_TICK;
          // Loop-edge fine-adjust armed (Shift+IN / Shift+OUT) → the platter repositions
          // the loop head rekordbox-style instead of scratching the track. Snap follows the
          // grid magnet (quantize on = whole-beat steps, off = surgical sub-beat).
          if (deck.adjusting) {
            loopAdjustJog(deck, ev.deck, sec);
            break;
          }
          if (ev.scratch) {
            jogVinyl.current[ev.deck] = true;
            // Grab lazily if the touch landed before we knew it was vinyl mode.
            if (!deck.scrubbing && jogTouched.current[ev.deck]) {
              deck.scrubBegin();
              onJogStart(ev.deck);
            }
            if (deck.scrubbing) {
              deck.scrubMove(sec);
              emitJog(ev.deck, sec);
            } else {
              deck.bend(sec); // touch released mid-stream → fall back to a bend
            }
          } else {
            // Non-vinyl top plate → bend. If we wrongly grabbed (mode just flipped),
            // let the platter go first.
            jogVinyl.current[ev.deck] = false;
            if (deck.scrubbing) {
              deck.scrubEnd();
              onJogEnd(ev.deck);
            }
            deck.bend(sec);
          }
          break;
        }
        case "jogBend": {
          // Outer ring (never touched) → momentary pitch-bend / paused frame-search.
          // When loop-edge adjust is armed it repositions the loop head too (parity with
          // the top plate), so either rim or platter nudges the boundary rekordbox-style.
          const deck = engine.deck(ev.deck);
          if (deck.adjusting) {
            loopAdjustJog(deck, ev.deck, ev.delta * SEC_PER_TICK);
            break;
          }
          deck.bend(ev.delta * SEC_PER_TICK);
          break;
        }
        case "jogSearch": {
          // SHIFT + jog → fast scan through the track (works playing or paused). A
          // coarse needle-drop, coalesced/streamed to session peers like a scrub seek.
          const deck = engine.deck(ev.deck);
          const sec = ev.delta * SEARCH_SEC_PER_TICK;
          deck.needleDrop(sec);
          emitSeekTo(ev.deck, deck.position());
          refresh();
          break;
        }
        case "zoom": {
          // Relative encoder → zoom the focused deck's waveform (in/out per detent).
          const id = ev.deck ?? focused;
          setZoomFor(id, latest.current.zoom[id] * (ev.delta > 0 ? 0.82 : 1.22));
          break;
        }
        case "selector":
          // Browse-encoder PRESS → jump the browse cursor between the track list and the
          // source list (Collection / Community / playlists), rekordbox tree↔list — not
          // open/close the library (the chin's Library button / Alt already do that).
          libRef.current?.toggleSourceNav();
          break;
        case "browse":
          // Browse encoder → step the library row cursor (opens the panel if it was shut).
          libRef.current?.browse(ev.delta);
          break;
        case "load":
          // LOAD A / LOAD B → load the cursor row onto that deck (canDriveDeck already gated
          // this above, so a session passenger can't load over a deck they don't control).
          libRef.current?.load(ev.deck);
          break;
      }
    },
    [engine, refresh, settings.tempoRange, settings.pitchRange, settings.jogSensitivity, emitSeekTo, onJogStart, onJogEnd, emitJog, room, focused, midiShift, focusShift, shiftLatched, shiftHeld, setZoomFor],
  );

  const midi = useMidi({
    enabled: settings.midiEnabled,
    learn: settings.midiBindings,
    onEvent: onMidiEvent,
    onLearnChange: (next) => setSettings((s) => ({ ...s, midiBindings: next })),
  });

  // 🎮 An Xbox/standard gamepad as a control surface — emits the SAME MidiEvents as the MIDI
  // layer into onMidiEvent (so it inherits focus / shift / room-sync / jog). Live whenever a
  // pad is present; rumbles on the beat of the deck being driven. See src/htl/gamepad.
  useGamepad({ engine, getFocused: () => focused, onEvent: onMidiEvent });

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
          padMode: d.padMode,
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

  // ---- Auto-mix (auto-DJ) ------------------------------------------------------
  // The AutoMixer drives the real deck/engine controls to beatmatch + crossfade one
  // track into the next; the MixQueue feeds it (a playlist, or radio suggestions).
  const mixQueue = useMixQueue();
  const [autoStatus, setAutoStatus] = useState<AutoMixStatus>({
    enabled: false,
    phase: "idle",
    liveDeck: null,
    plan: null,
    mixOutTime: null,
    countdownSec: null,
  });
  // AUTO forces on-device stems on mobile (a stem transition needs both decks) regardless of
  // the Settings ▸ Stems toggle; the gate in deriveStems reads this ref. (Declared up by the
  // mobile-stems ref, assigned here where autoStatus is in scope.)
  autoEnabledRef.current = autoStatus.enabled;

  // Apply a crossfade value through the one canonical path (engine + state + session).
  const applyCrossfade = useCallback(
    (x: number) => {
      const v = x < -1 ? -1 : x > 1 ? 1 : x;
      setCrossfade(v);
      engine.setCrossfade(v);
      if (room.controlling) room.sendIntent({ kind: "crossfade", value: v });
    },
    [engine, room],
  );

  // Load a track onto a deck for the auto-mixer (shares the load in a session) and
  // resolve once the buffer + analysis are attached.
  const autoLoad = useCallback(
    async (id: DeckId, track: TrackMeta) => {
      if (track.videoId) {
        roomLoadTarget.current[id] = track.videoId;
        if (!room.enabled || room.controlling) {
          emit({ kind: "load", deck: id, videoId: track.videoId, name: track.title, artist: track.artist });
        }
      }
      await loadTrackToDeck(id, track);
    },
    [emit, loadTrackToDeck, room.enabled, room.controlling],
  );

  // The TrackMeta currently on a deck (so the mixer can adopt a manually-started
  // deck and seed radio from it), enriched with analyzed key/bpm from the library.
  const deckTrack = useCallback(
    (id: DeckId): TrackMeta | null => {
      const m = meta[id];
      if (!m.videoId) return null;
      const lib = library.collection.find((t) => t.videoId === m.videoId);
      return {
        videoId: m.videoId,
        title: m.name,
        artist: m.artist,
        duration: m.duration,
        thumbnail: m.thumbnail ?? null,
        views: null,
        bpm: m.bpm ?? lib?.bpm ?? null,
        key: lib?.key ?? null,
        isrc: lib?.isrc ?? null, // carries TIDAL radio seeding when known
        provider: lib?.provider,
      };
    },
    [meta, library.collection],
  );

  // MOBILE: bring one deck to the desired stem mode. → Stems (want): the deck is mix-only so
  // its float32 buffer is still resident — derive in place (position + playback preserved, no
  // re-decode). → Single (!want): stems loading RELEASED the mobile mix buffer (the OOM fix),
  // so re-decode the track to restore the plain mix, carrying position/playback via a snapshot.
  // No-op when the deck is already in the requested mode. Driven by the global Settings toggle
  // (and AUTO) through reconcileMobileStems — there is no longer a per-deck button.
  const applyMobileStemMode = useCallback(
    (id: DeckId, want: boolean) => {
      const deck = engine.deck(id);
      const track = deckTrack(id);
      if (!track || want === deck.hasStems) return;
      deriveGuard.current[id] = ""; // re-open the derive decision with the new request
      if (want) {
        if (!deck.buffer) return; // no resident mix to split (shouldn't happen from Single)
        void deriveStems(id, track.videoId, deck.buffer, () => latest.current.loaded[id] !== track.videoId);
      } else {
        const snap = deckSnapshot(deck, latest.current.meta[id], track.videoId);
        void loadTrackToDeck(id, track, snap);
      }
    },
    [engine, deckTrack, deriveStems, loadTrackToDeck],
  );
  const reconcileMobileStems = useCallback(
    (want: boolean) => (["A", "B"] as DeckId[]).forEach((id) => applyMobileStemMode(id, want)),
    [applyMobileStemMode],
  );

  // Current crossfade behind a ref so the mixer can detect a manual fader grab.
  const crossfadeRef = useRef(crossfade);
  crossfadeRef.current = crossfade;

  // Current stem-load status behind a ref so the mixer can tell when a deck's stems are
  // still separating (and hold the blend a beat for the stem swap, see stemsPending below).
  const statusRef = useRef(status);
  statusRef.current = status;

  // Latest callbacks behind a ref so the (stably-constructed) AutoMixer never holds
  // a stale closure.
  const autoDeps = useRef({ autoLoad, applyCrossfade, deckTrack });
  autoDeps.current.autoLoad = autoLoad;
  autoDeps.current.applyCrossfade = applyCrossfade;
  autoDeps.current.deckTrack = deckTrack;
  const mixerRef = useRef<AutoMixer | null>(null);
  if (mixerRef.current === null) {
    mixerRef.current = new AutoMixer({
      engine,
      queue: mixQueue,
      loadDeck: (id, t) => autoDeps.current.autoLoad(id, t),
      applyCrossfade: (x) => autoDeps.current.applyCrossfade(x),
      deckTrack: (id) => autoDeps.current.deckTrack(id),
      getCrossfade: () => crossfadeRef.current,
      now: () => performance.now(),
      stemsPending: (id) => stemLoading(statusRef.current[id]),
      onChange: (s) => setAutoStatus(s),
    });
  }

  // A remote's "automix" intent drives the host's mixer (assigned to the forward ref).
  autoMixerControlRef.current = (action) => {
    const m = mixerRef.current;
    if (!m) return;
    if (action === "toggle") m.isEnabled() ? m.disable() : m.enable();
    else if (action === "skip") m.skip();
    else if (action === "mixnow") m.mixNow();
    else if (action === "hold") m.hold();
  };

  // In a session, only the audio host runs the auto-mixer; remotes mirror its state.
  const autoIsRemote = room.enabled && !room.isAnchor;
  // Keep the high-up applyIntent's view of the queue + our role current (it mutates the
  // canonical queue only on the authority).
  mixQueueRef.current = mixQueue;
  autoIsRemoteRef.current = autoIsRemote;

  // Tick the state machine on a steady cadence while AUTO is on (host/solo only).
  useEffect(() => {
    if (!autoStatus.enabled || autoIsRemote) return;
    const iv = setInterval(() => void mixerRef.current?.tick(), 150);
    return () => clearInterval(iv);
  }, [autoStatus.enabled, autoIsRemote]);

  // Mobile stem mode reconcile. The desired state for every loaded deck = the global toggle
  // (Settings ▸ Stems) OR AUTO running (a stem transition needs both decks' stems; the OOM
  // that once barred this is resolved — int16 shared-offset WSOLA + aggregate budget). When
  // that desired value FLIPS, bring both already-loaded decks into line (derive, or restore
  // the plain mix). New auto-loads inherit it via the deriveStems gate, so this only handles
  // the transition. Guarded on the value so deckTrack churn can't re-fire it mid-derive.
  const lastMobileWant = useRef<boolean | null>(null);
  useEffect(() => {
    if (!isMobileDevice()) return;
    const want = settings.mobileStems || autoStatus.enabled;
    if (lastMobileWant.current === want) return;
    lastMobileWant.current = want;
    reconcileMobileStems(want);
  }, [settings.mobileStems, autoStatus.enabled, reconcileMobileStems]);

  // Host streams the auto-DJ queue + status to the room so remotes see what's coming.
  useEffect(() => {
    if (!room.enabled || !room.isAnchor) return;
    room.sendAutomix({ status: autoStatus, mode: mixQueue.mode, current: mixQueue.current, upcoming: mixQueue.upcoming });
  }, [room.enabled, room.isAnchor, room.sendAutomix, autoStatus, mixQueue.mode, mixQueue.current, mixQueue.upcoming]);

  // Anchor handover continuity: when THIS device becomes the anchor (e.g. the desktop host
  // refreshed and an iPad took over the clock), seed the local queue from the last mirror
  // it received so the host→guest stream stays 1:1 instead of resetting to empty. One-shot
  // on the transition, and only when our local queue is empty (don't stomp an active one).
  const wasAnchorRef = useRef(false);
  useEffect(() => {
    const became = room.isAnchor && !wasAnchorRef.current;
    wasAnchorRef.current = room.isAnchor;
    if (became && remoteAutomix && remoteAutomix.upcoming.length > 0 && mixQueue.upcoming.length === 0) {
      mixQueue.adopt(remoteAutomix.upcoming, remoteAutomix.current, remoteAutomix.mode);
    }
  }, [room.isAnchor, remoteAutomix, mixQueue]);

  // Queue is one of the library tabs — remember whether it was the open one across reloads.
  const [mixqOpen, setMixqOpen] = useState(() => localStorage.getItem("htl:mixqOpen") === "1");
  useEffect(() => {
    try {
      localStorage.setItem("htl:mixqOpen", mixqOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [mixqOpen]);
  // Auto-mix controls: drive the local mixer (host/solo) or send an intent (remote).
  const autoControl = useCallback(
    (action: "toggle" | "skip" | "mixnow" | "hold") => {
      if (autoIsRemote) {
        if (room.controlling) room.sendIntent({ kind: "automix", action });
        return;
      }
      autoMixerControlRef.current(action);
    },
    [autoIsRemote, room.controlling, room.sendIntent],
  );
  const toggleAuto = useCallback(() => {
    autoControl("toggle");
    setMixqOpen(true); // surface the queue
  }, [autoControl]);
  const autoMixNow = useCallback(() => autoControl("mixnow"), [autoControl]);
  const autoSkip = useCallback(() => autoControl("skip"), [autoControl]);
  const autoHold = useCallback(() => autoControl("hold"), [autoControl]);

  // Queue editing routes through ONE authority: host/solo mutates its local queue
  // directly; a controlling remote sends a queue intent → the host applies it → the
  // automix stream re-broadcasts, so all devices converge 1:1 on the host's queue. A
  // non-controlling remote can't edit (no-op). Seed/mode changes stay host-only (the
  // radio engine), so remotes only add/remove/move individual tracks.
  const toQueuedTrack = (t: TrackMeta): QueuedTrack => ({
    videoId: t.videoId,
    title: t.title,
    artist: t.artist,
    duration: t.duration,
    thumbnail: t.thumbnail,
    views: t.views,
    bpm: t.bpm ?? null,
    key: t.key ?? null,
    isrc: t.isrc ?? null,
    provider: t.provider,
    providerId: t.providerId ?? null,
  });
  // A track → the free-text a listener's "add to queue" becomes when routed as a song request.
  const requestTextFor = (t: TrackMeta): string => [t.artist, t.title].filter(Boolean).join(" — ").slice(0, 120) || t.title || "a track";
  // Queue-edit POLICY off the attachment (P3): VISITING another rig WITHOUT full board
  // control → my add/addNext is a gated SONG REQUEST (never a silent no-op), and remove/move
  // I simply don't own. On my OWN rig (home), or visiting WITH full control granted, I edit
  // the canonical queue — directly when I'm the anchor, else via a queue intent the authority
  // applies + re-streams. `fullControl` excludes a stepped-up single-deck listener (myDeck
  // set), whose deck-less queue intent the server would drop anyway. This generalises the old
  // `listeningTo`-only check, which left invite guests + stage listeners with a dead button.
  const fullControl = room.controlling && room.myDeck === null;
  const visitingNoControl = room.attachment.to === "rig" && !fullControl;
  const queueCanEdit = !autoIsRemote || fullControl;
  const queueEdit = useMemo(
    () => ({
      add: (t: TrackMeta) => {
        if (visitingNoControl) room.requestSong(requestTextFor(t));
        else if (autoIsRemote) {
          if (room.controlling) room.sendIntent({ kind: "queue", action: "add", track: toQueuedTrack(t) });
        } else mixQueue.enqueue(t);
      },
      addNext: (t: TrackMeta) => {
        if (visitingNoControl) room.requestSong(requestTextFor(t)); // can only request, not jump the queue
        else if (autoIsRemote) {
          if (room.controlling) room.sendIntent({ kind: "queue", action: "addNext", track: toQueuedTrack(t) });
        } else mixQueue.enqueueNext(t);
      },
      remove: (videoId: string) => {
        if (visitingNoControl) return; // don't own a queue to remove from
        if (autoIsRemote) {
          if (room.controlling) room.sendIntent({ kind: "queue", action: "remove", videoId });
        } else mixQueue.remove(videoId);
      },
      move: (from: number, to: number) => {
        if (visitingNoControl) return;
        if (autoIsRemote) {
          // Resolve the moved track's id from the list the user actually sees (the mirror), so
          // the host moves the RIGHT track — its from-index is stale against the live queue.
          const videoId = remoteAutomix?.upcoming[from]?.videoId;
          if (room.controlling && videoId) room.sendIntent({ kind: "queue", action: "move", videoId, to });
        } else mixQueue.reorder(from, to);
      },
    }),
    [autoIsRemote, visitingNoControl, room.controlling, room.sendIntent, room.requestSong, mixQueue, remoteAutomix],
  );
  // F1→queue: a crowd song-request, actioned in one tap — search the free text, drop the top
  // hit onto the auto-mix queue (authority-correct via queueEdit.add), then clear the request.
  const queueRequest = useCallback(
    async (text: string, reqId: string) => {
      try {
        const results = await searchYouTube(text, 1);
        if (results[0]) {
          queueEdit.add(results[0]);
          room.dismissRequest(reqId);
        }
      } catch {
        /* search failed — leave the request for a manual pull */
      }
    },
    [queueEdit, room],
  );

  // Background-precompute the next queued tracks' key/BPM (desktop only — a full
  // decode is too heavy for phones, which stay on provider-order + honest badges).
  // Runs during AUTO, and also when the queue panel is open off-AUTO so radio picks
  // show real key/tempo while you're looking at them (the cheap ISRC/global-DB lookup
  // fills known tracks without a decode; only novel ones decode, one at a time).
  useQueuePrefetch(mixQueue, engine.ctx, (autoStatus.enabled || mixqOpen) && !isMobileDevice());

  // Keep the queue aware of what's loaded on the decks even when AUTO is OFF, so the
  // panel shows the loaded/playing track as "now playing" and Radio can build
  // suggestions from both decks without the auto-mixer running. When AUTO is on the
  // mixer owns `current`, so we step aside.
  useEffect(() => {
    if (autoStatus.enabled) return;
    // A queue-remote (any non-anchor device — my own iPad, a co-DJ, a listener) mirrors the
    // authority's queue via remoteAutomix; running a SECOND local radio engine here just burns
    // recommendation fetches on a queue it never uses (audit #4). Only the authority seeds.
    if (autoIsRemote) return;
    const a = deckTrack("A");
    const b = deckTrack("B");
    const live = (engine.deckA.playing && a) || (engine.deckB.playing && b) || a || b || null;
    const other = live === a ? b : a;
    mixQueue.setCurrent(live);
    // Seed primary = the LIVE deck (what's playing / loaded), so suggestions follow it;
    // the seed-set signature in ensureNext means loading EITHER deck re-seeds.
    if (live) void mixQueue.ensureNext([live, other].filter((t): t is TrackMeta => !!t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.A.videoId, meta.B.videoId, autoStatus.enabled, autoIsRemote, mixQueue.mode]);

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

  // On GO-LIVE, force a fresh full snapshot so the recording's baseline captures the CURRENT
  // decks + FX racks (a rack/track set up before broadcasting would otherwise be missed, and the
  // FX-pad throws would replay into an empty rack). The capture is already running by now.
  useEffect(() => {
    if (room.roomPublic && room.isAnchor && room.status === "online") {
      room.publishState(buildSnapshot());
      sendHostStemView("A");
      sendHostStemView("B");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.roomPublic]);

  // The auto-mixer drives the host's decks DIRECTLY (play/seek/sync/key/EQ) — those
  // don't emit the per-control intents the session relays, so a guest would see the
  // wrong deck state during an auto-transition. Re-publish the full snapshot at each
  // transition boundary (mix start / settle) so remotes resync the loaded + playing
  // decks. Gated to mixing/armed (NOT preload) so we never abort an in-flight load.
  useEffect(() => {
    if (!room.isAnchor || room.status !== "online") return;
    if (autoStatus.phase === "mixing" || autoStatus.phase === "armed") {
      room.publishState(buildSnapshot());
      sendHostStemView("A");
      sendHostStemView("B");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStatus.phase, autoStatus.liveDeck, room.isAnchor, room.status]);

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
      const include = lastStemKey.current[id] !== key || tickN.current % 4 === 0;
      lastStemKey.current[id] = key;
      const tick: DeckTick = { pos: deck.position(), playing: deck.playing, rate: deck.effectiveRate };
      if (include) tick.stems = { g, m };
      return tick;
    };
    // 250 ms (4/s), not 80 ms (12.5/s): the tick is only a drift CORRECTION + stem-state heartbeat —
    // followers animate the playhead off their own clock between ticks, and transport flips ride
    // immediate intents — so a slower tick is imperceptible for sync but cuts the anchor's per-message
    // Durable-Object REQUESTS ~3× (the steady drain that would otherwise eat the 1M/mo DO-request
    // allowance on the $5 plan). Heartbeat stays ~1 Hz (every 4 ticks). Tunable: raise to 400–500 ms
    // for even more headroom if sessions run many hours/day.
    const iv = setInterval(() => {
      tickN.current++;
      room.sendTick({ A: buildTick(engine.deckA, "A"), B: buildTick(engine.deckB, "B") });
    }, 250);
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

  // Cue (PFL) is a per-device LOCAL monitor — NOT part of the shared board — so it must be
  // zeroed on every context transition: attaching to / leaving a VISITED rig (home↔rig), or
  // a replay start/stop. Otherwise a cue send left open from a prior context bleeds the now
  // remote/replay-driven deck audio into the cue device "at whatever volume" — the ghost
  // (#15: (a) unasked bleed + (b) stale level). Keyed on attachment+replay only, so a plain
  // join/leave of your OWN home rig keeps your cue (it's yours there). Fires on mount too
  // (cue is already 0 → harmless). Re-cue deliberately after a transition.
  useEffect(() => {
    engine.deckA.setCueLevel(0);
    engine.deckB.setCueLevel(0);
    refresh();
  }, [room.attachment.to, replay.active, engine, refresh]);

  // Load a SessionSnapshot onto THIS device's decks unconditionally (mirrors the boot-
  // restore) — used to put my OWN board back when I return home from visiting another rig.
  // Not gated on the follower path (applyRoomSnapshot is), because here I'm the driver
  // restoring my own set. (A deck empty in the snapshot is left as-is for now — restoring
  // loaded decks is the common case; a stale visited track on an unused deck is a minor edge.)
  const restoreBoard = useCallback(
    (snap: SessionSnapshot) => {
      setCrossfade(snap.crossfade);
      engine.setCrossfade(snap.crossfade);
      setZoom(snap.zoom);
      (["A", "B"] as DeckId[]).forEach((id) => {
        const d = snap.decks[id];
        if (!d?.videoId) return;
        const track: TrackMeta = { videoId: d.videoId, title: d.name, artist: d.artist, duration: d.duration, thumbnail: null, views: null, bpm: d.bpm };
        void loadTrackToDeck(id, track, d);
      });
      refresh();
    },
    [engine, loadTrackToDeck, refresh],
  );

  // P2: snapshot/restore my board across a VISIT to another rig. preVisit is captured the
  // instant I leave home, BEFORE the visited board overwrites my engine (network latency
  // makes the synchronous capture safe). On return I prefer the rig's LIVE state — another
  // of my devices may have advanced it, adopted via applyRoomSnapshot when I come back a
  // follower (it bumps homeAdoptAt) — and replay preVisit only if no live home snapshot lands
  // within a grace (the solo / cold-home case). Fixes the lost-solo-board defect: leaving a
  // visit used to strand you on the visited board.
  const prevAttachRef = useRef(room.attachment.to);
  useEffect(() => {
    const prev = prevAttachRef.current;
    const cur = room.attachment.to;
    prevAttachRef.current = cur;
    if (prev === cur) return;
    if (prev === "home" && cur === "rig") {
      preVisitRef.current = buildSnapshot();
    } else if (prev === "rig" && cur === "home") {
      const armedAt = performance.now();
      const token = ++restoreTokenRef.current;
      const snap = preVisitRef.current;
      restorePendingRef.current = true; // suspend persistence: the decks still mirror the visited board until restore
      window.setTimeout(() => {
        if (restoreTokenRef.current !== token) return; // a newer transition owns the flag now → it clears it
        restorePendingRef.current = false;
        if (roomRef.current?.attachment.to !== "home") return; // re-visited within the grace → don't clobber the live rig
        if (homeAdoptAt.current > armedAt) return; // the rig's live state already restored me
        if (snap) restoreBoard(snap);
      }, 2000);
    }
  }, [room.attachment.to, buildSnapshot, restoreBoard]);

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

  // Browsers start the audio context suspended; UNLOCK it on a user gesture (a
  // silent-buffer primer, not just resume) so iOS opens the output route. Critical for
  // LISTEN mode, where the first real sound starts later from a network tick — never
  // from a tap — so without an in-gesture primer iOS keeps the listener silent.
  //
  // RETRY-UNTIL-RUNNING (the "silent until a few refreshes" fix): `ctx.resume()` is
  // async and iOS can ignore the FIRST gesture (the race), so a once-and-done listener
  // gets consumed before the context actually starts → silent forever. Instead we retry
  // on EVERY gesture (idempotent: the primer + bg-bridge self-guard) and only detach once
  // the output is confirmed `running`. One tap is enough for sound; cleanup just waits for
  // the resume to land. Covers solo + session + broadcast-listen uniformly.
  useEffect(() => {
    if (engine.running) return;
    const evs = ["pointerdown", "touchend", "keydown"] as const;
    const detach = () => evs.forEach((e) => window.removeEventListener(e, unlock));
    const unlock = () => {
      engine.unlock();
      // Re-attach any worklet that lost the init race at construction (iOS "scrub works,
      // Play silent"): now the context is running, so the stretch node attaches reliably and
      // reloads the current track's PCM. Idempotent — only re-creates missing nodes.
      void engine.ensureWorklets();
      // iOS: bridge output through a media element so playback survives lock / app-switch
      // / Bluetooth / CarPlay handoffs (see AudioEngine). Idempotent + self-reverting.
      if (isIOSDevice()) engine.enableBackgroundAudio();
      if (engine.running) detach(); // confirmed flowing → stop retrying
    };
    evs.forEach((e) => window.addEventListener(e, unlock));
    return detach;
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
    // The DOM hooks above only fire when the PAGE backgrounds/foregrounds. iOS can suspend
    // or "interrupt" the audio context with the page still visible — a phone call, Siri,
    // another app taking the session, a Bluetooth/CarPlay route flip — and then the sound
    // stays dead until a manual refresh happens to re-prime it. Watch the context's OWN
    // state and a light poll so any drop out of "running" while a deck is playing self-heals.
    const onState = () => { if (!engine.running) engine.resumeOutput(); };
    engine.ctx.addEventListener("statechange", onState);
    const watch = window.setInterval(() => {
      if (!engine.running && (engine.deckA.playing || engine.deckB.playing)) engine.resumeOutput();
    }, 1500);
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
      engine.ctx.removeEventListener("statechange", onState);
      window.clearInterval(watch);
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
          ["loaded", dk.duration ? `${dk.duration.toFixed(1)}s` : "—"],
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
      {/* Top chin: panel launchers, reserving their own row at the top so they never
          overlap the board. The ⇄ swap sits top-LEFT; it flips which side the Library
          dock and the Settings/Profile/Session dock sit on (and mirrors the chin). */}
      <nav className="chin">
        <button
          className="chin-btn chin-swap"
          onClick={() => setDockSwapped((v) => !v)}
          aria-label="Swap panel sides"
          title="Swap panel sides"
        >
          <span className="chin-swap-i" aria-hidden="true">⇄</span>
        </button>
        <button className={`chin-btn chin-library ${libOpen ? "active" : ""}`} onClick={toggleLib} aria-label="Library">
          <span className="chin-label">Library</span>
        </button>
        <button
          className={`chin-btn chin-settings ${settingsOpen ? "active" : ""}`}
          onClick={toggleSettings}
          aria-label="Settings"
          title="Settings"
        >
          <span className="chin-gear" aria-hidden="true">⚙</span>
          <span className="chin-label">Settings</span>
        </button>
        <button
          className={`chin-btn chin-profile ${profileOpen ? "active" : ""}`}
          onClick={toggleProfile}
          aria-label="Profile"
          title="Your profile"
        >
          <span className="chin-globe" aria-hidden="true">🌐</span>
        </button>
        <button
          className={`chin-btn chin-discover ${discoverOpen ? "active" : ""}`}
          onClick={toggleDiscover}
          aria-label="Discover"
          title="Discover — who's live now"
        >
          <span className="chin-discover-i" aria-hidden="true">🧭</span>
        </button>
        <NotificationsBell
          signedIn={!!room.user}
          self={room.user?.handle ?? null}
          tunedTo={room.listeningTo}
          onListen={(h) => {
            setDiscoverOpen(false);
            room.tuneIn(h);
          }}
          onSeeAll={toggleDiscover}
        />
        <RoomBar room={room} onExpand={toggleSocial} />
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
              debrick={settings.waveformDebrick}
              glow={settings.glow}
              markerThickness={settings.markerThickness}
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
              wheelSeeks={settings.wheelSeeks}
              locked={deckLocked(id)}
              refresh={refresh}
              onLoadFile={(f) => onLoadFile(id, f)}
              onLoadTrack={(track) => loadAndShare(id, track)}
              onJogStart={() => onJogStart(id)}
              onJog={(delta) => emitJog(id, delta)}
              onJogEnd={() => onJogEnd(id)}
              onSeek={(pos) => emitSeekTo(id, pos)}
              onReprocessLyrics={(eng) => reprocessLyrics(id, eng)}
            />
          ))}
        </div>

        {/* Middle third: the A↔B crossfader across the top, then the two decks'
            button banks side by side beneath it. */}
        <div className="decks-third">
          <SamplerStrip
            sampler={sampler}
            ctlRef={samplerCtl}
            engine={engine}
            micSetRef={micVolSetRef}
            phones={
              !!settings.audioCueOutputId && engine.canCueDevice
                ? {
                    mix: cueMix,
                    level: cueLevel,
                    onMix: (v) => { engine.setCueMix(v); setCueMixSt(v); },
                    onLevel: (v) => { engine.setCueLevel(v); setCueLevelSt(v); },
                  }
                : null
            }
          />
          <Crossfader
            deckA={engine.deckA}
            deckB={engine.deckB}
            accentA={ACCENT.A}
            accentB={ACCENT.B}
            crossfade={crossfade}
            onCrossfade={applyCrossfade}
            locked={boardLocked || !xfaderEnabled}
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
            stemPending={stemLoading(status.A)}
            stemPendingPct={status.A?.pct ?? null}
            otherStemPending={stemLoading(status.B)}
            tempoRange={settings.tempoRange}
            pitchRange={settings.pitchRange}
            levelGainDb={levelGainsDb.a}
            onCycleTempoRange={cycleTempoRange}
            onCyclePitchRange={cyclePitchRange}
            onToggleShift={() => setShiftLatched((v) => !v)}
            onSync={() => { doSync("A"); emit({ kind: "sync", slave: engine.syncSlave }); refresh(); }}
            onKey={() => { engine.toggleKey("A"); emit({ kind: "key", slave: engine.keySlave }); refresh(); }}
            cueFader={!!settings.audioCueOutputId && engine.canCueDevice}
            locked={deckLocked("A")}
            refresh={refresh}
            emit={emit}
            emitControls={emitDeckControls}
            sampler={sampler}
            onFxSelect={(d, i) => { fxSelRef.current[d] = i; }}
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
            stemPending={stemLoading(status.B)}
            stemPendingPct={status.B?.pct ?? null}
            otherStemPending={stemLoading(status.A)}
            tempoRange={settings.tempoRange}
            pitchRange={settings.pitchRange}
            levelGainDb={levelGainsDb.b}
            onCycleTempoRange={cycleTempoRange}
            onCyclePitchRange={cyclePitchRange}
            onToggleShift={() => setShiftLatched((v) => !v)}
            onSync={() => { doSync("B"); emit({ kind: "sync", slave: engine.syncSlave }); refresh(); }}
            onKey={() => { engine.toggleKey("B"); emit({ kind: "key", slave: engine.keySlave }); refresh(); }}
            cueFader={!!settings.audioCueOutputId && engine.canCueDevice}
            locked={deckLocked("B")}
            refresh={refresh}
            emit={emit}
            emitControls={emitDeckControls}
            sampler={sampler}
            onFxSelect={(d, i) => { fxSelRef.current[d] = i; }}
          />
          </div>
        </div>

        {/* Bottom third dissolved — EQ moved into each deck bank's foot. */}
      </main>

      <LibraryPanel
        ref={libRef}
        library={library}
        onLoad={loadAndShare}
        loadedIds={loadedIds}
        deckLoaded={loaded}
        deckColors={ACCENT}
        open={libOpen}
        onOpenChange={setLibOpen}
        auto={{
          status: autoIsRemote && remoteAutomix ? remoteAutomix.status : autoStatus,
          queue: mixQueue,
          queueCount: autoIsRemote && remoteAutomix ? remoteAutomix.upcoming.length : mixQueue.upcoming.length,
          queueOpen: mixqOpen,
          mirror: autoIsRemote ? remoteAutomix : null,
          edit: queueEdit,
          canEdit: queueCanEdit,
          onToggle: toggleAuto,
          onToggleQueue: () => setMixqOpen((v) => !v),
          onMixNow: autoMixNow,
          onSkip: autoSkip,
          onHold: autoHold,
        }}
      />

      {/* Settings + Profile + Session share the RIGHT dock (the slot the old Search
          panel left) — one open at a time. On desktop the dock shares the workspace row
          with the board + library; on mobile dock-right makes it a full-screen panel
          under the chin (no floating pane). */}
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
      {socialOpen && (
        <SocialScreen room={room} onClose={() => setSocialOpen(false)} onActivate={() => engine.unlock()} onQueueRequest={queueRequest} />
      )}
      {discoverOpen && (
        <DiscoverScreen
          self={room.user?.handle ?? null}
          tunedTo={room.listeningTo}
          onClose={() => setDiscoverOpen(false)}
          onListen={(h) => {
            engine.unlock(); // tune-in is a user gesture → prime iOS audio
            room.tuneIn(h);
            setDiscoverOpen(false); // hand off to the Session dock's "Listening to @X" banner
          }}
          onPlaySet={playRecordedSet}
        />
      )}
      {profileOpen && (
        <ProfileScreen
          onClose={() => setProfileOpen(false)}
          live={room.roomPublic}
          listeners={room.listenerCount}
          onGoToSession={toggleSocial}
          onPlaySet={playRecordedSet}
          onTrimSet={editTrim}
        />
      )}
      <ReplayBar
        replay={replay}
        trim={
          trimEdit && replay.setId === trimEdit.id
            ? {
                setId: trimEdit.id,
                start: trimEdit.start,
                end: trimEdit.end,
                onSave: (start, end) => {
                  void trimSet(trimEdit.id, start || null, end);
                  setTrimEdit(null);
                  replay.stop();
                },
                onClear: () => {
                  setTrimEdit(null);
                  replay.stop();
                },
              }
            : null
        }
      />

      {publicHandle && (
        <PublicProfileScreen
          handle={publicHandle}
          onClose={closePublic}
          onListen={(h) => {
            engine.unlock(); // tune-in is a user gesture → prime iOS audio
            room.tuneIn(h);
            closePublic(); // hand off to the Session dock's "Listening to @X" banner
          }}
          onPlaySet={playRecordedSet}
        />
      )}

      </div>

      {kickedNotice && (
        <div className="kicked-toast" onClick={() => setKickedNotice(null)} role="status">
          {kickedNotice}
        </div>
      )}

    </div>
  );
}
