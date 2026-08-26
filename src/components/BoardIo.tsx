import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import { useEngine } from "../App/spine";
import { type SamplerApi } from "./useSampler";
import { ValueCell } from "./ValueCell";
import { Menu } from "./ContextMenu";

// ★ THE DEVICE CLUSTER — a TIGHT, CENTRED group on the deck seam, directly under the crossfader.
// Which is where a real mixer puts its master section: channel · MASTER · channel.
//
// Two homes were tried and rejected, and the reasons are the design:
//   • A full-width strip above the fader. It failed not because it was a row but because it was
//     LOPSIDED — master pinned left, devices pinned right, a hole between them. A line with a hole
//     in it reads as leftovers no matter how correct its contents are.
//   • The chin. It failed on CATEGORY: these are things you touch WHILE PLAYING, and the chin is
//     things you touch while not. Mic and REC beside Settings and Discover makes both worse.
// So they are on the board, where performance controls belong — but centred and tight, so the
// group is obviously deliberate, and in its own row, so it flanks nothing. A centred cluster is the
// one shape that reads as intentional at any size: 154px of it on a 390px phone and on a 1900px
// desktop look like the same object, which is the whole point of one surface that scales.
//
// Everything here is contextual. With no microphone and no cue device the cluster is a single
// record button, still centred, still deliberate.
//
// ★ AND THE MIC GROWS. What needs a permanent CONTROL rather than a permanent toggle? Only the mic
// level. So: off it is a glyph, because a glyph is a toggle; LIVE it widens to carry its value and
// becomes a drag. The control appears exactly while the thing it controls is happening — the same
// contextual law as everywhere else, one level deeper: not "is a mic plugged in" but "are you
// talking".
type CapSource = "master" | "deckA" | "deckB" | "mic";
const SRC_LABEL: Record<CapSource, string> = { master: "MST", deckA: "A", deckB: "B", mic: "MIC" };
const SRC_FULL: Record<CapSource, string> = { master: "Master mix", deckA: "Deck A", deckB: "Deck B", mic: "Mic" };
const SRC_TAKE: Record<CapSource, string> = { master: "Master take", deckA: "Deck A take", deckB: "Deck B take", mic: "Mic take" };
const DEST_FULL: Record<"master" | "A" | "B", string> = { master: "Room (master / PA)", A: "Deck A — FX rack", B: "Deck B — FX rack" };
const HOLD_MS = 460;
const SLOP = 5; // px before a press counts as a drag rather than a tap

export function BoardIo({
  sampler,
  ctlRef,
  micSetRef,
  micToggleRef,
  phones,
  hasMic = false,
}: {
  sampler: SamplerApi;
  ctlRef?: MutableRefObject<{ trigger: (i: number) => void; release: (i: number) => void } | null>;
  micSetRef?: MutableRefObject<((v: number) => void) | null>;
  micToggleRef?: MutableRefObject<(() => void) | null>;
  phones?: { mix: number; level: number; onMix: (v: number) => void; onLevel: (v: number) => void } | null;
  hasMic?: boolean;
}) {
  const s = sampler;
  const engine = useEngine();

  const [micOn, setMicOn] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [micVol, setMicVol] = useState(0.85);
  const [duck, setDuck] = useState(0.6);
  const [monitor, setMonitor] = useState(false);
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

  // Live input level, painted inside the mic button while it is live — "is it hearing me" belongs
  // on the control you just pressed, not in a menu.
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

  const [pop, setPop] = useState<{ kind: "mic" | "rec" | "cue"; x: number; y: number } | null>(null);
  const holdTmr = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const openAt = (kind: "mic" | "rec" | "cue", e: { clientX: number; clientY: number }) => setPop({ kind, x: e.clientX, y: e.clientY });
  // TAP does the thing, HOLD or right-click opens its cluster. Same vocabulary as the FX pads, the
  // chain chips and the sampler pads — fourth surface, one gesture set.
  const holdBind = (kind: "mic" | "rec" | "cue") => ({
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); openAt(kind, e); },
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      held.current = false;
      clearTimeout(holdTmr.current);
      holdTmr.current = window.setTimeout(() => { held.current = true; navigator.vibrate?.(8); openAt(kind, t); }, HOLD_MS);
    },
    onTouchEnd: () => clearTimeout(holdTmr.current),
    onTouchMove: () => clearTimeout(holdTmr.current),
  });
  const tapped = (fn: () => void) => () => { if (held.current) { held.current = false; return; } fn(); };

  // ★ THE MIC'S SECOND GESTURE. While talkover is live the button is a level control: drag it and
  // the level follows, RELATIVELY (it never jumps to where you pressed — you are talking over it).
  // A press that never moves is still the tap that turns it off.
  const micDrag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const micLive = useRef({ micVol, micOn });
  micLive.current = { micVol, micOn };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = micDrag.current;
      if (!d) return;
      if (!d.moved && Math.abs(e.clientX - d.x) < SLOP) return;
      d.moved = true;
      const next = Math.max(0, Math.min(1, d.v + (e.clientX - d.x) / 140));
      setMicVol(next);
      engine.setMicLevel(next);
    };
    const up = () => { micDrag.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [engine]);
  const micDown = (e: ReactPointerEvent) => {
    if (!micOn || e.button !== 0) return; // only a LIVE mic is a fader; off, it is purely a toggle
    micDrag.current = { x: e.clientX, v: micLive.current.micVol, moved: false };
  };

  const SRC_ORDER: CapSource[] = hasMic ? ["master", "deckA", "deckB", "mic"] : ["master", "deckA", "deckB"];

  return (
    <div className="dev-row">
      {hasMic && (
        <button
          className={`dev-btn dev-mic ${micOn ? "live" : ""} ${micBusy ? "busy" : ""}`}
          onPointerDown={micDown}
          onClick={tapped(() => { if (micDrag.current?.moved) return; void toggleMic(); })}
          aria-label="Microphone talkover"
          aria-pressed={micOn}
          title={micOn ? `Talkover ON at ${Math.round(micVol * 100)} — tap to mute, drag to set level · hold for ducking, destination, monitoring` : "Talkover off — tap to go live · hold for ducking, destination, monitoring"}
          {...holdBind("mic")}
        >
          <span className="dev-meter"><span ref={meterRef} /></span>
          <span className="dev-mark" aria-hidden="true">🎙</span>
          {micOn && <span className="dev-val">{Math.round(micVol * 100)}</span>}
        </button>
      )}
      <button
        className={`dev-btn dev-rec ${recording ? "armed" : ""}`}
        onClick={tapped(() => void toggleRec())}
        aria-label="Record"
        title={recording ? "Stop — the take drops into the next free GLBL pad" : `Record ${SRC_FULL[recSrc]} → next free GLBL pad · hold / right-click to change source`}
        {...holdBind("rec")}
      >
        <span className="dev-mark" aria-hidden="true">{recording ? "■" : "●"}</span>
        <span className="dev-tag">{SRC_LABEL[recSrc]}</span>
      </button>
      {phones && (
        <button
          className="dev-btn dev-cue"
          onClick={tapped(() => setPop({ kind: "cue", x: 0, y: 0 }))}
          aria-label="Headphone cue"
          title="Headphone cue — blend and level"
          {...holdBind("cue")}
        >
          <span className="dev-mark" aria-hidden="true">🎧</span>
        </button>
      )}

      {landed != null && <span className="io-landed" role="status">→ GLBL {landed + 1}</span>}
      {(s.error || ioErr) && (
        <div className="smp-error dev-error" role="status" onClick={() => { s.clearError(); setIoErr(null); }}>
          {s.error || ioErr} <span className="smp-error-x">✕</span>
        </div>
      )}

      {/* LEVEL is not in the mic cluster — it is the button you opened this from. A setting with a
          home on the surface does not get a second one in a menu. */}
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
          {/* Monitoring needs a mic AND somewhere private to hear it, so it exists only with both. */}
          {phones && (
            <>
              <div className="fx-preset-sep" />
              <button className={`fx-palette-item ${monitor ? "sel" : ""}`} role="menuitem" onClick={() => void toggleMonitor()}>
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
