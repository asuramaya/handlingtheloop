// User customization, persisted via the @htl Store and applied as CSS variables
// / body classes so the whole UI re-themes without prop drilling.
import { Store, migrateLegacyKey } from "../persistence";

export interface Settings {
  accentA: string; // deck A neon
  accentB: string; // deck B neon
  glow: boolean; // neon glow on/off
  tempoRange: number; // pitch fader half-range (±%)
  jumpBeats: number; // beat-jump / loop-move "skip" resolution, in beats
}

export const DEFAULT_SETTINGS: Settings = {
  accentA: "#00e5ff",
  accentB: "#ff2d9c",
  glow: true,
  tempoRange: 8,
  jumpBeats: 4,
};

export const TEMPO_RANGES = [6, 8, 10, 16, 50];

// Beat-jump resolution choices (beats). 4 = one bar.
export const JUMP_RESOLUTIONS = [1, 2, 4, 8, 16];
export function jumpLabel(beats: number): string {
  return beats >= 4 && beats % 4 === 0 ? `${beats / 4} bar${beats > 4 ? "s" : ""}` : `${beats} beat${beats > 1 ? "s" : ""}`;
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

export function applySettings(s: Settings) {
  const root = document.documentElement;
  root.style.setProperty("--neon-cyan", s.accentA);
  root.style.setProperty("--neon-pink", s.accentB);
  document.body.classList.toggle("no-glow", !s.glow);
}
