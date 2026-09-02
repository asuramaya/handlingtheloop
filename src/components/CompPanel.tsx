import { useCallback, useRef } from "react";
import type { Deck, CompFx } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { COMP_MODES } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { CompViz } from "./CompViz";
import { CompArPad } from "./CompArPad";
import { CompHead } from "./CompHead";
import { usePulse } from "./usePulse";
import { useFrameSync } from "./useFrameSync";
import { fxParamIntent } from "@htl/room/fxWire";

// COMP surface — a transfer curve you GRAB, the remaining cells, and a foot strip holding
// MODE / AUTO / sidechain source.
//
// ★ THE LAST DEVICE TO JOIN THE RACK'S OWN LAWS. It was the odd one out on three counts:
//   • Its mode row OPENED the panel, sitting directly under FxStrip's device tabs — the exact
//     "one undifferentiated stack of pill buttons" the saturator's row was moved to the foot to
//     escape. Every other device's mode select is the LAST thing in the panel; COMP's is now too.
//   • MODE was four radio buttons where the rest of the rack collapses a value-selector into ONE
//     cycler chip carrying .cyc-pips (Delay's TIME-MODE, Reverb's algorithm, MOD's MODE). Four
//     peers also crowded AUTO — a genuine toggle — into looking like a fifth mode, which it
//     isn't. One chip, tap to step, pips for depth; AUTO and the SC source are its real peers.
//   • It had no Readout strip, alone in a rack of eight devices that all wear one. LEFT says what
//     the device IS (mode · auto), RIGHT carries the sidechain — the setting most responsible for
//     how a buss compressor behaves and the one you cannot see from the knobs.
//
// ★ THRESH/RATIO/KNEE/ATTACK/RELEASE/SC-HP/SC-LP used to be seven more ValueCells indistinguish-
// able from MAKEUP or LOOK — a compressor you can't see is a compressor you can't set, and a flat
// row of orange pills doesn't show you what any of them DO.
//   • CompViz replaces THRESH/RATIO/KNEE with one instrument: a draggable transfer curve (bend =
//     threshold+ratio, knee = knee) that breathes with live gain reduction, and a live dot that
//     leaves the curve when SC:EXT is ducking it — the sidechain made visible, not just labelled.
//   • CompArPad is ATTACK/RELEASE's own small XY pad, to the curve's LEFT — a compressor's
//     transfer curve has one axis pair (input dB → output dB) and ballistics have none of their
//     own, so they get a pad rather than crowding into the curve or sitting as two buttonoids.
//   • SC-HP/SC-LP is the shared ribbon (drawFreqRibbon / hitFreqRibbon / dragHp / dragLp /
//     dragBand), and it now sits where Delay's and Reverb's sit: on the READOUT's own canvas, at
//     the top of the panel, spanning its FULL width — CompHead. Two earlier attempts put it in a
//     box of its own beside the curve, then inside the curve's canvas; both failed the same test
//     for the same reason. A frequency ribbon is a RULER (20 Hz .. 20 kHz across three log
//     decades), and two rulers only read as one control when they measure the same span in the
//     same pixels. Inside CompViz it inherited the middle column of a three-column row, so its
//     20 Hz started ~70 px in and its 20 kHz stopped ~60 px short of Reverb's. Sharing a border
//     bought local seamlessness at the price of the alignment that makes a shared widget shared.
interface CompPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
}

export function CompPanel({ deck, id, slot, accent }: CompPanelProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
  const [modePulse, pulseMode] = usePulse();
  // ONE channel for "what is being touched", shared by all three surfaces and read only by the
  // readout's own rAF. A ref, not state: it changes every frame of a drag, and re-rendering the
  // whole panel to move a caption would be the exact cost useFrameSync exists to avoid.
  const hot = useRef<string | null>(null);
  const setHot = useCallback((v: string | null) => {
    hot.current = v;
  }, []);
  // CompViz drags continuously — see useFrameSync.
  const pushFrame = useFrameSync((param, value) => emit(fxParamIntent(deck, id, slot, param, value)), refresh);
  const live = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    pushFrame(param, value);
  };

  if (!dev) return null;
  const get = (p: string) => dev.getParam(p);
  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit(fxParamIntent(deck, id, slot, param, value));
    refresh();
  };
  const mode = Math.round(get("mode"));
  const auto = get("auto") >= 0.5;
  const ext = get("scExt") >= 0.5;

  return (
    <div className="fx-panel sat-panel comp-panel" style={{ ["--accent" as string]: accent }}>
      {/* Readout + the SC-HP/LP ribbon, one canvas, full panel width — Delay's and Reverb's
          own head geometry (ribbon at y = READOUT_H, drawn at ribbonH − 4, hit at ribbonH). */}
      <CompHead deck={deck} slot={slot} accent={accent} set={live} hot={hot} setHot={setHot} />

      {/* THRESH/RATIO/KNEE live on the curve — drag the bend, drag the knee. SC-HP/SC-LP is the
          full-width ribbon in the head above. ATTACK/RELEASE get their own small pad to the LEFT.
          MAKEUP/LOOK are the two cells left with nothing to be dragged ON, so they keep a narrow
          side column instead of a whole row below. */}
      <CompViz deck={deck} slot={slot} accent={accent} set={live} setHot={setHot} left={<CompArPad deck={deck} slot={slot} accent={accent} set={live} setHot={setHot} />}>
        <div className="comp-side-cells">
          <ValueCell label="MAKEUP" value={get("makeup")} min={-12} max={24} step={0.5} reset={0} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`} onChange={(v) => setParam("makeup", v)} />
          <ValueCell label="LOOK" value={get("lookahead")} min={0} max={10} step={0.1} reset={0} format={(v) => (v <= 0 ? "OFF" : `${v.toFixed(1)}ms`)} onChange={(v) => setParam("lookahead", v)} />
        </div>
      </CompViz>

      {/* The foot strip — same position and language as every other device. MODE is the
          instrument (each mode re-times the ballistics underneath), AUTO is a real toggle, and
          the SC source is the DJ move: let the OTHER deck drive this compressor, so the incoming
          track carves its own hole instead of two tracks fighting for the same space. */}
      <div className="sat-styles">
        <button
          className={`cyc active ${modePulse}`}
          onClick={() => {
            setParam("mode", (mode + 1) % COMP_MODES.length);
            pulseMode();
          }}
          title={`Mode — tap to cycle. ${MODE_HINT[mode]}`}
        >
          {COMP_MODES[mode] ?? "?"}
          <span className="cyc-pips" aria-hidden="true">
            {COMP_MODES.map((m, i) => (
              <i key={m} className={i === mode ? "on" : ""} />
            ))}
          </span>
        </button>
        <span className="fx-sep" />
        <button className={auto ? "active" : ""} onClick={() => setParam("auto", auto ? 0 : 1)} title="Auto makeup + program-dependent release">
          AUTO
        </button>
        <span className="fx-sep" />
        {/* One toggle, not two mutually-exclusive buttons standing in for it — INT/EXT is a
            single real state, same idiom as AUTO right next to it. */}
        <button className={ext ? "active" : ""} onClick={() => setParam("scExt", ext ? 0 : 1)} title={ext ? "Detector listens to this channel — tap for the other deck" : `Detector listens to deck ${id === "A" ? "B" : "A"} — the other track ducks this one`}>
          SC: {ext ? (id === "A" ? "B" : "A") : "INT"}
        </button>
      </div>
    </div>
  );
}

const MODE_HINT = [
  "GLUE — VCA buss compressor. Slow-ish attack lets transients through, auto-release holds the mix together.",
  "FET — microsecond attack. It grabs; it's meant to be heard.",
  "OPTO — fixed attack, two-stage program-dependent release. Never sounds like it's working.",
  "LIMIT — brickwall with lookahead: it sees the peak coming and ducks before it lands.",
];
