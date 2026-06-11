import type { Deck } from "@htl/audio";
import { EQ_MAX_DB, EQ_MIN_DB } from "@htl/audio";
import type { Intent } from "@htl/room";
import { ValueCell } from "./ValueCell";

interface ChannelStripProps {
  id: "A" | "B";
  deck: Deck;
  accent: string;
  mirror?: boolean;
  onFocus: () => void;
  refresh: () => void;
  emit: (intent: Intent) => void; // broadcast the change to a shared session (no-op when off)
}

// Number-cell channel strip — the EQ knobs (TRIM/HI/MID/LOW). `mirror` flips deck B
// so the strips read symmetric about the centre faders. (FX/STEMS/PITCH moved to the
// deck-controls bank; channel volume to MixCenter.)
export function ChannelStrip({ id, deck, accent, mirror, onFocus, refresh, emit }: ChannelStripProps) {
  return (
    <div className={`chan ${mirror ? "mirror" : ""}`} style={{ ["--accent" as string]: accent }} onPointerDownCapture={onFocus}>
      <div className="chan-grid">
        {/* EQ — bipolar (detent 0 dB): TRIM/HI/MID/LOW. */}
        <div className="cbank eq">
          <ValueCell label="TRIM" value={gainToDb(deck.trim)} min={EQ_MIN_DB} max={EQ_MAX_DB} pivot={0} onChange={(v) => { const g = dbToGain(v); deck.setTrim(g); refresh(); emit({ kind: "control", deck: id, param: "trim", value: g }); }} format={db} />
          <ValueCell label="HI" value={deck.eqHigh} min={EQ_MIN_DB} max={EQ_MAX_DB} pivot={0} onChange={(v) => { deck.setEqHigh(v); refresh(); emit({ kind: "control", deck: id, param: "eqHigh", value: v }); }} format={db} />
          <ValueCell label="MID" value={deck.eqMid} min={EQ_MIN_DB} max={EQ_MAX_DB} pivot={0} onChange={(v) => { deck.setEqMid(v); refresh(); emit({ kind: "control", deck: id, param: "eqMid", value: v }); }} format={db} />
          <ValueCell label="LOW" value={deck.eqLow} min={EQ_MIN_DB} max={EQ_MAX_DB} pivot={0} onChange={(v) => { deck.setEqLow(v); refresh(); emit({ kind: "control", deck: id, param: "eqLow", value: v }); }} format={db} />
        </div>

        {/* FX (filter sweep + on/off), STEMS and PITCH all live in the centre
            deck-controls bank now; channel volume + metering in MixCenter. */}
      </div>
    </div>
  );
}

// Compact dB readout for the EQ / trim cells (signed, no decimals).
function db(v: number): string {
  return `${v > 0 ? "+" : ""}${Math.round(v)}`;
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function gainToDb(gain: number): number {
  return gain > 0 ? Math.max(EQ_MIN_DB, 20 * Math.log10(gain)) : EQ_MIN_DB;
}
