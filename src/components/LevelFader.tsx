import type { Deck } from "@htl/audio";
import { StereoMeter } from "./StereoMeter";

interface LevelFaderProps {
  deck: Deck;
  accent: string;
  level: number;
  gainDb: number;
  label: string;
  onLevel: (v: number) => void;
}

// A horizontal channel-volume fader for the bottom strip, riding over the deck's
// live stereo (L/R) meter. The meter is post-crossfade (gainDb), so it fades as
// the crossfader moves away from this deck.
export function LevelFader({ deck, accent, level, gainDb, label, onLevel }: LevelFaderProps) {
  return (
    <div className="lfader" style={{ ["--accent" as string]: accent }}>
      <span className="lfader-label">{label}</span>
      <div className="lfader-track">
        <StereoMeter deck={deck} axis="h" accent={accent} gainDb={gainDb} />
        <input
          type="range" className="lfader-input" min={0} max={1} step={0.01} value={level}
          title={`Deck ${label} volume`}
          onChange={(e) => onLevel(Number(e.target.value))}
          onContextMenu={(e) => { e.preventDefault(); onLevel(1); }}
        />
      </div>
    </div>
  );
}
