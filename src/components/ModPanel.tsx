import type { Deck, ModFx } from "@htl/audio";
import { useEmit, useRefresh } from "../App/spine";
import { MOD_MODES, MOD_SOURCES } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { ModViz } from "./ModViz";
import { useFrameSync } from "./useFrameSync";
import { usePulse } from "./usePulse";

// Modulation surface — the ModViz WYSIWYG (sweeping notch/comb spectrum + LFO waveform inset)
// on top, the shared knobs below it, MODE + SOURCE + THRU sharing one row at the bottom. Mirrors
// the Sat/Crush panel contract (Viz → knobs → mode row); reuses the .sat-* layout classes.
//
// WAVE and SYNC fold into the thing they're a property of, instead of getting a peer row/button:
//   WAVE   → used to be its own row of three buttons (SINE/TRI/SQUARE) sitting right next to a
//            curve-preview panel that already DRAWS that exact shape — now it's a click on the
//            inset itself (see ModViz).
//   SYNC   → not a peer of MODE/SOURCE, it's a property of RATE (it only changes what unit RATE
//            displays in) — so it's a TAP on the RATE cell (the same idiom TEMPO/PITCH already
//            use to cycle their own range tier: drag adjusts the value, a clean tap toggles the
//            cell's mode), with the same bottom-riding tick-scale as their .range-ticks, not a
//            standalone pill.
// MODE itself collapses too, but differently: CHORUS/FLANGER/PHASER become ONE cycler chip (tap
// steps through, pips show depth) — the same move Delay's TIME-MODE/STEREO chips already use.
//
// ★ NO CONTROL MAY POP IN OR OUT ACROSS THE 4 MODES. THRU used to be conditionally rendered
// (flanger-only) — appearing/disappearing as you cycle MODE, reflowing the row under your
// finger. Fixed the same way STAGES/F.BACK were fixed, below: THRU is a right-click on the MODE
// chip now (it's genuinely a property of "which mode am I holding right now", same as SYNC is a
// property of RATE), not a peer button. A lit corner dot shows the flag is armed in EVERY mode,
// since it's a standing setting, not something that only exists while you're looking at flanger.
//
// ★ FULL PARITY — every knob does something real in every mode now, not just PHASER/FLANGER:
//   STAGES → universal DENSITY knob. PHASER: allpass stage count (unchanged). CHORUS/FLANGER:
//            voice/tap count (STAGES detuned delay lines instead of one). BARBER: engine-PAIR
//            count (more simultaneous staggered sweeps). Never disabled anywhere now — its
//            label switches per mode so the number always reads as what it actually is.
//   F.BACK → CHORUS gets a modest regen (capped well below FLANGER's) for the first time; BARBER
//            gets per-voice self-resonance. PHASER/FLANGER unchanged.
//   WAVE   → reshapes BARBER's ramp curve itself (ease/linear/step) — a genuinely different
//            sweep character per selection, independent of the click-free crossfade math.
//   SOURCE → routes the existing envelope follower into BARBER's sweep DEPTH — a transient
//            momentarily widens the sweep instead of retuning anything, so ENV/BOTH can't touch
//            the phase-lock the crossfade depends on.

interface ModPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number;
  accent: string;
}

export function ModPanel({ deck, id, slot, accent }: ModPanelProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const dev = deck.fxDeviceAt(slot) as ModFx | undefined;
  if (!dev) return null;
  const get = (p: string) => dev.getParam(p);
  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
    refresh();
  };
  // ★ The XY pad drags continuously — see useFrameSync.
  const pushFrame = useFrameSync((param, value) => emit({ kind: "fxParam", deck: id, slot, param, value }), refresh);
  const live = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    pushFrame(param, value);
  };
  const mode = Math.round(get("mode"));
  const src = Math.round(get("src"));
  const thru = get("thru") >= 0.5;
  const sync = get("sync") >= 0.5;
  // The MODE chip's RIGHT-click arms THRU, and its whole visible answer is a 5px corner dot you
  // probably weren't looking at (and which, in CHORUS/PHASER/BARBER, changes no sound at all —
  // it's a standing flag). Flash the chip so the press itself is never in doubt. See usePulse.
  const [modePulse, pulseMode] = usePulse();

  return (
    <div className="fx-panel sat-panel" style={{ ["--accent" as string]: accent }}>
      {/* Live spectrum — the comb/notches sweep with the LFO; LFO waveform in the side panel.
          Also an XY mod pad (X=RATE, Y=DEPTH). */}
      <ModViz deck={deck} slot={slot} accent={accent} set={live} />

      <div className="sat-shared">
        <ValueCell
          label="RATE"
          value={get("rate")}
          min={0}
          max={1}
          onChange={(v) => setParam("rate", v)}
          format={() => (sync ? dev.divLabel : `${dev.rateHz.toFixed(2)}`)}
          onTap={() => setParam("sync", sync ? 0 : 1)}
        >
          {/* Free vs synced — a 2-position tick scale, same bottom-riding overlay TEMPO/PITCH
              use for their range tier (.range-ticks), not a standalone pill. Tap the cell to
              flip it (drag still adjusts the value); right-click still resets, unclaimed here. */}
          <div className="range-ticks">
            <span className={`range-tick ${!sync ? "active" : ""}`} />
            <span className={`range-tick ${sync ? "active" : ""}`} />
          </div>
        </ValueCell>
        <ValueCell label="DEPTH" value={get("depth")} min={0} max={1} onChange={(v) => setParam("depth", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="F.BACK" value={get("feedback")} min={0} max={1} onChange={(v) => setParam("feedback", v)} format={(v) => `${Math.round(v * 100)}`} />
        <ValueCell label="TONE" value={get("tone")} min={0} max={1} pivot={0.5} onChange={(v) => setParam("tone", v)} format={(v) => `${Math.round((v - 0.5) * 200)}`} />
        <ValueCell
          label={mode === 0 ? "VOICES" : mode === 1 ? "TAPS" : mode === 2 ? "STAGES" : "PAIRS"}
          value={get("stages")}
          min={2}
          max={12}
          step={1}
          onChange={(v) => setParam("stages", v)}
          format={(v) => `${Math.round(v)}`}
        />
      </div>

      {/* MODE + SOURCE, one row, fixed shape at every mode — same foot-strip position as every
          other device's mode row. THRU is a right-click on the MODE chip now (see header), not a
          button that only exists while FLANGER is selected. */}
      <div className="sat-styles">
        <button
          className={`cyc active ${thru ? "thru-on" : ""} ${modePulse}`}
          onClick={() => setParam("mode", (mode + 1) % MOD_MODES.length)}
          onContextMenu={(e) => { e.preventDefault(); setParam("thru", thru ? 0 : 1); pulseMode(); }}
          title={`Mode — tap to cycle: ${MOD_MODES.join(" / ")}. Right-click: Thru-zero (Flanger only).`}
        >
          {MOD_MODES[mode] ?? "?"}
          <span className="cyc-pips" aria-hidden="true">
            {MOD_MODES.map((m, i) => (
              <i key={m} className={i === mode ? "on" : ""} />
            ))}
          </span>
        </button>
        <span className="fx-sep" />
        {MOD_SOURCES.map((s, i) => (
          <button key={s} className={src === i ? "active" : ""} onClick={() => setParam("src", i)} title="Modulation source: LFO, envelope follower, or both">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
