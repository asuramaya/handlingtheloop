import { useRef } from "react";
import type { Deck } from "@htl/audio";
import { HOT_CUE_COUNT } from "@htl/audio";
import type { StemName } from "@htl/stems";
import type { Intent } from "@htl/room";
import { nextSkip, skipLabel, skipTitle } from "@htl/state";
import { ValueCell } from "./ValueCell";
import { EqCurve } from "./EqCurve";
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

// Tempo nudge step (percent) for SHIFT-clicking the ∓ pitch steppers.
const TEMPO_NUDGE = 0.5;

// One deck's performance controls: jog / loop section, hot-cue pads, then the
// SYNC·KEY·FX·dB rack over the CUE·PLAY·SHIFT foot. A SHIFT modifier (also the
// keyboard Shift key) remaps:
//   • jog ◀◀ ◀ ▶ ▶▶ → MOVE the active loop (grid-locked) instead of jumping
//   • ⌗ → a skip-size selector (1/16 beat … 8 bars) instead of the grid magnet
//   • a pad → save the active loop to that pad (empty) / clear it (set)
// `mirror` flips deck B so the two banks are symmetric around the center mixer.
export function DeckControls({ id, deck, accent, otherDeck, otherAccent, focused, onFocus, mirror, shift, tempoRange, pitchRange, levelGainDb, onCycleTempoRange, onCyclePitchRange, onToggleShift, onSync, onKey, refresh, emit, emitControls }: DeckControlsProps) {
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

  return (
    <div className={`bank ${mirror ? "mirror" : ""} ${shift ? "shifted" : ""} ${deck.adjusting ? "adjusting" : ""} ${focused ? "focused" : ""}`} data-deck={id} style={{ ["--accent" as string]: accent }} onPointerDownCapture={onFocus}>
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
          <button className="jog-btn" title={deck.adjusting ? `Nudge ${deck.adjusting} marker forward a beat` : shift ? "Move loop forward a beat" : "Forward a beat"} onClick={jog(1)}>▶<span className="kbd">→</span></button>
          <button className="jog-btn" title={deck.adjusting ? `Nudge ${deck.adjusting} marker forward` : shift ? "Move loop forward" : "Jump forward"} onClick={jog(deck.skipBeats)}>▶▶<span className="kbd">↑</span></button>
        </div>

        {/* FLX-style loop strip: manual IN / OUT / EXIT, then the beat-loop sizes
            (fractions of a beat, or whole beats 1–8 under SHIFT). */}
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

        {/* − · TEMPO-range · PITCH-range · + rack: the ∓ tempo/key steppers flank the
            two range buttons (SYNC and KEY moved down to the TEMPO/KEY row). */}
        <div className="transport">
          <button className="pitch-step" title={shift ? "Nudge tempo down 0.5%" : "Key down a semitone"} onClick={() => nudge(-1)}>−</button>
          <button className="hw-btn range" title="TEMPO knob range (±%)" onClick={act(onCycleTempoRange)}>
            ±{tempoRange}%<span className="kbd">F</span>
          </button>
          <button className="hw-btn range" title="PITCH (KEY) knob range (± semitones)" onClick={act(onCyclePitchRange)}>
            ±{pitchRange}st
          </button>
          <button className="pitch-step" title={shift ? "Nudge tempo up 0.5%" : "Key up a semitone"} onClick={() => nudge(1)}>+</button>
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

        {/* TEMPO + KEY knobs, now bracketed by SYNC (left) and KEY-match (right). */}
        <div className="pitch-row">
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

        {/* EQ foot (bottom third) — a full-width Pro-Q-style response curve: drag a
            node sideways = frequency, up/down = gain; mid wheel = bell width;
            right-click / double-click a node = reset that band. Drawn over the live
            spectrum. */}
        <div className="eq-row">
          <EqCurve deck={deck} id={id} accent={accent} otherDeck={otherDeck} otherAccent={otherAccent} emit={emit} emitControls={emitControls} refresh={refresh} />
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

