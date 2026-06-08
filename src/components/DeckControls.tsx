import { useRef } from "react";
import type { Deck } from "../audio/Deck";
import { HOT_CUE_COUNT } from "../audio/Deck";
import { Fader } from "./Fader";

interface DeckControlsProps {
  id: "A" | "B";
  deck: Deck;
  accent: string;
  loading: boolean;
  mirror: boolean;
  onSync: () => void;
  onLoadFile: (file: File) => void;
  refresh: () => void;
}

const LOOP_SIZES = [1, 2, 4, 8];

// One deck's performance controls: tempo fader on the outer edge, then transport
// / beat-jump / hot-cue pads / loop section. `mirror` flips deck B so the two
// banks are symmetric around the center mixer (DDJ layout).
export function DeckControls({ id, deck, accent, loading, mirror, onSync, onLoadFile, refresh }: DeckControlsProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const act = (fn: () => void) => () => {
    fn();
    refresh();
  };

  return (
    <div className={`bank ${mirror ? "mirror" : ""}`} data-deck={id} style={{ ["--accent" as string]: accent }}>
      <Fader
        className="pitch"
        label="TEMPO"
        value={deck.tempo}
        min={-8}
        max={8}
        step={0.05}
        onChange={(v) => {
          deck.setTempo(v);
          refresh();
        }}
        format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
      />

      <div className="bank-main">
        <div className="transport">
          <button className="hw-btn cue" onPointerDown={act(() => (deck.playing ? deck.jumpToCue() : deck.setCue()))}>
            CUE
          </button>
          <button className="hw-btn play" onClick={act(() => deck.togglePlay())}>
            {deck.playing ? "❚❚" : "▶"}
          </button>
          <button className="hw-btn sync" onClick={act(onSync)}>
            SYNC
          </button>
          <button className={`hw-btn key ${deck.keylock ? "on" : ""}`} onClick={act(() => deck.setKeylock(!deck.keylock))}>
            KEY
          </button>
        </div>

        <div className="jog">
          <button className="jog-btn" title="Back a bar" onClick={act(() => deck.beatJump(-4))}>◀◀</button>
          <button className="jog-btn" title="Back a beat" onClick={act(() => deck.beatJump(-1))}>◀</button>
          <button className={`jog-btn mag ${deck.quantizing ? "on" : ""}`} title="Snap to grid" onClick={act(() => deck.setQuantize(!deck.quantizing))}>
            ⌗
          </button>
          <button className="jog-btn" title="Forward a beat" onClick={act(() => deck.beatJump(1))}>▶</button>
          <button className="jog-btn" title="Forward a bar" onClick={act(() => deck.beatJump(4))}>▶▶</button>
        </div>

        <div className="hotcues">
          {Array.from({ length: HOT_CUE_COUNT }, (_, i) => {
            const set = deck.hotCues[i] != null;
            return (
              <button
                key={i}
                className={`pad ${set ? "set" : ""}`}
                data-cue={i + 1}
                onClick={(e) => {
                  if (e.shiftKey && set) deck.clearHotCue(i);
                  else deck.hotCue(i);
                  refresh();
                }}
              >
                {i + 1}
                {set && (
                  <span className="pad-clear" onClick={(e) => { e.stopPropagation(); deck.clearHotCue(i); refresh(); }}>
                    ✕
                  </span>
                )}
              </button>
            );
          })}
        </div>

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
          <span className="loop-sep" />
          {LOOP_SIZES.map((n) => (
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
          <input
            ref={fileInput}
            type="file"
            accept="audio/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onLoadFile(f);
            }}
          />
          <button className="hw-btn small" onClick={() => fileInput.current?.click()}>
            {loading ? "loading…" : "Load file"}
          </button>
        </div>
      </div>
    </div>
  );
}
