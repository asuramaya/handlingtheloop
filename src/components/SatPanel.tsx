import type { Deck } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { SAT_STYLES } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { SatViz } from "./SatViz";
import { useFrameSync } from "./useFrameSync";

// Minimal Saturator surface (Phase 1) — per-band DRIVE + the shared controls, mutated on the
// deck's device and broadcast as fxParam (a session converges; an old client ignores the
// unknown kind). Phase 2 replaces this with the SatViz WYSIWYG (frequency display + draggable
// crossovers + transfer-curve inset). Mirrors the Delay/Reverb panel contract exactly.

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
  if (!dev) return null;
  const get = (p: string) => dev.getParam(p);

  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
    refresh();
  };
  // ★ The XY pad drags continuously — a pointermove-rate emit+refresh spends the frame budget
  // re-rendering the deck instead of painting the drag, and floods the socket. See useFrameSync.
  const pushFrame = useFrameSync((param, value) => emit({ kind: "fxParam", deck: id, slot, param, value }), refresh);
  const live = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    pushFrame(param, value);
  };
  const style = Math.round(get("style"));
  const punish = get("punish") >= 0.5;

  return (
    <div className="fx-panel sat-panel" style={{ ["--accent" as string]: accent }}>
      <div className="sat-styles">
        {SAT_STYLES.map((s, i) => (
          <button key={s} className={style === i ? "active" : ""} onClick={() => setParam("style", i)}>
            {s}
          </button>
        ))}
        <button className={`sat-punish ${punish ? "active" : ""}`} onClick={() => setParam("punish", punish ? 0 : 1)} title="Push the curve into its hot region">
          PUNISH
        </button>
      </div>

      {/* WYSIWYG: log-freq display — drag a crossover line to retune the split, drag inside a
          band to set its drive; the transfer curve reads out bottom-right. */}
      <SatViz deck={deck} slot={slot} accent={accent} set={live} />

      <div className="sat-shared">
        <ValueCell label="BIAS" value={get("bias")} min={0} max={1} onChange={(v) => setParam("bias", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="TONE" value={get("tone")} min={0} max={1} pivot={0.5} onChange={(v) => setParam("tone", v)} format={(v) => `${Math.round((v - 0.5) * 200)}`} />
        <ValueCell label="OUT" value={get("out")} min={0} max={1} pivot={0.5} onChange={(v) => setParam("out", v)} format={(v) => `${Math.round((v - 0.5) * 200)}`} />
      </div>
    </div>
  );
}
