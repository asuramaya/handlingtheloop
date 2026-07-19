import type { Deck } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { REVERB_STYLES } from "@htl/audio";
import { ReverbViz } from "./ReverbViz";
import { useFrameSync } from "./useFrameSync";

// The Reverb device surface (v5 layout): readout → tone ribbon (FreqRibbon.ts, same primitive the
// delay's tap timeline uses) → an inverted dome hanging DOWN from the ribbon's baseline, tail
// falling away from the source instead of rising from a floor. Grips fan across the arc on the
// same absolute-drag mechanic every dome iteration has used. MIX (wet presence) lives in the
// universal wet/dry fader; a foot strip holds the non-fader switches (FREEZE + MODE). Same
// contract as the Delay/EQ panels: mutate the deck's effect, `emit` the matching fxParam intent
// so a session converges, then `refresh`.


interface ReverbPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
}

export function ReverbPanel({ deck, id, slot, accent }: ReverbPanelProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const dev = deck.fxDeviceAt(slot);
  if (!dev) return null;

  const get = (p: string) => dev.getParam(p);
  const frozen = get("freeze") >= 0.5;
  const styleIdx = Math.max(0, Math.min(REVERB_STYLES.length - 1, Math.round(get("style"))));

  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
  };
  // ★ The dome's grips drag continuously (and the wheel-nudge can burst just as fast) — see
  // useFrameSync.
  const pushFrame = useFrameSync((param, value) => emit({ kind: "fxParam", deck: id, slot, param, value }), refresh);
  const live = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    pushFrame(param, value);
  };
  const toggle = (param: string) => {
    setParam(param, get(param) >= 0.5 ? 0 : 1);
    refresh();
  };
  const cycleStyle = () => {
    setParam("style", (styleIdx + 1) % REVERB_STYLES.length);
    refresh();
  };

  return (
    <div className="fx-panel fx-reverb" style={{ ["--accent" as string]: accent }}>
      <div className="rv-body">
        <ReverbViz size={get("size")} decay={get("decay")} brightness={get("brightness")} predelay={get("predelay")} width={get("width")} lowCut={get("lowCut")} highCut={get("highCut")} mix={get("mix")} drive={get("drive")} duck={get("duck")} character={get("character")} modRate={get("modRate")} style={styleIdx} frozen={frozen} accent={accent} onParam={live} deck={deck} slot={slot} />
      </div>
      <div className="fx-foot">
        <button className="fx-chip fx-chip-mode" onClick={cycleStyle} title="Algorithm voicing — Hall / Room / Plate / Ambient">
          {REVERB_STYLES[styleIdx] ?? "HALL"}
        </button>
        <button className={`fx-chip ${frozen ? "on" : ""}`} onClick={() => toggle("freeze")} title="Freeze — hold the current tail (near-infinite)">
          ❄ FRZ
        </button>
      </div>
    </div>
  );
}
