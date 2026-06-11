// User customization, persisted via the @htl Store and applied as CSS variables
// / body classes so the whole UI re-themes without prop drilling.
import { Store, migrateLegacyKey } from "../persistence";
import type { KeyBindings } from "./keybinds";

export interface Settings {
  accentA: string; // deck A neon
  accentB: string; // deck B neon
  bgColor: string; // app base background
  textColor: string; // primary text colour
  borderColor: string; // panel / control border lines
  selectorColor: string; // waveform playhead / cursor
  loopColor: string; // waveform loop region + loop markers
  markerColor: string; // waveform beat grid markers
  stripColor: string; // waveform strip (body); "" = follow the deck accent
  glow: boolean; // neon glow on/off
  tempoRange: number; // tempo fader half-range (±%)
  pitchRange: number; // KEY knob half-range (± semitones)
  jumpBeats: number; // beat-jump / loop-move "skip" resolution, in beats
  jogWeight: number; // platter inertia, 0 = featherweight/snappy … 1 = heavy flywheel
  jogDrag: number; // coast friction, 0 = long frictionless glide … 1 = quick brake
  stemModel: string; // stem-separation backend id (see @htl/stems STEM_MODELS); "dsp" = instant split
  streamSource: string; // playback source id (see @htl/media STREAM_SOURCES) — credential tier + catalog
  keyHints: boolean; // show the per-button keyboard-shortcut letters (desktop only)
  keyBindings: KeyBindings; // user-remapped keyboard shortcuts (id → primary/secondary code); {} = defaults
}

export const DEFAULT_BG = "#050507";
export const DEFAULT_TEXT = "#ecedfb";
export const DEFAULT_BORDER = "#1a1a28";

export const DEFAULT_SETTINGS: Settings = {
  accentA: "#00e5ff",
  accentB: "#ff2d9c",
  bgColor: DEFAULT_BG,
  textColor: DEFAULT_TEXT,
  borderColor: DEFAULT_BORDER,
  selectorColor: "#ffffff",
  loopColor: "#6ee7a8",
  markerColor: "#ffd64a",
  stripColor: "", // empty = use the deck's own accent for the waveform
  glow: true,
  tempoRange: 8,
  pitchRange: 12,
  jumpBeats: 4,
  jogWeight: 0.4,
  jogDrag: 0.4,
  stemModel: "dsp", // always DSP until the user explicitly picks a neural engine (every platform)
  streamSource: "yt-anonymous", // == DEFAULT_SOURCE in @htl/media; hardcoded to keep settings dep-free
  keyHints: true, // per-button key letters on by default (CSS hides them on mobile)
  keyBindings: {}, // empty → every action uses its default key (see @htl keybinds)
};

// Dark base-colour presets for the background picker (varied dark hues).
export const BG_PRESETS = ["#050507", "#0a0a12", "#0d0a16", "#0a1014", "#120a0e", "#0b0f0b", "#101010", "#000000"];
// Light, readable text presets.
export const TEXT_PRESETS = ["#ecedfb", "#ffffff", "#cdd3ff", "#ffe9c2", "#bfffe0", "#ffd0ec", "#d8d8d8", "#9fb0ff"];
// Border / line presets, subtle → neon.
export const BORDER_PRESETS = ["#1a1a28", "#2a2a3d", "#0c0c14", "#39314f", "#2a3d3a", "#4d3a2a", "#00e5ff", "#ff2d9c"];

export const TEMPO_RANGES = [6, 8, 10, 16, 50];

// KEY knob half-ranges (± semitones). 12 = a full octave each way.
export const PITCH_RANGES = [1, 2, 4, 7, 12];

// Beat-jump resolution choices (beats). 4 = one bar.
export const JUMP_RESOLUTIONS = [1, 2, 4, 8, 16];
export function jumpLabel(beats: number): string {
  return beats >= 4 && beats % 4 === 0 ? `${beats / 4} bar${beats > 4 ? "s" : ""}` : `${beats} beat${beats > 1 ? "s" : ""}`;
}

// Per-deck skip / beat-jump ladder, sub-beat → 8 bars (in beats). Driven by the
// jog ◀◀ ▶▶ (and their SHIFT loop-move), selected on the ⌗ button in SHIFT.
export const SKIP_SIZES = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32];
export const DEFAULT_SKIP = 4; // one bar

export function nextSkip(beats: number): number {
  const i = SKIP_SIZES.indexOf(beats);
  return SKIP_SIZES[(i + 1) % SKIP_SIZES.length] ?? DEFAULT_SKIP;
}
// Step the grid/skip size by `delta` rungs along the ladder, clamped (no wrap) —
// used by the deck header's − / + grid buttons.
export function stepSkip(beats: number, delta: number): number {
  const i = SKIP_SIZES.indexOf(beats);
  const base = i < 0 ? SKIP_SIZES.indexOf(DEFAULT_SKIP) : i;
  return SKIP_SIZES[Math.max(0, Math.min(SKIP_SIZES.length - 1, base + delta))];
}
// Full grid label for the header indicator: "1/16" … "2 beats" … "1 bar".
export function gridLabel(beats: number): string {
  if (beats < 1) return `1/${Math.round(1 / beats)}`;
  if (beats < 4) return `${beats} beat${beats > 1 ? "s" : ""}`;
  const bars = beats / 4;
  return `${bars} bar${bars > 1 ? "s" : ""}`;
}
// Compact button label: sub-beat as "1/16", whole beats bare, bars as "1B".
export function skipLabel(beats: number): string {
  if (beats < 1) return `1/${Math.round(1 / beats)}`;
  if (beats < 4) return String(beats);
  return `${beats / 4}B`;
}
// Full tooltip label.
export function skipTitle(beats: number): string {
  if (beats < 1) return `Skip 1/${Math.round(1 / beats)} beat`;
  if (beats < 4) return `Skip ${beats} beat${beats > 1 ? "s" : ""}`;
  const bars = beats / 4;
  return `Skip ${bars} bar${bars > 1 ? "s" : ""}`;
}

export const ACCENT_PRESETS = [
  "#00e5ff", // cyan
  "#ff2d9c", // magenta
  "#5dff9e", // lime
  "#ffe24a", // yellow
  "#b06bff", // purple
  "#ff6b3c", // orange
  "#36c2ff", // sky
  "#ff5d73", // coral
];

const store = new Store<Settings>("settings", DEFAULT_SETTINGS, 1);
migrateLegacyKey("htl.settings", store); // pre-versioned key

export function loadSettings(): Settings {
  return store.get();
}

export function saveSettings(s: Settings) {
  store.set(s);
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [5, 5, 7];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// Shift each channel of a hex colour (used to derive the panel/line shades from
// the chosen background, keeping the subtle blue tint of the default theme).
function shift(hex: string, dr: number, dg: number, db: number): string {
  const [r, g, b] = hexToRgb(hex);
  const h2 = (x: number) => clampByte(x).toString(16).padStart(2, "0");
  return `#${h2(r + dr)}${h2(g + dg)}${h2(b + db)}`;
}
// The darkest UI surface (lanes/buttons) derived from the chosen base — the same
// value applySettings writes to --surface. Exported so the waveform canvas can
// take it as a prop instead of reading getComputedStyle (which is one commit
// stale, since applySettings runs in a parent effect after the canvas's effects).
export function surfaceColor(bg: string): string {
  return shift(bg || DEFAULT_BG, 3, 3, 6);
}
// Linear blend of two hex colours; t = 0 → a, 1 → b.
function blend(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const h2 = (x: number) => clampByte(x).toString(16).padStart(2, "0");
  return `#${h2(r1 + (r2 - r1) * t)}${h2(g1 + (g2 - g1) * t)}${h2(b1 + (b2 - b1) * t)}`;
}

// WCAG relative-luminance contrast ratio between two hex colours (1 … 21). Used
// to warn when a chosen text / accent / border colour is unreadable on the base.
function relLum(hex: string): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function contrastRatio(a: string, b: string): number {
  const l1 = relLum(a);
  const l2 = relLum(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// Readability check against the current theme. Returns human-readable warnings
// for any colour pair whose contrast is too low to use comfortably.
export function contrastWarnings(s: Settings): string[] {
  const bg = s.bgColor || DEFAULT_BG;
  const w: string[] = [];
  if (contrastRatio(s.textColor, bg) < 4.5) w.push("Text is hard to read on this background.");
  if (contrastRatio(s.borderColor, bg) < 1.12) w.push("Borders are nearly invisible on this background.");
  return w;
}

export function applySettings(s: Settings) {
  const root = document.documentElement;
  root.style.setProperty("--neon-cyan", s.accentA);
  root.style.setProperty("--neon-pink", s.accentB);
  // Re-theme the dark surfaces off the chosen base so the whole UI follows the
  // background colour (the panels otherwise cover the body, hiding plain --bg).
  const bg = s.bgColor || DEFAULT_BG;
  root.style.setProperty("--bg", bg);
  root.style.setProperty("--surface", surfaceColor(bg)); // darkest UI surfaces (buttons, lanes)
  root.style.setProperty("--panel", shift(bg, 6, 6, 10));
  root.style.setProperty("--panel-2", shift(bg, 11, 11, 18));
  // Text + border are user-controlled; muted is text faded halfway toward the bg.
  const text = s.textColor || DEFAULT_TEXT;
  root.style.setProperty("--text", text);
  root.style.setProperty("--muted", blend(text, bg, 0.55));
  root.style.setProperty("--line", s.borderColor || DEFAULT_BORDER);
  // Waveform viewport colours (read by the canvas). Strip is optional — left
  // unset it falls back to each deck's accent so the two waveforms stay distinct.
  root.style.setProperty("--wv-selector", s.selectorColor || "#ffffff");
  root.style.setProperty("--wv-loop", s.loopColor || "#6ee7a8");
  root.style.setProperty("--wv-marker", s.markerColor || "#ffd64a");
  if (s.stripColor) root.style.setProperty("--wv-strip", s.stripColor);
  else root.style.removeProperty("--wv-strip");
  document.body.classList.toggle("no-glow", !s.glow);
  document.body.classList.toggle("show-keys", s.keyHints);
}
