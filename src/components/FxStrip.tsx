import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useEmit, useRefresh } from "../App/spine";
import type { Deck, FxKind, FxChain } from "@htl/audio";
import { loadFxPresets, saveFxPreset, renameFxPreset, deleteFxPreset, factoryFxPresets } from "@htl/audio";
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
import { MixFader } from "./MixFader";
import { useLongPress } from "./useLongPress";

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

  // ---- CHAINS ---------------------------------------------------------------------------------
  // A chain is a set of STEMS plus the devices that process them, and the set is a PARTITION: a
  // stem belongs to exactly one chain, so nothing is heard twice and the chains sum back to the
  // track. One chain over ALL stems IS the rack that has always shipped — that is the default,
  // and while it holds, every line below behaves exactly as it did before chains existed.
  //
  // The row of chain chips is the MASTER of a master/detail pair whose detail is the device row
  // that already exists. It costs one 22 px row and no width, which is the whole reason it is a
  // row of chips and not the rail this started as: the host is a ~450 px deck column, twice.
  const [chains, setChains] = useState<FxChain[]>([]);
  const [selChain, setSelChain] = useState(0); // index into `chains`; the master is always last
  const [stemPick, setStemPick] = useState(false); // the four-lane picker, open on the selected chip
  // ADD A DEVICE — a fork of the preset menu, in two steps: pick the effect, then pick the sound
  // it lands with. A chain is built the way a real chain is built, one deliberate device at a
  // time; the whole rack laid out at once and struck through was a list of things you did NOT
  // choose, which is the opposite of a workflow.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number; kind?: FxKind } | null>(null);
  const devices = deck.fxDevices; // the whole rack, in order
  // ★ NEVER PRESENT A HALF-BUILT RACK. The EQ is built in the Deck's constructor; the other eight
  // can only be built once the worklets attach, so for a beat at every boot `fxDevices` IS the EQ,
  // alone — and a strip that renders that list faithfully shows a one-tab rack with the EQ in it.
  // That's the legacy "EQ is the one special device" surface, reconstructed by accident, at load.
  const ready = deck.fxRackReady;
  const multi = chains.length > 1;
  const chain = chains[Math.min(selChain, Math.max(0, chains.length - 1))];
  // The device row shows the SELECTED chain's devices, in that chain's own order. With one chain
  // it is the whole rack, unfiltered — the original list, not a filtered copy of it.
  const tabs = !ready ? [] : multi && chain ? chain.kinds.map((k: FxKind) => devices.find((d) => d.kind === k)).filter(Boolean) as typeof devices : devices;
  // In multi-chain mode the row continues past this chain's devices with the ones it does NOT
  // hold, dimmed. Tapping a dim chip moves that device into this chain. That is the whole
  // populate gesture, and it works on a phone — drag-and-drop onto a chip is the mouse shortcut
  // for the same thing, not the only way in.
  const others = !ready || !multi || !chain ? [] : devices.filter((d) => !chain.kinds.includes(d.kind));
  const gi = (i: number) => (multi ? devices.findIndex((d) => d.kind === tabs[i]?.kind) : i); // shown index → rack index
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
  // The rack is FIXED-MEMBERSHIP: one instance of each device exists, so the default chain is
  // built from whatever the rack actually holds once the worklets land, never from a hard-coded
  // list that could drift from it.
  useEffect(() => {
    if (!ready || chains.length) return;
    setChains([{ id: "mix", name: "MIX", stems: 0, kinds: devices.map((d) => d.kind), master: true }]);
  }, [ready, chains.length, devices]);
  // Hand the model to the engine. A single all-stems chain is passed as EMPTY — not as a
  // one-chain special case but as "no chains", which restores the plain serial rack and switches
  // the per-stem taps back off. Nothing about the default path costs anything.
  useEffect(() => {
    if (!ready || !chains.length) return;
    const plain = chains.length === 1; // the master alone IS the serial rack
    deck.setFxChains(plain ? [] : chains);
  }, [deck, ready, chains]);
  // Selecting a chain whose devices don't include the current selection would leave the panel
  // showing a device this chain cannot hear.
  useEffect(() => {
    if (!multi || !chain) return;
    const here = devices[cur]?.kind;
    if (here && !chain.kinds.includes(here)) {
      const first = devices.findIndex((d) => d.kind === chain.kinds[0]);
      if (first >= 0) setSel(first);
    }
  }, [multi, chain, devices, cur]);
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
  const LANES: { bit: number; label: string; color: string }[] = [
    { bit: 1, label: "DRUM", color: "#ff5d73" },
    { bit: 2, label: "BASS", color: "#b06bff" },
    { bit: 4, label: "VOICE", color: "#5dff9e" },
    { bit: 8, label: "INST", color: "#36c2ff" },
  ];
  // The source read-out is the four INITIALS, each in its stem's colour, and it is always the
  // same four positions — so "which stems does this chain hear" is a glance at a fixed shape
  // (DBVI, D‧V‧, ‧‧VI) rather than a sentence to parse. "DRUM +1" made you count.
  // MIX is the special case: it is the catch-all every unclaimed stem falls back to, so when it
  // holds all four it says so in a word instead of spelling out the whole alphabet.
  const chainInitials = (c: FxChain) => LANES.map((l) => ({ ch: l.label[0], on: !!(c.stems & l.bit), color: l.color }));
  const chainTitle = (c: FxChain, i: number) => {
    const on = LANES.filter((l) => c.stems & l.bit).map((l) => l.label);
    if (!on.length) return `${c.name}: no stems — this chain hears nothing`;
    if (on.length === 4) return `${c.name}: every stem${i === 0 ? " (the mix)" : ""}`;
    return `${c.name}: ${on.join(", ")}`;
  };
  const toggleStem = (bit: number) => {
    setChains((prev) => {
      const cur = prev[selChain];
      if (!cur || cur.master) return prev; // the master takes the SUM of the chains, not stems
      const taking = !(cur.stems & bit);
      return prev.map((c, i) =>
        i === selChain
          ? { ...c, stems: taking ? c.stems | bit : c.stems & ~bit }
          : taking && !c.master
            ? { ...c, stems: c.stems & ~bit } // a stem has exactly one owner
            : c,
      );
    });
  };
  const addChain = () => {
    setChains((prev) => {
      const id = `c${prev.length}${Date.now().toString(36).slice(-3)}`;
      const at = Math.max(0, prev.length - 1); // …before the master, which is always last
      const next = [...prev];
      next.splice(at, 0, { id, name: `CHAIN ${at + 1}`, stems: 0, kinds: [] });
      return next;
    });
    setSelChain(Math.max(0, chains.length - 1));
    setStemPick(true); // a new chain hears nothing until it is given a stem — say so immediately
  };
  const dropDeviceOnChain = (kind: FxKind, target: number) => {
    setChains((prev) => prev.map((c, i) => (i === target ? { ...c, kinds: [...c.kinds.filter((k: FxKind) => k !== kind), kind] } : { ...c, kinds: c.kinds.filter((k: FxKind) => k !== kind) })));
    setSelChain(target);
  };
  const removeChain = (at: number) => {
    setChains((prev) => {
      const dead = prev[at];
      if (!dead || dead.master || prev.length < 2) return prev; // the master is the channel; it cannot leave
      // Its devices go home to the master rather than vanishing. Its STEMS need no rehoming: a
      // stem no chain claims runs dry into the sum, which is exactly where it belongs.
      return prev
        .map((c) => (c.master ? { ...c, kinds: [...c.kinds, ...dead.kinds.filter((k: FxKind) => !c.kinds.includes(k))] } : c))
        .filter((_, i) => i !== at);
    });
    setSelChain((v) => Math.max(0, v - 1));
  };

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
    if (multi && chain && dragFrom != null && dropAt != null) {
      // Multi-chain: order is a property of the CHAIN, not of the rack, so the reorder happens in
      // the chain's own kind list and the rack is left alone.
      const from = dragFrom, to = dragFrom < dropAt ? dropAt - 1 : dropAt;
      setChains((prev) =>
        prev.map((c, i) => {
          if (i !== selChain) return c;
          const ks = [...c.kinds];
          const [k] = ks.splice(from, 1);
          ks.splice(Math.max(0, Math.min(to, ks.length)), 0, k);
          return { ...c, kinds: ks };
        }),
      );
      setDragFrom(null);
      setDropAt(null);
      return;
    }
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
        select(Math.max(0, Math.min(live.current.len - 1, live.current.cur + dir)));
      },
      moveSel: (dir) => {
        const L = live.current;
        reorder(L.cur, Math.max(0, Math.min(L.len - 1, L.cur + dir)));
      },
      selectKind: (kind) => {
        const idx = deck.fxDevices.findIndex((d) => d.kind === kind);
        if (idx >= 0) select(idx);
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
    select(slot);
    setMenu({ slot, x: e.clientX, y: e.clientY });
  };
  // Touch has no right-click: long-press a tab to open its preset menu (was desktop-only).
  const tabLong = useLongPress<number>((slot, x, y) => { cancelMenuTimer(); select(slot); setMenu({ slot, x, y }); });
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
  /** Move a device into the selected chain and land it on a chosen starting point. The rack is
   *  fixed-membership, so this never CREATES a device — it claims the one instance that exists,
   *  which is also why the device leaves whatever chain held it before. */
  const addDeviceToChain = (kind: FxKind, preset?: { name: string; params: Record<string, number> }, presetIdx = 0) => {
    dropDeviceOnChain(kind, selChain);
    const slot = devices.findIndex((d) => d.kind === kind);
    if (slot < 0) return;
    select(slot);
    presetIdxRef.current[kind] = presetIdx;
    if (preset) applyPreset(slot, preset);
    else applyDefault(slot);
  };

  const applyDefault = (slot: number) => {
    const d = deck.fxDeviceAt(slot);
    if (!d) return;
    presetIdxRef.current[d.kind] = 0; // keep the hardware FX-SELECT cursor in sync with a mouse apply
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
      emit({ kind: "fxBypass", deck: id, slot: cur, value: selDev.bypassed });
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
  const copyToOther = () => {
    if (!selDev) return;
    deck.copyFxTo(otherDeck, cur); // ensures the other deck has the same device + params
    broadcastRack(otherId, otherDeck); // presence/order/effect-params
    emitControls(otherId); // eq params (and the rest of the other deck's control state)
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
      emit({ kind: "fxParam", deck: id, slot: cur, param: "mix", value: v });
    }
    refresh();
  };

  return (
    <div className="fx-strip" style={{ ["--accent" as string]: accent }}>
      {/* ★ THE CHAIN ROW — the master of a master/detail pair whose detail is the device row below
          it. One line, the same chip language, and it SCROLLS rather than compresses, so it costs
          a deck column nothing in width at any size. A chip carries the chain's name and, as a
          left edge, the colour of the stems it owns; the selected chip opens the four-lane picker
          when tapped again. Drag a device tab onto a chip to move that device into that chain. */}
      {ready && chains.length > 0 && (
        <div className="fx-chains">
          {chains.map((c, i) =>
            c.master ? (
              <span key="add-wrap" className="fx-chain-tail">
              <button className="fx-chain add" title="New chain" onClick={addChain}>
                ＋
              </button>
              {/* ★ THE MASTER, pinned rightmost at a constant place — because that is where it
                  is in the SIGNAL, not a layout preference. It has no stem selector: it does not
                  take stems, it takes the SUM of the chains, after them. */}
              <button
                key={c.id}
                className={`fx-chain master ${i === selChain ? "sel" : ""}`}
                title={`${c.name}: the master channel — every chain sums here`}
                onClick={() => { setSelChain(i); setStemPick(false); }}
                onDragOver={(e) => { if (dragFrom != null) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
                onDrop={(e) => {
                  e.preventDefault();
                  const k = tabs[dragFrom ?? -1]?.kind;
                  if (k) dropDeviceOnChain(k, i);
                  setDragFrom(null);
                  setDropAt(null);
                }}
              >
                <span className="fx-chain-name">{c.name}</span>
              </button>
              </span>
            ) : (
              <button
                key={c.id}
                className={`fx-chain ${i === selChain ? "sel" : ""} ${c.stems === 0 ? "deaf" : ""}`}
                title={chainTitle(c, i)}
                onClick={() => {
                  if (i === selChain) setStemPick((v) => !v);
                  else { setSelChain(i); setStemPick(false); }
                }}
                onContextMenu={(e) => { e.preventDefault(); removeChain(i); }}
                onDragOver={(e) => { if (dragFrom != null) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
                onDrop={(e) => {
                  e.preventDefault();
                  const k = tabs[dragFrom ?? -1]?.kind;
                  if (k) dropDeviceOnChain(k, i);
                  setDragFrom(null);
                  setDropAt(null);
                }}
              >
                <span className="fx-chain-name">{c.name}</span>
                <span className="fx-chain-src">
                  {chainInitials(c).map((x) => (
                    <i key={x.ch} className={x.on ? "on" : ""} style={{ ["--lane" as string]: x.color }}>
                      {x.ch}
                    </i>
                  ))}
                </span>
              </button>
            ),
          )}
        </div>
      )}
      {/* The picker, only while a chain's sources are being set. Taking a stem takes it FROM
          whoever had it: the chains are a partition, so there is no "both" to draw. */}
      {ready && stemPick && chain && (
        <div className="fx-stems">
          {LANES.map((l) => {
            const mine = !!(chain.stems & l.bit);
            const ownerIdx = chains.findIndex((c) => c.stems & l.bit);
            return (
              <button
                key={l.label}
                className={`fx-stem ${mine ? "on" : ""}`}
                style={{ ["--lane" as string]: l.color }}
                title={mine ? `${l.label} → ${chain.name}` : ownerIdx >= 0 ? `${l.label} is in ${chains[ownerIdx].name} — tap to take it` : `${l.label} is unrouted`}
                onClick={() => toggleStem(l.bit)}
              >
                {l.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="fx-head">
      <div className="fx-tabs" role="tablist" ref={tabsRef}>
        {tabs.map((d, i) => (
          <button
            key={d.kind}
            className={`fx-tab ${cur === gi(i) ? "sel" : ""} ${d.bypassed || (d.kind === "eq" && deck.eqBypassed) ? "bypassed" : ""} ${dropAt === i ? "drop-before" : ""} ${dropAt === i + 1 ? "drop-after" : ""} ${dragFrom === i ? "dragging" : ""}`}
            onClick={() => { if (tabLong.fired.current) return; select(gi(i)); }}
            onContextMenu={(e) => openPresetMenu(e, gi(i))}
            {...tabLong.bind(gi(i))}
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
            className={`fx-drop-end ${dropAt === tabs.length ? "active" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dropAt !== tabs.length) setDropAt(tabs.length);
            }}
            onDrop={(e) => {
              e.preventDefault();
              dropHere();
            }}
          />
        )}
        {/* ＋ — the only way a device enters a chain. Opens the two-step picker below. */}
        {multi && others.length > 0 && (
          <button
            className="fx-tab fx-tab-add"
            title="Add an effect to this chain"
            onClick={(e) => { cancelMenuTimer(); setMenu(null); setAddMenu({ x: e.clientX, y: e.clientY }); }}
          >
            ＋
          </button>
        )}
        {/* Fixed-membership rack: the EQ + the pad-FX bank are permanent residents — no add/remove.
            Reorder by dragging a tab; dial / save presets by right-clicking one. */}
      </div>
        {/* COPY — touched about once a session. Tucked into the header, out of the way of the
            three controls you actually perform with. Parked outside the scrolling tab row so it
            doesn't slide off. */}
        {selDev && (
          <button className="fx-copy" title={`Copy this device to deck ${otherId}`} aria-label={`Copy this device to deck ${otherId}`} onClick={copyToOther}>
            ⇄
          </button>
        )}
      </div>

      <div className="fx-stage">
        {multi && chain && chain.kinds.length === 0 ? (
          <div className="fx-panel fx-unknown">
            {chain.name} is empty — tap a dimmed device above to move it into this chain.
          </div>
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

      {/* The device picker — the preset menu's shape, one step earlier in the workflow. Step 1
          names the effect; step 2 names the sound it arrives with, so a device never lands in a
          chain in an unknown state. Both steps are the same list widget, so there is nothing new
          to learn and nothing new to style. */}
      {addMenu && chain && (
        <>
          <div className="fx-menu-backdrop" onClick={() => setAddMenu(null)} onContextMenu={(e) => { e.preventDefault(); setAddMenu(null); }} />
          <div className="fx-palette fx-preset-menu" role="menu" style={{ left: addMenu.x, top: addMenu.y }}>
            {!addMenu.kind ? (
              <>
                <div className="fx-preset-head">Add to {chain.name}</div>
                {others.map((d) => (
                  <button key={d.kind} className="fx-palette-item" role="menuitem" onClick={() => setAddMenu({ ...addMenu, kind: d.kind })}>
                    {KIND_LABEL[d.kind] ?? d.kind.toUpperCase()}
                  </button>
                ))}
              </>
            ) : (
              <>
                <div className="fx-preset-head">
                  <button className="fx-preset-back" title="Back to the effect list" onClick={() => setAddMenu({ x: addMenu.x, y: addMenu.y })}>
                    ‹
                  </button>
                  {KIND_LABEL[addMenu.kind] ?? addMenu.kind.toUpperCase()} — start from
                </div>
                <button
                  className="fx-palette-item"
                  role="menuitem"
                  onClick={() => { addDeviceToChain(addMenu.kind!); setAddMenu(null); }}
                >
                  Default
                </button>
                {factoryFxPresets(addMenu.kind).length > 0 && <div className="fx-preset-sep" />}
                {factoryFxPresets(addMenu.kind).map((pr, i) => (
                  <button
                    key={pr.name}
                    className="fx-palette-item fx-preset-apply"
                    role="menuitem"
                    onClick={() => { addDeviceToChain(addMenu.kind!, pr, i + 1); setAddMenu(null); }}
                  >
                    {pr.name}
                  </button>
                ))}
              </>
            )}
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
