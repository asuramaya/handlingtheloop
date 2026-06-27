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
import { useLongPress } from "./useLongPress";

// The deck's channel-strip device rack, as a TAB bar over one full-size device panel (so
// the EQ curve keeps its full height) and a shared BYPASS / RESET / COPY toolbar that acts
// on whichever device is selected. EVERY device — the EQ included — is a first-class member:
// add from the +, remove by RIGHT-CLICKING its tab, reorder later. The EQ is a single
// instance (only one EQ); its params ride the eq* ControlParams while presence/order ride
// the fxRack intent. One device's surface shows at a time.

const KIND_LABEL: Record<string, string> = { eq: "EQ", delay: "DELAY", reverb: "REVERB", chorus: "CHORUS", saturator: "SAT", crush: "CRUSH", mod: "MOD", gate: "GATE", noise: "NOISE" };
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

// What the FLX BEAT FX section drives on a strip. Fixed-membership rack → no add/remove; the
// section is a single-effect unit (select / reorder / wet-dry / engage / latch-throw).
export interface FxStripCtl {
  navSel: (dir: number) => void; // BEAT ◀▶: move the selected effect tab
  moveSel: (dir: number) => void; // SHIFT+BEAT ◀▶: reorder the selected effect left/right
  selectKind: (kind: FxKind) => void; // reveal a device's panel by kind (FX pad right-click)
}

export function FxStrip({ deck, id, accent, otherDeck, otherAccent, emit, emitControls, refresh, onSelect, ctlRef }: FxStripProps) {
  const [sel, setSel] = useState(0); // selected rack index
  const [dragFrom, setDragFrom] = useState<number | null>(null); // tab being dragged
  const [dropAt, setDropAt] = useState<number | null>(null); // INSERTION point 0..len (gap the drop lands in)
  const [menu, setMenu] = useState<{ slot: number; x: number; y: number } | null>(null); // preset menu
  const [presetTick, setPresetTick] = useState(0); // bump to re-read presets after save/delete
  // Styled name prompt (replaces window.prompt) for saving / renaming a preset.
  const [dialog, setDialog] = useState<{ mode: "save"; kind: FxKind; params: Record<string, number> } | { mode: "rename"; kind: FxKind; name: string } | null>(null);

  const devices = deck.fxDevices; // the whole chain, in order
  const cur = Math.max(0, Math.min(sel, devices.length - 1));
  const selDev = devices[cur];
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => onSelect?.(cur), [cur, onSelect]); // keep App's per-deck "current FX" ref in sync
  // Bring the selected tab into view in the scrollable row — so revealing an off-screen effect
  // (right-click its FX pad → selectKind) actually surfaces its tab. block:nearest = no page jump.
  useEffect(() => {
    (tabsRef.current?.children[cur] as HTMLElement | undefined)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [cur]);
  // Mouse wheel → horizontal slide on the (scrollbar-less) tab row. Touch drags natively; this
  // just lets a vertical wheel push the row sideways. Non-passive listener so preventDefault can
  // stop the page from scrolling while the cursor's over the row and there's overflow to consume.
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return; // nothing to slide
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      el.scrollLeft += delta;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const otherId: "A" | "B" = id === "A" ? "B" : "A";

  const broadcastRack = (which: "A" | "B" = id, d: Deck = deck) => emit({ kind: "fxRack", deck: which, rack: d.fxSnapshot() });

  // Drag a tab to reorder the chain. The dragged device stays selected as it moves.
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    deck.moveFx(from, to);
    broadcastRack();
    setSel(Math.max(0, Math.min(to, deck.fxDevices.length - 1))); // follow the device to its final index
    refresh();
  };
  // Commit a drag at the current INSERTION point. Removing the source first shifts later
  // slots down one, so insertion point p maps to final index p-1 when dragging rightward.
  const dropHere = () => {
    if (dragFrom != null && dropAt != null) {
      const finalIdx = Math.max(0, Math.min(dragFrom < dropAt ? dropAt - 1 : dropAt, deck.fxDevices.length - 1));
      reorder(dragFrom, finalIdx);
    }
    setDragFrom(null);
    setDropAt(null);
  };

  // The FLX BEAT FX section drives this strip over `ctlRef`. The rack is fixed-membership now
  // (EQ + the permanent pad-FX bank — no add/remove), so the section is a SINGLE-EFFECT unit over
  // the chain: BEAT ◀▶ select / reorder, DEPTH wet/dry, ON/OFF engage, FX SELECT latch-throw
  // (handled in App via the resident bank). The ctl only exposes nav / reorder / reveal here.
  // A ref so the imperative ctl always reads current values (no stale closure per render).
  const live = useRef({ len: devices.length, cur });
  live.current = { len: devices.length, cur };
  useEffect(() => {
    if (!ctlRef) return;
    ctlRef.current = {
      navSel: (dir) => setSel((s) => Math.max(0, Math.min(live.current.len - 1, s + dir))),
      moveSel: (dir) => {
        const L = live.current;
        reorder(L.cur, Math.max(0, Math.min(L.len - 1, L.cur + dir)));
      },
      selectKind: (kind) => {
        const idx = deck.fxDevices.findIndex((d) => d.kind === kind);
        if (idx >= 0) setSel(idx);
      },
    };
    return () => {
      if (ctlRef) ctlRef.current = null;
    };
  }, [ctlRef]);

  // --- presets (right-click an effect tab) ---
  const menuDev = menu ? deck.fxDeviceAt(menu.slot) : null;
  const menuPresets = useMemo(() => (menuDev ? loadFxPresets(menuDev.kind) : []), [menuDev, presetTick]);
  const openPresetMenu = (e: React.MouseEvent, slot: number) => {
    e.preventDefault();
    setSel(slot);
    setMenu({ slot, x: e.clientX, y: e.clientY });
  };
  // Touch has no right-click: long-press a tab to open its preset menu (was desktop-only).
  const tabLong = useLongPress<number>((slot, x, y) => { setSel(slot); setMenu({ slot, x, y }); });
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
    <div className="fx-strip" style={{ ["--accent" as string]: accent }}>
      <div className="fx-tabs" role="tablist" ref={tabsRef}>
        {devices.map((d, i) => (
          <button
            key={d.kind}
            className={`fx-tab ${cur === i ? "sel" : ""} ${d.bypassed || (d.kind === "eq" && deck.eqBypassed) ? "bypassed" : ""} ${dropAt === i ? "drop-before" : ""} ${dropAt === i + 1 ? "drop-after" : ""} ${dragFrom === i ? "dragging" : ""}`}
            onClick={() => { if (tabLong.fired.current) return; setSel(i); }}
            onContextMenu={(e) => openPresetMenu(e, i)}
            {...tabLong.bind(i)}
            draggable
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (dragFrom == null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              // Insertion point = before this tab, or after it (cursor past its midpoint).
              const r = e.currentTarget.getBoundingClientRect();
              const p = e.clientX > r.left + r.width / 2 ? i + 1 : i;
              if (dropAt !== p) setDropAt(p);
            }}
            onDrop={(e) => {
              e.preventDefault();
              dropHere();
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDropAt(null);
            }}
            role="tab"
            aria-selected={cur === i}
            title="Drag to reorder · right-click for presets"
          >
            {KIND_LABEL[d.kind] ?? d.kind.toUpperCase()}
          </button>
        ))}
        {/* Trailing drop zone: lets a drag land AFTER the last tab (otherwise the end slot,
            e.g. right of the EQ, has no tab to drop onto and is unreachable). Only live mid-drag. */}
        {dragFrom != null && (
          <div
            className={`fx-drop-end ${dropAt === devices.length ? "active" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dropAt !== devices.length) setDropAt(devices.length);
            }}
            onDrop={(e) => {
              e.preventDefault();
              dropHere();
            }}
          />
        )}
        {/* Fixed-membership rack: the EQ + the pad-FX bank are permanent residents — no add/remove.
            Reorder by dragging a tab; dial / save presets by right-clicking one. */}
      </div>

      <div className="fx-stage">
        {!selDev ? (
          <div className="fx-panel fx-unknown">Loading effects…</div>
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
