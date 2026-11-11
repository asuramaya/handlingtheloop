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
// decks' faders grow OUTWARD from the shared centre. The range is 0…2 so the centre
// (1 = unity) is the default rest position: drag inward to cut, outward to boost.
export function LevelFader({ deck, accent, level, gainDb, label, mirror, onLevel }: LevelFaderProps) {
  const frac = Math.max(0, Math.min(1, level / 2)); // 0..1 across the 0..2 throw
  return (
    <div className={`lfader ${mirror ? "mirror" : ""}`} style={{ ["--accent" as string]: accent }}>
      <div className="lfader-track">
        <StereoMeter deck={deck} axis="h" accent={accent} gainDb={gainDb} />
        <input
          type="range" className="lfader-input" min={0} max={2} step={0.01} value={level}
          title={`Deck ${label} volume (centre = unity) — double-click / right-click resets`}
          onChange={(e) => onLevel(Number(e.target.value))}
          onDoubleClick={() => onLevel(1)}
          onContextMenu={(e) => { e.preventDefault(); onLevel(1); }}
        />
        {/* Level % printed on the (widened) handle. Tracks the thumb; the inner span
            counter-flips so deck A's mirrored fader stays readable. */}
        <div className="lfader-val" style={{ left: `calc(${frac} * (100% - 38px) + 19px)` }}>
          <span>{Math.round(level * 100)}</span>
        </div>
      </div>
    </div>
  );
}
