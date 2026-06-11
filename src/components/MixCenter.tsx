import type { Deck } from "@htl/audio";
import { StereoMeter } from "./StereoMeter";

interface MixCenterProps {
  deckA: Deck;
  deckB: Deck;
  accentA: string;
  accentB: string;
  levelA: number;
  levelB: number;
  crossfade: number;
  onLevelA: (v: number) => void;
  onLevelB: (v: number) => void;
  onCrossfade: (v: number) => void;
}

// The mixer centre: three vertical faders standing between the two channels —
// deck A volume (left) · A↔B crossfade (middle) · deck B volume (right). Each
// fader rides over that deck's live stereo (L/R) dB meter; the crossfade meter is
// bipolar, deck A growing UP from the centre datum and deck B growing DOWN. A
// (top) and B (bottom) label the whole cluster.
export function MixCenter({ deckA, deckB, accentA, accentB, levelA, levelB, crossfade, onLevelA, onLevelB, onCrossfade }: MixCenterProps) {
  // Equal-power crossfade gains (match AudioEngine.setCrossfade): as the fader
  // moves toward B, A's gain falls. Feed these to the meters as a dB offset so each
  // deck's bar shows its ACTUAL contribution to the mix, fading gradually.
  const x = (crossfade + 1) / 2;
  const toDb = (g: number) => 20 * Math.log10(Math.max(g, 1e-4));
  const gainDbA = toDb(Math.cos((x * Math.PI) / 2));
  const gainDbB = toDb(Math.cos(((1 - x) * Math.PI) / 2));

  return (
    <div className="mixcenter">
      <span className="xf-end top">A</span>
      <div className="mc-cols">
        {/* Deck A volume */}
        <div className="mc-col" style={{ ["--accent" as string]: accentA }}>
          <StereoMeter deck={deckA} dir="up" accent={accentA} gainDb={gainDbA} />
          <input
            type="range" className="mc-fader" min={0} max={1} step={0.01} value={levelA}
            title="Deck A volume"
            onChange={(e) => onLevelA(Number(e.target.value))}
            onContextMenu={(e) => { e.preventDefault(); onLevelA(1); }}
          />
        </div>

        {/* A↔B crossfade — bipolar meter (A up · B down) */}
        <div className="mc-col cross">
          <span className="mc-bip">
            <StereoMeter deck={deckA} dir="up" accent={accentA} className="bip-a" gainDb={gainDbA} />
            <StereoMeter deck={deckB} dir="down" accent={accentB} className="bip-b" gainDb={gainDbB} />
          </span>
          <input
            type="range" className="mc-fader" min={-1} max={1} step={0.01} value={crossfade}
            title="A ↔ B crossfade"
            onChange={(e) => onCrossfade(Number(e.target.value))}
            onContextMenu={(e) => { e.preventDefault(); onCrossfade(0); }}
          />
        </div>

        {/* Deck B volume */}
        <div className="mc-col" style={{ ["--accent" as string]: accentB }}>
          <StereoMeter deck={deckB} dir="up" accent={accentB} gainDb={gainDbB} />
          <input
            type="range" className="mc-fader" min={0} max={1} step={0.01} value={levelB}
            title="Deck B volume"
            onChange={(e) => onLevelB(Number(e.target.value))}
            onContextMenu={(e) => { e.preventDefault(); onLevelB(1); }}
          />
        </div>
      </div>
      <span className="xf-end bottom">B</span>
    </div>
  );
}
