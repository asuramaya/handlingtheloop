import type { Deck, ModFx } from "@htl/audio";
import { MOD_MODES, MOD_WAVES, MOD_SOURCES } from "@htl/audio";
import type { Intent } from "@htl/room";
import { ValueCell } from "./ValueCell";
import { ModViz } from "./ModViz";

// Minimal Modulation surface (Phase 1) — MODE / SOURCE / WAVE selectors + the shared knobs.
// Phase 2 drops the ModViz (sweeping notch/comb response + LFO inset) in above the cells.
// Mirrors the Sat/Crush panel contract; reuses the .sat-* layout classes.

interface ModPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
  emit: (intent: Intent) => void;
  refresh: () => void;
}

export function ModPanel({ deck, id, slot, accent, emit, refresh }: ModPanelProps) {
  const dev = deck.fxDeviceAt(slot) as ModFx | undefined;
  if (!dev) return null;
  const get = (p: string) => dev.getParam(p);
  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
    refresh();
  };
  const mode = Math.round(get("mode"));
  const src = Math.round(get("src"));
  const wave = Math.round(get("wave"));
  const thru = get("thru") >= 0.5;
  const sync = get("sync") >= 0.5;

  return (
    <div className="fx-panel sat-panel" style={{ ["--accent" as string]: accent }}>
      <div className="sat-styles">
        {MOD_MODES.map((m, i) => (
          <button key={m} className={mode === i ? "active" : ""} onClick={() => setParam("mode", i)}>
            {m}
          </button>
        ))}
      </div>
      <div className="sat-styles">
        {MOD_SOURCES.map((s, i) => (
          <button key={s} className={src === i ? "active" : ""} onClick={() => setParam("src", i)} title="Modulation source: LFO, envelope follower, or both">
            {s}
          </button>
        ))}
        {MOD_WAVES.map((wv, i) => (
          <button key={wv} className={wave === i ? "active" : ""} onClick={() => setParam("wave", i)} title="LFO waveform">
            {wv}
          </button>
        ))}
        {mode === 1 && (
          <button className={`sat-punish ${thru ? "active" : ""}`} onClick={() => setParam("thru", thru ? 0 : 1)} title="Thru-zero: deep null-point flange">
            THRU
          </button>
        )}
        <button className={`sat-punish ${sync ? "active" : ""}`} onClick={() => setParam("sync", sync ? 0 : 1)} title="Sync the LFO rate to the deck tempo (musical divisions) vs free Hz">
          SYNC
        </button>
      </div>

      {/* Live spectrum — the comb/notches sweep with the LFO; LFO waveform in the side panel.
          Also an XY mod pad (X=RATE, Y=DEPTH). */}
      <ModViz deck={deck} slot={slot} accent={accent} set={setParam} />

      <div className="sat-shared">
        <ValueCell label="RATE" value={get("rate")} min={0} max={1} onChange={(v) => setParam("rate", v)} format={() => (sync ? dev.divLabel : `${dev.rateHz.toFixed(2)}`)} />
        <ValueCell label="DEPTH" value={get("depth")} min={0} max={1} onChange={(v) => setParam("depth", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="F.BACK" value={get("feedback")} min={0} max={1} onChange={(v) => setParam("feedback", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="TONE" value={get("tone")} min={0} max={1} pivot={0.5} onChange={(v) => setParam("tone", v)} format={(v) => `${Math.round((v - 0.5) * 200)}`} />
        {mode === 2 && <ValueCell label="STAGES" value={get("stages")} min={2} max={12} step={1} onChange={(v) => setParam("stages", v)} format={(v) => `${Math.round(v)}`} />}
        <ValueCell label="MIX" value={get("mix")} min={0} max={1} onChange={(v) => setParam("mix", v)} format={(v) => `${Math.round(v * 100)}`} />
      </div>
    </div>
  );
}
