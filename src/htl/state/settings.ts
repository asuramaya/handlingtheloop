// User customization, persisted via the @htl Store and applied as CSS variables
// / body classes so the whole UI re-themes without prop drilling.
import { Store, migrateLegacyKey } from "../persistence";
import type { KeyBindings } from "./keybinds";
import type { MidiLearnMap, MidiMap } from "../midi/types";
import type { ColorProfile } from "./colorProfiles";
import type { KeyProfile } from "./keyProfiles";

export interface Settings {
  accentA: string; // deck A neon
  accentB: string; // deck B neon
  bgColor: string; // app base background
  textColor: string; // primary text colour
  borderColor: string; // panel / control border lines
  selectorColor: string; // waveform playhead / cursor
  loopColor: string; // waveform loop region + loop markers
  markerColor: string; // waveform beat grid markers
  shiftColor: string; // SHIFT-mode / alt-action highlight ("Accents"); "" = default amber
  stripColor: string; // waveform strip (body); "" = follow the deck accent
  stemDrumsColor: string; // per-stem waveform colours; "" each = built-in default
  stemBassColor: string;
  stemVocalsColor: string;
  stemOtherColor: string;
  freqLowColor: string; // frequency-colour band hues (when freqColors is on); "" each = built-in default
  freqMidColor: string;
  freqHighColor: string;
  glow: boolean; // neon glow on/off
  tempoRange: number; // tempo fader half-range (±%)
  pitchRange: number; // KEY knob half-range (± semitones)
  jumpBeats: number; // beat-jump / loop-move "skip" resolution, in beats
  jogWeight: number; // platter inertia, 0 = featherweight/snappy … 1 = heavy flywheel
  jogDrag: number; // coast friction, 0 = long frictionless glide … 1 = quick brake
  stemModel: string; // stem-separation backend id (see @htl/stems STEM_MODELS); "off" = Single (plain mix, no stems)
  streamSource: string; // playback source id (see @htl/media STREAM_SOURCES) — credential tier + catalog
  keyHints: boolean; // show the per-button keyboard-shortcut letters (desktop only)
  keyBindings: KeyBindings; // the LIVE working keymap overlay (id → primary/secondary code); {} = defaults
  keyProfiles: KeyProfile[]; // saved, shareable keyboard profiles (synced to account, same as midiMaps)
  activeKeyProfileId: string | null; // which saved profile keyBindings was loaded from (null = ad-hoc / default)
  midiEnabled: boolean; // enable USB-MIDI controller support (Web MIDI; desktop Chromium only)
  midiBindings: MidiLearnMap; // the LIVE working overlay layered over the matched profile; {} = profile only
  midiMaps: MidiMap[]; // saved, shareable named maps (synced to account); load one → copies into midiBindings
  activeMidiMapId: string | null; // which saved map midiBindings was loaded from (null = ad-hoc / built-in only)
  colorProfiles: ColorProfile[]; // saved, shareable colour themes (synced to account, same as midiMaps)
  activeColorProfileId: string | null; // which saved profile is loaded (null = ad-hoc / built-in)
  stretchEngine: StretchEngine; // time-stretch algorithm: time-domain WSOLA or phase-locked vocoder
  stretchQuality: StretchQuality; // tempo/pitch engine quality preset (grain/FFT size)
  stretchTransient: boolean; // copy/sharpen attacks (WSOLA 1:1 copy / PV phase reset) — see stretchWorklet
  stretchAa: boolean; // WSOLA: anti-aliased windowed-sinc resampling when pitching up
  stretchTThresh: number; // WSOLA transient-detector threshold (flux/EMA ratio); lower = more sensitive
  stemQuality: StemQuality; // demucs-GPU separation quality (shift-TTA + overlap), desktop only
  audioOutputId: string; // chosen audio output device (AudioContext.setSinkId); "" = system default
  autoEnhance: boolean; // desktop: silently swap in a cached neural set over the DSP split when one exists
  freqColors: boolean; // collapsed (non-stem) waveform: rekordbox-style low/mid/high frequency colouring
  freqVividness: number; // band-colour saturation: 0 = grey, 1 = as-picked, up to 2 = neon-boosted
  uiContrast: number; // UI "ink" depth: 0 = soft/grey panel fills, 1 = inky (deep fills + brighter text)
  inheritRoomColor: boolean; // contextual: while in a shared session, take on the HOST's accent (the room "vibe")
  lyricsAuto: boolean; // transcribe lyrics from the neural vocal stem (Whisper, desktop GPU); pooled + shared
  lyricsModel: string; // lyrics engine: whisper model id "base" | "small" (WHISPER_MODELS), or "youtube" for YouTube captions
}

// Time-stretch algorithm. WSOLA = time-domain overlap-add (crisp transients, but
// metallic on dense polyphony — aligns one grain). PV = phase-LOCKED phase vocoder
// (Laroche-Dolson identity locking) — clean on full mixes, the pro fix, more CPU.
export type StretchEngine = "wsola" | "pv";
// The unified time-stretch engine's quality/latency trade-off (see stretchWorklet).
export type StretchQuality = "fast" | "balanced" | "hifi";
export interface StretchConfig {
  frame: number; // WSOLA grain length (samples) — also ≈ added latency
  search: number; // ± cross-correlation search radius (samples)
  stride: number; // correlation stride (1 = finest/most CPU)
}
export const STRETCH_PRESETS: Record<StretchQuality, StretchConfig & { label: string; latencyMs: number; blurb: string }> = {
  fast: { frame: 512, search: 120, stride: 4, label: "Fast", latencyMs: 11, blurb: "Lightest CPU + lowest latency. Slightly softer on large key shifts." },
  balanced: { frame: 1024, search: 200, stride: 2, label: "Balanced", latencyMs: 21, blurb: "Recommended. Crisp transients with low latency — ideal for beatmatching." },
  hifi: { frame: 2048, search: 300, stride: 1, label: "Hi-Fi", latencyMs: 43, blurb: "Cleanest tone on sustained material; more CPU + latency." },
};
export function stretchConfig(q: StretchQuality): StretchConfig {
  const p = STRETCH_PRESETS[q] ?? STRETCH_PRESETS.balanced;
  return { frame: p.frame, search: p.search, stride: p.stride };
}

// Desktop demucs-GPU separation quality. Pure GPU-time-for-quality knobs (no model
// change): `overlap` averages more segment passes per sample (smoother seams);
// `shifts` is demucs' random-shift test-time augmentation — the biggest artifact
// reducer, at ≈shifts× the compute. Mobile never separates, so this is desktop-only.
// `mult` is the rough compute multiplier vs the old single pass (shown in the picker).
export type StemQuality = "fast" | "balanced" | "hifi";
export interface StemConfig {
  shifts: number;
  overlap: number;
}
export const STEM_PRESETS: Record<StemQuality, StemConfig & { label: string; mult: string; blurb: string }> = {
  fast: { shifts: 0, overlap: 0.25, label: "Fast", mult: "1×", blurb: "Single pass at 25% overlap. Fastest separation — the original path." },
  balanced: { shifts: 1, overlap: 0.5, label: "Balanced", mult: "~2.7×", blurb: "Recommended. One shift pass + 50% overlap — cleaner seams and fewer artifacts." },
  hifi: { shifts: 2, overlap: 0.5, label: "Hi-Fi", mult: "~5×", blurb: "Two shift passes + 50% overlap — the cleanest stems this model gives, but slow." },
};
export function stemConfig(q: StemQuality): StemConfig {
  const p = STEM_PRESETS[q] ?? STEM_PRESETS.balanced;
  return { shifts: p.shifts, overlap: p.overlap };
}

// Default frequency-colour band hues (rekordbox-style) — shared by the waveform renderer
// (the "" fallback) and the Settings pickers (the swatch shown for an unset value).
export const FREQ_LOW_DEFAULT = "#2a74ff"; // blue (bass)
export const FREQ_MID_DEFAULT = "#ff9c30"; // amber (mid)
export const FREQ_HIGH_DEFAULT = "#e4f0ff"; // near-white (high)

// One-tap waveform frequency palettes (low/mid/high). The first IS the default trio.
export interface BandPalette {
  name: string;
  low: string;
  mid: string;
  high: string;
}
export const BAND_PALETTES: BandPalette[] = [
  { name: "Rekordbox", low: FREQ_LOW_DEFAULT, mid: FREQ_MID_DEFAULT, high: FREQ_HIGH_DEFAULT },
  { name: "Serato", low: "#1f6feb", mid: "#2ec27e", high: "#ff5d73" },
  { name: "Sunset", low: "#6a2c9c", mid: "#ff6b35", high: "#ffd23f" },
  { name: "Ice", low: "#0066ff", mid: "#00d4ff", high: "#eaffff" },
  { name: "Heat", low: "#3a2bff", mid: "#ff2d6b", high: "#ffe24a" },
  { name: "Vapor", low: "#ff5dd2", mid: "#7b5cff", high: "#9bf6ff" },
  { name: "Mono", low: "#5a5a5a", mid: "#9a9a9a", high: "#ffffff" },
];

export const DEFAULT_BG = "#050507";
export const DEFAULT_TEXT = "#ecedfb";
export const DEFAULT_BORDER = "#1a1a28";
// UI contrast / "ink" depth (0 = soft grey fills, 1 = deepest ink). Declared up here
// so DEFAULT_SETTINGS can reference it (module eval order).
export const DEFAULT_CONTRAST = 0.7;

export const DEFAULT_SETTINGS: Settings = {
  accentA: "#00e5ff",
  accentB: "#ff2d9c",
  bgColor: DEFAULT_BG,
  textColor: DEFAULT_TEXT,
  borderColor: DEFAULT_BORDER,
  selectorColor: "#ffffff",
  loopColor: "#6ee7a8",
  markerColor: "#ffd64a",
  shiftColor: "#ffd250", // SHIFT highlight ("Accents")
  stripColor: "", // empty = use the deck's own accent for the waveform
  stemDrumsColor: "", // empty each = the built-in per-stem colour
  stemBassColor: "",
  stemVocalsColor: "",
  stemOtherColor: "",
  freqLowColor: "", // empty each = the built-in band colour (blue / amber / white)
  freqMidColor: "",
  freqHighColor: "",
  glow: true,
  tempoRange: 8,
  pitchRange: 12,
  jumpBeats: 4,
  jogWeight: 0.4,
  jogDrag: 0.4,
  stemModel: "off", // "Single" (plain mix, no stems) until the user picks a neural engine; DSP split was dropped
  streamSource: "yt-anonymous", // == DEFAULT_SOURCE in @htl/media; hardcoded to keep settings dep-free
  keyHints: true, // per-button key letters on by default (CSS hides them on mobile)
  keyBindings: {}, // empty → every action uses its default key (see @htl keybinds)
  keyProfiles: [], // no saved keyboard profiles yet
  activeKeyProfileId: null,
  midiEnabled: false, // off until the user opts in (Web MIDI shows a permission prompt)
  midiBindings: {}, // empty → rely on the auto-matched built-in controller profile
  midiMaps: [], // no saved maps yet
  activeMidiMapId: null,
  colorProfiles: [], // no saved colour themes yet
  activeColorProfileId: null,
  stretchEngine: "wsola", // proven default; PV is opt-in until ear-tested across devices
  stretchQuality: "balanced", // crisp + low-latency default
  stretchTransient: true, // preserve attacks by default
  stretchAa: true, // anti-alias pitch-ups by default
  stretchTThresh: 2.2, // matches the worklet's built-in default
  stemQuality: "balanced", // desktop demucs-GPU: 1 shift + 50% overlap by default
  audioOutputId: "", // system default output until the user picks a device
  autoEnhance: true, // desktop auto-upgrades DSP → cached neural; toggle off to stay on the picked model
  freqColors: true, // crispy rekordbox-style band colours on by default; off → flat per-deck colour
  freqVividness: 1, // as-picked saturation by default
  uiContrast: DEFAULT_CONTRAST, // inky-but-readable fills by default (deeper than a flat grey)
  inheritRoomColor: true, // catch the host's vibe in a shared session by default
  lyricsAuto: true, // Whisper lyrics primary over YouTube captions when a neural vocal stem exists
  lyricsModel: "base", // fast tier by default; "small" is better on sung lyrics
};

// Dark base-colour presets for the background picker (varied dark hues).
export const BG_PRESETS = ["#050507", "#0a0a12", "#0d0a16", "#0a1014", "#120a0e", "#0b0f0b", "#101010", "#000000"];
// Light, readable text presets.
export const TEXT_PRESETS = ["#ecedfb", "#ffffff", "#cdd3ff", "#ffe9c2", "#bfffe0", "#ffd0ec", "#d8d8d8", "#9fb0ff"];
// Border / line presets, subtle → neon.
export const BORDER_PRESETS = ["#1a1a28", "#2a2a3d", "#0c0c14", "#39314f", "#2a3d3a", "#4d3a2a", "#00e5ff", "#ff2d9c"];

export const TEMPO_RANGES = [6, 8, 10, 16, 50, 100];

// KEY knob half-ranges (± semitones). 12 = a full octave each way, 24 = two octaves.
export const PITCH_RANGES = [1, 2, 4, 7, 12, 24];

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
// How far the panel/surface fills lift OFF the base, scaled by the contrast knob:
// 0 → 1.55× (soft, washed grey), 1 → 0.3× (inky — fills hug the base for maximum
// separation from the bright text). Lower scale = darker darks.
function panelScale(contrast: number): number {
  const c = Math.max(0, Math.min(1, Number.isFinite(contrast) ? contrast : DEFAULT_CONTRAST));
  return 1.55 - 1.25 * c;
}

// The darkest UI surface (lanes/buttons) derived from the chosen base + contrast.
// Luminance-aware: on a LIGHT theme the fills go darker than the base instead of
// clamping to white. Exported so the waveform canvas can take it as a prop instead
// of reading getComputedStyle (which is one commit stale, since applySettings runs
// in a parent effect after the canvas's effects).
export function surfaceColor(bg: string, contrast: number = DEFAULT_CONTRAST): string {
  const sc = panelScale(contrast);
  const sgn = relLum(bg || DEFAULT_BG) < 0.5 ? 1 : -1;
  return shift(bg || DEFAULT_BG, sgn * 3 * sc, sgn * 3 * sc, sgn * 6 * sc);
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
  // Panel/surface fills follow the contrast knob (inkier = deeper). Luminance-aware
  // so the lift direction flips for light themes (panels go darker, not clamp-white).
  const c = Math.max(0, Math.min(1, Number.isFinite(s.uiContrast) ? s.uiContrast : DEFAULT_CONTRAST));
  const sc = panelScale(c);
  const dark = relLum(bg) < 0.5;
  const sgn = dark ? 1 : -1;
  const lift = (r: number, g: number, b: number) => shift(bg, sgn * r * sc, sgn * g * sc, sgn * b * sc);
  root.style.setProperty("--surface", surfaceColor(bg, c)); // darkest UI surfaces (buttons, lanes)
  root.style.setProperty("--panel", lift(6, 6, 10));
  root.style.setProperty("--panel-2", lift(11, 11, 18));
  // Text + border are user-controlled; contrast nudges the text toward the theme's
  // extreme (whiter on dark, blacker on light) for "brighter whites", and muted is
  // that result faded halfway toward the bg.
  const text = blend(s.textColor || DEFAULT_TEXT, dark ? "#ffffff" : "#000000", 0.3 * c);
  root.style.setProperty("--text", text);
  root.style.setProperty("--muted", blend(text, bg, 0.55));
  root.style.setProperty("--line", s.borderColor || DEFAULT_BORDER);
  // Waveform viewport colours (read by the canvas). Strip is optional — left
  // unset it falls back to each deck's accent so the two waveforms stay distinct.
  root.style.setProperty("--wv-selector", s.selectorColor || "#ffffff");
  root.style.setProperty("--wv-loop", s.loopColor || "#6ee7a8");
  root.style.setProperty("--wv-marker", s.markerColor || "#ffd64a");
  root.style.setProperty("--shift", s.shiftColor || "#ffd250"); // SHIFT / alt-action highlight
  if (s.stripColor) root.style.setProperty("--wv-strip", s.stripColor);
  else root.style.removeProperty("--wv-strip");
  document.body.classList.toggle("no-glow", !s.glow);
  document.body.classList.toggle("show-keys", s.keyHints);
}
