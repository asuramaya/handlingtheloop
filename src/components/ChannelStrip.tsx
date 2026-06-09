import type { Deck } from "@htl/audio";
import { EQ_MAX_DB, EQ_MIN_DB } from "@htl/audio";
import { Knob } from "./Knob";
import { Fader } from "./Fader";

interface ChannelStripProps {
  id: "A" | "B";
  deck: Deck;
  accent: string;
  tempoRange: number;
  mirror?: boolean;
  onCycleTempoRange: () => void;
  refresh: () => void;
}

// Full center-mixer channel strip: the TEMPO (pitch) fader and the channel LEVEL
// fader flank a column of knobs — TRIM, the one-knob FILTER (HP/LP), and the
// 3-band EQ. `mirror` flips deck B so the two strips are symmetric, with both
// tempo faders on the outer edges and both level faders by the crossfader.
export function ChannelStrip({ id, deck, accent, tempoRange, mirror, onCycleTempoRange, refresh }: ChannelStripProps) {
  return (
    <div className={`chan ${mirror ? "mirror" : ""}`} style={{ ["--accent" as string]: accent }}>
      <span className="chan-id">{id}</span>
      <div className="chan-row">
        <div className="chan-pitch">
          <Fader
            className="pitch"
            label="TEMPO"
            value={deck.tempo}
            min={-tempoRange}
            max={tempoRange}
            step={0.05}
            onChange={(v) => {
              deck.setTempo(v);
              refresh();
            }}
            format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
          />
          <button className="tempo-width mini" title="Tempo fader range (±%)" onClick={onCycleTempoRange}>
            ±{tempoRange}
          </button>
        </div>
        <div className="chan-knobs">
          <Knob label="TRIM" value={gainToDb(deck.trim)} min={-12} max={12} defaultValue={0} onChange={(v) => deck.setTrim(dbToGain(v))} format={db} />
          <Knob label="HI" value={deck.eqHigh} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={0} onChange={(v) => deck.setEqHigh(v)} format={db} />
          <Knob label="MID" value={deck.eqMid} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={0} onChange={(v) => deck.setEqMid(v)} format={db} />
          <Knob label="LOW" value={deck.eqLow} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={0} onChange={(v) => deck.setEqLow(v)} format={db} />
          <Knob
            label="FILTER"
            value={deck.filterValue}
            min={-1}
            max={1}
            defaultValue={0}
            onChange={(v) => deck.setFilter(v)}
            format={(v) => (Math.abs(v) < 0.02 ? "—" : v < 0 ? "LP" : "HP")}
          />
        </div>
        <Fader
          className="level"
          label="LVL"
          value={deck.level}
          min={0}
          max={1}
          onChange={(v) => {
            deck.setLevel(v);
            refresh();
          }}
          format={(v) => `${Math.round(v * 100)}`}
        />
      </div>
    </div>
  );
}

// Compact dB readout for the EQ / trim knobs (signed, no decimals).
function db(v: number): string {
  return `${v > 0 ? "+" : ""}${Math.round(v)}`;
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -12;
}
