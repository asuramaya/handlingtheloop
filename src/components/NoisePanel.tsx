import type { Deck, NoiseFx } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { NOISE_TYPES } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { NoiseViz } from "./NoiseViz";
import { useFrameSync } from "./useFrameSync";

// NOISE riser surface — TYPE selector + RISE toggle, the climbing sweep WYSIWYG, and the shared
// cells (SWEEP / RES / TONE / BARS / MIX). Mirrors the family contract, reuses the .sat-* classes.

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

  return (
    <div className="fx-panel sat-panel" style={{ ["--accent" as string]: accent }}>
      <div className="sat-styles">
        {NOISE_TYPES.map((t, i) => (
          <button key={t} className={type === i ? "active" : ""} onClick={() => setParam("type", i)} title="Noise colour">
            {t}
          </button>
        ))}
        <button className={`sat-punish ${rise ? "active" : ""}`} onClick={() => setParam("rise", rise ? 0 : 1)} title="RISE: the throw auto-builds over BARS (tempo-synced). Off = manual gate at SWEEP.">
          RISE
        </button>
      </div>

      {/* The sweep response climbs over the live noise; XY pad (X=SWEEP, Y=RES). */}
      <NoiseViz deck={deck} slot={slot} accent={accent} set={live} />

      <div className="sat-shared">
        <ValueCell label="SWEEP" value={get("sweep")} min={0} max={1} onChange={(v) => setParam("sweep", v)} format={() => `${dev.sweepHz < 1000 ? Math.round(dev.sweepHz) : `${(dev.sweepHz / 1000).toFixed(1)}k`}`} />
        <ValueCell label="RES" value={get("res")} min={0} max={1} onChange={(v) => setParam("res", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="TONE" value={get("tone")} min={0} max={1} onChange={(v) => setParam("tone", v)} format={(v) => `${Math.round(v * 100)}`} />
        {rise && <ValueCell label="BARS" value={get("bars")} min={1} max={8} step={1} onChange={(v) => setParam("bars", v)} format={(v) => `${Math.round(v)}`} />}
      </div>
    </div>
  );
}
