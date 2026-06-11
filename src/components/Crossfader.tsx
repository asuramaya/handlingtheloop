import type { Deck } from "@htl/audio";
import { StereoMeter } from "./StereoMeter";

// Equal-power crossfade gains in dB (match AudioEngine.setCrossfade) — fed to the
// meters so each deck's bar shows its ACTUAL post-crossfade contribution.
export function crossfadeGainsDb(crossfade: number): { a: number; b: number } {
  const x = (crossfade + 1) / 2;
  const toDb = (g: number) => 20 * Math.log10(Math.max(g, 1e-4));
  return { a: toDb(Math.cos((x * Math.PI) / 2)), b: toDb(Math.cos(((1 - x) * Math.PI) / 2)) };
}

interface CrossfaderProps {
  deckA: Deck;
  deckB: Deck;
  accentA: string;
  accentB: string;
  crossfade: number;
  onCrossfade: (v: number) => void;
}

// The A↔B crossfader as a HORIZONTAL bar across the top of the middle section.
// A on the left, B on the right; the bipolar meter grows OUT from the centre datum
// (deck A leftward, deck B rightward), both post-crossfade so they fade as you sweep.
export function Crossfader({ deckA, deckB, accentA, accentB, crossfade, onCrossfade }: CrossfaderProps) {
  const { a: gainDbA, b: gainDbB } = crossfadeGainsDb(crossfade);
  return (
    <div className="xfader-bar">
      <div className="xbar-track">
        <span className="xbip">
          <StereoMeter deck={deckA} axis="h" accent={accentA} className="xb-a" gainDb={gainDbA} />
          <StereoMeter deck={deckB} axis="h" accent={accentB} className="xb-b" gainDb={gainDbB} />
        </span>
        <input
          type="range" className="xbar-input" min={-1} max={1} step={0.01} value={crossfade}
          title="A ↔ B crossfade"
          onChange={(e) => onCrossfade(Number(e.target.value))}
          onContextMenu={(e) => { e.preventDefault(); onCrossfade(0); }}
        />
      </div>
    </div>
  );
}
