// useReplay — G1c recorded-set replay: drives the SAME live-listener handlers from a LOCAL clock
// (replayDispatch routes a recorded recipe to applyRoomSnapshot/onRoomIntent/onRoomTick) instead of
// the live WS, so a saved set plays back on the decks. playRecordedSet / editTrim launch a replay
// (tuning out of any live listen first, via roomRef.current lazily). Lifted out of App.tsx so this
// concern owns its file. PURE RELOCATION: bodies sed-verbatim; the spine (engine/roomRef) is pulled
// via useSpine, the 3 session handlers + setters arrive via `deps`. Returns: `replay` (drives the
// follow/lock gates + ReplayBar), playRecordedSet/editTrim (Profile/Discover handlers), and
// trimEdit/setTrimEdit (the owner's set-trim controls). See htl-refactor-monoliths.
import { useCallback, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useSetReplay } from "@htl/replay";
import type { ClientMsg, Intent, TickDecks } from "@htl/room";
import type { AutoMixMirror } from "@htl";
import { useSpine } from "./spine";

export interface ReplayDeps {
  applyRoomSnapshot: (snapshot: unknown) => void;
  onRoomIntent: (intent: Intent) => void;
  onRoomTick: (decks: TickDecks) => void;
  setRemoteAutomix: Dispatch<SetStateAction<AutoMixMirror | null>>;
  setProfileOpen: Dispatch<SetStateAction<boolean>>;
  // Plain (v: boolean) => void, not a state setter: the People dock replaced the standalone
  // Discover dock, so "close Discover" is now a call into the host's own open/close logic
  // rather than a raw setState. Only ever called with a literal here.
  setDiscoverOpen: (v: boolean) => void;
  setPublicHandle: Dispatch<SetStateAction<string | null>>;
  playSetRef: MutableRefObject<(id: string) => void>;
}

export interface ReplayApi {
  replay: ReturnType<typeof useSetReplay>;
  playRecordedSet: (id: string, range?: { start: number; end: number }) => void;
  editTrim: (s: { id: string; trimStart?: number | null; trimEnd?: number | null; duration: number }) => void;
  trimEdit: { id: string; start: number; end: number } | null;
  setTrimEdit: Dispatch<SetStateAction<{ id: string; start: number; end: number } | null>>;
}

export function useReplay(deps: ReplayDeps): ReplayApi {
  const { engine, roomRef } = useSpine();
  const {
    applyRoomSnapshot,
    onRoomIntent,
    onRoomTick,
    setRemoteAutomix,
    setProfileOpen,
    setDiscoverOpen,
    setPublicHandle,
    playSetRef,
  } = deps;

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

  return { replay, playRecordedSet, editTrim, trimEdit, setTrimEdit };
}
