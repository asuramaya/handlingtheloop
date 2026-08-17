import { useEffect, useMemo, useRef } from "react";
import type { Deck, CompFx } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { COMP_MODES } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { MeterBar } from "./MeterBar";
import { drawReadout, READOUT_H } from "./Readout";
import { usePulse } from "./usePulse";

// COMP surface — the gain-reduction METER, the cells, and a foot strip holding MODE / AUTO /
// sidechain source.
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
// The meter is not decoration: a compressor you can't see is a compressor you can't set. Every
// decision you make here — threshold, ratio, how fast it lets go — is a decision about a number
// you can only read off the needle. MeterBar runs it on its own rAF rather than React state, so
// a meter moving at 60 Hz never re-renders the panel (the WaveformViewport lesson).

interface CompPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
}

const GR_FLOOR = 20; // dB of reduction at the far end of the meter

export function CompPanel({ deck, id, slot, accent }: CompPanelProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const dev = deck.fxDeviceAt(slot) as CompFx | undefined;
  const getGr = useMemo(() => () => dev?.gainReduction ?? 0, [dev]);
  const readoutRef = useRef<HTMLCanvasElement>(null);
  const [modePulse, pulseMode] = usePulse();

  // The readout runs on its own rAF, like every other device's — it reads the LIVE device rather
  // than React state, so a mode change or a knob drag shows up without a re-render.
  useEffect(() => {
    const d = deck.fxDeviceAt(slot) as CompFx | undefined;
    if (!d) return;
    let raf = 0;
    const draw = () => {
      const canvas = readoutRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const m = Math.round(d.getParam("mode"));
        const hp = d.getParam("scHp");
        const look = d.getParam("lookahead");
        const gr = d.gainReduction;
        drawReadout(ctx, w, accent, {
          left: `${COMP_MODES[m] ?? "?"}${d.getParam("auto") >= 0.5 ? "  ·  AUTO" : ""}`,
          // The needle says HOW MUCH; this says the comp is working at all, which at 0.2 dB of
          // reduction on a busy meter is otherwise easy to miss.
          mid: gr > 0.2 ? `−${gr.toFixed(1)} dB` : "",
          midHot: gr > 3,
          right: `SC ${d.getParam("scExt") >= 0.5 ? "EXT" : "INT"}${hp > 20 ? `  ·  HP ${Math.round(hp)}` : ""}${look > 0 ? `  ·  LOOK ${look.toFixed(1)}ms` : ""}`,
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [deck, slot, accent]);

  if (!dev) return null;
  const get = (p: string) => dev.getParam(p);
  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
    refresh();
  };
  const mode = Math.round(get("mode"));
  const isLimit = mode === 3;
  const auto = get("auto") >= 0.5;
  const ext = get("scExt") >= 0.5;
  const scHp = get("scHp");

  return (
    <div className="fx-panel sat-panel comp-panel" style={{ ["--accent" as string]: accent }}>
      <canvas ref={readoutRef} className="sat-readout" style={{ height: READOUT_H }} />

      {/* Gain reduction — how hard it's actually working, right now. */}
      <MeterBar getValue={getGr} toPercent={(gr) => (Math.min(1, gr / GR_FLOOR) * 100)} format={(gr) => (gr < 0.1 ? "0.0" : `−${gr.toFixed(1)}`)} unit="dB GR" label="Gain reduction (dB)" rtl />

      <div className="sat-shared">
        <ValueCell label={isLimit ? "CEIL" : "THRESH"} value={isLimit ? get("ceiling") : get("threshold")} min={isLimit ? -12 : -60} max={0} step={0.5} reset={isLimit ? -0.3 : -18} format={(v) => v.toFixed(1)} onChange={(v) => setParam(isLimit ? "ceiling" : "threshold", v)} />
        {!isLimit && <ValueCell label="RATIO" value={get("ratio")} min={1} max={20} step={0.5} reset={4} format={(v) => `${v.toFixed(1)}:1`} onChange={(v) => setParam("ratio", v)} />}
        <ValueCell label="ATTACK" value={get("attack")} min={0.02} max={100} step={0.02} reset={10} format={(v) => (v < 1 ? `${(v * 1000).toFixed(0)}µs` : `${v.toFixed(1)}ms`)} onChange={(v) => setParam("attack", v)} />
        <ValueCell label="RELEASE" value={get("release")} min={20} max={3000} step={10} reset={250} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`)} onChange={(v) => setParam("release", v)} />
        {!isLimit && <ValueCell label="KNEE" value={get("knee")} min={0} max={24} step={0.5} reset={6} format={(v) => v.toFixed(1)} onChange={(v) => setParam("knee", v)} />}
        <ValueCell label="MAKEUP" value={get("makeup")} min={-12} max={24} step={0.5} reset={0} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`} onChange={(v) => setParam("makeup", v)} />
        {/* THE sidechain high-pass. Without it a kick drum drives the reduction and pumps the whole
            track — this one filter is most of why a buss compressor works. 20 = off. */}
        <ValueCell label="SC-HP" value={scHp || 20} min={20} max={500} step={5} reset={20} format={(v) => (v <= 20 ? "OFF" : `${v.toFixed(0)}`)} onChange={(v) => setParam("scHp", v)} />
        <ValueCell label="LOOK" value={get("lookahead")} min={0} max={10} step={0.1} reset={0} format={(v) => (v <= 0 ? "OFF" : `${v.toFixed(1)}ms`)} onChange={(v) => setParam("lookahead", v)} />
        {/* MIX below 100 is parallel compression — squash it hard, then blend the crushed copy back
            under the untouched one. The New York drum trick, for free. */}
      </div>

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
        <button className={!ext ? "active" : ""} onClick={() => setParam("scExt", 0)} title="Detector listens to this channel">
          SC: INT
        </button>
        <button className={ext ? "active" : ""} onClick={() => setParam("scExt", 1)} title={`Detector listens to deck ${id === "A" ? "B" : "A"} — the other track ducks this one`}>
          SC: {id === "A" ? "B" : "A"}
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
