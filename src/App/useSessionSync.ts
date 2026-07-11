// useSessionSync — the inbound session-sync engine: applies a host's snapshot / control intents /
// playhead ticks to THIS device's local engine (the follower side of a shared room). Lifted out of
// App.tsx so a session agent owns this file instead of contending on App. PURE RELOCATION: the
// function bodies below are sed-verbatim from App; the spine (engine/refresh) is pulled via
// useSpine, everything else arrives via `deps` destructured to the original names so the closures +
// their useCallback dep arrays are byte-identical. The 4 auto-mix bridge refs are declared in App
// (assigned by the far-below mixer) and passed in. The type-only `../App` import is erased at build
// (no runtime cycle). See htl-refactor-monoliths.
import { useCallback, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { applyBoardAction } from "@htl/board/boardActions";
import { isMobileDevice, type Deck, type TrackMeta, type DeckSnapshot, type SessionSnapshot, type MixQueue } from "@htl";
import type { DeckId } from "@htl/audio";
import type { Intent, TickDecks } from "@htl/room";
import { decideFollowTick, decideSnapshotDeck, decideStemConverge, decideTickResync, shouldStartOnDecode } from "@htl/room/sessionFollow";
import type { Settings } from "@htl/state";
import { STEM_KEYS } from "./useStemPipeline";
import { useSpine } from "./spine";
import type { StemStatus } from "../App";

export interface SessionSyncDeps {
  setStatusFor: (id: DeckId, st: StemStatus | null) => void;
  loadTrackToDeck: (id: DeckId, track: TrackMeta, restore?: DeckSnapshot) => Promise<unknown>;
  loaded: Record<DeckId, string | null>;
  setCrossfade: Dispatch<SetStateAction<number>>;
  setSettings: Dispatch<SetStateAction<Settings>>;
  applyDeckStems: (deck: Deck, s: DeckSnapshot) => void;
  // Read-narrowed view of App's `latest` ref (covariant `current` → only `.loaded` is touched here).
  latest: { readonly current: { loaded: Record<DeckId, string | null> } };
  stemViewWaitTimers: MutableRefObject<Partial<Record<DeckId, ReturnType<typeof setTimeout>>>>;
  roomLoadTarget: MutableRefObject<Record<DeckId, string | null>>;
  reconciledTarget: MutableRefObject<Record<DeckId, string | null>>;
  deferDecodeRef: MutableRefObject<boolean>;
  pendingRoomLoad: MutableRefObject<Record<DeckId, { videoId: string; track: TrackMeta; restore?: DeckSnapshot } | null>>;
  loadingVid: MutableRefObject<Record<DeckId, string>>;
  homeAdoptAt: MutableRefObject<number>;
  lastSnapshotRef: MutableRefObject<SessionSnapshot | null>;
  lastTickAt: MutableRefObject<Record<DeckId, number>>;
  followSeekAt: MutableRefObject<Record<DeckId, number>>;
  resyncAt: MutableRefObject<Record<DeckId, number>>; // last divergence-reload attempt per deck (tick guard)
  scrubbing: MutableRefObject<Record<DeckId, boolean>>;
  stemTouch: MutableRefObject<Record<DeckId, Record<string, number>>>;
  snapFollowRef: MutableRefObject<boolean>;
  followRef: MutableRefObject<boolean>;
  ensureGuestStemsRef: MutableRefObject<(id: DeckId) => void>;
  stemReqRef: MutableRefObject<(id: DeckId, model: string) => void>;
  autoMixerControlRef: MutableRefObject<(action: "toggle" | "skip" | "mixnow" | "hold") => void>;
  mixQueueRef: MutableRefObject<MixQueue | null>;
  autoIsRemoteRef: MutableRefObject<boolean>;
  samplerApplyRef: MutableRefObject<((intent: Extract<Intent, { kind: "sample" }>) => void) | null>;
}

export interface SessionSync {
  runRoomLoad: (id: DeckId, videoId: string, track: TrackMeta, restore?: DeckSnapshot) => void;
  applyRoomSnapshot: (snapshot: unknown) => void;
  onRoomIntent: (intent: Intent) => void;
  onRoomTick: (decks: TickDecks) => void;
}

export function useSessionSync(deps: SessionSyncDeps): SessionSync {
  const { engine, refresh, roomRef } = useSpine();
  const {
    setStatusFor,
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
    scrubbing,
    stemTouch,
    snapFollowRef,
    followRef,
    ensureGuestStemsRef,
    stemReqRef,
    autoMixerControlRef,
    mixQueueRef,
    autoIsRemoteRef,
    samplerApplyRef,
  } = deps;

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
      if (d.eqMix != null) deck.setEqMix(d.eqMix);
      if (d.eqOut != null) deck.setEqOut(d.eqOut);
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
        // Load-once / reconcile-once / skip — the pure dedupe decision (see sessionFollow).
        const action = decideSnapshotDeck({
          snapVideoId: d.videoId,
          loadedId: latest.current.loaded[id],
          roomLoadTarget: roomLoadTarget.current[id],
          loadingVid: loadingVid.current[id],
          reconciledTarget: reconciledTarget.current[id],
        });
        if (action === "load" && d.videoId) {
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
        } else if (action === "reconcile") {
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
        if (shouldStartOnDecode({ snapPlaying: d.playing, deckPlaying: deck.playing, sinceLastTickMs: performance.now() - (lastTickAt.current[id] ?? 0) })) {
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
          else if (intent.param === "eqMix") deck.setEqMix(intent.value);
          else if (intent.param === "eqOut") deck.setEqOut(intent.value);
          else if (intent.param === "filter") deck.setFilter(intent.value);
          else if (intent.param === "pitch") deck.setPitch(Math.round(intent.value));
          break;
        case "toggle":
          if (intent.param === "keylock") deck.setKeylock(intent.value);
          else if (intent.param === "eqBypass") deck.setEqBypass(intent.value);
          else if (intent.param === "quantize") deck.setQuantize(intent.value);
          // (legacy "fx" filter-master toggle removed — ignored if an old peer sends it)
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
        // Track-identity guard (the "shared board, wrong song" fix): the anchor stamps each tick
        // with the videoId it holds on this deck. If ours differs, a load was lost/failed on a
        // flaky link — DON'T drive the wrong buffer; freeze it and self-heal by reloading the
        // anchor's track (throttled; force-load defeats a stuck load-guard). Also pulls a fresh
        // snapshot so the new track's cue/loop/fx land. See sessionFollow.decideTickResync.
        const vid = t.vid;
        const loadingThis = vid != null && (roomLoadTarget.current[id] === vid || loadingVid.current[id] === vid);
        const resync = decideTickResync({ tickVid: vid, loadedId: latest.current.loaded[id], loadingThisVid: loadingThis, sinceResyncMs: now - (resyncAt.current[id] ?? 0) });
        if (resync !== "drive") {
          if (resync === "load" || resync === "force-load") {
            resyncAt.current[id] = now;
            if (resync === "force-load") {
              roomLoadTarget.current[id] = null; // defeat a stuck dedupe guard
              loadingVid.current[id] = "";
            }
            runRoomLoad(id, vid!, { videoId: vid!, title: "", artist: "", duration: 0, thumbnail: null, views: null, bpm: null });
            roomRef.current?.requestState(); // pull the authoritative snapshot for the new track's discrete state
          }
          return; // diverged → never drive this deck
        }
        if (!deck.buffer || scrubbing.current[id]) return; // don't fight a local scrub
        // The drift-correction decision (see sessionFollow) → perform the named side effect.
        // A tick is a STALE snapshot of a moving clock and REAL rewinds arrive as seek INTENTS,
        // so a steady-playing follower is only ever pulled FORWARD (a lead is just latency, or a
        // momentarily-frozen suspended-mobile master clock; seeking BACK to it then replaying it
        // every grace window was the "loops a ~second forever, never catches up" bug).
        const action = decideFollowTick({
          masterPlaying: t.playing,
          deckPlaying: deck.playing,
          deckPos: deck.position(),
          masterPos: t.pos,
          sinceFollowSeekMs: now - followSeekAt.current[id],
        });
        if (action.kind === "start") {
          engine.resume(); // iOS starts suspended
          if (action.seek) deck.seek(t.pos); // catch up cleanly BEFORE the source starts
          deck.play();
          followSeekAt.current[id] = now;
          flipped = true;
        } else if (action.kind === "stop") {
          deck.pause();
          if (action.seek) deck.seek(t.pos); // land on the master's paused position
          followSeekAt.current[id] = now;
          flipped = true;
        } else if (action.kind === "catchup") {
          deck.seek(t.pos); // genuinely behind past the grace window → pull forward, reset grace
          followSeekAt.current[id] = now;
        } else if (action.kind === "align") {
          deck.seek(t.pos); // both paused → tight align is silent, no skip
        }
        // Reliable stem-state convergence: apply the anchor's authoritative per-stem mute/
        // gain when present, but SKIP a stem we ourselves touched in the last 400 ms so our
        // own in-flight change isn't briefly stomped by a slightly-stale echo. Idempotent —
        // only repaint when a value actually moved.
        if (t.stems) {
          const touched = stemTouch.current[id];
          STEM_KEYS.forEach((n, i) => {
            const g = t.stems!.g[i];
            const muted = !!t.stems!.m[i];
            // Idempotent per-stem convergence with the 400 ms self-touch grace (see sessionFollow).
            const dec = decideStemConverge({
              sinceTouchMs: now - (touched[n] ?? 0),
              masterGain: g,
              masterMuted: muted,
              localLevel: deck.stemLevel(n),
              localActive: deck.stemActive(n),
            });
            if (dec.setGain) {
              deck.setStemGain(n, g!);
              flipped = true;
            }
            if (dec.setMute) {
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
    [engine, refresh, runRoomLoad],
  );

  return { runRoomLoad, applyRoomSnapshot, onRoomIntent, onRoomTick };
}
