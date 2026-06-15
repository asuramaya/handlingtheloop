import { useEffect } from "react";
import type { Deck } from "@htl/audio";
import type { Intent } from "@htl/room";
import { ValueCell } from "./ValueCell";

// The Delay device surface — the first stackable channel-strip effect. Mirrors the EQ's
// interaction contract: mutate the deck's effect directly, then `emit` the matching FX
// intent so a shared session converges, then `refresh`. Knobs reuse ValueCell (same as
// TEMPO/TRIM). TIME is beat-locked by default: it shows a note-division stepper and the
// real delay seconds are computed from the deck's live BPM (so echoes ride the grid even
// as the tempo fader moves); SYNC off turns TIME into a free millisecond control.

// Beat-locked note divisions. 1 beat = a quarter note, so `beats` is the multiplier on
// the beat period (60 / bpm). Index 2 ("1/8") is the device default (see DelayFx._div).
const DIVISIONS: { label: string; beats: number }[] = [
  { label: "1/16", beats: 0.25 },
  { label: "1/8T", beats: 1 / 3 },
  { label: "1/8", beats: 0.5 },
  { label: "3/16", beats: 0.75 }, // dotted 1/8
  { label: "1/4", beats: 1 },
  { label: "1/4.", beats: 1.5 }, // dotted 1/4
  { label: "1/2", beats: 2 },
  { label: "3/4", beats: 3 },
  { label: "1 bar", beats: 4 },
];
const DEFAULT_DIV = 2;

const fmtMs = (s: number) => (s >= 1 ? `${s.toFixed(2)}s` : `${Math.round(s * 1000)}`);
const fmtHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`);
const fmtPct = (v: number) => `${Math.round(v * 100)}`;

interface DelayPanelProps {
  deck: Deck;
  id: "A" | "B";
  slot: number; // effect index (0 = first effect after the EQ)
  accent: string;
  emit: (intent: Intent) => void;
  refresh: () => void;
  onRemove: () => void;
}

export function DelayPanel({ deck, id, slot, accent, emit, refresh, onRemove }: DelayPanelProps) {
  const dev = deck.fxDeviceAt(slot);
  if (!dev) return null;

  const synced = dev.getParam("sync") >= 0.5;
  const divIdx = Math.max(0, Math.min(DIVISIONS.length - 1, Math.round(dev.getParam("div")) || DEFAULT_DIV));
  const bpm = deck.effectiveBpm;

  // Set one device param locally + broadcast it. `emit` is a no-op when solo.
  const setParam = (param: string, value: number) => {
    deck.setFxParam(slot, param, value);
    emit({ kind: "fxParam", deck: id, slot, param, value });
  };

  // Beat-locked time = the division's beats × the beat period. Keep the audio in step with
  // the grid as the division or tempo changes — in an EFFECT, never during render (an emit
  // in render would spam the session). DeckControls re-renders on tempo moves, so `bpm`
  // (deck.effectiveBpm) stays live and re-fires this when it changes.
  const timeForDiv = (idx: number): number | null => (bpm ? (60 / bpm) * DIVISIONS[idx].beats : null);
  useEffect(() => {
    if (!synced || bpm == null) return;
    const want = (60 / bpm) * DIVISIONS[divIdx].beats;
    if (Math.abs(want - dev.getParam("time")) > 1e-4) {
      deck.setFxParam(slot, "time", want);
      emit({ kind: "fxParam", deck: id, slot, param: "time", value: want });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, divIdx, bpm, slot, id]);

  const setDiv = (idx: number) => {
    const i = Math.max(0, Math.min(DIVISIONS.length - 1, Math.round(idx)));
    setParam("div", i);
    const t = timeForDiv(i);
    if (t != null) setParam("time", t);
    refresh();
  };
  const toggleSync = () => {
    setParam("sync", synced ? 0 : 1);
    refresh();
  };
  const toggleBypass = () => {
    deck.setFxBypass(slot, !dev.bypassed);
    emit({ kind: "fxBypass", deck: id, slot, value: dev.bypassed });
    refresh();
  };

  return (
    <div className="fx-panel fx-delay" style={{ ["--accent" as string]: accent }}>
      <div className="fx-knobs">
        {synced ? (
          <ValueCell
            label="TIME"
            value={divIdx}
            min={0}
            max={DIVISIONS.length - 1}
            step={1}
            reset={DEFAULT_DIV}
            onChange={setDiv}
            format={(v) => DIVISIONS[Math.max(0, Math.min(DIVISIONS.length - 1, Math.round(v)))].label}
            kbd=""
          />
        ) : (
          <ValueCell
            label="TIME"
            value={dev.getParam("time")}
            min={0.02}
            max={2}
            step={0.001}
            reset={0.375}
            onChange={(v) => {
              setParam("time", v);
              refresh();
            }}
            format={fmtMs}
          />
        )}
        <ValueCell
          label="FBK"
          value={dev.getParam("feedback")}
          min={0}
          max={0.92}
          step={0.01}
          reset={0.38}
          onChange={(v) => {
            setParam("feedback", v);
            refresh();
          }}
          format={fmtPct}
        />
        <ValueCell
          label="TONE"
          value={dev.getParam("tone")}
          min={200}
          max={18000}
          step={50}
          reset={6500}
          onChange={(v) => {
            setParam("tone", v);
            refresh();
          }}
          format={fmtHz}
        />
        <ValueCell
          label="MIX"
          value={dev.getParam("mix")}
          min={0}
          max={1}
          step={0.01}
          reset={0.28}
          onChange={(v) => {
            setParam("mix", v);
            refresh();
          }}
          format={fmtPct}
        />
      </div>
      <div className="fx-foot">
        <button
          className={`fx-chip ${synced ? "on" : ""}`}
          onClick={toggleSync}
          title={synced ? "Beat-locked — tap for free time (ms)" : "Free time — tap to beat-lock"}
        >
          {synced ? "♩ SYNC" : "ms"}
        </button>
        <button className={`fx-chip ${dev.bypassed ? "" : "on"}`} onClick={toggleBypass} title="Bypass this effect">
          {dev.bypassed ? "OFF" : "ON"}
        </button>
        <button className="fx-chip fx-remove" onClick={onRemove} title="Remove delay">
          ✕
        </button>
      </div>
    </div>
  );
}
