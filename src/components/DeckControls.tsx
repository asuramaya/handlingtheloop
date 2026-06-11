import { useRef, useState } from "react";
import type { Deck } from "@htl/audio";
import { HOT_CUE_COUNT, EQ_MAX_DB, EQ_MIN_DB } from "@htl/audio";
import type { StemName } from "@htl/stems";
import type { Intent } from "@htl/room";
import { nextSkip, skipLabel, skipTitle } from "@htl/state";
import { ValueCell } from "./ValueCell";
import { KnobBorder } from "./KnobBorder";
import { LevelFader } from "./LevelFader";
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
  levelGainDb: number; // post-crossfade attenuation for this deck's level meter
  onCycleTempoRange: () => void;
  onCyclePitchRange: () => void;
  onToggleShift: () => void;
  onSync: () => void;
  onKey: () => void;
  refresh: () => void;
  emit: (intent: Intent) => void; // broadcast one action to a shared session (no-op when off)
  emitControls: (id: "A" | "B") => void; // re-broadcast a deck's whole control state (after SYNC / RESET)
}

// Every beat-loop size, shown at once (half-width). Each pairs with a keyboard
// U/I/O/P key: the fraction on a bare press, the whole beat under Shift — so the
// four whole-beat pads carry a ⇧ prefix in their kbd hint.
const LOOP_SIZES: { n: number; label: string; kbd: string }[] = [
  { n: 0.5, label: "1/2", kbd: "U" },
  { n: 0.25, label: "1/4", kbd: "I" },
  { n: 0.125, label: "1/8", kbd: "O" },
  { n: 0.0625, label: "1/16", kbd: "P" },
  { n: 1, label: "1", kbd: "⇧U" },
  { n: 2, label: "2", kbd: "⇧I" },
  { n: 4, label: "4", kbd: "⇧O" },
  { n: 8, label: "8", kbd: "⇧P" },
];

// Tempo nudge step (percent) for SHIFT-clicking the ∓ pitch steppers.
const TEMPO_NUDGE = 0.5;

// One deck's performance controls: jog / loop section, hot-cue pads, then the
// SYNC·KEY·FX·dB rack over the CUE·PLAY·SHIFT foot. A SHIFT modifier (also the
// keyboard Shift key) remaps:
//   • jog ◀◀ ◀ ▶ ▶▶ → MOVE the active loop (grid-locked) instead of jumping
//   • ⌗ → a skip-size selector (1/16 beat … 8 bars) instead of the grid magnet
//   • a pad → save the active loop to that pad (empty) / clear it (set)
// `mirror` flips deck B so the two banks are symmetric around the center mixer.
export function DeckControls({ id, deck, accent, focused, onFocus, mirror, shift, tempoRange, pitchRange, levelGainDb, onCycleTempoRange, onCyclePitchRange, onToggleShift, onSync, onKey, refresh, emit, emitControls }: DeckControlsProps) {
  const [effect, setEffect] = useState(EFFECTS[0].id);
  const [fxMenu, setFxMenu] = useState(false);
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
          {/* IN / OUT drop the loop boundaries; SHIFT-IN / SHIFT-OUT instead arm a
              fine-adjust mode where the waveform (drag / scroll) and arrow keys nudge
              that boundary. RELOOP/EXIT toggles the loop; SHIFT clears it outright. */}
          <button
            className={`loop-btn ${deck.loopInPoint != null ? "armed" : ""} ${deck.adjusting === "in" ? "adjust" : ""}`}
            title={shift ? "Adjust loop-in — drag / scroll the wave or arrow-key it" : "Loop in"}
            onClick={(e) => {
              if (shift || e.shiftKey) deck.toggleAdjust("in");
              else { deck.loopIn(); emit({ kind: "loop", deck: id, action: "in" }); }
              refresh();
            }}
          >
            IN<span className="kbd">Q</span>
          </button>
          <button
            className={`loop-btn ${deck.adjusting === "out" ? "adjust" : ""}`}
            title={shift ? "Adjust loop-out — drag / scroll the wave or arrow-key it" : "Loop out"}
            onClick={(e) => {
              if (shift || e.shiftKey) deck.toggleAdjust("out");
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
        <div className="loop-sizes">
          {LOOP_SIZES.map((s) => {
            const active = deck.loop?.active && deck.loop.beats === s.n;
            return (
              <button
                key={s.n}
                className={`loop-btn ${active || rolling.current === s.n ? "on" : ""}`}
                title={shift ? `Loop roll ${s.label} — hold` : `Beat loop ${s.label}`}
                onPointerDown={(e) => {
                  // All sizes show at once now, so SHIFT no longer swaps the bank —
                  // instead Shift-HOLD rolls: engage the loop on press, snap back
                  // on-beat on release. Plain press latches the loop (via onClick).
                  if (!(shift || e.shiftKey)) return;
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
                  if (shift || e.shiftKey) return; // handled as a roll by the pointer events
                  deck.setBeatLoop(s.n);
                  emit({ kind: "loop", deck: id, action: "beat", beats: s.n });
                  refresh();
                }}
              >
                {s.label}
                <span className="kbd">{s.kbd}</span>
              </button>
            );
          })}
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

        {/* SYNC·KEY·FX·range rack. SYNC beat-matches and KEY matches key — both
            stay static under SHIFT (the channel RESET moved to PLAY's shift). FX
            toggles the color filter; the range button sets the TEMPO/KEY knob span. */}
        <div className="transport">
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
            {deck.syncRole === "master" ? "MASTER" : "SYNC"}
            <span className="kbd">A</span>
          </button>
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
            {deck.keyRole === "master" ? "KMST" : "KEY"}
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
            title={shift ? "Reset channel (EQ / filter / trim / tempo / key / stems)" : "Play / pause"}
            onClick={act(() => {
              if (shift) {
                deck.setTempo(0);
                deck.setFilter(0);
                deck.setTrim(1);
                deck.setEqLow(0);
                deck.setEqMid(0);
                deck.setEqHigh(0);
                deck.setPitch(0);
                deck.setLevel(1); // volume back to centre (unity)
                deck.resetStems(); // also reset stem faders → unity and un-mute all stems
                emit({ kind: "control", deck: id, param: "level", value: 1 });
                emitControls(id);
              } else {
                deck.togglePlay();
                emit({ kind: "transport", deck: id, action: deck.playing ? "play" : "pause" });
              }
            })}
          >
            {shift ? "RESET" : deck.playing ? "❚❚" : "▶"}
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

        {/* EQ foot — bipolar (detent 0 dB): TRIM/HI/MID/LOW, same size as STEMS. */}
        <div className="eq-row">
          <ValueCell label="TRIM" value={gainToDb(deck.trim)} min={EQ_MIN_DB} max={EQ_MAX_DB} pivot={0} onChange={(v) => { const g = dbToGain(v); deck.setTrim(g); refresh(); emit({ kind: "control", deck: id, param: "trim", value: g }); }} format={db} />
          <ValueCell label="HI" value={deck.eqHigh} min={EQ_MIN_DB} max={EQ_MAX_DB} pivot={0} onChange={(v) => { deck.setEqHigh(v); refresh(); emit({ kind: "control", deck: id, param: "eqHigh", value: v }); }} format={db} />
          <ValueCell label="MID" value={deck.eqMid} min={EQ_MIN_DB} max={EQ_MAX_DB} pivot={0} onChange={(v) => { deck.setEqMid(v); refresh(); emit({ kind: "control", deck: id, param: "eqMid", value: v }); }} format={db} />
          <ValueCell label="LOW" value={deck.eqLow} min={EQ_MIN_DB} max={EQ_MAX_DB} pivot={0} onChange={(v) => { deck.setEqLow(v); refresh(); emit({ kind: "control", deck: id, param: "eqLow", value: v }); }} format={db} />
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

// Compact dB readout for the EQ / trim cells (signed, no decimals).
function db(v: number): string {
  return `${v > 0 ? "+" : ""}${Math.round(v)}`;
}
function dbToGain(d: number): number {
  return Math.pow(10, d / 20);
}
function gainToDb(gain: number): number {
  return gain > 0 ? Math.max(EQ_MIN_DB, 20 * Math.log10(gain)) : EQ_MIN_DB;
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
