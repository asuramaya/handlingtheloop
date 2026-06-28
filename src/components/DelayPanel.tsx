import { useEffect } from "react";
import { useEmit, useRefresh } from "../App/spine";
import type { Deck } from "@htl/audio";
import { ValueCell } from "./ValueCell";
import { DelayViz } from "./DelayViz";
import { clamp } from "../util/math";
import { fmtHz, fmtPct, fmtMs } from "../util/format";

// The Delay device surface (H-Delay × Eternity). Mirrors the EQ contract: mutate the
// deck's effect directly, `emit` the matching FX intent so a session converges, then
// `refresh`. Knobs reuse ValueCell. TIME is beat-locked by default (a note-division
// stepper; real seconds computed from the deck BPM, so echoes ride the grid as the tempo
// moves); chips switch time-mode (Repitch/Digital/Fade), stereo (Mono/Ping-Pong), LINK
// (sweep HP+LP together), FREEZE (infinite hold) and SYNC (beat-lock).

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
  const linked = get("link") >= 0.5;
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

  const setDiv = (idx: number) => {
    const i = Math.max(0, Math.min(DIVISIONS.length - 1, Math.round(idx)));
    setParam("div", i);
    if (bpm != null) setParam("time", (60 / bpm) * DIVISIONS[i].beats);
    refresh();
  };
  // HP/LP: when LINK is on, sweeping one drags the other by the same Hz ratio (band sweep).
  const setFilter = (which: "hp" | "lp", v: number) => {
    if (linked) {
      const cur = get(which);
      const ratio = cur > 0 ? v / cur : 1;
      const other = which === "hp" ? "lp" : "hp";
      setParam(other, clamp(get(other) * ratio, which === "hp" ? 200 : 20, 18000));
    }
    setParam(which, v);
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
      <DelayViz time={get("time")} feedback={get("feedback")} mix={get("mix")} pingpong={stereo === 1} frozen={frozen} bpm={bpm} accent={accent} hp={get("hp")} lp={get("lp")} modDepth={get("modDepth")} modRate={get("modRate")} drive={get("analog")} duck={get("duck")} width={get("spread")} />
      <div className="fx-knobs">
        {synced ? (
          <ValueCell label="TIME" value={divIdx} min={0} max={DIVISIONS.length - 1} step={1} reset={DEFAULT_DIV} onChange={setDiv} format={(v) => DIVISIONS[clamp(Math.round(v), 0, DIVISIONS.length - 1)].label} />
        ) : (
          <ValueCell label="TIME" value={get("time")} min={0.02} max={2} step={0.001} reset={0.375} onChange={(v) => tweak("time", v)} format={fmtMs} />
        )}
        <ValueCell label="FBK" value={get("feedback")} min={0} max={0.95} step={0.01} reset={0.38} onChange={(v) => tweak("feedback", v)} format={fmtPct} />
        <ValueCell label="HP" value={get("hp")} min={20} max={18000} step={20} reset={120} onChange={(v) => setFilter("hp", v)} format={fmtHz} />
        <ValueCell label="LP" value={get("lp")} min={200} max={18000} step={50} reset={6500} onChange={(v) => setFilter("lp", v)} format={fmtHz} />
        <ValueCell label="MIX" value={get("mix")} min={0} max={1} step={0.01} reset={0.28} onChange={(v) => tweak("mix", v)} format={fmtPct} />
        <ValueCell label="DEPTH" value={get("modDepth")} min={0} max={0.012} step={0.0002} reset={0} onChange={(v) => tweak("modDepth", v)} format={(v) => `${Math.round((v / 0.012) * 100)}`} />
        <ValueCell label="RATE" value={get("modRate")} min={0.02} max={8} step={0.02} reset={0.5} onChange={(v) => tweak("modRate", v)} format={(v) => `${v.toFixed(2)}`} />
        <ValueCell label="DRIVE" value={get("analog")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("analog", v)} format={fmtPct} />
        <ValueCell label="DUCK" value={get("duck")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("duck", v)} format={fmtPct} />
        <ValueCell label="WIDTH" value={get("spread")} min={0} max={1} step={0.01} reset={0} onChange={(v) => tweak("spread", v)} format={fmtPct} />
      </div>
      <div className="fx-foot">
        <button className="fx-chip" onClick={() => cycle("timeMode", TIME_MODES.length)} title="Time-change behaviour: Repitch (pitch slur) / Digital / Fade">
          {TIME_MODES[timeMode] ?? "RPT"}
        </button>
        <button className="fx-chip" onClick={() => cycle("stereo", STEREO_MODES.length)} title="Stereo: Mono (independent) / Ping-Pong (bounce L↔R)">
          {STEREO_MODES[stereo] ?? "MONO"}
        </button>
        <button className={`fx-chip ${linked ? "on" : ""}`} onClick={() => toggle("link")} title="Link HP+LP — sweep the band together">
          LINK
        </button>
        <button className={`fx-chip ${get("lofi") >= 0.5 ? "on" : ""}`} onClick={() => toggle("lofi")} title="LoFi — old-digital-delay bitcrush + bandwidth loss">
          LOFI
        </button>
        <button className={`fx-chip ${frozen ? "on" : ""}`} onClick={() => toggle("freeze")} title="Freeze — infinite hold of the current tail">
          ❄ FRZ
        </button>
        <button className={`fx-chip ${synced ? "on" : ""}`} onClick={() => toggle("sync")} title={synced ? "Beat-locked — tap for free ms" : "Free time — tap to beat-lock"}>
          {synced ? "SYNC" : "ms"}
        </button>
      </div>
    </div>
  );
}
