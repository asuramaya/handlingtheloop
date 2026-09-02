// useMidiRouting — the onMidiEvent dispatcher lifted out of App.tsx so a MIDI/control-surface
// agent owns this file instead of contending on App. PURE RELOCATION: the body is verbatim from
// App (sed-extracted); the App spine arrives via `deps`, destructured to the original names so the
// closure + its useCallback dep array are unchanged. Consumed by useMidi + useGamepad in App.
import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { EQ_MIN_DB, EQ_MAX_DB, type Deck, type DeckId, type SmartFader } from "@htl";
import { useRoom } from "@htl/room";
import type { MidiEvent } from "@htl/midi";
import type { Settings } from "@htl/state";
import type { LibraryHandle } from "../components/LibraryPanel";
import { fxPadRelease, fxPadArg } from "../components/fxPads";
import { useSpine } from "./spine";
import { fxParamIntent } from "@htl/room/fxWire";

export interface MidiRoutingDeps {
  settings: Settings;
  room: ReturnType<typeof useRoom>;
  focused: DeckId;
  setFocused: Dispatch<SetStateAction<DeckId>>;
  setZoomFor: (id: DeckId, next: number) => void;
  midiShift: Record<DeckId, boolean>;
  focusShift: boolean;
  shiftLatched: boolean;
  shiftHeld: boolean;
  emitSeekTo: (id: DeckId, pos: number) => void;
  onJogStart: (id: DeckId) => void;
  onJogEnd: (id: DeckId) => void;
  emitJog: (id: DeckId, delta: number) => void;
  canDriveDeckRef: MutableRefObject<(id: DeckId) => boolean>;
  eqStemModeRef: MutableRefObject<boolean>;
  fxSelRef: MutableRefObject<Record<DeckId, number>>;
  handlersRef: MutableRefObject<Record<string, (deck: Deck, id: DeckId, s: boolean) => void>>;
  libRef: RefObject<LibraryHandle>;
  toggleLibrary: () => void;
  lockedRef: MutableRefObject<boolean>;
  micVolSetRef: MutableRefObject<((v: number) => void) | null>;
  xfaderEnabledRef: MutableRefObject<boolean>;
  knobPickup: MutableRefObject<Record<string, { caught: boolean; last: number }>>;
  samplerCtl: MutableRefObject<{ trigger: (i: number) => void; release: (i: number) => void } | null>;
  smartFader: SmartFader;
  setMidiShift: Dispatch<SetStateAction<Record<DeckId, boolean>>>;
  setFocusShift: Dispatch<SetStateAction<boolean>>;
  setCrossfade: Dispatch<SetStateAction<number>>;
  setSmartFaderArmed: Dispatch<SetStateAction<boolean>>;
  setCueMixSt: Dispatch<SetStateAction<number>>;
  setCueLevelSt: Dispatch<SetStateAction<number>>;
  setMasterVolSt: Dispatch<SetStateAction<number>>;
  jogVinyl: MutableRefObject<Record<DeckId, boolean>>;
  latest: { readonly current: { zoom: Record<DeckId, number> } };
}

export function useMidiRouting(deps: MidiRoutingDeps) {
  const { engine, refresh, emitRef } = useSpine();
  const {
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
    eqStemModeRef,
    fxSelRef,
    handlersRef,
    libRef,
    toggleLibrary,
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
  } = deps;

  // onMidiEvent-private accumulators (moved verbatim from App — used only by the dispatcher).
  const jogTouched = useRef<Record<DeckId, boolean>>({ A: false, B: false });
  const loopAdjAcc = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  const knobAcc = useRef<Record<string, number>>({});

  const onMidiEvent = useCallback(
    (ev: MidiEvent) => {
      if (lockedRef.current) return; // a watch-only participant can't drive the decks
      // A stepped-up listener may drive ONLY their own deck — block control aimed at the
      // other one (navigation/zoom stay free). A deck-less control event targets `focused`.
      const evNav = ev.type === "zoom" || ev.type === "focus" || ev.type === "browse" || ev.type === "selector" || ev.type === "library";
      if (!evNav && !canDriveDeckRef.current((ev as { deck?: DeckId }).deck ?? focused)) return;
      // Map a 0..1 knob to dB with a centre detent at 0 dB (DJ EQ convention).
      const eqDb = (v: number) => (v < 0.5 ? EQ_MIN_DB * (0.5 - v) * 2 : EQ_MAX_DB * (v - 0.5) * 2);
      // Stem-volume knob curve: bottom = 0%, CENTRE = 100% (unity), top = 150% (overdrive).
      const stemKnobGain = (v: number) => (v <= 0.5 ? v * 2 : 1 + (v - 0.5));
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
          // MOMENTARY shifted pad-modes: on key-up, ROLL snaps back on-beat (slip) and FX2 throws
          // its effect OFF — that on-while-held behaviour is exactly what distinguishes them from
          // LOOP / FX, which latch. Every other action ignores the release (it already acted on
          // press). Handle it BEFORE the pad-bank switch so a release never reflows the pad mode.
          if (ev.pressed === false) {
            const rel = /^hotcue(\d)$/.exec(ev.action);
            if (rel) {
              const i = Number(rel[1]) - 1;
              if (deck.padMode === "roll") {
                deck.rollOut();
                emitRef.current({ kind: "loop", deck: id, action: "exit" });
                refresh();
              } else if (deck.padMode === "fx" || deck.padMode === "fx2") {
                // ★ PARITY. A controller pad releases through the SAME gesture the finger and the
                // key use — quick release latches, held release lets go — instead of fx2 being the
                // only surface that could hold. The press half already shares it: MIDI routes
                // hotcueN through the same HANDLERS entry the keyboard does.
                if (fxPadRelease(deck, id, i)) emitRef.current({ kind: "board", deck: id, id: "fxPad", phase: "up", arg: fxPadArg(deck, i) });
                refresh();
              }
            }
            break;
          }
          // Effective shift. A DECK-ADDRESSED hardware button (FLX, ev.deck set) uses ONLY its
          // own shift (its SHIFT byte or that deck's latch) — never the focus-model/keyboard
          // shift. Otherwise a latched/held shift would silently turn the FOCUSED deck's ▶ into
          // move-loop, so "jog forward" died intermittently on whichever deck had focus (deck B).
          // The focus-model shift (focusShift/latch/keyboard) only applies to a DECKLESS board.
          const sh = ev.shift || midiShift[id] || (ev.deck == null && (focusShift || shiftLatched || shiftHeld));
          // Hardware pad bank → HTL pad mode. The FLX emits a distinct note block per base bank, so a
          // pad press tells us which bank the player is physically in; switch the deck to match BEFORE
          // routing — otherwise every bank stays stuck on whatever software mode was set (all CUE). We
          // only switch when the FAMILY differs, so an active shifted peer (ROLL/FX2/GLBL, set from the
          // shifted bank button) survives a plain pad hit in the same family.
          if (ev.padBank) {
            const family = deck.padMode === "fx2" ? "fx" : deck.padMode === "roll" ? "loop" : deck.padMode === "global" ? "sampler" : deck.padMode;
            if (family !== ev.padBank) {
              deck.setPadMode(ev.padBank);
              emitRef.current({ kind: "board", deck: id, id: "padMode", arg: ev.padBank });
            }
          }
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
            const x = (ev.value - 0.5) * 2;
            // Smart Fader armed → the fader scrubs the auto-transition (tempo morph + bass swap);
            // it drives engine.setCrossfade itself + manipulates both decks, so don't double-apply.
            // Gate on the live instance flag (always current), not the React-mirror ref.
            if (smartFader.isArmed) {
              smartFader.onCrossfade(x);
              setCrossfade(x);
              if (!smartFader.isArmed) setSmartFaderArmed(false); // throw completed → stood down
              if (room.controlling) room.sendIntent({ kind: "crossfade", value: x });
              refresh();
              break;
            }
            if (!xfaderEnabledRef.current) break; // SMART FADER (shift) disabled → ignore the crossfader
            setCrossfade(x);
            engine.setCrossfade(x);
            if (room.controlling) room.sendIntent({ kind: "crossfade", value: x });
            break;
          }
          // Global headphone / mic knobs (no deck): the FLX 🎧 MIX + 🎧 LEVEL + a mappable mic level.
          if (ev.target === "fxWetDry") {
            // BEAT FX LEVEL/DEPTH → the focused deck's SELECTED effect wet/dry ("mix"). Mirror
            // the on-screen knob exactly: set + broadcast the param + refresh so the MIX cell
            // (which reads the live param) actually moves. (No-op if the EQ tab is selected.)
            const fid = ev.deck ?? focused;
            const slot = fxSelRef.current[fid];
            engine.deck(fid).setFxParam(slot, "mix", ev.value);
            emitRef.current(fxParamIntent(engine.deck(fid), fid, slot, "mix", ev.value));
            refresh();
            break;
          }
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
          if (ev.target === "master") {
            engine.setMasterVolume(ev.value);
            setMasterVolSt(ev.value); // keep the SMART buttonoid's ring/value in step with the knob
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
            // In stem mode (SMART CFX) the column of knobs rides stem volumes instead of EQ/filter,
            // going DOWN the line: HI→drums, MID→bass, LOW→vocals, CFX/filter→other — but ONLY when
            // this deck has separated stems; without them, fall THROUGH to EQ/filter so the knob is
            // never dead. Stem curve: bottom 0% · centre 100% (unity) · top 150% (overdrive).
            case "eqHi":
              if (eqStemModeRef.current && deck.stemControlsReady) { deck.setStemGain("drums", stemKnobGain(ev.value)); refresh(); break; }
              deck.setEqHigh(eqDb(ev.value));
              ctl({ kind: "control", deck: id, param: "eqHigh", value: deck.eqHigh });
              break;
            case "eqMid":
              if (eqStemModeRef.current && deck.stemControlsReady) { deck.setStemGain("bass", stemKnobGain(ev.value)); refresh(); break; }
              deck.setEqMid(eqDb(ev.value));
              ctl({ kind: "control", deck: id, param: "eqMid", value: deck.eqMid });
              break;
            case "eqLow":
              if (eqStemModeRef.current && deck.stemControlsReady) { deck.setStemGain("vocals", stemKnobGain(ev.value)); refresh(); break; }
              deck.setEqLow(eqDb(ev.value));
              ctl({ kind: "control", deck: id, param: "eqLow", value: deck.eqLow });
              break;
            case "filter":
              // The CFX/filter knob is the 4th stem (other) in stem mode; otherwise the colour filter
              // (always live now — its old on/off master is gone, so the knob can't be stuck off).
              if (eqStemModeRef.current && deck.stemControlsReady) { deck.setStemGain("other", stemKnobGain(ev.value)); refresh(); break; }
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
              deck.setStemGain(stem, stemKnobGain(ev.value)); // bottom 0% · centre 100% · top 150%
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
            if (jogTouched.current[ev.deck]) {
              // Finger down: a scratch turn drives the platter. (Re-)grab whenever we're NOT
              // already in an active grab — even mid-COAST or mid-MOTOR ramp — so the scratch
              // INTERRUPTS the platter's own motion. Gating on `scrubbing` (true through coast/
              // motor) instead skipped the re-grab AND `scrubMove` (grab-only) swallowed the
              // input, so the platter kept coasting and the jog "did nothing" — the freeze bug.
              if (!deck.grabbing) {
                deck.scrubBegin();
                onJogStart(ev.deck);
              }
              deck.scrubMove(sec);
              emitJog(ev.deck, sec);
            } else {
              deck.bend(sec); // no touch registered → fall back to a bend
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
        case "library":
          // Gamepad Guide button → open / close the library dock (which flips the pad into
          // crate-dig mode: the pad reads the live libOpen state to reroute its inputs).
          toggleLibrary();
          break;
        case "load":
          // LOAD A / LOAD B → load the cursor row onto that deck (canDriveDeck already gated
          // this above, so a session passenger can't load over a deck they don't control).
          libRef.current?.load(ev.deck);
          break;
      }
    },
    [engine, refresh, settings.tempoRange, settings.pitchRange, settings.jogSensitivity, emitSeekTo, onJogStart, onJogEnd, emitJog, room, focused, midiShift, focusShift, shiftLatched, shiftHeld, setZoomFor, toggleLibrary],
  );

  return { onMidiEvent };
}
