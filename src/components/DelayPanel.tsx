import { useEffect } from "react";
import { useEmit, useRefresh } from "../App/spine";
import type { Deck } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { DelayViz } from "./DelayViz";
import { clamp } from "../util/math";
import { fmtPct, fmtMs } from "../util/format";

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
const DEFAULT_DIV = 2;
const TIME_MODES = ["RPT", "DIG", "FADE"]; // Repitch / Digital / Fade
const STEREO_MODES = ["MONO", "PING"]; // Single / Ping-Pong

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
  const tweak = (param: string, value: number) => {
    setParam(param, value);
    refresh();
  };

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
  const onTime = (sec: number) => {
    if (synced && bpm != null) {
      const beats = sec / (60 / bpm);
      let best = DEFAULT_DIV;
      let bestD = Infinity;
      DIVISIONS.forEach((d, i) => {
        const dist = Math.abs(Math.log(d.beats / Math.max(1e-4, beats)));
        if (dist < bestD) {
          bestD = dist;
          best = i;
        }
      });
      if (best !== divIdx) setParam("div", best);
      setParam("time", (60 / bpm) * DIVISIONS[best].beats);
    } else {
      setParam("time", clamp(sec, 0.02, 2));
    }
    refresh();
  };
  const onFeedback = (v: number) => tweak("feedback", v);
  const onFilters = (hp: number, lp: number) => {
    if (Math.abs(hp - get("hp")) > 0.5) setParam("hp", hp);
    if (Math.abs(lp - get("lp")) > 0.5) setParam("lp", lp);
    refresh();
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
        timeLabel={synced ? DIVISIONS[divIdx].label : fmtMs(get("time"))}
        onTime={onTime}
        onFeedback={onFeedback}
        onFilters={onFilters}
      />
      {/* The character params, in families. MOTION · COLOUR · DYNAMICS. */}
      <div className="fx-knobs dly-knobs">
        <ValueCell label="DEPTH" value={get("modDepth")} min={0} max={0.012} step={0.0002} reset={0} onChange={(v) => tweak("modDepth", v)} format={(v) => `${Math.round((v / 0.012) * 100)}`} />
        <ValueCell label="RATE" value={get("modRate")} min={0.02} max={8} step={0.02} reset={0.5} onChange={(v) => tweak("modRate", v)} format={(v) => `${v.toFixed(2)}`} />
        <ValueCell label="WIDTH" value={get("spread")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("spread", v)} format={fmtPct} />
        <span className="fx-sep" aria-hidden="true" />
        <ValueCell label="DRIVE" value={get("analog")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("analog", v)} format={fmtPct} />
        <span className="fx-sep" aria-hidden="true" />
        <ValueCell label="DUCK" value={get("duck")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("duck", v)} format={fmtPct} />
      </div>
      <div className="fx-foot">
        {/* SYNC + the time-change behaviour: both are about how TIME moves, so they sit together
            (TIME itself is on the viz). */}
        <button className={`fx-chip ${synced ? "on" : ""}`} onClick={() => toggle("sync")} title={synced ? "Beat-locked — tap for free ms" : "Free time — tap to beat-lock"}>
          {synced ? "SYNC" : "ms"}
        </button>
        {/* ★ A CYCLER, and it has to LOOK like one. RPT/MONO used to be styled exactly like the
            toggles beside them, so nothing said that tapping RPT gives you DIG and FADE — two of
            the six chips had invisible contents. The ▸ says "there's more behind me". */}
        <button className="fx-chip cyc" onClick={() => cycle("timeMode", TIME_MODES.length)} title="Time-change behaviour — tap to cycle: Repitch (pitch slur) / Digital / Fade">
          {TIME_MODES[timeMode] ?? "RPT"}
          <span className="cyc-mark">▸</span>
        </button>
        <span className="fx-sep" aria-hidden="true" />
        <button className="fx-chip cyc" onClick={() => cycle("stereo", STEREO_MODES.length)} title="Stereo — tap to cycle: Mono (independent) / Ping-Pong (bounce L↔R)">
          {STEREO_MODES[stereo] ?? "MONO"}
          <span className="cyc-mark">▸</span>
        </button>
        <button className={`fx-chip ${get("lofi") >= 0.5 ? "on" : ""}`} onClick={() => toggle("lofi")} title="LoFi — old-digital-delay bitcrush + bandwidth loss">
          LOFI
        </button>
        <span className="fx-sep" aria-hidden="true" />
        {/* FREEZE is a performance move — an infinite hold you SLAM mid-phrase — not a setting.
            It gets the weight of one. */}
        <button className={`fx-chip dly-freeze ${frozen ? "on" : ""}`} onClick={() => toggle("freeze")} title="Freeze — infinite hold of the current tail">
          ❄ FREEZE
        </button>
      </div>
    </div>
  );
}
