import { Fragment, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useEmit, useRefresh } from "../App/spine";
import type { Deck, FxKind } from "@htl/audio";
import { saveFxPreset, renameFxPreset, factoryFxPresets, loadFxPresets, loadFxBank } from "@htl/audio";
import { saveChainPreset, renameChainPreset, factoryChainPresets, type ChainPreset } from "@htl/audio";
import { EqCurve } from "./EqCurve";
import { DelayPanel } from "./DelayPanel";
import { ReverbPanel } from "./ReverbPanel";
import { SatPanel } from "./SatPanel";
import { CrushPanel } from "./CrushPanel";
import { ModPanel } from "./ModPanel";
import { GatePanel } from "./GatePanel";
import { NoisePanel } from "./NoisePanel";
import { CompPanel } from "./CompPanel";
import { PromptModal } from "./Dialog";
import { StemPicker, STEMS } from "./StemPicker";
import { Menu, MenuFly } from "./ContextMenu";
import { bankChainRows, chainOf, CHAIN_KIND, resolveFxRows, presetOf, isGroup, isRef, reorderTop, reorderInGroup, fileIntoGroup, moveOutOfGroup, moveBetweenGroups, addFxSection, deleteFxSection, deleteFxRow, revertFxRow, renameFxSection, materialiseFxRow, type FxRow, type FxLeaf, type FxPath } from "@htl/audio";

// Every kind a chain can be given. The pad-FX bank plus the two channel devices — the same set
// the rack has always known, now offered per chain instead of once globally.
const ALL_KINDS = ["eq", "delay", "reverb", "saturator", "crush", "mod", "gate", "noise", "comp"] as const;

import { MixFader } from "./MixFader";
import { useLongPress } from "./useLongPress";
import { DropLine, insertionToIndex, useReorderDrag } from "./useReorderDrag";
import { useHoverDismiss } from "./useHoverDismiss";
import { fxBypassIntent, fxParamIntent, fxRackIntent } from "@htl/room/fxWire";

// The deck's channel-strip device rack, as a TAB bar over one full-size device panel (so
// the EQ curve keeps its full height). EVERY device — the EQ included — is a first-class
// member; the EQ is a single instance, its params ride the eq* ControlParams while the rest
// ride the fxRack intent. One device's surface shows at a time.
//
// The shell around the panel is three CLASSES of control, and they used to be one
// undifferentiated row of nine equal boxes. Now each has its own home:
//   HEADER  — the POWER glyph: engage/bypass the selected device. The control you hit most,
//             mid-mix, so it sits proud in the tab row and reads as the device's power state.
//   FOOT    — RESET (heavily used, stays a real labelled button you can hit without aiming),
//             the universal MIX fader (see MixFader), and COPY demoted to an end-cap.
// Per-device params stay inside the device's own panel. Every device gets the same shell, so
// wet/dry is always in the same place — it used to be cell 6-of-12 on the delay and cell
// 9-of-10 on the comp.

const KIND_LABEL: Record<string, string> = { eq: "EQ", delay: "DELAY", reverb: "REVERB", chorus: "CHORUS", saturator: "SAT", crush: "CRUSH", mod: "MOD", gate: "GATE", noise: "NOISE", comp: "COMP" };
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
  stepChain: (dir: number) => void; // walk the chain row — this is what AIMS the pad bank
  openMenu: (kind: FxKind, x: number, y: number) => void; // that device's own menu, at a cursor
  cyclePreset: (dir: number) => void; // FX SELECT: step Default → factory bank → wrap, on the selected effect
  closeMenu: () => void; // dismiss the preset browse (hardware bypass/mix — a DJ never clicks the backdrop)
}

/** Where a flyout hangs, and how wide it is. ★ THE WIDTH IS MEASURED, NOT CHOSEN — it comes off
 *  the menu the row lives in, so the two windows are the same object at two sizes rather than one
 *  box and a constant that used to be right. */
type FlyAnchor = { left: number; right: number; top: number };
function flyFrom(el: HTMLElement): { anchor: FlyAnchor } {
  const r = el.getBoundingClientRect();
  const menu = el.closest<HTMLElement>(".fx-preset-menu")?.getBoundingClientRect();
  // ★ HORIZONTALLY IT HANGS OFF THE MENU, VERTICALLY OFF THE ROW. It used to take both from the
  // row — but a row sits INSIDE the menu's 4px padding and its own border, so `row.right + gap`
  // put the second window a few pixels inside the first one's edge: the two boxes overlapped, and
  // on the flipped side the same error ran it back over the menu from the other direction. The
  // row's TOP is still the right vertical anchor (the window should open beside the thing you
  // pointed at); its left and right never were.
  // Only the ANCHOR now — the window measures itself (see MenuFly).
  return { anchor: { left: menu?.left ?? r.left, right: menu?.right ?? r.right, top: r.top } };
}

export function FxStrip({ deck, id, accent, otherDeck, otherAccent, emitControls, onSelect, ctlRef }: FxStripProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const [sel, setSel] = useState(0); // selected rack index
  const [menu, setMenu] = useState<{ slot: number; x: number; y: number } | null>(null); // preset menu (right-click summon)
  const [presetTick, setPresetTick] = useState(0); // bump to re-read presets after save/delete
  // Hardware preset browsing (FLX FX SELECT): a per-kind cursor (0 = Default, 1..N = factory bank)
  // + a brief on-screen flash of the applied preset name (so a hardware DJ sees what they landed on).
  const presetNameRef = useRef<Record<string, string>>({}); // per-kind cursor BY NAME ("" = Default)
  const menuTimerRef = useRef<number | null>(null); // safety-net auto-dismiss for a HARDWARE-summoned menu (a DJ never clicks the backdrop)
  const menuRef = useRef<HTMLDivElement>(null); // the open preset menu — to keep the active item scrolled into view
  const closeMenu = () => { if (menuTimerRef.current) { clearTimeout(menuTimerRef.current); menuTimerRef.current = null; } setMenu(null); };
  useEffect(() => () => { if (menuTimerRef.current) clearTimeout(menuTimerRef.current); }, []);
  // Styled name prompt (replaces window.prompt) for saving / renaming a preset.
  const [dialog, setDialog] = useState<{ mode: "save"; kind: FxKind; params: Record<string, number> } | { mode: "rename"; kind: FxKind; name: string } | { mode: "chain"; at: string } | { mode: "chainPreset"; name: string } | { mode: "section"; kind: string; at: number; name: string } | { mode: "newSection"; kind: string } | { mode: "renameRow"; kind: FxKind; path: FxPath; name: string } | null>(null);

  // ---- CHAINS ---------------------------------------------------------------------------------
  // A chain is a set of STEMS plus the devices that process them, and the set is a PARTITION: a
  // stem belongs to exactly one chain, so nothing is heard twice and the chains sum back to the
  // track. One chain over ALL stems IS the rack that has always shipped — that is the default,
  // and while it holds, every line below behaves exactly as it did before chains existed.
  //
  // The row of chain chips is the MASTER of a master/detail pair whose detail is the device row
  // that already exists. It costs one 22 px row and no width, which is the whole reason it is a
  // row of chips and not the rail this started as: the host is a ~450 px deck column, twice.
  // Chains are the DECK's, not this component's — the strip renders them, the pads play them, and
  // a session will one day sync them. Three readers means the list cannot belong to any one.
  const [selChainId, setSelChainId] = useState("master");
  // ADD A DEVICE — a fork of the preset menu, in two steps: pick the effect, then pick the sound
  // it lands with. A chain is built the way a real chain is built, one deliberate device at a
  // time; the whole rack laid out at once and struck through was a list of things you did NOT
  // choose, which is the opposite of a workflow.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number; kind?: FxKind } | null>(null);
  // The CHAIN menu — right-click a chain chip. Right-click used to delete the chain outright,
  // which is a destructive act on a single unconfirmable gesture; it lives in here now, under a
  // label, alongside the thing you actually reach for often (recall a chain you have built).
  const [chainMenu, setChainMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const openChainMenu = (id: string, x: number, y: number) => {
    cancelMenuTimer();
    setMenu(null);
    setSelChainId(id);
    setChainMenu({ x, y, id });
  };
  const [chainTick, setChainTick] = useState(0); // bump to re-read saved chain presets
  // The flyout's row AND its screen position. It cannot live inside the menu: the menu scrolls
  // (max-height + overflow-y), and an absolutely-positioned child of a scrolling box is CLIPPED by
  // it — which is why it appeared as a bare sliver against the menu's right edge. So it is
  // positioned `fixed`, measured from the row that opened it.
  const [addHover, setAddHover] = useState<{ kind: FxKind; anchor: FlyAnchor } | null>(null);
  // The THIRD window on the add path: a section's contents. The add picker's flyout shows the same
  // arrangement the right-click menu does, so it shows sections, and a section has to open the same
  // way there as it does there.
  const [addFly, setAddFly] = useState<{ at: number; name: string; anchor: FlyAnchor } | null>(null);
  // ★ THE CHAIN MENU GETS THE ROW MENU TOO. Its saved rows carried three inline glyphs — › preview,
  // ✎ rename, ✕ remove — which is exactly the clutter the preset menu was cleared of, and the ✕ was
  // a chain deleted by a bare 22px glyph one pixel from the rename. The acts live on a right-click
  // (long-press on touch) now, the same gesture and the same third layer as the preset rows.
  const [chainRowMenu, setChainRowMenu] = useState<{ x: number; y: number; preset: ChainPreset; path: FxPath; factory: boolean } | null>(null);
  const longChain = useLongPress<{ preset: ChainPreset; path: FxPath; factory: boolean }>((d, x, y) => { setChainPeek(null); setChainRowMenu({ x, y, ...d }); });
  // ★ THE CHAIN BANK IS A BANK — the same arrangement engine, so the same two drags and the same
  // second window. `chainFly` is a SECTION's contents, exactly like `presetFly`; the old
  // hover-a-row-to-preview-its-devices window is gone, and that manifest lives in the row menu now
  // (see below). Three windows was already the ceiling; four would have been a stack, not a menu.
  // ★ THE PEEK — a chain's CONTENTS, on hover of the row, as a third window. Recalling a chain
  // REPLACES what the chain holds, so "what am I about to get, and what am I about to lose" is a
  // question worth answering before the click. It briefly lived in the row menu instead; a manifest
  // you have to right-click for is one you do not read.
  const [chainPeek, setChainPeek] = useState<{ key: string; preset: ChainPreset; anchor: FlyAnchor } | null>(null);
  // ★ A HOVER-OPENED WINDOW NEEDS A HOVER-OUT, AND THE ROW IS NOT IT. The peek closes on its OWN
  // mouseleave — which never fires if you leave the ROW without ever reaching the window, so moving
  // the pointer off the list left it stranded on screen over everything else. Leaving the row arms
  // a short grace instead: entering the peek (or another row) cancels it, and anything else lets it
  // close. The grace is what makes the gap between the row and the window crossable at all.
  const peekTimer = useRef<number | undefined>(undefined);
  const holdPeek = () => { if (peekTimer.current) clearTimeout(peekTimer.current); peekTimer.current = undefined; };
  const dropPeek = (now = false) => {
    holdPeek();
    if (now) return setChainPeek(null);
    peekTimer.current = window.setTimeout(() => setChainPeek(null), 140);
  };
  useEffect(() => () => holdPeek(), []);

  const [chainFly, setChainFly] = useState<{ at: number; name: string; anchor: FlyAnchor } | null>(null);
  const [chainTickBump, setChainTickBump] = useState(0);
  const chainRows: FxRow[] = useMemo(() => (chainMenu ? bankChainRows() : []), [chainMenu, chainTick, chainTickBump]);
  const bumpChains = () => { setChainTick((t) => t + 1); setChainTickBump((t) => t + 1); };
  const chainDragged = useRef(false);
  // The PRESET menu's second window: one section's contents. A user's bank outgrows a single list,
  // and how it wants grouping is theirs to decide — so a section is a separator ROW in their own
  // saved array (fxPresets.ts) and its presets live behind this window rather than inline. The
  // first window then stops growing: adding thirty presets adds rows you do not see, not scroll.
  const [presetFly, setPresetFly] = useState<{ at: number; name: string; anchor: FlyAnchor } | null>(null);
  const devices = deck.fxDevices; // every device this deck owns, in signal order
  // ★ NEVER PRESENT A HALF-BUILT RACK. The EQ is built in the Deck's constructor; the rest can
  // only be built once the worklets attach, so for a beat at every boot the rack is the EQ alone —
  // and a strip that renders that faithfully shows the legacy "EQ is the one special device"
  // surface, reconstructed by accident, at load.
  const ready = deck.fxRackReady;
  const chains = deck.fxChainList;
  const chain = chains.find((c) => c.id === selChainId) ?? deck.fxChain("master");

  // The device row IS the selected chain's device list. Not a filter of a global rack — the chain
  // owns these instances.
  const tabs = !ready || !chain ? [] : chain.devices;
  // What this chain could still be given. Kinds are unique WITHIN a chain and free ACROSS chains,
  // so this is every kind the chain doesn't already hold — a chain can have its own EQ even while
  // the master has one.
  const others = !ready || !chain ? [] : (ALL_KINDS.filter((k) => !chain.devices.some((d) => d.kind === k)) as FxKind[]);
  const gi = (i: number) => devices.indexOf(tabs[i]); // shown index → the deck's flat slot index
  const cur = Math.max(0, Math.min(sel, devices.length - 1));
  const selDev = ready ? devices[cur] : undefined;
  const tabsRef = useRef<HTMLDivElement>(null);
  // The rack fills in from a promise callback (ensureWorklets → ensurePadFx), somewhere React can't
  // see. Ask the deck to say when. The `ready` dep drops the hook once it has fired, and the
  // re-check covers the rack landing between this render and this effect.
  useEffect(() => {
    if (deck.fxRackReady) {
      if (!ready) refresh(); // it finished in the gap — don't strand the loading state
      return;
    }
    deck.onRackReady = () => refresh();
    return () => {
      deck.onRackReady = undefined;
    };
  }, [deck, refresh, ready]);
  useEffect(() => onSelect?.(cur), [cur, onSelect]); // keep App's per-deck "current FX" ref in sync
  // ★ Selecting a chain AIMS THE PADS at it — the strip and the pad bank are the same list read at
  // two distances, so this is the only act of assignment in the system. In an effect, not in the
  // render body: aiming a performance surface is a side effect on the engine, and a render can run
  // twice.
  useEffect(() => {
    if (chain && deck.fxFocus !== chain.id) {
      deck.setFxFocus(chain.id);
      refresh();
    }
  }, [deck, chain, refresh]);
  // Keep the selection inside the chain being shown: a panel for a device this chain doesn't own
  // is a panel for something you are not listening to.
  useEffect(() => {
    if (!chain || !chain.devices.length) return;
    if (!chain.devices.includes(devices[cur])) {
      const i = devices.indexOf(chain.devices[0]);
      if (i >= 0) setSel(i);
    }
  }, [chain, devices, cur]);
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

  // ★ THE STRIP REOPENS WHERE YOU LEFT IT. It used to always land on rack index 0 — which is the
  // EQ, so every boot presented the EQ as the thing you'd come to see. That was true once, back when
  // the EQ *was* the one special device; now it's one resident of nine and no device gets to be the
  // default. Stored by KIND, not index: the rack is reorderable, and an index would faithfully
  // reopen slot 2 while the effect you actually wanted had moved to slot 5.
  const selKey = `htl.fx.sel.${id}`;
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !ready) return;
    restored.current = true;
    let kind: string | null = null;
    try {
      kind = localStorage.getItem(selKey);
    } catch { /* private mode — fall through to the default */ }
    const i = kind ? devices.findIndex((d) => d.kind === kind) : -1;
    if (i >= 0) setSel(i);
  }, [ready, devices, selKey]);
  // Persist at the CALL SITES, not in an effect: an effect keyed on the selection would fire once
  // with the pre-restore value (the EQ) and overwrite the very thing it was about to read back.
  const select = (i: number) => {
    setSel(i);
    const k = deck.fxDevices[i]?.kind;
    if (k) {
      try {
        localStorage.setItem(selKey, k);
      } catch { /* private mode — the selection just won't survive a reload */ }
    }
  };

  // ---- chain edits. All of them are list surgery on a partition, so every one has to keep the
  // partition true: a stem handed to one chain is taken from whoever held it, and a device moved
  // into one chain leaves the other. There is no state in which a stem is in two chains, because
  // there is no code path that can put it there.
  const LANES = STEMS; // the chip initials and the picker read the same table
  // The source read-out is the four INITIALS, each in its stem's colour, and it is always the
  // same four positions — so "which stems does this chain hear" is a glance at a fixed shape
  // (DBVI, D‧V‧, ‧‧VI) rather than a sentence to parse. "DRUM +1" made you count.
  // MIX is the special case: it is the catch-all every unclaimed stem falls back to, so when it
  // holds all four it says so in a word instead of spelling out the whole alphabet.
  const chainInitials = (c: { stems: number }) => LANES.map((l) => ({ ch: l.label[0], on: !!(c.stems & l.bit), color: l.color }));
  const chainTitle = (c: { name: string; stems: number }) => {
    const on = LANES.filter((l) => c.stems & l.bit).map((l) => l.label);
    if (!on.length) return `${c.name}: no stems — this chain hears nothing`;
    if (on.length === 4) return `${c.name}: every stem`;
    return `${c.name}: ${on.join(", ")}`;
  };
  // Every edit below is an ENGINE call, then a refresh. There is no local copy of the chain list
  // to keep in step, which is the whole reason the list moved into the deck.
  /** The whole set at once — what StemPicker's paint/solo gestures produce. FxRack.setChainStems
   *  takes stems from every other chain in the SAME act, so a sweep that claims all four is one
   *  re-partition and one rebuild, not four. */
  const setChainStems = (m: number, id = selChainId) => {
    const c = deck.fxChain(id);
    if (!c || c.master) return;
    deck.setFxChainStems(id, m);
    refresh();
  };
  const addChain = () => {
    const c = deck.addFxChain(`CHAIN ${chains.filter((x) => !x.master).length + 1}`);
    setSelChainId(c.id);
    refresh();
  };
  /** Give a device to a chain. Kinds are unique WITHIN a chain, free ACROSS them — so this never
   *  takes anything from anyone: it BUILDS one here. */
  const addDeviceToChain = (kind: FxKind, id = selChainId, preset?: { name: string; params: Record<string, number> }) => {
    const d = deck.addFxTo(id, kind);
    if (!d) return;
    // The picker's cursor is the preset's NAME now, like everywhere else — it used to hand down a
    // factory INDEX, which stopped identifying anything once the list became arrangeable.
    presetNameRef.current[kind] = preset?.name ?? "";
    const slot = deck.fxDevices.indexOf(d);
    if (slot >= 0) {
      select(slot);
      if (preset) applyPreset(slot, preset);
    }
    setSelChainId(id);
    broadcastRack();
    refresh();
  };
  /** Take a device out of a chain. It is that chain's instance, so this DESTROYS it — there is no
   *  homeless-device state to represent, and nothing left running that nothing can reach. */
  const removeDeviceFromChain = (kind: FxKind, id = selChainId) => {
    deck.removeFxFrom({ chain: id, kind });
    broadcastRack();
    refresh();
  };
  const removeChain = (id: string) => {
    if (deck.removeFxChain(id)) {
      setSelChainId("master");
      broadcastRack();
      refresh();
    }
  };

  const broadcastRack = (which: "A" | "B" = id, d: Deck = deck) => emit(fxRackIntent(d, which));

  // ★ TWO DRAGS, ONE GESTURE. Devices reorder within a chain; chains reorder within the row. They
  // are the same act on two rows, so they are the same hook — and because it hit-tests by
  // coordinate rather than riding HTML5 drag-and-drop, the gesture exists on touch. That is what
  // let the ◀ ▶ menu buttons go: they were there because dragging did not work on a phone.
  const draggedRef = useRef(false); // a drag ends in a click; that click is not a selection
  const tabDrag = useReorderDrag({
    group: `fx-tabs-${id}`,
    onStart: () => { draggedRef.current = true; tabLong.cancel(); cancelMenuTimer(); setMenu(null); setAddMenu(null); setChainMenu(null); },
    // `at` is an INSERTION point: removing the source first shifts later slots down one, so a
    // rightward move lands at at-1.
    onReorder: (from, at) => {
      const to = insertionToIndex(from, at);
      if (chain) { deck.moveFxIn(chain.id, from, to); broadcastRack(); refresh(); }
      else reorder(from, Math.max(0, Math.min(to, deck.fxDevices.length - 1)));
    },
    // Dropped on a chain chip: the device is BUILT there and destroyed here — instances are per
    // chain, so nothing is handed over.
    onDropOn: (from, chainId) => {
      const k = tabs[from]?.kind;
      if (!k || chainId === chain?.id) return;
      addDeviceToChain(k, chainId);
      removeDeviceFromChain(k, chain?.id ?? "master");
    },
  });
  const chainDrag = useReorderDrag({
    group: `fx-chains-${id}`,
    onStart: () => { draggedRef.current = true; chainLong.cancel(); setChainMenu(null); },
    onReorder: (from, at) => {
      const c = chains[from];
      if (c && deck.moveFxChain(c.id, insertionToIndex(from, at))) { broadcastRack(); refresh(); }
    },
  });

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
  /** Step the SELECTED device one place along its chain. The one implementation of "reorder",
   *  shared by the hardware FX SELECT knob, the ◀ ▶ menu acts (touch) and the drag (mouse). */
  const moveSelBy = (dir: number) => {
    const c = deck.fxChain(deck.fxFocus);
    if (!c) return;
    const here = c.devices.indexOf(deck.fxDeviceAt(cur) as never);
    if (here < 0) return;
    const to = Math.max(0, Math.min(c.devices.length - 1, here + dir));
    if (to === here) return;
    deck.moveFxIn(c.id, here, to);
    const idx = deck.fxDevices.indexOf(c.devices[to]);
    if (idx >= 0) setSel(idx); // the selection follows the device, not the position
    broadcastRack();
    refresh();
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
      // ★ Both of these walk THE CHAIN, not the deck's flat device list. Stepping off the end of
      // a drum chain into the master's devices would be a hardware knob quietly crossing a routing
      // boundary — the knob is aimed at a chain, exactly as the pads are.
      navSel: (dir) => {
        if (menuTimerRef.current) { clearTimeout(menuTimerRef.current); menuTimerRef.current = null; }
        setMenu(null); // moving to another effect closes the preset browse
        const c = deck.fxChain(deck.fxFocus);
        if (!c || !c.devices.length) return;
        const here = c.devices.findIndex((d) => d === deck.fxDeviceAt(live.current.cur));
        const next = c.devices[Math.max(0, Math.min(c.devices.length - 1, (here < 0 ? 0 : here) + dir))];
        const idx = deck.fxDevices.indexOf(next);
        if (idx >= 0) select(idx);
      },
      moveSel: (dir) => moveSelBy(dir),
      // Right-clicking an FX pad opens the DEVICE's menu, the way right-clicking a sampler pad
      // opens that pad's. Two banks side by side answering the same gesture two different ways was
      // the last thing separating them.
      openMenu: (kind, x, y) => {
        const here = deck.fxChain(deck.fxFocus)?.devices.find((d) => d.kind === kind);
        const slot = here ? deck.fxDevices.indexOf(here) : -1;
        if (slot < 0) return;
        cancelMenuTimer();
        select(slot);
        setMenu({ slot, x, y });
      },
      stepChain: (dir) => {
        const list = deck.fxChainList;
        if (list.length < 2) return;
        const at = Math.max(0, list.findIndex((c) => c.id === deck.fxFocus));
        const next = list[(at + dir + list.length) % list.length];
        setSelChainId(next.id);
        deck.setFxFocus(next.id);
        refresh();
      },
      selectKind: (kind) => {
        // ★ There can be several devices of a kind now — one per chain. Reveal the one in the
        // chain the pads are AIMED at; "first of that kind anywhere" would open a panel for a
        // device you are not listening to.
        const here = deck.fxChain(deck.fxFocus)?.devices.find((d) => d.kind === kind);
        const idx = here ? deck.fxDevices.indexOf(here) : deck.fxDevices.findIndex((d) => d.kind === kind);
        if (idx >= 0) select(idx);
      },
      // FX SELECT (hardware): step the SELECTED effect through Default → its factory bank → wrap,
      // applying each. Reads the live cur (not a stale render closure) and drives the device
      // directly, syncing like a menu apply. `dir` +1/-1 walks forward/back.
      cyclePreset: (dir) => {
        const at = live.current.cur;
        const dev = deck.fxDeviceAt(at);
        if (!dev) return;
        // ★ THE RESOLVED LIST, NOT THE FACTORY BANK. The browse used to index into
        // factoryFxPresets() — which was fine while that list was fixed and read-only, and is
        // wrong the moment the arrangement can be reordered, grouped and pruned: it would have
        // stepped confidently onto a different preset than the one the menu marks. It walks what
        // the menu shows now, addressed BY NAME, and separators are not stops (a hardware press
        // that lands on a heading and applies nothing reads as a dead button).
        const bank = loadFxPresets(dev.kind);
        const n = bank.length + 1; // slot 0 = Default, then the arrangement in its own order
        const cur = presetNameRef.current[dev.kind] ?? "";
        const found = cur ? bank.findIndex((p) => p.name === cur) : -1;
        let pi = cur === "" ? 0 : found >= 0 ? found + 1 : 0;
        pi = (((pi + dir) % n) + n) % n;
        presetNameRef.current[dev.kind] = pi === 0 ? "" : bank[pi - 1].name;
        // Wet/dry and bypass are live performance state — a preset browse never touches either.
        if (pi === 0) {
          deck.resetFxParamsAt(at);
          if (dev.kind === "eq") deck.armEqPreset({ name: "Default", params: dev.snapshotParams() }); // browsing also arms the pad
        } else {
          const p = bank[pi - 1];
          for (const k in p.params) if (k !== "mix") deck.setFxParam(at, k, p.params[k]);
          if (dev.kind === "eq") deck.armEqPreset(p);
        }
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
  // ★ ONE LIST NOW. Factory presets are REFERENCES inside the same arrangement as your own, so
  // there is no separate read-only bank pinned to the bottom of the menu any more — you group,
  // reorder, edit and delete all of them together, and a factory preset added in a later release
  // still arrives (resolveFxRows appends it under NEW). What "factory" still buys is the thing
  // that matters: the shipped params stay in code, so every one of them can be reverted.
  const menuRows: FxRow[] = useMemo(() => (menuDev ? resolveFxRows(menuDev.kind) : []), [menuDev, presetTick]);
  const presetKind = menuDev?.kind ?? "";
  const bumpPresets = () => setPresetTick((t) => t + 1);

  // ★ THE ROW MENU. Every per-row glyph is in here instead — rename, revert, move out, delete, and
  // for a heading rename/remove. Five things on a row is a toolbar, not a list, and the menu they
  // sat in is 168px wide. Opened by right-click, or by a tap-and-hold on touch (useLongPress's
  // 460ms, the same stand-in the rest of the app uses). The rows themselves are now nothing but
  // their names, which is what a list of presets should look like.
  // ★ A DRAG ENDS IN A CLICK, AND THAT CLICK IS NOT AN APPLY. The row is the drag handle and the
  // name button sits inside it, so pointerup after a reorder fired the button too — you could not
  // rearrange a bank without loading half of it into the deck on the way past. The tab and chain
  // strips already carried a draggedRef for exactly this; the menu rows did not.
  const presetDragged = useRef(false);
  // ★ ONE ROW MENU, AND IT NAMES ITS BANK. It read `menuDev.kind` throughout and rendered only when
  // a DEVICE menu was open — so right-clicking a section heading in the CHAIN menu set this state
  // and then nothing appeared, and chain sections had no rename and no remove at all while every
  // effect bank had both. A row menu belongs to the bank whose row was clicked, not to whichever
  // menu happens to be open.
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; kind: string; path: FxPath; group: boolean; name: string; factory: boolean } | null>(null);
  const openRowMenu = (kind: string, x: number, y: number, path: FxPath, group: boolean, name: string, factory: boolean) => setRowMenu({ x, y, kind, path, group, name, factory });
  const longRow = useLongPress<{ kind: string; path: FxPath; group: boolean; name: string; factory: boolean }>((d, x, y) => openRowMenu(d.kind, x, y, d.path, d.group, d.name, d.factory));
  // Which second window a bank's edits have to close, and which tick re-reads it.
  const closeBankFly = (kind: string) => (kind === CHAIN_KIND ? setChainFly(null) : setPresetFly(null));
  const bumpBank = (kind: string) => (kind === CHAIN_KIND ? bumpChains() : bumpPresets());

  // ★ SHOW WHERE IT WENT. A cross-group drop moves a row into a list that is not on screen, so the
  // only trace it left was one digit changing on two headings — from the operator's side that is
  // indistinguishable from a drag that did nothing, which is exactly what "moving between groups
  // doesn't work" turned out to be. So the drop OPENS THE TARGET, and the row is right there.
  // After the next paint, because the index is only meaningful once the mutation has rendered.
  const revealGroup = (at: number, name: string) =>
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-group="fxpreset:${id}"][data-row] [data-drag="${at}"]`);
      if (el) setPresetFly({ at, name, ...flyFrom(el) });
    });

  // Reordering INSIDE a section — its own group id, or the two vertical lists hit-test into each
  // other while both are on screen.
  const sectionDrag = useReorderDrag({
    group: `fxsection:${id}`,
    axis: "y",
    ghost: true,
    // ★ THE WAY OUT OF A GROUP IS THE SAME GESTURE AS THE WAY IN. This drag accepts the FIRST
    // window's targets too: a section heading (move straight into that group) and the list's own
    // background (back to the top level). Without it the only exit was the row menu's "move out",
    // which is fine as a fallback and hopeless as the primary gesture — you can drag a preset in
    // and then not drag it out again.
    accept: [`fxpreset:${id}`, `fxtop:${id}`],
    onStart: () => { presetDragged.current = true; longRow.cancel(); setRowMenu(null); },
    onReorder: (from, at) => {
      if (presetFly) reorderInGroup(presetKind, presetFly.at, from, at);
      bumpPresets();
    },
    onDropOn: (from, dropId, grp, at) => {
      if (!presetFly) return;
      setPresetFly(null); // the window it came from is about to be a different list
      if (grp === `fxtop:${id}`) {
        // `at` is where in the TOP-LEVEL list the pointer was — the wrapper is a drop-list, so a
        // row leaving a group lands in the gap you aimed at rather than always beside its section.
        // The pinned lane in the chin is the one target with no position of its own: it MEANS the
        // end, which is the one gap a scrolling list can never show you.
        moveOutOfGroup(presetKind, presetFly.at, from, dropId === "end" ? menuRows.length : at);
      } else {
        const toG = Number(dropId);
        if (toG === presetFly.at) return bumpPresets(); // its own heading: nothing moves
        moveBetweenGroups(presetKind, presetFly.at, from, toG);
        const g = menuRows[toG];
        if (g && isGroup(g)) revealGroup(toG, g.name);
      }
      bumpPresets();
    },
  });
  // ★ ONE DRAG FOR THE WHOLE TOP LEVEL, presets and sections alike — which is the point of the
  // nesting. The flat model could only ever render loose presets and THEN sections, because a row
  // after a separator was IN that section by definition; there was no way to express a preset
  // sitting between two groups. Now the top level is just a list of rows and this reorders it.
  const presetDrag = useReorderDrag({
    group: `fxpreset:${id}`,
    axis: "y", // a menu is a column; the hook was x-only until this needed it
    ghost: true, // the menu clips at 240px, and a row transformed in place can never leave it
    // A SECTION cannot go inside a section — the arrangement is one level deep. Saying so here is
    // what stops a heading from outlining itself as a target for a drag the model will refuse.
    canDropOn: (from) => !isGroup(menuRows[from]),
    onStart: () => { presetDragged.current = true; longRow.cancel(); setRowMenu(null); },
    onReorder: (from, at) => {
      reorderTop(presetKind, from, at);
      bumpPresets();
    },
    onDropOn: (from, dropId) => {
      const g = Number(dropId);
      fileIntoGroup(presetKind, from, g);
      // Filing REMOVES a top-level row, so every heading after the source shifts up one.
      const toG = from < g ? g - 1 : g;
      const grp = menuRows[g];
      if (grp && isGroup(grp)) revealGroup(toG, grp.name);
      bumpPresets();
    },
  });
  // ★ THE SAME TWO DRAGS, ONE BANK OVER. Nothing here is chain-specific: the arrangement engine
  // does not know what a leaf IS, so wiring a second bank to it is wiring, not a second design.
  const chainSectionDrag = useReorderDrag({
    group: `chainsection:${id}`,
    axis: "y",
    ghost: true,
    accept: [`chainpreset:${id}`, `chaintop:${id}`],
    onStart: () => { chainDragged.current = true; longChain.cancel(); setChainRowMenu(null); dropPeek(true); },
    onReorder: (from, at) => { if (chainFly) reorderInGroup(CHAIN_KIND, chainFly.at, from, at); bumpChains(); },
    onDropOn: (from, dropId, grp, at) => {
      if (!chainFly) return;
      const src = chainFly.at;
      setChainFly(null);
      if (grp === `chaintop:${id}`) moveOutOfGroup(CHAIN_KIND, src, from, dropId === "end" ? chainRows.length : at);
      else {
        const toG = Number(dropId);
        if (toG === src) return bumpChains();
        moveBetweenGroups(CHAIN_KIND, src, from, toG);
      }
      bumpChains();
    },
  });
  const chainTopDrag = useReorderDrag({
    group: `chainpreset:${id}`,
    axis: "y",
    ghost: true,
    canDropOn: (from) => !isGroup(chainRows[from]),
    onStart: () => { chainDragged.current = true; longChain.cancel(); setChainRowMenu(null); dropPeek(true); },
    onReorder: (from, at) => { reorderTop(CHAIN_KIND, from, at); bumpChains(); },
    onDropOn: (from, dropId) => { fileIntoGroup(CHAIN_KIND, from, Number(dropId)); bumpChains(); },
  });

  const activePresetName = menuDev ? presetNameRef.current[menuDev.kind] ?? "" : "";
  const hiddenCount = useMemo(() => (menuDev ? loadFxBank(menuDev.kind).gone.length : 0), [menuDev, presetTick]);

  // Keep the active preset scrolled into view as the list is cycled (a hardware browse can walk past
  // the visible window). Scrolls ONLY the menu container — no page jump.
  useEffect(() => {
    // The menu itself stopped being the scroller when it grew a chin — its body is.
    const cont = menuRef.current?.querySelector<HTMLElement>(".fx-menu-body") ?? menuRef.current;
    const el = cont?.querySelector<HTMLElement>(".fx-palette-item.sel");
    if (!cont || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < cont.scrollTop) cont.scrollTop = top - 6;
    else if (bottom > cont.scrollTop + cont.clientHeight) cont.scrollTop = bottom - cont.clientHeight + 6;
  }, [menu, activePresetName]);
  // Adjusting wet/dry (the FLX BEAT-FX knob or the on-screen MIX cell) dismisses the browse — it means
  // "I'm tuning this now", not still picking. Preset cycling PRESERVES mix, so this never false-fires;
  // EQ has no mix param, and the first observation is skipped.
  //
  // ★ It watches the MENU'S device, and it remembers which slot that reading came from. Watching
  // the SELECTED device was a race: opening the menu also selects the tab you right-clicked, so
  // right-clicking SAT while REVERB was focused changed the observed mix from reverb's to sat's —
  // a different device's value, read as a fader move — and the watchdog shut the menu it had just
  // opened. Nobody touched a fader; the subject changed underneath the observer.
  const menuMix = menuDev ? menuDev.getParam("mix") : null; // EQ included now that Eq3 maps "mix"
  const lastMixRef = useRef<{ slot: number; mix: number } | null>(null);
  useEffect(() => {
    if (!menu || menuMix == null) {
      lastMixRef.current = null; // nothing open: the next open starts from its own first reading
      return;
    }
    const prev = lastMixRef.current;
    if (prev && prev.slot === menu.slot && prev.mix !== menuMix) {
      closeMenu();
      lastMixRef.current = null;
      return;
    }
    lastMixRef.current = { slot: menu.slot, mix: menuMix };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuMix, menu]);
  // Mouse/touch opens are STICKY (dismiss by clicking away or picking) — cancel any pending
  // hardware auto-dismiss so a deliberate open isn't yanked shut mid-browse.
  const cancelMenuTimer = () => { if (menuTimerRef.current) { clearTimeout(menuTimerRef.current); menuTimerRef.current = null; } };
  const openPresetMenu = (e: React.MouseEvent, slot: number) => {
    e.preventDefault();
    cancelMenuTimer();
    select(slot);
    setMenu({ slot, x: e.clientX, y: e.clientY });
  };
  // Touch has no right-click: long-press a tab to open its preset menu (was desktop-only).
  const tabLong = useLongPress<number>((slot, x, y) => { tabDrag.cancel(); cancelMenuTimer(); select(slot); setMenu({ slot, x, y }); });
  // Touch has no right-click: long-press a chain chip for the same menu.
  const chainLong = useLongPress<string>((id, x, y) => { chainDrag.cancel(); openChainMenu(id, x, y); });
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
  // "Default" is the flat PRESET, and a preset never touches the blend or the on/off — same rule
  // as RESET and as every other preset in the bank.
  /** Recall a chain preset into a chain: its stems, and its devices BUILT fresh in the preset's
   *  order. Nothing is taken from another chain — kinds are unique within a chain and free across
   *  them, so a recall creates instances rather than moving anyone else's. */
  const applyChainPreset = (id: string, p: ChainPreset) => {
    const c = deck.fxChain(id);
    if (!c) return;
    for (const d of [...c.devices]) deck.removeFxFrom({ chain: id, kind: d.kind });
    if (!c.master) deck.setFxChainStems(id, p.stems);
    deck.setFxChainName(id, p.name.toUpperCase());
    for (const k of p.kinds) deck.addFxTo(id, k as FxKind);
    setSelChainId(id);
    setChainMenu(null);
    broadcastRack();
    refresh();
  };

  const applyDefault = (slot: number) => {
    const d = deck.fxDeviceAt(slot);
    if (!d) return;
    deck.resetFxParamsAt(slot);
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
  /** Apply a preset AND remember it by NAME. The cursor used to be the factory bank's INDEX, which
   *  stopped meaning anything the moment the list became reorderable, groupable and deletable —
   *  and would have silently browsed to the wrong preset rather than failing. */
  const applyPresetNamed = (slot: number, p: { name: string; params: Record<string, number> }) => {
    const d = deck.fxDeviceAt(slot);
    if (d) presetNameRef.current[d.kind] = p.name;
    applyPreset(slot, p);
  };

  // --- shared toolbar (acts on the selected device) ---
  const isEq = selDev?.kind === "eq";
  const bypassed = isEq ? deck.eqBypassed : !!selDev?.bypassed;
  // Shift = hard kill: skip a delay/reverb's ring-out and cut immediately (BaseFxDevice.setBypass's
  // `hard` flag). EQ has no tail to preserve, so it ignores the modifier entirely.
  const toggleBypass = (e: React.MouseEvent) => {
    if (!selDev) return;
    closeMenu(); // toggling bypass dismisses the preset browse
    if (isEq) {
      deck.setEqBypass(!deck.eqBypassed);
      emit({ kind: "toggle", deck: id, param: "eqBypass", value: deck.eqBypassed });
    } else {
      deck.setFxBypass(cur, !selDev.bypassed, e.shiftKey);
      emit(fxBypassIntent(deck, id, cur, selDev.bypassed));
    }
    refresh();
  };
  const powerRef = useRef<HTMLButtonElement>(null);
  const [tailFading, setTailFading] = useState(false); // mirrors selDev.releasing, for the CSS class only
  // The power button fades with the REAL wet signal while a ring-out is in flight, instead of
  // snapping to "off" while a delay/reverb's tail is still audibly decaying. `--tail` is written
  // imperatively every frame (a ref, never React state) — the same reason useFrameSync exists:
  // a re-render just to paint one CSS variable would spend the frame budget on the wrong thing.
  // `tailFading` itself only flips at the two edges, so it can't cause a per-frame render either.
  useEffect(() => {
    if (!selDev) return;
    let raf = 0;
    let was = false;
    const tick = () => {
      const releasing = selDev.releasing;
      if (releasing !== was) {
        was = releasing;
        setTailFading(releasing);
        if (!releasing) powerRef.current?.style.removeProperty("--tail");
      }
      if (releasing) powerRef.current?.style.setProperty("--tail", String(selDev.wetLevel));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selDev]);
  // RESET aims at the device's CHARACTER — the params. It does NOT touch the wet/dry or the
  // on/off: those are performance state you're holding mid-mix, independent of what the effect
  // is dialled to. (It used to blow away both, so "put this delay back to sane" also yanked
  // your blend to 28% and forced the effect back into the signal.)
  const reset = () => {
    if (!selDev) return;
    if (isEq) {
      deck.resetEqParams();
      emitControls(id);
    } else {
      deck.resetFxParamsAt(cur);
      broadcastRack();
    }
    refresh();
  };
  /** ⇄ ONE DEVICE. It lands in the other deck's chain of the same NAME — a reverb built on your
   *  drums is a reverb ON DRUMS, and a copy that forgets that half is not a copy. If the other deck
   *  has no such chain, the copy brings the chain with it (see Deck.copyFxTo). */
  const copyDeviceToOther = (slot: number) => {
    const addr = deck.fxAddrAt(slot);
    if (!addr) return;
    deck.copyFxTo(otherDeck, addr);
    broadcastRack(otherId, otherDeck); // presence/order/effect-params
    emitControls(otherId); // eq params (and the rest of the other deck's control state)
    refresh();
  };
  /** ⇄ A WHOLE CHAIN — name, stems, devices, params and order. This is the unit a DJ actually
   *  built, and the one worth handing to the other deck in a single act. */
  const copyChainToOther = (chainId: string) => {
    deck.copyFxChainTo(otherDeck, chainId);
    broadcastRack(otherId, otherDeck);
    emitControls(otherId);
    refresh();
  };
  // The universal wet/dry. The EQ rides the eq* ControlParams (eqMix); every other device
  // rides the per-param fxParam intent — the SAME seams the old in-panel MIX cells used, so
  // session-sync and MIDI converge exactly as before. Only the surface moved.
  const setMix = (v: number) => {
    if (!selDev) return;
    if (isEq) {
      deck.setEqMix(v);
      emit({ kind: "control", deck: id, param: "eqMix", value: v });
    } else {
      deck.setFxParam(cur, "mix", v);
      emit(fxParamIntent(deck, id, cur, "mix", v));
    }
    refresh();
  };

  // ONE row renderer for both windows: a name, a drag handle, and a right-click. Every act that
  // used to be a glyph on the row is in the row menu now.
  const presetRow = (l: FxLeaf, path: FxPath, i: number, drag: ReturnType<typeof useReorderDrag>) => {
    if (!menu || !menuDev) return null;
    const p = presetOf(menuDev.kind, l);
    if (!p) return null;
    const factory = isRef(l);
    return (
      <div
        key={`p:${path.join(":")}:${p.name}`}
        className={`fx-preset-row ${chainPeek?.key === path.join(":") ? "hot" : ""} ${drag.from === i ? "reorder-source" : ""}`}
        {...drag.bind(i)}
        {...longRow.bind({ kind: menuDev.kind, path, group: false, name: p.name, factory })}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation(); // the menu backdrop's own right-click closes the whole menu
          openRowMenu(menuDev.kind, e.clientX, e.clientY, path, false, p.name, factory);
        }}
      >
        <button className={`fx-palette-item fx-preset-apply ${factory ? "is-factory" : ""}`} role="menuitem" title={`Apply ${p.name} — right-click for more, drag to reorder`} onClick={() => { if (presetDragged.current) return; applyPresetNamed(menu.slot, p); }}>
          {p.name}
        </button>
      </div>
    );
  };

  // ONE row for a chain preset, saved or factory — a name and a right-click, exactly like a preset
  // row. The ✎ and ✕ that used to ride on the saved ones are row-menu items now: a chain is a
  // bigger thing to lose than a preset, and losing it to a bare glyph beside the rename it is one
  // pixel from was the worst destructive affordance left in the strip.
  const chainRow = (l: FxLeaf, path: FxPath, i: number, drag: ReturnType<typeof useReorderDrag>) => {
    const p = chainOf(l);
    if (!p) return null;
    const factory = isRef(l);
    return (
      <div
        key={`c:${path.join(":")}:${p.name}`}
        className={`fx-preset-row ${chainPeek?.key === path.join(":") ? "hot" : ""} ${drag.from === i ? "reorder-source" : ""}`}
        {...drag.bind(i)}
        data-peek-row={path.join(":")}
        onMouseEnter={(e) => { holdPeek(); if (!chainRowMenu && drag.from == null) setChainPeek({ key: path.join(":"), preset: p, ...flyFrom(e.currentTarget) }); }}
        onMouseLeave={() => dropPeek()}
        {...longChain.bind({ preset: p, path, factory })}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation(); // the menu backdrop's own right-click closes the whole menu
          dropPeek(true);
          setChainRowMenu({ x: e.clientX, y: e.clientY, preset: p, path, factory });
        }}
      >
        <button className={`fx-palette-item fx-preset-apply ${factory ? "is-factory" : ""}`} role="menuitem" title={`Recall ${p.name} — right-click for more`} onClick={() => { if (chainDragged.current) return; if (chainMenu) applyChainPreset(chainMenu.id, p); }}>
          {p.name}
        </button>
      </div>
    );
  };

  // The ADD picker reads the SAME arrangement the right-click menu does — see the flyout below.
  const addRows: FxRow[] = useMemo(() => (addHover ? resolveFxRows(addHover.kind) : []), [addHover, presetTick]);
  // Which kinds have anything to offer at all: the chevron, and the hover, are gated on it. Off the
  // arrangement, not the factory bank — a kind whose presets you have all deleted has none.
  const addHas = useMemo(() => {
    const m: Record<string, boolean> = {};
    if (addMenu) for (const k of others) m[k] = resolveFxRows(k).some((r) => (isGroup(r) ? r.items.length > 0 : true));
    return m;
  }, [addMenu, others.join(","), presetTick]);
  const addGone = useMemo(() => (addHover ? loadFxBank(addHover.kind).gone.length : 0), [addHover, presetTick]);
  // One row, both windows — the same markup the preset menu uses for a leaf, minus the editing.
  const addLeaf = (l: FxLeaf, key: string) => {
    if (!addHover) return null;
    const p = presetOf(addHover.kind, l);
    if (!p) return null;
    return (
      <button key={key} className={`fx-palette-item fx-preset-apply ${isRef(l) ? "is-factory" : ""}`} role="menuitem" title={p.name} onClick={() => { addDeviceToChain(addHover.kind, selChainId, p); setAddMenu(null); setAddHover(null); setAddFly(null); }}>
        {p.name}
      </button>
    );
  };

  // The five hover-opened windows in this strip all close by the same rule — see useHoverDismiss.
  // Each names the window and the row that opened it; a null key turns the watch off entirely
  // (a menu is open above it, or a drag is running, and neither is a hover).
  useHoverDismiss(
    chainPeek && !chainRowMenu ? `peek:${chainPeek.key}` : null,
    [".fx-menu-fly.layer-3", `[data-peek-row="${chainPeek?.key ?? ""}"]`],
    () => setChainPeek(null),
  );
  // A SECTION's window, in each of the three menus that has one. The heading is never "left" if you
  // change your mind on the way to the flyout — nothing fires — so this is the only thing that
  // closes them at all in that case. The peek is a KEEP for the chain one: it opens from a row
  // inside that window, and closing its parent out from under it is the same bug inverted.
  useHoverDismiss(
    presetFly && !rowMenu && presetDrag.from == null && sectionDrag.from == null ? `pfly:${presetFly.at}` : null,
    [".fx-menu-fly", `[data-fly-row="fx:${presetFly?.at ?? -1}"]`],
    () => setPresetFly(null),
  );
  useHoverDismiss(
    chainFly && !chainRowMenu && !rowMenu && chainTopDrag.from == null && chainSectionDrag.from == null ? `cfly:${chainFly.at}` : null,
    [".fx-menu-fly", `[data-fly-row="chain:${chainFly?.at ?? -1}"]`],
    () => setChainFly(null),
  );
  useHoverDismiss(
    addHover && !addFly ? `add:${addHover.kind}` : null,
    [".fx-menu-fly", `[data-add-row="${addHover?.kind ?? ""}"]`],
    () => setAddHover(null),
  );
  useHoverDismiss(
    addFly ? `addfly:${addFly.at}` : null,
    [".fx-menu-fly", `[data-addfly-row="add:${addFly?.at ?? -1}"]`],
    () => setAddFly(null),
  );

  return (
    <div className="fx-strip" style={{ ["--accent" as string]: accent }}>
      {/* ★ THE CHAIN ROW — the master of a master/detail pair whose detail is the device row below
          it. One line, the same chip language, and it SCROLLS rather than compresses, so it costs
          a deck column nothing in width at any size. A chip carries the chain's name and, as a
          left edge, the colour of the stems it owns; the selected chip opens the four-lane picker
          when tapped again. Drag a device tab onto a chip to move that device into that chain, and
          drag a chip itself to reorder the row. */}
      {ready && chains.length > 0 && (
        <div className="fx-chain-bar">
          {/* ★ ＋ DOES NOT SCROLL. It used to ride at the end of the row, which meant the way to
              make a chain disappeared the moment you had enough chains to need one. It is a fixed
              first column now, outside the scroller — the row slides underneath it. */}
          <button className="fx-chain add" title="New chain" onClick={addChain}>
            ＋
          </button>
        <div className={`fx-chains ${chainDrag.from != null || tabDrag.from != null ? "dragging" : ""}`} {...chainDrag.row} onPointerDownCapture={() => { draggedRef.current = false; }}>
          {chains.map((c) =>
            c.master ? (
              <span key="master-wrap" className="fx-chain-tail">
              {/* ★ THE MASTER, pinned rightmost at a constant place — because that is where it
                  is in the SIGNAL, not a layout preference. It has no stem selector: it does not
                  take stems, it takes the SUM of the chains, after them. */}
              <button
                className={`fx-chain master ${c.id === chain?.id ? "sel" : ""} ${tabDrag.onto === c.id ? "drop-in" : ""}`}
                title={`${c.name}: the master channel — every chain sums here · right-click for presets`}
                // It DOES get a menu. It was refused one on the grounds that it takes no stems and
                // cannot be deleted — but those are two rows of a menu whose main body is the
                // saved-chain list, and "recall a rack I built" is exactly as sensible on the
                // master as anywhere else. The menu already hides what does not apply.
                onClick={() => { if (draggedRef.current) { draggedRef.current = false; return; } setSelChainId(c.id); }}
                {...chainLong.bind(c.id)}
                {...tabDrag.foreign(c.id)}
                onContextMenu={(e) => { e.preventDefault(); openChainMenu(c.id, e.clientX, e.clientY); }}
              >
                <span className="fx-chain-name">{c.name}</span>
              </button>
              </span>
            ) : (
              <button
                key={c.id}
                className={`fx-chain ${c.id === chain?.id ? "sel" : ""} ${c.stems === 0 ? "deaf" : ""} ${chainDrag.from === chains.indexOf(c) ? "is-dragging" : ""} ${chainDrag.at === chains.indexOf(c) ? "drop-before" : ""} ${chainDrag.at === chains.indexOf(c) + 1 ? "drop-after" : ""} ${tabDrag.onto === c.id ? "drop-in" : ""}`}
                title={`${chainTitle(c)} · drag to reorder · right-click for stems and presets`}
                onClick={() => { if (draggedRef.current) { draggedRef.current = false; return; } if (!chainLong.fired.current) setSelChainId(c.id); }}
                {...chainLong.bind(c.id)}
                {...chainDrag.bind(chains.indexOf(c))}
                {...tabDrag.foreign(c.id)}
                onContextMenu={(e) => { e.preventDefault(); openChainMenu(c.id, e.clientX, e.clientY); }}
              >
                <span className="fx-chain-name">{c.name}</span>
                {/* The stem letters are a PREVIEW of what this chain hears. With nothing separated
                    there is nothing to preview — four dead letters on every chip is noise that
                    looks like state. Same rule as the picker in the menu: absent, not dimmed. */}
                {deck.hasStems && (
                <span className="fx-chain-src">
                  {chainInitials(c).map((x) => (
                    <i key={x.ch} className={x.on ? "on" : ""} style={{ ["--lane" as string]: x.color }}>
                      {x.ch}
                    </i>
                  ))}
                </span>
                )}
              </button>
            ),
          )}
        </div>
        </div>
      )}
      <div className="fx-head">
      {/* ★ SAME RULE AS THE CHAIN ROW's ＋: the way to add a device cannot be the thing that
          scrolls out of sight once you have added a few. Fixed first column, row slides under. */}
      {others.length > 0 && (
        <button
          className="fx-tab fx-tab-add"
          title="Add an effect to this chain"
          onClick={(e) => { cancelMenuTimer(); setMenu(null); setAddMenu({ x: e.clientX, y: e.clientY }); }}
        >
          ＋
        </button>
      )}
      <div className={`fx-tabs ${tabDrag.from != null ? "dragging" : ""}`} role="tablist" ref={tabsRef} {...tabDrag.row} onPointerDownCapture={() => { draggedRef.current = false; }}>
        {tabs.map((d, i) => (
          <button
            key={d.kind}
            className={`fx-tab ${cur === gi(i) ? "sel" : ""} ${d.bypassed || (d.kind === "eq" && deck.eqBypassed) ? "bypassed" : ""} ${tabDrag.at === i ? "drop-before" : ""} ${tabDrag.at === i + 1 ? "drop-after" : ""} ${tabDrag.from === i ? "is-dragging" : ""}`}
            onClick={() => { if (draggedRef.current) { draggedRef.current = false; return; } if (tabLong.fired.current) return; select(gi(i)); }}
            onContextMenu={(e) => openPresetMenu(e, gi(i))}
            {...tabLong.bind(gi(i))}
            {...tabDrag.bind(i)}
            role="tab"
            aria-selected={cur === i}
            title="Drag to reorder, or onto a chain chip to move it there · right-click for presets"
          >
            {KIND_LABEL[d.kind] ?? d.kind.toUpperCase()}
          </button>
        ))}
      </div>
        {/* COPY used to live here, as a permanent header button for a thing touched about once a
            session. It is in the menus now — on the device, and on the chain — where the rest of
            "what can I do to this?" already is, and where it can say WHICH thing it copies. */}
      </div>

      <div className="fx-stage">
        {chain && chain.devices.length === 0 ? (
          // The ＋ is right there, one row up and pinned. A sentence explaining it is a sentence
          // you read once and then read past forever.
          <div className="fx-panel fx-unknown fx-empty">EMPTY</div>
        ) : !selDev ? (
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
        ) : selDev.kind === "comp" ? (
          <CompPanel deck={deck} id={id} slot={cur} accent={accent} />
        ) : selDev.kind === "noise" ? (
          <NoisePanel deck={deck} id={id} slot={cur} accent={accent} />
        ) : (
          <div className="fx-panel fx-unknown">This effect isn’t available in this build.</div>
        )}
      </div>

      {/* The device foot — same shell for every effect, and it holds the three controls you
          actually PERFORM with, side by side: kill it back to neutral, ride the blend, cut it in
          or out. POWER sits with MIX because that's what it acts on — an on/off across the room
          from the wet/dry it gates reads as unrelated chrome. COPY went to the header. */}
      {selDev && (
        <div className={`fx-bar ${bypassed ? "off" : ""}`}>
          {/* A glyph, not a word — so it shrinks to a square end-cap matching POWER, and the
              fader keeps the whole middle at any width. The panel narrows a LOT (two decks
              side by side on a laptop, and again on a phone) and a 6-letter label is the first
              thing that stops fitting. */}
          <button className="eq-tool fx-reset" title="Reset this device to its defaults" aria-label="Reset this device" onClick={reset}>
            ↺
          </button>
          <MixFader value={selDev.getParam("mix")} reset={selDev.paramDefault("mix")} onChange={setMix} disabled={bypassed} />
          <button
            ref={powerRef}
            className={`fx-power ${bypassed ? "" : "on"}${tailFading ? " releasing" : ""}`}
            title={bypassed ? "Engage this effect" : "Bypass this effect (A/B) · Shift: hard kill, no ring-out"}
            aria-label={bypassed ? "Engage effect" : "Bypass effect"}
            aria-pressed={!bypassed}
            onClick={toggleBypass}
          >
            ⏻
          </button>
        </div>
      )}

      {/* Preset menu — right-click an effect tab. Same FxMenu as the chain menu and the picker:
          one widget, one place to change it. */}
      {menu && menuDev && (
        <Menu
          x={menu.x}
          y={menu.y}
          innerRef={menuRef}
          onClose={() => setMenu(null)}
          // ★ THE CHIN. DEFAULT is not a preset — it is the device's own reset state, so it is not
          // in the arrangement and cannot be grouped, reordered or deleted. It also cannot be at
          // the BOTTOM OF THE SCROLL: a bank of twenty rows in a 240px window put the way OUT of
          // the list twenty rows inside it. Pinned under the body, it is where it always was on
          // screen and no longer where the list happens to end.
          chin={
            <>
              <button className={`fx-palette-item ${activePresetName === "" ? "sel" : ""}`} role="menuitem" onClick={() => applyDefault(menu.slot)}>
                Default
              </button>
              {/* The factory bank used to be pinned here as a second, read-only list. It is merged
                  into the arrangement above now — as references, so the shipped params still live
                  in code and every one of them can be reverted or restored. What remains is a note
                  that a deleted factory preset is DELETED, not lost: without it, a preset you
                  dropped weeks ago just looks like the app mislaid it. Deliberately not actionable
                  from the deck — the restore is three deliberate steps away, in Settings, where it
                  cannot be hit mid-set. */}
              {hiddenCount > 0 && <div className="fx-preset-note">{hiddenCount} hidden — Settings ▸ Audio</div>}
            </>
          }
          // ★ IDENTICAL EVERYWHERE — the master's devices get exactly the menu a stem chain's do.
          // Two menus that differ by context is what made right-clicking two tabs in a row flicker
          // between shapes; the fix is one shape, not a smarter guess about which to show.
          // ✕ takes the effect OUT of whatever holds it, master included: the rack is
          // fixed-membership, so the device still exists — it is simply in no chain, and out of
          // the signal path, until something claims it again.
          acts={[
            // ◀ ▶ used to sit here, because reordering was HTML5 drag-and-drop and that does not
            // exist on touch — so a phone needed buttons to rewire the graph at all. The drag is
            // pointer-based now and works with a finger, so the buttons are gone: one gesture for
            // one act, on every surface. (The hardware SHIFT+BEAT knob still calls moveSelBy.)
            { glyph: "⇄", title: `Copy ${KIND_LABEL[menuDev.kind] ?? menuDev.kind.toUpperCase()} to deck ${otherId}`, onClick: () => { copyDeviceToOther(menu.slot); setMenu(null); } },
            { glyph: "＋", title: "Save the current settings as a preset", onClick: () => saveCurrent(menu.slot) },
            // ▭ — a SECTION. Nothing hardcoded: the factory bank stays one flat read-only list,
            // and how your OWN saved presets are grouped is yours to decide. It lands at the
            // bottom; drag it where you want it, then drag presets onto it.
            { glyph: "▭", title: "Add a section to your saved presets", onClick: () => setDialog({ mode: "newSection", kind: menuDev.kind }) },
            {
              glyph: "✕",
              // Named after the chain that actually HOLDS it, which is not always the selected one.
              title: `Remove ${KIND_LABEL[menuDev.kind] ?? menuDev.kind.toUpperCase()} from ${chains.find((c) => c.devices.includes(menuDev))?.name ?? "the rack"}`,
              danger: true,
              onClick: () => { removeDeviceFromChain(menuDev.kind, chains.find((c) => c.devices.includes(menuDev))?.id ?? "master"); setMenu(null); },
            },
          ]}
        >
          {/* ★ YOURS FIRST. The saved ones are what gets reached for mid-set; the factory bank is
              a place you go shopping, once. It used to run Default → factory → yours, which put
              the thing you actually use at the bottom of a scroll. */}
          {/* ★ ONE LIST, PRESETS AND SECTIONS INTERLEAVED — which is what nesting bought. While a
              section was a separator in a flat array, membership fell out of order, so a row after
              a heading WAS in that heading and the top level could only ever be "every loose
              preset, then every section". A section is a container now, so this is just the rows
              in the order you put them in. */}
          {/* The wrapper is the "back to the top level" target, and it carries its OWN group id so
              the first window's own drag never sees it — otherwise every drop that was not on a
              heading would read as "move to top" and ordinary reordering would stop working. A
              heading nested inside still wins, because closest() finds the innermost match. */}
          {/* Absolutely positioned over the menu's own bottom edge (see .fx-end-strip): it costs
              NO layout, so it can come and go with the drag without moving the list underneath —
              which is what ruled out both the chin versions of it. */}
          {sectionDrag.from != null && (
            <div className={`fx-end-strip ${sectionDrag.onto === "end" ? "drop" : ""}`} data-drop="end" data-group={`fxtop:${id}`} aria-hidden="true">
              TO THE END
            </div>
          )}
          <div className={`fx-top-zone ${sectionDrag.onto === "top" ? "drop" : ""} ${presetDrag.from != null || sectionDrag.from != null ? "dragging" : ""}`} data-drop="top" data-group={`fxtop:${id}`}>
          <div {...presetDrag.row} onPointerDownCapture={() => { presetDragged.current = false; }}>
            {menuRows.map((r, i) => (
              <Fragment key={`r:${i}`}>
                <DropLine show={presetDrag.at === i || (sectionDrag.onto === "top" && sectionDrag.intoAt === i)} />
                {
              isGroup(r) ? (
                <div
                  key={`s:${i}:${r.name}`}
                  data-fly-row={`fx:${i}`}
                  className={`fx-preset-row fx-section-row ${presetFly?.at === i ? "hot" : ""} ${presetDrag.onto === String(i) || (sectionDrag.onto === String(i) && presetFly?.at !== i) ? "drop" : ""} ${presetDrag.from === i ? "reorder-source" : ""}`}
                  // Not while a menu is open above (its backdrop would be the thing "entering"),
                  // and NOT MID-DRAG: dragging a preset onto a heading made that heading open its
                  // flyout over the very drop target you were aiming at. The `.drop` outline is
                  // the feedback a drag needs; a window opening under your finger is not.
                  // …and not while EITHER drag runs: a heading that re-targets the open flyout
                  // mid-drag would also re-target the source group a flyout drop reads from, so
                  // the row would be taken out of whichever section you last passed over.
                  onMouseEnter={(e) => !rowMenu && presetDrag.from == null && sectionDrag.from == null && setPresetFly({ at: i, name: r.name, ...flyFrom(e.currentTarget) })}
                  {...presetDrag.bind(i)}
                  {...presetDrag.foreign(String(i))}
                  {...longRow.bind({ kind: menuDev.kind, path: [i] as FxPath, group: true, name: r.name, factory: false })}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openRowMenu(menuDev.kind, e.clientX, e.clientY, [i] as FxPath, true, r.name, false);
                  }}
                >
                  {/* The COUNT LEADS, at a fixed width so every name starts on the same column —
                      a count that re-indents each heading by its own number of digits reads as a
                      ragged list. */}
                  <button className="fx-palette-item fx-section-name" role="menuitem" title={`${r.name} — ${r.items.length} preset${r.items.length === 1 ? "" : "s"} · right-click for more`} onClick={(e) => { if (presetDragged.current) return; setPresetFly({ at: i, name: r.name, ...flyFrom(e.currentTarget.parentElement as HTMLElement) }); }}>
                    <i className="fx-section-n">{r.items.length}</i>
                    <span className="fx-section-label">{r.name}</span>
                  </button>
                </div>
                ) : (
                  presetRow(r, [i] as FxPath, i, presetDrag)
                )}
              </Fragment>
            ))}
            <DropLine show={presetDrag.at === menuRows.length || (sectionDrag.onto === "top" && sectionDrag.intoAt === menuRows.length)} />
          </div>
            {/* The in-list landing strip that used to live here is gone: it was the end of a list
                that scrolls, so on any bank long enough to need it, it was past the fold. Its job
                belongs to the pinned lane in the chin (see below), which never scrolls away. */}
          </div>
        </Menu>
      )}

      {/* THE CHAIN MENU. Same widget as the preset menu, re-laid so the two ACTS — make one, throw
          one away — sit at the top under their own rule, and the recall list runs beneath. Delete
          is a labelled item here rather than a bare right-click, because a right-click that
          destroys a chain is a gesture with no name and no second chance. */}
      {chainMenu && chains.some((c) => c.id === chainMenu.id) && (
        <Menu
          x={chainMenu.x}
          y={chainMenu.y}
          wide
          onClose={() => { setChainMenu(null); setChainFly(null); setChainRowMenu(null); dropPeek(true); }}
          acts={[
            // The whole chain, to the other deck — name, stems, devices, params, order.
            { glyph: "⇄", title: `Copy ${(deck.fxChain(chainMenu.id)?.name ?? "this chain")} to deck ${otherId}`, onClick: () => { copyChainToOther(chainMenu.id); setChainMenu(null); } },
            { glyph: "＋", title: "Save this chain as a preset", onClick: () => { setDialog({ mode: "chain", at: chainMenu.id }); setChainMenu(null); } },
            // The same act every effect bank has. A bank you can rename and remove sections in but
            // not ADD one to is a bank that can only ever shrink.
            { glyph: "▭", title: "Add a section to your saved chains", onClick: () => setDialog({ mode: "newSection", kind: CHAIN_KIND }) },
            ...(!!deck.fxChain(chainMenu.id)?.master
              ? [] // the master is the channel; it cannot leave
              : [{ glyph: "✕", title: `Delete ${(deck.fxChain(chainMenu.id)?.name ?? "")}`, danger: true, onClick: () => { removeChain(chainMenu.id); setChainMenu(null); } }]),
          ]}
        >
          {/* ★ THE STEMS, at the top of the menu that opens on the chip they belong to. Same
              control the sampler's pad menu uses to pick which parts of a grab to keep — one
              question, one widget, one set of colours. A stem has exactly one owner, so taking one
              takes it from whoever held it; there is no "both" to draw.
              Absent entirely with no stems on the deck: a chain cannot hear a stem that has not
              been separated, so the question does not apply and is not asked. */}
          {deck.hasStems && !deck.fxChain(chainMenu.id)?.master && (
            <>
              <StemPicker
                mask={deck.fxChain(chainMenu.id)?.stems ?? 0}
                onCommit={(m) => setChainStems(m, chainMenu.id)}
              />
              <div className="fx-preset-sep" />
            </>
          )}
          {/* ★ YOURS FIRST — the saved chains are what gets recalled mid-set; the factory bank
              below is a place you go shopping, once. */}
          {/* ONE INTERLEAVED LIST — yours and the shipped ones together, in the order you put them
              in. The old shape was "yours, a rule, then a read-only factory block", which is the
              two-lists model the effect banks abolished: it cannot express a chain of yours sitting
              inside a shipped section, and nothing in it could be reordered at all. */}
          {/* The same lane, one bank over (see .fx-end-strip). */}
          {chainSectionDrag.from != null && (
            <div className={`fx-end-strip ${chainSectionDrag.onto === "end" ? "drop" : ""}`} data-drop="end" data-group={`chaintop:${id}`} aria-hidden="true">
              TO THE END
            </div>
          )}
          <div className={`fx-top-zone ${chainSectionDrag.onto === "top" ? "drop" : ""} ${chainTopDrag.from != null || chainSectionDrag.from != null ? "dragging" : ""}`} data-drop="top" data-group={`chaintop:${id}`}>
            <div {...chainTopDrag.row} onPointerDownCapture={() => { chainDragged.current = false; }}>
              {chainRows.map((r, i) => (
                <Fragment key={`cr:${i}`}>
                  <DropLine show={chainTopDrag.at === i || (chainSectionDrag.onto === "top" && chainSectionDrag.intoAt === i)} />
                  {isGroup(r) ? (
                    <div
                      data-fly-row={`chain:${i}`}
                      className={`fx-preset-row fx-section-row ${chainFly?.at === i ? "hot" : ""} ${chainTopDrag.onto === String(i) || (chainSectionDrag.onto === String(i) && chainFly?.at !== i) ? "drop" : ""} ${chainTopDrag.from === i ? "reorder-source" : ""}`}
                      onMouseEnter={(e) => { if (chainRowMenu || chainTopDrag.from != null || chainSectionDrag.from != null) return; dropPeek(true); setChainFly({ at: i, name: r.name, ...flyFrom(e.currentTarget) }); }}
                      {...chainTopDrag.bind(i)}
                      {...chainTopDrag.foreign(String(i))}
                      {...longRow.bind({ kind: CHAIN_KIND, path: [i] as FxPath, group: true, name: r.name, factory: false })}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); dropPeek(true); openRowMenu(CHAIN_KIND, e.clientX, e.clientY, [i] as FxPath, true, r.name, false); }}
                    >
                      <button className="fx-palette-item fx-section-name" role="menuitem" title={`${r.name} — ${r.items.length} chain${r.items.length === 1 ? "" : "s"}`} onClick={(e) => { if (chainDragged.current) return; setChainFly({ at: i, name: r.name, ...flyFrom(e.currentTarget.parentElement as HTMLElement) }); }}>
                        <i className="fx-section-n">{r.items.length}</i>
                        <span className="fx-section-label">{r.name}</span>
                      </button>
                    </div>
                  ) : (
                    chainRow(r, [i] as FxPath, i, chainTopDrag)
                  )}
                </Fragment>
              ))}
              <DropLine show={chainTopDrag.at === chainRows.length || (chainSectionDrag.onto === "top" && chainSectionDrag.intoAt === chainRows.length)} />
            </div>
          </div>
        </Menu>
      )}

      {/* ★ THE SECOND WINDOW ON THE CHAIN MENU. Recalling a chain REPLACES what the chain holds,
          which is a destructive act behind a one-word label — "Vocal Air" tells you nothing about
          what it is or what it costs. So the same flyout that shows an effect's presets shows a
          chain's CONTENTS: which stems it claims, and the devices it brings, in signal order. */}
      {/* ★ THE SECTION'S CONTENTS — the second window, same widget and the opening menu's own
          MEASURED width, so the pair is one object at two sizes. This is what keeps the first
          window short: a section's presets are rows you do not see until you ask for them, which
          is also why they need no collapsed-state persisted anywhere. Closed by moving off it. */}
      {/* ★ THE SECTION'S CONTENTS — the second window, at the opening menu's own MEASURED width and
          hanging off the MENU's edge rather than the row's, so the two never overlap. Its rows are
          bare names too; delete, rename, revert and move-out are all on the right-click. */}
      {menu && menuDev && presetFly && (() => {
        const g = menuRows[presetFly.at];
        if (!g || !isGroup(g)) return null;
        return (
          <MenuFly
            anchor={presetFly.anchor}
            head={g.name}
            inert={presetDrag.from != null || sectionDrag.from != null}
            onEnter={() => setPresetFly(presetFly)}
            // ★ NOT WHILE A MENU IS OPEN ABOVE IT. The row menu's backdrop is `position: fixed;
            // inset: 0`, so the instant it mounts the pointer is over the backdrop and no longer
            // over this window — which fires mouseleave and closes the very window the menu was
            // opened FROM. A hover-dismissed panel cannot dismiss itself on a hover it never lost.
            // ★ NOR WHILE A DRAG IS RUNNING. Dragging a row OUT of this window is the whole point
            // of accepting the first window's targets — and the moment the pointer crosses the
            // edge, mouseleave fires and this window unmounts, taking `presetFly` with it. The drop
            // then has no source group to move FROM and silently does nothing, which is exactly
            // what "dragging out of a group doesn't work" looked like.
            onLeave={() => {
              if (!rowMenu && sectionDrag.from == null && presetDrag.from == null) setPresetFly(null);
            }}
          >
            {g.items.length === 0 ? null : (
              <div {...sectionDrag.row} onPointerDownCapture={() => { presetDragged.current = false; }}>
                {g.items.map((l, i) => (
                  <Fragment key={`i:${i}`}>
                    <DropLine show={sectionDrag.at === i} />
                    {presetRow(l, [presetFly.at, i] as FxPath, i, sectionDrag)}
                  </Fragment>
                ))}
                <DropLine show={sectionDrag.at === g.items.length} />
              </div>
            )}
          </MenuFly>
        );
      })()}

      {/* ★ THE ROW MENU — everything that used to be a glyph on a row. It is the third window, and
          it needs its own layer: the preset menu sits at z-index 41 and its flyout at 43, so a menu
          opened FROM the flyout has to sit above both or it opens underneath the thing that spawned
          it. Closing it must not close the menu behind it, which is why the backdrop is its own. */}
      {rowMenu && (
        <Menu x={rowMenu.x} y={rowMenu.y} head={rowMenu.name} onClose={() => setRowMenu(null)} layer={rowMenu.kind === CHAIN_KIND ? 4 : 3}>
          <button
            className="fx-palette-item"
            role="menuitem"
            onClick={() => {
              const r = rowMenu;
              setRowMenu(null);
              if (r.group) setDialog({ mode: "section", kind: r.kind, at: r.path[0], name: r.name });
              else setDialog({ mode: "renameRow", kind: r.kind as FxKind, path: r.path, name: r.name });
            }}
          >
            Rename
          </button>
          {/* Only a preset that HAS a factory original behind it can go back to one — an untouched
              reference has nothing to revert, and something you wrote yourself never had a shipped
              version to return to. */}
          {!rowMenu.group && !rowMenu.factory && factoryFxPresets(rowMenu.kind).some((f) => f.name === rowMenu.name) && (
            <button className="fx-palette-item" role="menuitem" onClick={() => { revertFxRow(rowMenu.kind, rowMenu.path); setRowMenu(null); bumpPresets(); }}>
              Revert to factory
            </button>
          )}
          {!rowMenu.group && rowMenu.path.length === 2 && (
            <button className="fx-palette-item" role="menuitem" onClick={() => { moveOutOfGroup(rowMenu.kind, rowMenu.path[0], rowMenu.path[1] as number); setRowMenu(null); closeBankFly(rowMenu.kind); bumpBank(rowMenu.kind); }}>
              Move out of section
            </button>
          )}
          <div className="fx-preset-sep" />
          <button
            className="fx-palette-item danger"
            role="menuitem"
            title={rowMenu.group ? "The presets inside it are kept" : rowMenu.factory ? "Restore it from Settings ▸ Audio" : undefined}
            onClick={() => {
              const r = rowMenu;
              setRowMenu(null);
              if (r.group) {
                deleteFxSection(r.kind, r.path[0]);
                closeBankFly(r.kind);
              } else deleteFxRow(r.kind, r.path);
              bumpBank(r.kind);
            }}
          >
            {rowMenu.group ? "Remove section" : "Delete"}
          </button>
        </Menu>
      )}

      {/* ★ THE SECTION'S CHAINS — the second window, exactly the preset menu's. The window that
          used to live here showed one chain's CONTENTS on hover; that manifest is in the row menu
          now (below). Three windows was already the ceiling, and a hover that could mean either
          "show me this section" or "show me this chain's devices" is not a gesture, it is a guess. */}
      {chainMenu && chainFly && (() => {
        const g = chainRows[chainFly.at];
        if (!g || !isGroup(g)) return null;
        return (
          <MenuFly
            anchor={chainFly.anchor}
            head={g.name}
            inert={chainTopDrag.from != null || chainSectionDrag.from != null}
            onEnter={() => setChainFly(chainFly)}
            onLeave={() => { if (!chainRowMenu && !rowMenu && chainSectionDrag.from == null && chainTopDrag.from == null) { setChainFly(null); dropPeek(); } }}
          >
            {g.items.length === 0 ? null : (
              <div {...chainSectionDrag.row} onPointerDownCapture={() => { chainDragged.current = false; }}>
                {g.items.map((l, i) => (
                  <Fragment key={`ci:${i}`}>
                    <DropLine show={chainSectionDrag.at === i} />
                    {chainRow(l, [chainFly.at, i] as FxPath, i, chainSectionDrag)}
                  </Fragment>
                ))}
                <DropLine show={chainSectionDrag.at === g.items.length} />
              </div>
            )}
          </MenuFly>
        );
      })()}

      {/* ★ THE THIRD WINDOW — what is IN this chain, hanging off the row you are pointing at. The
          stems are shown always, unlike the picker on the chip: this is a description, not a
          control, and a manifest may state a fact the deck cannot act on yet. */}
      {chainMenu && chainPeek && chainRowMenu == null && (
        <MenuFly layer={3} anchor={chainPeek.anchor} head={chainPeek.preset.name} onEnter={() => { holdPeek(); setChainPeek(chainPeek); }} onLeave={() => dropPeek(true)}>
          <div className="fly-stems">
            <span className="fly-key">Stems</span>
            <span className="fx-chain-src">
              {LANES.map((l) => (
                <i key={l.label} className={chainPeek.preset.stems & l.bit ? "on" : ""} style={{ ["--lane" as string]: l.color }}>
                  {l.label[0]}
                </i>
              ))}
            </span>
          </div>
          {chainPeek.preset.kinds.length === 0 ? (
            <div className="fly-empty">EMPTY</div>
          ) : (
            chainPeek.preset.kinds.map((k, i) => (
              <div key={`${k}${i}`} className="fly-line">
                <span className="fly-num">{i + 1}</span>
                <span className="fly-dev">{KIND_LABEL[k as FxKind] ?? k.toUpperCase()}</span>
              </div>
            ))
          )}
        </MenuFly>
      )}

      {/* ★ THE CHAIN ROW MENU — the FOURTH tier now: the peek above is a window at 45, and a menu
          opened from a row that can also be peeked has to clear it. */}
      {chainMenu && chainRowMenu && (
        <Menu x={chainRowMenu.x} y={chainRowMenu.y} head={chainRowMenu.preset.name} onClose={() => setChainRowMenu(null)} layer={4}>
          <button className="fx-palette-item" role="menuitem" onClick={() => { applyChainPreset(chainMenu.id, chainRowMenu.preset); setChainRowMenu(null); setChainFly(null); }}>
            Recall into this chain
          </button>
          <button className="fx-palette-item" role="menuitem" onClick={() => { setDialog({ mode: "chainPreset", name: chainRowMenu.preset.name }); setChainRowMenu(null); }}>
            Rename
          </button>
          {/* A factory chain you have edited or renamed can go back to what shipped — the same
              revert the effect presets have, from the same tombstone/ref machinery. */}
          {!chainRowMenu.factory && factoryChainPresets().some((f) => f.name === chainRowMenu.preset.name) && (
            <button className="fx-palette-item" role="menuitem" onClick={() => { revertFxRow(CHAIN_KIND, chainRowMenu.path); bumpChains(); setChainRowMenu(null); }}>
              Revert to factory
            </button>
          )}
          <button className="fx-palette-item danger" role="menuitem" onClick={() => { deleteFxRow(CHAIN_KIND, chainRowMenu.path); bumpChains(); setChainRowMenu(null); setChainFly(null); }}>
            Delete
          </button>
        </Menu>
      )}

      {/* The device picker — the preset menu's shape, one step earlier in the workflow. Step 1
          names the effect; step 2 names the sound it arrives with, so a device never lands in a
          chain in an unknown state. Both steps are the same list widget, so there is nothing new
          to learn and nothing new to style. */}
      {addMenu && chain && (
        <Menu x={addMenu.x} y={addMenu.y} onClose={() => { setAddMenu(null); setAddHover(null); setAddFly(null); }}>
          {/* CLICK ADDS. The two-step version made you answer a question you usually don't have —
              most of the time you want the effect, not a particular preset of it. So the click is
              the whole gesture, and the presets live in a flyout that opens on HOVER beside the
              menu: there when you want them, never in the way when you don't. */}
          {others.map((k) => {
            const has = addHas[k];
            // ★ TOUCH IS PERFORM *AND* CREATE. A phone has no keyboard and no controller, so
            // anything it cannot reach it cannot do at all — and the preset flyout opened on
            // HOVER, which does not exist on touch. So the chevron is its OWN tap target: tap the
            // name to add with Default, tap the › to choose what it lands on. Hover still opens it
            // for a mouse; the tap target is the parity, not a replacement.
            const openFly = (el: HTMLElement) => { setAddFly(null); setAddHover({ kind: k, ...flyFrom(el) }); };
            return (
              <button
                key={k}
                data-add-row={k}
                className={`fx-palette-item ${addHover?.kind === k ? "hot" : ""}`}
                role="menuitem"
                onMouseEnter={(e) => { if (has) openFly(e.currentTarget); }}
                onClick={() => { addDeviceToChain(k); setAddMenu(null); setAddHover(null); setAddFly(null); }}
              >
                {KIND_LABEL[k] ?? k.toUpperCase()}
                {has && (
                  <span
                    className="fx-add-more"
                    role="button"
                    tabIndex={-1}
                    aria-label={`${KIND_LABEL[k] ?? k} presets`}
                    title="Choose what it lands on"
                    onClick={(e) => { e.stopPropagation(); openFly(e.currentTarget.parentElement as HTMLElement); }}
                  >
                    ›
                  </span>
                )}
              </button>
            );
          })}
        </Menu>
      )}
      {/* ★ ONE BANK, TWO DOORS. This window used to render factoryFxPresets() — the SHIPPED list,
          flat and in code order — while the right-click menu renders the arrangement: your
          sections, your order, your saved presets, minus the ones you deleted. So the same effect
          offered two different lists depending on how you arrived at it, and the one on the ADD
          path was the one that could not be curated. It reads the same source now, renders the
          same rows with the same markup, and opens a section the same way. What it does NOT
          inherit is the editing — drag, rename, delete and revert stay in the menu that owns the
          bank. A picker that quietly rearranged your bank on the way past would be a worse
          disparity than the one this fixes. */}
      {addMenu && addHover && (
        <MenuFly
          anchor={addHover.anchor}
          head={KIND_LABEL[addHover.kind] ?? addHover.kind.toUpperCase()}
          onEnter={() => setAddHover(addHover)}
          // Not while the section window is open: the pointer leaves this one to reach that one.
          onLeave={() => { if (!addFly) { setAddHover(null); setAddFly(null); } }}
          // DEFAULT SITS WHERE IT SITS IN THE OTHER DOOR — a pinned chin under the list, behind the
          // same rule: it is the device's own reset state, not a preset, so it is never IN the list
          // and never scrolls with it. It used to lead here, which put the same two lists in two
          // different orders.
          chin={
            <>
              <button className="fx-palette-item" role="menuitem" onClick={() => { addDeviceToChain(addHover.kind); setAddMenu(null); setAddHover(null); setAddFly(null); }}>
                Default
              </button>
              {addGone > 0 && <div className="fx-preset-note">{addGone} hidden — Settings ▸ Audio</div>}
            </>
          }
        >
          {addRows.map((r, i) =>
            isGroup(r) ? (
              <div
                key={`as:${i}:${r.name}`}
                data-addfly-row={`add:${i}`}
                className={`fx-preset-row fx-section-row ${addFly?.at === i ? "hot" : ""}`}
                onMouseEnter={(e) => setAddFly({ at: i, name: r.name, ...flyFrom(e.currentTarget) })}
              >
                <button className="fx-palette-item fx-section-name" role="menuitem" title={`${r.name} — ${r.items.length} preset${r.items.length === 1 ? "" : "s"}`} onClick={(e) => setAddFly({ at: i, name: r.name, ...flyFrom(e.currentTarget.parentElement as HTMLElement) })}>
                  <i className="fx-section-n">{r.items.length}</i>
                  <span className="fx-section-label">{r.name}</span>
                </button>
              </div>
            ) : (
              addLeaf(r, `al:${i}`)
            ),
          )}
        </MenuFly>
      )}
      {addMenu && addHover && addFly && (() => {
        const g = addRows[addFly.at];
        if (!g || !isGroup(g)) return null;
        return (
          <MenuFly layer={3} anchor={addFly.anchor} head={g.name} onEnter={() => setAddFly(addFly)} onLeave={() => setAddFly(null)}>
            {g.items.map((l, i) => addLeaf(l, `af:${i}`))}
          </MenuFly>
        );
      })()}

      {dialog && (
        <PromptModal
          title={dialog.mode === "newSection" ? "New section" : dialog.mode === "section" ? "Rename section" : dialog.mode === "renameRow" ? "Rename preset" : dialog.mode === "chainPreset" ? "Rename saved chain" : dialog.mode === "chain" ? "Save chain" : dialog.mode === "save" ? `Save ${KIND_LABEL[dialog.kind] ?? dialog.kind.toUpperCase()} preset` : "Rename preset"}
          initial={dialog.mode === "rename" || dialog.mode === "chainPreset" || dialog.mode === "section" || dialog.mode === "renameRow" ? dialog.name : dialog.mode === "chain" ? deck.fxChain(dialog.at)?.name ?? "" : ""}
          placeholder={dialog.mode === "chain" || dialog.mode === "chainPreset" ? "Chain name" : dialog.mode === "section" || dialog.mode === "newSection" ? "Section name" : "Preset name"}
          submitLabel={dialog.mode === "rename" || dialog.mode === "chainPreset" || dialog.mode === "section" || dialog.mode === "renameRow" ? "Rename" : dialog.mode === "newSection" ? "Add" : "Save"}
          onSubmit={(v) => {
            if (dialog.mode === "chainPreset") {
              renameChainPreset(dialog.name, v);
              setChainTick((t) => t + 1);
              return;
            }
            if (dialog.mode === "chain") {
              const c = deck.fxChain(dialog.at);
              if (c) {
                saveChainPreset(v, c.stems, c.devices.map((d) => d.kind));
                deck.setFxChainName(c.id, v.trim().toUpperCase() || c.name);
                setChainTick((t) => t + 1);
                refresh();
              }
              return;
            }
            if (dialog.mode === "renameRow") {
              // Renaming a factory preset MATERIALISES it — the name is part of what you changed,
              // and the shipped one keeps its own so a revert still has something to point at.
              materialiseFxRow(dialog.kind, dialog.path, { name: v });
              setPresetTick((t) => t + 1);
              return;
            }
            if (dialog.mode === "newSection") {
              addFxSection(dialog.kind, v);
              bumpBank(dialog.kind);
              return;
            }
            if (dialog.mode === "section") {
              renameFxSection(dialog.kind, dialog.at, v);
              closeBankFly(dialog.kind); // its head would otherwise still say the old name
              bumpBank(dialog.kind);
              return;
            }
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
