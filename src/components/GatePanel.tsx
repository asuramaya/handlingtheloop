import type { Deck, GateFx } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { GATE_SHAPES } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { GateViz } from "./GateViz";
import { useFrameSync } from "./useFrameSync";
import { fxParamIntent } from "@htl/room/fxWire";

// Trance GATE surface — the sweeping gate-envelope WYSIWYG on top, the shared knobs below it,
// SHAPE select at the bottom. Mirrors the Sat/Crush/Mod panel contract (Viz → knobs → mode row).
//
// SYNC folds into the RATE cell instead of sitting as its own pill — the same move MOD's RATE
// got: a TAP toggles it (the cell already shows the result either way, via its own format
// function), with a 2-position .range-ticks scale as the always-visible state readout. Not a
// peer of SHAPE, it's a property of RATE alone.

interface GatePanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
}

export function GatePanel({ deck, id, slot, accent }: GatePanelProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const dev = deck.fxDeviceAt(slot) as GateFx | undefined;
  if (!dev) return null;
  const get = (p: string) => dev.getParam(p);
  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit(fxParamIntent(deck, id, slot, param, value));
    refresh();
  };
  // ★ The XY pad drags continuously — see useFrameSync.
  const pushFrame = useFrameSync((param, value) => emit(fxParamIntent(deck, id, slot, param, value)), refresh);
  const live = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    pushFrame(param, value);
  };
  const shape = Math.round(get("shape"));
  const sync = get("sync") >= 0.5;
  const align = get("align") >= 0.5;

  return (
    <div className="fx-panel sat-panel" style={{ ["--accent" as string]: accent }}>
      {/* The gate envelope sweeps under a playhead; an XY pad (X=RATE, Y=DEPTH). */}
      <GateViz deck={deck} slot={slot} accent={accent} set={live} />

      <div className="sat-shared">
        <ValueCell
          label="RATE"
          value={get("rate")}
          min={0}
          max={1}
          onChange={(v) => setParam("rate", v)}
          format={() => (sync ? dev.divLabel : `${dev.freqHz.toFixed(1)}`)}
          onTap={() => setParam("sync", sync ? 0 : 1)}
        >
          <div className="range-ticks">
            <span className={`range-tick ${!sync ? "active" : ""}`} />
            <span className={`range-tick ${sync ? "active" : ""}`} />
          </div>
        </ValueCell>
        <ValueCell label="DEPTH" value={get("depth")} min={0} max={1} onChange={(v) => setParam("depth", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="DUTY" value={get("duty")} min={0} max={1} onChange={(v) => setParam("duty", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="SMOOTH" value={get("smooth")} min={0} max={1} onChange={(v) => setParam("smooth", v)} format={(v) => `${Math.round(v * 100)}`} />
        {/* SHIFT — where the gate's cycle sits against the bar line, as a fraction of a cycle.
            50% is the offbeat gate, which is a performance move, not a correction. It folds ALIGN
            into itself the same way RATE holds SYNC: a TAP toggles ALIGN (the cell greys to FREE,
            where a shift has nothing to be shifted against), a drag moves the offset. Present in
            both states — a control that vanished in FREE would reflow the row under your finger,
            the rule the MOD panel already settled. */}
        <ValueCell
          label="SHIFT"
          value={get("shift")}
          min={0}
          max={1}
          onChange={(v) => setParam("shift", v)}
          format={(v) => (align ? `${Math.round(v * 100)}` : "—")}
          onTap={() => setParam("align", align ? 0 : 1)}
          active={align}
        >
          <div className="range-ticks">
            <span className={`range-tick ${!align ? "active" : ""}`} />
            <span className={`range-tick ${align ? "active" : ""}`} />
          </div>
        </ValueCell>
      </div>

      {/* Mode select, bottom — same foot-strip position as every other device's mode row. */}
      <div className="sat-styles">
        {GATE_SHAPES.map((s, i) => (
          <button key={s} className={shape === i ? "active" : ""} onClick={() => setParam("shape", i)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
