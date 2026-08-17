import type { Deck, NoiseFx } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { NOISE_TYPES } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { NoiseViz } from "./NoiseViz";
import { useFrameSync } from "./useFrameSync";
import { usePulse } from "./usePulse";

// NOISE riser surface — the climbing sweep WYSIWYG, the shared cells, and a foot strip holding
// TYPE. Mirrors the family contract (Viz → knobs → mode row), reuses the .sat-* classes.
//
// ★ Three deviations from the rack's own laws, fixed together:
//   • The TYPE row OPENED the panel. Every other device's mode select is the LAST thing in it —
//     a row of pill buttons directly under FxStrip's own device tabs reads as one continuous
//     stack of tabs, which is exactly why the saturator's row was moved to the foot.
//   • TYPE was three peers where the rack collapses a value-selector into ONE cycler chip with
//     .cyc-pips, and RISE — a genuine toggle, and the single most consequential control here —
//     sat among them wearing the PUNISH accent, reading as a fourth colour of noise.
//   • BARS was conditionally rendered on RISE, so toggling RISE reflowed the knob row. RISE folds
//     into the BARS cell instead: a TAP flips it, the same idiom RATE uses for SYNC and GATE's
//     SHIFT uses for ALIGN. The cell is always there, and it says MANUAL when there is no build
//     to count — which is more informative than an empty space where a control used to be.

interface NoisePanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
}

export function NoisePanel({ deck, id, slot, accent }: NoisePanelProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const dev = deck.fxDeviceAt(slot) as NoiseFx | undefined;
  if (!dev) return null;
  const get = (p: string) => dev.getParam(p);
  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
    refresh();
  };
  // ★ The XY pad drags continuously — see useFrameSync.
  const pushFrame = useFrameSync((param, value) => emit({ kind: "fxParam", deck: id, slot, param, value }), refresh);
  const live = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    pushFrame(param, value);
  };
  const type = Math.round(get("type"));
  const rise = get("rise") >= 0.5;
  const [typePulse, pulseType] = usePulse();

  return (
    <div className="fx-panel sat-panel" style={{ ["--accent" as string]: accent }}>
      {/* The sweep response climbs over the live noise; XY pad (X=SWEEP, Y=RES). */}
      <NoiseViz deck={deck} slot={slot} accent={accent} set={live} />

      <div className="sat-shared">
        <ValueCell label="SWEEP" value={get("sweep")} min={0} max={1} onChange={(v) => setParam("sweep", v)} format={() => `${dev.sweepHz < 1000 ? Math.round(dev.sweepHz) : `${(dev.sweepHz / 1000).toFixed(1)}k`}`} />
        <ValueCell label="RES" value={get("res")} min={0} max={1} onChange={(v) => setParam("res", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="TONE" value={get("tone")} min={0} max={1} onChange={(v) => setParam("tone", v)} format={(v) => `${Math.round(v * 100)}`} />
        {/* BARS holds RISE: a tap flips auto-build vs a manual gate, a drag sets the build length.
            Present in both states — the tick scale shows which one you're in, and the value reads
            MANUAL when there is nothing to count. */}
        <ValueCell
          label="BARS"
          value={get("bars")}
          min={1}
          max={8}
          step={1}
          onChange={(v) => setParam("bars", v)}
          format={(v) => (rise ? `${Math.round(v)}` : "MAN")}
          onTap={() => setParam("rise", rise ? 0 : 1)}
          active={rise}
        >
          <div className="range-ticks">
            <span className={`range-tick ${!rise ? "active" : ""}`} />
            <span className={`range-tick ${rise ? "active" : ""}`} />
          </div>
        </ValueCell>
      </div>

      {/* The foot strip — same position and language as every other device. */}
      <div className="sat-styles">
        <button
          className={`cyc active ${typePulse}`}
          onClick={() => {
            setParam("type", (type + 1) % NOISE_TYPES.length);
            pulseType();
          }}
          title={`Noise colour — tap to cycle: ${NOISE_TYPES.join(" / ")}`}
        >
          {NOISE_TYPES[type] ?? "?"}
          <span className="cyc-pips" aria-hidden="true">
            {NOISE_TYPES.map((t, i) => (
              <i key={t} className={i === type ? "on" : ""} />
            ))}
          </span>
        </button>
      </div>
    </div>
  );
}
