// SNAPSHOT <-> DECK — the receiving (and recording) half of session restore, lifted out of App.tsx.
//
// ★ WHY IT MOVED, and it is not "App.tsx is long". These four functions are the entire APPLYING
// side of deck state: they write the room's (or a saved session's) authority into this device's
// decks, and they must never ask canDriveDeck — a follower that gated them would stop following
// (thread ba5eb70e, ruling 27e1bc4d). The driving side, which must ALWAYS ask, sat in the same
// file, separated from them by nothing but a function boundary. A function boundary cannot carry
// that distinction, because the same method is reached from both sides: `seek` is APPLYING when it
// comes from a DeckSnapshot and ORIGINATING when the user drags the waveform.
//
// ★ AND THE MODULE IS NOT THE POINT EITHER — the INTERFACE IS. A module that imports the full Deck
// bounds nothing at all; it just moves the same 163-member surface behind a different filename.
// What does the work is the narrowed STRUCTURAL interface a consumer declares for itself, which
// src/htl/room/applyIntent.ts has been proving since long before this design discussion started:
// it declares its own `IntentDeck` and imports nothing from the audio layer, and the real Deck
// satisfies it by having the methods, with no import and no change on Deck's side.
//
// So this module copies that precedent rather than inventing a design. `SnapshotDeck` below is the
// deck surface a SNAPSHOT can touch, and nothing else. It is a real bound because of what it LEAVES
// OUT, and the check that it stays one is mechanical: if this file ever imports Deck, the bound is
// gone and the move bought nothing. Nothing here may import from ../htl/audio.
//
// Metron's correction, kept because the reasoning is the useful part: I had claimed all 136
// deck-mutation sites lived in App.tsx. That came from a scan that reads only App.tsx — true the
// way "every fish I caught was in this lake" is true. Counted across src/, deck writers are touched
// in ten files; App.tsx holds 130 of 528. The extraction is still right, but it is copying a working
// precedent, not clearing a prerequisite for something we had yet to invent.

import type { DeckSnapshot } from "../htl/state/session";
import type { DeckMeta } from "../components/DeckLane";
import { STEM_KEYS } from "./useStemPipeline";
import { isMobileDevice } from "../htl/stems/models";

/** The deck surface a snapshot READS. Derived from DeckSnapshot's own field types wherever one
 *  exists, so this interface cannot drift from the shape it is converting to. */
export interface SnapshotDeck {
  readonly tempo: number;
  readonly trim: number;
  readonly level: number;
  readonly eqLow: number;
  readonly eqMid: number;
  readonly eqHigh: number;
  readonly eqLowFreq: number;
  readonly eqMidFreq: number;
  readonly eqHighFreq: number;
  readonly eqMidQ: number;
  readonly eqLowQ: number;
  readonly eqHighQ: number;
  readonly eqLowShape: number;
  readonly eqMidShape: number;
  readonly eqHighShape: number;
  readonly eqHpFreq: number;
  readonly eqHpQ: number;
  readonly eqLpFreq: number;
  readonly eqLpQ: number;
  readonly eqBypassed: boolean;
  readonly eqMix: number;
  readonly eqOut: number;
  readonly filterValue: number;
  readonly keylock: boolean;
  readonly pitch: number;
  readonly quantizing: boolean;
  readonly playing: boolean;
  readonly ownStems: boolean;
  readonly stemsNeural: boolean;
  fxSnapshot(): DeckSnapshot["fx"];
  fxChainSnapshot(): DeckSnapshot["fxChains"];
  position(): number;
  stemLevel(name: (typeof STEM_KEYS)[number]): number;
  stemActive(name: (typeof STEM_KEYS)[number]): boolean;

  // Accessor-backed state: read on the way out, written on the way in.
  skipBeats: number;
  cuePoint: DeckSnapshot["cuePoint"];
  hotCues: DeckSnapshot["hotCues"];
  hotLoops: NonNullable<DeckSnapshot["hotLoops"]>;
  loop: DeckSnapshot["loop"];
  loopInPoint: DeckSnapshot["loopInPoint"];

  // ★ THE WRITE HALF, AND THE WHOLE POINT OF THE BOUND: these are the ONLY mutators a snapshot may
  // reach. Everything a DJ originates — the transport beyond a restore, the jog, the sampler, the
  // cue bus, the stem pipeline — is absent by construction, so an originating gesture cannot be
  // written against this type by accident.
  setTempo(v: number): void;
  setTrim(v: number): void;
  setLevel(v: number): void;
  setEqLow(v: number): void;
  setEqMid(v: number): void;
  setEqHigh(v: number): void;
  setEqLowFreq(v: number): void;
  setEqMidFreq(v: number): void;
  setEqHighFreq(v: number): void;
  setEqMidQ(v: number): void;
  setEqLowQ(v: number): void;
  setEqHighQ(v: number): void;
  setEqLowShape(v: number): void;
  setEqMidShape(v: number): void;
  setEqHighShape(v: number): void;
  setEqHpFreq(v: number): void;
  setEqHpQ(v: number): void;
  setEqLpFreq(v: number): void;
  setEqLpQ(v: number): void;
  setEqBypass(on: boolean): void;
  setEqMix(v: number): void;
  setEqOut(v: number): void;
  setFilter(v: number): void;
  setKeylock(on: boolean): void;
  setPitch(semis: number): void;
  setQuantize(on: boolean): void;
  applyFxSnapshot(fx: DeckSnapshot["fx"]): void;
  applyFxChainSnapshot(fx: DeckSnapshot["fxChains"]): void;
  markRemoteStems(has: boolean, neural: boolean): void;
  setStemGain(name: (typeof STEM_KEYS)[number], v: number): void;
  setStemMute(name: (typeof STEM_KEYS)[number], on: boolean): void;
  seek(t: number): void;
  play(): void;
}

export function deckSnapshot(deck: SnapshotDeck, meta: DeckMeta, videoId: string | null): DeckSnapshot {
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
    eqMix: deck.eqMix,
    eqOut: deck.eqOut,
    filter: deck.filterValue,
    fx: deck.fxSnapshot(), // post-EQ effect chain (delay/reverb…) — EQ stays in the eq* fields
    fxChains: deck.fxChainSnapshot(), // the STEM chains — `fx` above is the master's alone
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

// Apply per-stem mixer state from a snapshot. The deck stores gain/mute even
// before its stems exist, so it takes effect the moment separation finishes.
export function applyDeckStems(deck: SnapshotDeck, s: DeckSnapshot) {
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
/** ★ THE CHANNEL'S OWN SOUND — everything that belongs to the DECK rather than to the track on it:
 *  the EQ, the colour filter, the FX rack and the stem chains. It was inlined in applyDeckControls,
 *  which is only ever called from inside the track-load path — so a deck that booted with no track
 *  restored NONE of it, and the chains a DJ had built came back gone. Every deck gets this at boot
 *  now, track or no track; the load path still calls it (idempotent) so a restored deck is correct
 *  whichever route it arrives by. Cue points, loops and the playhead deliberately stay OUT: those
 *  are the TRACK's, and applying them to an empty deck would be a lie. */
export function applyDeckRack(deck: SnapshotDeck, s: DeckSnapshot) {
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
  if (s.eqHpFreq != null) deck.setEqHpFreq(s.eqHpFreq);
  if (s.eqHpQ != null) deck.setEqHpQ(s.eqHpQ);
  if (s.eqLpFreq != null) deck.setEqLpFreq(s.eqLpFreq);
  if (s.eqLpQ != null) deck.setEqLpQ(s.eqLpQ);
  deck.setEqBypass(!!s.eqBypass);
  if (s.eqMix != null) deck.setEqMix(s.eqMix);
  if (s.eqOut != null) deck.setEqOut(s.eqOut);
  deck.applyFxSnapshot(s.fx); // FX chain (undefined = old snapshot → keep default; [] = explicitly empty)
  deck.applyFxChainSnapshot(s.fxChains); // the stem chains, which `fx` has never described
}

export function applyDeckControls(deck: SnapshotDeck, s: DeckSnapshot) {
  deck.setTempo(s.tempo);
  deck.setTrim(s.trim);
  deck.setLevel(s.level);
  applyDeckRack(deck, s); // the EQ, the filter, the rack and the chains — see above
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
