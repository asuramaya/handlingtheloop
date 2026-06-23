import { useEffect, useRef, useState, type DragEvent, type MutableRefObject, type PointerEvent } from "react";
import type { AudioEngine, SampleMode } from "@htl";
import { GLOBAL_COUNT, type SamplerPad, type SamplerApi } from "./useSampler";
import { ValueCell } from "./ValueCell";

// Capture sources for the record button, in cycle order. MIC is only offered when getUserMedia
// exists. Each captures into the next free global pad (owned-audio tier).
type CapSource = "master" | "deckA" | "deckB" | "mic";
const SRC_LABEL: Record<CapSource, string> = { master: "MIX", deckA: "A", deckB: "B", mic: "MIC" };
const SRC_TAKE: Record<CapSource, string> = { master: "Mix take", deckA: "Deck A take", deckB: "Deck B take", mic: "Mic take" };

// The 12 GLOBAL sample pads (master-routed) that sit over the A/B crossfader — uploaded
// account clips that cut through the mix. The per-deck "play X→Y" region samples (8 each)
// live in the decks' SAMPLER pad-mode now, not here.

const MODE_LABEL: Record<SampleMode, string> = { oneshot: "1-shot", gate: "gate", loop: "loop", bounce: "bounce" };
const MODE_DOT: Record<SampleMode, string> = { oneshot: "●", gate: "▣", loop: "↻", bounce: "⇄" };
const MODES: SampleMode[] = ["oneshot", "gate", "loop", "bounce"];

export function SamplerStrip({
  sampler,
  ctlRef,
  engine,
  micSetRef,
  phones,
}: {
  sampler: SamplerApi; // lifted to App (shared with the decks' SAMPLER pad-mode)
  ctlRef?: MutableRefObject<{ trigger: (i: number) => void; release: (i: number) => void } | null>;
  engine: AudioEngine;
  micSetRef?: MutableRefObject<((v: number) => void) | null>; // App pushes the FLX MIC knob value into the cell
  // Master headphone (cue-device) controls — joins the IO zone only when a 2nd output is set.
  // Owned by App so the FLX 🎧 MIX knob and these cells stay in step.
  phones?: { mix: number; level: number; onMix: (v: number) => void; onLevel: (v: number) => void } | null;
}) {
  const s = sampler;

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
  const [grabbing, setGrabbing] = useState(false);
  const [ioErr, setIoErr] = useState<string | null>(null);
  const meterRef = useRef<HTMLSpanElement>(null);

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

  // Cycle the mic destination: PA (master, ducks) → into deck A's FX rack → deck B's.
  const cycleDest = () => {
    const order = ["master", "A", "B"] as const;
    const next = order[(order.indexOf(micDest) + 1) % order.length];
    setMicDest(next);
    engine.setMicRoute(next);
  };

  // Retroactive catch: lift the last 4 bars of the master out of the ring → next free pad.
  const doGrab = async () => {
    if (grabbing) return;
    setGrabbing(true);
    setIoErr(null);
    const take = await engine.grabBars(4);
    setGrabbing(false);
    if (take) await s.captureToGlobal(take, "Catch");
    else setIoErr("Nothing to catch yet — let some audio play first.");
  };

  const cycleSrc = () => {
    const order: CapSource[] = engine.canMic ? ["master", "deckA", "deckB", "mic"] : ["master", "deckA", "deckB"];
    setRecSrc((c) => order[(order.indexOf(c) + 1) % order.length]);
  };

  const toggleRec = async () => {
    if (recording) {
      setRecording(false);
      const take = await engine.stopCapture();
      if (take) await s.captureToGlobal(take, SRC_TAKE[recSrc]);
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
  const fileInput = useRef<HTMLInputElement>(null);
  const pickPad = useRef<number | null>(null);
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const longPress = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false);

  const openPicker = (i: number) => {
    pickPad.current = i;
    fileInput.current?.click();
  };

  // Pad press. Empty pads ASSIGN (region → capture from the deck; global → file picker);
  // filled pads TRIGGER (gate = hold; loop = toggle; one-shot = retrigger).
  const onPadDown = (e: PointerEvent, pad: SamplerPad) => {
    if (e.button !== 0) return; // right / middle button → context menu only, never trigger
    if (suppressClick.current) return;
    if (pad.kind === "empty") return; // assign happens on click, below
    if (pad.mode === "gate") {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      s.trigger(pad.index);
    } else if (pad.mode === "loop" || pad.mode === "bounce") {
      pad.playing ? s.stop(pad.index) : s.trigger(pad.index); // continuous modes toggle
    } else {
      s.trigger(pad.index);
    }
  };
  const onPadUp = (pad: SamplerPad) => {
    if (pad.mode === "gate") s.release(pad.index);
  };
  const onPadClick = (pad: SamplerPad) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (pad.kind !== "empty") return;
    if (pad.route === "master") openPicker(pad.index);
    else if (pad.hasTrack) s.assignRegion(pad.index);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    const i = pickPad.current;
    e.target.value = "";
    if (f && i != null) void s.assignFile(i, f);
  };

  const onDrop = (e: DragEvent, i: number) => {
    e.preventDefault();
    setDragOver(null);
    if (routeIsMaster(i)) {
      const f = e.dataTransfer.files?.[0];
      if (f) void s.assignFile(i, f);
    }
  };

  return (
    <div className="sampler-strip" aria-label="Sampler">
      <input ref={fileInput} type="file" accept="audio/*" hidden onChange={onFile} />
      {s.pads.slice(0, GLOBAL_COUNT).map((pad) => {
        return (
          <button
            key={pad.index}
            className={`smp-pad smp-${pad.route} ${pad.kind === "empty" ? "empty" : "set"} ${pad.playing ? "playing" : ""} ${dragOver === pad.index ? "drag-over" : ""} ${pad.uploading ? "uploading" : ""}`}
            disabled={pad.kind === "empty" && pad.route !== "master" && !pad.hasTrack}
            title={padTitle(pad)}
            onPointerDown={(e) => onPadDown(e, pad)}
            onPointerUp={() => onPadUp(pad)}
            onPointerLeave={() => onPadUp(pad)}
            onClick={() => onPadClick(pad)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (pad.kind !== "empty") setMenu({ i: pad.index, x: e.clientX, y: e.clientY });
            }}
            onTouchStart={(e) => {
              if (pad.kind === "empty") return;
              const t = e.touches[0];
              longPress.current = window.setTimeout(() => {
                suppressClick.current = true;
                setMenu({ i: pad.index, x: t.clientX, y: t.clientY });
              }, 480);
            }}
            onTouchEnd={() => clearTimeout(longPress.current)}
            onTouchMove={() => clearTimeout(longPress.current)}
            onDragOver={(e) => {
              if (routeIsMaster(pad.index) && e.dataTransfer.types.includes("Files")) {
                e.preventDefault();
                setDragOver(pad.index);
              }
            }}
            onDragLeave={() => setDragOver((d) => (d === pad.index ? null : d))}
            onDrop={(e) => onDrop(e, pad.index)}
          >
            {pad.kind === "empty" ? (
              <span className="smp-hint">{pad.route === "master" ? "＋" : pad.hasTrack ? "slice" : "—"}</span>
            ) : (
              <>
                <span className="smp-name">{pad.name || "sample"}</span>
                <span className="smp-mode" aria-hidden="true">
                  {MODE_DOT[pad.mode]}
                </span>
              </>
            )}
          </button>
        );
      })}

      {/* IO — two labelled groups so the controls read at a glance. Captures drop into the
          next free global pad above. */}
      <div className="smp-io">
        {engine.canMic && (
          <div className="smp-io-grp">
            {/* The talkover toggle IS a buttonoid: TAP = mic on/off, DRAG/SCROLL = talkover VOL
                (double-tap resets). The live input meter rides the bottom edge. */}
            <ValueCell
              className={`smp-io-cell smp-io-mic ${micOn ? "on" : ""}`}
              label={micBusy ? "MIC …" : micOn ? "MIC ON" : "MIC OFF"}
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
            >
              <span className="smp-io-meter"><span ref={meterRef} /></span>
            </ValueCell>
            {/* DUCK is a pure AMOUNT — how far the music drops under talkover. A knob, no tap
                toggle, so it never pretends to switch something on/off it can't. */}
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
            {/* Monitor (PFL) is on/off only — an honest plain toggle, NOT a fake knob borrowing
                an unrelated value. (Renamed from CUE so "cue" means only the deck cue point.) */}
            <button className={`smp-io-btn ${monitor ? "on" : ""}`} onClick={() => void toggleMonitor()} title="Monitor — hear your own mic in the headphone/cue device (needs a cue device set)">
              MON
            </button>
            <button className="smp-io-sel" onClick={cycleDest} title="Where the mic GOES — the PA (talkover, ducks the music) or through Deck A/B's FX rack">
              <span className="smp-io-arrow">→</span>{micDest === "master" ? "PA" : micDest}
            </button>
          </div>
        )}
        <div className="smp-io-grp">
          <button className="smp-io-sel" onClick={cycleSrc} title="What ● REC PULLS FROM — the mix or a deck (⟲ CATCH always takes the master)">
            <span className="smp-io-arrow">←</span>{SRC_LABEL[recSrc]}
          </button>
          <button className={`smp-io-btn smp-io-rec ${recording ? "armed" : ""}`} onClick={() => void toggleRec()} title={recording ? "Stop → the take drops into the next free pad" : `Record ${SRC_LABEL[recSrc]} → next free pad`}>
            {recording ? "■ STOP" : "● REC"}
          </button>
          {engine.canRingCapture && (
            <button className="smp-io-btn" onClick={() => void doGrab()} disabled={grabbing} title="Catch the last 4 bars that just played (from the master) → next free pad">
              {grabbing ? "…" : "⟲ CATCH"}
            </button>
          )}
        </div>
        {phones && (
          // Master HEADPHONE monitoring — sits with MON/REC since it's the same zone. MIX = the
          // CUE↔MST blend in the cue device, LVL = its output level. Only here in 2-device mode.
          <div className="smp-io-grp">
            <ValueCell
              className="smp-io-cell"
              label="🎧 MIX"
              value={phones.mix}
              min={0}
              max={1}
              pivot={0.5}
              format={(v) => (v < 0.48 ? "CUE" : v > 0.52 ? "MST" : "MID")}
              onChange={phones.onMix}
            />
            <ValueCell
              className="smp-io-cell"
              label="🎧 LVL"
              value={phones.level}
              min={0}
              max={1}
              reset={1}
              format={(v) => `${Math.round(v * 100)}`}
              onChange={phones.onLevel}
            />
          </div>
        )}
      </div>

      {(s.error || ioErr) && (
        <div className="smp-error" role="status" onClick={() => { s.clearError(); setIoErr(null); }}>
          {s.error || ioErr} <span className="smp-error-x">✕</span>
        </div>
      )}

      {menu && (
        <>
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()} />
          <div className="ctx-menu smp-menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 220) }}>
            <div className="ctx-label">Mode</div>
            <div className="smp-modes">
              {MODES.map((m) => (
                <button
                  key={m}
                  className={s.pads[menu.i].mode === m ? "active" : ""}
                  onClick={() => s.setMode(menu.i, m)}
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <div className="ctx-label">Level</div>
            <input
              className="smp-gain"
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={s.pads[menu.i].gain}
              onChange={(e) => s.setGain(menu.i, Number(e.target.value))}
            />
            <div className="ctx-sep" />
            {routeIsMaster(menu.i) ? (
              <button onClick={() => { openPicker(menu.i); setMenu(null); }}>↻ Replace file…</button>
            ) : (
              <button onClick={() => { s.assignRegion(menu.i); setMenu(null); }}>↻ Re-slice from deck</button>
            )}
            <button className="ctx-danger" onClick={() => { s.clearPad(menu.i); setMenu(null); }}>
              ✕ Clear pad
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const routeIsMaster = (i: number) => i < GLOBAL_COUNT; // the strip only shows the global pads

function padTitle(pad: SamplerPad): string {
  if (pad.kind === "empty") {
    if (pad.route === "master") return "Drop or click to load a global sample (→ master)";
    return pad.hasTrack ? `Slice a region from deck ${pad.route}` : `Load a track on deck ${pad.route} first`;
  }
  const where = pad.route === "master" ? "global → master" : `deck ${pad.route}`;
  return `${pad.name || "sample"} · ${MODE_LABEL[pad.mode]} · ${where} — right-click for options`;
}
