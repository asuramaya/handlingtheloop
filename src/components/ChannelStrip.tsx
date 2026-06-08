import type { Deck } from "../audio/Deck";
import { EQ_MAX_DB, EQ_MIN_DB } from "../audio/Eq3";
import { Knob } from "./Knob";
import { Fader } from "./Fader";

interface ChannelStripProps {
  id: "A" | "B";
  deck: Deck;
  accent: string;
  refresh: () => void;
}

// One mixer channel: TRIM + 3-band EQ knobs over a LEVEL fader, like the center
// section of a DDJ. EQ/trim are write-only to the engine; level reads from the
// deck so it can be driven elsewhere later.
export function ChannelStrip({ id, deck, accent, refresh }: ChannelStripProps) {
  return (
    <div className="chan" style={{ ["--accent" as string]: accent }}>
      <span className="chan-id">{id}</span>
      <Knob label="TRIM" value={0} min={-12} max={12} defaultValue={0} onChange={(v) => deck.setTrim(dbToGain(v))} />
      <Knob label="HI" value={0} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={0} onChange={(v) => deck.setEqHigh(v)} />
      <Knob label="MID" value={0} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={0} onChange={(v) => deck.setEqMid(v)} />
      <Knob label="LOW" value={0} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={0} onChange={(v) => deck.setEqLow(v)} />
      <Fader
        className="level"
        label=""
        value={deck.level}
        min={0}
        max={1}
        onChange={(v) => {
          deck.setLevel(v);
          refresh();
        }}
      />
    </div>
  );
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}
