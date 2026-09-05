import { useEffect } from "react";
import { useEmit, useRefresh } from "../App/spine";
import type { Deck } from "@htl/audio";
import { DelayViz } from "./DelayViz";
import { useFrameSync } from "./useFrameSync";
import { snapIndex } from "@htl/audio";
import { clamp } from "../util/math";
import { fxParamIntent } from "@htl/room/fxWire";

// The Delay surface. Its four big params — TIME, FEEDBACK, HP, LP — are not down here: they're
// ON the viz, which already drew every one of them (see DelayViz). Grab a tap to set the time and
// the tail; drag the filter ribbon to set the tone window. LINK is GONE, not moved: it existed
// only because HP and LP were two separate cells, and on a ribbon "sweep both" is just dragging
// the band's body.
//
// What's left is the character — grouped by what it DOES, because a flat grid of nine cells makes
// you read every label to find one: MOTION (depth/rate/width) · COLOUR (drive) · DYNAMICS
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
    emit(fxParamIntent(deck, id, slot, param, value));
  };
  // ★ LIVE path — see useFrameSync. The AUDIO moves on the pointer event (it must never wait),
  // but the React render and the session emit are folded into ONE pass per frame. Doing both on
  // every pointermove spent the frame budget re-rendering the deck instead of painting the thing
  // under your finger, and flooded the socket with intents no remote could use.
  const sync = useFrameSync((param, value) => emit(fxParamIntent(deck, id, slot, param, value)), refresh);
  const live = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    sync(param, value);
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
  // The KNOB's own committed value — not what's actually applied (DelayFx caps that live from the
  // feedback amount; the viz reads hpResApplied/lpResApplied straight off the device for drawing).
  const onRes = (hpRes: number, lpRes: number): [number, number] => {
    if (Math.abs(hpRes - get("hpRes")) > 0.002) live("hpRes", hpRes);
    if (Math.abs(lpRes - get("lpRes")) > 0.002) live("lpRes", lpRes);
    return [get("hpRes"), get("lpRes")];
  };
  // The character rail. These three are the only params left with no geometry of their own, so they
  // ride a fader each at the foot of the viz instead of three cells in a DOM row below it.
  const CHAR_PARAM = { width: "spread", drive: "analog", duck: "duck" } as const;
  const onChar = (id: "width" | "drive" | "duck", v: number): number => {
    const c = clamp(v, 0, 1);
    live(CHAR_PARAM[id], c);
    return c;
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
        deck={deck}
        slot={slot}
        time={get("time")}
        feedback={get("feedback")}
        mix={get("mix")}
        pingpong={stereo === 1}
        frozen={frozen}
        bpm={bpm}
        accent={accent}
        hp={get("hp")}
        lp={get("lp")}
        hpRes={get("hpRes")}
        lpRes={get("lpRes")}
        modDepth={get("modDepth")}
        modRate={get("modRate")}
        drive={get("analog")}
        duck={get("duck")}
        width={get("spread")}
        timeMode={timeMode}
        snapBeats={synced ? DIVISION_BEATS : undefined}
        snapLabels={synced ? DIVISION_LABELS : undefined}
        modSnapBeats={synced ? LFO_BEATS : undefined}
        modSnapLabels={synced ? LFO_LABELS : undefined}
        onTime={onTime}
        onFeedback={onFeedback}
        onFilters={onFilters}
        onRes={onRes}
        onMod={onMod}
        onChar={onChar}
      />
      {/* The cell row is GONE. WIDTH · DRIVE · DUCK were the last three params standing in a DOM
          grid under a canvas that is otherwise the whole instrument — and they're bare 0‥1
          quantities with no geometry to seize, which is precisely what a fader is for. They're the
          rail at the foot of the viz now. (DEPTH and RATE left earlier, for the same reason in
          reverse: they DO have geometry — they're the wave.) */}
      {/* ★ ORDERED BY WHEN YOU REACH FOR IT, NOT BY TOPIC. On a phone this rack is ~180px and the
          row has to slide; whatever sits at the far right is, in practice, unreachable — FREEZE
          was literally clipped off the edge of an iPhone. So the two you touch MID-MIX lead:
          FREEZE (an infinite hold you slam) and SYNC. The set-and-forget ones (repitch / stereo)
          live to their right, where scrolling to them costs nothing. */}
      <div className="fx-foot">
        {/* FREEZE is a performance move, not a setting. It gets the weight of one — and the first
            slot, because a control you can't reach in a hurry isn't a performance control. */}
        <button className={`fx-chip dly-freeze ${frozen ? "on" : ""}`} onClick={() => toggle("freeze")}>
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
      </div>
    </div>
  );
}
