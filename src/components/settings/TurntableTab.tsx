// Settings ▸ Turntable — how a deck moves: the platter, its motor, the jog's ring and search, and
// how tempo changes are rendered (the stretch engine). One tab, drawn.
//
// ★ WHY. Operator, 2026-11-02: "im worried about overcomplication and splintering in the settings
// ... start with the spiritual whole of the jog mechanism", then: the stretch engine "probably
// belongs in platter too, but platter maybe needs a diff name", and "the graph to control maps need
// more love". So:
//   • every gesture is a TILE: its curve, its readout, and the control(s) that shape it, together.
//     The graph is not a legend for sliders somewhere below; it sits on top of its own slider, and
//     dragging sideways ON the graph moves that same value.
//   • the curves are the deck's own physics with the deck's own mappings (platterCurves.ts), so
//     what you see is what the platter will do.
//   • Tempo (stretch engine + sync responsiveness) moved here from Audio, whose "Stretch engine"
//     card had also been holding the master limiter and headroom.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { STRETCH_PRESETS, type Settings, type StretchEngine, type StretchQuality } from "@htl";
import { InfoDot } from "./InfoDot";
import { Slider } from "./Slider";
import { ToggleRow } from "./ControlsTab";
import { peak, platterCurves, ringCurve, settleTime, SPAN_S, type Curve } from "./platterCurves";

// An instant gesture still lands one simulation step later (DT ≈ 8 ms): that is "instant", not
// "0.01s" — the readout rounds a single step away.
const fmtS = (s: number) => (s <= 0.0101 ? "instant" : `${s.toFixed(2)}s`);

/** A value the tile edits: its range, so the graph can be dragged as well as the slider. */
interface Knob {
  value: number;
  min: number;
  max: number;
  step: number;
  set: (v: number) => void;
  label: string;
}

function Graph({ c, knob }: { c: Curve; knob: Knob }) {
  const W = 160;
  const H = 64;
  const x = (i: number, len: number) => (i / (len - 1)) * W;
  const y = (v: number) => H - ((v - c.yMin) / (c.yMax - c.yMin)) * H;
  const drag = useRef<{ x: number; v: number; w: number } | null>(null);
  const snap = (v: number) => Math.max(knob.min, Math.min(knob.max, Math.round(v / knob.step) * knob.step));
  return (
    <svg
      className="tt-graph"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${c.title} curve; drag sideways to change ${knob.label}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, v: knob.value, w: e.currentTarget.getBoundingClientRect().width };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        knob.set(snap(d.v + ((e.clientX - d.x) / d.w) * (knob.max - knob.min)));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      {c.unit === "×" && <line className="ref" x1={0} x2={W} y1={y(1)} y2={y(1)} />}
      <line className="zero" x1={0} x2={W} y1={y(0)} y2={y(0)} />
      {c.lines.map((l, i) => (
        <polyline
          key={l.label}
          className={i === 0 ? "trace" : "trace alt"}
          points={l.v.map((v, k) => `${x(k, l.v.length).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
        />
      ))}
    </svg>
  );
}

function Tile({ c, readout, knob, info, children }: { c: Curve; readout: ReactNode; knob: Knob; info: string; children?: ReactNode }) {
  return (
    <div className="tt-tile">
      <div className="tt-tile-head">
        <span className="tt-tile-title">{c.title}</span>
        <InfoDot label={c.title} text={info} />
        <span className="tt-tile-val">{readout}</span>
      </div>
      <Graph c={c} knob={knob} />
      <input
        type="range"
        className="settings-slider tt-slider"
        aria-label={knob.label}
        min={knob.min}
        max={knob.max}
        step={knob.step}
        value={knob.value}
        onChange={(e) => knob.set(Number(e.target.value))}
      />
      {children}
    </div>
  );
}

export function TurntableTab({ settings, set }: { settings: Settings; set: (patch: Partial<Settings>) => void }) {
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
  const ring = useMemo(() => ringCurve(settings.jogBendStrength), [settings.jogBendStrength]);
  const [play, pause, letGo, back] = curves;
  const knob = (label: string, key: keyof Settings, min = 0, max = 1, step = 0.01): Knob => ({
    label,
    value: settings[key] as number,
    min,
    max,
    step,
    set: (v) => set({ [key]: v } as Partial<Settings>),
  });
  const [showTempoDetail, setShowTempoDetail] = useState(false);

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Platter</span>
          <InfoDot
            label="Platter"
            text={`Speed of the record (×1 = playing) over ${SPAN_S} s for each gesture, computed by the same physics the deck runs. Drag a slider, or drag sideways on a graph, and watch the curve change.`}
          />
          <button className="link-btn" onClick={() => set({ jogWeight: 0.4, vinylStartTime: 0, vinylBrakeTime: 0, backSpinLength: 0.5 })}>
            reset
          </button>
        </div>
        <div className="tt-tiles">
          <Tile c={play} readout={fmtS(settleTime(play.lines[0].v, 1))} knob={knob("Start", "vinylStartTime")} info="Play's motor spin-up. All the way left is instant." />
          <Tile c={pause} readout={fmtS(settleTime(pause.lines[0].v, 0))} knob={knob("Brake", "vinylBrakeTime")} info="Pause's motor spin-down. All the way left is instant." />
          <Tile
            c={letGo}
            readout={
              <>
                <span className="trace-key">catch {fmtS(settleTime(letGo.lines[0].v, 1))}</span>
                <span className="trace-key alt">glide {fmtS(settleTime(letGo.lines[1].v, 0))}</span>
              </>
            }
            knob={knob("Mass", "jogWeight")}
            info="The record's mass when you let go of it. Solid line: released on a playing deck, it catches back up to play. Dashed: pushed on a paused deck, it glides to a stop. Heavier is slower to catch and glides further."
          >
            <ToggleRow
              label="Slip"
              info="On release, playback snaps to where it would have been, on the beat, instead of catching up from where you let go. Toggle key: Z."
              on={settings.slip}
              onToggle={() => set({ slip: !settings.slip })}
            />
          </Tile>
          <Tile
            c={back}
            readout={`×${Math.abs(peak(back.lines[0].v)).toFixed(0)} back · ${fmtS(settleTime(back.lines[0].v, 1))}`}
            knob={knob("Back spin", "backSpinLength")}
            info="How hard a spinback throws the record backward and how long the motor takes to catch it. The Spinback key or pad, and a hard backward flick of a jog wheel."
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Jog wheel</span>
          <InfoDot label="Jog wheel" text="Hardware jog wheels. Scratching is always 1:1 with the platter: one turn of the wheel is one turn of the record." />
          <button className="link-btn" onClick={() => set({ jogSensitivity: 1, jogBendStrength: 1 })}>
            reset
          </button>
        </div>
        <div className="tt-tiles">
          <Tile
            c={ring}
            readout={`+${peak(ring.lines[0].v).toFixed(0)}% push`}
            knob={knob("Ring bend", "jogBendStrength", 0.25, 2, 0.05)}
            info="Turning the jog's outer ring while playing pushes the tempo, and it eases back when you stop. The graph is a gentle turn held for 0.4 s, then let go."
          />
          <div className="tt-tile">
            <div className="tt-tile-head">
              <span className="tt-tile-title">Search</span>
              <InfoDot label="Search" text="SHIFT + jog sweeps through the track. This is how far one turn of the wheel travels." />
              <span className="tt-tile-val">×{settings.jogSensitivity.toFixed(2)}</span>
            </div>
            <div className="tt-big" aria-live="polite">
              1 turn ≈ <b>{(36 * settings.jogSensitivity).toFixed(0)} s</b> of track
            </div>
            <input
              type="range"
              className="settings-slider tt-slider"
              aria-label="Search speed"
              min={0.25}
              max={4}
              step={0.05}
              value={settings.jogSensitivity}
              onChange={(e) => set({ jogSensitivity: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="settings-section tt-tempo">
        <div className="settings-section-head">
          <span className="settings-label">Tempo</span>
          <InfoDot
            label="Tempo"
            text="How a deck sounds when its tempo or key moves. WSOLA works in the time domain: lightest on CPU and crispest on drums, but can sound metallic on a dense mix. Phase-locked works in the frequency domain: cleanest on full mixes, at more CPU. Quality trades latency for grain size; the number is the real latency."
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Algorithm</span>
          <span className="settings-control">
            <span className="seg-group">
              {([
                ["wsola", "WSOLA"],
                ["pv", "Phase-locked"],
              ] as [StretchEngine, string][]).map(([e, label]) => (
                <button key={e} className={`hw-btn small ${settings.stretchEngine === e ? "on" : ""}`} onClick={() => set({ stretchEngine: e })}>
                  {label}
                </button>
              ))}
            </span>
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-label">Quality</span>
          <span className="settings-control">
            <span className="settings-value">~{STRETCH_PRESETS[settings.stretchQuality].latencyMs} ms</span>
            <span className="seg-group">
              {(Object.keys(STRETCH_PRESETS) as StretchQuality[]).map((q) => (
                <button key={q} className={`hw-btn small ${settings.stretchQuality === q ? "on" : ""}`} onClick={() => set({ stretchQuality: q })}>
                  {STRETCH_PRESETS[q].label}
                </button>
              ))}
            </span>
          </span>
        </div>
        <Slider
          label="Sync pull"
          info="How hard SYNC pulls a following deck back onto the beat after it drifts or you nudge it. Gentle is inaudible but slow (a seek takes about eleven seconds to come fully back); tight re-locks in a fraction of that, at the cost of a briefly larger tempo trim."
          hint={settings.syncPhaseGain <= 0.07 ? "gentle" : settings.syncPhaseGain >= 0.15 ? "tight" : "balanced"}
          value={settings.syncPhaseGain}
          onChange={(v) => set({ syncPhaseGain: v })}
          min={0.02}
          max={0.3}
          step={0.02}
        />
        <button className="link-btn tt-more" onClick={() => setShowTempoDetail((o) => !o)} aria-expanded={showTempoDetail}>
          {showTempoDetail ? "Fewer options" : "More options"}
        </button>
        {showTempoDetail && (
          <>
            <ToggleRow
              label="Keep attacks sharp"
              info="Copy drum hits through intact instead of stretching them with everything else, so kicks and snares keep their edge at a changed tempo."
              on={settings.stretchTransient}
              onToggle={() => set({ stretchTransient: !settings.stretchTransient })}
            />
            {settings.stretchTransient && (
              <Slider
                label="Attack detector"
                info="How eager the attack detector is. Sensitive catches soft hits but can mistake a busy passage for one; strict only fires on a clear transient."
                hint={settings.stretchTThresh <= 1.7 ? "sensitive" : settings.stretchTThresh >= 3 ? "strict" : "balanced"}
                value={settings.stretchTThresh}
                onChange={(v) => set({ stretchTThresh: v })}
                min={1.3}
                max={4}
                step={0.1}
              />
            )}
            <ToggleRow
              label="Anti-alias pitch-up"
              info="A cleaner resampler when the key goes up, which removes the fizz on a key-up. WSOLA only."
              on={settings.stretchAa}
              onToggle={() => set({ stretchAa: !settings.stretchAa })}
            />
          </>
        )}
      </div>
    </>
  );
}
