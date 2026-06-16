import { useState } from "react";
import type { Deck, FxKind } from "@htl/audio";
import type { Intent } from "@htl/room";
import { EqCurve } from "./EqCurve";
import { DelayPanel } from "./DelayPanel";

// The deck's channel-strip device rack, as a TAB bar over one full-size device panel (so
// the EQ curve keeps its full height) and a shared BYPASS / RESET / COPY toolbar that acts
// on whichever device is selected. EVERY device — the EQ included — is a first-class member:
// add from the +, remove by RIGHT-CLICKING its tab, reorder later. The EQ is a single
// instance (only one EQ); its params ride the eq* ControlParams while presence/order ride
// the fxRack intent. One device's surface shows at a time.

const KIND_LABEL: Record<string, string> = { eq: "EQ", delay: "DELAY", reverb: "REVERB", chorus: "CHORUS" };
// Effects the palette can add (label shown in the + menu). EQ is only offered when absent
// (single instance); others can stack.
const ADDABLE: { kind: FxKind; label: string }[] = [
  { kind: "eq", label: "EQ" },
  { kind: "delay", label: "Delay" },
];

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
  const [sel, setSel] = useState(0); // selected rack index
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null); // tab being dragged
  const [dragOver, setDragOver] = useState<number | null>(null); // tab the drag is over

  const devices = deck.fxDevices; // the whole chain, in order
  const cur = Math.max(0, Math.min(sel, devices.length - 1));
  const selDev = devices[cur];
  const otherId: "A" | "B" = id === "A" ? "B" : "A";

  const broadcastRack = (which: "A" | "B" = id, d: Deck = deck) => emit({ kind: "fxRack", deck: which, rack: d.fxSnapshot() });

  // Drag a tab to reorder the chain. The dragged device stays selected as it moves.
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    deck.moveFx(from, to);
    broadcastRack();
    setSel(to);
    refresh();
  };

  const addDevice = (kind: FxKind) => {
    const added = deck.addFx(kind);
    setPaletteOpen(false);
    if (!added) return; // unknown, or the single EQ is already present
    broadcastRack();
    setSel(deck.fxDevices.indexOf(added));
    refresh();
  };
  const removeAt = (i: number) => {
    deck.removeFxAt(i);
    broadcastRack();
    setSel(Math.max(0, i - 1));
    refresh();
  };

  // --- shared toolbar (acts on the selected device) ---
  const isEq = selDev?.kind === "eq";
  const bypassed = isEq ? deck.eqBypassed : !!selDev?.bypassed;
  const toggleBypass = () => {
    if (!selDev) return;
    if (isEq) {
      deck.setEqBypass(!deck.eqBypassed);
      emit({ kind: "toggle", deck: id, param: "eqBypass", value: deck.eqBypassed });
    } else {
      deck.setFxBypass(cur, !selDev.bypassed);
      emit({ kind: "fxBypass", deck: id, slot: cur, value: selDev.bypassed });
    }
    refresh();
  };
  const reset = () => {
    if (!selDev) return;
    if (isEq) {
      deck.resetEq();
      emitControls(id);
      emit({ kind: "toggle", deck: id, param: "eqBypass", value: false });
    } else {
      deck.resetFxAt(cur);
      broadcastRack(); // params + bypass changed → resync the chain
    }
    refresh();
  };
  const copyToOther = () => {
    if (!selDev) return;
    deck.copyFxTo(otherDeck, cur); // ensures the other deck has the same device + params
    broadcastRack(otherId, otherDeck); // presence/order/effect-params
    emitControls(otherId); // eq params (and the rest of the other deck's control state)
    refresh();
  };

  return (
    <div className="fx-strip" style={{ ["--accent" as string]: accent }}>
      <div className="fx-tabs" role="tablist">
        {devices.map((d, i) => (
          <button
            key={i}
            className={`fx-tab ${cur === i ? "sel" : ""} ${d.bypassed || (d.kind === "eq" && deck.eqBypassed) ? "bypassed" : ""} ${dragOver === i && dragFrom !== i ? "drag-over" : ""} ${dragFrom === i ? "dragging" : ""}`}
            onClick={() => setSel(i)}
            onContextMenu={(e) => {
              e.preventDefault();
              removeAt(i);
            }}
            draggable
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (dragFrom == null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOver !== i) setDragOver(i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom != null) reorder(dragFrom, i);
              setDragFrom(null);
              setDragOver(null);
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDragOver(null);
            }}
            role="tab"
            aria-selected={cur === i}
            title="Drag to reorder · right-click to remove"
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
              {ADDABLE.filter((a) => a.kind !== "eq" || !deck.hasFxKind("eq")).map((a) => (
                <button key={a.kind} className="fx-palette-item" onClick={() => addDevice(a.kind)} role="menuitem">
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="fx-stage">
        {!selDev ? (
          <div className="fx-panel fx-unknown">No effects — add one with +</div>
        ) : selDev.kind === "eq" ? (
          <EqCurve deck={deck} id={id} accent={accent} otherDeck={otherDeck} otherAccent={otherAccent} emit={emit} />
        ) : selDev.kind === "delay" ? (
          <DelayPanel deck={deck} id={id} slot={cur} accent={accent} emit={emit} refresh={refresh} />
        ) : (
          <div className="fx-panel fx-unknown">This effect isn’t available in this build.</div>
        )}
      </div>

      {/* Shared device toolbar — same shell for every effect (reuses the EQ tool styling). */}
      {selDev && (
        <div className="eq-tools">
          <button className={`eq-tool bypass ${bypassed ? "on" : ""}`} title="Bypass this device (A/B)" onClick={toggleBypass}>
            BYPASS
          </button>
          <button className="eq-tool reset" title="Reset this device" onClick={reset}>
            RESET
          </button>
          <button className="eq-tool copy" title={`Copy this device to deck ${otherId}`} onClick={copyToOther}>
            COPY
          </button>
        </div>
      )}
    </div>
  );
}
