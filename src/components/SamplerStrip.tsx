import { useEffect, useRef, useState, type DragEvent, type MutableRefObject, type PointerEvent } from "react";
import type { AudioEngine, SampleMode } from "@htl";
import { GLOBAL_COUNT, type SamplerPad, type SamplerApi } from "./useSampler";

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
}: {
  sampler: SamplerApi; // lifted to App (shared with the decks' SAMPLER pad-mode)
  ctlRef?: MutableRefObject<{ trigger: (i: number) => void; release: (i: number) => void } | null>;
  engine: AudioEngine;
}) {
  const s = sampler;

  // Mic (talkover) + capture-record controls. Captures land in the next free GLOBAL pad.
  const [micOn, setMicOn] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [micLevel, setMicLevel] = useState(0.85);
  const [duck, setDuck] = useState(0.6);
  const [showMic, setShowMic] = useState(false); // level/duck expander
  const [recSrc, setRecSrc] = useState<CapSource>("master");
  const [recording, setRecording] = useState(false);
  const [ioErr, setIoErr] = useState<string | null>(null);

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
      engine.setMicLevel(micLevel);
      engine.setMicDuck(duck);
    }
    const next = !micOn;
    setMicOn(next);
    engine.setMicOn(next);
    setShowMic(next);
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
              <span className="smp-hint">{pad.route === "master" ? "＋" : pad.hasTrack ? "grab" : "—"}</span>
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

      {/* Mic + capture IO — captures drop into the next free global pad above. */}
      <div className="smp-io">
        {engine.canMic && (
          <button className={`smp-io-btn ${micOn ? "on" : ""}`} onClick={() => void toggleMic()} disabled={micBusy} title="Microphone talkover — music ducks while you talk">
            🎙{micBusy ? "…" : micOn ? " ON" : ""}
          </button>
        )}
        <button className="smp-io-src" onClick={cycleSrc} title="Record source — what the ● captures">
          {SRC_LABEL[recSrc]}
        </button>
        <button className={`smp-io-rec ${recording ? "armed" : ""}`} onClick={() => void toggleRec()} title={recording ? "Stop → drops into the next free pad" : `Record ${SRC_LABEL[recSrc]} → next free pad`}>
          {recording ? "■ STOP" : "● REC"}
        </button>
      </div>

      {showMic && micOn && (
        <div className="smp-mic-ctl">
          <label>LVL<input type="range" min={0} max={1} step={0.02} value={micLevel} onChange={(e) => { const v = Number(e.target.value); setMicLevel(v); engine.setMicLevel(v); }} /></label>
          <label>DUCK<input type="range" min={0} max={1} step={0.02} value={duck} onChange={(e) => { const v = Number(e.target.value); setDuck(v); engine.setMicDuck(v); }} /></label>
        </div>
      )}

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
              <button onClick={() => { s.assignRegion(menu.i); setMenu(null); }}>↻ Re-grab from deck</button>
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
    return pad.hasTrack ? `Grab a region from deck ${pad.route}` : `Load a track on deck ${pad.route} first`;
  }
  const where = pad.route === "master" ? "global → master" : `deck ${pad.route}`;
  return `${pad.name || "sample"} · ${MODE_LABEL[pad.mode]} · ${where} — right-click for options`;
}
