import { useEffect, useRef } from "react";
import type { Deck } from "@htl/audio";

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
  // ★ TWO KINDS OF "OFF", AND THEY MUST NOT SHARE A CLASS. `locked` is the SESSION lock — someone
  // else has the board, so the bar is inert at the CSS level (pointer-events: none). `enabled` is
  // the DJ's own switch, and the way back from it lives ON the bar (right-click / long-press), so a
  // disabled fader has to stay interactive. Folding the two together is how you build a switch that
  // can be turned off and never on: the SMART chip used to be the escape hatch, and it is gone.
  locked?: boolean; // the crossfader is a whole-board move → blocked for non-full-controllers
  smart?: boolean; // Smart Fader armed → the throw scrubs an auto-transition (tempo morph + bass swap)
  enabled?: boolean; // is the crossfader live at all? (disabled = thrown positions are ignored)
  canControl?: boolean; // may this user toggle either of the above? (false = non-controller in a session)
  onToggleSmart?: () => void; // TAP THE HANDLE — fader ↔ smart (mirrors the `T` key)
  onToggleEnabled?: () => void; // right-click / long-press the bar — enable/disable (mirrors `Shift+T`)
  kbd?: string; // keybind hint for the smart toggle (drawn on the bar under body.show-keys)
}

const FLOOR_DB = -60; // dBFS floor for the glow brightness
const DECAY = 1.1; // per-frame fall (instant attack, slow decay — VU ballistics)

// The A↔B crossfader as a HORIZONTAL bar. The strip is always an A↔B blend gradient; instead of a
// discrete level meter, each side's GLOW brightens with that deck's post-crossfade output (louder =
// brighter), so position (handle), blend (gradient) and level (glow) never fight for the same pixels.
export function Crossfader({ deckA, deckB, accentA, accentB, crossfade, onCrossfade, locked, smart, enabled = true, canControl = true, onToggleSmart, onToggleEnabled, kbd }: CrossfaderProps) {
  const frac = (crossfade + 1) / 2; // 0 = full A (left) … 100 = full B (right)
  const trackRef = useRef<HTMLDivElement>(null);
  // ★ THE MODE LIVES ON THE FADER. Smart Fader used to be a chip in the I/O strip that meant three
  // unrelated things at once — drag it for MASTER VOLUME, tap it to arm smart, hold it to disable
  // the crossfader — two of which were about this bar and only sat over there because that was the
  // middle of the board. The smart fader is a property of the fader, so it is a property of the
  // fader: TAP THE HANDLE to switch fader ↔ smart, right-click / long-press the bar to disable it.
  //
  // The tap rides the range input rather than the pill (the pill is `pointer-events: none` so the
  // native thumb keeps every drag). A press that neither MOVED nor CHANGED THE VALUE landed on the
  // handle and stayed there — which a throw never does, so a fast mix can never trip the toggle.
  const press = useRef<{ x: number; v: number } | null>(null);
  const hold = useRef<number | undefined>(undefined);
  const heldRef = useRef(false); // the long-press fired → swallow the tap that follows it
  const toggleEnabled = () => { if (canControl) onToggleEnabled?.(); };
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
      className={`xfader-bar ${locked ? "locked" : ""} ${smart ? "smart-armed" : ""} ${enabled ? "" : "xfader-off"}`}
      style={{ ["--xa" as string]: accentA, ["--xb" as string]: accentB }}
      title={smart ? "Smart Fader armed — throw the fader to auto-transition (tempo morph + bass swap)" : undefined}
    >
      {/* ★ ONLY THE STATE YOU CANNOT SEE. Smart-armed is unmistakable — the whole track becomes a
          breathing A↔B gradient — so a pill spelling "SMART" next to it is a caption on a picture
          that already said it. Disabled is NOT: it is a 45% opacity change, which reads as "dim"
          rather than "off" and is easily confused with the session lock. So that one keeps its
          label, and the resting board still says nothing. */}
      {!enabled && (
        <span className="xbar-mode off" aria-live="polite">
          FADER OFF
          {kbd && <i className="xbar-kbd">{kbd}</i>}
        </span>
      )}
      <div className="xbar-track" ref={trackRef}>
        {/* Per-side level glow — opacity tracks --a-lvl / --b-lvl (set by the rAF above). */}
        <span className="xglow xglow-a" />
        <span className="xglow xglow-b" />
        <input
          type="range" className="xbar-input" min={-1} max={1} step={0.01} value={crossfade}
          title={`A ↔ B crossfade — double-click re-centres · tap the handle for ${smart ? "FADER" : "SMART"} · right-click / hold to ${enabled ? "disable" : "enable"} the fader`}
          // The thumb is transparent now (the .xbar-val pill is the visible handle), so the colour
          // vars live on the pill, not here — this input is just the drag hit-area.
          onChange={(e) => { if (enabled) onCrossfade(Number(e.target.value)); }}
          onDoubleClick={() => { if (enabled) onCrossfade(0); }}
          // ★ PRIMARY BUTTON ONLY. A right-click fires pointerdown/pointerup too, so without this
          // the same gesture toggled the mode AND enable/disable — a right-click that did both.
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            heldRef.current = false;
            press.current = { x: e.clientX, v: crossfade };
            if (e.pointerType === "touch") {
              clearTimeout(hold.current);
              hold.current = window.setTimeout(() => { heldRef.current = true; navigator.vibrate?.(8); toggleEnabled(); }, 480);
            }
          }}
          onPointerUp={(e) => {
            if (e.button !== 0) { press.current = null; return; }
            clearTimeout(hold.current);
            const p = press.current;
            press.current = null;
            if (!p || heldRef.current || !canControl) return;
            // Landed on the handle and never left it: no drag, no value change. Anywhere else on
            // the track the click JUMPS the fader, which is a value change, so this cannot fire.
            if (Math.abs(e.clientX - p.x) < 4 && crossfade === p.v) onToggleSmart?.();
          }}
          onPointerCancel={() => { clearTimeout(hold.current); press.current = null; }}
          // Re-centre lives on the double-click (it always has); the right-click is worth more as
          // the enable/disable, which otherwise has no home now the SMART chip is gone.
          onContextMenu={(e) => { e.preventDefault(); toggleEnabled(); }}
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
    </div>
  );
}
