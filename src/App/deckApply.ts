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
// ★ WHERE THE BOUND IS ENFORCED: src/htl/audio/deckSurfaceBound.test.ts, and NOT here any more.
// This module used to carry its own test asserting the property over a two-entry list. That was a
// roster of one fixed by making it a roster of two — the module that gets this property tomorrow
// still went unchecked, and nothing said so. Metron replaced it with a DERIVED population (every
// module declaring a deck surface made of methods), which on its first run found a third module
// that had had the property all along and was never protected: src/htl/room/fxWire.ts. It also
// corrected the invariant my roster had encoded: fxWire only READS, so "an applying module declares
// its own surface" was a property of the two modules I happened to be looking at. The rule is that
// A MODULE DECLARING ITS OWN DECK SURFACE MUST NOT ALSO REACH FOR THE WIDE ONE.
//
// Metron's correction, kept because the reasoning is the useful part: I had claimed all 136
// deck-mutation sites lived in App.tsx. That came from a scan that reads only App.tsx — true the
// way "every fish I caught was in this lake" is true. Counted across src/, deck writers are touched
// in ten files; App.tsx holds 130 of 528. The extraction is still right, but it is copying a working
// precedent, not clearing a prerequisite for something we had yet to invent.

import type { DeckSnapshot } from "../htl/state/session";
import type { Beatgrid } from "../htl/analysis/analyze";
import { decodeGrid, encodeGrid, gridMatches } from "../htl/room/gridWire";
import type { SnapField } from "../htl/room/snapshotRepair";

/** Pad a saved cue/loop slot array out to `n` (the deck's own slot count) with empty slots: a save
 *  from before the second cue bank carries only 8. */
export function padSlots<T>(a: (T | null)[], n: number): (T | null)[] {
  return a.length >= n ? a : [...a, ...new Array<T | null>(n - a.length).fill(null)];
}
import type { DeckMeta } from "../components/DeckLane";
import { STEM_KEYS } from "./useStemPipeline";
import { isMobileDevice } from "../htl/stems/models";

/** The deck surface a snapshot READS. Derived from DeckSnapshot's own field types wherever one
 *  exists, so this interface cannot drift from the shape it is converting to. */
export interface SnapshotDeck {
  /** The loop engine's verbatim apply (audio included, no broadcast); optional so a fake deck can omit it. */
  applyLoopState?(loop: { start: number; end: number; active: boolean; beats?: number } | null, inPoint?: number | null, seek?: number): void;
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
  readonly remoteStems: boolean;
  readonly stemsNeural: boolean;
  /** The track's beat grid: read into the snapshot, and ADOPTED from the anchor's by a follower. */
  beatgrid: Beatgrid | null;
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
    // The grid only describes a track that is on the deck; an empty deck has none to send.
    ...(videoId && deck.beatgrid ? { grid: encodeGrid(deck.beatgrid) } : {}),
  };
}

// ── The follower's REPAIR (operator, 2026-11-11: session sync audit) ──────────────────────────────
// reconcileDeck replaces "apply the whole snapshot once per videoId": it runs on EVERY newer snapshot,
// so it has to be safe to run over a live deck, which is two rules —
//   IDEMPOTENT: a setter is called only when the value actually differs. Re-writing an equal loop
//     re-anchors it, an equal EQ ramps for nothing, an equal stem mute clicks; none of that may happen
//     on a heartbeat that changes nothing.
//   NOT OVER OUR OWN EDIT: a field this device changed in the last second is `held` and left alone;
//     the snapshot is a round trip old and cannot contain our gesture yet.
// The FX rack and chains are compared here (fxDiffers) but applied by the caller, which must wait
// for the FX worklets on a cold boot. Returns the fields it actually wrote, for the trace and tests.
const EPS = 1e-6;
const same = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? a == b : Math.abs(a - b) <= EPS);
const sameLoop = (a: { active: boolean; start: number; end: number; beats: number } | null | undefined, b: typeof a) =>
  !a || !b ? !a === !b : a.active === b.active && same(a.start, b.start) && same(a.end, b.end) && same(a.beats, b.beats);
const sameSlots = <T>(a: readonly (T | null)[], b: readonly (T | null)[], eq: (x: T, y: T) => boolean) => {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x === null || y === null ? x !== y : !eq(x, y)) return false;
  }
  return true;
};

export function fxDiffers(deck: Pick<SnapshotDeck, "fxSnapshot" | "fxChainSnapshot">, d: DeckSnapshot): boolean {
  if (d.fx !== undefined && JSON.stringify(deck.fxSnapshot()) !== JSON.stringify(d.fx)) return true;
  if (d.fxChains !== undefined && JSON.stringify(deck.fxChainSnapshot()) !== JSON.stringify(d.fxChains)) return true;
  return false;
}

export function reconcileDeck(deck: SnapshotDeck, d: DeckSnapshot, held: (f: SnapField) => boolean, mobile = isMobileDevice()): string[] {
  const wrote: string[] = [];
  const num = (field: SnapField, name: string, want: number | null | undefined, have: number, set: (v: number) => void) => {
    if (want == null || !Number.isFinite(want) || held(field) || same(have, want)) return;
    set(want);
    wrote.push(name);
  };
  num("tempo", "tempo", d.tempo, deck.tempo, (v) => deck.setTempo(v));
  num("trim", "trim", d.trim, deck.trim, (v) => deck.setTrim(v));
  num("level", "level", d.level, deck.level, (v) => deck.setLevel(v));
  num("eq", "eqLow", d.eqLow, deck.eqLow, (v) => deck.setEqLow(v));
  num("eq", "eqMid", d.eqMid, deck.eqMid, (v) => deck.setEqMid(v));
  num("eq", "eqHigh", d.eqHigh, deck.eqHigh, (v) => deck.setEqHigh(v));
  num("eq", "eqLowFreq", d.eqLowFreq, deck.eqLowFreq, (v) => deck.setEqLowFreq(v));
  num("eq", "eqMidFreq", d.eqMidFreq, deck.eqMidFreq, (v) => deck.setEqMidFreq(v));
  num("eq", "eqHighFreq", d.eqHighFreq, deck.eqHighFreq, (v) => deck.setEqHighFreq(v));
  num("eq", "eqMidQ", d.eqMidQ, deck.eqMidQ, (v) => deck.setEqMidQ(v));
  num("eq", "eqLowShape", d.eqLowShape, deck.eqLowShape, (v) => deck.setEqLowShape(v));
  num("eq", "eqMidShape", d.eqMidShape, deck.eqMidShape, (v) => deck.setEqMidShape(v));
  num("eq", "eqHighShape", d.eqHighShape, deck.eqHighShape, (v) => deck.setEqHighShape(v));
  num("eq", "eqLowQ", d.eqLowQ, deck.eqLowQ, (v) => deck.setEqLowQ(v));
  num("eq", "eqHighQ", d.eqHighQ, deck.eqHighQ, (v) => deck.setEqHighQ(v));
  // The filter drives the EQ's HP/LP nodes, so it goes BEFORE the explicit cut positions (as in
  // applyDeckRack) — otherwise a centred filter would reset manually-dragged cut handles.
  num("filter", "filter", d.filter ?? 0, deck.filterValue, (v) => deck.setFilter(v));
  num("eq", "eqHpFreq", d.eqHpFreq, deck.eqHpFreq, (v) => deck.setEqHpFreq(v));
  num("eq", "eqHpQ", d.eqHpQ, deck.eqHpQ, (v) => deck.setEqHpQ(v));
  num("eq", "eqLpFreq", d.eqLpFreq, deck.eqLpFreq, (v) => deck.setEqLpFreq(v));
  num("eq", "eqLpQ", d.eqLpQ, deck.eqLpQ, (v) => deck.setEqLpQ(v));
  num("eq", "eqMix", d.eqMix, deck.eqMix, (v) => deck.setEqMix(v));
  num("eq", "eqOut", d.eqOut, deck.eqOut, (v) => deck.setEqOut(v));
  if (!held("eq") && deck.eqBypassed !== !!d.eqBypass) {
    deck.setEqBypass(!!d.eqBypass);
    wrote.push("eqBypass");
  }
  num("pitch", "pitch", d.pitchSemis ?? 0, deck.pitch, (v) => deck.setPitch(v));
  if (!held("keylock") && deck.keylock !== d.keylock) {
    deck.setKeylock(d.keylock);
    wrote.push("keylock");
  }
  if (!held("quantize") && deck.quantizing !== d.quantize) {
    deck.setQuantize(d.quantize);
    wrote.push("quantize");
  }
  // ★ skipBeats WAS CARRIED AND NEVER APPLIED: the snapshot has always written it, only the local
  // session restore read it back, so a follower's beat jump used its own resolution.
  if (d.skipBeats != null && !held("skipBeats") && deck.skipBeats !== d.skipBeats) {
    deck.skipBeats = d.skipBeats;
    wrote.push("skipBeats");
  }
  // Discrete state — absolute, so exact regardless of our own playhead.
  if (!held("cue") && !same(deck.cuePoint, d.cuePoint)) {
    deck.cuePoint = d.cuePoint;
    wrote.push("cuePoint");
  }
  if (!held("hotCues")) {
    const slots = deck.hotCues.length;
    const cues = padSlots([...d.hotCues], slots);
    if (!sameSlots(deck.hotCues, cues, (x, y) => same(x, y))) {
      deck.hotCues = cues;
      wrote.push("hotCues");
    }
    const loops = padSlots((d.hotLoops ?? []).map((l) => (l ? { ...l } : null)), slots);
    if (!sameSlots(deck.hotLoops, loops, (x, y) => sameLoop(x, y))) {
      deck.hotLoops = loops;
      wrote.push("hotLoops");
    }
  }
  if (!held("loop")) {
    const loopDiffers = !sameLoop(deck.loop, d.loop);
    const inDiffers = !same(deck.loopInPoint, d.loopInPoint);
    // ★ THROUGH THE LOOP ENGINE, NOT ONTO THE FIELD (integration of the session sync audit). Writing
    // deck.loop only changed what the deck SHOWS; the audio kept its old loop points until something
    // else called applyLoop. applyLoopState applies the region to the audio, never broadcasts, and
    // leaves the pending in-point alone when it is not given.
    if ((loopDiffers || inDiffers) && deck.applyLoopState) {
      deck.applyLoopState(d.loop ? { ...d.loop } : null, inDiffers ? d.loopInPoint : undefined);
      if (loopDiffers) wrote.push("loop");
      if (inDiffers) wrote.push("loopInPoint");
    } else {
      if (loopDiffers) {
        deck.loop = d.loop ? { ...d.loop } : null;
        wrote.push("loop");
      }
      if (inDiffers) {
        deck.loopInPoint = d.loopInPoint;
        wrote.push("loopInPoint");
      }
    }
  }
  if (!held("stems")) {
    // Same rule as applyDeckStems, written only where it differs: a stem-less phone mirrors the
    // source's stems as a REMOTE display (never over a real local set).
    if (mobile && !deck.ownStems && (deck.remoteStems !== !!d.hasStems || (deck.stemsNeural !== (!!d.hasStems && !!d.stemsNeural)))) {
      deck.markRemoteStems(!!d.hasStems, !!d.stemsNeural);
      wrote.push("remoteStems");
    }
    for (const name of STEM_KEYS) {
      const g = d.stemGains?.[name];
      if (g != null && !same(deck.stemLevel(name), g)) {
        deck.setStemGain(name, g);
        wrote.push(`stemGain.${name}`);
      }
      if (d.stemMutes) {
        const muted = !!d.stemMutes[name];
        if (deck.stemActive(name) === muted) {
          deck.setStemMute(name, muted);
          wrote.push(`stemMute.${name}`);
        }
      }
    }
  }
  // The anchor's grid for this track. Never held (no gesture of ours edits a grid) and never
  // replaced by our own analysis afterwards: the grid only changes in setBuffer, i.e. on a reload,
  // and the next snapshot re-adopts it then.
  if (d.grid && !gridMatches(deck.beatgrid, d.grid)) {
    const g = decodeGrid(d.grid);
    if (g) {
      deck.beatgrid = g;
      wrote.push("grid");
    }
  }
  return wrote;
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
  // Padded to the deck's slot count: a snapshot from before the second cue bank carries only 8.
  const slots = deck.hotCues.length;
  deck.hotCues = padSlots([...s.hotCues], slots);
  deck.hotLoops = padSlots((s.hotLoops ?? []).map((l) => (l ? { ...l } : null)), slots);
  deck.loop = s.loop ? { ...s.loop } : null;
  deck.loopInPoint = s.loopInPoint;
  applyDeckStems(deck, s);
  deck.seek(s.position);
  // Resume playback if it was playing — actual sound waits for the first gesture
  // (autoplay policy), but the deck comes back in the playing state + position.
  if (s.playing) deck.play();
}
