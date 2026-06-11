import type { Deck } from "@htl/audio";
import { StereoMeter } from "./StereoMeter";

interface LevelFaderProps {
  deck: Deck;
  accent: string;
  level: number;
  gainDb: number;
  label: string;
  mirror?: boolean; // flip horizontally so the deck's origin (0) sits at the centre
  onLevel: (v: number) => void;
}

// A horizontal channel-volume fader at the top of the deck's bank, riding over the
// deck's live stereo (L/R) meter. The meter is post-crossfade (gainDb), so it fades
// as the crossfader moves away from this deck. `mirror` flips it (deck A) so both
// decks' faders grow OUTWARD from the shared centre.
export function LevelFader({ deck, accent, level, gainDb, label, mirror, onLevel }: LevelFaderProps) {
  return (
    <div className={`lfader ${mirror ? "mirror" : ""}`} style={{ ["--accent" as string]: accent }}>
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
