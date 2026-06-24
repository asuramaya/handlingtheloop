import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { Deck, FxKind } from "@htl/audio";
import { loadFxPresets, saveFxPreset, renameFxPreset, deleteFxPreset } from "@htl/audio";
import type { Intent } from "@htl/room";
import { EqCurve } from "./EqCurve";
import { DelayPanel } from "./DelayPanel";
import { ReverbPanel } from "./ReverbPanel";
import { SatPanel } from "./SatPanel";
import { CrushPanel } from "./CrushPanel";
import { ModPanel } from "./ModPanel";
import { GatePanel } from "./GatePanel";
import { NoisePanel } from "./NoisePanel";
import { PromptModal } from "./Dialog";

// The deck's channel-strip device rack, as a TAB bar over one full-size device panel (so
// the EQ curve keeps its full height) and a shared BYPASS / RESET / COPY toolbar that acts
// on whichever device is selected. EVERY device — the EQ included — is a first-class member:
// add from the +, remove by RIGHT-CLICKING its tab, reorder later. The EQ is a single
// instance (only one EQ); its params ride the eq* ControlParams while presence/order ride
// the fxRack intent. One device's surface shows at a time.

const KIND_LABEL: Record<string, string> = { eq: "EQ", delay: "DELAY", reverb: "REVERB", chorus: "CHORUS", saturator: "SAT", crush: "CRUSH", mod: "MOD", gate: "GATE", noise: "NOISE" };
// Effects the palette can add (label shown in the + menu). EQ is only offered when absent
// (single instance); others can stack.
const ADDABLE: { kind: FxKind; label: string }[] = [
  { kind: "eq", label: "EQ" },
  { kind: "delay", label: "Delay" },
  { kind: "reverb", label: "Reverb" },
  { kind: "saturator", label: "Saturator" },
  { kind: "crush", label: "Bitcrusher" },
  { kind: "mod", label: "Modulation" },
  { kind: "gate", label: "Gate" },
  { kind: "noise", label: "Noise" },
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
  onSelect?: (i: number) => void; // report the selected rack index up (so the gamepad can bypass it)
  ctlRef?: MutableRefObject<FxStripCtl | null>; // hardware (FLX BEAT FX) drives selection + add-mode
}

// What the FLX BEAT FX section drives on a strip: BEAT ◀▶ navigate, FX SELECT add-mode + commit.
export interface FxStripCtl {
  navSel: (dir: number) => void; // move the selected tab — or the add candidate while in add-mode
  selectPress: () => void; // FX SELECT: 1st press arms add-mode, 2nd commits the candidate
}

export function FxStrip({ deck, id, accent, otherDeck, otherAccent, emit, emitControls, refresh, onSelect, ctlRef }: FxStripProps) {
  const [sel, setSel] = useState(0); // selected rack index
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null); // tab being dragged
  const [dragOver, setDragOver] = useState<number | null>(null); // tab the drag is over
  const [menu, setMenu] = useState<{ slot: number; x: number; y: number } | null>(null); // preset menu
  const [presetTick, setPresetTick] = useState(0); // bump to re-read presets after save/delete
  // Styled name prompt (replaces window.prompt) for saving / renaming a preset.
  const [dialog, setDialog] = useState<{ mode: "save"; kind: FxKind; params: Record<string, number> } | { mode: "rename"; kind: FxKind; name: string } | null>(null);

  const devices = deck.fxDevices; // the whole chain, in order
  const cur = Math.max(0, Math.min(sel, devices.length - 1));
  const selDev = devices[cur];
  useEffect(() => onSelect?.(cur), [cur, onSelect]); // keep App's per-deck "current FX" ref in sync
  const otherId: "A" | "B" = id === "A" ? "B" : "A";

  const broadcastRack = (which: "A" | "B" = id, d: Deck = deck) => emit({ kind: "fxRack", deck: which, rack: d.fxSnapshot() });

  // Drag a tab to reorder the chain. The dragged device stays selected as it moves.
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    deck.moveFx(from, to);
    broadcastRack();
    setSel(from < to ? to - 1 : to); // follow the device to where it actually landed (insert-before)
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
  // --- BEAT FX add-mode: FX SELECT arms it, BEAT ◀▶ cycle the effect to add, FX SELECT commits ---
  const [addMode, setAddMode] = useState(false);
  const [cand, setCand] = useState(0); // index into the addable list while in add-mode
  const addable = useMemo(() => ADDABLE.filter((a) => !deck.hasFxKind(a.kind)), [deck, devices.length]);
  // Refs so the imperative ctl always reads current values (no stale closure per render).
  const live = useRef({ cur, addMode, cand, addable, len: devices.length });
  live.current = { cur, addMode, cand, addable, len: devices.length };
  useEffect(() => {
    if (!ctlRef) return;
    ctlRef.current = {
      navSel: (dir) => {
        const L = live.current;
        if (L.addMode) {
          if (L.addable.length) setCand((c) => (((c + dir) % L.addable.length) + L.addable.length) % L.addable.length);
        } else {
          setSel((s) => Math.max(0, Math.min(L.len - 1, s + dir)));
        }
      },
      selectPress: () => {
        const L = live.current;
        if (!L.addMode) {
          if (L.addable.length) {
            setCand(0);
            setAddMode(true);
          }
        } else {
          const pick = L.addable[L.cand];
          if (pick) addDevice(pick.kind); // selects the new tab
          setAddMode(false);
        }
      },
    };
    return () => {
      if (ctlRef) ctlRef.current = null;
    };
  }, [ctlRef]);
  // If the addable set empties (all effects present) while armed, drop add-mode.
  useEffect(() => {
    if (addMode && addable.length === 0) setAddMode(false);
    else if (cand >= addable.length) setCand(0);
  }, [addMode, addable.length, cand]);

  const removeAt = (i: number) => {
    deck.removeFxAt(i);
    broadcastRack();
    setSel(Math.max(0, i - 1));
    refresh();
  };

  // --- presets (right-click an effect tab) ---
  const menuDev = menu ? deck.fxDeviceAt(menu.slot) : null;
  const menuPresets = useMemo(() => (menuDev ? loadFxPresets(menuDev.kind) : []), [menuDev, presetTick]);
  const openPresetMenu = (e: React.MouseEvent, slot: number) => {
    e.preventDefault();
    setSel(slot);
    setMenu({ slot, x: e.clientX, y: e.clientY });
  };
  // Sync after a param change: the EQ rides the eq* ControlParams (emitControls), every other
  // device rides the fxRack snapshot (params + bypass).
  const syncDevice = (d: { kind: FxKind }) => {
    if (d.kind === "eq") emitControls(id);
    else broadcastRack();
  };
  const applyPreset = (slot: number, params: Record<string, number>) => {
    const d = deck.fxDeviceAt(slot);
    if (!d) return;
    for (const k in params) deck.setFxParam(slot, k, params[k]);
    syncDevice(d);
    setMenu(null);
    refresh();
  };
  const applyDefault = (slot: number) => {
    const d = deck.fxDeviceAt(slot);
    if (!d) return;
    deck.resetFxAt(slot);
    if (d.kind === "eq") emit({ kind: "toggle", deck: id, param: "eqBypass", value: false });
    syncDevice(d);
    setMenu(null);
    refresh();
  };
  const saveCurrent = (slot: number) => {
    const d = deck.fxDeviceAt(slot);
    if (!d) return;
    setMenu(null);
    setDialog({ mode: "save", kind: d.kind, params: d.snapshotParams() });
  };
  const renamePreset = (kind: FxKind, name: string) => {
    setMenu(null);
    setDialog({ mode: "rename", kind, name });
  };
  const deletePreset = (kind: FxKind, name: string) => {
    deleteFxPreset(kind, name);
    setPresetTick((t) => t + 1); // keep the menu open, just drop the row
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
    <div className={`fx-strip ${addMode ? "add-mode" : ""}`} style={{ ["--accent" as string]: accent }}>
      {addMode && (
        // BEAT FX add-mode banner: ◀ candidate ▶, FX SELECT to add. Hardware-driven; also clickable.
        <div className="fx-addbar" role="status">
          <button className="fx-addbar-arrow" onClick={() => ctlRef?.current?.navSel(-1)} aria-label="Previous effect">◀</button>
          <button className="fx-addbar-pick" onClick={() => ctlRef?.current?.selectPress()} title="Add this effect">
            ＋ {addable[cand]?.label ?? "—"}
          </button>
          <button className="fx-addbar-arrow" onClick={() => ctlRef?.current?.navSel(1)} aria-label="Next effect">▶</button>
        </div>
      )}
      <div className="fx-tabs" role="tablist">
        {devices.map((d, i) => (
          <button
            key={d.kind}
            className={`fx-tab ${cur === i ? "sel" : ""} ${d.bypassed || (d.kind === "eq" && deck.eqBypassed) ? "bypassed" : ""} ${dragOver === i && dragFrom !== i ? "drag-over" : ""} ${dragFrom === i ? "dragging" : ""}`}
            onClick={() => setSel(i)}
            onContextMenu={(e) => openPresetMenu(e, i)}
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
            title="Drag to reorder · right-click for presets"
          >
            {KIND_LABEL[d.kind] ?? d.kind.toUpperCase()}
          </button>
        ))}
        <div className="fx-add-wrap">
          {selDev && !isEq && (
            // The EQ is the permanent channel strip — no remove. Optional effects below it do.
            <button className="fx-tab fx-remove" onClick={() => removeAt(cur)} title="Remove the selected effect" aria-label="Remove the selected effect">
              −
            </button>
          )}
          <button className="fx-tab fx-add" onClick={() => setPaletteOpen((o) => !o)} title="Add an effect" aria-haspopup="menu" aria-expanded={paletteOpen}>
            +
          </button>
          {paletteOpen && (
            <div className="fx-palette" role="menu">
              {/* One of each kind per channel — hide any effect already in this rack. */}
              {ADDABLE.filter((a) => !deck.hasFxKind(a.kind)).map((a) => (
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
        ) : selDev.kind === "reverb" ? (
          <ReverbPanel deck={deck} id={id} slot={cur} accent={accent} emit={emit} refresh={refresh} />
        ) : selDev.kind === "saturator" ? (
          <SatPanel deck={deck} id={id} slot={cur} accent={accent} emit={emit} refresh={refresh} />
        ) : selDev.kind === "crush" ? (
          <CrushPanel deck={deck} id={id} slot={cur} accent={accent} emit={emit} refresh={refresh} />
        ) : selDev.kind === "mod" ? (
          <ModPanel deck={deck} id={id} slot={cur} accent={accent} emit={emit} refresh={refresh} />
        ) : selDev.kind === "gate" ? (
          <GatePanel deck={deck} id={id} slot={cur} accent={accent} emit={emit} refresh={refresh} />
        ) : selDev.kind === "noise" ? (
          <NoisePanel deck={deck} id={id} slot={cur} accent={accent} emit={emit} refresh={refresh} />
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

      {/* Preset menu — right-click an effect tab. For now: Default + saved snapshots + Save. */}
      {menu && menuDev && (
        <>
          <div className="fx-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="fx-palette fx-preset-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
            <div className="fx-preset-head">{KIND_LABEL[menuDev.kind] ?? menuDev.kind.toUpperCase()} presets</div>
            <button className="fx-palette-item" role="menuitem" onClick={() => applyDefault(menu.slot)}>
              Default
            </button>
            {menuPresets.length > 0 && <div className="fx-preset-sep" />}
            {menuPresets.map((p) => (
              <div key={p.name} className="fx-preset-row">
                <button className="fx-palette-item fx-preset-apply" role="menuitem" title="Apply" onClick={() => applyPreset(menu.slot, p.params)}>
                  {p.name}
                </button>
                <button className="fx-preset-mini" title="Rename" aria-label="Rename preset" onClick={() => renamePreset(menuDev.kind, p.name)}>
                  ✎
                </button>
                <button className="fx-preset-mini danger" title="Remove" aria-label="Remove preset" onClick={() => deletePreset(menuDev.kind, p.name)}>
                  ✕
                </button>
              </div>
            ))}
            <div className="fx-preset-sep" />
            <button className="fx-palette-item fx-preset-save" role="menuitem" onClick={() => saveCurrent(menu.slot)}>
              ＋ Save current…
            </button>
          </div>
        </>
      )}

      {dialog && (
        <PromptModal
          title={dialog.mode === "save" ? `Save ${KIND_LABEL[dialog.kind] ?? dialog.kind.toUpperCase()} preset` : "Rename preset"}
          initial={dialog.mode === "rename" ? dialog.name : ""}
          placeholder="Preset name"
          submitLabel={dialog.mode === "save" ? "Save" : "Rename"}
          onSubmit={(v) => {
            if (dialog.mode === "save") saveFxPreset(dialog.kind, v, dialog.params);
            else renameFxPreset(dialog.kind, dialog.name, v);
            setPresetTick((t) => t + 1);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
