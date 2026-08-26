import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useEngine } from "../App/spine";
import { type SamplerApi } from "./useSampler";
import { ValueCell } from "./ValueCell";
import { Menu } from "./ContextMenu";
import { Toasts } from "./Toasts";

// ★ THE DEVICES SIT IN THE CROSSFADER'S OWN TAILS — mic at the left end, capture and cue at the
// right — so they cost the board no row at all. IN on the left, OUT on the right, which is a real
// mixer's convention rather than an arbitrary split.
//
// Four homes were tried; the rejects are the design:
//   • A full-width strip above the fader — LOPSIDED (master left, devices right, a hole between).
//     A line with a hole in it reads as leftovers however correct its contents are.
//   • The chin — a CATEGORY error. These are touched WHILE PLAYING; the chin is what you touch
//     while not. Mic and REC beside Settings and Discover made both rows worse.
//   • A centred cluster in its own row under the fader — deliberate-looking, but a whole row spent
//     on three buttons is a row spent on three buttons.
//
// ★ FLANKING THE FADER IS ONLY SAFE BECAUSE THE TAILS ARE EQUAL AND THE MASTER LEFT. The earlier
// arithmetic that killed this idea assumed a 163px master fader on one side: two of those on a
// 390px board leave the fader 64px of throw. The master is a hairline BAND now (MasterBand), so the
// tails are icon-sized, and a phone can afford them. But equal is not optional — unequal tails move
// the fader's centre by half their difference, and that centre is a claim about the mix.
//
// So both tails are sized to `TAIL`, the wider side's WIDEST state. Widest-state, not current, so
// the fader does not reflow under your hand when the mic goes live. It is still contextual: the
// width is derived from which devices EXIST, so a bare rig gets one small record button and two
// 42px tails.
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
  children,
}: {
  sampler: SamplerApi;
  ctlRef?: MutableRefObject<{ trigger: (i: number) => void; release: (i: number) => void } | null>;
  micSetRef?: MutableRefObject<((v: number) => void) | null>;
  micToggleRef?: MutableRefObject<(() => void) | null>;
  phones?: { mix: number; level: number; onMix: (v: number) => void; onLevel: (v: number) => void } | null;
  hasMic?: boolean;
  children?: ReactNode; // the crossfader itself — it sits BETWEEN the two tails
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
  /** ★ RESTORED. As a ValueCell the mic had a wheel handler and arrow keys; as a plain button it
   *  had neither, which was a straight regression with no design behind it — a desktop DJ scrolls
   *  over a control, and a keyboard has to be able to reach a level at all. */
  const nudgeMic = (d: number) => {
    const next = Math.max(0, Math.min(1, micLive.current.micVol + d));
    setMicVol(next);
    engine.setMicLevel(next);
  };
  const micBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = micBtn.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      if (!micLive.current.micOn) return;
      e.preventDefault();
      nudgeMic(e.deltaY < 0 ? 0.02 : -0.02);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [engine, hasMic]);

  const SRC_ORDER: CapSource[] = hasMic ? ["master", "deckA", "deckB", "mic"] : ["master", "deckA", "deckB"];

  // ★ THE TAILS ARE MEASURED, NOT ASSUMED. They were fixed constants mirroring the CSS, which
  // meant a button whose content grew (an emoji renders taller and wider than a digit, and the mic
  // widens when it goes live) got CLIPPED by a number written down somewhere else. So the buttons
  // size to their content and the tails observe them: both take the wider side's width, which keeps
  // the fader's centre on the deck seam without anyone having to keep two files in agreement.
  const lIn = useRef<HTMLDivElement>(null);
  const rIn = useRef<HTMLDivElement>(null);
  const [tail, setTail] = useState(0);
  useEffect(() => {
    const measure = () => {
      const l = lIn.current?.scrollWidth ?? 0;
      const r = rIn.current?.scrollWidth ?? 0;
      // Round up: a fractional width that rounds DOWN clips the last pixel of a glyph.
      setTail(Math.ceil(Math.max(l, r)));
    };
    measure();
    // Observe the CONTENT, never the tail — the tail's width is what we are setting, so watching it
    // would be a feedback loop that never settles.
    const ro = new ResizeObserver(measure);
    if (lIn.current) ro.observe(lIn.current);
    if (rIn.current) ro.observe(rIn.current);
    return () => ro.disconnect();
  }, [hasMic, phones, micOn, recording]);

  return (
    <div className="xrow">
      <div className="xtail xtail-l" style={{ width: tail || undefined }}>
      <div className="xtail-in" ref={lIn}>
      {hasMic && (
        <button
          ref={micBtn}
          className={`dev-btn dev-mic ${micOn ? "live" : ""} ${micBusy ? "busy" : ""}`}
          onPointerDown={micDown}
          onKeyDown={(e) => {
            if (!micOn) return;
            const step = e.shiftKey ? 0.01 : 0.05;
            if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); nudgeMic(-step); }
            if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); nudgeMic(step); }
          }}
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
      </div>
      </div>

      {children}

      <div className="xtail xtail-r" style={{ width: tail || undefined }}>
      <div className="xtail-in" ref={rIn}>
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
      </div>
      </div>

      {/* ★ TOASTS FLOAT, they do not live in the row. These were absolutely positioned inside the
          fader's row, which meant they were clipped by it AND overlapped the decks below — a
          message you cannot finish reading is worse than no message. They are a fixed, bottom-centre
          stack now: out of the board entirely, wrapping instead of truncating, and self-dismissing,
          because a notice that needs a click to go away is a modal wearing a toast's clothes. */}
      <Toasts
        items={[
          landed != null ? { id: "landed", kind: "ok" as const, text: `Take landed → GLBL ${landed + 1}` } : null,
          s.error || ioErr ? { id: "err", kind: "warn" as const, text: (s.error || ioErr) as string } : null,
        ].filter(Boolean) as { id: string; kind: "ok" | "warn"; text: string }[]}
        onDismiss={(id) => { if (id === "err") { s.clearError(); setIoErr(null); } else setLanded(null); }}
      />

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
