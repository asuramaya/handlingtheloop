import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Deck } from "@htl/audio";
import { useEngine } from "../App/spine";
import { type SamplerApi } from "./useSampler";
import { ValueCell } from "./ValueCell";
import { Menu } from "./ContextMenu";
import { MasterFader } from "./MasterFader";
import { Crossfader } from "./Crossfader";

// ★ THE BOARD'S ONE ROW. There used to be two: a full-width I/O strip of seven equal-weight cells,
// and the crossfader beneath it. The strip was permanently full because its content was gated on
// `engine.canMic` — which is `!!getUserMedia`, i.e. "this is a browser" — so every DJ carried MIC /
// DUCK / MON / BLEND / LVL forever whether they owned a microphone or not.
//
// Sorting those controls by how often you touch them settles the whole layout:
//   • MASTER + the limiter — a READOUT you want to see constantly, set once.
//   • MIC on/off — mid-set, urgent, one gesture. (It has a key now: see `micToggle`.)
//   • REC — deliberate, occasional.
//   • DUCK · DEST · MON · BLEND · LVL — configuration. Once per gig, per rig.
// Five of the seven are settings wearing performance clothes. So the row is: the master fader at
// one end, the crossfader between, and a CONTEXTUAL GLYPH per plugged-in device at the other —
// each glyph one tap for the thing you actually do, and a hold / right-click for its cluster.
// The board gets a whole row of height back and nothing became unreachable.

type CapSource = "master" | "deckA" | "deckB" | "mic";
const SRC_LABEL: Record<CapSource, string> = { master: "MST", deckA: "A", deckB: "B", mic: "MIC" };
const SRC_FULL: Record<CapSource, string> = { master: "Master mix", deckA: "Deck A", deckB: "Deck B", mic: "Mic" };
const SRC_TAKE: Record<CapSource, string> = { master: "Master take", deckA: "Deck A take", deckB: "Deck B take", mic: "Mic take" };
const DEST_FULL: Record<"master" | "A" | "B", string> = { master: "Room (master / PA)", A: "Deck A — FX rack", B: "Deck B — FX rack" };
const HOLD_MS = 460; // touch long-press → the glyph's cluster (the same threshold useLongPress uses)

export function BoardBar({
  sampler,
  ctlRef,
  micSetRef,
  micToggleRef,
  phones,
  master,
  hasMic = false,
  xfader,
}: {
  sampler: SamplerApi;
  ctlRef?: MutableRefObject<{ trigger: (i: number) => void; release: (i: number) => void } | null>;
  micSetRef?: MutableRefObject<((v: number) => void) | null>; // App pushes the FLX MIC knob value in
  micToggleRef?: MutableRefObject<(() => void) | null>; // the `micToggle` key + any controller reaches the mic through here
  phones?: { mix: number; level: number; onMix: (v: number) => void; onLevel: (v: number) => void } | null;
  master?: { value: number; canControl: boolean; onChange: (v: number) => void };
  hasMic?: boolean;
  xfader: {
    deckA: Deck; deckB: Deck; accentA: string; accentB: string; crossfade: number;
    onCrossfade: (v: number) => void; locked?: boolean; smart?: boolean; enabled?: boolean;
    canControl?: boolean; kbd?: string; onToggleSmart?: () => void; onToggleEnabled?: () => void;
  };
}) {
  const s = sampler;
  const engine = useEngine();

  const [micOn, setMicOn] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [micVol, setMicVol] = useState(0.85);
  const [duck, setDuck] = useState(0.6);
  const [monitor, setMonitor] = useState(false); // PFL — hear the mic in the cue/headphone bus
  const [micDest, setMicDest] = useState<"master" | "A" | "B">("master");
  const [recSrc, setRecSrc] = useState<CapSource>("master");
  const [recording, setRecording] = useState(false);
  const [ioErr, setIoErr] = useState<string | null>(null);
  const meterRef = useRef<HTMLSpanElement>(null);
  const [landed, setLanded] = useState<number | null>(null);
  const landedTmr = useRef<number | undefined>(undefined);
  const flashLanded = (gi: number) => {
    setLanded(gi);
    clearTimeout(landedTmr.current);
    landedTmr.current = window.setTimeout(() => setLanded(null), 2600);
  };
  useEffect(() => () => clearTimeout(landedTmr.current), []);

  useEffect(() => {
    if (micSetRef) micSetRef.current = setMicVol;
    return () => { if (micSetRef) micSetRef.current = null; };
  }, [micSetRef]);

  // Live input level, painted onto the mic glyph itself while it is live.
  useEffect(() => {
    if (!micOn && !monitor) return;
    let raf = 0;
    const tick = () => {
      if (meterRef.current) meterRef.current.style.height = `${Math.round(engine.micLevel * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, micOn, monitor]);

  // Talkover on/off; first use acquires the mic (permission prompt).
  const toggleMic = async () => {
    if (!engine.micReady) {
      setMicBusy(true);
      const ok = await engine.enableMic();
      setMicBusy(false);
      if (!ok) { setIoErr("Mic unavailable — check the browser permission (needs HTTPS)."); return; }
      engine.setMicLevel(micVol);
      engine.setMicDuck(duck);
    }
    const next = !micOn;
    setMicOn(next);
    engine.setMicOn(next);
  };
  // ★ THE KEY. The mic had no binding at all, which is what made a permanent on-screen button the
  // only way in on every surface — and so what kept the whole input section pinned to the board.
  // Give it a key and the glyph is free to be small and contextual. Ref-published so the keymap
  // reaches the live closure rather than a stale one.
  const liveMic = useRef(toggleMic);
  liveMic.current = toggleMic;
  useEffect(() => {
    if (!micToggleRef) return;
    micToggleRef.current = () => void liveMic.current();
    return () => { if (micToggleRef) micToggleRef.current = null; };
  }, [micToggleRef]);

  const toggleMonitor = async () => {
    if (!engine.micReady) {
      const ok = await engine.enableMic();
      if (!ok) { setIoErr("Mic unavailable — check the browser permission (needs HTTPS)."); return; }
    }
    const next = !monitor;
    setMonitor(next);
    engine.setMicMonitor(next);
  };

  const toggleRec = async () => {
    if (recording) {
      setRecording(false);
      const take = await engine.stopCapture();
      if (take) { const gi = await s.captureToGlobal(take, SRC_TAKE[recSrc]); if (gi != null) flashLanded(gi); }
      else setIoErr("Nothing captured.");
      return;
    }
    setIoErr(null);
    if (recSrc === "mic" && !engine.micReady) {
      const ok = await engine.enableMic();
      if (!ok) { setIoErr("Mic unavailable — check the browser permission (needs HTTPS)."); return; }
    }
    if (engine.startCapture(recSrc)) setRecording(true);
    else setIoErr("Couldn't start recording.");
  };

  useEffect(() => {
    if (!ctlRef) return;
    ctlRef.current = { trigger: s.trigger, release: s.release };
    return () => { if (ctlRef) ctlRef.current = null; };
  }, [ctlRef, s.trigger, s.release]);

  // ONE POPOVER STATE for the three glyphs. Each is the same widget the FX and sampler menus use,
  // so the positioning, the flip-then-clamp and the backdrop are solved once, everywhere.
  const [pop, setPop] = useState<{ kind: "mic" | "rec" | "cue"; x: number; y: number } | null>(null);
  const holdTmr = useRef<number | undefined>(undefined);
  const held = useRef(false); // the hold fired → swallow the tap that follows it
  // Tap does the thing; hold / right-click opens the cluster. The same grammar as the FX pads and
  // the chain chips — third surface, one gesture vocabulary.
  const glyphHold = (kind: "mic" | "rec" | "cue") => ({
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setPop({ kind, x: e.clientX, y: e.clientY }); },
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      held.current = false;
      clearTimeout(holdTmr.current);
      holdTmr.current = window.setTimeout(() => { held.current = true; navigator.vibrate?.(8); setPop({ kind, x: t.clientX, y: t.clientY }); }, HOLD_MS);
    },
    onTouchEnd: () => clearTimeout(holdTmr.current),
    onTouchMove: () => clearTimeout(holdTmr.current),
  });
  const tapped = (fn: () => void) => () => { if (held.current) { held.current = false; return; } fn(); };
  const SRC_ORDER: CapSource[] = hasMic ? ["master", "deckA", "deckB", "mic"] : ["master", "deckA", "deckB"];

  return (
    <div className="board-bar">
      {master && (
        <MasterFader engine={engine} value={master.value} onChange={master.onChange} disabled={!master.canControl} />
      )}
      <Crossfader {...xfader} />
      {/* THE DEVICE GLYPHS — each present only while its device is. A board with no microphone and
          no cue output shows one: the record dot. */}
      <div className="board-io">
        {hasMic && (
          <button
            className={`io-glyph io-mic ${micOn ? "on" : ""} ${micBusy ? "busy" : ""}`}
            onClick={tapped(() => void toggleMic())}
            title={`${micOn ? "Talkover ON" : "Talkover off"} — tap to toggle · right-click / hold for level, ducking, destination and monitoring`}
            aria-label="Microphone talkover"
            aria-pressed={micOn}
            {...glyphHold("mic")}
          >
            <span className="io-glyph-meter"><span ref={meterRef} /></span>
            <span className="io-glyph-mark">🎙</span>
          </button>
        )}
        <button
          className={`io-glyph io-rec ${recording ? "armed" : ""}`}
          onClick={tapped(() => void toggleRec())}
          title={recording ? "Stop — the take drops into the next free GLBL pad" : `Record ${SRC_FULL[recSrc]} → next free GLBL pad · right-click / hold to change source`}
          aria-label="Record"
          {...glyphHold("rec")}
        >
          <span className="io-glyph-mark">{recording ? "■" : "●"}</span>
          <span className="io-glyph-tag">{SRC_LABEL[recSrc]}</span>
        </button>
        {phones && (
          <button
            className="io-glyph io-cue"
            onClick={tapped(() => setPop({ kind: "cue", x: 0, y: 0 }))}
            title="Headphone cue — blend and level"
            aria-label="Headphone cue"
            onContextMenu={(e) => { e.preventDefault(); setPop({ kind: "cue", x: e.clientX, y: e.clientY }); }}
          >
            <span className="io-glyph-mark">🎧</span>
          </button>
        )}
        {/* Where the take landed — GLBL pad-mode is on the decks, not beside this row. */}
        {landed != null && <span className="io-landed" role="status">→ GLBL {landed + 1}</span>}
      </div>

      {(s.error || ioErr) && (
        <div className="smp-error" role="status" onClick={() => { s.clearError(); setIoErr(null); }}>
          {s.error || ioErr} <span className="smp-error-x">✕</span>
        </div>
      )}

      {/* THE CLUSTERS. Everything that is configuration, behind the glyph it configures. Built on
          the shared Menu, which retires one more `.ctx-menu` hand-positioned popup. */}
      {pop?.kind === "mic" && (
        <Menu x={pop.x || 40} y={pop.y || 40} head="MIC" onClose={() => setPop(null)}>
          <div className="io-pop-row">
            <ValueCell className="io-pop-cell" label="LEVEL" value={micVol} min={0} max={1} step={0.02} reset={0.85}
              format={(v) => `${Math.round(v * 100)}`} onChange={(v) => { setMicVol(v); engine.setMicLevel(v); }} />
            <ValueCell className="io-pop-cell" label="DUCK" value={duck} min={0} max={1} step={0.02} reset={0.6}
              format={(v) => `${Math.round(v * 100)}`} onChange={(v) => { setDuck(v); engine.setMicDuck(v); }} />
          </div>
          <div className="fx-preset-sep" />
          <div className="ctx-label">Mic goes to</div>
          {(["master", "A", "B"] as const).map((d) => (
            <button key={d} className={`fx-palette-item ${micDest === d ? "sel" : ""}`} role="menuitem" title={DEST_FULL[d]}
              onClick={() => { setMicDest(d); engine.setMicRoute(d); }}>
              {DEST_FULL[d]}
            </button>
          ))}
          {/* MONITOR needs a mic AND somewhere private to hear it, so it only exists with both. */}
          {phones && (
            <>
              <div className="fx-preset-sep" />
              <button className={`fx-palette-item ${monitor ? "sel" : ""}`} role="menuitem"
                onClick={() => void toggleMonitor()}>
                {monitor ? "✓ " : ""}Monitor in headphones
              </button>
            </>
          )}
        </Menu>
      )}
      {pop?.kind === "rec" && (
        <Menu x={pop.x || 40} y={pop.y || 40} head="RECORD FROM" onClose={() => setPop(null)}>
          {SRC_ORDER.map((srcOpt) => (
            <button key={srcOpt} className={`fx-palette-item ${recSrc === srcOpt ? "sel" : ""}`} role="menuitem"
              onClick={() => { setRecSrc(srcOpt); setPop(null); }}>
              {SRC_FULL[srcOpt]}
            </button>
          ))}
        </Menu>
      )}
      {pop?.kind === "cue" && phones && (
        <Menu x={pop.x || 40} y={pop.y || 40} head="CUE" onClose={() => setPop(null)}>
          <div className="io-pop-row">
            {/* BLEND, not "MIX", so it never collides with the REC source value MST. */}
            <ValueCell className="io-pop-cell" label="BLEND" value={phones.mix} min={0} max={1} pivot={0.5}
              format={(v) => (v < 0.48 ? "CUE" : v > 0.52 ? "MST" : "MID")} onChange={phones.onMix} />
            <ValueCell className="io-pop-cell" label="LVL" value={phones.level} min={0} max={1} reset={1}
              format={(v) => `${Math.round(v * 100)}`} onChange={phones.onLevel} />
          </div>
        </Menu>
      )}
    </div>
  );
}
