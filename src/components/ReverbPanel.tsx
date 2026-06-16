import type { Deck } from "@htl/audio";
import { REVERB_STYLES } from "@htl/audio";
import type { Intent } from "@htl/room";
import { ValueCell } from "./ValueCell";
import { ReverbViz } from "./ReverbViz";

// The Reverb device surface (v2 layout): a 4×3 buttonoid grid on the LEFT, the full round
// decay-rate viz on the RIGHT, and a foot strip for the non-fader switches (FREEZE + MODE).
// Same contract as the Delay/EQ panels: mutate the deck's effect, `emit` the matching fxParam
// intent so a session converges, then `refresh`. Params ride the generic FX bus.

const fmtPct = (v: number) => `${Math.round(v * 100)}`;
const fmtHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`);
const fmtMs = (s: number) => `${Math.round(s * 1000)}`;

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
        <div className="fx-knobs rv-knobs">
          <ValueCell label="SIZE" value={get("size")} min={0} max={1} step={0.01} reset={0.6} onChange={(v) => tweak("size", v)} format={fmtPct} />
          <ValueCell label="DECAY" value={get("decay")} min={0} max={1} step={0.01} reset={0.5} onChange={(v) => tweak("decay", v)} format={fmtPct} />
          <ValueCell label="PREDLY" value={get("predelay")} min={0} max={0.2} step={0.001} reset={0.012} onChange={(v) => tweak("predelay", v)} format={fmtMs} />
          <ValueCell label="MIX" value={get("mix")} min={0} max={1} step={0.01} reset={0.3} onChange={(v) => tweak("mix", v)} format={fmtPct} />
          <ValueCell label="BRIGHT" value={get("brightness")} min={0} max={1} step={0.01} reset={0.6} onChange={(v) => tweak("brightness", v)} format={fmtPct} />
          <ValueCell label="WIDTH" value={get("width")} min={0} max={1.5} step={0.01} reset={1} onChange={(v) => tweak("width", v)} format={fmtPct} />
          <ValueCell label="CHAR" value={get("character")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("character", v)} format={fmtPct} />
          <ValueCell label="RATE" value={get("modRate")} min={0.02} max={6} step={0.02} reset={0.35} onChange={(v) => tweak("modRate", v)} format={(v) => v.toFixed(2)} />
          <ValueCell label="DRIVE" value={get("drive")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("drive", v)} format={fmtPct} />
          <ValueCell label="DUCK" value={get("duck")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("duck", v)} format={fmtPct} />
          <ValueCell label="LO CUT" value={get("lowCut")} min={20} max={2000} step={10} reset={20} onChange={(v) => tweak("lowCut", v)} format={fmtHz} />
          <ValueCell label="HI CUT" value={get("highCut")} min={1000} max={20000} step={100} reset={18000} onChange={(v) => tweak("highCut", v)} format={fmtHz} />
        </div>
        <ReverbViz size={get("size")} decay={get("decay")} brightness={get("brightness")} predelay={get("predelay")} width={get("width")} lowCut={get("lowCut")} highCut={get("highCut")} mix={get("mix")} drive={get("drive")} duck={get("duck")} character={get("character")} modRate={get("modRate")} frozen={frozen} accent={accent} />
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
