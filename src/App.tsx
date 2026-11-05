import { separationForces, type SeparatePurpose } from "./App/separatePurpose";
import { canArmAutoMix } from "./htl/automix/autoMixAuthority";
import { setBeatlockMax, BEATLOCK_ANY } from "./htl/analysis";
import { canDriveDeck as canDriveDeckFor, canDriveBoard as canDriveBoardFor } from "./App/drivePermission";
import type { StemAckState } from "./htl/room/protocol";
// The requester's stall limit and the host's heartbeat are one invariant with two owners, so both
// live in protocol.ts — a local copy here could drift from the heartbeat that keeps it alive.
import { STEM_ACK_STALL_MS } from "./htl/room/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeckLane, type DeckMeta } from "./components/DeckLane";
import { SongOverview } from "./components/SongOverview";
import { DeckControls } from "./components/DeckControls";
import type { FxStripCtl } from "./components/FxStrip";
import { crossfadeGainsDb } from "./components/Crossfader";
import { BoardBar } from "./components/BoardBar";
import { useSampler, deckPadBase } from "./components/useSampler";
import { fxPadArg, fxPadPress, fxPadRelease } from "./components/fxPads";
import { searchYouTube } from "@htl/media";
import { LibraryPanel, type LibraryHandle } from "./components/LibraryPanel";
import { autoLine } from "./components/automixStatus";
import { displayTrack } from "./util/format";
import { SettingsPanel } from "./components/SettingsPanel";
import { useChinHeight } from "./components/lib/useChinHeight";
import { RoomBar } from "./components/RoomBar";
import { PublicProfileScreen, handleFromPath } from "./components/PublicProfileScreen";
import { initialDock } from "./App/initialDock";
import { mayContributeAnalysis, mayReuseGrid } from "./App/gridReuse";
import { event } from "@htl/debug/trace";
import { setPerfAudioProbe } from "@htl/debug/perfCapture";
import { escapeAction, trackOpenOrder } from "./App/escapeKey";
import { libraryKeyAction } from "./App/libraryKeys";
import { SocialScreen } from "./components/SocialScreen";
import { PeopleScreen } from "./components/PeopleScreen";
import { INITIAL_PEOPLE_VIEW, clearGraphCache, viewForPane, type PeopleView, type PeoplePane } from "@htl/account";
import { useNotifications } from "./components/social/useNotifications";
import { type FriendPresence, type Me, fetchFriendsOnline, fetchMe, logPlay, trimSet } from "@htl/account";
import { useRoom, type Intent, type DeckTick, type QueuedTrack, type NowPlaying } from "@htl/room";
import { ReplayBar } from "./components/ReplayBar";
import { useMidi, type DeckFeedback } from "@htl/midi";
import { useGamepad } from "@htl/gamepad";
import {
  AudioEngine,
  type Deck,
  analyzeTrackAsync,
  serializeGrid,
  deserializeGrid,
  extractPalette,
  serializePalette,
  deserializePalette,
  neonHex,
  fetchAnalysisFull,
  ANALYSIS_VERSION,
  type Beatgrid,
  decodeAudio,
  getCachedTrack,
  setCachedTrack,
  initDecodeCrashGuard,
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
  MIC_NONE,
  loadSettings,
  hydrateFxBanks,
  onFxBankChange,
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
  useOnePanel,
  placementsFor,
  panelsToClose,
  type PanelKey,
  type DeckSnapshot,
  type SessionSnapshot,
  loadSession,
  saveSession,
  getAudio,
  putAudio,
  loadStems,
  setSeparationAuthority,
  getStemModel,
  modelSupport,
  isMobileDevice,
  isIOSDevice,
  isChromium,
  initGpuCrashGuard,
  isGpuBlocked,
  unblockGpu,
  gpuCrashModel,
  resetStemGuard,
  STEM_MODELS,
  armGpu,
  disarmGpu,
  initStemCrashGuard,
  stemTrace,
  type Stems,
  type StemModel,
  useMixQueue,
  type MixQueue,
  useQueuePrefetch,
  AutoMixer,
  SmartFader,
  PAD_MODE_RESERVED,
  type PadMode,
  type AutoMixStatus,
  type AutoMixMirror,
  seedMicChain,
} from "@htl";
import { platterDrag } from "@htl/audio/JogEngine";
import { resolveLyrics, getLyricsDiag, formatLyricsDiag, type LyricsSource, type LyricsLine } from "@htl/lyrics";
import { whenIdle } from "./util/idle";
import { useStemPipeline, stemSrcLabel, STEM_KEYS } from "./App/useStemPipeline";
// The APPLYING side of deck state, and the only place it lives — it declares its own narrowed
// SnapshotDeck rather than taking a Deck, so an originating gesture cannot be written against it.
import { deckSnapshot, applyDeckStems, applyDeckRack, applyDeckControls } from "./App/deckApply";
import { useSessionSync } from "./App/useSessionSync";
import { isStemWork } from "./App/stemWork";
import { crashPrompts, type CrashPrompt } from "./App/crashPrompt";
import { CrashGuardPrompt } from "./components/CrashGuardPrompt";
import { PerfRecChip } from "./components/PerfCaptureControl";
import { shouldReleaseClaim } from "./App/loadClaim";
import { deckNamePatch } from "./App/deckNameBackfill";
import { publishedDeckId } from "./App/publishedDeckId";
import { useStemViewSync } from "./App/useStemViewSync";
import { useLyricsSync } from "./App/useLyricsSync";
import { useReplay } from "./App/useReplay";
import { useMidiRouting } from "./App/useMidiRouting";
import { SpineContext, useSpine, type Spine } from "./App/spine";
import { fxBypassIntent } from "@htl/room/fxWire";
import { registerBoardAction } from "@htl/board/boardActions";

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
/** How long a requester waits for the NEXT progress step before reporting the host has gone quiet.
 *  A stall window, not a total deadline: progress arrives in ~10% steps, and even a long track on a
 *  CPU host moves a step well inside this. The old fixed 20 s TOTAL is what fired mid-success. */

/** How a separation's outcome leaves forceSeparate for someone other than this device's own UI —
 *  today, the host answering a remote's stem request. forceSeparate never throws, so without this a
 *  caller cannot tell a failure from a success. */
/** Options for forceSeparate. `purpose` is required so every call site states its intent. */
export interface SeparateOpts {
  purpose: SeparatePurpose;
  stale?: () => boolean;
  report?: SeparationReport;
}

export type SeparationReport = (e: { kind: "progress"; pct: number } | { kind: "failed"; reason: string }) => void;

export interface StemStatus {
  phase: StemPhase;
  pct?: number; // 0–100, while downloading/separating
  detail: string;
  src?: string; // short engine label for the persistent chip ("Demucs" / "Open-Unmix")
  of?: "track"; // a TRACK-load write sharing this slot, never stem work (see App/stemWork.ts)
  /** WHICH part of a fresh on-device separation is running, before the first inference window
   *  reports. Without it the header read "Separating 0%" through a one-time ~170 MB model download
   *  AND the GPU session setup — several seconds, or forever if setup hangs — so "downloading",
   *  "warming up" and "stuck" all looked identical (decision 7b5a5bfd). Absent once windows report. */
  step?: "model" | "prep";
}

// One labelled group of live diagnostics for the Settings → Debug tab (audio engine,
// shared session, device, per-deck). Polled by the panel while that tab is open.
export interface DebugSection {
  title: string;
  rows: [string, string][];
}

// Debug-only: underruns-per-second tracker for the Audio-health readout, so a CarPlay/Bluetooth
// chop reads as a clear rate ("⚠ STARVING") not a slowly-climbing total. Module-level (one app).
const _uhRate = { underruns: 0, atMs: 0, perSec: 0 };

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




const EMPTY_META: DeckMeta = { name: "", artist: "", bpm: null, duration: 0, pyramid: null, videoId: null, thumbnail: null, palette: null };

// <input> types that are NOT text entry. A focused slider / checkbox / button must NOT swallow the
// board keyboard shortcuts — only an actual typing target (text field / textarea / contentEditable)
// should. This is the "an open menu hijacks the board" pathology: a range slider (sampler-pad gain,
// a fader, a panel knob) keeps focus after you drag it, and a blanket INPUT guard then ate every key.
const NON_TEXT_INPUT_TYPES = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "file", "color", "image"]);




// A stable JSON signature of just the colour/theme settings — drives the instant cross-device
// colour-sync de-dupe (an adopted change must not bounce straight back out as a fresh broadcast).
function colorSig(s: Settings): string {
  return JSON.stringify(COLOR_PROFILE_KEYS.map((k) => (s as unknown as Record<string, unknown>)[k]));
}

// The 8 beat-loop sizes, ascending — pad/key index → beats (shared by the keyboard
// handlers and the MIDI pad dispatch so a loop pad can match the active loop's size).
const LOOP_BEATS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8];




export function App() {
  // Lazy singleton — the AudioContext is created on first render (post user-gesture), not at import.
  const engineRef = useRef<AudioEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new AudioEngine();
  const engine = engineRef.current;
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const emitRef = useRef<(intent: Intent) => void>(() => {});
  const roomRef = useRef<ReturnType<typeof useRoom> | null>(null); // filled in AppBody once useRoom has run
  const spine = useMemo<Spine>(() => ({ engine, refresh, emitRef, roomRef }), [engine, refresh, emitRef, roomRef]);
  return (
    <SpineContext.Provider value={spine}>
      <AppBody />
    </SpineContext.Provider>
  );
}

function AppBody() {
  const { engine, refresh, emitRef, roomRef } = useSpine();

  const library = useLibrary();

  // The auto-DJ queue + status streamed from the session host (null when solo/host).
  const [remoteAutomix, setRemoteAutomix] = useState<AutoMixMirror | null>(null);

  const [meta, setMeta] = useState<Record<DeckId, DeckMeta>>({ A: EMPTY_META, B: EMPTY_META });
  const [, setLoading] = useState<Record<DeckId, boolean>>({ A: false, B: false });
  const [status, setStatus] = useState<Record<DeckId, StemStatus | null>>({ A: null, B: null });
  const [crossfade, setCrossfade] = useState(0);
  // Smart Fader: a crossfader-driven auto-transition (tempo morph + bass swap) armed by the FLX
  // SMART FADER button. Stateful → keep one instance for the session. armedRef lets the crossfader
  // event handler check it without re-subscribing.
  const smartFaderRef = useRef<SmartFader | null>(null);
  if (smartFaderRef.current === null) smartFaderRef.current = new SmartFader(engine);
  const smartFader = smartFaderRef.current;
  // ★ The transition speaks. Without this every move it makes — the tempo morph, the bass swap,
  // starting the incoming deck — happens on this device only, and a co-DJ's board hears a plain
  // crossfade while this one performs a transition. emitRef is stable, so this is wired once.
  if (smartFaderRef.current) smartFader.setEmitter((intent) => emitRef.current(intent));
  const [smartFaderArmed, setSmartFaderArmed] = useState(false);
  // ★ THE MODE IS SHARED, NOT JUST BROADCAST. A co-DJ arming Smart Fader has to arm it HERE too,
  // or this board pins its key-lock and lights nothing while its own fader still performs a plain
  // crossfade — a strip that lies. Registered from App because it needs the SmartFader instance
  // and the strip's state, which the deck-scoped default in boardActions.ts cannot reach.
  // `announce = false`: we are arming BECAUSE they armed, and echoing would bounce it back.
  useEffect(() => {
    registerBoardAction("smartFader", (deck, _phase, arg) => {
      const on = arg === "arm";
      deck.setKeylockPinnedOff(on);
      if (deck !== engine.deckA) return; // emitted per deck; act on the board once
      if (on) setSmartFaderArmed(smartFader.arm(crossfadeRef.current, false));
      else {
        smartFader.disarm(false);
        setSmartFaderArmed(false);
      }
    });
  }, [engine, smartFader]);
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
  const [masterVol, setMasterVolSt] = useState(1); // master output volume (SMART buttonoid + FLX MASTER knob)
  // The board bar’s MIC cluster owns its level state; this ref lets the FLX MIC LEVEL knob
  // push the display value into it (the knob already drives engine.setMicLevel directly).
  const micVolSetRef = useRef<((v: number) => void) | null>(null);
  // The mic's on/off, published by the board bar so the `micToggle` key can reach it. A GLOBAL
  // action like focusToggle — it is not a deck's, so it is handled before the deck dispatch below.
  const micToggleRef = useRef<(() => void) | null>(null);
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
      // ★ PRESSING THE BUTTON THAT READS "MASTER" RELEASES SYNC (operator, 2026-11-03: "sync
      // problems when using sync/master"). The engine's toggle FLIPS a master into the follower,
      // which the auto-mixer and Smart Fader rely on, but from the button it meant: press the deck
      // you are playing out, labelled MASTER, and ITS tempo jumps to follow the other deck. Now the
      // lit button on either deck lets go, and nothing's tempo moves. To swap who leads, press SYNC
      // on the deck that should follow.
      if (engine.syncRole(id) === "master") engine.releaseSync();
      else engine.toggleSync(id);
      if (engine.syncRole(id) === "slave") {
        const other: DeckId = id === "A" ? "B" : "A";
        setZoom((z) => ({ ...z, [id]: z[other] }));
      }
    },
    [engine],
  );
  const [loaded, setLoaded] = useState<Record<DeckId, string | null>>({ A: null, B: null });
  const [captions, setCaptions] = useState<Record<DeckId, LyricsLine[]>>({ A: [], B: [] });
  // Where each deck's ribbon text came from — aligned to the vocal stem / pool / YouTube — for
  // the little source tag on the caption bar. null = none shown yet.
  const [captionSource, setCaptionSource] = useState<Record<DeckId, LyricsSource | null>>({ A: null, B: null });
  // Which videoId each deck's CURRENT captions actually belong to — so the host broadcasts
  // the lines paired with their true id (not a momentarily-stale loaded[id]) and a guest only
  // applies streamed lyrics whose id matches the track it's showing. Prevents the cross-track
  // contamination (e.g. a 50 Cent deck showing/caching another track's lyrics).
  const captionVidRef = useRef<Record<DeckId, string>>({ A: "", B: "" });
  // Lyric processing/failure tell per deck (model download %, "Transcribing…", "unavailable").
  const [lyricStatus, setLyricStatus] = useState<Record<DeckId, string | null>>({ A: null, B: null });

  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  // Settings ▸ Debug ▸ Performance capture reads audio health + the engine-shaping settings
  // through these (the recorder is module-level so it keeps running with Settings closed).
  const settingsForPerf = useRef(settings);
  settingsForPerf.current = settings;
  useEffect(() => {
    setPerfAudioProbe(() => {
      const ah = engine.audioHealth();
      const s = settingsForPerf.current;
      return {
        underruns: ah.underruns,
        outputLatencyMs: ah.outputLatencyMs,
        baseLatencyMs: Math.round((engine.ctx.baseLatency ?? 0) * 1000),
        state: ah.state,
        playing: ah.playing,
        reserveMs: ah.reserveMs,
        stems: `${engine.deck("A").hasStems ? "A" : ""}${engine.deck("B").hasStems ? "B" : ""}`,
        stemModel: s.stemModel,
        stretch: `${s.stretchEngine}/${s.stretchQuality}`,
      };
    });
    return () => setPerfAudioProbe(null);
  }, [engine]);
  // ★ THE PRESET BANKS' SYNC BRIDGE, both legs. OUTBOUND: every bank write announces itself and is
  // mirrored into settings.fxBanks, which is what syncs to the account. Installed once.
  useEffect(() => {
    onFxBankChange((kind, bank) => setSettings((s) => ({ ...s, fxBanks: { ...s.fxBanks, [kind]: bank } })));
    return () => onFxBankChange(null);
  }, []);
  // ★ INBOUND, AND IT RUNS ON EVERY CHANGE — NOT ONCE ON MOUNT, WHICH IS WHAT IT USED TO DO AND WHY
  // THE BANKS NEVER ARRIVED. The account blob lands ASYNCHRONOUSLY, always after mount: the sign-in
  // reconcile, the 30s poll and the live account-room broadcast each call setSettings later. A
  // one-shot hydrate therefore only ever saw this device's own localStorage, so a second device
  // showed the factory arrangement — and then its first local edit announced THAT back over the
  // account blob and took the first device's curation with it. Silent, cross-device, both ways.
  // Depending on the object identity is the whole fix; hydrateFxBanks is dirty-checked, so the
  // outbound leg's own setSettings re-runs this and writes nothing, which is why it cannot loop.
  useEffect(() => {
    hydrateFxBanks(settings.fxBanks);
  }, [settings.fxBanks]);
  // Which right-dock panel was open last reload — restored DESKTOP-ONLY (like libOpen
  // below; on a phone the docks are full-screen modals that always start closed). The
  // three share one slot, so one string captures it.
  // ★ A FOLLOWED @handle LINK OUTRANKS A REMEMBERED PANEL. With a dock restored here, the effect
  // below ("opening any own-account dock leaves the public profile") fired at MOUNT and cleared
  // the deep link before it could render — so a shared link to a live DJ landed on the board with
  // no profile and no way to tune in (thread 3b2ea067, reproduced on the rig and fixed by clearing
  // the stored key by hand). The decision is in App/initialDock.ts so the rule is testable; the
  // stored value is left alone, so the next ordinary load restores it as before.
  const initRightDock = initialDock(localStorage.getItem("htl:rightDock"), handleFromPath(), window.innerWidth >= 769);
  const [settingsOpen, setSettingsOpen] = useState(initRightDock === "settings");
  // ONE People dock replaces Profile + Discover + the notification bell; `peopleTab` says which
  // face of it is showing. The old per-surface open flags are gone — three booleans that had to
  // be mutually exclusive by hand were three chances to leave two docks open at once.
  const [profileOpen, setProfileOpen] = useState(initRightDock === "profile" || initRightDock === "discover");
  // ★ THE DOCK'S POSITION LIVES HERE, not inside it. PeopleScreen unmounts every time the dock
  // closes, so anything it owned — tab, pushed person, filters, scroll — died with it: measured
  // at 151 rows + scrollTop 1200 becoming 0/0 on a close. Held here, an excursion costs nothing.
  const [peopleView, setPeopleView] = useState<PeopleView>(() => ({
    ...INITIAL_PEOPLE_VIEW,
    ...viewForPane(initRightDock === "discover" ? "air" : "profile"),
  }));
  const peopleTab = peopleView.tab;
  const patchPeopleView = useCallback(
    (patch: Partial<PeopleView> | ((v: PeopleView) => PeopleView)) =>
      setPeopleView((v) => (typeof patch === "function" ? patch(v) : { ...v, ...patch })),
    [],
  );
  const [socialOpen, setSocialOpen] = useState(initRightDock === "social");

  // Keyboard-help popover — a lightweight, ephemeral overlay (not one of the persisted
  // right-docks above): pops near the chin, closes on click-away or Escape.
  useEffect(() => {
    const v = settingsOpen ? "settings" : profileOpen ? (peopleTab === "explore" ? "discover" : "profile") : socialOpen ? "social" : "";
    try {
      localStorage.setItem("htl:rightDock", v);
    } catch {
      /* ignore */
    }
  }, [settingsOpen, profileOpen, socialOpen, peopleTab]);
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
    if (settingsOpen || profileOpen || socialOpen) setPublicHandle(null);
  }, [settingsOpen, profileOpen, socialOpen]);
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
  // CRASH GUARDS ASK, THEY DO NOT DECIDE. If the last GPU separation (desktop) or stem download
  // (phone) took the tab down, the guard blocks that job at boot so a reload cannot crash straight
  // back into it, and then a prompt ASKS on every load while the block stands (App/crashPrompt.ts).
  // ★ THIS USED TO BE SILENT: the GPU guard also bounced the selected stem model to "off" and said
  // nothing outside a Settings banner, so stems were later just off with nobody having turned them
  // off. The model is no longer touched; the block alone breaks the loop.
  const [crashAsks, setCrashAsks] = useState<CrashPrompt[]>([]);
  useEffect(() => {
    // ★ DID THE TAB DIE MID-DECODE LAST TIME? The only failure in a track load that leaves no
    // exception, no rejection and no onerror — the process is simply gone, and the next boot looks
    // normal. Witness-only on purpose: a decode is not optional, so unlike the GPU guard below this
    // one never blocks anything. It reports once and clears.
    initDecodeCrashGuard();
    const gpuCrashedNow = initGpuCrashGuard();
    // Mobile stem-download crash guard. LIVE: useStemPipeline arms it around a phone's cached-set
    // download+decode (the 2026-09-10 redesign). The note that used to sit here called it inert;
    // that stopped being true when the redesign re-wired the arming, and the note was left behind.
    const stemFailLevelNow = initStemCrashGuard();
    const crashedModel = gpuCrashModel();
    setCrashAsks(
      crashPrompts({
        gpuBlocked: isGpuBlocked(),
        gpuCrashedNow,
        gpuModelLabel: crashedModel ? getStemModel(crashedModel).label : null,
        stemFailLevel: stemFailLevelNow,
      }),
    );
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Dock open-state persists across reloads on DESKTOP (the docks share the screen
  // there, so it's a layout preference). On mobile they're full-screen modals, so we
  // always start closed regardless of what was stored.
  const [libOpen, setLibOpen] = useState(() => window.innerWidth >= 769 && localStorage.getItem("htl:libOpen") === "1");
  const libOpenRef = useRef(libOpen); // read by the keyboard handler (library keys, App/libraryKeys.ts)
  libOpenRef.current = libOpen;
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
  // Chin launchers. On a DESKTOP each of Library/Settings/People/Session floats independently
  // (Settings ▸ Controls ▸ Panel placement): left/right/bottom coexist fine even when two share
  // an edge, since panelOrder already resolves who is on top — that is supported stacking, not
  // a collision. "center" is the exception that evicts other centers, because two full-viewport
  // modals are just dim-over-dim with one hiding the other.
  //
  // ★ A PHONE IS NOT A SMALL DESKTOP. It has ONE slot, every panel fills it, and none of the
  // desktop liberties — placement, stack order, resize, backdrop dim — mean anything there.
  // That is not expressed as "the same system, with mobile overrides"; it is a fifth placement
  // ("sheet") that every configuration resolves to, decided ONCE below.
  // ★ ONE READ OF THE DEVICE, ONE RESOLVED PLACEMENT PER PANEL, THREADED DOWN.
  //
  // This used to be four inline `window.matchMedia("(max-width: 768px)")` calls and four
  // hand-written lists of which panels to close — "is this a phone" answered four times, and
  // "what does opening this evict" answered four times, each list written separately and each
  // one a place to forget the panel added most recently. (`closeRightDock` was still closing a
  // "discover" dock that had stopped existing.) Now the device is read once, the four
  // placements are derived from it, and the eviction rule is a pure function with a suite.
  const onePanel = useOnePanel();
  // The chin's real height, published as --chin-h for the phone sheet to start below. Measured,
  // not assumed — see useChinHeight for what the assumed 36px was actually costing.
  const [chinEl, setChinEl] = useState<HTMLElement | null>(null);
  useChinHeight(chinEl);
  const placements = placementsFor(
    {
      library: settings.libraryDock,
      settings: settings.settingsDock,
      people: settings.peopleDock,
      session: settings.sessionDock,
    },
    onePanel,
  );
  const PANEL_CLOSERS: Record<PanelKey, () => void> = {
    library: () => setLibOpen(false),
    settings: () => setSettingsOpen(false),
    people: () => setProfileOpen(false),
    session: () => setSocialOpen(false),
  };
  /** Everything a panel's own placement says it evicts. On a phone that is every other panel —
   *  there is one slot. On a desktop it is only the other CENTER panels, and edge docks close
   *  nothing at all. See htl/state/panelPlacement.ts. */
  const evictFor = (opening: PanelKey) =>
    panelsToClose(opening, placements).forEach((k) => PANEL_CLOSERS[k]());
  const toggleLib = () => {
    // Functional update so the keyboard (Alt) and chin button never read a stale libOpen.
    setLibOpen((v) => {
      const next = !v;
      if (next) evictFor("library");
      return next;
    });
  };
  // The right-dock launchers TOGGLE (press the chin button again to close — no explicit ✕).
  const toggleSocial = () => {
    setSocialOpen((v) => {
      const next = !v;
      if (next) evictFor("session");
      return next;
    });
  };
  // Open the People dock on a named tab. `toggleDiscover` used to open a whole separate panel;
  // it is now "open People, on Discover", which is what every caller actually meant.
  const openPeople = (pane: PeoplePane) => {
    patchPeopleView(viewForPane(pane));
    setProfileOpen(true);
    evictFor("people");
  };
  // Compatibility shim for the callers that used to open/close a standalone Discover dock — a
  // deep-link handler, a room hand-off, an invite accept. Every one of them means "show Discover"
  // or "get out of the way", and both still have an exact meaning here.
  const setDiscoverOpen = (v: boolean) => (v ? openPeople("air") : setProfileOpen(false));
  const toggleProfile = () => {
    if (profileOpen) return setProfileOpen(false);
    // ★ REOPEN WHERE YOU LEFT. This used to hardcode `openPeople("profile")`, so although the tab was
    // remembered, every press of the chin button overwrote it — you could never come back to the
    // list you were reading.
    evictFor("people");
    setProfileOpen(true);
  };
  const toggleSettings = () => {
    setSettingsOpen((v) => {
      const next = !v;
      if (next) evictFor("settings");
      return next;
    });
  };
  // ★ ESCAPE (App/escapeKey.ts): close the most recently opened panel, or open Settings when
  // nothing is open. Its own listener, deferred one task so every other handler of this keydown
  // has run: anything that consumed Escape (dialog, menu, ⓘ bubble, key rebind, text field)
  // marks it with preventDefault, and the board then leaves it alone.
  const openOrder = useRef<PanelKey[]>([]);
  useEffect(() => {
    openOrder.current = trackOpenOrder(openOrder.current, { library: libOpen, settings: settingsOpen, people: profileOpen, session: socialOpen });
  }, [libOpen, settingsOpen, profileOpen, socialOpen]);
  // ★ A CLICKED CONTROL DOES NOT KEEP THE KEYBOARD. Measured headless: click the Settings gear,
  // press Enter, and Settings closed again — the button kept focus and Enter re-pressed it; click
  // the crossfader, press ↑, and the deck jumped while the fader ignored it. On an instrument the
  // keys belong to the board, so once a POINTER click lands, the control lets go of focus.
  // Keyboard activation (Tab + Enter/Space: detail === 0) keeps focus, so tabbing still works,
  // and a text field is never blurred (it is not in the selector, and focus sits on it, not on
  // an ancestor).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = (e.target as Element | null)?.closest?.('button, [role="button"], [role="switch"], a[href], input[type="range"], input[type="checkbox"], input[type="radio"], select, [tabindex]');
      if (el instanceof HTMLElement && document.activeElement === el && el.tagName !== "SELECT") el.blur();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  const escapeActsRef = useRef({ close: (_p: PanelKey) => {}, openSettings: () => {} });
  escapeActsRef.current = { close: (p) => PANEL_CLOSERS[p](), openSettings: toggleSettings };
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      setTimeout(() => {
        const a = escapeAction(e.defaultPrevented, openOrder.current);
        if (a.kind === "close") escapeActsRef.current.close(a.panel);
        else if (a.kind === "openSettings") escapeActsRef.current.openSettings();
      }, 0);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, []);
  const [shiftLatched, setShiftLatched] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  // A controller SHIFT button is held, per deck (the FLX4 has one SHIFT per side).
  const [midiShift, setMidiShift] = useState<Record<DeckId, boolean>>({ A: false, B: false });
  // A deckless / focus-model SHIFT (the Starrypad's latching RECORD toggle): it isn't tied
  // to a side, so it applies to whatever deck is FOCUSED — and FOLLOWS focus while it's on.
  const [focusShift, setFocusShift] = useState(false);
  // Which deck the keyboard drives (Tab toggles it; the focused deck is ringed).
  const [focused, setFocused] = useState<DeckId>("A");
  const focusedRef = useRef<DeckId>("A"); // current focus for the ~7Hz feedback interval (no stale closure)
  useEffect(() => { focusedRef.current = focused; }, [focused]);
  // Live midi.send (assigned once midi exists, far below) so toggle handlers can force the FLX
  // hardware Smart-CFX/Fader OFF the instant they fire — not just on the next 150ms feedback tick.
  const midiSendRef = useRef<((bytes: number[]) => void) | null>(null);
  // Keyboard/on-screen shift is a property of the FOCUSED deck — never both. A deck's
  // shift is on when the keyboard Shift / latch (or a focus-model latch) is active AND
  // it's focused, OR that deck's own controller SHIFT button is held.
  const bankShift = (id: DeckId) => midiShift[id] || ((shiftLatched || shiftHeld || focusShift) && focused === id);
  const shift = bankShift(focused); // shift for whatever the keyboard is driving
  const [expandedLane, setExpandedLane] = useState<DeckId | null>(null); // single-deck (maximized) view
  // Deck accent tints to the LOADED track's album-art palette (Phase C) — "themes to whatever's
  // playing" — falling back to the user's chosen accent for an empty deck, an art-less track, or
  // when the `deckArtAccent` toggle is off (art theming is opt-in — the base look stays untouched).
  // neonHex floors the art-derived accent into a legible, vivid band (a dark/washed cover can't
  // produce an unreadable deck) — applied here at the theming seam so it fixes stored palettes too.
  const ACCENT: Record<DeckId, string> = {
    A: settings.deckArtAccent && meta.A.palette ? neonHex(meta.A.palette.accent) : settings.accentA,
    B: settings.deckArtAccent && meta.B.palette ? neonHex(meta.B.palette.accent) : settings.accentB,
  };
  // Post-crossfade attenuation per deck, so the bottom level-fader meters fade with the crossfader.
  const levelGainsDb = crossfadeGainsDb(crossfade);

  // Shared-session intent emitters, reached through refs so the keyboard handler
  // (set up before the room wiring below) can broadcast its actions too. Assigned
  // each render once `emit` / `emitDeckControls` exist.
  // emitRef now comes from the spine (filled below once `emit` exists). emitDeckRef stays local.
  const emitDeckRef = useRef<(id: DeckId) => void>(() => {});
  // A remote's "make these stems" request, routed to the host handler (assigned once the
  // room + separation wiring exist below). Lets onRoomIntent call it without an ordering cycle.
  const stemReqRef = useRef<(id: DeckId, model: string) => void>(() => {});
  // The REQUESTER's half of stemsAck — filled below once setStatusFor exists.
  const stemAckRef = useRef<(id: DeckId, state: StemAckState, reason?: string, pct?: number) => void>(() => {});
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
  // ★ AND THE BOARD-WIDE ONE, WHICH EXISTED AND NOTHING EVER ASKED. canDriveBoard has said since it
  // was written that the crossfader "needs FULL control — never a stage DJ, never a follower", and
  // its only consumer was a `locked:` prop driving pointer-events. dragCrossfade guarded on
  // lockedRef, which is the FOLLOWER lock: a stepped-up listener holds controlling=true, so it
  // passed, moved this device's crossfader, and emitted an intent the server drops (canDriveIntent
  // needs BOTH decks). Silent divergence on the shared board — 71277a23, from the seat one role up.
  const boardLockedRef = useRef(false);
  // Per-deck "current FX" index — the device selected in each deck's FX strip, mirrored up so
  // the gamepad's bypass-current action (R3) knows which device to flip.
  const fxSelRef = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  // Imperative handles into each deck's FxStrip so the FLX BEAT FX section can drive its
  // selection / reorder (BEAT ◀▶). The section targets the focused deck.
  const fxCtlA = useRef<FxStripCtl | null>(null);
  const fxCtlB = useRef<FxStripCtl | null>(null);
  const fxCtlFor = (d: DeckId) => (d === "A" ? fxCtlA : fxCtlB).current;
  // FLX4 SMART FADER lamp (0x96/0x01) — app-driven, diffed.
  const xfaderLedRef = useRef<boolean | null>(null);
  // Tracks our last eqStemMode edge so we can FORCE the FLX hardware Smart-CFX off (0x96/0x00 0x00)
  // on connect + every toggle — see the feedback push. We NEVER send 0x7F (that latches the hardware
  // feature ON, which remaps the COLOR knob onto the trim CC and fights trim).
  const cfxLedRef = useRef<boolean | null>(null);
  const beatFxLedRef = useRef<boolean | null>(null); // last FX-bypass (RELEASE FX) lamp state sent (diff)
  // SMART CFX toggles the channel knob column between EQ/filter and STEM VOLUME, top-to-bottom:
  // HI→drums, MID→bass, LOW→vocals, CFX/filter→other. Ref drives the fader handler.
  const [eqStemMode, setEqStemMode] = useState(false);
  const eqStemModeRef = useRef(false);
  useEffect(() => { eqStemModeRef.current = eqStemMode; }, [eqStemMode]);
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
  // …and WHICH load holds that claim. A videoId cannot answer that, because the case that matters
  // most reloads the SAME videoId: the tick-resync self-heal. See the release in loadTrackToDeck's
  // finally (ruling ab419a94) — comparing ids let a superseded load disarm its own successor.
  // The board that owns a track says what it is called: fill a deck's blank name/artist/bpm/
  // duration from the authoritative snapshot. Blanks only — a name already on screen is never
  // overwritten by a snapshot echo. See App/deckNameBackfill.ts (thread 47468bb9).
  const nameDeckFromSnapshot = useCallback((id: DeckId, d: DeckSnapshot) => {
    setMeta((m) => {
      const patch = deckNamePatch(m[id], d);
      return patch ? { ...m, [id]: { ...m[id], ...patch } } : m;
    });
  }, []);
  const loadingSeq = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  // When the current claim was made, so the resync can ask how old the IN-FLIGHT load is. Asking
  // the resync clock instead is what let a slow load be cancelled and restarted forever.
  const loadingSince = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  // The track this deck is loading RIGHT NOW — cleared when that load ends, however it ends. This is
  // NOT loadingVid, which survives a successful land on purpose (it is the dedupe key). The board we
  // publish reads this one, so a deck mid-decode announces the track that is coming instead of
  // announcing emptiness. See App/publishedDeckId.ts.
  const loadingNow = useRef<Record<DeckId, string>>({ A: "", B: "" });
  // Jog/scrub streaming: while we're locally scrubbing a deck, ignore the master's
  // inbound ticks for it (so they don't fight the scrub) and coalesce our streamed
  // seeks to one per animation frame.
  const scrubbing = useRef<Record<DeckId, boolean>>({ A: false, B: false });
  const jogDelta = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  const jogRaf = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  // FLX4 jog mode, latched from the controller's own CC stream: the hardware VINYL
  // button switches the top-plate CC (0x22 scratch / 0x23 bend), so the arriving tick
  // tells us the mode. Gates whether a touch grabs the platter (vinyl) or is inert
  // (non-vinyl, where the top plate just bends). Assumes vinyl until the first tick
  // reveals otherwise — most FLX4 use leaves VINYL on, and the very first CC corrects it.
  const jogVinyl = useRef<Record<DeckId, boolean>>({ A: true, B: true });
  // Accumulated jog motion (seconds) while editing a loop edge under GRID LOCK — the
  // continuous wheel is integrated and spent one whole beat at a time (see the jogTurn
  // handler), since a per-tick adjustBy would just re-snap to the same beat and stick.
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
  // Last tick-divergence reload attempt per deck. null = NEVER attempted, which is not the same as
  // "attempted a very long time ago" — the 0 sentinel made an absence read as the tab's whole
  // uptime and trip every threshold (thread 1d40b603).
  const resyncAt = useRef<Record<DeckId, number | null>>({ A: null, B: null });
  // Consecutive resync attempts per deck since it last landed the anchor's track → the backoff.
  const resyncTries = useRef<Record<DeckId, number>>({ A: 0, B: 0 });

  const cycleTempoRange = useCallback(() => {
    const i = TEMPO_RANGES.indexOf(settings.tempoRange);
    const next = TEMPO_RANGES[(i + 1) % TEMPO_RANGES.length];
    setSettings((s) => ({ ...s, tempoRange: next }));
    emitRef.current({ kind: "tempoRange", value: next }); // share it (the range scales the tempo fader)
    // A shrinking range can strand a deck's tempo outside the new ± limit — the knob ring
    // would just clamp its display and go visually dead-ended while the deck kept playing
    // the old, now out-of-range value. Snap it to the new limit instead of leaving that split.
    //
    // ★ BUT ONLY ON A DECK THIS DEVICE MAY DRIVE. The keyboard gates on the deck you AIMED at
    // (canDriveDeckRef, in the key handler) — and this action ignores that deck and touches BOTH.
    // So a STAGE DJ holding deck A could press the tempo-range key, legally, and have it snap the
    // OTHER DJ's deck locally while the server refused the matching intent (DjRoom.canDrive is
    // deck-scoped): a silent divergence on a deck they do not hold. A per-deck gate on the button
    // is not a gate on what the button DOES. The other deck's owner clamps their own, on their own
    // device, from their own copy of this setting.
    (["A", "B"] as const).forEach((id) => {
      if (!canDriveDeckRef.current(id)) return;
      const deck = engine.deck(id);
      const clamped = Math.max(-next, Math.min(next, deck.tempo));
      if (clamped !== deck.tempo) {
        deck.setTempo(clamped);
        emitRef.current({ kind: "control", deck: id, param: "tempo", value: clamped });
      }
    });
    refresh();
  }, [settings.tempoRange, engine, refresh]);
  // SHIFT-F: cycle the KEY knob's ± semitone range (local only for now).
  const cyclePitchRange = useCallback(() => {
    const i = PITCH_RANGES.indexOf(settings.pitchRange);
    const next = PITCH_RANGES[(i + 1) % PITCH_RANGES.length];
    setSettings((s) => ({ ...s, pitchRange: next }));
    // Same rule as cycleTempoRange: never clamp a deck this device does not hold.
    (["A", "B"] as const).forEach((id) => {
      if (!canDriveDeckRef.current(id)) return;
      const deck = engine.deck(id);
      const clamped = Math.max(-next, Math.min(next, deck.pitch));
      if (clamped !== deck.pitch) {
        deck.setPitch(clamped);
        emitRef.current({ kind: "control", deck: id, param: "pitch", value: clamped });
      }
    });
    refresh();
  }, [settings.pitchRange, engine, refresh]);

  // "dB" gain-match: nudge this deck's TRIM so its trimmed loudness equals the
  // other deck's, clamped to the trim knob's range so a near-silent track can't
  // demand absurd gain. Loudness is the cached integrated RMS of each buffer.
  // The trim has its OWN range (−26…+6 dB): it used to borrow the EQ's band-gain
  // constants, so widening the EQ to a true kill would have silently dragged the
  // trim knob down to 1% gain. Different controls, different limits.
  const MIN_TRIM = Math.pow(10, -26 / 20);
  const MAX_TRIM = Math.pow(10, 6 / 20);
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
    // The keyboard transport for the shared pad gesture (fxPads). It used to toggle, on the
    // grounds that "the keyboard has no key-up" — it does; nothing was listening.
    const fxKeyDown = (deck: DeckRef, id: DeckId, i: number) => {
      const { fired, repeat, kind } = fxPadPress(deck, id, i);
      if (repeat) return; // auto-repeat: the throw, the reveal and the render all stay put
      if (fired) emitRef.current({ kind: "board", deck: id, id: "fxPad", phase: "down", arg: fxPadArg(deck, i) });
      if (kind) fxCtlFor(id)?.selectKind(kind); // press IS reveal
    };
    const fxKeyUp = (deck: DeckRef, id: DeckId, i: number) => {
      if (fxPadRelease(deck, id, i)) emitRef.current({ kind: "board", deck: id, id: "fxPad", phase: "up", arg: fxPadArg(deck, i) });
    };
    const padModeKey = (deck: DeckRef, id: DeckId, m: PadMode) => {
      if (PAD_MODE_RESERVED.has(m)) return; // KEY isn't built yet — match the on-screen disabled state
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
        if (s) {
          deck.setPitch(0);
          emitRef.current({ kind: "control", deck: id, param: "pitch", value: 0 });
          return;
        }
        engine.toggleKey(id);
        emitRef.current({ kind: "control", deck: id, param: "pitch", value: deck.pitch });
        emitRef.current({ kind: "key", slave: engine.keySlave }); // mirror the button on peers
      },
      // Channel CUE (headphone PFL) toggle — pre-listen this deck in the cue device. LOCAL-ONLY
      // (each DJ's headphone is their own → never emitted to a session). 0 ↔ full send.
      cuePfl: (deck) => {
        deck.setCueLevel(deck.cueLevel > 0 ? 0 : 1);
        refresh();
      },
      // Toggle bypass on the FX device currently selected in this deck's FX strip (gamepad R3).
      // ON/OFF → A/B the focused deck's selected effect. SHIFT+ON/OFF → reset it.
      fxBypassCur: (deck, id, s) => {
        const i = fxSelRef.current[id];
        if (!deck.fxDevices[i]) return;
        fxCtlFor(id)?.closeMenu(); // hardware ON/OFF dismisses the preset browse
        if (s) {
          deck.resetFxAt(i);
          refresh();
          return;
        }
        const dev = deck.fxDevices[i];
        const next = !dev.bypassed;
        deck.setFxBypass(i, next);
        emitRef.current(fxBypassIntent(deck, id, i, next));
        refresh();
      },
      // BEAT FX SMART CFX → reset the focused deck's SELECTED effect to its defaults (local).
      fxReset: (deck, id) => {
        const i = fxSelRef.current[id];
        if (!deck.fxDevices[i]) return;
        deck.resetFxAt(i);
        refresh();
      },
      // BEAT FX BEAT ◀▶ → move the selection (add candidate in add-mode). SHIFT → reorder the tab.
      fxSelPrev: (_deck, id, s) => { const c = fxCtlFor(id); s ? c?.moveSel(-1) : c?.navSel(-1); },
      fxSelNext: (_deck, id, s) => { const c = fxCtlFor(id); s ? c?.moveSel(1) : c?.navSel(1); },
      // FX SELECT → step the BEAT-FX-selected effect through its presets, popping the same floaty
      // menu a tab right-click opens (with the applied preset highlighted). Plain = FORWARD,
      // SHIFT = BACKWARD. Press-only.
      fxSelectPress: (_deck, id, s) => {
        fxCtlFor(id)?.cyclePreset(s ? -1 : 1);
      },
      // SMART CFX → flip the HI/MID/LOW/CFX knob column between EQ/filter and stem volumes.
      // Flip eq/stem mode, and IMMEDIATELY force the FLX hardware Smart-CFX off (the press-down
      // engaged it; close the COLOR-knob remap window now instead of waiting for the 150ms tick).
      eqStemToggle: () => { setEqStemMode((v) => !v); midiSendRef.current?.([0x96, 0x00, 0x00]); },
      // Own key (Z), not ⇧F — see keybinds.ts. Same flag the on-screen lock button drives.
      keylock: (deck, id) => {
        const on = !deck.keylock;
        deck.setKeylock(on);
        emitRef.current({ kind: "toggle", deck: id, param: "keylock", value: on });
      },
      tempoRange: (_deck, _id, s) => {
        if (!s) cycleTempoRange();
      },
      pitchRange: (_deck, _id, s) => {
        if (!s) cyclePitchRange();
      },
      matchGain: (deck, id) => {
        matchGain(id);
        emitRef.current({ kind: "control", deck: id, param: "trim", value: deck.trim });
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
      spinback: (deck, _id, s) => {
        // SHIFT = a stronger/longer spin (an explicit strength override — spinback() already
        // took one, nothing new to build engine-side). 20 is clearly past the settings knob's
        // normal 4..14 range (lerp(4,14,backSpinLength)), so it reads as a deliberately bigger
        // throw, not just "the Long preset."
        deck.spinback(s ? 20 : undefined); // back-spin then catch to play (local audio effect)
      },
      // Release-FX Vinyl Brake: decelerate to a stop now, always — independent of the Vinyl
      // Speed toggle and of Play/Pause's own brakeStop (see Deck.releaseBrake's doc comment).
      releaseBrake: (deck) => {
        deck.releaseBrake();
      },
      slip: () => {
        // SLIP is a setting now (a scrub behaviour); Z toggles it for both decks.
        setSettings((s) => ({ ...s, slip: !s.slip }));
      },
      // FLX SMART CFX → A/B the EQ (the permanent channel-strip device) on BOTH decks at once.
      // More useful than a colour-filter kill: drop/restore the whole EQ curve instantly.
      eqBypass: () => {
        const on = !engine.deck("A").eqBypassed;
        engine.deck("A").setEqBypass(on);
        engine.deck("B").setEqBypass(on);
        refresh();
      },
      // FLX SMART FADER (unshifted) → arm/disarm OUR Smart Fader (crossfader-driven transition).
      // Always force the HW Smart-Fader off first so only our software version runs.
      smartFaderToggle: () => {
        midiSendRef.current?.([0x96, 0x01, 0x00]); // force the HW Smart-Fader off immediately
        if (smartFader.isArmed) {
          smartFader.disarm();
          setSmartFaderArmed(false);
        } else {
          const ok = smartFader.arm(crossfadeRef.current);
          setSmartFaderArmed(ok); // false if a deck lacks a beatgrid → nothing to morph
          refresh();
        }
      },
      // SHIFT + SMART FADER → enable/disable the crossfader entirely and recentre it.
      xfaderToggle: () => {
        if (smartFader.isArmed) { smartFader.disarm(); setSmartFaderArmed(false); }
        setXfaderEnabled((e) => !e);
        setCrossfade(0);
        engine.setCrossfade(0);
        emitRef.current({ kind: "crossfade", value: 0 }); // sync the recentre to a session
        midiSendRef.current?.([0x96, 0x01, 0x00]); // force the HW Smart-Fader off immediately
      },
      // Keyboard Smart Fader: ONE shift-aware key — bare = arm/disarm Smart Fader, SHIFT = enable/
      // disable the crossfader. Mirrors the FLX SMART FADER button's unshifted/shifted split.
      smartFader: (d, i, s) => (s ? HANDLERS.xfaderToggle(d, i, s) : HANDLERS.smartFaderToggle(d, i, s)),
      // CENSOR — plays backward from here and slip-snaps forward on release (the radio-edit move).
      // It lost its FX pad to the EQ, so it lives on its own key now. The keyboard has no key-up
      // (see fxKey), so this TOGGLES: press to run backward, press again to return. SHIFT = a
      // sustained REVERSE that just keeps running backward until you press again.
      censor: (deck, id, s) => {
        const on = !deck.reversing;
        if (!on) deck.censorEnd();
        else if (s) deck.setReverse(true);
        else deck.censorBegin();
        if (!s) emitRef.current({ kind: "board", deck: id, id: "censor", phase: on ? "down" : "up" });
        refresh();
      },
      // Pad-mode selectors — switch what the 8 pads (keys 1-8) do on the focused deck. Emit
      // over the board bus so the bank switch syncs + records (else replay shows the wrong pads).
      // SHIFT switches to the peer mode (mirrors the on-screen mode row + the FLX shift layer):
      // loop→roll, sampler→global, fx→fx2 (the FX latch layer). CUE has no shift peer (KEY retired).
      chainPrev: (_deck, id) => fxCtlFor(id)?.stepChain(-1),
      chainNext: (_deck, id) => fxCtlFor(id)?.stepChain(1),
      padModeCue: (deck, id) => padModeKey(deck, id, "cue"),
      padModeLoop: (deck, id, s) => padModeKey(deck, id, s ? "roll" : "loop"),
      padModeSampler: (deck, id, s) => padModeKey(deck, id, s ? "global" : "sampler"),
      padModeFx: (deck, id, s) => padModeKey(deck, id, s ? "fx2" : "fx"),
    };
    // The 8 pads (keys 1-8) route by the deck's pad mode: Hot Cue → cue, Loop → beat-loop
    // size, Sampler → that deck's region pad (via the sampler bridge ref), FX → a Pad-FX.
    // The keyboard has no per-key keyup, so a hold-FX TOGGLES here (press on / press off) and
    // a one-shot fires once; the on-screen pads stay true momentary.
    for (let i = 0; i < 8; i++)
      HANDLERS[`hotcue${i + 1}`] = (deck, id, s) =>
        deck.padMode === "loop" || deck.padMode === "roll"
          ? beatLoop(deck, id, i)
          : deck.padMode === "sampler"
            ? samplerCtl.current?.trigger(deckPadBase(id) + i)
            : deck.padMode === "global"
              ? samplerCtl.current?.trigger(i) // global pads are flat index 0-7
              : deck.padMode === "fx" || deck.padMode === "fx2"
                ? fxKeyDown(deck, id, i)
                : hotcue(deck, id, s, i);
    handlersRef.current = HANDLERS; // expose to the MIDI dispatcher (same button behaviours)
    const keyIndex = bindingIndex(mergeBindings(settings.keyBindings));

    const onKey = (e: KeyboardEvent) => {
      // Never hijack genuine TEXT entry — but ONLY text entry. A focused slider/checkbox/button
      // (e.g. a menu's range slider, a fader, a panel knob) must keep letting the board keys
      // through, or interacting with one silently kills every shortcut until you click away (the
      // "an open menu hijacks the board" pathology). So bail only for a real typing target.
      const el = document.activeElement as HTMLElement | null;
      const typingTarget =
        !!el &&
        (el.tagName === "TEXTAREA" ||
          el.isContentEditable ||
          (el.tagName === "INPUT" && !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type)));
      if (typingTarget) {
        // …but give the keyboard a way OUT of a lingering field (e.g. the Library filter box,
        // which keeps focus after you click it and otherwise swallows every board key with no
        // escape). Escape blurs it → focus returns to the body and the deck keys work again.
        if (e.key === "Escape") {
          el!.blur();
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

      // ★ THE LIBRARY, FROM THE KEYBOARD. Operator, 2026-11-02: "problems with basic interaction
      // and navigation using the shortcuts and the playlist". The FLX4's browse knob and LOAD
      // buttons drove the library through libRef; the keyboard reached none of it, so a track could
      // only be loaded with the mouse. While the Library is OPEN the arrows and Enter browse it
      // (libraryKeys.ts): ↑/↓ move the cursor, ← / → put it on the playlists / the tracks, Enter
      // loads onto the focused deck and Shift+Enter onto the other one. Closed, they are the board's
      // again. Loading is a deck action, so it respects canDriveDeck like any other.
      const libAct = libraryKeyAction(e.code, e.shiftKey, libOpenRef.current);
      if (libAct) {
        e.preventDefault();
        const lib = libRef.current;
        if (!lib) return;
        if (libAct.kind === "browse") lib.browse(libAct.delta);
        else if (libAct.kind === "sources") lib.setSourceNav(libAct.on);
        else {
          const target: DeckId = libAct.toOther ? (focused === "A" ? "B" : "A") : focused;
          if (canDriveDeckRef.current(target)) lib.load(target);
        }
        return;
      }

      const actionId = keyIndex.get(e.code);
      if (!actionId) return;
      e.preventDefault();
      if (actionId === "focusToggle") {
        setFocused((f) => (f === "A" ? "B" : "A"));
        return;
      }
      // ★ GLOBAL, like focusToggle — the mic belongs to the room, not to a deck, so it never
      // reaches the per-deck dispatch (and its gate) below.
      if (actionId === "micToggle") {
        micToggleRef.current?.();
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
    // The keyboard's release half. Only the FX pads care — everything else on the board is a
    // down-stroke action — so this resolves the key to a pad index and hands it to fxKeyUp, which
    // decides whether it was a tap (stay latched) or a hold (let go).
    const onKeyRelease = (e: KeyboardEvent) => {
      const actionId = keyIndex.get(e.code);
      if (!actionId?.startsWith("hotcue")) return;
      const i = Number(actionId.slice(6)) - 1;
      if (!(i >= 0 && i < 8)) return;
      // Release BOTH decks' held copies of this pad index: focus can move between the press and
      // the release, and a pad left latched because you tabbed decks mid-hold is a stuck effect.
      // Release BOTH decks' copies: focus can move between the press and the release, and a pad
      // left latched because you tabbed decks mid-hold is a stuck effect nobody asked for.
      for (const d of ["A", "B"] as DeckId[]) fxKeyUp(d === "A" ? engine.deckA : engine.deckB, d, i);
      refresh();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyRelease);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyRelease);
    };
  }, [engine, doSync, shift, focused, matchGain, cycleTempoRange, cyclePitchRange, refresh, libOpen, settings.keyBindings]);

  useEffect(() => {
    applySettings(settings);
    // ★ THE RESOLVED ACCENT HAS TO REACH THE CSS, NOT JUST THE PROPS — and it has to land AFTER
    // applySettings, which is why it lives inside this effect rather than its own.
    // `ACCENT` is artwork-aware and every component taking an `accent` PROP followed it correctly.
    // But applySettings writes `--neon-cyan` / `--neon-pink` straight from `settings.accentA/B`,
    // and most of the app's chrome (buttons, faders, meters) is coloured off those variables. So
    // with Deck artwork on, the waveform wore the cover's colour while everything around it wore
    // the stored setting, and rolling a palette visibly repainted the app "over" the artwork. Two
    // sources of truth for one colour, and only one of them knew about album art.
    // Written to :root; the shared-session vibe paints on <body> and still wins, so the precedence
    // stays room > artwork > your picked colour.
    document.documentElement.style.setProperty("--neon-cyan", ACCENT.A);
    document.documentElement.style.setProperty("--neon-pink", ACCENT.B);
    saveSettings(settings);
    engine.deckA.setJogPhysics(settings.jogWeight, platterDrag(settings.jogWeight));
    engine.deckB.setJogPhysics(settings.jogWeight, platterDrag(settings.jogWeight));
    engine.deckA.setBendStrength(settings.jogBendStrength);
    engine.deckB.setBendStrength(settings.jogBendStrength);
    for (const d of [engine.deckA, engine.deckB]) {
      d.setVinylSpeed(true, settings.vinylBrakeTime, settings.vinylStartTime); // a time of 0 = instant
      d.setBackSpinLength(settings.backSpinLength);
      d.setSlip(settings.slip); // Slip is a scrub behaviour now, driven from Controls (not a per-deck button)
    }
    engine.setStretchConfig({
      ...stretchConfig(settings.stretchQuality),
      engine: settings.stretchEngine,
      transient: settings.stretchTransient,
      aa: settings.stretchAa,
      tThresh: settings.stretchTThresh,
    });
    engine.setMasterHeadroomDb(settings.masterHeadroomDb); // trim BEFORE the limiter — see masterHeadroom.ts
    engine.setPerDeckLimiter(settings.perDeckLimiter); // idempotent: re-applying the same state rewires nothing
    engine.setSyncPhaseGain(settings.syncPhaseGain); // how hard SYNC pulls back onto the beat — see settings.ts
    // Which pairs AUTO / Smart Fader beat-match. The slider's top (41) is "Any pair": exactly √2.
    setBeatlockMax(settings.beatlockRangePct >= 41 ? BEATLOCK_ANY : settings.beatlockRangePct / 100);
    setDemucsQuality(stemConfig(settings.stemQuality)); // desktop demucs-GPU quality knobs
    // ACCENT is in the deps so a track change (new cover art) repaints the chrome too, not just
    // the waveform that happens to take it as a prop.
  }, [settings, engine, ACCENT.A, ACCENT.B]);

  // Route the mix to the chosen output device (only re-applies when it changes, so a
  // theme tweak never re-routes audio). "" = system default.
  useEffect(() => {
    // Clear a dead id rather than retrying it every load: the engine falls back to the default
    // output and tells us which device vanished, and the SETTING is ours to fix, not its.
    engine.onSinkLost = (gone) => {
      setSettings((s) => (s.audioOutputId === gone ? { ...s, audioOutputId: "" } : s));
    };
    void engine.setSinkId(settings.audioOutputId);
  }, [engine, settings.audioOutputId, setSettings]);

  // Route the headphone-cue (PFL) bus to a separate device. "" = no separate cue
  // (single output) — the CUE button stays a plain cue-point button.
  useEffect(() => {
    void engine.setCueSinkId(settings.audioCueOutputId);
  }, [engine, settings.audioCueOutputId]);

  // Chosen microphone input — remembered by the engine so the next enableMic() uses it, and
  // re-acquired live if the mic is already running. "" = system default mic.
  useEffect(() => {
    // ★ "None" is not a device — it is the absence of one. Hand the engine nothing and make sure
    // any stream that was live is let go, so unplugging the mic in Settings really unplugs it
    // (the board's mic controls vanish in the same act).
    if (settings.audioInputId === MIC_NONE) { engine.setMicOn(false); engine.disableMic(); return; }
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
    const max = Math.round(sr * 0.2); // ~200 ms — a strong always-on cushion for CarPlay Wi-Fi jitter
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
    // A route flip to wireless CarPlay (Wi-Fi Direct, 48 kHz) fires a devicechange but keeps the
    // page visible + the ctx "running", so none of the resume hooks fire — proactively pre-buffer
    // the moment the route changes, before the first skip (iOS gives no outputLatency to predict it).
    const onDevice = () => engine.primeWirelessFloor();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDevice);
    return () => {
      window.clearInterval(iv);
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDevice);
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

  // ★★ THE SEPARATION AUTHORITY. Operator ruling: "if the host cant separate then so be it,
  // no stems ... we cannot place the debt of separation on mere listeners." Exactly ONE device
  // per session may spend CPU/GPU on demucs, which also kills the duplicate-work race for free
  // (the shared R2 cache records only COMPLETED stems, so two capable devices used to both miss
  // and both separate the same track — there is no in-flight state to consult).
  //
  // Read as a PREDICATE, never snapshotted: the anchor moves (a host refresh hands the clock to
  // its own phone and takes it back on return), so a cached role is stale exactly when it matters.
  //
  // WHY NOT BARE isAnchor, which is the obvious version and is WRONG: the client connects to its
  // own room whether or not the user ever engages the session switches, and the server only
  // claims an anchor for a JOINED device (room.ts: `isJoined(self) && !anchorActive`). So a plain
  // solo DJ — the commonest case in the app — is status:"online" with anchorId still null and
  // isAnchor false. Gating on isAnchor alone would have stopped a solo rig separating at all.
  // Hence the last clause: with nobody else joined there is nobody to defer TO, so we are the
  // authority by default. A public listener is excluded FIRST and unconditionally — it may see an
  // empty peer roster, which would otherwise read as "alone" and hand it the very debt the ruling
  // forbids.
  const maySeparate = useCallback((): boolean => {
    const r = roomRef.current;
    if (!r) return true; // no room at all → solo rig, nobody to defer to
    if (r.listeningTo) return false; // public listener → NEVER, by ruling
    if (r.isAnchor) return true; // the session's single authority
    // Someone else is participating → the anchor owns this, not us. Ask, don't compute.
    if (r.peers.some((p) => p.id !== r.you && p.joined)) return false;
    return true; // connected but nobody else joined → solo in practice
  }, []);
  // Register it with the stems module, which enforces it at the ONE place separation begins
  // (loadStems), so no present or future call site can bypass the ruling by forgetting a check.
  const maySeparateRef = useRef(maySeparate);
  maySeparateRef.current = maySeparate;
  // ★ REGISTERED DURING THE FIRST RENDER, NOT IN AN EFFECT. This used to be a useEffect([]), which
  // runs after paint and after the 58 effects declared above it — so there was a window in which
  // the stems module's own default decided the question. That was survivable only because the
  // default was permissive, and the permissive default is the defect (see stems/index.ts). With a
  // deny default, a late registration would wrongly REFUSE a legitimate solo separation, so the
  // window has to close rather than change sides. Setting it here is idempotent and closes over a
  // ref, so re-running it costs nothing and a double render is harmless.
  const authorityRegistered = useRef(false);
  if (!authorityRegistered.current) {
    authorityRegistered.current = true;
    setSeparationAuthority(() => maySeparateRef.current());
  }

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
  // the deck stuck on the PLAIN MIX after any model round-trip — this said "the DSP split",
  // which f2004f2 deleted on 2026-07-01).
  const stemJobs = useRef<Map<string, Promise<Stems>>>(new Map());

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

  // STEM PIPELINE — deriveStems + its promote/cache helpers live in ./App/useStemPipeline so a
  // stems-agent owns that file instead of contending on App.tsx. The App spine (refs/engine/
  // session) is handed in; deriveStems comes back out and feeds the load + session + mobile paths.
  const { deriveStems, warmStems } = useStemPipeline({
    setStatusFor,
    requestStemsFromHost,
    maySeparate,
    stemModelRef,
    mobileStemsRef,
    autoEnabledRef,
    autoEnhanceRef,
    deriveGuard,
    stemLoadedKey,
    stemJobs,
    snapFollowRef,
    lastSnapshotRef,
  });

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
        A: deckSnapshot(engine.deckA, meta.A, publishedDeckId(loaded.A, loadingNow.current.A)),
        B: deckSnapshot(engine.deckB, meta.B, publishedDeckId(loaded.B, loadingNow.current.B)),
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
      // ★ EXACTLY ONE `load.end` PER LOAD, AND ONE FOR EVERY LOAD. Both halves were wrong when this
      // instrument was first written: a SUCCESSFUL load emitted nothing at all, so "load.start with
      // no load.end" meant either "it worked" or "it is still hanging" — the two readings the ring
      // exists to separate, made indistinguishable by the recorder itself. (Read live at HEAD: the
      // host's own boot restore of both decks sat 41 s with no end line, and that was success.)
      // Meanwhile a FAILING load emitted twice, from the catch and again from the finally, the
      // second line overwriting `aborted` with `no-land` for anyone reading the last one.
      let ended = false;
      const endLoad = (why: string) => {
        if (ended) return;
        ended = true;
        event("load.end", { deck: id, vid: claimedVid || (track.videoId ?? null), seq, landed, why });
      };
      setStatusFor(id, null);
      // Free the OUTGOING track's stem set (~300–424 MB) up front, BEFORE we decode
      // the new track and build its stems. Otherwise the old set + the new mix + the
      // new stem set briefly coexist on this deck (plus the other deck's set) and
      // OOM-reload iPhone Safari on a track switch. The stems get re-derived anyway.
      stemTrace(`load ${id}:start`, track.title?.slice(0, 40));
      // ★ EVERY LOAD, NAMED, INCLUDING THE ONES THAT END IN SILENCE. A follower's deck B was
      // observed deciding action=load from the host's snapshot and then never arriving (ruling
      // 92d04ef9): the catch below returns WITHOUT a status when the load was aborted or
      // superseded, and `loadTrackToDeck` aborts the previous load on the SAME deck — so a boot
      // restore and a room snapshot racing each other on one deck can leave the loser invisible.
      // The ring is the right home: the listener this happens to is on a phone with no console.
      event("load.start", { deck: id, vid: track.videoId ?? null, seq });
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
          setStatusFor(id, { phase: "downloading", of: "track", detail: "Matching…" });
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
        loadingSeq.current[id] = seq; // whoever claimed LAST owns the claim, same id or not
        loadingSince.current[id] = performance.now(); // so "is this load stuck?" is asked of the LOAD
        loadingNow.current[id] = vid; //                    and so the published board says what is coming
        claimedVid = vid;
        // Lyrics: cache/pool → LRCLIB words (shown instantly, line-synced) → upgraded to
        // word-level by aligning to the neural vocal stem (CPU DSP, no GPU, contributed back)
        // → YouTube captions as the fallback. The resolver polls the deck for neural vocals on
        // its own, so it's decoupled from the stem pipeline; it cancels via stale() on the next load.
        setCaptionSource((s) => ({ ...s, [id]: null }));
        setLyricStatus((s) => ({ ...s, [id]: null }));
        void resolveLyrics({
          videoId: vid,
          deck: engine.deck(id),
          engine: lyricsModelRef.current === "youtube" ? "youtube" : "lrclib",
          // The uploader's title — the fallback name when acoustic identity has no match (~1 in 5).
          trackTitle: track.title,
          // ★ FROM THE CATALOG, NOT THE DECK. Lyrics resolve BEFORE the audio is decoded, so
          // deck.duration is still 0 here — and LRCLIB's exact /get is duration-matched, so a zero
          // silently skips the fast precise lookup and falls through to the slow fuzzy search.
          duration: track.duration,
          enabled: lyricsAutoRef.current,
          // A neural vocal stem UPGRADES lyrics from line-level to word-level. It is no longer a
          // prerequisite: LRCLIB's own line clock works with no stem, no model and no GPU.
          stemsEnabled: stemModelRef.current !== "off",
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
        // True when this load REUSED a persisted grid from the shared dataset (vs deriving locally).
        // Gates the contribution below: a reuse-hit has nothing new to add, so it skips the re-POST;
        // a local derive (fresh, behind, or foreign-shape) DOES post → self-healing the row.
        let reusedGrid = false;
        // Set from the reuse verdict below: false when the pooled row describes DIFFERENT AUDIO, in
        // which case contributing ours would only start an overwrite war with the device that wrote
        // it. mayContributeAnalysis carries the reasoning.
        let mayContribute = true;
        let storedPaletteStr: string | null = null; // stored art palette from the shared dataset (if any)
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
                setStatusFor(id, { phase: "downloading", of: "track", pct, detail: `Downloading… ${label}` });
              },
              ctrl.signal,
            );
            void putAudio(vid, data.slice(0)); // cache for next refresh
          }
          if (stale()) return;
          setStatusFor(id, { phase: "downloading", of: "track", detail: "Decoding…" });
          const buffer = await decodeAudio(engine.ctx, data);
          if (stale()) return;
          // Cache-first (Metadata B): reuse a persisted beatgrid from the shared dataset instead of
          // re-running the expensive detector — but ONLY when the stored grid is a shape this build
          // can read (deserializeGrid is epoch-gated), at least as new as what we'd produce, AND
          // DESCRIBES THE AUDIO WE JUST DECODED (mayReuseGrid). That last one was missing: the gate
          // asked about the algorithm and never about the recording, while `firstBeat` is an
          // absolute time and analyzeTrack takes a supplied grid verbatim — so audio that starts
          // even a little differently from the contributor's puts every beat in the track out by
          // that much, permanently, and re-analysing cannot fix it because re-analysing is what
          // this skips. A refused grid → derive locally, which re-contributes at OUR version below,
          // upgrading the row: the pool converges to the newest detector as tracks get touched.
          // Key by track.videoId (what postAnalysis writes).
          let suppliedGrid: Beatgrid | null = null;
          if (track.videoId) {
            const stored = await fetchAnalysisFull(track.videoId, ctrl.signal);
            if (stale()) return;
            const verdict = mayReuseGrid(stored, buffer.duration, ANALYSIS_VERSION);
            if (verdict.ok) suppliedGrid = deserializeGrid(stored!.grid);
            // The verdict also decides whether we may contribute — see mayContributeAnalysis.
            mayContribute = mayContributeAnalysis(verdict.why);
            // ★ A CONTESTED TRACK IS NOW STABLE AND SILENT, AND SILENT IS THE HALF THAT NEEDS A
            // WITNESS. fa6b9b6 stopped two devices overwriting each other's pooled row, correctly —
            // but the survivor is whoever WROTE FIRST, with no tiebreak and no way to displace a row
            // that is simply wrong for everyone else. This device then re-derives on every single
            // load, forever, paying ~0.8–1.6 s each time, and nothing anywhere says why. One line,
            // once per load, so "why does this one track always take a second to grid" is
            // answerable from a console instead of from a guess.
            if (verdict.why === "different-audio")
              console.info(
                `[htl] pooled grid declined for ${vid}: it describes ${stored?.duration?.toFixed(1)}s of audio and we decoded ${buffer.duration.toFixed(1)}s — deriving locally and NOT contributing, so the pooled row stays with whoever wrote it first`,
              );
            // ★ AND THE OTHER REFUSALS, because `different-audio` is not the one whose FREQUENCY is
            // unknown. `unknown-duration` refuses a row we cannot check at all, and how much of the
            // real pool that is cannot be measured from here — every row on this machine was written
            // by this machine, which is the wrong population to answer it with. If it turns out to be
            // most of them, every load re-derives and the only symptom is that loads got slower.
            // `behind-version` is expected and loud on purpose: after an ANALYSIS_VERSION bump it
            // fires once per track and IS the lazy migration running.
            else if (verdict.why === "unknown-duration" || verdict.why === "behind-version")
              console.info(`[htl] pooled grid not reused for ${vid}: ${verdict.why} — deriving locally and contributing at v${ANALYSIS_VERSION}`);
            storedPaletteStr = stored?.palette ?? null;
          }
          reusedGrid = suppliedGrid != null;
          const analysis = await analyzeTrackAsync(buffer, suppliedGrid);
          if (stale()) return;
          cached = { buffer, analysis };
          setCachedTrack(vid, cached);
        }
        if (stale()) return;
        engine.deck(id).setBuffer(cached.buffer, cached.analysis.beatgrid);
        // The resident audio bill, written next to the decode-crash guard's record so an iOS OOM
        // has a measured number before it rather than arithmetic after it.
        engine.reportAudioResident(`deck ${id} load`);
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
        // Album-art palette (Phase B) + the analysis contribution, in ONE self-healing post. Read the
        // stored palette; if none yet, extract it from the same-origin /api/art image (canvas-untainted
        // now that art is first-party). Apply it to the deck meta for per-track theming, then contribute
        // grid + palette to the shared dataset. Fire-and-forget so neither the image load nor the POST
        // blocks the deck. The POST fires when we DERIVED a grid OR extracted a NEW palette (either is
        // new data); it carries the grid/summary so a palette-only top-up never nulls them. Skipping it
        // when a stored grid was reused AND the palette already existed = nothing new to add.
        if (track.videoId) {
          const artId = track.videoId;
          const derived = cached!;
          void (async () => {
            try {
              let paletteStr = deserializePalette(storedPaletteStr) ? storedPaletteStr : null;
              let freshPalette = false;
              if (!paletteStr) {
                const p = await extractPalette(`/api/art/${artId}`);
                if (p) {
                  paletteStr = serializePalette(p);
                  freshPalette = true;
                }
              }
              const pal = deserializePalette(paletteStr);
              if (pal) setMeta((m) => (m[id]?.videoId === artId ? { ...m, [id]: { ...m[id], palette: pal } } : m));
              if (mayContribute && (!reusedGrid || freshPalette)) {
                void postAnalysis({
                  videoId: artId,
                  bpm: derived.analysis.bpm,
                  key: derived.analysis.key?.camelot ?? null,
                  keyName: derived.analysis.key?.name ?? null,
                  beatOffset: derived.analysis.beatgrid?.firstBeat ?? null,
                  duration: Math.round(derived.buffer.duration * 1000) / 1000, // ms precision: the reuse gate cannot be tighter than the write
                  grid: derived.analysis.beatgrid ? serializeGrid(derived.analysis.beatgrid) : null,
                  palette: paletteStr,
                  energy: derived.analysis.energy, // the auto-mix arc's input — see trackEnergy

                  version: ANALYSIS_VERSION, // stamps the algorithm → drives the convergence guard
                });
              }
            } catch {
              /* palette/contribution is best-effort — never affects the load */
            }
          })();
        }
        // Stems: the deck plays the PLAIN MIX until a real neural set arrives (R2 cache →
        // on-device separation where supported), then swaps in. There is no instant "DSP split"
        // to light the buttons with — f2004f2 deleted it on 2026-07-01. stale() guards re-loads.
        // Keyed by the resolved id so the R2 stem cache lines up with the stream.
        void deriveStems(id, vid, cached!.buffer, stale);
      } catch (e) {
        endLoad((e as Error).name === "AbortError" ? "aborted" : stale() ? "superseded" : "failed");
        if ((e as Error).name === "AbortError" || stale()) return;
        setStatusFor(id, { phase: "failed", detail: (e as Error).message ?? String(e) });
        return;
      } finally {
        if (!stale()) setLoading((l) => ({ ...l, [id]: false }));
        // Release the in-flight claim whenever it never landed AND it's still OURS — the
        // `=== claimedVid` check proves no newer load took it over, so this is safe even when we
        // were SUPERSEDED (stale). The old code only released on !stale(), so a superseded load
        // whose successor bailed early stranded this claim → a later snapshot read it as "still
        // loading" and skipped the reload forever (the guest stayed on the wrong track). On a
        // successful land we KEEP the claim as the per-deck dedupe key.
        // ★ RELEASE ONLY IF THIS LOAD STILL OWNS THE CLAIM, and ownership is the SEQUENCE, not the
        // id. This test used to be `loadingVid.current[id] === claimedVid`, whose comment said that
        // proved no newer load had taken it over. It proves that only when a successor loads a
        // DIFFERENT track — and the one path that matters reloads the SAME one. The follower's
        // tick-resync re-requests the anchor's track, so a superseded load released the claim its
        // live successor was holding; the next tick then read "nothing loading this vid", started
        // another load, aborted the running one, and the new predecessor wiped the claim again.
        // Deck B livelocked: a new load every ~3 s, none of them ever landing, no error, no status,
        // the listener simply stuck on the wrong song (ruling ab419a94, caught on the rig at HEAD).
        // Comparing sequences keeps what the id test was written for — a successor that dies before
        // claiming leaves the claim owned by US, so we still release it and nothing is stranded.
        if (shouldReleaseClaim({ landed, claimedVid, claimSeq: loadingSeq.current[id], mySeq: seq })) loadingVid.current[id] = "";
        // "Loading right now" ends when this load ends, landed or not — but only if a newer load has
        // not already taken the deck over, or we would erase ITS announcement.
        if (loadingSeq.current[id] === seq) loadingNow.current[id] = "";
        // Every exit passes here, so this is where the line is guaranteed: a load that landed says
        // `landed`, and one that ended without landing and without throwing (an early `return` on a
        // stale sequence) — the quietest of all — says so too.
        endLoad(landed ? "landed" : stale() ? "stale" : "no-land");
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
    async (id: DeckId, videoId: string, mix: AudioBuffer, model: StemModel, opts: SeparateOpts) => {
      const { stale, report, purpose } = opts;
      // ★ `purpose` IS REQUIRED, and that is the point. This function serves two different intents:
      //   "reanalyze" — the user asked for a FRESH compute (maybe at a different shift-TTA quality,
      //                 which the job key does not include), so it must force and must not be
      //                 swallowed by an existing job;
      //   "request"   — a remote asked for these stems to EXIST, so it must join a running job or hit
      //                 the cache rather than forcing a second separation of the same track.
      // Hardcoding force=true for both is what made a remote request separate the host's track a second
      // time even after loadStems learned to dedupe (0dbe499). It is a required field rather than an
      // inference from whether `report` was passed, because a signal that merely correlates with intent
      // is the dead .catch() again — and required means the compiler refuses a call site that doesn't say.
      const force = separationForces(purpose);
      const verb = force ? "Re-analyzing" : "Separating";
      // ★ `report` EXISTS BECAUSE THIS FUNCTION NEVER THROWS. Every failure below is caught and
      // turned into local status, so a caller that awaits it cannot tell success from failure —
      // it always resolves. handleStemRequest had a `.catch()` on this call that could therefore
      // never fire: dead code, shipped under a commit message claiming a failed separation now
      // reports its error. It did not. The requester's only evidence was, again, silence.
      // `report` is how the outcome leaves this function for anyone who is not this device's UI.
      if (model.kind === "dsp") return void report?.({ kind: "failed", reason: `${model.label} is a local-only model.` });
      if (modelSupport(model) !== "runs") {
        report?.({ kind: "failed", reason: `The host's device can't run ${model.label}.` });
        setStatusFor(id, { phase: "unavailable", detail: `${model.label}: can't re-analyze on this device.` });
        setTimeout(() => !stale?.() && setStatusFor(id, null), 6000);
        return;
      }
      // ★ HOST-ONLY, and this path needs its OWN check: re-analyze passes force=true, which
      // skips the cache probe entirely, so the cold-cache gate in deriveStems never sees it.
      // Without this a guest or listener could hand itself a full separation from Settings.
      if (!maySeparate()) {
        report?.({ kind: "failed", reason: "This device is not the session's audio host." });
        setStatusFor(id, {
          phase: "unavailable",
          detail: "Only the session host can re-analyze stems — you're not the audio host of this session.",
        });
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
      setStatusFor(id, { phase: "separating", pct: 0, detail: `${verb} with ${model.label}…` });
      try {
        const stems = await loadStems(
          engine.ctx,
          videoId,
          mix,
          model,
          (pct) => {
            const p = Math.round(pct * 100);
            setStatusFor(id, { phase: "separating", pct: p, detail: `${verb} with ${model.label}… ${p}%` });
            report?.({ kind: "progress", pct: p });
          },
          force, // reanalyze forces a fresh compute; a request joins running work or uses the cache
        );
        if (stale?.()) return;
        // ★ THE DECK MUST STILL HOLD THIS TRACK. The only guard used to be `stale`, which a remote
        // request never passes — and nothing downstream checks either: setStems packs whatever it is
        // handed against the deck's CURRENT buffer. So a request for track T, still separating when
        // the host loaded track U onto that deck, applied T's stems there, and the deck played T's
        // stems while cued on U. Today's work made that far easier to hit: every request now lands
        // on the host and can wait behind running and preload jobs in the one-at-a-time GPU queue,
        // long enough to outlast a track change on an AUTO host. Checked against the deck itself for
        // BOTH purposes, because re-analyze had the same hole.
        if (latest.current.loaded[id] !== videoId) {
          report?.({ kind: "failed", reason: "The host changed the track on that deck before its stems were ready." });
          return;
        }
        // loadStems throws on failure now (no DSP fallback) → the catch below reports it. A
        // returned set is always the real neural model, so flag it neural (setStems defaults false).
        engine.deck(id).setStems(stems, true, videoId);
        refresh();
        setStatusFor(id, { phase: "ready", src: stemSrcLabel(model.id), detail: force ? `${model.label} ready (re-analyzed).` : `${model.label} ready.` });
      } catch (e) {
        console.warn("[htl] re-analyze failed:", e);
        report?.({ kind: "failed", reason: `The host's separation failed: ${e instanceof Error ? e.message : String(e)}` });
        setStatusFor(id, { phase: "failed", detail: `${model.label} re-analyze failed — see console.` });
        setTimeout(() => !stale?.() && setStatusFor(id, null), 6000);
      } finally {
        if (gpuSeparate) disarmGpu();
      }
    },
    [engine, refresh, setStatusFor, maySeparate],
  );

  // "Re-analyze loaded track(s)" with `modelId` from Settings: switch to that model
  // and force a fresh separation on every loaded deck (ignoring any cached result).
  const reanalyze = useCallback(
    (modelId: string, only?: DeckId) => {
      const model = getStemModel(modelId);
      if (model.kind === "dsp") return;
      // Only flip the global model when it ACTUALLY changes — returning the same `s` reference makes
      // React bail out, so a per-deck re-analyze doesn't trip the model-change effect that would
      // otherwise re-derive the OTHER deck too.
      setSettings((s) => (s.stemModel === modelId ? s : { ...s, stemModel: modelId }));
      for (const id of only ? [only] : (["A", "B"] as DeckId[])) {
        const vid = loaded[id];
        const deck = engine.deck(id);
        if (!vid || !deck.buffer) continue;
        void forceSeparate(id, vid, deck.buffer, model, { purpose: "reanalyze" });
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

  // Re-run stems for whatever is on the decks once a crash guard lifts — the same deliberate
  // re-derive a model change does, so a "Try again" takes effect on the tracks already loaded.
  const rederiveLoaded = () => {
    for (const id of ["A", "B"] as DeckId[]) {
      const vid = latest.current.loaded[id];
      const deck = engine.deck(id);
      if (!vid || !deck.buffer) continue;
      deriveGuard.current[id] = "";
      void deriveStems(id, vid, deck.buffer, () => latest.current.loaded[id] !== vid);
    }
  };
  // The answer to a boot-time crash prompt. "Keep off" leaves the block standing for this load, and
  // the prompt returns on the next one. "Try again" lifts it. For the GPU guard it also restores a
  // GPU model if the setting is not on one: older builds bounced the setting to "off" when they
  // blocked, so a lifted block on an "off" setting would otherwise change nothing the user can see.
  const answerCrash = (id: CrashPrompt["id"], tryAgain: boolean) => {
    setCrashAsks((asks) => asks.filter((p) => p.id !== id));
    if (!tryAgain) return;
    if (id === "stems") {
      resetStemGuard();
      rederiveLoaded();
      return;
    }
    unblockGpu();
    const gpuModel = gpuCrashModel() ?? STEM_MODELS.find((m) => m.tier === "gpu")?.id;
    if (gpuModel && getStemModel(settings.stemModel).tier !== "gpu") {
      setSettings((s) => ({ ...s, stemModel: gpuModel })); // the model-change effect above re-derives
    } else {
      rederiveLoaded();
    }
  };

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
      // ★ THE CHANNEL COMES BACK EVEN WITH NO TRACK ON IT. This restore only ever ran inside the
      // track load below, behind `if (!d.videoId) return` — so an empty deck restored nothing, and
      // the FX chains a DJ had built were silently gone on every refresh. The rack belongs to the
      // DECK, not to whatever is playing through it.
      applyDeckRack(engine.deck(id), d);
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
  // The inbound session-sync engine — applies a host's snapshot / control intents / playhead ticks
  // to THIS device's local engine — lives in ./App/useSessionSync (so a session agent owns it
  // without contending on App). These 4 refs bridge it to the auto-mixer + sampler set up far below
  // (assigned there); declared here so both the hook and that code share them.
  const autoMixerControlRef = useRef<(action: "toggle" | "skip" | "mixnow" | "hold") => void>(() => {});
  const mixQueueRef = useRef<MixQueue | null>(null);
  const autoIsRemoteRef = useRef(false);
  const samplerApplyRef = useRef<((intent: Extract<Intent, { kind: "sample" }>) => void) | null>(null);
  const { runRoomLoad, applyRoomSnapshot, onRoomIntent, onRoomTick } = useSessionSync({
    setStatusFor,
    nameDeckFromSnapshot,
    loadTrackToDeck,
    loaded,
    setCrossfade,
    setSettings,
    applyDeckStems,
    latest,
    stemViewWaitTimers,
    roomLoadTarget,
    reconciledTarget,
    deferDecodeRef,
    pendingRoomLoad,
    loadingVid,
    homeAdoptAt,
    lastSnapshotRef,
    lastTickAt,
    followSeekAt,
    resyncAt,
    resyncTries,
    loadingSince,
    scrubbing,
    stemTouch,
    snapFollowRef,
    followRef,
    ensureGuestStemsRef,
    stemReqRef,
    stemAckRef,
    autoMixerControlRef,
    mixQueueRef,
    autoIsRemoteRef,
    samplerApplyRef,
  });

  // G1c recorded-set replay lives in ./App/useReplay (replayDispatch + useSetReplay + the play/
  // edit-trim launchers). Returns drive the follow/lock gates + ReplayBar + Profile/Discover.
  const { replay, playRecordedSet, editTrim, trimEdit, setTrimEdit } = useReplay({
    applyRoomSnapshot,
    onRoomIntent,
    onRoomTick,
    setRemoteAutomix,
    setProfileOpen,
    setDiscoverOpen,
    setPublicHandle,
    playSetRef,
  });

  // The session stem-view concern (inbound host-streamed 4-lane envelopes + the outbound host
  // streamers + the on-join publish) lives in ./App/useStemViewSync. Returns feed useRoom
  // (onStemView), the onStemsReady + join-publish effects, and stemReqRef below.
  const { onRoomStemView, sendHostStemView, handleStemRequest } = useStemViewSync({
    setStatusFor,
    forceSeparate,
    loaded,
    latest,
    stemReqTimers,
    stemViewWaitTimers,
    reqSepGuard,
  });


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

  // The session lyrics concern (inbound host captions + the host broadcaster + the user reprocess
  // escape hatch) lives in ./App/useLyricsSync. Returns feed useRoom (onLyrics), the caption-change
  // + join-publish broadcast effects, and a deck's onReprocessLyrics prop.
  const { onRoomLyrics, reprocessLyrics, sendHostLyrics } = useLyricsSync({
    captions,
    captionSource,
    setCaptions,
    setCaptionSource,
    setLyricStatus,
    latest,
    captionVidRef,
    loadSeq,
    lyricsModelRef,
    stemModelRef,
  });

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
      // The room asks a device what is on its board the moment it takes the anchor slot; answer with
      // the CURRENT one rather than whatever was last published (a fresh page has published nothing).
      snapshotNow: () => buildSnapshot(),
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

  // The unread badge has to tick while the People dock is CLOSED — that is the whole job of a
  // badge — so the poll lives out here beside friendsOnline, for exactly the reason stated there.
  // The old bell owned both the count and the popover and could only count while mounted.
  const notifications = useNotifications(!!room.user);

  // ★ THE GRAPH CACHE IS VIEWER-RELATIVE, so a change of identity is the one event that truly
  // invalidates it — every row carries `following` / `followsYou` computed against whoever was
  // signed in. Without this, signing out and back in as someone else would serve the previous
  // account's graph, with the previous account's relationships, out of a session-lifetime cache.
  const seenUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = room.user?.id ?? null;
    if (seenUserId.current !== undefined && seenUserId.current !== id) {
      clearGraphCache();
      setPeopleView((v) => ({ ...v, people: { ...v.people, query: "" }, scroll: { ...v.scroll, people: 0 } }));
    }
    seenUserId.current = id;
  }, [room.user?.id]);

  // The Profile dock is where a handle gets claimed; on its close, refresh the room's
  // account view so "Go live" un-gates (room.user.handle) without a page reload.
  useEffect(() => {
    if (!profileOpen) room.refreshUser();
  }, [profileOpen, room.refreshUser]);

  // Contextual room colour: while CONNECTED to a session (and opted in), wear the HOST's
  // Friends (mutual follows) online now — owned here (not in Discover) because the chin presence
  // dot must show even when the Discover panel is closed. Polled while signed in; Discover gets
  // the list as a prop so there's one poll, not two.
  const [friendsOnline, setFriendsOnline] = useState<FriendPresence[]>([]);
  useEffect(() => {
    if (!room.signedIn) {
      setFriendsOnline([]);
      return;
    }
    let alive = true;
    const load = () =>
      fetchFriendsOnline()
        .then((f) => alive && setFriendsOnline(f))
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [room.signedIn]);

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

  // Fill the spine room ref (read lazily by the host stem-view / lyrics streamers below).
  roomRef.current = room;

  // Broadcast whenever a deck's captions change and we're the board authority.
  useEffect(() => {
    sendHostLyrics("A");
    sendHostLyrics("B");
  }, [captions, captionSource, room.status, room.controlling, room.isAnchor, sendHostLyrics]);

  stemReqRef.current = handleStemRequest;
  // ★ THE REQUESTER NOW WAITS ON THE HOST'S WORD, NOT A CLOCK. requestStemsFromHost arms a fixed 20 s
  // timeout, which used to be the ONLY evidence of the host's state and fired while the host was
  // still succeeding. An ack replaces that guess with a fact:
  //   refused    → say WHY immediately, instead of 20 s of "Requesting…" followed by a wrong reason;
  //   separating → drop the fixed deadline and re-arm a STALL watchdog on every progress step, so a
  //                long track on a slow host is allowed as long as it keeps moving, and only a host
  //                that has genuinely gone quiet is reported.
  // Success needs no branch here: the stem view landing clears the timer (onRoomStemView), as before.
  stemAckRef.current = (id, state, reason, pct) => {
    const t = stemReqTimers.current[id];
    if (t) clearTimeout(t);
    stemReqTimers.current[id] = undefined;
    if (state === "refused") {
      setStatusFor(id, { phase: "unavailable", detail: reason ?? "The session host can't make stems for this track." });
      setTimeout(() => setStatusFor(id, null), 6000);
      return;
    }
    const p = typeof pct === "number" ? pct : undefined;
    // "loading" (the host downloading model weights) re-arms the same stall watchdog as separation
    // progress: once every phase REPORTS, the watchdog measures silence rather than guessing duration.
    const what = state === "loading" ? "downloading the stem model" : state === "queued" ? "queued behind other stem work" : "separating stems";
    setStatusFor(id, {
      phase: "separating",
      ...(p !== undefined ? { pct: p } : {}),
      detail: p !== undefined ? `The session host is ${what}… ${p}%` : reason ?? `The session host is ${what}…`,
    });
    stemReqTimers.current[id] = setTimeout(() => {
      setStatusFor(id, { phase: "unavailable", detail: "The session host stopped reporting progress on these stems." });
      setTimeout(() => setStatusFor(id, null), 6000);
    }, STEM_ACK_STALL_MS);
  };

  useEffect(() => {
    engine.deckA.onStemsReady = () => sendHostStemView("A");
    engine.deckB.onStemsReady = () => sendHostStemView("B");
    // ★ A STEM SET THAT NEVER REACHED THE ENGINE (applied before the playback node attached — see
    // Deck/stemsLost.ts). The deck has already reset to honest no-stems and kept its mix audible; derive
    // the set again through the ordinary path, which now finds a node. Only for the track still on the
    // deck — if it changed, the new track's own load owns its stems. The guards are cleared because they
    // record a set that no longer exists, and would otherwise make deriveStems return as "already done".
    const stemsLost = (id: DeckId) => (lostVideoId: string | null) => {
      const vid = latest.current.loaded[id];
      const deck = engine.deck(id);
      if (!lostVideoId || vid !== lostVideoId || !deck.buffer) return;
      deriveGuard.current[id] = "";
      stemLoadedKey.current[id] = "";
      refresh();
      void deriveStems(id, vid, deck.buffer, () => latest.current.loaded[id] !== vid);
    };
    engine.deckA.onStemsLost = stemsLost("A");
    engine.deckB.onStemsLost = stemsLost("B");
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
      engine.deckA.onStemsLost = undefined;
      engine.deckB.onStemsLost = undefined;
      engine.deckA.onLoopEdit = undefined;
      engine.deckB.onLoopEdit = undefined;
    };
    // deriveStems + refresh: the stems-lost handler calls them, so a stale copy would re-derive through
    // yesterday's closures. Re-running this effect only re-wires the deck hooks.
  }, [engine, sendHostStemView, deriveStems, refresh]);

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
      emit({ kind: "control", deck: id, param: "eqMix", value: d.eqMix });
      emit({ kind: "control", deck: id, param: "eqOut", value: d.eqOut });
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
  // The rule itself lives in App/drivePermission.ts — pure, so it is TESTED rather than read. It
  // was three inline arrows here, consulted through a ref by three key handlers and by the whole
  // control surface, with nothing able to reach it from a test.
  const seat = { enabled: room.enabled, controlling: room.controlling, myDeck: room.myDeck };
  const canDriveDeck = (id: DeckId) => canDriveDeckFor(seat, id);
  const deckLocked = (id: DeckId) => !canDriveDeckFor(seat, id, replay.active);
  // A whole-board move (the crossfader) needs FULL control — locked for a stage DJ, any follower,
  // and during replay.
  const boardLocked = !canDriveBoardFor(seat, replay.active);
  canDriveDeckRef.current = canDriveDeck;
  boardLockedRef.current = boardLocked;
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
  // Bridge to the sampler's trigger/release (set by BoardBar) so MIDI-learned + 1-8
  // keyboard pads fire the sampler without threading the api through the keymap effect.
  const samplerCtl = useRef<{ trigger: (i: number) => void; release: (i: number) => void } | null>(null);
  // A decoded MidiEvent is fanned out to the SAME handlers the keyboard/buttons use, so a hardware
  // board has full feature + session-sync parity. The dispatcher (value→real-range scaling, focus/
  // shift/room-sync/jog) lives in ./App/useMidiRouting so a control-surface agent owns that file.
  const { onMidiEvent } = useMidiRouting({
    settings,
    room,
    focused,
    setFocused,
    setZoomFor,
    midiShift,
    focusShift,
    shiftLatched,
    shiftHeld,
    emitSeekTo,
    onJogStart,
    onJogEnd,
    emitJog,
    canDriveDeckRef,
    boardLockedRef,
    eqStemModeRef,
    fxSelRef,
    handlersRef,
    libRef,
    toggleLibrary: toggleLib,
    closeLibrary: () => setLibOpen(false),
    lockedRef,
    micVolSetRef,
    xfaderEnabledRef,
    knobPickup,
    samplerCtl,
    smartFader,
    setMidiShift,
    setFocusShift,
    setCrossfade,
    setSmartFaderArmed,
    setCueMixSt,
    setCueLevelSt,
    setMasterVolSt,
    jogVinyl,
    latest,
  });

  const midi = useMidi({
    enabled: settings.midiEnabled,
    learn: settings.midiBindings,
    onEvent: onMidiEvent,
    onLearnChange: (next) => setSettings((s) => ({ ...s, midiBindings: next })),
  });

  // 🎮 An Xbox/standard gamepad as a control surface — emits the SAME MidiEvents as the MIDI
  // layer into onMidiEvent (so it inherits focus / shift / room-sync / jog). Live whenever a
  // pad is present; rumbles on the beat of the deck being driven. See src/htl/gamepad.
  useGamepad({ engine, getFocused: () => focused, onEvent: onMidiEvent, getLibraryOpen: () => libOpen });

  // Light the controller from deck state (play/cue/sync/loop + hot-cue pads). Polled
  // at ~7 Hz; the engine diffs each lamp so only changes are actually sent. The mute
  // SysEx keep-alive is handled inside MidiEngine.
  useEffect(() => { midiSendRef.current = midi.send; }, [midi.send]);
  useEffect(() => {
    if (!settings.midiEnabled || midi.status.state !== "connected") return;
    const push = () => {
      (["A", "B"] as DeckId[]).forEach((id) => {
        const d = engine.deck(id);
        const fb: DeckFeedback = {
          play: d.playing,
          cue: !d.playing, // cue lamp lit while stopped (sitting on the cue), per DJ convention
          // SYNC lamp = the MASTER indicator: lit ONLY on the deck that is the tempo master, so
          // it marks which deck leads, swaps to the other deck when master hands over, and goes
          // dark when sync is disengaged. (The slave follows but doesn't claim the lamp.)
          sync: d.syncRole === "master",
          loop: !!d.loop?.active,
          // Manual loop IN/OUT button lamps: lit when that edge exists (loop active) or is armed
          // for fine-adjust (Shift-IN/OUT → deck.adjusting). Off otherwise.
          loopIn: !!d.loop?.active || d.adjusting === "in",
          loopOut: !!d.loop?.active || d.adjusting === "out",
          cuePfl: d.cueLevel > 0, // channel headphone PFL active
          hotcues: Array.from({ length: 8 }, (_, i) => d.hotCues[i] != null),
          // The shifted peer modes light their BASE button's lamp (roll→loop, global→sampler, …).
          padMode:
            d.padMode === "roll" ? "loop"
            : d.padMode === "global" ? "sampler"
            : d.padMode === "fx2" ? "fx"
            : d.padMode,
        };
        midi.setFeedback(id, fb);
      });
      // FORCE the FLX hardware Smart-CFX OFF. That feature (host-controlled, LATCHING, on 0x96/0x00)
      // remaps the COLOR knob onto the trim CC and fights trim. We do eq/stem entirely in SOFTWARE,
      // so the hardware feature must stay disengaged — send 0x00 on connect (initial diff) and after
      // every toggle, NEVER 0x7F. The lamp stays dark; eq/stem mode is shown on-screen.
      const cfxOn = eqStemModeRef.current;
      if (cfxOn !== cfxLedRef.current) {
        cfxLedRef.current = cfxOn;
        midi.send([0x96, 0x00, 0x00]);
      }
      // FORCE the FLX hardware SMART FADER OFF too — SAME pathology as Smart-CFX (host-controlled,
      // latching, on 0x96/0x01): driving 0x7F engages the hardware feature and changes crossfader
      // behaviour. We do the crossfader-enable in software, so keep the hardware feature disengaged:
      // send 0x00 on connect + every toggle, NEVER 0x7F. Lamp stays dark.
      const xfOn = xfaderEnabledRef.current;
      if (xfOn !== xfaderLedRef.current) {
        xfaderLedRef.current = xfOn;
        midi.send([0x96, 0x01, 0x00]);
      }
      // FX bypass (RELEASE FX ON/OFF) lamp 0x94/0x47 = the FOCUSED deck's SELECTED effect is active
      // (not bypassed). Diffed. (0x7F may BLINK on this lamp; adjust the value if so.)
      const fid = focusedRef.current;
      const fdeck = engine.deck(fid);
      const sd = fdeck.fxDevices[fxSelRef.current[fid]];
      const fxLit = sd ? (sd.kind === "eq" ? !fdeck.eqBypassed : !sd.bypassed) : false;
      if (fxLit !== beatFxLedRef.current) {
        beatFxLedRef.current = fxLit;
        midi.send([0x94, 0x47, fxLit ? 0x7f : 0x00]);
      }
    };
    push();
    const iv = setInterval(push, 150);
    return () => clearInterval(iv);
  }, [engine, settings.midiEnabled, midi.status.state, midi.setFeedback, midi.send]);
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
  //
  // ★ THE GUARD IS HERE BECAUSE THIS IS THE MUTATOR, and 5dd05b9 put it on a CALLER. I guarded
  // dragCrossfade — the on-screen fader, the one you can see — and wrote "guarded HERE, at the
  // mutator" in the commit. dragCrossfade is a caller of this. The AutoMixer reaches this function
  // directly through autoDeps (seven sites in autoMixer.ts), so a stage DJ with auto-mix running was
  // still the exact divergence that commit exists to stop: the local engine crossfades, the intent
  // goes out, and the server drops it because a crossfade carries no deck and canDriveIntent then
  // demands both. Same seat, same predicate, a different door — Metron found it, and my own comment
  // below names the bypass ("applyCrossfade stays pure so the AutoMixer, which also calls it…").
  //
  // A refusal here makes an auto-mix transition VISIBLY incomplete for a seat that may not move the
  // board, which is worse than nothing and better than silent divergence — the failure mode is now
  // audible instead of invisible. Whether a stage DJ should be able to ARM auto-mix at all is a
  // product question, recorded rather than decided here.
  const applyCrossfade = useCallback(
    (x: number) => {
      if (boardLockedRef.current) return;
      const v = x < -1 ? -1 : x > 1 ? 1 : x;
      setCrossfade(v);
      // ★ THE REF NOW, NOT AT THE NEXT RENDER. AUTO reads the fader back through crossfadeRef to tell
      // its own moves from a hand on the fader. The ref used to catch up only when React re-rendered;
      // the old 150 ms tick usually came after a render, but the 16 ms loop around a cut does not —
      // it read the stale position, saw a 2.0 jump it had just made itself, and handed the
      // transition to "manual" (seen in a real AUTO run: a spin-out that never settled).
      crossfadeRef.current = v;
      engine.setCrossfade(v);
      // Not the smart fader's own move (AUTO, mostly): its next throw re-reads the decks.
      smartFader.noteExternalCrossfade();
      if (room.controlling) room.sendIntent({ kind: "crossfade", value: v });
    },
    [engine, room, smartFader],
  );
  // The ON-SCREEN crossfader drag: when Smart Fader is armed it scrubs the auto-transition
  // (same as the hardware fader); otherwise it's a plain crossfade. (applyCrossfade stays pure so
  // the AutoMixer, which also calls it, is never routed through Smart Fader.)
  const dragCrossfade = useCallback(
    (x: number) => {
      // ★ WATCH-ONLY: THE CROSSFADER IS A WHOLE-BOARD MOVE. Guarded HERE, at the mutator, because
      // until now its only guard was `.xfader-bar.locked { pointer-events: none }` plus the stage
      // shield — and setup.css claimed "Control is gated in the handlers too", which was not true of
      // this path. Same shape as the drop handlers that were only ever covered by the shield: a
      // control that works because something sits over it is not guarded. It also matters more than
      // most, because a listener who moves this hears a different mix from the host's — the operator's
      // rule is that performers and listeners stay synced.
      if (boardLockedRef.current) return; // NOT lockedRef: a stage DJ is `controlling` and must still be refused the board
      if (smartFader.isArmed) {
        const v = x < -1 ? -1 : x > 1 ? 1 : x;
        smartFader.onCrossfade(v);
        setCrossfade(v);
        if (!smartFader.isArmed) setSmartFaderArmed(false);
        if (room.controlling) room.sendIntent({ kind: "crossfade", value: v });
        refresh();
        return;
      }
      applyCrossfade(x);
    },
    [smartFader, applyCrossfade, room, refresh],
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
  const autoDeps = useRef({ autoLoad, applyCrossfade, deckTrack, settings, warmStems });
  autoDeps.current.autoLoad = autoLoad;
  autoDeps.current.applyCrossfade = applyCrossfade;
  autoDeps.current.deckTrack = deckTrack;
  autoDeps.current.settings = settings; // read per-transition — a taste change lands on the next mix
  autoDeps.current.warmStems = warmStems;
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
      stemsPending: (id) => isStemWork(statusRef.current[id]),
      performance: () => autoDeps.current.settings.autoPerformance,
      autoFx: () => autoDeps.current.settings.autoFx,
      // Pre-separate the track AFTER next, so its stems are on disk before the deck ever asks.
      // Fire-and-forget: a rejected/failed warm is not the mixer's problem (the deck load retries
      // for real), so the promise is deliberately dropped rather than awaited or surfaced.
      warmStems: (vid) => void autoDeps.current.warmStems(vid),
      // Sticky: the AUTO chain is offered ONCE. Deleting it is how the tail is turned off, and a
      // mixer that keeps putting it back would be arguing with the user.
      onAutoFxSeeded: () => setSettings((cur) => ({ ...cur, autoFx: { ...cur.autoFx, seeded: true } })),
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
  // ★ AUTO-MIX IS HOST ONLY — operator ruling 2026-09-23, thread cb9000d2, decision 34075fae.
  //
  // Auto-mix is a WHOLE-BOARD activity by construction: it drives both decks AND the crossfader.
  // A seat that cannot move the board could never complete a transition, so the honest moment to
  // say so is when the person asks, not halfway through one. The operator went further than
  // "refuse a stage DJ" — any seat not on the session-owner's account is refused, which is a
  // product call about whose rig this is and is not derivable from the audio graph.
  //
  // `room.controlling` was the wrong gate and had already failed once. A stepped-up listener holds
  // controlling=true with ONE deck, so it sent the intent — and the server dropped it, because the
  // automix intent carries no `deck` and canDriveIntent then demands BOTH. The control appeared to
  // work and nothing happened, which is the silent-divergence shape one level up from the one
  // 2e77ffb fixed in the crossfade mutator.
  const autoControl = useCallback(
    (action: "toggle" | "skip" | "mixnow" | "hold") => {
      if (!canArmAutoMix(room)) return; // not this person's rig — refuse at the control
      if (autoIsRemote) {
        room.sendIntent({ kind: "automix", action }); // a host's OWN second device, driving its rig
        return;
      }
      autoMixerControlRef.current(action);
    },
    [autoIsRemote, room.enabled, room.host, room.sendIntent],
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
    mixQueue.setCurrent(live);
    // AUTO IS OFF, but the Queue tab is still showing suggestions, so the radio still runs — seeded
    // from whatever the user has on the decks. There is no vibe anchor here: off-AUTO, every track
    // change IS the user's own choice, so the live deck is both the anchor and the current track,
    // and `anchorAge` is permanently 0.
    if (live) void mixQueue.ensureNext({ anchor: live, current: live, anchorAge: 0, played: 0, arc: mixQueue.arc });
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
      // Pass the ROSTER signature, not a bare `true`: the force re-send exists for a newly joined
      // guest, so it should fire once per roster change however often this effect runs.
      sendHostLyrics("A", joinedSig);
      sendHostLyrics("B", joinedSig);
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
      // Stamp the loaded videoId every tick (cheap) so a follower can detect a diverged deck and
      // refuse to drive the wrong track — the "shared board, wrong song" guard. See decideTickResync.
      const tick: DeckTick = { pos: deck.position(), playing: deck.playing, rate: deck.effectiveRate, vid: latest.current.loaded[id] };
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
    engine.setMasterMuted(silent); // multiplies the DJ's own master fader — never clobbers it
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
          ["stems", dk.hasStems ? (dk.stemsNeural ? "neural (4-lane)" : "non-neural") : "none"],
          ["stretch attached", String(dk.stretchAttached)],
          ["worklet heartbeat", h ? `ld${h.loaded} pl${h.playing} fifo${h.fifo} pk${Number(h.peak ?? 0).toFixed(2)} g${Number(h.gain ?? 0).toFixed(2)} end${h.ended}` : "none"],
        ],
      };
    };
    const role = room.isAnchor ? "anchor" : room.controlling ? "controller" : room.listening ? "listener" : room.joined ? "watcher" : "—";
    const sd = e.syncDiag;
    const chase = sd.fold != null && Math.abs(Math.log2(sd.fold)) > 0.5; // fold >1.41× or <0.71× → density chase
    // Audio-thread health — the CarPlay/Bluetooth chop instrument. Compute an underruns/sec RATE
    // across polls so a real dropout stream reads as a rate ("⚠ STARVING"), not a static total.
    const ah = e.audioHealth();
    const nowMs = performance.now();
    if (_uhRate.atMs > 0) {
      const dt = (nowMs - _uhRate.atMs) / 1000;
      if (dt > 0.05) _uhRate.perSec = Math.max(0, (ah.underruns - _uhRate.underruns) / dt);
    }
    _uhRate.underruns = ah.underruns;
    _uhRate.atMs = nowMs;
    const starving = _uhRate.perSec > 1;
    return [
      {
        // ⚠ STARVING = the worklet FIFO ran dry (our problem — CPU / pre-roll). Flat while it mutes
        // = the app's audio is clean and the drop is downstream (the route). reserve shows the guard.
        title: "Audio health (chop / skip)",
        rows: [
          ["underruns", `${ah.underruns}  (${_uhRate.perSec.toFixed(1)}/s)${starving ? "  ⚠ STARVING — FIFO dry" : ah.playing ? "  ok" : ""}`],
          ["pre-roll reserve", `${ah.reserveMs} ms  ·  sep ${ah.sepMs} / wl ${ah.wirelessMs} / adaptive ${ah.adaptiveMs}`],
          ["output latency", `${ah.outputLatencyMs} ms${ah.outputLatencyMs === 0 ? "  (iOS reads 0 on CarPlay/BT)" : ""}`],
          ["sample rate / state", `${ah.sampleRate} Hz · ${ah.state}${ah.playing ? " · playing" : ""}`],
        ],
      },
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
        // SYNC phase-lock telemetry — the instrument for the rhythm-engine upgrade. Watch `fold`
        // (~2 = the half/double DENSITY chase) and `trim` (SATURATED = rubato the loop can't follow).
        title: "Sync (phase-lock)",
        rows: sd.active
          ? [
              ["slave → master", `${sd.slave} → ${sd.slave === "A" ? "B" : "A"}`],
              ["bpm slave / master", `${fmt(sd.slaveBpm, 1)} / ${fmt(sd.masterBpm, 1)}`],
              ["fold factor", `${fmt(sd.fold, 3)}${chase ? "  ⚠ DENSITY CHASE" : ""}`],
              ["phase err", `${fmt(sd.errBeats, 3)} beats`],
              ["rubato feed-fwd", `${((sd.feedFwd ?? 0) * 100).toFixed(2)}%`],
              ["trim", `${((sd.trim ?? 0) * 100).toFixed(2)}%${sd.saturated ? "  ⚠ SATURATED (rubato)" : ""}`],
            ]
          : [["state", sd.slave ? "engaged · idle (a deck not playing)" : "off"]],
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
      // ★ LYRICS — "are they firing, and if they are, why don't they line up?". The decode measures
      // its own word times against the REAL vocal onsets in the isolated stem, and the verdict names
      // which of the four failures it is (segment fallback / constant offset / drift / model scatter)
      // and whose fault it is. Per deck, because the two can be on different tracks and engines.
      ...(["A", "B"] as DeckId[]).map((id): DebugSection => {
        const vid = loaded[id];
        const dg = vid ? getLyricsDiag(vid) : null;
        const cues = captions[id] ?? [];
        const hasWords = cues.some((l) => l.words?.length);
        return {
          title: `Lyrics ${id}`,
          rows: dg
            ? formatLyricsDiag(dg)
            : [
                // No decode on this device — say what IS showing and where it came from, so
                // "nothing is happening" and "it came from the pool" are never confused.
                ["state", lyricStatus[id] ? `⟳ ${lyricStatus[id]}` : cues.length ? "idle (lyrics loaded)" : "idle (no lyrics)"],
                ["engine", lyricsModelRef.current === "youtube" ? "YouTube captions" : "LRCLIB"],
                ["source", captionSource[id] ?? "—"],
                ["lines / word-timed", `${cues.length} / ${hasWords ? "yes" : "no"}`],
                ["stems", settings.stemModel === "off" ? "OFF — no vocal stem to time words against" : settings.stemModel],
                ["measured", "no local decode — from cache or the pool"],
              ],
        };
      }),
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
    <div className="app">
      {/* Top chin: panel launchers, reserving their own row at the top so they never
          overlap the board. No more ⇄ swap button — each floating dock (Library/
          Settings/Profile/Session) picks its own edge independently now instead of one
          global left↔right flip; Library's is in Settings ▸ Controls ▸ Library placement. */}
      <nav className="chin" ref={setChinEl}>
        <button className={`chin-btn chin-library ${libOpen ? "active" : ""}`} onClick={toggleLib} aria-label="Library">
          <span className="chin-label">Library</span>
        </button>
        {/* ★ AUTO LIVES ON THE MAIN SCREEN (operator, 2026-11-04: "move the button outside the
            library section into the main screen next to the library open/close button"). It
            changes what the DECKS do, so it cannot hide inside a panel you have to open first; the
            chip says what it is doing (the same words as the Queue's status, automixStatus.ts). */}
        {(() => {
          const st = autoIsRemote && remoteAutomix ? remoteAutomix.status : autoStatus;
          const nx = (autoIsRemote && remoteAutomix ? remoteAutomix.upcoming : mixQueue.upcoming)[0];
          const l = autoLine(st, nx ? displayTrack(nx.title, nx.artist).title || nx.videoId : null);
          const canAuto = canArmAutoMix(room);
          return (
            <button
              className={`chin-btn chin-auto ${st.enabled ? "on" : ""}`}
              onClick={toggleAuto}
              aria-pressed={st.enabled}
              disabled={!canAuto}
              aria-label={st.enabled ? `AUTO on — ${l.headline}` : "AUTO off"}
              title={canAuto ? l.headline : "Auto-mix runs on the host's rig — it drives both decks and the crossfader, which this seat cannot move."}
            >
              <span className="chin-auto-word">AUTO</span>
              {l.chip && <span className={`automix-count tone-${l.tone}`}>{l.chip}</span>}
            </button>
          );
        })()}
        <button
          className={`chin-btn chin-settings ${settingsOpen ? "active" : ""}`}
          onClick={toggleSettings}
          aria-label="Settings"
        >
          <span className="chin-gear" aria-hidden="true">⚙</span>
          <span className="chin-label">Settings</span>
        </button>
        {/* ONE PEOPLE BUTTON. It replaced 🌐 Profile, 🧭 Discover and the 🔔 bell — three chin
            slots for one subject, two of which polled the same live-rooms query and one of
            which ended in a link to another. A PERSON glyph, because that is the subject; a
            globe said "the internet" and a compass said "navigation", neither of which is what
            is behind it. The badge is unread activity; the dot is friends online — two different
            facts, so two different marks rather than one number that means either. */}
        <button
          className={`chin-btn chin-people ${profileOpen ? "active" : ""}`}
          onClick={toggleProfile}
          aria-label={
            notifications.unread > 0
              ? `People, ${notifications.unread} new`
              : friendsOnline.length > 0
                ? `People — ${friendsOnline.length} friends online`
                : "People"
          }
        >
          <span className="chin-people-i" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c0-4.418 3.582-8 8-8s8 3.582 8 8v1H4v-1z" />
            </svg>
          </span>
          {notifications.unread > 0 && (
            <span className="notif-badge">{notifications.unread > 9 ? "9+" : notifications.unread}</span>
          )}
          {notifications.unread === 0 && friendsOnline.length > 0 && (
            <span className="chin-presence-dot" aria-hidden="true" />
          )}
        </button>
        <RoomBar room={room} onExpand={toggleSocial} />
      </nav>
      {/* The chin's "?" button is GONE. It opened a modal whose entire content was the same
          <KeyMap> that Settings ▸ Controls already renders — the identical editable map, from
          the identical `settings.keyBindings`, reachable one click away. A second door to one
          room is not a feature; it is a second thing to keep current, and the one that gets
          forgotten is always the one nobody owns. Keys live in Controls. */}

      {/* Workspace: on desktop a flex ROW so the Library/Search docks SHARE the
          width with the board (push it, don't overlay). On mobile a column with the
          docks as centered modals. */}
      <div className="workspace">
      <main className="stage">
        <div className="lanes-flank">
        {/* The "gestalt of the song" rail — rekordbox's overview strip, rotated vertical, one
            per deck, spanning the FULL height of the stacked pair (not just its own deck's
            waveform box) so the two bookend the whole board like a mixer's tall meter columns.
            Deck A's on the left, Deck B's on the right — each still shows only its OWN track;
            the shared full-board height is purely a bolder canvas for it, not a data merge. */}
        <SongOverview
          deck={engine.deckA}
          pyramid={meta.A.pyramid}
          accent={ACCENT.A}
          background={surfaceColor(settings.bgColor, settings.uiContrast)}
          selectorColor={settings.selectorColor}
          markerColor={settings.markerColor}
          loopColor={settings.loopColor}
          freqColors={settings.freqColors}
          freqLow={settings.freqLowColor || FREQ_LOW_DEFAULT}
          freqMid={settings.freqMidColor || FREQ_MID_DEFAULT}
          freqHigh={settings.freqHighColor || FREQ_HIGH_DEFAULT}
          vividness={settings.freqVividness}
          bandLayers={settings.bandLayers}
          bandFromDeck={settings.bandFromDeck}
          side="left"
          windowSec={zoom.A}
          locked={deckLocked("A")}
          onSeek={(pos) => emitSeekTo("A", pos)}
          refresh={refresh}
          onLoadFile={(f) => onLoadFile("A", f)}
          onLoadTrack={(track) => loadAndShare("A", track)}
          onFocus={() => setFocused("A")}
        />
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
              bandLayers={settings.bandLayers}
              bandFromDeck={settings.bandFromDeck}
              stemsFollowDeck={settings.stemsFollowDeck}
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
              // DeckLane already called censorBegin/End by the time this fires, so
              // deck.reversing reflects the NEW state — mirrors the keyboard censor
              // handler's own board-event shape. releaseBrake has no session-sync from
              // the keyboard either (spinback doesn't get one currently), so the touch
              // gesture matches that as-is rather than inventing new sync for just one path.
              onCensorToggle={() => emitRef.current({ kind: "board", deck: id, id: "censor", phase: engine.deck(id).reversing ? "down" : "up" })}
              onReprocessLyrics={(eng) => reprocessLyrics(id, eng)}
            />
          ))}
        </div>
        <SongOverview
          deck={engine.deckB}
          pyramid={meta.B.pyramid}
          accent={ACCENT.B}
          background={surfaceColor(settings.bgColor, settings.uiContrast)}
          selectorColor={settings.selectorColor}
          markerColor={settings.markerColor}
          loopColor={settings.loopColor}
          freqColors={settings.freqColors}
          freqLow={settings.freqLowColor || FREQ_LOW_DEFAULT}
          freqMid={settings.freqMidColor || FREQ_MID_DEFAULT}
          freqHigh={settings.freqHighColor || FREQ_HIGH_DEFAULT}
          vividness={settings.freqVividness}
          bandLayers={settings.bandLayers}
          bandFromDeck={settings.bandFromDeck}
          side="right"
          windowSec={zoom.B}
          locked={deckLocked("B")}
          onSeek={(pos) => emitSeekTo("B", pos)}
          refresh={refresh}
          onLoadFile={(f) => onLoadFile("B", f)}
          onLoadTrack={(track) => loadAndShare("B", track)}
          onFocus={() => setFocused("B")}
        />
        </div>

        {/* Middle third: the A↔B crossfader across the top, then the two decks'
            button banks side by side beneath it. */}
        <div className="decks-third">
        {/* Locked out (joined but not driving): the controls stay fully visible, we just swallow
            pointer input over THEM. It used to cover the whole stage, which also swallowed the
            two gestures that only LOOK: switching which deck is on screen, and zoom/expand. On a
            phone the unfocused deck is display:none, so a listener was pinned to deck A with no
            way to watch the host work the other one. Ruling 7ba93a22 separates the listener's
            stream from the driver's by design — see everything, drive nothing — and looking is
            the "see" half. The lanes police themselves: every driving gesture in DeckLane
            early-returns on `locked`. */}
        {room.enabled && !room.controlling && (
          <div className="stage-lock" aria-hidden="true" />
        )}
          <BoardBar
            master={{
              value: masterVol,
              canControl: !boardLocked,
              onChange: (v: number) => { engine.setMasterVolume(v); setMasterVolSt(v); },
            }}
            sampler={sampler}
            ctlRef={samplerCtl}
            micSetRef={micVolSetRef}
            micToggleRef={micToggleRef}
            hasMic={engine.canMic && settings.audioInputId !== MIC_NONE}
            // ★ THE MIC CHAIN APPEARS ON DEMAND, exactly as AUTO's does (operator, 0708130a): the
            // first time the mic is pointed INTO a deck's rack, that deck is offered a MIC chain.
            // "master" is the PA talkover and touches no rack, so it seeds nothing. Sticky, so
            // deleting the chain declines the offer for good. The policy lives here because
            // `micFxSeeded` is settings; the seeding itself is seedMicChain, beside the rack.
            onMicRoute={(dest) => {
              if (dest === "master") return;
              if (!seedMicChain(engine.deck(dest), settings.micFxSeeded)) return;
              setSettings((cur) => ({ ...cur, micFxSeeded: true }));
              refresh(); // the strip reads the rack directly — nothing else tells it a chain arrived
            }}
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
            xfader={{
              deckA: engine.deckA,
              deckB: engine.deckB,
              accentA: ACCENT.A,
              accentB: ACCENT.B,
              crossfade,
              onCrossfade: dragCrossfade,
              // ONLY the session lock. The DJ's own disable is `enabled`, which dims the bar but
              // leaves it live — because the right-click that turns it back on is on the bar.
              locked: boardLocked,
              smart: smartFaderArmed,
              enabled: xfaderEnabled,
              canControl: !boardLocked,
              onToggleSmart: () => handlersRef.current.smartFaderToggle?.(engine.deckA, "A", false),
              onToggleEnabled: () => handlersRef.current.xfaderToggle?.(engine.deckA, "A", false),
            }}
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
            stemPending={isStemWork(status.A)}
            stemPendingPct={status.A?.pct ?? null}
            otherStemPending={isStemWork(status.B)}
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
            emitControls={emitDeckControls}
            sampler={sampler}
            onFxSelect={(d, i) => { fxSelRef.current[d] = i; }}
            fxCtlRef={fxCtlA}
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
            stemPending={isStemWork(status.B)}
            stemPendingPct={status.B?.pct ?? null}
            otherStemPending={isStemWork(status.A)}
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
            emitControls={emitDeckControls}
            sampler={sampler}
            onFxSelect={(d, i) => { fxSelRef.current[d] = i; }}
            fxCtlRef={fxCtlB}
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
        dockMode={placements.library}
        panelOrder={settings.panelOrder}
        auto={{
          status: autoIsRemote && remoteAutomix ? remoteAutomix.status : autoStatus,
          queue: mixQueue,
          queueCount: autoIsRemote && remoteAutomix ? remoteAutomix.upcoming.length : mixQueue.upcoming.length,
          queueOpen: mixqOpen,
          mirror: autoIsRemote ? remoteAutomix : null,
          edit: queueEdit,
          canEdit: queueCanEdit,
          canAuto: canArmAutoMix(room), // host only — cb9000d2, decision 34075fae
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
          dockMode={placements.settings}
          onePanel={onePanel}
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
          loadedVideoIds={Array.from(loadedIds)}
          loadedDecks={(["A", "B"] as DeckId[])
            .filter((id) => loaded[id])
            .map((id) => {
              const dk = engine.deck(id);
              const k = stemLoadedKey.current[id] ?? "";
              return { id, neural: dk.stemsNeural, hasStems: dk.hasStems, model: k.includes(":") ? k.slice(k.lastIndexOf(":") + 1) : null };
            })}
          stemStatus={status}
          onReanalyze={reanalyze}
          // What each deck's lyrics ARE right now — the readout that did not exist, which is why
          // "I can't tell when or if they are firing" was an unanswerable question.
          lyricDecks={(["A", "B"] as DeckId[])
            .filter((id) => loaded[id])
            .map((id) => ({
              id,
              source: captionSource[id] ?? null,
              lines: captions[id]?.length ?? 0,
              status: lyricStatus[id] ?? null,
            }))}
          onRetranscribe={(deck) => reprocessLyrics(deck)}
          onGpuReenable={() => {
            setCrashAsks((asks) => asks.filter((p) => p.id !== "gpu")); // answered in Settings instead
            refresh();
          }}
          outputSupported={engine.canSetSink}
          debug={collectDebug}
          midi={midi}
        />
      )}
      {socialOpen && (
        <SocialScreen
          room={room}
          onClose={() => setSocialOpen(false)}
          onActivate={() => engine.unlock()}
          onQueueRequest={queueRequest}
          dockMode={placements.session}
          panelOrder={settings.panelOrder}
        />
      )}
      {profileOpen && (
        <PeopleScreen
          view={peopleView}
          setView={patchPeopleView}
          onClose={() => setProfileOpen(false)}
          dockMode={placements.people}
          panelOrder={settings.panelOrder}
          self={room.user?.handle ?? null}
          tunedTo={room.listeningTo}
          friends={friendsOnline}
          notifications={notifications}
          onListen={(h) => {
            engine.unlock(); // tune-in is a user gesture → prime iOS audio
            room.tuneIn(h);
            setProfileOpen(false); // hand off to the Session dock's "Listening to @X" banner
          }}
          onJam={(h) => {
            engine.unlock(); // jamming is a user gesture → prime iOS audio
            room.jam(h);
            setProfileOpen(false);
          }}
          onPlaySet={playRecordedSet}
          onTrimSet={editTrim}
          live={room.roomPublic}
          listeners={room.listenerCount}
          onGoToSession={toggleSocial}
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
          onJam={(h) => {
            engine.unlock(); // jam is a user gesture → prime iOS audio
            room.jam(h);
            closePublic();
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

      <CrashGuardPrompt prompts={crashAsks} onAnswer={answerCrash} />
      <PerfRecChip />
    </div>
  );
}
