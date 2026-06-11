import { useEffect, useRef } from "react";
import type { Deck } from "@htl/audio";

interface StereoMeterProps {
  deck: Deck;
  dir?: "up" | "down"; // fills grow from the bottom (up) or the top (down)
  accent?: string;
  className?: string;
  gainDb?: number; // added to the raw level — e.g. the crossfade attenuation, so the
  // meter shows the deck's ACTUAL contribution to the mix, not its raw channel level
}

// dBFS window the meter spans: −60 (floor) … 0 (full scale).
const FLOOR_DB = -60;
const DECAY_DB = 1.1; // per-frame fall when the signal drops (instant attack)

// A stereo (L/R) level meter: two sub-bars driven by its own rAF off the deck's
// post-fader analysers. Ballistics (fast attack / slow decay) live here, per
// instance, so several meters can read the same deck a frame without fighting
// over shared smoothed state. Writes straight to the DOM (no React state).
export function StereoMeter({ deck, dir = "up", accent, className, gainDb = 0 }: StereoMeterProps) {
  const lf = useRef<HTMLSpanElement>(null);
  const rf = useRef<HTMLSpanElement>(null);
  // Read the (live) attenuation each frame without re-running the rAF effect.
  const gain = useRef(gainDb);
  gain.current = gainDb;

  useEffect(() => {
    let raf = 0;
    let pl = -100;
    let pr = -100;
    const apply = (el: HTMLSpanElement | null, db: number) => {
      if (!el) return;
      const norm = Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
      el.style.height = `${norm * 100}%`;
      el.classList.toggle("hot", db > -3);
    };
    const tick = () => {
      const { l, r } = deck.meterStereo();
      const g = gain.current;
      const lv = l + g;
      const rv = r + g;
      pl = lv >= pl ? lv : pl - DECAY_DB;
      pr = rv >= pr ? rv : pr - DECAY_DB;
      apply(lf.current, pl);
      apply(rf.current, pr);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deck]);

  return (
    <span className={`smeter ${dir} ${className ?? ""}`} style={accent ? { ["--accent" as string]: accent } : undefined}>
      <span className="smeter-bar"><span ref={lf} className="smeter-fill" /></span>
      <span className="smeter-bar"><span ref={rf} className="smeter-fill" /></span>
    </span>
  );
}
