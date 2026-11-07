// Settings ▸ Interface: a live sample of the waveform in the colours being edited.
//
// Operator, 2026-11-03: "live waveform preview would be nice". The colour cards are a list of
// swatches, and a swatch says nothing about how three band colours MIX, how vivid they come out,
// or whether the grid still reads against the background. So this draws a short synthetic bar of
// music (kick, snare, hats over a mid bed) with the SAME colour maths the deck lane uses:
// bandRamp for "Deck colour", tiltLuma for "Frequency", the layered lobes or the flat tint, the
// vividness pull, deckShades for stem lanes that follow the deck, and surfaceColor for the
// background. It is not the real renderer (no audio, no pyramid), so it shows colour, not detail.
//
// It reads Deck A's own colour. With "From cover art" on, the board's deck colour comes from the
// artwork instead, which a settings page cannot know, so the preview shows the no-art colour that
// the Decks card labels as such.
import { useEffect, useRef } from "react";
import { surfaceColor, FREQ_LOW_DEFAULT, FREQ_MID_DEFAULT, FREQ_HIGH_DEFAULT, type Settings } from "@htl";
import { bandRamp, hexRGB, tiltLuma } from "@htl/analysis";
import { deckShades } from "../../htl/state/randomPalette";
import { shape, BAND_TILT } from "../WaveformViewport";

type RGB = [number, number, number];

const STEM_DEFAULTS = { drums: "#ff5d73", bass: "#b06bff", vocals: "#5dff9e", other: "#36c2ff" } as const;
const BEATS = 8; // two bars
const LOOP = [4, 6] as const; // a two-beat loop in the second bar
const PLAYHEAD = 0.36; // as a fraction of the width

/** Deterministic 0..1 noise, so the preview never shimmers between renders. */
function noise(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Three band energies at a position in beats: kick on every beat, snare on 2 and 4, hats on the
 *  eighths, over a slowly moving mid bed. Shapes, not a recording. */
export function sampleBands(beat: number, i: number): { low: number; mid: number; high: number } {
  const f = beat - Math.floor(beat);
  const b = Math.floor(beat) % 4;
  const kick = Math.exp(-f * 7);
  const snare = b === 1 || b === 3 ? Math.exp(-f * 9) : 0;
  const hf = (beat * 2) % 1;
  const hat = Math.exp(-hf * 16);
  const bed = 0.3 + 0.12 * Math.sin(beat * 1.3) + 0.05 * noise(i);
  return {
    low: 0.12 + 0.85 * kick,
    mid: bed + 0.55 * snare,
    high: 0.12 + 0.45 * hat + 0.25 * snare + 0.08 * noise(i + 7),
  };
}

function vivid([r, g, b]: RGB, viv: number): RGB {
  if (viv === 1) return [r, g, b];
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  return [gray + (r - gray) * viv, gray + (g - gray) * viv, gray + (b - gray) * viv];
}
const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const css = ([r, g, b]: RGB, a = 1) => `rgba(${cl(r)},${cl(g)},${cl(b)},${a})`;

function draw(canvas: HTMLCanvasElement, s: Settings) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW < 4 || cssH < 4) return;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const accent = s.accentA || "#00e5ff";
  ctx.fillStyle = surfaceColor(s.bgColor, s.uiContrast);
  ctx.fillRect(0, 0, w, h);

  // Layout: the plain wave on top, the four stem lanes in a strip beneath it.
  const laneGap = 2 * dpr;
  const stripH = Math.round(h * 0.34);
  const waveH = h - stripH - laneGap * 2;
  const mid = waveH / 2;
  const amp = mid - 2 * dpr;
  const beatAt = (x: number) => (x / w) * BEATS;

  // ---- loop region (behind the wave, as on the deck) ----
  const lx0 = (LOOP[0] / BEATS) * w;
  const lx1 = (LOOP[1] / BEATS) * w;
  const loopRgb = hexRGB(s.loopColor || "#6ee7a8");
  ctx.fillStyle = css(loopRgb, 0.16);
  ctx.fillRect(lx0, 0, lx1 - lx0, h);

  // ---- the plain wave, coloured the way the board colours it ----
  const mode = !s.freqColors ? "flat" : s.bandFromDeck ? "deck" : "freq";
  const raw: [RGB, RGB, RGB] =
    mode === "deck"
      ? bandRamp(accent)
      : [hexRGB(s.freqLowColor || FREQ_LOW_DEFAULT), hexRGB(s.freqMidColor || FREQ_MID_DEFAULT), hexRGB(s.freqHighColor || FREQ_HIGH_DEFAULT)];
  const cols = (mode === "deck" ? raw : tiltLuma(raw)).map((c) => vivid(c, s.freqVividness)) as [RGB, RGB, RGB];
  const flatCol = hexRGB(s.stripColor || accent);
  const wt = [1, 1, 1].map((v) => Math.pow(v, BAND_TILT));

  for (let x = 0; x < w; x++) {
    const { low, mid: m, high } = sampleBands(beatAt(x), x);
    const level = shape(Math.min(1, 0.22 * low + 0.2 * m + 0.12 * high + 0.08));
    const a = level * amp;
    if (mode === "flat") {
      ctx.fillStyle = css(flatCol, 0.9);
      ctx.fillRect(x, mid - a, 1, a * 2);
      continue;
    }
    const l = low * wt[0], mm = m * wt[1], hh = high * wt[2];
    const sum = l + mm + hh + 1e-4;
    if (s.bandLayers) {
      // layered lobes: high innermost, low outermost, tiling the amplitude exactly
      const pk = hh / sum;
      const cum = (hh + mm) / sum;
      const spans: Array<[number, number, RGB]> = [
        [0, pk, cols[2]],
        [pk, cum, cols[1]],
        [cum, 1, cols[0]],
      ];
      for (const [i0, i1, c] of spans) {
        const y0 = a * i0;
        const y1 = a * i1;
        if (y1 - y0 < 0.1) continue;
        ctx.fillStyle = css(c);
        ctx.fillRect(x, mid - y1, 1, y1 - y0);
        ctx.fillRect(x, mid + y0, 1, y1 - y0);
      }
    } else {
      const c: RGB = [
        (l * cols[0][0] + mm * cols[1][0] + hh * cols[2][0]) / sum,
        (l * cols[0][1] + mm * cols[1][1] + hh * cols[2][1]) / sum,
        (l * cols[0][2] + mm * cols[1][2] + hh * cols[2][2]) / sum,
      ];
      ctx.fillStyle = css(c, 0.96);
      ctx.fillRect(x, mid - a, 1, a * 2);
    }
  }

  // ---- stem lanes ----
  const lanes = ["drums", "bass", "vocals", "other"] as const;
  const shades = s.stemsFollowDeck ? deckShades(accent, lanes.length) : null;
  const laneColor: Record<(typeof lanes)[number], string> = {
    drums: s.stemDrumsColor,
    bass: s.stemBassColor,
    vocals: s.stemVocalsColor,
    other: s.stemOtherColor,
  };
  const top = waveH + laneGap * 2;
  const laneH = stripH / lanes.length;
  lanes.forEach((name, li) => {
    const c = hexRGB(shades ? shades[li] : laneColor[name] || STEM_DEFAULTS[name]);
    const cy = top + laneH * li + laneH / 2;
    const la = laneH / 2 - 1 * dpr;
    ctx.fillStyle = css(c, 0.92);
    for (let x = 0; x < w; x++) {
      const { low, mid: m, high } = sampleBands(beatAt(x), x);
      const v = name === "drums" ? 0.55 * low + 0.45 * high : name === "bass" ? 0.4 + 0.5 * low : name === "vocals" ? 0.6 * m + 0.15 * Math.sin(x / (w / 9)) : 0.7 * m;
      const a = Math.max(0.5, shape(Math.min(1, v * 0.6)) * la);
      ctx.fillRect(x, cy - a, 1, a * 2);
    }
  });

  // ---- beat grid (bar lines heavier), loop edges, playhead ----
  const grid = hexRGB(s.markerColor || "#ffffff");
  for (let b = 0; b <= BEATS; b++) {
    const x = Math.min(w - dpr, Math.round((b / BEATS) * w));
    const bar = b % 4 === 0;
    ctx.fillStyle = css(grid, bar ? 0.75 : 0.35);
    ctx.fillRect(x, 0, (bar ? 2 : 1) * dpr, waveH);
  }
  ctx.fillStyle = css(loopRgb, 0.9);
  ctx.fillRect(lx0, 0, 2 * dpr, h);
  ctx.fillRect(lx1 - 2 * dpr, 0, 2 * dpr, h);
  ctx.fillStyle = s.selectorColor || "#ffffff";
  ctx.fillRect(Math.round(PLAYHEAD * w), 0, 2 * dpr, h);
}

export function WaveformPreview({ settings }: { settings: Settings }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef(settings);
  latest.current = settings;

  useEffect(() => {
    if (ref.current) draw(ref.current, settings);
  }, [settings]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => draw(el, latest.current));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="wave-preview">
      <canvas ref={ref} className="wave-preview-canvas" role="img" aria-label="Preview of the waveform in the current colours" />
    </div>
  );
}
