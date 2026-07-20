import { useState } from "react";
import type { Deck } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { SAT_STYLES } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { SatViz } from "./SatViz";
import { useFrameSync } from "./useFrameSync";

// Saturator surface — the SatViz WYSIWYG (frequency display + draggable crossovers +
// transfer-curve inset) plus the per-band STYLE/PUNISH/BIAS subrow for whichever band is
// currently SELECTED (pressing inside a band in SatViz selects it, mirroring the EQ's "touching
// a node selects its band"). Each band carries its own character now — "multiband" used to mean
// only drive varied per band while style/bias/punish were one shared setting for the whole
// device. HEAT/TONE/OUT stay device-wide. Mirrors the Delay/Reverb panel contract otherwise.

interface SatPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number; // rack index of this saturator device
  accent: string;
}

export function SatPanel({ deck, id, slot, accent }: SatPanelProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const dev = deck.fxDeviceAt(slot);
  const [sel, setSel] = useState(1); // band whose subrow is shown (default MID)
  if (!dev) return null;
  const get = (p: string) => dev.getParam(p);

  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
    refresh();
  };
  // ★ Crossover/drive drags are continuous — a pointermove-rate emit+refresh spends the frame
  // budget re-rendering the deck instead of painting the drag, and floods the socket. See useFrameSync.
  const pushFrame = useFrameSync((param, value) => emit({ kind: "fxParam", deck: id, slot, param, value }), refresh);
  const live = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    pushFrame(param, value);
  };

  const style = Math.round(get(`style${sel}`));
  const punish = get(`punish${sel}`) >= 0.5;

  return (
    <div className="fx-panel sat-panel" style={{ ["--accent" as string]: accent }}>
      {/* WYSIWYG: log-freq display — drag a crossover line to retune the split, drag inside a
          band to set its drive AND select it; the transfer curve reads out bottom-right. */}
      <SatViz deck={deck} slot={slot} accent={accent} set={live} sel={sel} onSelect={setSel} />

      {/* Device-wide (TONE/OUT/HEAT) | a divider | BIAS for the SELECTED band — one row, not
          two, since the panel's height budget is shared with every other device in the rack.
          The canvas's own dashed ring is the "which band" indicator; no separate text label. */}
      <div className="sat-shared">
        <ValueCell label="TONE" value={get("tone")} min={0} max={1} pivot={0.5} onChange={(v) => setParam("tone", v)} format={(v) => `${Math.round((v - 0.5) * 200)}`} />
        <ValueCell label="OUT" value={get("out")} min={0} max={1} pivot={0.5} onChange={(v) => setParam("out", v)} format={(v) => `${Math.round((v - 0.5) * 200)}`} />
        <ValueCell label="HEAT" value={get("heat")} min={0} max={1} onChange={(v) => setParam("heat", v)} format={(v) => `${Math.round(v * 100)}`} />
        <div className="fx-sep" />
        <ValueCell label="BIAS" value={get(`bias${sel}`)} min={0} max={1} onChange={(v) => setParam(`bias${sel}`, v)} format={(v) => `${Math.round(v * 100)}`} />
      </div>

      {/* Style select, for the SELECTED band — same foot-strip grammar as every other device's
          mode row. PUNISH is that band's own hot-mode gesture; HEAT (above) sets how hot. */}
      <div className="sat-styles">
        {SAT_STYLES.map((s, i) => (
          <button key={s} className={style === i ? "active" : ""} onClick={() => setParam(`style${sel}`, i)}>
            {s}
          </button>
        ))}
        <button className={`sat-punish ${punish ? "active" : ""}`} onClick={() => setParam(`punish${sel}`, punish ? 0 : 1)} title="Push this band into its hot region (HEAT sets how hot)">
          PUNISH
        </button>
      </div>
    </div>
  );
}
