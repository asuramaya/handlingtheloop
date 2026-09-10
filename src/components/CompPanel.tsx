import { useCallback, useRef } from "react";
import type { Deck, CompFx } from "@htl/audio";
import { useEmit, useEngine, useRefresh } from "../App/spine";
import { useMicReady } from "./lib/useMicReady";
import { COMP_MODES } from "@htl/audio";
import { CompViz } from "./CompViz";
import { CompArPad } from "./CompArPad";
import { CompHead } from "./CompHead";
import { usePulse } from "./usePulse";
import { useFrameSync } from "./useFrameSync";
import { useValueDrag } from "./useValueDrag";
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
  const engine = useEngine();
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
  // The sidechain SOURCE, three-way. Was a two-state INT/EXT toggle whose "EXT" silently meant
  // "the other deck" — the only external source that existed. Naming the source instead of
  // toggling an abstraction is what makes the mic reachable at all.
  const scSrc = Math.round(get("scSrc"));
  const otherDeck = id === "A" ? "B" : "A";
  const SC_LABEL = ["INT", otherDeck, "MIC"];
  // MIC stays SELECTABLE with no mic running — it is dimmed, not skipped. Skipping it would make
  // the cycle's behaviour depend on hidden state, which is the exact fault this control was built
  // to remove; you would tap twice and land back where you started with nothing explaining why.
  // Dimming says "this is the right control and it is waiting on something else".
  const micReady = useMicReady(engine);
  const SC_TITLE = [
    "Detector listens to this channel — an ordinary compressor. Tap to duck from the other deck.",
    `Detector listens to deck ${otherDeck} — that track ducks this one. Tap to duck from the mic.`,
    micReady
      ? "Detector listens to the MIC — the music compresses when you talk, shaped by this compressor's own sidechain filters, ratio and release. Tap to go back to internal."
      : "Detector listens to the MIC — but the mic is OFF, so it is hearing silence and nothing is ducking. Turn the mic on in the I/O strip.",
  ];
  // Snapped to the nearest stop so a value set elsewhere (a preset, MIDI, a session) still lights
  // the right pip rather than falling off the cycle.
  // The REAL value drives the label and the active state; the nearest stop only drives the pips.
  const lookRaw = get("lookahead");
  const look = LOOK_STOPS.reduce((best, v) => (Math.abs(v - lookRaw) < Math.abs(best - lookRaw) ? v : best), LOOK_STOPS[0]);
  // Destructured rather than spread whole: React 18's createElement does extract `ref` out of a
  // spread config, so `{...lookDrag}` happens to work — but it works by a detail of createElement
  // that nothing here states, and a reader cannot tell the ref is wired by looking. Naming it is
  // free.
  const { ref: lookRef, ...lookHandlers } = useValueDrag<HTMLButtonElement>({
    value: lookRaw,
    min: 0,
    max: 10, // CompFx clamps lookMs to 0..10; the worklet's ring is sized for exactly that ceiling
    step: 0.1, // finer than the ear can place a pre-duck, coarse enough that the label stays short
    onChange: (v) => setParam("lookahead", v),
  });

  return (
    <div className="fx-panel sat-panel comp-panel" style={{ ["--accent" as string]: accent }}>
      {/* Readout + the SC-HP/LP ribbon, one canvas, full panel width — Delay's and Reverb's
          own head geometry (ribbon at y = READOUT_H, drawn at ribbonH − 4, hit at ribbonH). */}
      <CompHead deck={deck} slot={slot} accent={accent} set={live} hot={hot} setHot={setHot} />

      {/* THRESH/RATIO/KNEE/MAKEUP all live on the curve — drag the bend, the knee, the output end.
          SC-HP/SC-LP is the full-width ribbon in the head above. ATTACK/RELEASE get their own pad
          to the LEFT. Nothing keeps a side column any more: MAKEUP turned out to be something the
          plot was already DRAWING (the curve is plotted with makeup folded in, so the height of
          its output end IS the makeup) and only needed a handle, and LOOK — a set-once value, not
          a mid-mix gesture — went to the foot with the other set-once controls. That gives the
          curve the whole width the column used to hold, which is what it was short of on a phone. */}
      <CompViz deck={deck} slot={slot} accent={accent} set={live} setHot={setHot} left={<CompArPad deck={deck} slot={slot} accent={accent} set={live} setHot={setHot} />} />

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
        <button className={auto ? "active" : ""} onClick={() => setParam("auto", auto ? 0 : 1)}>
          AUTO
        </button>
        <span className="fx-sep" />
        {/* One control cycling three named sources, not a toggle plus a hidden meaning — the
            same idiom as LOOKAHEAD below, which is also a set-once value you cycle and leave. */}
        <button
          className={`${scSrc > 0 ? "active" : ""}${scSrc === 2 && !micReady ? " waiting" : ""}`}
          onClick={() => setParam("scSrc", (scSrc + 1) % 3)}
          title={SC_TITLE[scSrc]}
        >
          SC: {SC_LABEL[scSrc]}
        </button>
        <span className="fx-sep" />
        {/* ★ LOOKAHEAD IS A BUTTONOID DIAL — it LOOKS like the foot's other buttons and BEHAVES
            like a knob. Operator, 2026-09-10: "why not keep it there but make that a buttonoid
            dial instead of a toggle?"
            That dissolved a premise I had put up as a choice. I had framed it as "keep the foot's
            button language OR get continuous control back, pick one", on the assumption that the
            foot is button-language-only so a continuous control must move out. It is not one or
            the other: tap still cycles the stops exactly as before, and a vertical drag or the
            wheel now dials the real 0–10 ms range underneath. Nobody loses the old gesture and the
            resolution comes back.
            The pips stay COARSE on purpose — they light the nearest stop, so they read as "roughly
            here" while the label carries the exact value. A pip per tenth of a millisecond would
            be noise pretending to be state. */}
        <button
          ref={lookRef}
          {...lookHandlers}
          className={`cyc ${lookRaw > 0 ? "active" : ""}`}
          onClick={() => setParam("lookahead", LOOK_STOPS[(LOOK_STOPS.indexOf(look) + 1) % LOOK_STOPS.length] ?? 0)}
          title="Lookahead — tap to cycle the stops, drag or scroll to dial it. The detector sees the peak coming by this much and ducks before it lands."
        >
          {lookRaw > 0 ? `LOOK ${fmtLook(lookRaw)}ms` : "LOOK OFF"}
          <span className="cyc-pips" aria-hidden="true">
            {LOOK_STOPS.map((v) => (
              <i key={v} className={v === look ? "on" : ""} />
            ))}
          </span>
        </button>
      </div>
    </div>
  );
}

/** Whole numbers stay whole ("3ms", not "3.0ms"); an off-stop value shows its one decimal. */
function fmtLook(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Lookahead's stops, in ms. 0 = off; 10 is the param's own ceiling. Now the TAP targets of a
 *  control you can also dial continuously — they are convenient landmarks, not the whole range. */
const LOOK_STOPS = [0, 1, 3, 10];

const MODE_HINT = [
  "GLUE — VCA buss compressor. Slow-ish attack lets transients through, auto-release holds the mix together.",
  "FET — microsecond attack. It grabs; it's meant to be heard.",
  "OPTO — fixed attack, two-stage program-dependent release. Never sounds like it's working.",
  "LIMIT — brickwall with lookahead: it sees the peak coming and ducks before it lands.",
];
