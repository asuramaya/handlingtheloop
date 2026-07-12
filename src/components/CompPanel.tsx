import { useEffect, useRef } from "react";
import type { Deck, CompFx } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { COMP_MODES } from "@htl/audio";
import { ValueCell } from "./ValueCell";

// COMP surface — MODE row (GLUE / FET / OPTO / LIMIT), the gain-reduction METER, and the cells.
// The meter is not decoration: a compressor you can't see is a compressor you can't set. Every
// decision you make here — threshold, ratio, how fast it lets go — is a decision about a number
// you can only read off the needle. It runs on its own rAF rather than React state, so a meter
// moving at 60 Hz never re-renders the panel (the WaveformViewport lesson).

interface CompPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
}

const GR_FLOOR = 20; // dB of reduction at the far end of the meter

export function CompPanel({ deck, id, slot, accent }: CompPanelProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
  const barRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLSpanElement>(null);

  // The needle. Imperative + rAF: the meter is the one thing in this panel that moves constantly,
  // and pushing it through React state would re-render the whole rack 60 times a second.
  useEffect(() => {
    if (!dev) return;
    let raf = 0;
    const tick = () => {
      const gr = dev.gainReduction;
      const pct = Math.min(1, gr / GR_FLOOR) * 100;
      if (barRef.current) barRef.current.style.width = `${pct}%`;
      if (readRef.current) readRef.current.textContent = gr < 0.1 ? "0.0" : `−${gr.toFixed(1)}`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dev]);

  if (!dev) return null;
  const get = (p: string) => dev.getParam(p);
  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
    refresh();
  };
  const mode = Math.round(get("mode"));
  const isLimit = mode === 3;
  const auto = get("auto") >= 0.5;
  const ext = get("scExt") >= 0.5;
  const scHp = get("scHp");

  return (
    <div className="fx-panel sat-panel comp-panel" style={{ ["--accent" as string]: accent }}>
      {/* MODE is the instrument, not a preset — each one re-times the ballistics underneath. */}
      <div className="sat-styles">
        {COMP_MODES.map((m, i) => (
          <button key={m} className={mode === i ? "active" : ""} onClick={() => setParam("mode", i)} title={MODE_HINT[i]}>
            {m}
          </button>
        ))}
        <button className={`sat-punish ${auto ? "active" : ""}`} onClick={() => setParam("auto", auto ? 0 : 1)} title="Auto makeup + program-dependent release">
          AUTO
        </button>
      </div>

      {/* Gain reduction — how hard it's actually working, right now. */}
      <div className="comp-meter" title="Gain reduction (dB)">
        <div className="comp-meter-track">
          <div ref={barRef} className="comp-meter-bar" />
        </div>
        <span ref={readRef} className="comp-meter-read">
          0.0
        </span>
        <span className="comp-meter-unit">dB GR</span>
      </div>

      <div className="sat-shared">
        <ValueCell label={isLimit ? "CEIL" : "THRESH"} value={isLimit ? get("ceiling") : get("threshold")} min={isLimit ? -12 : -60} max={0} step={0.5} reset={isLimit ? -0.3 : -18} format={(v) => v.toFixed(1)} onChange={(v) => setParam(isLimit ? "ceiling" : "threshold", v)} />
        {!isLimit && <ValueCell label="RATIO" value={get("ratio")} min={1} max={20} step={0.5} reset={4} format={(v) => `${v.toFixed(1)}:1`} onChange={(v) => setParam("ratio", v)} />}
        <ValueCell label="ATTACK" value={get("attack")} min={0.02} max={100} step={0.02} reset={10} format={(v) => (v < 1 ? `${(v * 1000).toFixed(0)}µs` : `${v.toFixed(1)}ms`)} onChange={(v) => setParam("attack", v)} />
        <ValueCell label="RELEASE" value={get("release")} min={20} max={3000} step={10} reset={250} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`)} onChange={(v) => setParam("release", v)} />
        {!isLimit && <ValueCell label="KNEE" value={get("knee")} min={0} max={24} step={0.5} reset={6} format={(v) => v.toFixed(1)} onChange={(v) => setParam("knee", v)} />}
        <ValueCell label="MAKEUP" value={get("makeup")} min={-12} max={24} step={0.5} reset={0} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`} onChange={(v) => setParam("makeup", v)} />
        {/* THE sidechain high-pass. Without it a kick drum drives the reduction and pumps the whole
            track — this one filter is most of why a buss compressor works. 20 = off. */}
        <ValueCell label="SC-HP" value={scHp || 20} min={20} max={500} step={5} reset={20} format={(v) => (v <= 20 ? "OFF" : `${v.toFixed(0)}`)} onChange={(v) => setParam("scHp", v)} />
        <ValueCell label="LOOK" value={get("lookahead")} min={0} max={10} step={0.1} reset={0} format={(v) => (v <= 0 ? "OFF" : `${v.toFixed(1)}ms`)} onChange={(v) => setParam("lookahead", v)} />
        {/* MIX below 100 is parallel compression — squash it hard, then blend the crushed copy back
            under the untouched one. The New York drum trick, for free. */}
      </div>

      {/* The DJ move: let the OTHER deck drive this deck's compressor, so the incoming track carves
          its own hole instead of two tracks fighting for the same space. */}
      <div className="sat-styles comp-sc">
        <button className={!ext ? "active" : ""} onClick={() => setParam("scExt", 0)} title="Detector listens to this channel">
          SC: INT
        </button>
        <button className={ext ? "active" : ""} onClick={() => setParam("scExt", 1)} title={`Detector listens to deck ${id === "A" ? "B" : "A"} — the other track ducks this one`}>
          SC: DECK {id === "A" ? "B" : "A"}
        </button>
      </div>
    </div>
  );
}

const MODE_HINT = [
  "GLUE — VCA buss compressor. Slow-ish attack lets transients through, auto-release holds the mix together.",
  "FET — microsecond attack. It grabs; it's meant to be heard.",
  "OPTO — fixed attack, two-stage program-dependent release. Never sounds like it's working.",
  "LIMIT — brickwall with lookahead: it sees the peak coming and ducks before it lands.",
];
