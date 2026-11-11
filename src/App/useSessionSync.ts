import type { StemAckState } from "../htl/room/protocol";
// useSessionSync — the inbound session-sync engine: applies a host's snapshot / control intents /
// playhead ticks to THIS device's local engine (the follower side of a shared room). Lifted out of
// App.tsx so a session agent owns this file instead of contending on App. PURE RELOCATION: the
// function bodies below are sed-verbatim from App; the spine (engine/refresh) is pulled via
// useSpine, everything else arrives via `deps` destructured to the original names so the closures +
// their useCallback dep arrays are byte-identical. The 4 auto-mix bridge refs are declared in App
// (assigned by the far-below mixer) and passed in. The type-only `../App` import is erased at build
// (no runtime cycle). See htl-refactor-monoliths.
import { useCallback, useEffect, useRef } from "react";
import { padSlots } from "./deckApply";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { applyBoardAction } from "@htl/board/boardActions";
import { isMobileDevice, type Deck, type TrackMeta, type DeckSnapshot, type SessionSnapshot, type MixQueue } from "@htl";
import type { DeckId } from "@htl/audio";
import type { Intent, TickDecks } from "@htl/room";
import { TIMED_ERR_ALPHA, decideFollowTick, decideTimedFollow, decideSnapshotDeck, decideStemConverge, decideTickResync, holdsForeignTrack, isAudibleDeckIntent, shouldStartOnDecode } from "@htl/room/sessionFollow";
import { applyIntent as applyIntentTo, type IntentEngine } from "@htl/room/applyIntent";
import type { Settings } from "@htl/state";
import { applyDeckFxSnapshot } from "./deckFxSnapshot";
import { STEM_KEYS } from "./useStemPipeline";
import { useSpine } from "./spine";
import { event } from "@htl/debug/trace";
import type { StemStatus } from "../App";
import { applyQueueIntent, type QueueTarget } from "../htl/room/queueIntent";

export interface SessionSyncDeps {
  setStatusFor: (id: DeckId, st: StemStatus | null) => void;
  // Fill in a deck's name/artist/bpm/duration from the authoritative snapshot when ours are blank.
  // A deck can arrive on a track with no name at all (the tick-resync loads from a videoId), and
  // reconcile is the only moment that can put it right. See App/deckNameBackfill.ts.
  nameDeckFromSnapshot: (id: DeckId, d: DeckSnapshot) => void;
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
  resyncAt: MutableRefObject<Record<DeckId, number | null>>; // last divergence-reload attempt per deck; null = never
  resyncTries: MutableRefObject<Record<DeckId, number>>; //    consecutive attempts since this deck last landed
  loadingSince: MutableRefObject<Record<DeckId, number>>; //   the in-flight load's last sign of life (claim, chunk, decode, analysis)
  scrubbing: MutableRefObject<Record<DeckId, boolean>>;
  stemTouch: MutableRefObject<Record<DeckId, Record<string, number>>>;
  snapFollowRef: MutableRefObject<boolean>;
  followRef: MutableRefObject<boolean>;
  ensureGuestStemsRef: MutableRefObject<(id: DeckId) => void>;
  stemReqRef: MutableRefObject<(id: DeckId, model: string) => void>;
  /** The host's answer to a reqStems we sent — replaces the requester's fixed timeout with a fact.
   *  OPTIONAL deliberately: the wire half (host emits, receiver routes) lands independently of the
   *  requester-side UI wiring in App.tsx, which is being edited concurrently for the host-only
   *  separation ruling. Without it the ack is received and ignored — no regression, just the old
   *  timeout behaviour until the consumer is wired. Two agents in one file is how FxStrip.tsx lost
   *  its hunks; an optional dep is the cheap way not to need the same file at the same moment. */
  stemAckRef?: MutableRefObject<(id: DeckId, state: StemAckState, reason?: string, pct?: number) => void>;
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
  // Per-deck token for the FX restore deferred until the worklets exist (see reconcileDeckState).
  const fxApplySeq = useRef<Partial<Record<DeckId, number>>>({});
  const reconcileDeckState = useCallback(
    (id: DeckId, d: DeckSnapshot) => {
      const deck = engine.deck(id);
      // ★ THE NAME IS PART OF THE STATE. This function applied every control field the snapshot
      // carries and walked past `name` and `artist` sitting beside them, so a deck that arrived
      // nameless — the tick-resync loads from a bare videoId — stayed nameless for the whole
      // session while its duration, BPM and key were all correct (thread 47468bb9).
      nameDeckFromSnapshot(id, d);
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
      const slots = deck.hotCues.length;
      deck.hotCues = padSlots([...d.hotCues], slots);
      deck.hotLoops = padSlots((d.hotLoops ?? []).map((l) => (l ? { ...l } : null)), slots);
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
      // BOTH halves — the master rack and the stem chains. See App/deckFxSnapshot.ts for why
      // applying only `fx` here left a late-joining listener without the host's stem chains.
      // ★ NOT BEFORE THE FX WORKLETS EXIST. At boot the stored snapshot lands before addModule()
      // has finished, so every reverb/comp in it was built as a pass-through and then rebuilt by the
      // repair — two warnings and a repair line per boot, and effects that were briefly not there.
      // Wait for the modules when they are not in yet; a per-deck token makes sure a NEWER snapshot
      // applied meanwhile is never overwritten by this older, delayed one.
      const tok = (fxApplySeq.current[id] = (fxApplySeq.current[id] ?? 0) + 1);
      if (engine.fxWorkletsReady) applyDeckFxSnapshot(deck, d);
      else
        void engine
          .ensureWorklets()
          .catch(() => {}) // modules failed: apply anyway — the degrade + repair path is the fallback
          .then(() => {
            if (fxApplySeq.current[id] === tok) applyDeckFxSnapshot(engine.deck(id), d);
          });
    },
    [engine, setStatusFor, nameDeckFromSnapshot],
  );

  // Kick off a room-driven load with a SELF-HEALING dedupe guard. roomLoadTarget is set
  // optimistically (so a duplicate snapshot/intent doesn't load the same track twice), but
  // if the load fails / aborts / is superseded WITHOUT landing the track, we clear the guard
  // so the next snapshot or intent can retry — otherwise the deck stays stuck on the old
  // track and the session silently drifts out of sync.
  const runRoomLoad = useCallback(
    (id: DeckId, videoId: string, track: TrackMeta, snapRestore?: DeckSnapshot) => {
      // ★ THE SNAPSHOT'S TRANSPORT IS NOT RESTORED HERE. Its position is as old as the snapshot plus
      // the whole download and decode, and restoring it (applyDeckControls seeks it and plays) made a
      // guest joining mid-song PLAY seconds of the wrong part and then jump when the first tick
      // arrived (measured: started 2.03 s behind, seeked 84 ms later). The deck lands paused at
      // the snapshot's position; the tick follower starts it at the host's live position, and the
      // post-decode fallback below still starts it when nothing is ticking.
      const restore = snapRestore ? { ...snapRestore, playing: false } : undefined;
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
      // ★ WHY THIS IS RECORDED. "A listener does not adopt the host's board" (thread d4a56d30) cost a
      // night of guessing between three explanations — the room never held a board, the room held a
      // stale one, or the client was handed a good one and ignored it. The server now says which
      // side it was (room.ts logs every publish and catch-up with its content); this is the same
      // sentence from the client's end, so the two can be read against each other. Into the ring
      // (Settings ▸ Debug), not the console: a phone listener has no console, and that is exactly
      // the device this bug is reported on.
      if (!snapFollowRef.current) {
        event("room.snapshot", { applied: false, why: "not following" });
        return; // solo, OR a driver holding the live board → ignore catch-up snapshots
      }
      const snap = snapshot as SessionSnapshot | null;
      if (!snap || !snap.decks) {
        event("room.snapshot", { applied: false, why: snap ? "no decks" : "empty" });
        return;
      }
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
        event("room.snapshot", { deck: id, action, snapVid: d.videoId ?? null, loadedVid: latest.current.loaded[id] || null });
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
          event("room.follow", { deck: id, kind: "decode-start", pos: +d.position.toFixed(2) });
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

  // Apply ONE control intent to the local engine — used for both inbound remote intents and our
  // own actions. Pure local effect, no network. The SWITCH lives in src/htl/room/applyIntent.ts
  // so a test can drive it: while it sat inline here, "does this gesture reach the other device
  // intact?" was a question the suite could not ask. This is the wiring, that is the behaviour.
  const applyIntent = useCallback(
    (intent: Intent) => {
      applyIntentTo(intent, engine as unknown as IntentEngine, {
        automix: (action) => autoMixerControlRef.current(action),
        board: (deckId, id, phase, arg) => {
          applyBoardAction(engine.deck(deckId), id, phase, arg);
        },
        // The authority rule and the four actions live in htl/room/queueIntent.ts — pure, so the
        // "a mirroring remote must NOT apply" decision is testable instead of readable.
        queue: (q) => {
          applyQueueIntent(q, mixQueueRef.current as unknown as QueueTarget | null, { mirroring: autoIsRemoteRef.current });
        },
        sample: (s) => samplerApplyRef.current?.(s),
        crossfade: (v) => setCrossfade(v),
        tempoRange: (v) => setSettings((st) => (st.tempoRange === v ? st : { ...st, tempoRange: v })),
        load: (deckId, videoId, name, artist) => {
          // A co-DJ handed us a track → WE load/decode/play it (the master is the real audio
          // source). Minimal meta; loadTrackToDeck fetches + analyses by id. Dedupe vs the
          // snapshot path so we don't load it twice.
          if (videoId !== latest.current.loaded[deckId] && videoId !== roomLoadTarget.current[deckId]) {
            runRoomLoad(deckId, videoId, { videoId, title: name ?? "", artist: artist ?? "", duration: 0, thumbnail: null, views: null, bpm: null });
          }
        },
        // The 250 ms tail lives here, with the ref it guards: tick-follow must stay suppressed
        // just past the end of a remote scrub or the next tick yanks the platter back.
        scrub: (deckId, active) => {
          if (active) scrubbing.current[deckId] = true;
          else setTimeout(() => (scrubbing.current[deckId] = false), 250);
        },
        ensureGuestStems: (deckId) => ensureGuestStemsRef.current(deckId),
        refresh,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, runRoomLoad, refresh],
  );

  // The videoId the anchor last stamped on each deck's tick (null: none yet / an older anchor).
  const tickVid = useRef<Record<DeckId, string | null>>({ A: null, B: null });
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
      // The host's ANSWER to our reqStems. Intercepted like reqStems itself — it is a message about
      // a request's fate, not a control to apply to the board.
      if (intent.kind === "stemsAck") {
        stemAckRef?.current(intent.deck, intent.state, intent.reason, intent.pct);
        return;
      }
      if ("deck" in intent && isAudibleDeckIntent(intent.kind, "action" in intent ? String(intent.action) : undefined)) {
        const d = intent.deck;
        const foreign = holdsForeignTrack({ loadedId: latest.current.loaded[d], tickVid: tickVid.current[d], roomLoadTarget: roomLoadTarget.current[d] });
        event("room.intent", { deck: d, kind: intent.kind, action: "action" in intent ? intent.action : null, applied: !foreign });
        // The host's play/seek/hot-cue on a deck still holding another track would sound THAT track;
        // the tick follower starts the session's track at the live position once it lands.
        if (foreign) return;
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
  const followErr = useRef<Record<DeckId, number | null>>({ A: null, B: null }); // smoothed timed-follow error (s)
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
        tickVid.current[id] = vid ?? null;
        const loadingThis = vid != null && (roomLoadTarget.current[id] === vid || loadingVid.current[id] === vid);
        const lastResync = resyncAt.current[id];
        const resync = decideTickResync({
          tickVid: vid,
          loadedId: latest.current.loaded[id],
          // The age of the load itself, not of the last resync — "is THIS load stuck?" is a question
          // only the load can answer (ruling ab419a94).
          inFlightForMs: loadingThis ? now - (loadingSince.current[id] || now) : null,
          sinceResyncMs: lastResync == null ? null : now - lastResync,
          attempts: resyncTries.current[id],
        });
        if (resync === "drive") resyncTries.current[id] = 0; // landed on the anchor's track → backoff resets
        if (resync !== "drive") {
          if (resync === "load" || resync === "force-load") {
            resyncAt.current[id] = now;
            resyncTries.current[id] += 1;
            if (resync === "force-load") {
              roomLoadTarget.current[id] = null; // defeat a stuck dedupe guard
              loadingVid.current[id] = "";
            }
            // ★ SAY THAT IT WAS THE RESYNC. This branch starts a load without emitting anything,
            // so the ring showed only `room.snapshot` lines and a reader could not tell a deck that
            // was never re-loaded from one whose snapshot load was ABORTED by a resync load here
            // (loadTrackToDeck aborts the previous load on the same deck). That ambiguity let a
            // wrong conclusion look supported twice tonight — once when I read an absence as
            // evidence, and once in Deckard's own reading of the same extract. "Which path started
            // this load" must be read, never inferred.
            event("room.resync", { deck: id, action: resync, vid: vid ?? null, loadedVid: latest.current.loaded[id] || null });
            // ★ AND LOAD IT WITH A NAME IF WE HAVE ONE. A tick carries only a videoId, so this
            // branch used to build a TrackMeta with an empty title and artist — correct audio under
            // a header reading "—" (thread 47468bb9). The last snapshot usually knows the name of
            // the very track the anchor is asking us to hold, so use it; reconcile still backfills
            // (App/deckNameBackfill.ts) for the case where no snapshot has arrived yet.
            const known = lastSnapshotRef.current?.decks[id];
            const named = known?.videoId === vid ? known : null;
            runRoomLoad(id, vid!, {
              videoId: vid!,
              title: named?.name ?? "",
              artist: named?.artist ?? "",
              duration: named?.duration ?? 0,
              thumbnail: null,
              views: null,
              bpm: named?.bpm ?? null,
            });
            roomRef.current?.requestState(); // pull the authoritative snapshot for the new track's discrete state
          }
          // …and never let it SOUND either: a track the session is not playing (see holdsForeignTrack).
          if (deck.playing && holdsForeignTrack({ loadedId: latest.current.loaded[id], tickVid: vid, roomLoadTarget: roomLoadTarget.current[id] })) {
            event("room.follow", { deck: id, kind: "silence-foreign", loadedVid: latest.current.loaded[id] || null, vid: vid ?? null });
            deck.pause();
            flipped = true;
          }
          return; // diverged → never drive this deck
        }
        // ★ "Can this deck play?", not "does it still hold the float32 mix". A phone RELEASES the mix
        // once its stems are in the worklet (releaseMixBuffer), and `!deck.buffer` then switched off
        // every follow tick for the rest of the track: a stemmed guest stopped starting, stopping and
        // catching up with the host the moment its stems landed.
        if (!deck.hasLocalPcm || scrubbing.current[id]) return; // still loading, or don't fight a local scrub
        // The drift-correction decision (see sessionFollow) → perform the named side effect.
        // A tick is a STALE snapshot of a moving clock and REAL rewinds arrive as seek INTENTS,
        // so a steady-playing follower is only ever pulled FORWARD (a lead is just latency, or a
        // momentarily-frozen suspended-mobile master clock; seeking BACK to it then replaying it
        // every grace window was the "loops a ~second forever, never catches up" bug).
        // ★ TIMED FOLLOW: a tick stamped with the room clock (DeckTick.at) and our own clock synced
        // → the host's AUDIBLE position now, our own latency, an error in both directions, glided
        // out with a speed trim or seeked when large. Otherwise (older host, clock not synced yet)
        // the untimed rules below.
        const sNow = roomRef.current?.serverNow() ?? null;
        if (t.at != null && sNow != null) {
          const rate = t.rate && t.rate > 0 ? t.rate : deck.effectiveRate;
          const age = Math.max(0, Math.min(5, (sNow - t.at) / 1000));
          const masterNow = t.playing ? t.pos + age * rate : t.pos;
          const lat = engine.audibleLatency() * rate;
          // The trim acts on the error smoothed over ~1 s (TIMED_ERR_ALPHA): one tick's reading of
          // the audio clock jitters by a render quantum, and a trim chasing that wobbles the pitch.
          const rawErr = deck.position() - (t.playing ? masterNow + lat : masterNow);
          const prevErr = followErr.current[id];
          followErr.current[id] = prevErr == null || !deck.playing ? rawErr : prevErr * (1 - TIMED_ERR_ALPHA) + rawErr * TIMED_ERR_ALPHA;
          const timed = decideTimedFollow({
            masterPlaying: t.playing,
            deckPlaying: deck.playing,
            masterNow,
            deckPos: deck.position(),
            deckLatency: lat,
            sinceFollowSeekMs: now - followSeekAt.current[id],
            smoothErr: followErr.current[id] ?? undefined,
          });
          if (timed.kind !== "trim" && timed.kind !== "hold") {
            followErr.current[id] = null; // a jump: start over
            if (timed.kind !== "seek") event("room.follow", { deck: id, kind: timed.kind, errMs: Math.round((deck.position() - timed.target) * 1000) });
          }
          if (timed.kind === "start") {
            engine.resume(); // iOS starts suspended
            deck.setFollowTrim(0);
            deck.seek(timed.target);
            deck.play();
            followSeekAt.current[id] = now;
            flipped = true;
          } else if (timed.kind === "stop") {
            deck.pause();
            deck.setFollowTrim(0);
            if (Math.abs(deck.position() - timed.target) > 0.05) deck.seek(timed.target);
            followSeekAt.current[id] = now;
            flipped = true;
          } else if (timed.kind === "seek") {
            // The error is read BEFORE the seek: read after it, it was always ~0.
            event("room.follow.seek", { deck: id, errMs: Math.round((deck.position() - timed.target) * 1000), rttMs: roomRef.current?.clockRtt() ?? null });
            deck.setFollowTrim(0);
            deck.seek(timed.target);
            followSeekAt.current[id] = now;
          } else if (timed.kind === "trim") {
            deck.setFollowTrim(timed.trim);
          } else if (timed.kind === "align") {
            deck.seek(timed.target);
          }
          deck.followTick(t.playing ? masterNow + lat : t.pos, t.playing, t.rate);
          convergeStems();
          return;
        }
        const action = decideFollowTick({
          masterPlaying: t.playing,
          deckPlaying: deck.playing,
          deckPos: deck.position(),
          masterPos: t.pos,
          sinceFollowSeekMs: now - followSeekAt.current[id],
        });
        if (action.kind !== "hold") event("room.follow", { deck: id, kind: action.kind, untimed: true, errMs: Math.round((deck.position() - t.pos) * 1000) });
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
        convergeStems();
        // Feed the follower visual clock + the anchor's effective RATE: the waveform glides at
        // the display rate off a wall-clock extrapolation of this tick, and a listener's own
        // audio re-speeds to the host's rate so it stops drifting (the host's jog-bend /
        // sync-trim never cross as intents). See Deck.visualPosition / followTick.
        deck.followTick(t.pos, t.playing, t.rate);
        // Reliable stem-state convergence: apply the anchor's authoritative per-stem mute/
        // gain when present, but SKIP a stem we ourselves touched in the last 400 ms so our
        // own in-flight change isn't briefly stomped by a slightly-stale echo. Idempotent —
        // only repaint when a value actually moved.
        function convergeStems() {
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
        }
      });
      if (flipped) refresh();
    },
    [engine, refresh, runRoomLoad],
  );

  return { runRoomLoad, applyRoomSnapshot, onRoomIntent, onRoomTick };
}
