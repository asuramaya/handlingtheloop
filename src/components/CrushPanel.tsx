import type { Deck, CrushFx } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { CRUSH_MODES } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { CrushViz } from "./CrushViz";
import { useFrameSync } from "./useFrameSync";

// Minimal Bitcrusher surface (Phase 1) — MODE selector + the shared controls, mutated on the
// deck's device and broadcast as fxParam. Phase 2 drops the CrushViz pixel scope in above the
// cells. Mirrors the Saturator/Delay panel contract. Reuses the .sat-* layout classes.

interface CrushPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
}

export function CrushPanel({ deck, id, slot, accent }: CrushPanelProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const dev = deck.fxDeviceAt(slot) as CrushFx | undefined;
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
  const mode = Math.round(get("mode"));

  return (
    <div className="fx-panel sat-panel" style={{ ["--accent" as string]: accent }}>
      {/* Pixel scope — live staircase over the quantization grid; also an XY pad (X=RATE, Y=BITS). */}
      <CrushViz deck={deck} slot={slot} accent={accent} set={live} />

      <div className="sat-shared">
        <ValueCell label="BITS" value={get("bits")} min={0} max={1} onChange={(v) => setParam("bits", v)} format={() => dev.bitsValue.toFixed(1)} />
        <ValueCell label="RATE" value={get("rate")} min={0} max={1} onChange={(v) => setParam("rate", v)} format={() => `${dev.rateDiv.toFixed(0)}×`} />
        <ValueCell label="JITTER" value={get("jitter")} min={0} max={1} onChange={(v) => setParam("jitter", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="CUT" value={get("cut")} min={0} max={1} onChange={(v) => setParam("cut", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="RES" value={get("res")} min={0} max={1} onChange={(v) => setParam("res", v)} format={(v) => `${Math.round(v * 100)}`} />
      </div>

      {/* Mode select, bottom — same foot-strip position as every other device's mode row (SAT's
          STYLE row lives here too). */}
      <div className="sat-styles">
        {CRUSH_MODES.map((m, i) => (
          <button key={m} className={mode === i ? "active" : ""} onClick={() => setParam("mode", i)}>
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}
