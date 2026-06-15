import { useState } from "react";
import type { Deck, FxKind } from "@htl/audio";
import type { Intent } from "@htl/room";
import { EqCurve } from "./EqCurve";
import { DelayPanel } from "./DelayPanel";

// The deck's channel-strip device rack, as a TAB bar over one full-size panel (so the EQ
// curve keeps its full height). Tabs: EQ · <each effect> · +. The EQ is the pinned first
// device (its own ControlParam sync); effects after it (delay/reverb/chorus) add/remove via
// the fxRack intent and tune via fxParam/fxBypass. One device's surface shows at a time.

const KIND_LABEL: Record<string, string> = { eq: "EQ", delay: "DELAY", reverb: "REVERB", chorus: "CHORUS" };
// Effects the palette can add (EQ is always present, not addable). Grows per build-out.
const ADDABLE: { kind: FxKind; label: string }[] = [{ kind: "delay", label: "Delay" }];

interface FxStripProps {
  deck: Deck;
  id: "A" | "B";
  accent: string;
  otherDeck: Deck;
  otherAccent: string;
  emit: (intent: Intent) => void;
  emitControls: (id: "A" | "B") => void;
  refresh: () => void;
}

export function FxStrip({ deck, id, accent, otherDeck, otherAccent, emit, emitControls, refresh }: FxStripProps) {
  const [sel, setSel] = useState(0); // 0 = EQ; 1..n = effect index + 1
  const [paletteOpen, setPaletteOpen] = useState(false);

  const effects = deck.fxEffects; // post-EQ devices in order
  // Clamp selection if the chain shrank (a removed effect) so we never index past the end.
  const maxSel = effects.length; // EQ at 0, effects at 1..effects.length
  const cur = sel > maxSel ? 0 : sel;

  const broadcastRack = () => emit({ kind: "fxRack", deck: id, rack: deck.fxSnapshot() });

  const addEffect = (kind: FxKind) => {
    deck.addFx(kind);
    broadcastRack();
    setSel(deck.fxEffects.length); // select the newly added one (its tab index = count)
    setPaletteOpen(false);
    refresh();
  };
  const removeEffect = (effectIdx: number) => {
    deck.removeFxAt(effectIdx);
    broadcastRack();
    setSel(0); // fall back to the EQ tab
    refresh();
  };

  return (
    <div className="fx-strip" style={{ ["--accent" as string]: accent }}>
      <div className="fx-tabs" role="tablist">
        <button className={`fx-tab ${cur === 0 ? "sel" : ""}`} onClick={() => setSel(0)} role="tab" aria-selected={cur === 0}>
          EQ
        </button>
        {effects.map((d, i) => (
          <button
            key={i}
            className={`fx-tab ${cur === i + 1 ? "sel" : ""} ${d.bypassed ? "bypassed" : ""}`}
            onClick={() => setSel(i + 1)}
            role="tab"
            aria-selected={cur === i + 1}
            title={d.bypassed ? "Bypassed" : undefined}
          >
            {KIND_LABEL[d.kind] ?? d.kind.toUpperCase()}
          </button>
        ))}
        <div className="fx-add-wrap">
          <button className="fx-tab fx-add" onClick={() => setPaletteOpen((o) => !o)} title="Add an effect" aria-haspopup="menu" aria-expanded={paletteOpen}>
            +
          </button>
          {paletteOpen && (
            <div className="fx-palette" role="menu">
              {ADDABLE.map((a) => (
                <button key={a.kind} className="fx-palette-item" onClick={() => addEffect(a.kind)} role="menuitem">
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="fx-stage">
        {cur === 0 ? (
          <EqCurve
            deck={deck}
            id={id}
            accent={accent}
            otherDeck={otherDeck}
            otherAccent={otherAccent}
            emit={emit}
            emitControls={emitControls}
            refresh={refresh}
          />
        ) : effects[cur - 1]?.kind === "delay" ? (
          <DelayPanel deck={deck} id={id} slot={cur - 1} accent={accent} emit={emit} refresh={refresh} onRemove={() => removeEffect(cur - 1)} />
        ) : (
          <div className="fx-panel fx-unknown">This effect isn’t available in this build.</div>
        )}
      </div>
    </div>
  );
}
