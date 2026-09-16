// useStemViewSync — the session stem-view concern: the INBOUND mirror (a host streams its 4-lane
// stem envelopes → a stem-less/mobile listener rebuilds the display from them) paired with the
// OUTBOUND host streamers (publish this device's envelopes; fulfil a remote's separation request).
// Lifted out of App.tsx so a session/stems agent owns this file instead of contending on App. PURE
// RELOCATION: the bodies below are sed-verbatim; the spine (engine/refresh/roomRef) is pulled via
// useSpine, everything else arrives via `deps` destructured to the original names so closures +
// useCallback dep arrays are byte-identical. The host streamers read roomRef.current lazily (so the
// hook can sit before useRoom). Returns feed App's useRoom (onStemView), the onStemsReady effect,
// the join-publish effects, and stemReqRef. Type-only `../App` import erased at build (no cycle).
// See htl-refactor-monoliths.
import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { getStemModel, deviceSupportsModel, type StemModel, type StemView } from "@htl";
import type { DeckId } from "@htl/audio";
import { useSpine } from "./spine";
import type { SeparateOpts, SeparationReport, StemStatus } from "../App";
import { startStemRequestReporter } from "../htl/room/stemRequestReporter";
import { STEM_ACK_HEARTBEAT_MS, type StemAckState } from "../htl/room/protocol";
import { onModelLoading } from "../htl/stems/separate";

/** Progress is forwarded in steps of this many percent — caps a separation at ~10 wire frames
 *  regardless of how many segments or shift-TTA passes the separator splits the work into. */
const PROGRESS_STEP = 10;

export interface StemViewSyncDeps {
  setStatusFor: (id: DeckId, st: StemStatus | null) => void;
  forceSeparate: (id: DeckId, videoId: string, mix: AudioBuffer, model: StemModel, opts: SeparateOpts) => Promise<void>;
  loaded: Record<DeckId, string | null>;
  // Read-narrowed view of App's `latest` ref (covariant `current` → only `.loaded` is touched).
  latest: { readonly current: { loaded: Record<DeckId, string | null> } };
  stemReqTimers: MutableRefObject<Partial<Record<DeckId, ReturnType<typeof setTimeout>>>>;
  stemViewWaitTimers: MutableRefObject<Partial<Record<DeckId, ReturnType<typeof setTimeout>>>>;
  reqSepGuard: MutableRefObject<Partial<Record<DeckId, string>>>;
}

export interface StemViewSync {
  onRoomStemView: (deck: DeckId, view: unknown) => void;
  sendHostStemView: (id: DeckId) => void;
  handleStemRequest: (id: DeckId, modelId: string) => void;
}

export function useStemViewSync(deps: StemViewSyncDeps): StemViewSync {
  const { engine, refresh, roomRef, emitRef } = useSpine();
  const { setStatusFor, forceSeparate, loaded, latest, stemReqTimers, stemViewWaitTimers, reqSepGuard } = deps;
  // The phase each deck's in-flight request is actually in, so a SECOND requester for the same track is
  // told the truth ("queued", "loading", "separating") instead of a hardcoded "separating".
  const reqPhase = useRef<Partial<Record<DeckId, { state: StemAckState; pct?: number }>>>({});

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

  const sendHostStemView = useCallback(
    (id: DeckId) => {
      const r = roomRef.current;
      if (!r) return;
      // Stream from whichever device actually holds the stems and speaks for the board
      // (the clock OR any controller). extractStemView returns null unless this deck has
      // REAL local stems, so a stem-less remote can never publish here.
      if (r.status !== "online" || (!r.controlling && !r.isAnchor)) return;
      const v = engine.deck(id).extractStemView(latest.current.loaded[id] ?? undefined);
      if (v) r.sendStemView(id, v);
    },
    [engine],
  );

  // HOST side of a remote's stem request: only the audio authority (anchor) fulfills it —
  // separate the deck with the asked-for model, which fires onStemsReady → streams the
  // 4-lane view back to the requester. If we already have neural stems, just (re)stream.
  // ★ EVERY EXIT NOW ANSWERS. These six returns were all silent, so the requester could not tell
  // "not anchor" from "unsupported model" from "separating right now" — its only signal was a fixed
  // 20 s timeout, which fired WHILE THE HOST WAS SUCCEEDING on any track long enough to need more
  // than 20 s. Elapsed time was a proxy for the host's state, and it failed toward a confident lie.
  // Under host-only separation this is the primary stem path for every non-host device, so a
  // refusal has to carry its reason and a success has to say "hold on" in words rather than by
  // being slow.
  const handleStemRequest = useCallback(
    (id: DeckId, modelId: string) => {
      const ack = (state: StemAckState, reason?: string, pct?: number) =>
        emitRef.current({
          kind: "stemsAck", deck: id, model: modelId, state,
          ...(reason ? { reason } : {}),
          ...(pct !== undefined ? { pct } : {}),
        });
      // Not the audio authority: say so rather than leaving the requester to time out. Silence here
      // is the worst case — every OTHER device in the room is also not the anchor.
      if (!roomRef.current?.isAnchor) return;
      const vid = latest.current.loaded[id];
      const deck = engine.deck(id);
      if (!vid) return void ack("refused", "The host has no track loaded on that deck.");
      if (!deck.buffer) return void ack("refused", "The host's track is still loading.");
      if (deck.hasStems && deck.stemsNeural) {
        sendHostStemView(id); // already have them — the view IS the answer
        return;
      }
      const model = getStemModel(modelId);
      if (model.kind === "dsp") return void ack("refused", `${model.label} is a local-only model — the host can't stream it.`);
      if (!deviceSupportsModel(model)) return void ack("refused", `The host's device can't run ${model.label}.`);
      const key = `${vid}:${model.id}`;
      // ★ LOAD-BEARING, NOT WASTE: this second requester gets ONE ack and no gate or report of its own.
      // Its stall watchdog is kept alive only by the FIRST request's progress frames, which reach it
      // because the writer leg relays stemsAck to every co-DJ and the frames carry deck+model, not a
      // requester id. Narrow that relay to the original requester and this one times out mid-way
      // through a healthy separation. If it is ever narrowed, target every PENDING requester of the
      // deck:model. (I had filed the broadcast as harmless waste to tidy; Deckard caught that tidying
      // it would introduce exactly this bug.)
      // A second requester used to be told "separating" even when the job was still waiting in the GPU
      // queue — naming the wrong phase, which is the merge "queued" exists to prevent. It gets the phase
      // the first request is ACTUALLY in, and its watchdog is then kept alive by that request's
      // heartbeat (below), which reaches it through the writer-leg broadcast.
      if (reqSepGuard.current[id] === key) {
        const now = reqPhase.current[id];
        return void ack(now?.state ?? "queued", "The host is already working on this track.", now?.pct);
      }
      reqSepGuard.current[id] = key;
      // ★ PROGRESS, COALESCED AT THE SOURCE. The separator posts a true fraction per SEGMENT (and
      // per shift-TTA pass), so the raw rate is set by the WORK — a faster GPU or a shorter segment
      // would silently raise it. Forwarding it raw would bound the wire by today's segment length,
      // the "throttle measures the wrong denominator" mistake from the other end. So: emit only when
      // progress crosses a new PROGRESS_STEP, which caps a whole separation at ~10 frames no matter
      // how the work is chunked. Terminal success needs no frame — the stem view arriving IS it.
      // This only became safe to send after bd7af4c kept stemsAck off the listener crowd.
      // The gate is the tested one (progressGate.test.ts), not an inline copy of it — a tested
      // function beside an untested reimplementation is how a fake ends up right where the real
      // code is wrong.
      // ★ PROGRESS, COALESCED AT THE SOURCE, plus PHASES and a HEARTBEAT. The separator posts per segment,
      // so forwarding raw would bound the wire by today's segment length; each phase emits only on a new
      // PROGRESS_STEP (~10 frames per separation). A queued request has no progress of its own, so the
      // current phase is also re-sent every STEM_ACK_HEARTBEAT_MS. All of it — one gate per phase, the
      // gate-bypassing heartbeat, the anchor-loss check, the single teardown — lives in the tested
      // startStemRequestReporter; this hook only wires it. (Safe to send only since bd7af4c kept
      // stemsAck off the listener crowd.)
      const reporter = startStemRequestReporter({
        ack,
        isAuthority: () => !!roomRef.current?.isAnchor,
        subscribeLoading: onModelLoading,
        onPhase: (state, pct) => {
          reqPhase.current[id] = { state, pct };
        },
        heartbeatMs: STEM_ACK_HEARTBEAT_MS,
        step: PROGRESS_STEP,
      });
      const report: SeparationReport = (e) => reporter.report(e);
      // No .catch(): forceSeparate never throws — failures arrive through `report` instead. The
      // .catch() that used to sit here could not fire, and claimed to handle exactly this.
      // purpose "request": join the job already running for this track+model (or use the cache) instead
      // of forcing a second separation. This is the argument that actually closes the duplicate.
      void forceSeparate(id, vid, deck.buffer, model, { purpose: "request", report }).finally(() => {
        reporter.stop();
        if (reqSepGuard.current[id] === key) {
          reqSepGuard.current[id] = undefined;
          reqPhase.current[id] = undefined;
        }
      });
    },
    [engine, forceSeparate, sendHostStemView, emitRef],
  );

  return { onRoomStemView, sendHostStemView, handleStemRequest };
}
