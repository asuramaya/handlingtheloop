import { useEffect, useRef } from "react";
import type { Deck } from "@htl/audio";
import { useLongPress } from "./useLongPress";

// Equal-power crossfade gains in dB (match AudioEngine.setCrossfade) — fed to the glow
// so each side brightens by its ACTUAL post-crossfade contribution, not its raw channel level.
export function crossfadeGainsDb(crossfade: number): { a: number; b: number } {
  const x = (crossfade + 1) / 2;
  const toDb = (g: number) => 20 * Math.log10(Math.max(g, 1e-4));
  return { a: toDb(Math.cos((x * Math.PI) / 2)), b: toDb(Math.cos(((1 - x) * Math.PI) / 2)) };
}

interface CrossfaderProps {
  deckA: Deck;
  deckB: Deck;
  accentA: string;
  accentB: string;
  crossfade: number;
  onCrossfade: (v: number) => void;
  locked?: boolean; // the crossfader is a whole-board move → blocked for non-full-controllers
  smart?: boolean; // Smart Fader armed → the throw scrubs an auto-transition (tempo morph + bass swap)
  enabled?: boolean; // crossfader live? (disabled = the bar is ignored — Shift+T / FLX shifted state)
  canControl?: boolean; // may this user toggle? (false = non-controller in a session → chip inert)
  shift?: boolean; // board shift held/latched → the chip previews & fires its ALT action (mirrors every shifted button)
  kbd?: string; // keyboard hint for the Smart Fader toggle (shown inside the chip when show-keys is on)
  onToggleSmart?: () => void; // tap the SMART chip → arm/disarm (mirrors the `T` key)
  onToggleEnabled?: () => void; // hold / right-click / SHIFT-tap the SMART chip → enable/disable (mirrors `Shift+T`)
}

const FLOOR_DB = -60; // dBFS floor for the glow brightness
const DECAY = 1.1; // per-frame fall (instant attack, slow decay — VU ballistics)

// The A↔B crossfader as a HORIZONTAL bar. The strip is always an A↔B blend gradient; instead of a
// discrete level meter, each side's GLOW brightens with that deck's post-crossfade output (louder =
// brighter), so position (handle), blend (gradient) and level (glow) never fight for the same pixels.
export function Crossfader({ deckA, deckB, accentA, accentB, crossfade, onCrossfade, locked, smart, enabled = true, canControl = true, shift = false, kbd, onToggleSmart, onToggleEnabled }: CrossfaderProps) {
  const frac = (crossfade + 1) / 2; // 0 = full A (left) … 100 = full B (right)
  const trackRef = useRef<HTMLDivElement>(null);
  // Touch parity for the SMART chip: a long-press = the right-click alt action (enable/disable),
  // so the crossfader-enable toggle is reachable on a touchscreen with no keyboard (mirrors the
  // sampler-pad / I/O-strip pattern). Mouse keeps its real right-click via onContextMenu below.
  const smartLong = useLongPress<void>(() => { if (canControl) onToggleEnabled?.(); });
  // Live crossfade attenuation per side, read each frame without re-running the rAF.
  const gains = useRef({ a: 0, b: 0 });
  const g = crossfadeGainsDb(crossfade);
  gains.current = g;

  // rAF: read both decks' post-fader levels, apply the crossfade attenuation + VU ballistics, and
  // write a 0..1 brightness to --a-lvl / --b-lvl on the track. CSS turns that into the side glow.
  useEffect(() => {
    let raf = 0;
    let pa = -100;
    let pb = -100;
    const norm = (db: number) => Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
    const tick = () => {
      const a = deckA.meterStereo();
      const b = deckB.meterStereo();
      const la = Math.max(a.l, a.r) + gains.current.a;
      const lb = Math.max(b.l, b.r) + gains.current.b;
      pa = la >= pa ? la : pa - DECAY;
      pb = lb >= pb ? lb : pb - DECAY;
      const el = trackRef.current;
      if (el) {
        el.style.setProperty("--a-lvl", norm(pa).toFixed(3));
        el.style.setProperty("--b-lvl", norm(pb).toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deckA, deckB]);

  return (
    <div
      className={`xfader-bar ${locked ? "locked" : ""} ${smart ? "smart-armed" : ""}`}
      style={{ ["--xa" as string]: accentA, ["--xb" as string]: accentB }}
      title={smart ? "Smart Fader armed — throw the fader to auto-transition (tempo morph + bass swap)" : undefined}
    >
      <div className="xbar-track" ref={trackRef}>
        {/* Per-side level glow — opacity tracks --a-lvl / --b-lvl (set by the rAF above). */}
        <span className="xglow xglow-a" />
        <span className="xglow xglow-b" />
        <input
          type="range" className="xbar-input" min={-1} max={1} step={0.01} value={crossfade}
          title="A ↔ B crossfade — double-click / right-click re-centres"
          // The thumb is transparent now (the .xbar-val pill is the visible handle), so the colour
          // vars live on the pill, not here — this input is just the drag hit-area.
          onChange={(e) => onCrossfade(Number(e.target.value))}
          onDoubleClick={() => onCrossfade(0)}
          onContextMenu={(e) => { e.preventDefault(); onCrossfade(0); }}
        />
        {/* A↔B position (0 = full A, 50 = centre, 100 = full B). The pill IS the handle now; --xpct
            snaps its colour to the side it landed on (matches the old thumb). */}
        <div
          className="lfader-val xbar-val"
          style={{
            left: `calc(${frac} * (100% - 38px) + 19px)`,
            ["--xpct" as string]: crossfade > 0 ? "100%" : "0%",
          }}
        >
          <span>{Math.round(frac * 100)}</span>
        </div>
      </div>
      {/* SMART chip — the on-screen home for the two toggles that were keyboard/FLX-only (so they're
          reachable on touch). TAP = arm/disarm Smart Fader (mirrors `T`); HOLD / RIGHT-CLICK /
          SHIFT-TAP = enable/disable the whole crossfader (mirrors `Shift+T`). With board shift held
          or latched the chip FLIPS to its alt action (label + click), exactly like every other
          shifted button; hold + right-click stay as the no-keyboard touch/mouse path. */}
      <button
        type="button"
        className={`xbar-smart ${smart ? "armed" : ""} ${enabled ? "" : "off"} ${shift ? "shifted" : ""}`}
        disabled={!canControl}
        title={
          shift
            ? enabled
              ? "Disable the crossfader (shifted)"
              : "Enable the crossfader (shifted)"
            : enabled === false
              ? "Crossfader OFF — shift-tap / hold / right-click to re-enable"
              : smart
                ? "Smart Fader armed — throw the fader to auto-transition · tap to disarm · shift-tap / hold to disable the crossfader"
                : "Tap: arm Smart Fader (auto-transition) · Shift-tap / hold / right-click: disable the crossfader"
        }
        onClick={() => {
          if (smartLong.fired.current) { smartLong.fired.current = false; return; } // swallow the tap a long-press already handled
          if (!canControl) return;
          if (shift) onToggleEnabled?.(); // board shift → fire the alt action, same as Shift+T
          else onToggleSmart?.();
        }}
        onContextMenu={(e) => { e.preventDefault(); if (canControl) onToggleEnabled?.(); }}
        {...smartLong.bind(undefined)}
      >
        <span className="xbar-smart-lbl">{shift ? (enabled ? "DISABLE" : "ENABLE") : "SMART"}</span>
        {kbd && <span className="kbd" aria-hidden="true">{kbd}</span>}
      </button>
    </div>
  );
}
