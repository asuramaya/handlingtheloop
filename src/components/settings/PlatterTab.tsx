// Settings ▸ Platter — everything the jog does, in one place, drawn.
//
// ★ WHY ONE TAB AND A GRAPH. Operator, 2026-11-02: "im worried about overcomplication and
// splintering in the settings ... start with the spiritual whole of the jog mechanism". The jog
// was three cards (Jog feel / Hardware jog wheel / Vinyl Speed Adjust) and nine controls whose
// help texts mostly said which OTHER card a behaviour lived in. Now:
//   • four cuts, chosen by the operator: the motor on/off toggle (Start/Brake at 0 IS off),
//     scratch sensitivity (a hand on the platter is always 1:1; the knob keeps only shift-search
//     speed), mouse-wheel scrub (a waveform setting, moved to Controls), and Weight + Drag merged
//     into one Mass;
//   • the platter's speed over time for each gesture, simulated by the deck's own physics with
//     the deck's own mappings (platterCurves.ts). Touching a control lights the curve it moves,
//     so "what does this do" is answered by watching it rather than by a paragraph.
import { useMemo, useState, type ReactNode } from "react";
import type { Settings } from "@htl";
import { Slider } from "./Slider";
import { InfoDot } from "./InfoDot";
import { ToggleRow } from "./ControlsTab";
import { platterCurves, settleTime, SPAN_S, type Curve, type CurveKey } from "./platterCurves";

const fmtS = (s: number) => (s <= 0.0001 ? "instant" : `${s.toFixed(2)}s`);

function CurvePanel({ c, lit, dim }: { c: Curve; lit: boolean; dim: boolean }) {
  const W = 120;
  const H = 64;
  const x = (i: number, len: number) => (i / (len - 1)) * W;
  const y = (v: number) => H - ((v - c.yMin) / (c.yMax - c.yMin)) * H;
  const target = c.key === "pause" ? 0 : 1;
  // The number under the panel: how long the gesture takes, read off the same trace.
  const t = settleTime(c.lines[0].v, target);
  const t2 = c.lines[1] ? settleTime(c.lines[1].v, 0) : null;
  return (
    <figure className={`platter-curve ${lit ? "lit" : ""} ${dim ? "dim" : ""}`}>
      <figcaption>{c.title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <line className="ref" x1={0} x2={W} y1={y(1)} y2={y(1)} />
        <line className="zero" x1={0} x2={W} y1={y(0)} y2={y(0)} />
        {c.lines.map((l, i) => (
          <polyline
            key={l.label}
            className={i === 0 ? "trace" : "trace alt"}
            points={l.v.map((v, k) => `${x(k, l.v.length).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
          />
        ))}
      </svg>
      <div className="platter-curve-val">
        {c.lines.length > 1 ? (
          <>
            <span className="trace-key">play {fmtS(t)}</span>
            <span className="trace-key alt">stop {fmtS(t2 ?? 0)}</span>
          </>
        ) : (
          fmtS(t)
        )}
      </div>
    </figure>
  );
}

/** Wrap a control so pointing at it or focusing it lights the curve it moves. */
function Lights({ k, set, children }: { k: CurveKey; set: (k: CurveKey | null) => void; children: ReactNode }) {
  return (
    <div onPointerEnter={() => set(k)} onPointerLeave={() => set(null)} onFocus={() => set(k)} onBlur={() => set(null)}>
      {children}
    </div>
  );
}

export function PlatterTab({ settings, set }: { settings: Settings; set: (patch: Partial<Settings>) => void }) {
  const [lit, setLit] = useState<CurveKey | null>(null);
  const curves = useMemo(
    () =>
      platterCurves({
        mass: settings.jogWeight,
        start: settings.vinylStartTime,
        brake: settings.vinylBrakeTime,
        backSpin: settings.backSpinLength,
      }),
    [settings.jogWeight, settings.vinylStartTime, settings.vinylBrakeTime, settings.backSpinLength],
  );
  const curve = (k: CurveKey) => curves.find((c) => c.key === k)!;
  const startT = settleTime(curve("play").lines[0].v, 1);
  const brakeT = settleTime(curve("pause").lines[0].v, 0);

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Platter</span>
          <InfoDot
            label="Platter"
            text={`How the record moves under each gesture: speed (×1 = playing) over ${SPAN_S} s, computed by the same physics the deck runs. Point at a control to see which curve it moves.`}
          />
          <button
            className="link-btn"
            onClick={() => set({ jogWeight: 0.4, vinylStartTime: 0, vinylBrakeTime: 0, backSpinLength: 0.5, jogSensitivity: 1, jogBendStrength: 1 })}
          >
            reset
          </button>
        </div>
        <div className="platter-curves">
          {curves.map((c) => (
            <CurvePanel key={c.key} c={c} lit={lit === c.key} dim={lit != null && lit !== c.key} />
          ))}
        </div>

        <div className="platter-group">Hand</div>
        <Lights k="letGo" set={setLit}>
          <Slider
            label="Mass"
            hint={settings.jogWeight < 0.2 ? "feather" : settings.jogWeight > 0.7 ? "heavy" : "balanced"}
            value={settings.jogWeight}
            onChange={(v) => set({ jogWeight: v })}
            info="How heavy the record feels when you let go. Heavier catches back up to play more slowly and, on a paused deck, glides further before it stops."
          />
        </Lights>
        <ToggleRow
          label="Slip"
          info="Scratch, hold or loop without losing your place: on release, playback snaps to where it would have been, on the beat. Toggle key: Z."
          on={settings.slip}
          onToggle={() => set({ slip: !settings.slip })}
        />

        <div className="platter-group">Motor</div>
        <Lights k="play" set={setLit}>
          <Slider
            label="Start"
            hint={fmtS(startT)}
            value={settings.vinylStartTime}
            onChange={(v) => set({ vinylStartTime: v })}
            min={0}
            info="How long Play takes to spin up to speed. 0 is instant."
          />
        </Lights>
        <Lights k="pause" set={setLit}>
          <Slider
            label="Brake"
            hint={fmtS(brakeT)}
            value={settings.vinylBrakeTime}
            onChange={(v) => set({ vinylBrakeTime: v })}
            min={0}
            info="How long Pause takes to spin down to a stop. 0 is instant."
          />
        </Lights>
        <Lights k="backSpin" set={setLit}>
          <Slider
            label="Back spin"
            hint={settings.backSpinLength < 0.34 ? "short" : settings.backSpinLength > 0.66 ? "long" : "normal"}
            value={settings.backSpinLength}
            onChange={(v) => set({ backSpinLength: v })}
            info="How hard and far a spinback throws the record backward before the motor catches it. Used by the Spinback key or pad and by a hard backward flick of a jog wheel."
          />
        </Lights>

        <div className="platter-group">Hardware jog</div>
        <Slider
          label="Search speed"
          hint={`×${settings.jogSensitivity.toFixed(2)}`}
          value={settings.jogSensitivity}
          onChange={(v) => set({ jogSensitivity: v })}
          min={0.25}
          max={4}
          step={0.05}
          info="How fast SHIFT + jog sweeps through the track. Scratching is always 1:1 with the platter."
        />
        <Slider
          label="Ring bend"
          hint={settings.jogBendStrength < 0.95 ? "gentle" : settings.jogBendStrength > 1.05 ? "strong" : "default"}
          value={settings.jogBendStrength}
          onChange={(v) => set({ jogBendStrength: v })}
          min={0.25}
          max={2}
          step={0.05}
          info="How hard turning the jog's outer ring pushes or pulls the tempo while playing."
        />
      </div>
    </>
  );
}
