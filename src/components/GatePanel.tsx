import type { Deck, GateFx } from "@htl/audio";
import { GATE_SHAPES } from "@htl/audio";
import type { Intent } from "@htl/room";
import { ValueCell } from "./ValueCell";
import { GateViz } from "./GateViz";

// Trance GATE surface — SHAPE selector + SYNC toggle, the sweeping gate-envelope WYSIWYG, and
// the shared cells (RATE / DEPTH / DUTY / SMOOTH / MIX). Mirrors the Mod/Sat/Crush contract and
// reuses the .sat-* layout classes.

interface GatePanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
  emit: (intent: Intent) => void;
  refresh: () => void;
}

export function GatePanel({ deck, id, slot, accent, emit, refresh }: GatePanelProps) {
  const dev = deck.fxDeviceAt(slot) as GateFx | undefined;
  if (!dev) return null;
  const get = (p: string) => dev.getParam(p);
  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
    refresh();
  };
  const shape = Math.round(get("shape"));
  const sync = get("sync") >= 0.5;

  return (
    <div className="fx-panel sat-panel" style={{ ["--accent" as string]: accent }}>
      <div className="sat-styles">
        {GATE_SHAPES.map((s, i) => (
          <button key={s} className={shape === i ? "active" : ""} onClick={() => setParam("shape", i)} title="Gate shape">
            {s}
          </button>
        ))}
        <button className={`sat-punish ${sync ? "active" : ""}`} onClick={() => setParam("sync", sync ? 0 : 1)} title="Sync the rate to the deck tempo">
          SYNC
        </button>
      </div>

      {/* The gate envelope sweeps under a playhead; an XY pad (X=RATE, Y=DEPTH). */}
      <GateViz deck={deck} slot={slot} accent={accent} set={setParam} />

      <div className="sat-shared">
        <ValueCell label="RATE" value={get("rate")} min={0} max={1} onChange={(v) => setParam("rate", v)} format={() => (sync ? dev.divLabel : `${dev.freqHz.toFixed(1)}`)} />
        <ValueCell label="DEPTH" value={get("depth")} min={0} max={1} onChange={(v) => setParam("depth", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="DUTY" value={get("duty")} min={0} max={1} onChange={(v) => setParam("duty", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="SMOOTH" value={get("smooth")} min={0} max={1} onChange={(v) => setParam("smooth", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="MIX" value={get("mix")} min={0} max={1} onChange={(v) => setParam("mix", v)} format={(v) => `${Math.round(v * 100)}`} />
      </div>
    </div>
  );
}
