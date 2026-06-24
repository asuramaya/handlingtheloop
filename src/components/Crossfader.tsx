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
  locked?: boolean; // the crossfader is a whole-board move → blocked for non-full-controllers
  smart?: boolean; // Smart Fader armed → the throw scrubs an auto-transition (tempo morph + bass swap)
}

// The A↔B crossfader as a HORIZONTAL bar across the top of the middle section.
// A on the left, B on the right; the bipolar meter grows OUT from the centre datum
// (deck A leftward, deck B rightward), both post-crossfade so they fade as you sweep.
export function Crossfader({ deckA, deckB, accentA, accentB, crossfade, onCrossfade, locked, smart }: CrossfaderProps) {
  const { a: gainDbA, b: gainDbB } = crossfadeGainsDb(crossfade);
  const frac = (crossfade + 1) / 2; // 0 = full A (left) … 100 = full B (right)
  return (
    <div className={`xfader-bar ${locked ? "locked" : ""} ${smart ? "smart-armed" : ""}`}>
      {smart && <span className="xbar-smart" title="Smart Fader armed — throw the fader to auto-transition">SMART</span>}
      <div className="xbar-track">
        <span className="xbip">
          <StereoMeter deck={deckA} axis="h" accent={accentA} className="xb-a" gainDb={gainDbA} />
          <StereoMeter deck={deckB} axis="h" accent={accentB} className="xb-b" gainDb={gainDbB} />
        </span>
        <input
          type="range" className="xbar-input" min={-1} max={1} step={0.01} value={crossfade}
          title="A ↔ B crossfade"
          // Tint the handle the PURE colour of the side it's landed on (so it matches
          // that deck's channel-fader handle exactly) — A left of centre, B right.
          style={{
            ["--xa" as string]: accentA,
            ["--xb" as string]: accentB,
            ["--xpct" as string]: crossfade > 0 ? "100%" : "0%",
          }}
          onChange={(e) => onCrossfade(Number(e.target.value))}
          onContextMenu={(e) => { e.preventDefault(); onCrossfade(0); }}
        />
        {/* A↔B position (0 = full A, 50 = centre, 100 = full B) printed on the handle. */}
        <div className="lfader-val xbar-val" style={{ left: `calc(${frac} * (100% - 38px) + 19px)` }}>
          <span>{Math.round(frac * 100)}</span>
        </div>
      </div>
    </div>
  );
}
