import type { Deck } from "@htl/audio";
import { REVERB_STYLES } from "@htl/audio";
import type { Intent } from "@htl/room";
import { ValueCell } from "./ValueCell";
import { ReverbViz } from "./ReverbViz";
import { fmtPct } from "../util/format";

// The Reverb device surface (v3 layout): the round decay-rate dome IS the control surface —
// every spatial param is a drag-handle ON it (the EQ-curve pattern, see ReverbViz). Only the
// two non-spatial knobs (MIX, DUCK) keep a numeric cell beside it; a foot strip holds the
// non-fader switches (FREEZE + MODE). Same contract as the Delay/EQ panels: mutate the deck's
// effect, `emit` the matching fxParam intent so a session converges, then `refresh`.


interface ReverbPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
  emit: (intent: Intent) => void;
  refresh: () => void;
}

export function ReverbPanel({ deck, id, slot, accent, emit, refresh }: ReverbPanelProps) {
  const dev = deck.fxDeviceAt(slot);
  if (!dev) return null;

  const get = (p: string) => dev.getParam(p);
  const frozen = get("freeze") >= 0.5;
  const styleIdx = Math.max(0, Math.min(REVERB_STYLES.length - 1, Math.round(get("style"))));

  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
  };
  const tweak = (param: string, value: number) => {
    setParam(param, value);
    refresh();
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
        <ReverbViz size={get("size")} decay={get("decay")} brightness={get("brightness")} predelay={get("predelay")} width={get("width")} lowCut={get("lowCut")} highCut={get("highCut")} mix={get("mix")} drive={get("drive")} duck={get("duck")} character={get("character")} modRate={get("modRate")} frozen={frozen} accent={accent} onParam={tweak} deck={deck} slot={slot} />
        {/* Every spatial param is a drag-handle ON the dome now (the EQ pattern). Only the two
            non-spatial knobs — MIX (wet presence) and DUCK (the breathing sidechain) — keep a
            numeric cell. This also kills the old 12-cell-beside-a-square-dome mobile crush. */}
        <div className="fx-knobs rv-knobs">
          <ValueCell label="MIX" value={get("mix")} min={0} max={1} step={0.01} reset={0.3} onChange={(v) => tweak("mix", v)} format={fmtPct} />
          <ValueCell label="DUCK" value={get("duck")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("duck", v)} format={fmtPct} />
        </div>
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
