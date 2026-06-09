import type { Deck } from "@htl/audio";
import { HOT_CUE_COUNT } from "@htl/audio";

interface DeckControlsProps {
  id: "A" | "B";
  deck: Deck;
  accent: string;
  mirror: boolean;
  shift: boolean;
  jumpBeats: number;
  onToggleShift: () => void;
  onSync: () => void;
  refresh: () => void;
}

const LOOP_SIZES = [1, 2, 4, 8];
const BIG_LOOP_SIZES = [16, 32, 48, 64];

// One deck's performance controls: transport / beat-jump / hot-cue pads / loop
// section, plus a SHIFT modifier (also the keyboard Shift key). Shift remaps:
//   • jog ◀◀ ◀ ▶ ▶▶ → MOVE the active loop (grid-locked) instead of jumping
//   • a pad → save the active loop to that pad (empty) / clear it (set)
// `mirror` flips deck B so the two banks are symmetric around the center mixer.
export function DeckControls({ id, deck, accent, mirror, shift, jumpBeats, onToggleShift, onSync, refresh }: DeckControlsProps) {
  const act = (fn: () => void) => () => {
    fn();
    refresh();
  };
  // Shift: move the loop; otherwise jump the playhead.
  const jog = (beats: number) => act(() => (shift ? deck.moveLoop(beats) : deck.beatJump(beats)));

  return (
    <div className={`bank ${mirror ? "mirror" : ""} ${shift ? "shifted" : ""}`} data-deck={id} style={{ ["--accent" as string]: accent }}>
      <div className="bank-main">
        {/* SHIFT remaps the transport: CUE→start, PLAY→play from cue,
            SYNC→reset pitch, KEY→reset the channel (EQ/filter/trim/tempo). */}
        <div className="transport">
          <button
            className="hw-btn cue"
            title={shift ? "Jump to start" : "Cue"}
            onPointerDown={act(() => (shift ? deck.seek(0) : deck.playing ? deck.jumpToCue() : deck.setCue()))}
          >
            {shift ? "START" : "CUE"}
          </button>
          <button
            className="hw-btn play"
            title={shift ? "Play from cue" : "Play / pause"}
            onClick={act(() => {
              if (shift) {
                deck.seek(deck.cuePoint);
                if (!deck.playing) deck.play();
              } else deck.togglePlay();
            })}
          >
            {deck.playing ? "❚❚" : "▶"}
          </button>
          <button className="hw-btn sync" title={shift ? "Reset pitch to 0%" : "Beat sync"} onClick={act(() => (shift ? deck.setTempo(0) : onSync()))}>
            {shift ? "PITCH" : "SYNC"}
          </button>
          <button
            className={`hw-btn key ${deck.keylock ? "on" : ""}`}
            title={shift ? "Reset channel (EQ / filter / trim / tempo)" : "Key lock"}
            onClick={act(() => {
              if (shift) {
                deck.setTempo(0);
                deck.setFilter(0);
                deck.setTrim(1);
                deck.setEqLow(0);
                deck.setEqMid(0);
                deck.setEqHigh(0);
              } else deck.setKeylock(!deck.keylock);
            })}
          >
            {shift ? "RESET" : "KEY"}
          </button>
        </div>

        <div className="jog">
          <button className="jog-btn" title={shift ? "Move loop back" : "Jump back"} onClick={jog(-jumpBeats)}>◀◀</button>
          <button className="jog-btn" title={shift ? "Move loop back a beat" : "Back a beat"} onClick={jog(-1)}>◀</button>
          <button className={`jog-btn mag ${deck.quantizing ? "on" : ""}`} title="Snap to grid" onClick={act(() => deck.setQuantize(!deck.quantizing))}>
            ⌗
          </button>
          <button className="jog-btn" title={shift ? "Move loop forward a beat" : "Forward a beat"} onClick={jog(1)}>▶</button>
          <button className="jog-btn" title={shift ? "Move loop forward" : "Jump forward"} onClick={jog(jumpBeats)}>▶▶</button>
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
                    if (deck.loop && !set) deck.saveLoop(i);
                    else deck.clearHotCue(i);
                  } else {
                    deck.hotCue(i);
                  }
                  refresh();
                }}
              >
                {isLoop ? "↻" : i + 1}
              </button>
            );
          })}
        </div>

        {/* Manual loop on its own row, beat-loop sizes on the next so they don't
            wrap awkwardly. SHIFT swaps the sizes to the big ones (16–64). */}
        <div className="loops">
          <button className={`loop-btn ${deck.loopInPoint != null ? "armed" : ""}`} onClick={act(() => deck.loopIn())}>IN</button>
          <button className="loop-btn" onClick={act(() => deck.loopOut())}>OUT</button>
          <button
            className={`loop-btn ${deck.loop?.active ? "on" : ""}`}
            disabled={!deck.loop}
            onClick={act(() => (deck.loop?.active ? deck.exitLoop() : deck.reloop()))}
          >
            {deck.loop && !deck.loop.active ? "RELOOP" : "EXIT"}
          </button>
        </div>
        <div className="loop-sizes">
          {(shift ? BIG_LOOP_SIZES : LOOP_SIZES).map((n) => (
            <button
              key={n}
              className={`loop-btn ${deck.loop?.active && deck.loop.beats === n ? "on" : ""}`}
              onClick={act(() => deck.setBeatLoop(n))}
            >
              {n}
            </button>
          ))}
        </div>

        <div className="bank-load">
          <button
            className={`hw-btn shift ${shift ? "on" : ""}`}
            onClick={onToggleShift}
            title="SHIFT — hold the Shift key or latch this to remap the jog (move loop) and pads (save loop)"
          >
            SHIFT
          </button>
        </div>
      </div>
    </div>
  );
}
