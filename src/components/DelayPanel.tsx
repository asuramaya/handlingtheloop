import { useEffect } from "react";
import { useEmit, useRefresh } from "../App/spine";
import type { Deck } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { DelayViz } from "./DelayViz";
import { useFrameSync } from "./useFrameSync";
import { snapIndex } from "@htl/audio";
import { clamp } from "../util/math";
import { fmtPct } from "../util/format";

// The Delay surface. Its four big params — TIME, FEEDBACK, HP, LP — are not down here: they're
// ON the viz, which already drew every one of them (see DelayViz). Grab a tap to set the time and
// the tail; drag the filter ribbon to set the tone window. LINK is GONE, not moved: it existed
// only because HP and LP were two separate cells, and on a ribbon "sweep both" is just dragging
// the band's body.
//
// What's left is the character — grouped by what it DOES, because a flat grid of nine cells makes
// you read every label to find one: MOTION (depth/rate/width) · COLOUR (drive/lofi) · DYNAMICS
// (duck) · TIME BEHAVIOUR (sync/repitch) · and FREEZE, which is a performance move, not a setting.
//
// Mutate the deck's device directly, `emit` the matching FX intent so a session converges, then
// `refresh`.

const DIVISIONS: { label: string; beats: number }[] = [
  { label: "1/16", beats: 0.25 },
  { label: "1/8T", beats: 1 / 3 },
  { label: "1/8", beats: 0.5 },
  { label: "3/16", beats: 0.75 },
  { label: "1/4", beats: 1 },
  { label: "1/4.", beats: 1.5 },
  { label: "1/2", beats: 2 },
  { label: "3/4", beats: 3 },
  { label: "1 bar", beats: 4 },
];
const DIVISION_BEATS = DIVISIONS.map((d) => d.beats); // the magnet the viz draws while you drag a tap
const DIVISION_LABELS = DIVISIONS.map((d) => d.label);
// The wobble's ladder — one LFO cycle per N beats. It locks to the grid whenever the delay does.
const LFO_BEATS = [0.25, 0.5, 1, 2, 4, 8, 16];
const LFO_LABELS = ["1/16", "1/8", "1/4", "1/2", "1 bar", "2 bar", "4 bar"];
const DEFAULT_DIV = 2;
const TIME_MODES = ["RPT", "DIG", "FADE"]; // Repitch / Digital / Fade
const STEREO_MODES = ["MONO", "PING"]; // Single / Ping-Pong

// The depth of a layered control, made visible: one pip per mode, the current one filled. Without
// it a cycler is a button that lies — it shows you a value and hides the fact that it's a stack.
function Pips({ n, at }: { n: number; at: number }) {
  return (
    <span className="cyc-pips" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i === at ? "on" : ""} />
      ))}
    </span>
  );
}

interface DelayPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number; // rack index of this delay device
  accent: string;
}

export function DelayPanel({ deck, id, slot, accent }: DelayPanelProps) {
  const emit = useEmit();
  const refresh = useRefresh();
  const dev = deck.fxDeviceAt(slot);
  if (!dev) return null;

  const get = (p: string) => dev.getParam(p);
  const synced = get("sync") >= 0.5;
  const frozen = get("freeze") >= 0.5;
  const timeMode = Math.round(get("timeMode"));
  const stereo = Math.round(get("stereo"));
  const divIdx = Math.max(0, Math.min(DIVISIONS.length - 1, Math.round(get("div")) || DEFAULT_DIV));
  const bpm = deck.effectiveBpm;

  // Set one device param locally + broadcast it (emit is a no-op when solo).
  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
  };
  // ★ LIVE path — see useFrameSync. The AUDIO moves on the pointer event (it must never wait),
  // but the React render and the session emit are folded into ONE pass per frame. Doing both on
  // every pointermove spent the frame budget re-rendering the deck instead of painting the thing
  // under your finger, and flooded the socket with intents no remote could use.
  const sync = useFrameSync((param, value) => emit({ kind: "fxParam", deck: id, slot, param, value }), refresh);
  const live = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    sync(param, value);
  };
  const tweak = live;

  // Beat-locked time = the division × the beat period. Pushed from an EFFECT (never during
  // render — an emit in render would spam the session); re-fires when the division or tempo
  // changes (DeckControls re-renders on tempo moves, so `bpm` stays live).
  useEffect(() => {
    if (!synced || bpm == null) return;
    const want = (60 / bpm) * DIVISIONS[divIdx].beats;
    if (Math.abs(want - get("time")) > 1e-4) setParam("time", want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, divIdx, bpm, slot, id]);

  // The viz hands back raw seconds; the note grid is the panel's business. Snap by LOG distance,
  // not linear — 1/8 and 1/8T are close in seconds but a triplet is never "nearly" a straight
  // eighth, and a linear nearest would make the long divisions impossible to land on.
  // ★ EVERY HANDLER RETURNS WHAT IT COMMITTED. The viz mirrors that, never the request — see the
  // note on DelayVizProps. The current rung is read FRESH off the device, not from the
  // render-scoped `divIdx`, which is a frame stale inside a pointermove burst.
  const onTime = (sec: number): number => {
    if (synced && bpm != null) {
      const beatSec = 60 / bpm;
      const held = Math.round(get("div"));
      // snapIndex, not a bare "nearest": nearest, recomputed every frame, flips on a pixel of hand
      // jitter anywhere near a midpoint — the tap machine-guns between two divisions. See snap.ts.
      const i = snapIndex(sec / beatSec, DIVISION_BEATS, held);
      if (i !== held) live("div", i);
      const locked = beatSec * DIVISIONS[i].beats;
      live("time", locked);
      return locked;
    }
    const free = clamp(sec, 0.02, 2);
    live("time", free);
    return free;
  };
  const onFeedback = (v: number): number => {
    live("feedback", v);
    return v;
  };
  // The wobble is ONE gesture, so it arrives as one call — depth and rate together. Its RATE locks
  // to musical periods whenever the delay is beat-locked: a free-running wobble drifts against the
  // track, and drifting is the whole difference between a dub delay's wobble sitting IN the groove
  // and sitting beside it.
  const onMod = (depth: number, rate: number): [number, number] => {
    let r = rate;
    if (synced && bpm != null) {
      const beatSec = 60 / bpm;
      const beatsPerCycle = (v: number) => 1 / Math.max(1e-4, v) / beatSec; // Hz → beats per cycle
      const held = snapIndex(beatsPerCycle(get("modRate")), LFO_BEATS, -1);
      const i = snapIndex(beatsPerCycle(rate), LFO_BEATS, held);
      r = 1 / (LFO_BEATS[i] * beatSec);
    }
    live("modDepth", depth);
    live("modRate", r);
    return [depth, r];
  };
  const onFilters = (hp: number, lp: number): [number, number] => {
    if (Math.abs(hp - get("hp")) > 0.5) live("hp", hp);
    if (Math.abs(lp - get("lp")) > 0.5) live("lp", lp);
    return [get("hp"), get("lp")]; // the device clamps — report what it actually took
  };

  const cycle = (param: string, count: number) => {
    setParam(param, (Math.round(get(param)) + 1) % count);
    refresh();
  };
  const toggle = (param: string) => {
    setParam(param, get(param) >= 0.5 ? 0 : 1);
    refresh();
  };

  return (
    <div className="fx-panel fx-delay" style={{ ["--accent" as string]: accent }}>
      <DelayViz
        time={get("time")}
        feedback={get("feedback")}
        mix={get("mix")}
        pingpong={stereo === 1}
        frozen={frozen}
        bpm={bpm}
        accent={accent}
        hp={get("hp")}
        lp={get("lp")}
        modDepth={get("modDepth")}
        modRate={get("modRate")}
        drive={get("analog")}
        duck={get("duck")}
        width={get("spread")}
        snapBeats={synced ? DIVISION_BEATS : undefined}
        snapLabels={synced ? DIVISION_LABELS : undefined}
        modSnapBeats={synced ? LFO_BEATS : undefined}
        modSnapLabels={synced ? LFO_LABELS : undefined}
        onTime={onTime}
        onFeedback={onFeedback}
        onFilters={onFilters}
        onMod={onMod}
      />
      {/* The character params, in families. MOTION · COLOUR · DYNAMICS. */}
      <div className="fx-knobs dly-knobs">
        {/* DEPTH and RATE are NOT here. They were never two knobs — depth without rate is silent,
            rate without depth is inaudible; neither half means anything alone, which is the tell
            that they're one control wearing two costumes. They're the WAVE on the viz now: grab it,
            up/down is how deep, sideways stretches it. At depth 0 the wave is flat, which is
            exactly the centre line — so the resting wobble is a thing you can grab, not a ghost. */}
        <ValueCell label="WIDTH" value={get("spread")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("spread", v)} format={fmtPct} />
        <span className="fx-sep" aria-hidden="true" />
        <ValueCell label="DRIVE" value={get("analog")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("analog", v)} format={fmtPct} />
        <span className="fx-sep" aria-hidden="true" />
        <ValueCell label="DUCK" value={get("duck")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("duck", v)} format={fmtPct} />
      </div>
      {/* ★ ORDERED BY WHEN YOU REACH FOR IT, NOT BY TOPIC. On a phone this rack is ~180px and the
          row has to slide; whatever sits at the far right is, in practice, unreachable — FREEZE
          was literally clipped off the edge of an iPhone. So the two you touch MID-MIX lead:
          FREEZE (an infinite hold you slam) and SYNC. The set-and-forget ones (repitch / stereo /
          lofi) live to their right, where scrolling to them costs nothing. */}
      <div className="fx-foot">
        {/* FREEZE is a performance move, not a setting. It gets the weight of one — and the first
            slot, because a control you can't reach in a hurry isn't a performance control. */}
        <button className={`fx-chip dly-freeze ${frozen ? "on" : ""}`} onClick={() => toggle("freeze")} title="Freeze — infinite hold of the current tail">
          ❄ FREEZE
        </button>
        <button className={`fx-chip ${synced ? "on" : ""}`} onClick={() => toggle("sync")} title={synced ? "Beat-locked — tap for free ms" : "Free time — tap to beat-lock"}>
          {synced ? "SYNC" : "ms"}
        </button>
        <span className="fx-sep" aria-hidden="true" />
        {/* ★ A CYCLER IS A STACK, AND IT MUST SHOW ITS DEPTH. RPT/MONO used to be styled exactly
            like the toggles beside them, so nothing said that tapping RPT gives you DIG and FADE —
            two of the chips had invisible contents. A ▸ only says "there's more"; the PIPS say how
            many more and WHERE YOU ARE in them, which is the question you actually have. */}
        <button className="fx-chip cyc" onClick={() => cycle("timeMode", TIME_MODES.length)} title={`Time-change behaviour — tap to cycle: ${TIME_MODES.join(" / ")} (Repitch slurs the pitch, Digital jumps, Fade crossfades)`}>
          {TIME_MODES[timeMode] ?? "RPT"}
          <Pips n={TIME_MODES.length} at={timeMode} />
        </button>
        <button className="fx-chip cyc" onClick={() => cycle("stereo", STEREO_MODES.length)} title={`Stereo — tap to cycle: ${STEREO_MODES.join(" / ")} (Ping-Pong bounces L↔R)`}>
          {STEREO_MODES[stereo] ?? "MONO"}
          <Pips n={STEREO_MODES.length} at={stereo} />
        </button>
        <button className={`fx-chip ${get("lofi") >= 0.5 ? "on" : ""}`} onClick={() => toggle("lofi")} title="LoFi — old-digital-delay bitcrush + bandwidth loss">
          LOFI
        </button>
      </div>
    </div>
  );
}
