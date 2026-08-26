import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Deck } from "@htl/audio";
import { useEngine } from "../App/spine";
import { type SamplerApi } from "./useSampler";
import { ValueCell } from "./ValueCell";
import { Menu } from "./ContextMenu";
import { MasterFader } from "./MasterFader";
import { Crossfader } from "./Crossfader";

// ★ THE BOARD BAR: A GLOBALS STRIP, THEN THE CROSSFADER ALONE ON ITS OWN LINE.
//
// It began as a full-width I/O strip of seven equal-weight cells above the fader, permanently full
// because its content was gated on `engine.canMic` — which is `!!getUserMedia`, i.e. "this is a
// browser" — so every DJ carried MIC / DUCK / MON / BLEND / LVL forever whether they owned a
// microphone or not. Gating that properly emptied it, and everything left fitted on one line WITH
// the fader — which is where the real constraint showed up.
//
// ★ NOTHING SHARES THE CROSSFADER'S LINE. Its centre is a CLAIM: at 50 the mix is equal, and the
// pixel that says so has to be the seam between deck A's column and deck B's. Anything flanking it
// pushes that pixel by half the flanks' difference (measured: 163px of master vs 83px of glyphs put
// the centre 40px into B). Balancing the flanks fixes it on a desktop and kills it on a phone —
// two 163px flanks on a 390px board leave the fader 64px of throw, which is a switch, not a
// crossfader. Anything flanking the fader costs a PROPORTION of the board, never a constant.
// So nothing flanks it. The fader is full-width and dead-centre at every size, with no arithmetic
// to get wrong and no breakpoint to maintain — which is the whole point of one surface that scales
// both ways.
//
// The strip above it holds what is genuinely global, sorted by how often you touch it:
//   • MASTER + the limiter — a readout you want to see constantly, set once.
//   • MIC — on/off AND level, both one gesture, because a live mic is ridden, not configured.
//   • REC — deliberate, occasional.
//   • DUCK · DEST · MON · BLEND · LVL — configuration. Once per gig, per rig, behind a hold.
// Because the strip constrains nothing, its contents are free to be contextual: a board with no
// microphone and no cue output shows a master and a record dot, and that is the whole line.

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
      {/* THE GLOBALS STRIP. It constrains nothing below it, so it is free to be lopsided: master at
          the left edge, devices at the right, whatever is between them empty. */}
      <div className="board-globals">
        {master && (
          <MasterFader engine={engine} value={master.value} onChange={master.onChange} disabled={!master.canControl} />
        )}
        <span className="board-gap" />
        {/* Each control present only while its device is. */}
        <div className="board-io">
        {/* ★ A LIVE MIC IS RIDDEN, NOT CONFIGURED. On/off and level are both things you reach for
            mid-sentence, so neither is allowed to be a tap deep: this is a cell, not a glyph —
            TAP toggles talkover, DRAG sets the level, and only the settings you dial once (ducking,
            destination, monitoring) live behind the hold. Its live input rises inside it, so "is it
            hearing me" is on the control you just pressed. */}
        {hasMic && (
          <ValueCell
            className={`board-cell io-mic ${micOn ? "on" : ""}`}
            label={micBusy ? "MIC…" : "MIC"}
            value={micVol}
            min={0}
            max={1}
            step={0.02}
            reset={0.85}
            active={micOn}
            disabled={micBusy}
            format={(v) => `${Math.round(v * 100)}`}
            onTap={() => void toggleMic()}
            onChange={(v) => { setMicVol(v); engine.setMicLevel(v); }}
            onContextMenu={(e) => setPop({ kind: "mic", x: e.clientX, y: e.clientY })}
          >
            <span className="io-glyph-meter"><span ref={meterRef} /></span>
          </ValueCell>
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
      </div>
      {/* ★ ALONE ON ITS LINE, full width, centre on the deck seam — at every screen size. */}
      <Crossfader {...xfader} />

      {(s.error || ioErr) && (
        <div className="smp-error" role="status" onClick={() => { s.clearError(); setIoErr(null); }}>
          {s.error || ioErr} <span className="smp-error-x">✕</span>
        </div>
      )}

      {/* THE CLUSTERS. Everything that is configuration, behind the glyph it configures. Built on
          the shared Menu, which retires one more `.ctx-menu` hand-positioned popup. */}
      {/* LEVEL is NOT in the mic cluster — it is on the cell you opened this from. A setting that
          has a home on the board does not get a second one in a menu. */}
      {pop?.kind === "mic" && (
        <Menu x={pop.x || 40} y={pop.y || 40} head="MIC" onClose={() => setPop(null)}>
          <div className="io-pop-row">
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
