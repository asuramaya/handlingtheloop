// APPLYING ONE INTENT — the receiving half of session sync, lifted out of the React hook that
// used to own it.
//
// WHY IT MOVED. This switch is the only place a remote gesture becomes local state, so it is
// exactly the code a multi-device bug lives in — and while it sat inside a `useCallback` in
// useSessionSync it could not be called by a test at all. "Does turning this knob on my phone
// move the same effect on my laptop?" was a question the suite structurally could not ask, so
// nobody asked it, and the answer drifted. It is a plain function over two interfaces now, and
// src/htl/room/roomSim.ts drives two simulated devices through it.
//
// The interfaces are STRUCTURAL: the real Deck and AudioEngine satisfy them by having the
// methods, with no imports and no changes on their side. Anything that can hold the same state
// can stand in.

import { type DeckId, type Intent, type StemName } from "./protocol";
import type { FxChainSlot, FxSlot } from "./protocol";
import { withRemote } from "./remoteApply";
import { hotCueHasResult } from "./loopWire";

/** The deck surface an intent can touch. The real Deck has all of it. */
export interface IntentDeck {
  setTempo(v: number): void;
  setTrim(v: number): void;
  setLevel(v: number): void;
  setEqLow(v: number): void;
  setEqMid(v: number): void;
  setEqHigh(v: number): void;
  setEqLowFreq(v: number): void;
  setEqMidFreq(v: number): void;
  setEqHighFreq(v: number): void;
  setEqLowQ(v: number): void;
  setEqMidQ(v: number): void;
  setEqHighQ(v: number): void;
  setEqLowShape(v: number): void;
  setEqMidShape(v: number): void;
  setEqHighShape(v: number): void;
  setEqHpFreq(v: number): void;
  setEqHpQ(v: number): void;
  setEqLpFreq(v: number): void;
  setEqLpQ(v: number): void;
  setEqMix(v: number): void;
  setEqOut(v: number): void;
  setFilter(v: number): void;
  setPitch(v: number): void;
  setKeylock(v: boolean): void;
  setEqBypass(v: boolean): void;
  setQuantize(v: boolean): void;
  setFxParam(slot: number, param: string, value: number): void;
  setFxBypass(slot: number, value: boolean): void;
  applyFxSnapshot(rack: FxSlot[]): void;
  /** Resolve a portable FX address (chain NAME + device kind) to a local slot; -1 if absent. */
  fxSlotOf(chain: string, fx: string): number;
  applyFxChains(chains: ReadonlyArray<FxChainSlot> | undefined): void;
  setStemGain(stem: StemName, value: number): void;
  setStemMute(stem: StemName, muted: boolean): void;
  readonly playing: boolean;
  play(): void;
  pause(): void;
  seek(position: number): void;
  cuePoint: number;
  scrubBegin(slip?: boolean): void;
  scrubMove(delta: number): void;
  scrubEnd(): void;
  loopIn(): void;
  loopOut(): void;
  exitLoop(): void;
  reloop(): void;
  setBeatLoop(beats: number): void;
  hotCue(slot: number): void;
  saveLoop(slot: number): void;
  clearHotCue(slot: number): void;
  skipBeats: number;
  applyLoopRegion(start: number, end: number, active: boolean): void;
  /** Adopt a sender's absolute loop RESULT verbatim (no snap, no recompute, no broadcast). */
  applyLoopState(loop: { start: number; end: number; active: boolean; beats?: number } | null, inPoint?: number | null, seek?: number): void;
  /** Adopt a sender's hot-cue slot contents verbatim (no broadcast). */
  applyHotCue(slot: number, cue: number | null, loop: { start: number; end: number; beats?: number } | null): void;
}

/** The engine surface. The real AudioEngine has all of it. */
export interface IntentEngine {
  deck(id: DeckId): IntentDeck;
  setCrossfade(v: number): void;
  resume(): void;
  /** Take a peer's SYNC / KEY role for real (not just the button) — see AudioEngine.applySyncRole. */
  applySyncRole(slave: DeckId | null): void;
  applyKeyRole(slave: DeckId | null): void;
  /** Remote tempo / pitch: an echo of the lock on the follower keeps it (syncRoles.isRoleEcho). */
  applyRemoteTempo(id: DeckId, pct: number, follow?: boolean): void;
  applyRemotePitch(id: DeckId, semis: number, follow?: boolean): void;
}

/** Everything an intent needs that is NOT the audio engine — React mirrors, the sampler bridge,
 *  the queue authority, the loader. The hook supplies the real ones; the simulator records them. */
export interface IntentHost {
  automix(action: "toggle" | "skip" | "mixnow" | "hold"): void;
  board(deck: DeckId, id: string, phase?: "down" | "up", arg?: string | number): void;
  queue(intent: Extract<Intent, { kind: "queue" }>): void;
  sample(intent: Extract<Intent, { kind: "sample" }>): void;
  /** Mirror the crossfader into React state (the engine move happens here). */
  crossfade(v: number): void;
  tempoRange(v: number): void;
  load(deck: DeckId, videoId: string, name?: string, artist?: string): void;
  /** A remote scrub is in flight on this deck → suppress tick-follow. The 250 ms tail on
   *  `false` belongs to the caller that owns the flag. */
  scrub(deck: DeckId, active: boolean): void;
  ensureGuestStems(deck: DeckId): void;
  refresh(): void;
}

/** ★ WHICH DEVICE DID THEY MEAN? One rule, in one place, for both FX intents.
 *
 *  A portable address (chain NAME + device kind) wins when the sender supplied one, because a
 *  `slot` is an index into `chains.flatMap(devices)` and that list differs the moment two devices
 *  hold different chains — the sender's "slot 5" is the receiver's fourth device, or nothing.
 *
 *  When the address resolves to nothing HERE, the answer is -1 and the caller does NOTHING. That
 *  is deliberate: falling back to the index would be precisely the bug, quietly moving a device
 *  the sender never named. A gesture that cannot be placed is dropped, not guessed.
 *
 *  With no address at all — an older peer — the slot is used as before, which is exactly the
 *  behaviour those peers already get from each other. */
function fxSlot(deck: IntentDeck, chain: string | undefined, fx: string | undefined, slot: number): number {
  if (chain != null && fx != null) return deck.fxSlotOf(chain, fx);
  return slot;
}

/** ★ Applied INSIDE withRemote (operator, 2026-11-11: session sync audit): a deck method this runs
 *  (an older peer's loop re-run, say) must not broadcast its own result back as if the DJ here had
 *  made it. See remoteApply.ts. */
export function applyIntent(intent: Intent, engine: IntentEngine, host: IntentHost): void {
  withRemote(() => applyIntentNow(intent, engine, host));
}

function applyIntentNow(intent: Intent, engine: IntentEngine, host: IntentHost): void {
  if (intent.kind === "automix") return host.automix(intent.action);
  // Board-agnostic gesture (pad mode, FX-pad throw, …) — the registry owns the semantics, so new
  // board controls sync + replay without touching this switch.
  if (intent.kind === "board") return host.board(intent.deck, intent.id, intent.phase, intent.arg);
  if (intent.kind === "queue") return host.queue(intent);
  if (intent.kind === "crossfade") {
    host.crossfade(intent.value);
    engine.setCrossfade(intent.value);
    return;
  }
  if (intent.kind === "tempoRange") return host.tempoRange(intent.value);
  // ★ SYNC / KEY role: the REAL role, not the button (operator, 2026-11-11: session sync audit).
  // Mirroring only the label left this engine's follower id null, so the next press here inverted
  // both devices. The receiver engages follow + key shift as a local press would, minus the
  // broadcast and minus the align seek (the sender's explicit seek carries the position).
  if (intent.kind === "sync") {
    engine.applySyncRole(intent.slave);
    host.refresh();
    return;
  }
  if (intent.kind === "key") {
    engine.applyKeyRole(intent.slave);
    host.refresh();
    return;
  }
  // A co-DJ fired a sampler pad — reconstruct it locally. Has no `deck`, so handle it before the
  // lookup below.
  if (intent.kind === "sample") return host.sample(intent);

  const deck = engine.deck(intent.deck);
  switch (intent.kind) {
    case "control":
      // Tempo / pitch go through the engine: on the follower of a lock, the lock's own echo must not
      // release it (syncRoles.isRoleEcho), while a hand on the far fader still does.
      if (intent.param === "tempo") engine.applyRemoteTempo(intent.deck, intent.value, intent.follow);
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
      else if (intent.param === "pitch") engine.applyRemotePitch(intent.deck, Math.round(intent.value), intent.follow);
      break;
    case "toggle":
      if (intent.param === "keylock") deck.setKeylock(intent.value);
      else if (intent.param === "eqBypass") deck.setEqBypass(intent.value);
      else if (intent.param === "quantize") deck.setQuantize(intent.value);
      // (legacy "fx" filter-master toggle removed — ignored if an old peer sends it)
      break;
    case "fxParam": {
      // A post-EQ effect knob moved on a controller — high-frequency live sync.
      const slot = fxSlot(deck, intent.chain, intent.fx, intent.slot);
      if (slot >= 0) deck.setFxParam(slot, intent.param, intent.value);
      host.refresh();
      break;
    }
    case "fxBypass": {
      const slot = fxSlot(deck, intent.chain, intent.fx, intent.slot);
      if (slot >= 0) deck.setFxBypass(slot, intent.value);
      host.refresh();
      break;
    }
    case "fxRack":
      // Add/remove/reorder the effect chain (or a late joiner catching up): reconcile the whole
      // list — kinds + order rebuild, params + bypass re-applied. `chains` is the stem chains,
      // absent from an older peer's message, in which case they are left exactly as they are
      // (never destroyed by a message that could not describe them).
      deck.applyFxSnapshot(intent.rack);
      if (intent.chains) deck.applyFxChains(intent.chains);
      host.refresh();
      break;
    case "stemGain":
      // Apply regardless of local stems — the deck holds gain/mute state buffer-free, so a
      // mix-only remote stays in sync and reflects it on its cells.
      deck.setStemGain(intent.stem, intent.value);
      host.ensureGuestStems(intent.deck);
      break;
    case "stem":
      deck.setStemMute(intent.stem, !intent.on);
      host.ensureGuestStems(intent.deck);
      break;
    case "transport":
      // ★ PLAY/PAUSE CARRY WHERE (operator, 2026-11-11: session sync audit): a quantized start seeks
      // to its landing beat and then plays, and a bare play here started from THIS needle instead.
      // A deck already playing is left alone (a seek would only jump it back by the network delay).
      if (intent.action === "play") {
        if (!deck.playing) {
          engine.resume(); // a co-DJ's deck must advance (silently) to track the master
          if (intent.position != null) deck.seek(intent.position);
          deck.play();
        }
      } else if (intent.action === "pause") {
        if (deck.playing) deck.pause();
        if (intent.position != null) deck.seek(intent.position);
      } else if (intent.action === "seek") deck.seek(intent.position ?? 0);
      break;
    case "cue":
      deck.cuePoint = intent.position;
      break;
    case "jog":
      // Drive the platter physics locally (audible scratch on the master, silent on co-DJs).
      if (intent.phase === "start") {
        host.scrub(intent.deck, true);
        engine.resume();
        deck.scrubBegin(intent.slip); // the sender's slip, when it said (older peers: ours)
      } else if (intent.phase === "move") {
        deck.scrubMove(intent.delta ?? 0);
      } else {
        deck.scrubEnd();
        host.scrub(intent.deck, false);
      }
      break;
    case "loop":
      // ★ A RESULT IS APPLIED VERBATIM (loopWire.ts): the sender's region / in-point exactly, and its
      // head move if it made one. Only a message from an older bundle (no `state`) is re-run here,
      // at this device's playhead, as before.
      if (intent.state !== undefined) {
        deck.applyLoopState(intent.state.loop, intent.state.inPoint, intent.position);
        break;
      }
      if (intent.action === "in") deck.loopIn();
      else if (intent.action === "out") deck.loopOut();
      else if (intent.action === "exit") deck.exitLoop();
      else if (intent.action === "reloop") deck.reloop();
      else deck.setBeatLoop(intent.beats ?? 0.5);
      break;
    case "hotcue":
      if (intent.action !== "clear" && hotCueHasResult(intent)) {
        // The slot holds what the sender's slot holds; a press that moved the sender's head moves
        // this one to the same LANDED place, whatever this device had stored on the pad.
        deck.applyHotCue(intent.slot, intent.cue ?? null, intent.loop ?? null);
        if (intent.position != null) deck.seek(intent.position);
        break;
      }
      if (intent.action === "press") deck.hotCue(intent.slot);
      else if (intent.action === "save") deck.saveLoop(intent.slot);
      else deck.clearHotCue(intent.slot);
      break;
    case "skip":
      deck.skipBeats = intent.beats; // jog / beat-jump resolution
      break;
    case "loopBounds":
      // fine-adjust / move. The newer sender's count and head move ride along when present.
      if (intent.beats != null || intent.position != null) deck.applyLoopState({ start: intent.start, end: intent.end, active: intent.active, beats: intent.beats }, undefined, intent.position);
      else deck.applyLoopRegion(intent.start, intent.end, intent.active);
      break;
    case "load":
      host.load(intent.deck, intent.videoId, intent.name, intent.artist);
      break;
  }
}
