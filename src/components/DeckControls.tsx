import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useEmit, useRefresh } from "../App/spine";
import type { Deck, PadMode } from "@htl/audio";
import { HOT_CUE_COUNT, PAD_MODE_SHIFT, PAD_MODE_RESERVED } from "@htl/audio";
import { deckPadBase, GLOBAL_COUNT, type SamplerApi, type SamplerPad } from "./useSampler";
import { padsForDeck, fxPadArg } from "./fxPads";
import type { StemName } from "@htl/stems";
import { nextSkip, skipLabel, skipTitle, TEMPO_RANGES, PITCH_RANGES } from "@htl/state";
import { ValueCell } from "./ValueCell";
import { useLongPress } from "./useLongPress";
import { FxStrip, type FxStripCtl } from "./FxStrip";
import { LevelFader } from "./LevelFader";

// Per-stem cells (under the PITCH foot). Each is a level knob AND the mute toggle:
// tap = mute / unmute, scroll/drag = level. `kbd` is the global keyboard hint.
const STEM_CELLS: { name: StemName; label: string; kbd: string }[] = [
  { name: "drums", label: "DRUM", kbd: "V" },
  { name: "bass", label: "BASS", kbd: "B" },
  { name: "vocals", label: "VOICE", kbd: "N" },
  { name: "other", label: "INST", kbd: "M" },
];

interface DeckControlsProps {
  id: "A" | "B";
  deck: Deck;
  accent: string;
  otherDeck: Deck; // the other deck (for the EQ clash view + copy-to)
  otherAccent: string;
  focused: boolean;
  onFocus: () => void;
  expanded: boolean; // this deck is solo'd (its lane is expanded) → controls go full-width
  collapsed: boolean; // the OTHER deck is solo'd → this deck's controls hide
  mirror: boolean;
  shift: boolean;
  stemPending: boolean; // this deck's stems are still loading (downloading/separating)
  stemPendingPct?: number | null; // load progress 0–100 for the placeholder label
  otherStemPending: boolean; // the OTHER deck's stems are loading (so reserve the row to stay aligned)
  tempoRange: number;
  pitchRange: number;
  levelGainDb: number; // post-crossfade attenuation for this deck's level meter
  onCycleTempoRange: () => void;
  onCyclePitchRange: () => void;
  onToggleShift: () => void;
  onSync: () => void;
  onKey: () => void;
  cueFader?: boolean; // a separate cue device is selected → CUE becomes a headphone-level fader
  locked?: boolean; // a watch-only / off-seat deck: the whole bank is non-interactive (control blocked)
  emitControls: (id: "A" | "B") => void; // re-broadcast a deck's whole control state (after SYNC / RESET)
  sampler?: SamplerApi; // shared sampler — this deck's 8 region pads fill the SAMPLER pad-mode
  onFxSelect?: (id: "A" | "B", i: number) => void; // surface this deck's selected FX index (for gamepad bypass)
  fxCtlRef?: MutableRefObject<FxStripCtl | null>; // hardware (FLX BEAT FX) drives this strip's selection/add-mode
}

// The 8 beat-loop sizes, sorted ascending, in a 4×2 grid that mirrors the hot-cue
// pads. Each has its own key, left→right top→bottom: U I O P / H J K L.
const LOOP_SIZES: { n: number; label: string; kbd: string }[] = [
  { n: 0.0625, label: "1/16", kbd: "U" },
  { n: 0.125, label: "1/8", kbd: "I" },
  { n: 0.25, label: "1/4", kbd: "O" },
  { n: 0.5, label: "1/2", kbd: "P" },
  { n: 1, label: "1", kbd: "H" },
  { n: 2, label: "2", kbd: "J" },
  { n: 4, label: "4", kbd: "K" },
  { n: 8, label: "8", kbd: "L" },
];

// The four mode buttons + their SHIFT-layer labels (peer mode in PAD_MODE_SHIFT). U·I·O·P.
// SMP = the deck's LOCAL sample pads (slices of this track); its shift peer GLBL = the account's
// GLOBAL sample bank (uploaded one-shots).
const PAD_MODE_BTNS: { base: PadMode; label: string; shiftLabel: string; kbd: string }[] = [
  { base: "cue", label: "CUE", shiftLabel: "", kbd: "U" }, // no shift peer (KEY retired)
  { base: "fx", label: "FX", shiftLabel: "FX2", kbd: "I" },
  { base: "loop", label: "LOOP", shiftLabel: "ROLL", kbd: "O" },
  { base: "sampler", label: "SMP", shiftLabel: "GLBL", kbd: "P" },
];

// One deck's performance controls: jog / loop section, hot-cue pads, then the
// SYNC·KEY·FX·dB rack over the CUE·PLAY·SHIFT foot. A SHIFT modifier (also the
// keyboard Shift key) remaps:
//   • jog ◀◀ ◀ ▶ ▶▶ → MOVE the active loop (grid-locked) instead of jumping
//   • ⌗ → a skip-size selector (1/16 beat … 8 bars) instead of the grid magnet
//   • a pad → save the active loop to that pad (empty) / clear it (set)
// `mirror` flips deck B so the two banks are symmetric around the center mixer.
export function DeckControls({ id, deck, accent, otherDeck, otherAccent, focused, onFocus, expanded, collapsed, mirror, shift, stemPending, stemPendingPct, otherStemPending, tempoRange, pitchRange, levelGainDb, onCycleTempoRange, onCyclePitchRange, onToggleShift, onSync, onKey, cueFader, locked, emitControls, sampler, onFxSelect, fxCtlRef }: DeckControlsProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  // Beat size currently rolling (Shift-held loop pad), or null. A roll engages a
  // beat-loop on press and snaps back on-beat on release (deck.rollOut).
  const rolling = useRef<number | null>(null);
  const endRoll = () => {
    if (rolling.current == null) return;
    rolling.current = null;
    deck.rollOut();
    emit({ kind: "loop", deck: id, action: "exit" });
    refresh();
  };
  // Hot-cue HOLD: pressing a set hot cue and holding (past TAP_MS) previews from it (plays
  // from the cue, slip-aware return on release); a quick tap is the normal jump. The timer
  // arms the hold; `padSuppress` swallows the trailing click so a hold doesn't also jump.
  const HOLD_MS = 220;
  const padHold = useRef<{ held: boolean; tmr: number } | null>(null);
  const padSuppress = useRef(false);
  const endPadHold = () => {
    const rec = padHold.current;
    padHold.current = null;
    if (!rec) return;
    clearTimeout(rec.tmr);
    if (rec.held) {
      deck.previewRelease(); // slip → snap to shadow; else return to where we were
      padSuppress.current = true; // a hold consumed the gesture — don't also jump on click
      refresh();
    }
    // a quick tap (timer never fired) falls through to onClick = the normal jump
  };
  // Performance-pad mode lives on the DECK (so the keymap/MIDI route 1-8 by it); this is
  // just the UI mirror + persistence. Restore the saved mode onto the deck once on mount.
  const PAD_MODE_KEY = `htl:padMode:${id}`;
  const padRestored = useRef(false);
  if (!padRestored.current) {
    padRestored.current = true;
    const saved = localStorage.getItem(PAD_MODE_KEY);
    if (saved === "loop" || saved === "cue" || saved === "sampler" || saved === "fx" || saved === "roll" || saved === "global") deck.setPadMode(saved);
  }
  // True when the deck is parked in a SHIFTED-layer mode (ROLL/GLOBAL/…) — used to persistently tint
  // the bank so it's obvious you're on the second layer even after releasing shift.
  const inShiftedMode = deck.padMode === "roll" || deck.padMode === "global" || deck.padMode === "fx2";
  const changePadMode = (m: PadMode) => {
    deck.setPadMode(m);
    try {
      localStorage.setItem(PAD_MODE_KEY, m);
    } catch {
      /* ignore */
    }
    emit({ kind: "board", deck: id, id: "padMode", arg: m }); // sync + record the bank switch
    refresh();
  };
  // SMP pad-mode: this deck's 8 LOCAL region pads (a slice of the shared sampler bank).
  const smpBase = deckPadBase(id);
  const smpPads: SamplerPad[] = sampler ? sampler.pads.slice(smpBase, smpBase + 8) : [];
  // GLOBAL pad-mode (SMP-shift): the account's 8 GLOBAL one-shots (the bank that also lives on the
  // top strip). Triggered/assigned right here so the strip can shed them.
  const glbPads: SamplerPad[] = sampler ? sampler.pads.slice(0, GLOBAL_COUNT) : [];
  const [smpMenu, setSmpMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  const glbFileInput = useRef<HTMLInputElement>(null);
  const glbPickPad = useRef<number | null>(null);
  const openGlbPicker = (i: number) => { glbPickPad.current = i; glbFileInput.current?.click(); };
  const onGlbFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    const i = glbPickPad.current;
    e.target.value = "";
    if (f && i != null && sampler) void sampler.assignFile(i, f);
  };
  // Press a LOCAL sample pad: empty (track loaded) → grab a region; filled → trigger (gate =
  // hold, loop = toggle, one-shot = retrigger). Mirrors the global strip's pad behaviour.
  const smpDown = (pad: SamplerPad) => {
    if (!sampler) return;
    if (pad.kind === "empty") {
      if (pad.hasTrack && !shift) { sampler.assignRegion(pad.index); refresh(); }
      return;
    }
    if (shift) { sampler.clearPad(pad.index); refresh(); return; } // SHIFT on a filled pad = clear it
    if (pad.mode === "loop" || pad.mode === "bounce") pad.playing ? sampler.stop(pad.index) : sampler.trigger(pad.index);
    else sampler.trigger(pad.index);
    refresh();
  };
  const smpUp = (pad: SamplerPad) => {
    if (sampler && pad.mode === "gate") { sampler.release(pad.index); refresh(); }
  };
  // Touch long-press on a sample pad opens its config menu — the right-click equivalent, which was
  // desktop-only (so inaccessible on touch). Shared by SMP + GLBL; tap still triggers immediately.
  const smpLong = useLongPress<SamplerPad>((pad, x, y) => { if (pad.kind !== "empty") setSmpMenu({ i: pad.index, x, y }); });
  // Press a GLOBAL pad: empty → file picker; filled → trigger (SHIFT = clear). Same grammar as SMP.
  const glbDown = (pad: SamplerPad) => {
    if (!sampler) return;
    if (pad.kind === "empty") { openGlbPicker(pad.index); return; }
    if (shift) { sampler.clearPad(pad.index); refresh(); return; }
    if (pad.mode === "loop" || pad.mode === "bounce") pad.playing ? sampler.stop(pad.index) : sampler.trigger(pad.index);
    else sampler.trigger(pad.index);
    refresh();
  };
  // Right-click an FX pad = REVEAL its effect's control surface in the rack below (tweak / "mode
  // making"). No load — the device is already a live resident; this just selects its tab. CENS has
  // no backing device, so it has nothing to reveal. (Touch reveals via the rack tabs directly.)
  const fxReveal = (e: React.MouseEvent, slot: number) => {
    e.preventDefault();
    const kind = padsForDeck(deck)[slot]?.kind;
    if (kind) fxCtlRef?.current?.selectKind(kind);
  };
  // ★ ONE GESTURE. Down ENGAGES — always, immediately, so a performance control never waits to
  // find out what you meant. Up decides what it WAS: released quickly it stays LATCHED; held past
  // the threshold it lets go. That is Ableton Push's Repeat button, and it is the shape the mode
  // research argues for — a held throw is a quasimode you cannot forget you are in, while a latch
  // is a real mode and therefore owes visible state (the pad stays lit).
  const PAD_HOLD_MS = 220; // the one number the whole gesture rests on — tune by ear
  const padDownAt = useRef<{ slot: number; t: number } | null>(null);
  const fxPadDown = (e: React.PointerEvent, slot: number) => {
    if (e.button !== 0) return;
    const pad = padsForDeck(deck)[slot];
    if (!pad) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    padDownAt.current = { slot, t: performance.now() };
    if (!(pad.active?.(deck) ?? false)) {
      pad.on(deck);
      emit({ kind: "board", deck: id, id: "fxPad", phase: "down", arg: fxPadArg(deck, slot) });
    }
    // ★ PRESS IS REVEAL. You threw it, so it is what you are looking at — which also closes the
    // hole chains opened, where a pad could engage something that was not on screen.
    if (pad.kind) fxCtlRef?.current?.selectKind(pad.kind);
    refresh();
  };
  const fxPadUp = (slot: number) => {
    const rec = padDownAt.current;
    padDownAt.current = null;
    const pad = padsForDeck(deck)[slot];
    if (!pad) return;
    // Quick tap → leave it latched. Held → let it go, which is also how you un-latch: press a lit
    // pad, hold, and it drops on release.
    if (rec && rec.slot === slot && performance.now() - rec.t >= PAD_HOLD_MS) {
      pad.off?.(deck);
      emit({ kind: "board", deck: id, id: "fxPad", phase: "up", arg: fxPadArg(deck, slot) });
    }
    refresh();
  };
  // The FX bank scrolls now instead of crushing (cues-loops.css) — but a pad thrown from
  // OFF-SCREEN (keyboard 1-8, MIDI, a co-DJ's board mirror) gave no clue it fired. Scroll
  // whichever pad is actually engaged into view, same idea as FxStrip's tab auto-scroll —
  // source-agnostic since it reacts to the resulting STATE, not the trigger. A no-op via
  // the browser's own "nearest" logic when it's already visible.
  const fxBankRef = useRef<HTMLDivElement>(null);
  const activeFxIdx = padsForDeck(deck).findIndex((pad) => pad?.active?.(deck));
  useEffect(() => {
    if (deck.padMode !== "fx" && deck.padMode !== "fx2") return;
    if (activeFxIdx < 0) return;
    const el = fxBankRef.current?.children[activeFxIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeFxIdx, deck.padMode]);
  const act = (fn: () => void) => () => {
    fn();
    refresh();
  };
  // Broadcast the deck's current playhead as a seek (after a jump/cue) so co-DJs follow.
  const emitSeek = () => emit({ kind: "transport", deck: id, action: "seek", position: deck.position() });
  // Loop-boundary adjust mode (Shift-IN / Shift-OUT armed) takes priority: the jog
  // buttons step the armed edge — until the loop is exited. Otherwise Shift moves the
  // whole loop, and a plain press jumps the playhead — both by the deck's skip.
  const jog = (beats: number) =>
    act(() => {
      if (deck.adjusting) deck.adjustStep(beats);
      else if (shift) deck.moveLoop(beats);
      else {
        deck.beatJump(beats);
        emitSeek();
      }
    });
  // CUE-point action (set / jump-to-cue / START-on-shift). Shared by the plain CUE
  // button and — when a separate cue device is selected — the CUE fader's tap.
  const cueAction = () => {
    if (shift) {
      deck.seek(0);
      emit({ kind: "transport", deck: id, action: "seek", position: 0 });
    } else if (deck.playing) {
      deck.jumpToCue();
      emitSeek();
    } else {
      deck.setCue();
      emit({ kind: "cue", deck: id, position: deck.cuePoint });
    }
  };
  // CUE button HOLD = momentary preview from the cue point (CDJ "cue play"): paused + held
  // past HOLD_MS plays from the cue while down; release snaps back (slip-aware previewRelease,
  // the same primitive as the hot-cue hold). A quick tap stays the normal cueAction. Only
  // arms when paused & un-shifted — holding while playing, or with Shift, is just a tap.
  const cueHold = useRef<{ held: boolean; tmr: number } | null>(null);
  const cueSuppress = useRef(false);
  const cueDown = () => {
    if (shift || deck.playing) return; // tap-only path (START / jump-to-cue) resolves on click
    const rec = { held: false, tmr: 0 };
    rec.tmr = window.setTimeout(() => {
      rec.held = true;
      deck.previewHold(deck.cuePoint); // play from the cue while held
      refresh();
    }, HOLD_MS);
    cueHold.current = rec;
  };
  const cueEndHold = () => {
    const rec = cueHold.current;
    cueHold.current = null;
    if (!rec) return;
    clearTimeout(rec.tmr);
    if (rec.held) {
      deck.previewRelease(); // slip-aware return to the cue point
      cueSuppress.current = true; // the hold owned it — don't also set/jump on the trailing click
      refresh();
    }
  };
  const cueClick = () => {
    if (cueSuppress.current) { cueSuppress.current = false; return; }
    cueAction(); // quick tap (or the play/shift tap-only path)
    refresh();
  };

  return (
    <div className={`bank ${mirror ? "mirror" : ""} ${shift ? "shifted" : ""} ${inShiftedMode ? "in-shifted-mode" : ""} ${deck.adjusting ? "adjusting" : ""} ${focused ? "focused" : ""} ${expanded ? "expanded" : ""} ${collapsed ? "collapsed" : ""} ${locked ? "locked" : ""}`} data-deck={id} style={{ ["--accent" as string]: accent }} onPointerDownCapture={onFocus}>
      <div className="bank-main">
        {/* Beat-jump / loop-move row (SHIFT remaps it to move the loop; the ⌗ in
            the middle is the grid magnet, or the skip selector under SHIFT). */}
        <div className="jog">
          <button className="jog-btn" title={deck.adjusting ? `Nudge ${deck.adjusting} marker back` : shift ? "Move loop back" : "Jump back"} onClick={jog(-deck.skipBeats)}>◀◀<span className="kbd">↓</span></button>
          <button className="jog-btn" title={deck.adjusting ? `Nudge ${deck.adjusting} marker back a beat` : shift ? "Move loop back a beat" : "Back a beat"} onClick={jog(-1)}>◀<span className="kbd">←</span></button>
          {shift ? (
            <button
              className="jog-btn mag skip"
              title={skipTitle(deck.skipBeats)}
              onClick={act(() => {
                deck.skipBeats = nextSkip(deck.skipBeats);
                emit({ kind: "skip", deck: id, beats: deck.skipBeats });
              })}
            >
              {skipLabel(deck.skipBeats)}
              <span className="kbd">G</span>
            </button>
          ) : (
            <button
              className={`jog-btn mag ${deck.quantizing ? "on" : ""}`}
              title="Snap to grid"
              onClick={act(() => {
                deck.setQuantize(!deck.quantizing);
                emit({ kind: "toggle", deck: id, param: "quantize", value: deck.quantizing });
              })}
            >
              ⌗<span className="kbd">G</span>
            </button>
          )}
          <button className="jog-btn" title={deck.adjusting ? `Nudge ${deck.adjusting} marker forward a beat` : shift ? "Move loop forward a beat" : "Forward a beat"} onClick={jog(1)}>▶<span className="kbd">→</span></button>
          <button className="jog-btn" title={deck.adjusting ? `Nudge ${deck.adjusting} marker forward` : shift ? "Move loop forward" : "Jump forward"} onClick={jog(deck.skipBeats)}>▶▶<span className="kbd">↑</span></button>
        </div>

        {/* SLIP moved to a Controls setting (it's a scrub behaviour); BRAKE is the Vinyl
            Speed pause brake; REV/CENSOR stay engine-only (reuse: sampler bounce, FX). */}

        {/* Manual loop strip — ALWAYS visible (IN / OUT / EXIT), constant across pad modes. */}
        <div className="loops">
          {/* IN / OUT drop the loop boundaries; SHIFT-IN / SHIFT-OUT instead arm a
              fine-adjust mode where the waveform (drag / scroll) and arrow keys nudge
              that boundary. RELOOP/EXIT toggles the loop; SHIFT clears it outright. */}
          <button
            className={`loop-btn ${deck.loopInPoint != null ? "armed" : ""} ${deck.adjusting === "in" ? "adjust" : ""}`}
            title={deck.adjusting === "in" ? "Tap to exit loop-in adjust" : shift ? "Adjust loop-in — drag / scroll / arrow-key (snaps to grid when ⌗ is on)" : "Loop in"}
            onClick={(e) => {
              // Already armed → a plain tap disarms (no need to re-hold Shift to release).
              if (shift || e.shiftKey || deck.adjusting === "in") deck.toggleAdjust("in");
              else { deck.loopIn(); emit({ kind: "loop", deck: id, action: "in" }); }
              refresh();
            }}
          >
            IN<span className="kbd">Q</span>
          </button>
          <button
            className={`loop-btn ${deck.adjusting === "out" ? "adjust" : ""}`}
            title={deck.adjusting === "out" ? "Tap to exit loop-out adjust" : shift ? "Adjust loop-out — drag / scroll / arrow-key (snaps to grid when ⌗ is on)" : "Loop out"}
            onClick={(e) => {
              // Already armed → a plain tap disarms (no need to re-hold Shift to release).
              if (shift || e.shiftKey || deck.adjusting === "out") deck.toggleAdjust("out");
              else { deck.loopOut(); emit({ kind: "loop", deck: id, action: "out" }); }
              refresh();
            }}
          >
            OUT<span className="kbd">W</span>
          </button>
          <button
            className={`loop-btn ${deck.loop?.active ? "on" : ""}`}
            disabled={!deck.loop}
            title={shift ? "Clear the loop" : deck.loop && !deck.loop.active ? "Reloop" : "Exit loop"}
            onClick={(e) => {
              if (shift || e.shiftKey) {
                deck.clearLoop();
                emit({ kind: "loop", deck: id, action: "exit" });
              } else if (deck.loop?.active) {
                deck.exitLoop();
                emit({ kind: "loop", deck: id, action: "exit" });
              } else {
                deck.reloop();
                emit({ kind: "loop", deck: id, action: "reloop" });
              }
              refresh();
            }}
          >
            {shift ? "CLEAR" : deck.loop && !deck.loop.active ? "RELOOP" : "EXIT"}
            <span className="kbd">E</span>
          </button>
        </div>

        {/* Pad bank: a CUE / LOOP mode selector swaps ONLY these 8 pads — hot cues, or the
            beat-loop sizes (folds the old separate loop-size row in). */}
        {/* Order mirrors the FLX4's physical bank buttons left-to-right: CUE · FX · LOOP · SMP
            (HOT CUE / PAD FX1 / BEAT JUMP / SAMPLER); U·I·O·P read across in the same order. */}
        {/* Hold SHIFT and the four mode buttons reveal their shifted peers (LOOP→ROLL, SMP→SONG;
            CUE/FX peers reserved) — more modes without overloading the pads. */}
        <div className={`pad-mode ${shift ? "shifted" : ""}`}>
          {PAD_MODE_BTNS.map(({ base, label, shiftLabel, kbd }) => {
            if (base === "sampler" && !sampler) return null;
            const peer = PAD_MODE_SHIFT[base];
            const hasPeer = peer !== base; // cue maps to itself = no shift peer (blank slot)
            const activeIsPeer = hasPeer && deck.padMode === peer; // currently IN the shifted mode (e.g. ROLL)
            const activeIsBase = deck.padMode === base;
            // Show the shifted label when you're IN the peer mode (persists after releasing shift —
            // so the button never lies about which layer you're in) OR while previewing via shift.
            const showPeer = hasPeer && (activeIsPeer || shift);
            // Click target: a PLAIN click always lands on the base (so it RETURNS from the peer, e.g.
            // FX2→FX); only shift goes to the peer. (`showPeer` drives the label/highlight, NOT this —
            // using it here trapped you in the peer, since showPeer stays true while you're in it.)
            const eff = shift && hasPeer ? peer : base;
            const reserved = showPeer && PAD_MODE_RESERVED.has(peer); // a labelled-but-unwired peer
            const lbl = showPeer ? shiftLabel : label;
            const on = showPeer ? activeIsPeer : activeIsBase; // highlight tracks the ACTUAL active mode
            return (
              <button
                key={base}
                disabled={reserved}
                className={`${on ? "on" : ""} ${showPeer ? "alt" : ""} ${reserved ? "reserved" : ""}`}
                title={reserved ? `${shiftLabel} — coming soon` : activeIsPeer ? `In ${shiftLabel} (shifted) mode` : undefined}
                onClick={() => { if (!reserved) changePadMode(eff); }}
              >
                {lbl}<span className="kbd">{kbd}</span>
              </button>
            );
          })}
        </div>

        {(deck.padMode === "loop" || deck.padMode === "roll") && (
        <div className={`loop-sizes ${deck.padMode === "roll" ? "roll-mode" : ""}`}>
          {LOOP_SIZES.map((s, i) => {
            const active = deck.loop?.active && deck.loop.beats === s.n;
            return (
              <button
                key={s.n}
                className={`loop-btn ${active || rolling.current === s.n ? "on" : ""}`}
                title={deck.padMode === "roll" ? `Loop roll ${s.label} — hold` : `Beat loop ${s.label}`}
                onPointerDown={(e) => {
                  // Rolling lives ONLY in ROLL mode now (no more shift-hold-roll in LOOP — that
                  // fought the LOOP→ROLL mode switch). Press engages the loop, release snaps back.
                  if (deck.padMode !== "roll") return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  rolling.current = s.n;
                  deck.setBeatLoop(s.n);
                  emit({ kind: "loop", deck: id, action: "beat", beats: s.n });
                  refresh();
                }}
                onPointerUp={endRoll}
                onPointerCancel={endRoll}
                onClick={(e) => {
                  if (deck.padMode === "roll") return; // ROLL handled by the pointer events above
                  if (shift || e.shiftKey) return; // LOOP-mode pad+shift is freed (was roll) — no-op
                  // Re-clicking the ACTIVE size exits; a different size resizes; else set.
                  if (active) {
                    deck.exitLoop();
                    emit({ kind: "loop", deck: id, action: "exit" });
                  } else {
                    deck.setBeatLoop(s.n);
                    emit({ kind: "loop", deck: id, action: "beat", beats: s.n });
                  }
                  refresh();
                }}
              >
                {s.label}
                <span className="kbd">{i + 1}</span>
              </button>
            );
          })}
        </div>
        )}

        {deck.padMode === "cue" && (
        <div className="hotcues">
          {Array.from({ length: HOT_CUE_COUNT }, (_, i) => {
            const set = deck.slotIsSet(i);
            const isLoop = deck.hotLoops[i] != null;
            return (
              <button
                key={i}
                className={`pad ${set ? "set" : ""} ${isLoop ? "loop" : ""}`}
                data-cue={i + 1}
                title={shift ? "Clear cue" : isLoop ? "Recall loop" : "Hot cue — tap to jump, hold to preview"}
                onPointerDown={(e) => {
                  // Set hot-cue (not a loop, no shift): hold = momentary roll/preview.
                  if (shift || e.shiftKey || !set || isLoop) return;
                  const cuePos = deck.hotCues[i];
                  if (cuePos == null) return;
                  const rec = { held: false, tmr: 0 };
                  rec.tmr = window.setTimeout(() => {
                    rec.held = true;
                    deck.previewHold(cuePos); // play from the cue while held
                    refresh();
                  }, HOLD_MS);
                  padHold.current = rec;
                }}
                onPointerUp={endPadHold}
                onPointerLeave={endPadHold}
                onClick={(e) => {
                  if (padSuppress.current) { padSuppress.current = false; return; } // a hold already handled it
                  const shiftNow = shift || e.shiftKey;
                  if (shiftNow) {
                    // SHIFT on a cue pad = clear, ALWAYS (the old shift=save-loop was the vestigial
                    // hotLoops path — a saved region is a SONG sample now, not a cue-pad loop).
                    deck.clearHotCue(i);
                    emit({ kind: "hotcue", deck: id, slot: i, action: "clear" });
                  } else {
                    deck.hotCue(i);
                    emit({ kind: "hotcue", deck: id, slot: i, action: "press" });
                  }
                  refresh();
                }}
              >
                {shift && set ? <span className="pad-clr">CLR</span> : isLoop ? "↻" : i + 1}
              </button>
            );
          })}
        </div>
        )}

        {/* SMP — the deck's LOCAL sample pads: 8 slices you grabbed from THIS track, routed through
            its channel. Empty = ＋ (slice the active loop / 4 bars); filled = tap to play. */}
        {deck.padMode === "sampler" && sampler && (
        <div className="hotcues smp-bank">
          {smpPads.map((pad, i) => (
            <button
              key={pad.index}
              className={`pad smp ${pad.kind === "empty" ? "" : "set"} ${pad.playing ? "playing" : ""} ${pad.stems ? "stemmed" : ""}`}
              data-cue={i + 1}
              disabled={pad.kind === "empty" && !pad.hasTrack}
              title={
                pad.kind === "empty"
                  ? pad.hasTrack ? `Slice a region from deck ${id}` : `Load a track on deck ${id} first`
                  : `${pad.name || "sample"} · ${pad.mode}${pad.stems ? ` · ${pad.stems.join("+")}` : ""} — tap to play · SHIFT = clear · right-click for options`
              }
              onPointerDown={(e) => { if (e.button === 0) smpDown(pad); }}
              onPointerUp={() => smpUp(pad)}
              onPointerLeave={() => smpUp(pad)}
              {...smpLong.bind(pad)}
              onContextMenu={(e) => { e.preventDefault(); if (pad.kind !== "empty") setSmpMenu({ i: pad.index, x: e.clientX, y: e.clientY }); }}
            >
              {shift && pad.kind !== "empty" ? <span className="pad-clr">CLR</span> : pad.kind === "empty" ? (pad.hasTrack ? "+" : "—") : pad.name || i + 1}
              {!shift && pad.stems && <span className="pad-stem" aria-hidden="true">{pad.stems.map((s) => s[0].toUpperCase()).join("")}</span>}
              <span className="kbd">{i + 1}</span>
            </button>
          ))}
        </div>
        )}

        {/* GLOBAL (SMP-shift) — the account's 8 GLOBAL one-shots (master-routed, uploaded clips).
            The same bank as the top strip; here so the strip can become controls-only. Empty = ＋
            (file picker); filled = tap to play · SHIFT = clear · right-click for options. */}
        {deck.padMode === "global" && sampler && (
        <div className="hotcues smp-bank glb-bank">
          <input ref={glbFileInput} type="file" accept="audio/*" hidden onChange={onGlbFile} />
          {glbPads.map((pad, i) => (
            <button
              key={pad.index}
              className={`pad smp glb ${pad.kind === "empty" ? "" : "set"} ${pad.playing ? "playing" : ""} ${pad.uploading ? "uploading" : ""}`}
              data-cue={i + 1}
              title={
                pad.kind === "empty"
                  ? "Load an audio file into this global pad"
                  : `${pad.name || "sample"} · ${pad.mode} — tap to play · SHIFT = clear · right-click for options`
              }
              onPointerDown={(e) => { if (e.button === 0) glbDown(pad); }}
              onPointerUp={() => smpUp(pad)}
              onPointerLeave={() => smpUp(pad)}
              {...smpLong.bind(pad)}
              onContextMenu={(e) => { e.preventDefault(); if (pad.kind !== "empty") setSmpMenu({ i: pad.index, x: e.clientX, y: e.clientY }); }}
            >
              {shift && pad.kind !== "empty" ? <span className="pad-clr">CLR</span> : pad.kind === "empty" ? "＋" : pad.name || i + 1}
              <span className="kbd">{i + 1}</span>
            </button>
          ))}
        </div>
        )}

        {/* FX pad-mode: 8 fixed performance effects (Throws + Motion). All 8 are ALWAYS armed —
            every backing effect is a permanent dormant resident of the rack. Tap = throw (hold-FX
            glow while held); right-click = reveal that effect's panel below to dial it in. */}
        {deck.padMode === "fx" && (
        <div className="hotcues fx-bank" ref={fxBankRef}>
          {padsForDeck(deck).map((pad, i) => (
            <button
              key={pad?.label ?? `empty${i}`}
              className={`pad fx ${pad ? "" : "empty"} ${pad?.active?.(deck) ? "playing latched" : ""}`}
              data-cue={i + 1}
              disabled={!pad}
              title={pad ? `${pad.label} — tap to latch, hold for momentary · ${pad.hint} · right-click to tweak` : "Empty slot — add an effect to this chain in the rack below"}
              onPointerDown={(e) => fxPadDown(e, i)}
              onPointerUp={() => fxPadUp(i)}
              onPointerCancel={() => fxPadUp(i)}
              onContextMenu={(e) => fxReveal(e, i)}
            >
              {pad?.label ?? "—"}
              <span className="kbd">{i + 1}</span>
            </button>
          ))}
        </div>
        )}

        {/* FX2 pad-mode (FX shifted): the MOMENTARY layer of the same 8 effects. Hold to throw the
            effect, release to drop it — a hands-on stab vs FX's set-and-forget latch. Lit = live
            while held. Right-click reveals the panel. */}
        {deck.padMode === "fx2" && (
        <div className="hotcues fx-bank fx2-bank" ref={fxBankRef}>
          {padsForDeck(deck).map((pad, i) => (
            <button
              key={pad?.label ?? `e${i}`}
              className={`pad fx fx2 ${pad ? "" : "empty"} ${pad?.active?.(deck) ? "playing" : ""}`}
              data-cue={i + 1}
              disabled={!pad}
              title={pad ? `${pad.label} — tap to latch, hold for momentary · ${pad.hint}` : "Empty slot"}
              onPointerDown={(e) => fxPadDown(e, i)}
              onPointerUp={() => fxPadUp(i)}
              onPointerCancel={() => fxPadUp(i)}
              onContextMenu={(e) => fxReveal(e, i)}
            >
              {pad?.label ?? "—"}
              <span className="kbd">{i + 1}</span>
            </button>
          ))}
        </div>
        )}

        {smpMenu && sampler && (
          <>
            <div className="ctx-backdrop" onClick={() => setSmpMenu(null)} onContextMenu={(e) => e.preventDefault()} />
            <div className="ctx-menu smp-menu" style={{ left: Math.min(smpMenu.x, window.innerWidth - 200), top: Math.min(smpMenu.y, window.innerHeight - 220) }}>
              <div className="ctx-label">Mode</div>
              <div className="smp-modes">
                {(["oneshot", "gate", "loop", "bounce"] as const).map((m) => (
                  <button key={m} className={sampler.pads[smpMenu.i].mode === m ? "active" : ""} onClick={() => { sampler.setMode(smpMenu.i, m); refresh(); }}>
                    {m === "oneshot" ? "1-shot" : m}
                  </button>
                ))}
              </div>
              <div className="ctx-label smp-lvl"><span>Level</span><span className="smp-lvl-val">{Math.round(sampler.pads[smpMenu.i].gain * 100)}%</span></div>
              <input className="smp-gain" type="range" min={0} max={1.5} step={0.05} value={sampler.pads[smpMenu.i].gain} onChange={(e) => { sampler.setGain(smpMenu.i, Number(e.target.value)); refresh(); }} />
              {/* Pitch: varispeed repitch in semitones (play one grab as any note). Dbl-click the row label to reset. */}
              <div className="ctx-label smp-lvl" onDoubleClick={() => { sampler.setPitch(smpMenu.i, 0); refresh(); }}><span>Pitch</span><span className="smp-lvl-val">{sampler.pads[smpMenu.i].pitch > 0 ? "+" : ""}{sampler.pads[smpMenu.i].pitch} st</span></div>
              <input className="smp-gain smp-pitch" type="range" min={-12} max={12} step={1} value={sampler.pads[smpMenu.i].pitch} onChange={(e) => { sampler.setPitch(smpMenu.i, Number(e.target.value)); refresh(); }} />
              {deck.hasStems && sampler.pads[smpMenu.i].route !== "master" && (
                <>
                  <div className="ctx-label">Stems</div>
                  {/* Multi-select: each stem toggles in/out of the chopped subset; "full" clears to the
                      mix. Derived from what was audible at grab, editable here. */}
                  <div className="smp-modes smp-stems">
                    {(() => {
                      const cur = sampler.pads[smpMenu.i].stems ?? [];
                      return (
                        <>
                          <button className={cur.length === 0 ? "active" : ""} onClick={() => { sampler.setStems(smpMenu.i, undefined); refresh(); }}>full</button>
                          {STEM_CELLS.map((s) => {
                            const on = cur.includes(s.name);
                            return (
                              <button
                                key={s.name}
                                className={on ? "active" : ""}
                                onClick={() => { sampler.setStems(smpMenu.i, on ? cur.filter((n) => n !== s.name) : [...cur, s.name]); refresh(); }}
                              >
                                {s.label.toLowerCase()}
                              </button>
                            );
                          })}
                        </>
                      );
                    })()}
                  </div>
                </>
              )}
              <div className="ctx-sep" />
              {/* Re-slice only makes sense for a LOCAL region pad; global pads carry an uploaded file. */}
              {sampler.pads[smpMenu.i].route !== "master" && (
                <button onClick={() => { sampler.assignRegion(smpMenu.i); setSmpMenu(null); refresh(); }}>↻ Re-slice from deck</button>
              )}
              <button className="ctx-danger" onClick={() => { sampler.clearPad(smpMenu.i); setSmpMenu(null); refresh(); }}>✕ Clear pad</button>
            </div>
          </>
        )}

        {/* The − / + nudge steppers and the ±range pill buttons that used to live here are both
            gone now — TEMPO/KEY are adjusted by drag/scroll/tap on the cells themselves below,
            and Minus/Equal still nudge a semitone/0.5% from the keyboard (pitchDown/pitchUp,
            unchanged — only the on-screen buttons went away, not the bindings). */}

        <div className="bank-load">
          {cueFader ? (
            /* A separate cue device is selected → CUE is a headphone-level "buttonoid"
               (like TRIM/TEMPO): TAP = the cue-point action (set / jump / START-on-shift,
               unchanged), DRAG / SCROLL = this deck's PFL level into the cue device.
               Double-tap kills the cue level. Local monitor only — never broadcast. */
            <ValueCell
              className={`cue cue-fader ${deck.cueLevel > 0 ? "cue-on" : ""}`}
              label={shift ? "START" : "CUE"}
              value={deck.cueLevel}
              min={0}
              max={1}
              step={0.02}
              reset={0}
              kbd="C"
              onTap={() => { cueAction(); refresh(); }}
              onChange={(v) => { deck.setCueLevel(v); refresh(); }}
              format={(v) => `${Math.round(v * 100)}`}
            />
          ) : (
            <button
              className="hw-btn cue"
              title={shift ? "Jump to start" : "Cue — tap to set/jump, hold to preview from the cue"}
              onPointerDown={cueDown}
              onPointerUp={cueEndHold}
              onPointerLeave={cueEndHold}
              onClick={cueClick}
            >
              {shift ? "START" : "CUE"}
              <span className="kbd">C</span>
            </button>
          )}
          {/* PLAY is a button-knob (like the stem cells): tap = play/pause (Shift =
              reset channel), scroll / drag = TRIM gain, shown as a percentage. Double-
              click resets trim to unity. The board's TRIM knob drives the same value. */}
          <ValueCell
            className={`play ${deck.playing ? "playing" : ""}`}
            label={shift ? "RESET" : "TRIM"}
            value={deck.trim}
            min={0}
            max={2}
            pivot={1}
            kbd="⎵"
            onTap={() => {
              if (shift) {
                deck.setTempo(0);
                deck.setFilter(0);
                deck.setTrim(1);
                deck.resetEq(); // gains → 0 dB and every band node back to its default frequency
                deck.setPitch(0);
                deck.setLevel(1); // volume back to centre (unity)
                deck.resetStems(); // also reset stem faders → unity and un-mute all stems
                emit({ kind: "control", deck: id, param: "level", value: 1 });
                emitControls(id);
              } else {
                deck.togglePlay();
                emit({ kind: "transport", deck: id, action: deck.playing ? "play" : "pause" });
              }
              refresh();
            }}
            onChange={(v) => { deck.setTrim(v); refresh(); emit({ kind: "control", deck: id, param: "trim", value: v }); }}
            format={(v) => `${Math.round(v * 100)}`}
          />
          <button
            className={`hw-btn shift ${shift ? "on" : ""}`}
            onClick={onToggleShift}
            title="SHIFT — hold the Shift key or latch this to remap the jog (move loop / skip size) and pads (save loop)"
          >
            SHIFT
            <span className="kbd">⇧</span>
          </button>
        </div>

        {/* TEMPO + KEY knobs, bracketed by KEY-match (left) and SYNC (right) — swapped from
            SYNC-left/KEY-right so the on-screen order reads A···S left-to-right, matching
            where those two keys actually sit on the keyboard (A left of S). */}
        <div className="pitch-row">
          <button
            className={`hw-btn key ${deck.keyRole !== "off" || deck.pitch !== 0 ? "on" : ""} ${deck.keyRole === "master" ? "master" : ""}`}
            title={
              deck.keyRole === "master"
                ? "KEY MASTER — the other deck matches this one's key (tap to follow it instead)"
                : deck.keyRole === "slave"
                  ? "Key-locked — harmonically matched to the other deck (tap to release)"
                  : "Key match — harmonically shift to be compatible with the other deck"
            }
            onClick={act(() => {
              onKey();
              emit({ kind: "control", deck: id, param: "pitch", value: deck.pitch });
            })}
          >
            {/* Very narrow phones (same 380px breakpoint the chin already uses to drop its
                label text): the full word doesn't fit next to TEMPO/KEY/SYNC any more —
                fall back to the bare initial rather than let it clip mid-word. Role state
                (master/slave/on) still reads from colour, so the letter alone is enough. */}
            <span className="btn-label-full">{deck.keyRole === "master" ? "KMST" : "KEY"}</span>
            <span className="btn-label-short">K</span>
            <span className="kbd">A</span>
          </button>
          <ValueCell
            label="TEMPO"
            value={deck.tempo}
            min={-tempoRange}
            max={tempoRange}
            step={0.05}
            pivot={0}
            onChange={(v) => { deck.setTempo(v); refresh(); emit({ kind: "control", deck: id, param: "tempo", value: v }); }}
            format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
            onTap={() => { onCycleTempoRange(); refresh(); }}
            kbd="F"
          >
            {/* Which of the 6 tempo-range tiers is active — a tap cycles it, this shows where
                you landed without needing digits (there's no room for "±50%" at mobile widths). */}
            <div className="range-ticks">
              {TEMPO_RANGES.map((r) => (
                <span key={r} className={`range-tick ${r === tempoRange ? "active" : ""}`} />
              ))}
            </div>
          </ValueCell>
          {/* Key lock: sits BETWEEN the two values it relates (not inside either one) — it's
              the relationship, not a property of TEMPO or KEY alone. A real bordered button
              (not a bare floating icon) with its own Z kbd hint — a dedicated key, not a ⇧F
              combo (that read as confusing: F already does something plain-pressed, and
              overloading its shift for a persistent toggle wasn't obvious). Shape/colour IS
              the state readout too: locked is quiet, unlocked swings the shackle open and
              picks up the board's shift-tint/glow language. */}
          <button
            className={`keylock-btn ${deck.keylock ? "locked" : "unlocked"}`}
            title={
              deck.keylock
                ? "Key lock ON — pitch holds steady as tempo changes. Tap to decouple (or Z)."
                : "Key lock OFF — pitch rides with tempo, vinyl-style. Tap to relock (or Z)."
            }
            onClick={() => {
              const on = !deck.keylock;
              deck.setKeylock(on);
              emit({ kind: "toggle", deck: id, param: "keylock", value: on });
              refresh();
            }}
          >
            <svg className="keylock-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <rect x="3" y="7" width="10" height="7" rx="1.5" />
              <path className="keylock-shackle" d="M5.5 7 V5.5 a2.5 2.5 0 0 1 5 0 V7" />
            </svg>
            <span className="kbd">Z</span>
          </button>
          <ValueCell
            label="KEY"
            value={deck.pitch}
            min={-pitchRange}
            max={pitchRange}
            step={1}
            pivot={0}
            // Tap/scroll still set the integer manual shift, but the READOUT shows the LIVE sounding
            // pitch (incl. the keylock-off Smart-Fader glide), so the cell isn't dead during a blend.
            className={Math.abs(deck.livePitchSemis - deck.pitch) > 0.05 ? "gliding" : ""}
            onChange={(v) => { deck.setPitch(Math.round(v)); refresh(); emit({ kind: "control", deck: id, param: "pitch", value: Math.round(v) }); }}
            format={() => {
              const live = deck.livePitchSemis;
              return Math.abs(live - deck.pitch) > 0.05
                ? `${live > 0 ? "+" : ""}${live.toFixed(1)}`
                : `${deck.pitch > 0 ? "+" : ""}${deck.pitch}`;
            }}
            onTap={() => { onCyclePitchRange(); refresh(); }}
            kbd="D"
          >
            <div className="range-ticks">
              {PITCH_RANGES.map((r) => (
                <span key={r} className={`range-tick ${r === pitchRange ? "active" : ""}`} />
              ))}
            </div>
          </ValueCell>
          <button
            className={`hw-btn sync ${deck.syncRole !== "off" ? "on" : ""} ${deck.syncRole === "master" ? "master" : ""}`}
            title={
              deck.syncRole === "master"
                ? "MASTER — the other deck follows this one (tap to follow it instead)"
                : deck.syncRole === "slave"
                  ? "Synced — following the other deck (tap to release)"
                  : "Beat sync — lock tempo + phase to the other deck"
            }
            onClick={act(() => {
              onSync();
              emitControls(id);
            })}
          >
            <span className="btn-label-full">{deck.syncRole === "master" ? "MASTER" : "SYNC"}</span>
            <span className="btn-label-short">{deck.syncRole === "master" ? "M" : "S"}</span>
            <span className="kbd">S</span>
          </button>
        </div>

        {/* STEMS foot: tap = mute / unmute, scroll/drag = level 0–150% (1 = unity).
            Dimmed when muted. HIDDEN entirely when the deck has no stems — mix-only
            mobile or the "Off" model — so the row doesn't sit there dead. It returns
            when stems exist locally (desktop split/neural) OR as a remote display in a
            session whose host streams its stem envelopes — but for a REMOTE deck only
            once those envelopes actually land (stemControlsReady), so the cells never sit
            above a single combined waveform while the host hasn't / can't stream them. */}
        {/* MOBILE stems are a global preference now (Settings ▸ Stems), not a per-deck button. */}
        {deck.stemControlsReady ? (
        <div className="stems-row">
          {STEM_CELLS.map((s) => (
            <ValueCell
              key={s.name}
              label={s.label}
              kbd={s.kbd}
              active={deck.stemActive(s.name)}
              value={deck.stemLevel(s.name)}
              min={0}
              max={1.5}
              reset={1}
              onTap={() => {
                if (shift) {
                  deck.soloStem(s.name); // Shift+tap = solo this stem (mute the rest)
                  STEM_CELLS.forEach((c) => emit({ kind: "stem", deck: id, stem: c.name, on: deck.stemActive(c.name) }));
                } else {
                  deck.toggleStem(s.name);
                  emit({ kind: "stem", deck: id, stem: s.name, on: deck.stemActive(s.name) });
                }
                refresh();
              }}
              onChange={(v) => { deck.setStemGain(s.name, v); refresh(); emit({ kind: "stemGain", deck: id, stem: s.name, value: v }); }}
              format={(v) => `${Math.round(v * 100)}`}
            />
          ))}
        </div>
        ) : stemPending || otherDeck.stemControlsReady || otherStemPending ? (
          // This deck has no stem row yet but the OTHER deck shows one (ready or
          // loading), or this deck's own stems are still loading. Reserve the row's
          // height with a "Stems loading…" placeholder so both decks' EQ + foot buttons
          // stay aligned, instead of the gap collapsing to the bottom.
          <div className="stems-row stems-pending" aria-live="polite">
            <span className="stems-pending-dot" />
            Stems loading{stemPendingPct != null ? ` ${Math.round(stemPendingPct)}%` : "…"}
          </div>
        ) : null}

        {/* FX strip (bottom third) — the channel-strip device rack. The EQ tab is the
            full-width Pro-Q-style response curve (drag a node sideways = frequency,
            up/down = gain; mid wheel = bell width; right-click / double-click = reset).
            Further tabs are stacked effects (delay…); + adds one. */}
        <div className="eq-row">
          <FxStrip deck={deck} id={id} accent={accent} otherDeck={otherDeck} otherAccent={otherAccent} emitControls={emitControls} onSelect={(i) => onFxSelect?.(id, i)} ctlRef={fxCtlRef} />
        </div>

        {/* Channel volume — a horizontal level fader (rendered at the bank TOP via
            CSS order). Deck A mirrors so both decks grow outward from the centre. */}
        <LevelFader
          deck={deck}
          accent={accent}
          level={deck.level}
          gainDb={levelGainDb}
          label={id}
          mirror={id === "A"}
          onLevel={(v) => { deck.setLevel(v); refresh(); emit({ kind: "control", deck: id, param: "level", value: v }); }}
        />
      </div>
    </div>
  );
}

