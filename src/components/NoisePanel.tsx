import type { Deck, NoiseFx } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { NOISE_DIRS, NOISE_TYPES } from "@htl/audio";
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
  const dir = Math.round(get("dir"));
  const snap = get("snap") >= 0.5;
  const [typePulse, pulseType] = usePulse();
  const [dirPulse, pulseDir] = usePulse();
  const [snapPulse, pulseSnap] = usePulse();

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
        {/* CURVE — the build's SHAPE, which is most of its character: below centre holds back and
            then rushes (the late bloom), above centre leaps and eases in. Two fixed ramps gave
            this device exactly one build, and every riser it made was the same event. */}
        <ValueCell label="CURVE" value={get("curve")} min={0} max={1} pivot={0.5} onChange={(v) => setParam("curve", v)} format={(v) => (v < 0.45 ? "LATE" : v > 0.55 ? "EARLY" : "LIN")} />
        {/* WIDTH — how much of the right channel is its OWN noise rather than a copy of the left.
            0 is mono-safe; 1 is fully decorrelated, which is as wide as noise gets. */}
        <ValueCell label="WIDTH" value={get("width")} min={0} max={1} onChange={(v) => setParam("width", v)} format={(v) => `${Math.round(v * 100)}`} />
        {/* DUCK — pulls the TRACK down as the build climbs. The fader move every DJ makes by hand
            under a riser, on the same envelope as the riser itself. */}
        <ValueCell label="DUCK" value={get("duck")} min={0} max={1} onChange={(v) => setParam("duck", v)} format={(v) => (v <= 0 ? "OFF" : `${Math.round(v * 100)}`)} />
        {/* IMPACT — the hit on release. A riser that ends in silence is half a gesture. */}
        <ValueCell label="IMPACT" value={get("impact")} min={0} max={1} onChange={(v) => setParam("impact", v)} format={(v) => (v <= 0 ? "OFF" : `${Math.round(v * 100)}`)} />
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
        <span className="fx-sep" />
        {/* DIR — UP is the riser, DOWN is the downlifter that goes WITH the drop rather than
            before it. Same envelope, run the other way; the device could only build tension. */}
        <button
          className={`cyc active ${dirPulse}`}
          onClick={() => {
            setParam("dir", (dir + 1) % NOISE_DIRS.length);
            pulseDir();
          }}
          title="Sweep direction — UP: a riser into the drop. DOWN: a downlifter out of it."
        >
          {NOISE_DIRS[dir] ?? "?"}
          <span className="cyc-pips" aria-hidden="true">
            {NOISE_DIRS.map((d, i) => (
              <i key={d} className={i === dir ? "on" : ""} />
            ))}
          </span>
        </button>
        {/* SNAP — quantise the build's END to the bar grid, so it arrives on the one however
            ragged the press was. A real toggle, so it looks like one. */}
        <button
          className={`${snap ? "active" : ""} ${snapPulse}`}
          onClick={() => {
            setParam("snap", snap ? 0 : 1);
            pulseSnap();
          }}
          title="SNAP: land the build's end on the bar grid (the drop), stretching it up to half a bar to fit."
        >
          SNAP
        </button>
      </div>
    </div>
  );
}
