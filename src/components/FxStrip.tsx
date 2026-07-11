import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useEmit, useRefresh } from "../App/spine";
import type { Deck, FxKind } from "@htl/audio";
import { loadFxPresets, saveFxPreset, renameFxPreset, deleteFxPreset, factoryFxPresets } from "@htl/audio";
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
  emitControls: (id: "A" | "B") => void;
  onSelect?: (i: number) => void; // report the selected rack index up (so the gamepad can bypass it)
  ctlRef?: MutableRefObject<FxStripCtl | null>; // hardware (FLX BEAT FX) drives selection + add-mode
}

// What the FLX BEAT FX section drives on a strip. Fixed-membership rack → no add/remove; the
// section is a single-effect unit (select / reorder / wet-dry / engage / latch-throw).
export interface FxStripCtl {
  navSel: (dir: number) => void; // BEAT ◀▶: move the selected effect tab
  moveSel: (dir: number) => void; // SHIFT+BEAT ◀▶: reorder the selected effect left/right
  selectKind: (kind: FxKind) => void; // reveal a device's panel by kind (FX pad right-click)
  cyclePreset: (dir: number) => void; // FX SELECT: step Default → factory bank → wrap, on the selected effect
  closeMenu: () => void; // dismiss the preset browse (hardware bypass/mix — a DJ never clicks the backdrop)
}

export function FxStrip({ deck, id, accent, otherDeck, otherAccent, emitControls, onSelect, ctlRef }: FxStripProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const [sel, setSel] = useState(0); // selected rack index
  const [dragFrom, setDragFrom] = useState<number | null>(null); // tab being dragged
  const [dropAt, setDropAt] = useState<number | null>(null); // INSERTION point 0..len (gap the drop lands in)
  const [menu, setMenu] = useState<{ slot: number; x: number; y: number } | null>(null); // preset menu (right-click summon)
  const [presetTick, setPresetTick] = useState(0); // bump to re-read presets after save/delete
  // Hardware preset browsing (FLX FX SELECT): a per-kind cursor (0 = Default, 1..N = factory bank)
  // + a brief on-screen flash of the applied preset name (so a hardware DJ sees what they landed on).
  const presetIdxRef = useRef<Record<string, number>>({}); // per-kind cursor (0=Default, 1..N=factory) for hardware FX-SELECT + the menu's active-preset mark
  const menuTimerRef = useRef<number | null>(null); // safety-net auto-dismiss for a HARDWARE-summoned menu (a DJ never clicks the backdrop)
  const menuRef = useRef<HTMLDivElement>(null); // the open preset menu — to keep the active item scrolled into view
  const closeMenu = () => { if (menuTimerRef.current) { clearTimeout(menuTimerRef.current); menuTimerRef.current = null; } setMenu(null); };
  useEffect(() => () => { if (menuTimerRef.current) clearTimeout(menuTimerRef.current); }, []);
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
      navSel: (dir) => {
        if (menuTimerRef.current) { clearTimeout(menuTimerRef.current); menuTimerRef.current = null; }
        setMenu(null); // moving to another effect closes the preset browse
        setSel((s) => Math.max(0, Math.min(live.current.len - 1, s + dir)));
      },
      moveSel: (dir) => {
        const L = live.current;
        reorder(L.cur, Math.max(0, Math.min(L.len - 1, L.cur + dir)));
      },
      selectKind: (kind) => {
        const idx = deck.fxDevices.findIndex((d) => d.kind === kind);
        if (idx >= 0) setSel(idx);
      },
      // FX SELECT (hardware): step the SELECTED effect through Default → its factory bank → wrap,
      // applying each. Reads the live cur (not a stale render closure) and drives the device
      // directly, syncing like a menu apply. `dir` +1/-1 walks forward/back.
      cyclePreset: (dir) => {
        const at = live.current.cur;
        const dev = deck.fxDeviceAt(at);
        if (!dev) return;
        const bank = factoryFxPresets(dev.kind);
        const n = bank.length + 1; // slot 0 = Default, 1..N = factory presets
        let pi = presetIdxRef.current[dev.kind] ?? 0;
        pi = (((pi + dir) % n) + n) % n;
        presetIdxRef.current[dev.kind] = pi;
        const mix = dev.getParam("mix"); // wet/dry is a live performance control — hold it across the browse
        if (pi === 0) {
          deck.resetFxAt(at);
          if (dev.kind === "eq") {
            emit({ kind: "toggle", deck: id, param: "eqBypass", value: false });
            deck.armEqPreset({ name: "Default", params: dev.snapshotParams() }); // browsing also arms the pad
          }
        } else {
          const p = bank[pi - 1];
          for (const k in p.params) if (k !== "mix") deck.setFxParam(at, k, p.params[k]);
          if (dev.kind === "eq") deck.armEqPreset(p);
        }
        deck.setFxParam(at, "mix", mix); // restore the blend for every device incl. EQ (covers the Default reset)
        if (dev.kind === "eq") emitControls(id);
        else broadcastRack();
        // Pop the SAME floaty preset menu a tab right-click opens, anchored under the selected tab, so
        // the hardware browse is VISIBLE — repeated presses walk the highlight down the list.
        const tabEl = tabsRef.current?.children[at] as HTMLElement | undefined;
        const r = tabEl?.getBoundingClientRect();
        if (r) {
          setMenu({ slot: at, x: r.left, y: r.bottom + 4 });
          // Transient browse HUD: dismiss a few seconds after the LAST press (each press resets it).
          // The applied preset persists — the menu is just the visual guide, not a mode.
          if (menuTimerRef.current) clearTimeout(menuTimerRef.current);
          menuTimerRef.current = window.setTimeout(() => setMenu(null), 8000); // long safety net only — each fwd/back press resets it; switching effect closes it outright
        }
        refresh();
      },
      closeMenu,
    };
    return () => {
      if (ctlRef) ctlRef.current = null;
    };
  }, [ctlRef]);

  // --- presets (right-click an effect tab) ---
  const menuDev = menu ? deck.fxDeviceAt(menu.slot) : null;
  const menuPresets = useMemo(() => (menuDev ? loadFxPresets(menuDev.kind) : []), [menuDev, presetTick]);
  const factoryPresets = useMemo(() => (menuDev ? factoryFxPresets(menuDev.kind) : []), [menuDev]); // built-in, read-only
  const activePresetIdx = menuDev ? presetIdxRef.current[menuDev.kind] ?? 0 : 0; // 0 = Default, 1..N = factory (marks the applied one)
  // Keep the active preset scrolled into view as the list is cycled (a hardware browse can walk past
  // the visible window). Scrolls ONLY the menu container — no page jump.
  useEffect(() => {
    const cont = menuRef.current;
    const el = cont?.querySelector<HTMLElement>(".fx-palette-item.sel");
    if (!cont || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < cont.scrollTop) cont.scrollTop = top - 6;
    else if (bottom > cont.scrollTop + cont.clientHeight) cont.scrollTop = bottom - cont.clientHeight + 6;
  }, [menu, activePresetIdx]);
  // Adjusting wet/dry (the FLX BEAT-FX knob or the on-screen MIX cell) dismisses the browse — it means
  // "I'm tuning this now", not still picking. Preset cycling PRESERVES mix, so this never false-fires;
  // EQ has no mix param, and the first observation is skipped.
  const curMix = selDev ? selDev.getParam("mix") : null; // EQ included now that Eq3 maps "mix"
  const lastMixRef = useRef<number | null>(null);
  useEffect(() => {
    if (menu && lastMixRef.current != null && curMix != null && curMix !== lastMixRef.current) closeMenu();
    lastMixRef.current = curMix;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curMix, menu]);
  // Mouse/touch opens are STICKY (dismiss by clicking away or picking) — cancel any pending
  // hardware auto-dismiss so a deliberate open isn't yanked shut mid-browse.
  const cancelMenuTimer = () => { if (menuTimerRef.current) { clearTimeout(menuTimerRef.current); menuTimerRef.current = null; } };
  const openPresetMenu = (e: React.MouseEvent, slot: number) => {
    e.preventDefault();
    cancelMenuTimer();
    setSel(slot);
    setMenu({ slot, x: e.clientX, y: e.clientY });
  };
  // Touch has no right-click: long-press a tab to open its preset menu (was desktop-only).
  const tabLong = useLongPress<number>((slot, x, y) => { cancelMenuTimer(); setSel(slot); setMenu({ slot, x, y }); });
  // Sync after a param change: the EQ rides the eq* ControlParams (emitControls), every other
  // device rides the fxRack snapshot (params + bypass).
  const syncDevice = (d: { kind: FxKind }) => {
    if (d.kind === "eq") emitControls(id);
    else broadcastRack();
  };
  // Picking an EQ preset also ARMS the EQ pad with it — the menu is how you load the curve the
  // pad throws. (Default arms the flat curve, which turns the pad into an A/B: hold flattens
  // your EQ, release brings it back.)
  const armEq = (d: { kind: FxKind; snapshotParams(): Record<string, number> }, name: string, params?: Record<string, number>) => {
    if (d.kind === "eq") deck.armEqPreset({ name, params: params ?? d.snapshotParams() });
  };
  const applyPreset = (slot: number, p: { name: string; params: Record<string, number> }) => {
    const d = deck.fxDeviceAt(slot);
    if (!d) return;
    // Wet/dry (mix) is a LIVE performance control, independent of the preset — leave it alone so
    // browsing presets (esp. on a controller) doesn't jump the blend out from under the DJ.
    for (const k in p.params) if (k !== "mix") deck.setFxParam(slot, k, p.params[k]);
    armEq(d, p.name, p.params);
    syncDevice(d);
    setMenu(null);
    refresh();
  };
  const applyDefault = (slot: number) => {
    const d = deck.fxDeviceAt(slot);
    if (!d) return;
    presetIdxRef.current[d.kind] = 0; // keep the hardware FX-SELECT cursor in sync with a mouse apply
    const mix = d.getParam("mix"); // preserve the live wet/dry across a Default (character resets, blend doesn't)
    deck.resetFxAt(slot);
    deck.setFxParam(slot, "mix", mix); // preserve wet/dry incl. EQ (Eq3 now maps "mix" → setMix)
    if (d.kind === "eq") emit({ kind: "toggle", deck: id, param: "eqBypass", value: false });
    armEq(d, "Default"); // the device is AT its defaults now → snapshot them as the armed curve
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
    closeMenu(); // toggling bypass dismisses the preset browse
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
          <EqCurve deck={deck} id={id} accent={accent} otherDeck={otherDeck} otherAccent={otherAccent} />
        ) : selDev.kind === "delay" ? (
          <DelayPanel deck={deck} id={id} slot={cur} accent={accent} />
        ) : selDev.kind === "reverb" ? (
          <ReverbPanel deck={deck} id={id} slot={cur} accent={accent} />
        ) : selDev.kind === "saturator" ? (
          <SatPanel deck={deck} id={id} slot={cur} accent={accent} />
        ) : selDev.kind === "crush" ? (
          <CrushPanel deck={deck} id={id} slot={cur} accent={accent} />
        ) : selDev.kind === "mod" ? (
          <ModPanel deck={deck} id={id} slot={cur} accent={accent} />
        ) : selDev.kind === "gate" ? (
          <GatePanel deck={deck} id={id} slot={cur} accent={accent} />
        ) : selDev.kind === "noise" ? (
          <NoisePanel deck={deck} id={id} slot={cur} accent={accent} />
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
          <div ref={menuRef} className="fx-palette fx-preset-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
            <div className="fx-preset-head">{KIND_LABEL[menuDev.kind] ?? menuDev.kind.toUpperCase()} presets</div>
            <button className={`fx-palette-item ${activePresetIdx === 0 ? "sel" : ""}`} role="menuitem" onClick={() => applyDefault(menu.slot)}>
              Default
            </button>
            {/* Factory bank — built-in, read-only (apply only, no rename/remove). The applied one is marked. */}
            {factoryPresets.length > 0 && <div className="fx-preset-sep" />}
            {factoryPresets.map((p, i) => (
              <button key={`f:${p.name}`} className={`fx-palette-item fx-preset-apply ${activePresetIdx === i + 1 ? "sel" : ""}`} role="menuitem" title="Apply factory preset" onClick={() => { presetIdxRef.current[menuDev.kind] = i + 1; applyPreset(menu.slot, p); }}>
                {p.name}
              </button>
            ))}
            {menuPresets.length > 0 && <div className="fx-preset-sep" />}
            {menuPresets.map((p) => (
              <div key={p.name} className="fx-preset-row">
                <button className="fx-palette-item fx-preset-apply" role="menuitem" title="Apply" onClick={() => applyPreset(menu.slot, p)}>
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
