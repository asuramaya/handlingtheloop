import { useState } from "react";
import type { Deck } from "@htl/audio";
import { HOT_CUE_COUNT } from "@htl/audio";
import type { StemName } from "@htl/stems";
import type { Intent } from "@htl/room";
import { nextSkip, skipLabel, skipTitle } from "@htl/state";
import { ValueCell } from "./ValueCell";
import { KnobBorder } from "./KnobBorder";
import { useValueDrag } from "./useValueDrag";

// Per-stem cells (under the PITCH foot). Each is a level knob AND the mute toggle:
// tap = mute / unmute, scroll/drag = level. `kbd` is the global keyboard hint.
const STEM_CELLS: { name: StemName; label: string; kbd: string }[] = [
  { name: "drums", label: "DRUM", kbd: "H" },
  { name: "bass", label: "BASS", kbd: "J" },
  { name: "vocals", label: "VOICE", kbd: "K" },
  { name: "other", label: "INST", kbd: "L" },
];

// Per-deck effect the FX fader drives. Only the color filter today — the FX button
// shows the current one and Shift-clicking it opens this list. Add reverb/echo here
// later (and branch the mixer's FILT fader on the choice).
const EFFECTS: { id: string; label: string }[] = [{ id: "filter", label: "Filter" }];

interface DeckControlsProps {
  id: "A" | "B";
  deck: Deck;
  accent: string;
  focused: boolean;
  onFocus: () => void;
  mirror: boolean;
  shift: boolean;
  tempoRange: number;
  pitchRange: number;
  onCycleTempoRange: () => void;
  onCyclePitchRange: () => void;
  onToggleShift: () => void;
  onSync: () => void;
  onKey: () => void;
  refresh: () => void;
  emit: (intent: Intent) => void; // broadcast one action to a shared session (no-op when off)
  emitControls: (id: "A" | "B") => void; // re-broadcast a deck's whole control state (after SYNC / RESET)
}

// Beat-loop sizes: fractions of a beat normally, whole beats under SHIFT.
const LOOP_SIZES = [0.5, 0.25, 0.125, 0.0625];
const LOOP_LABELS = ["1/2", "1/4", "1/8", "1/16"];
const BIG_LOOP_SIZES = [1, 2, 4, 8];

// Tempo nudge step (percent) for SHIFT-clicking the ∓ pitch steppers.
const TEMPO_NUDGE = 0.5;

// One deck's performance controls: jog / loop section, hot-cue pads, then the
// SYNC·KEY·FX·dB rack over the CUE·PLAY·SHIFT foot. A SHIFT modifier (also the
// keyboard Shift key) remaps:
//   • jog ◀◀ ◀ ▶ ▶▶ → MOVE the active loop (grid-locked) instead of jumping
//   • ⌗ → a skip-size selector (1/16 beat … 8 bars) instead of the grid magnet
//   • a pad → save the active loop to that pad (empty) / clear it (set)
// `mirror` flips deck B so the two banks are symmetric around the center mixer.
export function DeckControls({ id, deck, accent, focused, onFocus, mirror, shift, tempoRange, pitchRange, onCycleTempoRange, onCyclePitchRange, onToggleShift, onSync, onKey, refresh, emit, emitControls }: DeckControlsProps) {
  const [effect, setEffect] = useState(EFFECTS[0].id);
  const [fxMenu, setFxMenu] = useState(false);
  const effectLabel = EFFECTS.find((e) => e.id === effect)?.label ?? "FX";
  // ∓ stepper: KEY ±1 semitone (clamped to the pitch range), or TEMPO ±0.5% under
  // SHIFT (clamped to the tempo range).
  const nudge = (dir: number) => {
    if (shift) {
      deck.setTempo(Math.max(-tempoRange, Math.min(tempoRange, deck.tempo + dir * TEMPO_NUDGE)));
      emit({ kind: "control", deck: id, param: "tempo", value: deck.tempo });
    } else {
      deck.setPitch(Math.max(-pitchRange, Math.min(pitchRange, deck.pitch + dir)));
      emit({ kind: "control", deck: id, param: "pitch", value: deck.pitch });
    }
    refresh();
  };
  const act = (fn: () => void) => () => {
    fn();
    refresh();
  };
  // Broadcast the deck's current playhead as a seek (after a jump/cue) so co-DJs follow.
  const emitSeek = () => emit({ kind: "transport", deck: id, action: "seek", position: deck.position() });
  // Shift: move the loop; otherwise jump the playhead — both by the deck's skip.
  const jog = (beats: number) =>
    act(() => {
      if (shift) deck.moveLoop(beats);
      else {
        deck.beatJump(beats);
        emitSeek();
      }
    });

  return (
    <div className={`bank ${mirror ? "mirror" : ""} ${shift ? "shifted" : ""} ${focused ? "focused" : ""}`} data-deck={id} style={{ ["--accent" as string]: accent }} onPointerDownCapture={onFocus}>
      <div className="bank-main">
        {/* Beat-jump / loop-move row (SHIFT remaps it to move the loop; the ⌗ in
            the middle is the grid magnet, or the skip selector under SHIFT). */}
        <div className="jog">
          <button className="jog-btn" title={shift ? "Move loop back" : "Jump back"} onClick={jog(-deck.skipBeats)}>◀◀<span className="kbd">↓</span></button>
          <button className="jog-btn" title={shift ? "Move loop back a beat" : "Back a beat"} onClick={jog(-1)}>◀<span className="kbd">←</span></button>
          {shift ? (
            <button
              className="jog-btn mag skip"
              title={skipTitle(deck.skipBeats)}
              onClick={act(() => (deck.skipBeats = nextSkip(deck.skipBeats)))}
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
          <button className="jog-btn" title={shift ? "Move loop forward a beat" : "Forward a beat"} onClick={jog(1)}>▶<span className="kbd">→</span></button>
          <button className="jog-btn" title={shift ? "Move loop forward" : "Jump forward"} onClick={jog(deck.skipBeats)}>▶▶<span className="kbd">↑</span></button>
        </div>

        {/* FLX-style loop strip: manual IN / OUT / EXIT, then the beat-loop sizes
            (fractions of a beat, or whole beats 1–8 under SHIFT). */}
        <div className="loops">
          <button className={`loop-btn ${deck.loopInPoint != null ? "armed" : ""}`} onClick={act(() => { deck.loopIn(); emit({ kind: "loop", deck: id, action: "in" }); })}>IN<span className="kbd">Q</span></button>
          <button className="loop-btn" onClick={act(() => { deck.loopOut(); emit({ kind: "loop", deck: id, action: "out" }); })}>OUT<span className="kbd">W</span></button>
          <button
            className={`loop-btn ${deck.loop?.active ? "on" : ""}`}
            disabled={!deck.loop}
            onClick={act(() => {
              if (deck.loop?.active) {
                deck.exitLoop();
                emit({ kind: "loop", deck: id, action: "exit" });
              } else {
                deck.reloop();
                emit({ kind: "loop", deck: id, action: "reloop" });
              }
            })}
          >
            {deck.loop && !deck.loop.active ? "RELOOP" : "EXIT"}
            <span className="kbd">E</span>
          </button>
        </div>
        <div className="loop-sizes">
          {(shift ? BIG_LOOP_SIZES : LOOP_SIZES).map((n, i) => (
            <button
              key={n}
              className={`loop-btn ${deck.loop?.active && deck.loop.beats === n ? "on" : ""}`}
              onClick={act(() => { deck.setBeatLoop(n); emit({ kind: "loop", deck: id, action: "beat", beats: n }); })}
            >
              {shift ? n : LOOP_LABELS[i]}
              <span className="kbd">{["U", "I", "O", "P"][i]}</span>
            </button>
          ))}
        </div>

        <div className="hotcues">
          {Array.from({ length: HOT_CUE_COUNT }, (_, i) => {
            const set = deck.slotIsSet(i);
            const isLoop = deck.hotLoops[i] != null;
            return (
              <button
                key={i}
                className={`pad ${set ? "set" : ""} ${isLoop ? "loop" : ""}`}
                data-cue={i + 1}
                title={shift ? (deck.loop && !set ? "Save loop here" : "Clear") : isLoop ? "Recall loop" : "Hot cue"}
                onClick={(e) => {
                  const shiftNow = shift || e.shiftKey;
                  if (shiftNow) {
                    if (deck.loop && !set) {
                      deck.saveLoop(i);
                      emit({ kind: "hotcue", deck: id, slot: i, action: "save" });
                    } else {
                      deck.clearHotCue(i);
                      emit({ kind: "hotcue", deck: id, slot: i, action: "clear" });
                    }
                  } else {
                    deck.hotCue(i);
                    emit({ kind: "hotcue", deck: id, slot: i, action: "press" });
                  }
                  refresh();
                }}
              >
                {isLoop ? "↻" : i + 1}
              </button>
            );
          })}
        </div>

        {/* SYNC·KEY·FX·dB rack. SHIFT remaps SYNC→reset pitch, KEY→reset channel.
            FX toggles the color filter; dB matches this deck's gain to the other. */}
        <div className="transport">
          <button
            className="hw-btn sync"
            title={shift ? "Reset pitch to 0%" : "Beat sync"}
            onClick={act(() => {
              if (shift) {
                deck.setTempo(0);
                emit({ kind: "control", deck: id, param: "tempo", value: 0 });
              } else {
                onSync();
                emitControls(id);
              }
            })}
          >
            {shift ? "PITCH" : "SYNC"}
            <span className="kbd">A</span>
          </button>
          <button
            className={`hw-btn key ${deck.pitch !== 0 ? "on" : ""}`}
            title={shift ? "Reset channel (EQ / filter / trim / tempo / key / stems)" : "Match key to the other deck"}
            onClick={act(() => {
              if (shift) {
                deck.setTempo(0);
                deck.setFilter(0);
                deck.setTrim(1);
                deck.setEqLow(0);
                deck.setEqMid(0);
                deck.setEqHigh(0);
                deck.setPitch(0);
                deck.resetStems(); // also reset stem faders → unity and un-mute all stems
                emitControls(id);
              } else {
                onKey();
                emit({ kind: "control", deck: id, param: "pitch", value: deck.pitch });
              }
            })}
          >
            {shift ? "RESET" : "KEY"}
            <span className="kbd">S</span>
          </button>
          <div className="fx-wrap">
            <FxButton
              deck={deck}
              label={effectLabel}
              title={shift ? "Choose effect" : `${effectLabel}: tap on / off · scroll or drag to sweep LP↔HP (Shift: choose effect)`}
              onToggle={act(() => {
                if (shift) setFxMenu((o) => !o);
                else {
                  deck.setFx(!deck.fxOn);
                  emit({ kind: "toggle", deck: id, param: "fx", value: deck.fxOn });
                }
              })}
              onAdjust={(v) => {
                deck.setFilter(v);
                refresh();
                emit({ kind: "control", deck: id, param: "filter", value: v });
              }}
            />
            {fxMenu && (
              <>
                <div className="fx-menu-catch" onClick={() => setFxMenu(false)} />
                <div className="fx-menu">
                  {EFFECTS.map((e) => (
                    <button
                      key={e.id}
                      className={`fx-menu-item ${e.id === effect ? "on" : ""}`}
                      onClick={() => {
                        setEffect(e.id);
                        setFxMenu(false);
                      }}
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            className="hw-btn range"
            title={shift ? "KEY knob range (± semitones)" : "TEMPO knob range (±%)"}
            onClick={act(shift ? onCyclePitchRange : onCycleTempoRange)}
          >
            {shift ? `±${pitchRange}` : `±${tempoRange}`}
            <span className="kbd">F</span>
          </button>
        </div>

        <div className="bank-load">
          <button
            className="hw-btn cue"
            title={shift ? "Jump to start" : "Cue"}
            onPointerDown={act(() => {
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
            })}
          >
            {shift ? "START" : "CUE"}
            <span className="kbd">C</span>
          </button>
          <button
            className="hw-btn play"
            title={shift ? "Play from cue" : "Play / pause"}
            onClick={act(() => {
              if (shift) {
                deck.seek(deck.cuePoint);
                if (!deck.playing) deck.play();
                emitSeek();
                emit({ kind: "transport", deck: id, action: "play" });
              } else {
                deck.togglePlay();
                emit({ kind: "transport", deck: id, action: deck.playing ? "play" : "pause" });
              }
            })}
          >
            {deck.playing ? "❚❚" : "▶"}
            <span className="kbd">⎵</span>
          </button>
          <button
            className={`hw-btn shift ${shift ? "on" : ""}`}
            onClick={onToggleShift}
            title="SHIFT — hold the Shift key or latch this to remap the jog (move loop / skip size) and pads (save loop)"
          >
            SHIFT
            <span className="kbd">⇧</span>
          </button>
        </div>

        {/* PITCH foot: TEMPO + KEY knobs bracketed by the ∓ steppers (KEY ±1
            semitone, or TEMPO ±0.5% under SHIFT). Ranges set by the F button. */}
        <div className="pitch-row">
          <button className="pitch-step" title={shift ? "Nudge tempo down 0.5%" : "Key down a semitone"} onClick={() => nudge(-1)}>−</button>
          <ValueCell
            label="TEMPO"
            value={deck.tempo}
            min={-tempoRange}
            max={tempoRange}
            step={0.05}
            pivot={0}
            onChange={(v) => { deck.setTempo(v); refresh(); emit({ kind: "control", deck: id, param: "tempo", value: v }); }}
            format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
          />
          <ValueCell
            label="KEY"
            value={deck.pitch}
            min={-pitchRange}
            max={pitchRange}
            step={1}
            pivot={0}
            onChange={(v) => { deck.setPitch(Math.round(v)); refresh(); emit({ kind: "control", deck: id, param: "pitch", value: Math.round(v) }); }}
            format={(v) => `${v > 0 ? "+" : ""}${Math.round(v)}`}
          />
          <button className="pitch-step" title={shift ? "Nudge tempo up 0.5%" : "Key up a semitone"} onClick={() => nudge(1)}>+</button>
        </div>

        {/* STEMS foot: tap = mute / unmute, scroll/drag = level 0–150% (1 = unity).
            Dimmed when muted; disabled until the deck has stems. */}
        <div className="stems-row">
          {STEM_CELLS.map((s) => (
            <ValueCell
              key={s.name}
              label={s.label}
              kbd={s.kbd}
              disabled={!deck.hasStems}
              active={deck.hasStems ? deck.stemActive(s.name) : undefined}
              value={deck.hasStems ? deck.stemLevel(s.name) : 1}
              min={0}
              max={1.5}
              reset={1}
              onTap={() => { deck.toggleStem(s.name); refresh(); emit({ kind: "stem", deck: id, stem: s.name, on: deck.stemActive(s.name) }); }}
              onChange={(v) => { deck.setStemGain(s.name, v); refresh(); emit({ kind: "stemGain", deck: id, stem: s.name, value: v }); }}
              format={(v) => `${Math.round(v * 100)}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// The merged effect control: tap toggles the effect on/off, scroll or vertical drag
// sweeps the color filter (LP ← centre → HP), and Shift-tap opens the effect chooser
// (handled by the parent's onToggle). A bipolar fill grows from the centre toward the
// engaged side so the sweep reads at a glance.
function FxButton({ deck, label, title, onToggle, onAdjust }: { deck: Deck; label: string; title: string; onToggle: () => void; onAdjust: (v: number) => void }) {
  const f = deck.filterValue; // −1 … 0 … +1
  const drag = useValueDrag<HTMLButtonElement>({ value: f, min: -1, max: 1, step: 0.01, onChange: onAdjust });
  const dir = Math.abs(f) < 0.02 ? "" : f < 0 ? " · LP" : " · HP";
  return (
    <button
      ref={drag.ref}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      className={`hw-btn fx ${deck.fxOn ? "on" : ""}`}
      title={title}
      onClick={onToggle}
    >
      <KnobBorder value={f} min={-1} max={1} pivot={0} />
      <span className="fx-label">{label}{dir}</span>
      <span className="kbd">D</span>
    </button>
  );
}
