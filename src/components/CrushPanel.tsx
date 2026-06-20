import type { Deck, CrushFx } from "@htl/audio";
import { CRUSH_MODES } from "@htl/audio";
import type { Intent } from "@htl/room";
import { ValueCell } from "./ValueCell";

// Minimal Bitcrusher surface (Phase 1) — MODE selector + the shared controls, mutated on the
// deck's device and broadcast as fxParam. Phase 2 drops the CrushViz pixel scope in above the
// cells. Mirrors the Saturator/Delay panel contract. Reuses the .sat-* layout classes.

interface CrushPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
  emit: (intent: Intent) => void;
  refresh: () => void;
}

export function CrushPanel({ deck, id, slot, accent, emit, refresh }: CrushPanelProps) {
  const dev = deck.fxDeviceAt(slot) as CrushFx | undefined;
  if (!dev) return null;
  const get = (p: string) => dev.getParam(p);
  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
    refresh();
  };
  const mode = Math.round(get("mode"));

  return (
    <div className="fx-panel sat-panel" style={{ ["--accent" as string]: accent }}>
      <div className="sat-styles">
        {CRUSH_MODES.map((m, i) => (
          <button key={m} className={mode === i ? "active" : ""} onClick={() => setParam("mode", i)}>
            {m}
          </button>
        ))}
      </div>

      <div className="sat-shared">
        <ValueCell label="BITS" value={get("bits")} min={0} max={1} onChange={(v) => setParam("bits", v)} format={() => dev.bitsValue.toFixed(1)} />
        <ValueCell label="RATE" value={get("rate")} min={0} max={1} onChange={(v) => setParam("rate", v)} format={() => `${dev.rateDiv.toFixed(0)}×`} />
        <ValueCell label="JITTER" value={get("jitter")} min={0} max={1} onChange={(v) => setParam("jitter", v)} format={(v) => `${Math.round(v * 100)}`} />
      </div>
      <div className="sat-shared">
        <ValueCell label="CUT" value={get("cut")} min={0} max={1} onChange={(v) => setParam("cut", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="RES" value={get("res")} min={0} max={1} onChange={(v) => setParam("res", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="MIX" value={get("mix")} min={0} max={1} reset={1} onChange={(v) => setParam("mix", v)} format={(v) => `${Math.round(v * 100)}`} />
      </div>
    </div>
  );
}
