import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useEngine } from "../App/spine";
import { type SamplerApi } from "./useSampler";
import { ValueCell } from "./ValueCell";
import { SmartChip } from "./SmartChip";
import { MeterBar } from "./MeterBar";

// Capture sources for the record button, in cycle order. MIC is only offered when getUserMedia
// exists. Each captures into the next free global pad (owned-audio tier).
type CapSource = "master" | "deckA" | "deckB" | "mic";
const SRC_LABEL: Record<CapSource, string> = { master: "MST", deckA: "A", deckB: "B", mic: "MIC" };
const SRC_FULL: Record<CapSource, string> = { master: "Master mix", deckA: "Deck A", deckB: "Deck B", mic: "Mic" };
const SRC_TAKE: Record<CapSource, string> = { master: "Master take", deckA: "Deck A take", deckB: "Deck B take", mic: "Mic take" };
// Where the mic signal GOES (folded into the MIC buttonoid's right-click). Default = the room.
const DEST_FULL: Record<"master" | "A" | "B", string> = { master: "Room (master / PA)", A: "Deck A — FX rack", B: "Deck B — FX rack" };

// Controls-only strip (MIC / capture / headphone). The GLOBAL sample pads moved into the decks'
// GLBL pad-mode (SMP+shift); captures still land in the next free global pad, played from there.

export function SamplerStrip({
  sampler,
  ctlRef,
  micSetRef,
  phones,
  smart,
}: {
  sampler: SamplerApi; // lifted to App (shared with the decks' SAMPLER pad-mode)
  ctlRef?: MutableRefObject<{ trigger: (i: number) => void; release: (i: number) => void } | null>;
  micSetRef?: MutableRefObject<((v: number) => void) | null>; // App pushes the FLX MIC knob value into the cell
  // Master headphone (cue-device) controls — joins the IO zone only when a 2nd output is set.
  // Owned by App so the FLX 🎧 MIX knob and these cells stay in step.
  phones?: { mix: number; level: number; onMix: (v: number) => void; onLevel: (v: number) => void } | null;
  // The crossfader's SMART chip lives here (between the mic and capture zones) — see SmartChip.
  smart?: { armed: boolean; enabled: boolean; canControl: boolean; shift: boolean; kbd: string; accentA: string; accentB: string; master: number; onToggleSmart: () => void; onToggleEnabled: () => void; onMaster: (v: number) => void };
}) {
  const s = sampler;
  const engine = useEngine();
  // Master limiter GR — the brickwall was invisible (measured, never rendered, per open thread
  // 32156af1). Reuses the same MeterBar primitive Saturator's own output meter uses.
  const getMasterGr = useMemo(() => () => engine.masterGr, [engine]);

  // Mic (talkover) + capture-record controls. Captures land in the next free GLOBAL pad.
  const [micOn, setMicOn] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [micVol, setMicVol] = useState(0.85); // talkover VOLUME (engine.setMicLevel)
  // Let App push the FLX MIC LEVEL knob value into this cell (the knob drives the engine
  // directly; this only keeps the display in step). setMicVol is stable.
  useEffect(() => {
    if (micSetRef) micSetRef.current = setMicVol;
    return () => {
      if (micSetRef) micSetRef.current = null;
    };
  }, [micSetRef]);
  const [duck, setDuck] = useState(0.6);
  const [monitor, setMonitor] = useState(false); // PFL — hear the mic in the cue/headphone bus
  const [micDest, setMicDest] = useState<"master" | "A" | "B">("master"); // PA, or into a deck's FX rack
  const [recSrc, setRecSrc] = useState<CapSource>("master");
  const [recording, setRecording] = useState(false);
  const [ioErr, setIoErr] = useState<string | null>(null);
  const meterRef = useRef<HTMLSpanElement>(null);
  // Capture-landed feedback: REC/CATCH deposit into a global pad that no longer sits beside the
  // strip (it's in GLBL pad-mode now), so flash "→ GLBL n" briefly to show where the take went.
  const [landed, setLanded] = useState<number | null>(null);
  const landedTmr = useRef<number | undefined>(undefined);
  const flashLanded = (gi: number) => {
    setLanded(gi);
    clearTimeout(landedTmr.current);
    landedTmr.current = window.setTimeout(() => setLanded(null), 2600);
  };
  useEffect(() => () => clearTimeout(landedTmr.current), []);

  // Live input-level meter: drive a bar width from engine.micLevel while the mic is live.
  useEffect(() => {
    if (!micOn && !monitor) return;
    let raf = 0;
    const tick = () => {
      if (meterRef.current) meterRef.current.style.width = `${Math.round(engine.micLevel * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, micOn, monitor]);

  // Toggle talkover; first use acquires the mic (permission prompt).
  const toggleMic = async () => {
    if (!engine.micReady) {
      setMicBusy(true);
      const ok = await engine.enableMic();
      setMicBusy(false);
      if (!ok) {
        setIoErr("Mic unavailable — check the browser permission (needs HTTPS).");
        return;
      }
      engine.setMicLevel(micVol);
      engine.setMicDuck(duck);
    }
    const next = !micOn;
    setMicOn(next);
    engine.setMicOn(next);
  };

  // Monitor (PFL): hear the mic in the cue device. First use acquires the mic.
  const toggleMonitor = async () => {
    if (!engine.micReady) {
      const ok = await engine.enableMic();
      if (!ok) {
        setIoErr("Mic unavailable — check the browser permission (needs HTTPS).");
        return;
      }
    }
    const next = !monitor;
    setMonitor(next);
    engine.setMicMonitor(next);
  };

  // The mic destination + REC source are no longer their own cells — they're folded into the MIC
  // buttonoid (right-click → DEST) and the REC button (right-click / hold → SRC). A little popup
  // picks the value directly.
  const [routeMenu, setRouteMenu] = useState<{ kind: "dest" | "src"; x: number; y: number } | null>(null);
  const recLong = useRef<number | undefined>(undefined);
  const recSuppress = useRef(false);
  const pickDest = (d: "master" | "A" | "B") => { setMicDest(d); engine.setMicRoute(d); setRouteMenu(null); };
  const SRC_ORDER: CapSource[] = engine.canMic ? ["master", "deckA", "deckB", "mic"] : ["master", "deckA", "deckB"];

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
      if (!ok) {
        setIoErr("Mic unavailable — check the browser permission (needs HTTPS).");
        return;
      }
    }
    if (engine.startCapture(recSrc)) setRecording(true);
    else setIoErr("Couldn't start recording.");
  };
  // Expose trigger/release so App's MIDI handler can fire the pads (kept out of App state).
  useEffect(() => {
    if (!ctlRef) return;
    ctlRef.current = { trigger: s.trigger, release: s.release };
    return () => {
      ctlRef.current = null;
    };
  }, [ctlRef, s.trigger, s.release]);

  return (
    <div className="sampler-strip" aria-label="Sampler controls">
      {/* The global sample PADS moved into the decks' GLBL pad-mode (SMP+shift); this strip is now
          controls-only. REC still lands its take in the next free GLBL pad — play/manage it from
          GLBL on either deck. */}
      {/* Three fixed zones: INPUT (mic) · MASTER (the SMART anchor) · OUTPUT (capture + monitor).
          SMART is pinned dead-centre (the crossfader's companion) and NEVER reflows — the flanking
          zones grow and shrink around it as the mic / cue device appear. Consistent grammar: every
          SETTING is a static LABEL + value (knob cells); ACTIONS are single bold words (REC · MON). */}
      <div className="smp-io">
        {/* INPUT — mic talkover (collapses to nothing when there's no mic). */}
        <div className="smp-io-zone smp-io-in">
          {engine.canMic && (
            <>
              {/* AMOUNT (+ tap-toggle + right-click): TAP = mic on/off, DRAG = talkover VOL, RIGHT-CLICK =
                  destination (Room / Deck A·B FX). The mic is just "the mic"; its routing hides here. */}
              <ValueCell
                className={`smp-io-cell smp-io-mic ${micOn ? "on" : ""}`}
                label={micBusy ? "MIC …" : "MIC"}
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
                onContextMenu={(e) => setRouteMenu({ kind: "dest", x: e.clientX, y: e.clientY })}
              >
                <span className="smp-io-meter"><span ref={meterRef} /></span>
              </ValueCell>
              {/* AMOUNT — how far the music drops under talkover. */}
              <ValueCell
                className="smp-io-cell smp-io-duck"
                label="DUCK"
                value={duck}
                min={0}
                max={1}
                step={0.02}
                reset={0.6}
                format={(v) => `${Math.round(v * 100)}`}
                onChange={(v) => { setDuck(v); engine.setMicDuck(v); }}
              />
            </>
          )}
        </div>

        {/* MASTER — the anchor. Tap = arm Smart Fader · drag / FLX MASTER knob = master volume ·
            double-tap = unity · hold / right-click / shift-tap = enable/disable the crossfader. */}
        <div className="smp-io-zone smp-io-mid">
          {smart && (
            <SmartChip
              smart={smart.armed}
              enabled={smart.enabled}
              canControl={smart.canControl}
              shift={smart.shift}
              kbd={smart.kbd}
              accentA={smart.accentA}
              accentB={smart.accentB}
              master={smart.master}
              onToggleSmart={smart.onToggleSmart}
              onToggleEnabled={smart.onToggleEnabled}
              onMaster={smart.onMaster}
            />
          )}
          {/* Master brickwall GR — measured since ef5c7ed1, never rendered until now (32156af1):
              a limiter you can't see is a limiter you can't tell is working. */}
          <MeterBar getValue={getMasterGr} toPercent={(gr) => Math.min(1, gr / 12) * 100} format={(gr) => (gr < 0.1 ? "0.0" : `−${gr.toFixed(1)}`)} unit="dB" label="Master limiter gain reduction" rtl className="smp-master-gr" />
        </div>

        {/* OUTPUT — capture + headphone monitor. Grows/reflows as the cue device appears. */}
        <div className="smp-io-zone smp-io-out">
          {/* ACTION — TAP = record into the next free GLBL pad (armed = red pulse); RIGHT-CLICK / HOLD =
              pick the SOURCE. The small tag under REC shows what you'll capture (no separate cell). */}
          <button
            className={`smp-io-btn smp-io-rec ${recording ? "armed" : ""}`}
            onClick={() => { if (recSuppress.current) { recSuppress.current = false; return; } void toggleRec(); }}
            onContextMenu={(e) => { e.preventDefault(); setRouteMenu({ kind: "src", x: e.clientX, y: e.clientY }); }}
            onTouchStart={(e) => { const t = e.touches[0]; recLong.current = window.setTimeout(() => { recSuppress.current = true; setRouteMenu({ kind: "src", x: t.clientX, y: t.clientY }); }, 480); }}
            onTouchEnd={() => clearTimeout(recLong.current)}
            onTouchMove={() => clearTimeout(recLong.current)}
            title={recording ? "Stop → the take drops into the next free GLBL pad" : `Tap to record ${SRC_FULL[recSrc]} → next free GLBL pad · right-click / hold to change source`}
          >
            <span className="smp-io-rec-lab">{recording ? "STOP" : "REC"}</span>
            {!recording && <span className="smp-io-rec-src">{SRC_LABEL[recSrc]}</span>}
          </button>
          {/* Where the take landed — it's in GLBL pad-mode now, not beside the strip. */}
          {landed != null && <span className="smp-io-landed" role="status">→ GLBL {landed + 1}</span>}
          {/* ACTION (toggle) — hear your own mic in the cue device (lives with the monitor controls). */}
          {engine.canMic && (
            <button className={`smp-io-btn smp-io-toggle ${monitor ? "on" : ""}`} onClick={() => void toggleMonitor()} title="MON — monitor your own mic in the cue/headphone device (needs a cue device set)">
              MON
            </button>
          )}
          {phones && (
            <>
              {/* AMOUNTS — cue-device blend + level. (BLEND, not "MIX", so it never collides with the
                  REC source value MIX.) */}
              <ValueCell
                className="smp-io-cell"
                label="BLEND"
                value={phones.mix}
                min={0}
                max={1}
                pivot={0.5}
                format={(v) => (v < 0.48 ? "CUE" : v > 0.52 ? "MST" : "MID")}
                onChange={phones.onMix}
              />
              <ValueCell
                className="smp-io-cell"
                label="LVL"
                value={phones.level}
                min={0}
                max={1}
                reset={1}
                format={(v) => `${Math.round(v * 100)}`}
                onChange={phones.onLevel}
              />
            </>
          )}
        </div>
      </div>

      {(s.error || ioErr) && (
        <div className="smp-error" role="status" onClick={() => { s.clearError(); setIoErr(null); }}>
          {s.error || ioErr} <span className="smp-error-x">✕</span>
        </div>
      )}

      {/* DEST / SRC picker, opened by right-click/hold on MIC (dest) or REC (src). */}
      {routeMenu && (
        <>
          <div className="ctx-backdrop" onClick={() => setRouteMenu(null)} onContextMenu={(e) => { e.preventDefault(); setRouteMenu(null); }} />
          <div className="ctx-menu smp-route-menu" style={{ left: Math.min(routeMenu.x, window.innerWidth - 180), top: Math.min(routeMenu.y, window.innerHeight - 180) }}>
            {routeMenu.kind === "dest" ? (
              <>
                <div className="ctx-label">Mic goes to</div>
                {(["master", "A", "B"] as const).map((d) => (
                  <button key={d} className={micDest === d ? "active" : ""} onClick={() => pickDest(d)}>{DEST_FULL[d]}</button>
                ))}
              </>
            ) : (
              <>
                <div className="ctx-label">Record from</div>
                {SRC_ORDER.map((srcOpt) => (
                  <button key={srcOpt} className={recSrc === srcOpt ? "active" : ""} onClick={() => { setRecSrc(srcOpt); setRouteMenu(null); }}>{SRC_FULL[srcOpt]}</button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
