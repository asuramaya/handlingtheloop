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
import type { StemStatus } from "../App";

export interface StemViewSyncDeps {
  setStatusFor: (id: DeckId, st: StemStatus | null) => void;
  forceSeparate: (id: DeckId, videoId: string, mix: AudioBuffer, model: StemModel, stale?: () => boolean) => Promise<void>;
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
  const { engine, refresh, roomRef } = useSpine();
  const { setStatusFor, forceSeparate, loaded, latest, stemReqTimers, stemViewWaitTimers, reqSepGuard } = deps;

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
  const handleStemRequest = useCallback(
    (id: DeckId, modelId: string) => {
      if (!roomRef.current?.isAnchor) return;
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

  return { onRoomStemView, sendHostStemView, handleStemRequest };
}
