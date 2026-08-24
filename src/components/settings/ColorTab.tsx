// Settings ▸ Color — theme pickers (grouped swatches), random/mono rolls, appearance
// toggles, and the saved/synced colour profiles. Owns the colour-roll helpers; pure
// render of (settings, set, onChange).
import { contrastWarnings, type Settings, FREQ_LOW_DEFAULT, FREQ_MID_DEFAULT, FREQ_HIGH_DEFAULT, DEFAULT_CONTRAST } from "@htl";
import { ColorProfiles } from "../ColorProfiles";
import { Slider } from "./Slider";

// The customisable theme colours — each pill opens the colour picker directly.
type ColorKey =
  | "accentA"
  | "accentB"
  | "bgColor"
  | "textColor"
  | "borderColor"
  | "selectorColor"
  | "loopColor"
  | "markerColor"
  | "shiftColor"
  | "stripColor"
  | "stemDrumsColor"
  | "stemBassColor"
  | "stemVocalsColor"
  | "stemOtherColor"
  | "freqLowColor"
  | "freqMidColor"
  | "freqHighColor";
// `def` is the built-in colour shown for an UNSET ("") value (so a picker reads its real
// default, not deck-A's accent). Omitted → falls back to accent A (e.g. Strip).
type ColorTarget = { key: ColorKey; label: string; def?: string };
// The colour pickers, grouped by WHAT they change with a one-line explanation each —
// so the Color tab reads as a labelled control surface, not a flat wall of swatches.
const COLOR_GROUPS: { id: string; title: string; desc: string; targets: ColorTarget[] }[] = [
  {
    id: "decks",
    title: "Decks",
    desc: "Each deck's signature colour. Its waveform, buttons, faders and meter.",
    targets: [
      { key: "accentA", label: "Deck A" },
      { key: "accentB", label: "Deck B" },
    ],
  },
  {
    id: "interface",
    title: "Interface",
    desc: "The app itself: base background, text, and the panel border lines.",
    targets: [
      { key: "bgColor", label: "Background" },
      { key: "textColor", label: "Text" },
      { key: "borderColor", label: "Border" },
    ],
  },
  {
    id: "waveform",
    title: "Waveform",
    desc: "Markers drawn over the waveforms, plus the waveform body. Leave Strip unset to follow the deck colour.",
    targets: [
      { key: "selectorColor", label: "Playhead" },
      { key: "loopColor", label: "Loops" },
      { key: "markerColor", label: "Beat grid" },
      { key: "shiftColor", label: "Shift" },
      { key: "stripColor", label: "Strip" },
    ],
  },
  {
    id: "stems",
    title: "Stem lanes",
    desc: "Per-stem waveform colours. They match the DRUM / BASS / VOICE / INST buttons.",
    targets: [
      { key: "stemDrumsColor", label: "Drums", def: "#ff5d73" },
      { key: "stemBassColor", label: "Bass", def: "#b06bff" },
      { key: "stemVocalsColor", label: "Vocals", def: "#5dff9e" },
      { key: "stemOtherColor", label: "Inst", def: "#36c2ff" },
    ],
  },
  {
    id: "bands",
    title: "Frequency bands",
    desc: "Bass / mid / high hues for the frequency-coloured waveform (when Frequency colours is on).",
    targets: [
      { key: "freqLowColor", label: "Lows", def: FREQ_LOW_DEFAULT },
      { key: "freqMidColor", label: "Mids", def: FREQ_MID_DEFAULT },
      { key: "freqHighColor", label: "Highs", def: FREQ_HIGH_DEFAULT },
    ],
  },
];

// HSL → #rrggbb (h 0–360, s/l 0–100).
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
const randHue = () => Math.floor(Math.random() * 360);
const randIn = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const vividHex = () => hslToHex(randHue(), randIn(78, 100), randIn(55, 66));

// Whacky-but-usable random theme: vivid accents, a dark base, light text.
function randomTheme(): Pick<Settings, ColorKey> {
  return {
    accentA: vividHex(),
    accentB: vividHex(),
    bgColor: hslToHex(randHue(), randIn(25, 70), randIn(5, 12)),
    textColor: hslToHex(randHue(), randIn(8, 35), randIn(86, 96)),
    borderColor: hslToHex(randHue(), randIn(40, 80), randIn(22, 38)),
    selectorColor: hslToHex(randHue(), randIn(0, 20), randIn(90, 100)),
    loopColor: vividHex(),
    markerColor: vividHex(),
    shiftColor: vividHex(),
    stripColor: vividHex(),
    stemDrumsColor: vividHex(),
    stemBassColor: vividHex(),
    stemVocalsColor: vividHex(),
    stemOtherColor: vividHex(),
    freqLowColor: vividHex(),
    freqMidColor: vividHex(),
    freqHighColor: vividHex(),
  };
}

// Pure black/white monochrome roll: flip a coin for which of text / background is
// black and which is white, with vivid random accents popping over the mono base.
function randomMono(): Pick<Settings, ColorKey> {
  const darkBase = Math.random() < 0.5; // true = black bg + white text
  const bg = darkBase ? "#000000" : "#ffffff";
  const text = darkBase ? "#ffffff" : "#000000";
  return {
    accentA: vividHex(),
    accentB: vividHex(),
    bgColor: bg,
    textColor: text,
    borderColor: darkBase ? "#2a2a2a" : "#cfcfcf",
    selectorColor: text,
    loopColor: vividHex(),
    markerColor: vividHex(),
    shiftColor: vividHex(),
    stripColor: vividHex(), // vivid waveform popping over the mono base
    // Vivid, DISTINCT per-stem colours so the quad lanes stay readable over mono.
    stemDrumsColor: vividHex(),
    stemBassColor: vividHex(),
    stemVocalsColor: vividHex(),
    stemOtherColor: vividHex(),
    freqLowColor: vividHex(),
    freqMidColor: vividHex(),
    freqHighColor: vividHex(),
  };
}

export function ColorTab({
  settings,
  set,
  onChange,
}: {
  settings: Settings;
  set: (patch: Partial<Settings>) => void;
  onChange: (next: Settings) => void;
}) {
  return (
    <div className="color-tab">
      {/* Header: one-shot rolls to explore, on the right of the intro line. */}
      <div className="color-intro">
        <span className="color-intro-text">Make it yours. Every surface follows the colours below. Pick a swatch to change it live.</span>
        <div className="color-rolls">
          <button className="color-roll" onClick={() => set(randomTheme())} title="Roll a whole random theme">
            🎲 Random
          </button>
          <button className="color-roll" onClick={() => set(randomMono())} title="Pure black/white base with vivid accents">
            ⬛⬜ Mono
          </button>
        </div>
      </div>

      {/* Collision detection: warn only when text/border can't be read. */}
      {(() => {
        const warns = contrastWarnings(settings);
        return warns.length ? (
          <div className="color-warnings">
            {warns.map((w) => (
              <div key={w} className="color-warning">
                <span className="color-warning-ico">⚠</span> {w}
              </div>
            ))}
          </div>
        ) : null;
      })()}

      {/* Grouped pickers: each section says WHAT it changes. The pill IS the
          OS colour wheel (tap to open). */}
      {COLOR_GROUPS.map((g) => (
        <div key={g.id} className="color-group">
          <div className="color-group-head">
            <span className="color-group-title">{g.title}</span>
            <span className="color-group-desc">{g.desc}</span>
          </div>
          <div className="color-targets">
            {g.targets.map((t) => {
              // Strip / unset values show their built-in default (or deck A).
              const value = settings[t.key] || t.def || settings.accentA;
              return (
                <label key={t.key} className="color-target" title={`${t.label} — ${value}`}>
                  <span className="color-target-dot" style={{ background: value }} />
                  {t.label}
                  <input type="color" value={value} onChange={(e) => set({ [t.key]: e.target.value } as Partial<Settings>)} />
                </label>
              );
            })}
          </div>
        </div>
      ))}

      {/* Appearance: the look-and-feel knobs that aren't a single colour. */}
      <div className="color-group">
        <div className="color-group-head">
          <span className="color-group-title">Appearance</span>
          <span className="color-group-desc">Depth, glow, the band-colour look, and shared-session vibe.</span>
        </div>

        <Slider
          label="Contrast"
          hint={settings.uiContrast < 0.25 ? "soft" : settings.uiContrast > 0.8 ? "inky" : "balanced"}
          value={settings.uiContrast ?? DEFAULT_CONTRAST}
          onChange={(v) => set({ uiContrast: v })}
        />

        <div className="settings-row">
          <span className="settings-label">Neon glow</span>
          <button
            className={`toggle ${settings.glow ? "on" : ""}`}
            onClick={() => set({ glow: !settings.glow })}
            role="switch"
            aria-checked={settings.glow}
          >
            <span className="toggle-knob" />
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-label">
            Frequency colors
            <span className="settings-sub muted"> · waveform by band (bass/mid/high)</span>
          </span>
          <button
            className={`toggle ${settings.freqColors ? "on" : ""}`}
            onClick={() => set({ freqColors: !settings.freqColors })}
            role="switch"
            aria-checked={settings.freqColors}
            title="Color the single (non-stem) waveform by frequency content — bass / mid / high (rekordbox-style), tuned by the Frequency bands above. Off = flat Strip color (clear Strip → each deck's accent)."
          >
            <span className="toggle-knob" />
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-label">
            De-brickwall
            <span className="settings-sub muted"> · open up loud, over-limited masters</span>
          </span>
          <button
            className={`toggle ${settings.waveformDebrick ? "on" : ""}`}
            onClick={() => set({ waveformDebrick: !settings.waveformDebrick })}
            role="switch"
            aria-checked={settings.waveformDebrick}
            title="Most modern masters are brick-walled (limited near full-scale), so the waveform flat-tops into a solid block. This re-expands local contrast — transients and micro-dynamics show as contour — while keeping whole-track loud/quiet shape (drops & breakdowns still dip). Off = raw amplitude."
          >
            <span className="toggle-knob" />
          </button>
        </div>

        <Slider
          label="Marker & grid bars"
          hint={`${settings.markerThickness ?? 2}px`}
          value={settings.markerThickness ?? 2}
          onChange={(v) => set({ markerThickness: v })}
          min={1}
          max={6}
          step={1}
        />

        <div className="settings-row">
          <span className="settings-label">
            Room color
            <span className="settings-sub muted"> · catch the host's accent in a session</span>
          </span>
          <button
            className={`toggle ${settings.inheritRoomColor ? "on" : ""}`}
            onClick={() => set({ inheritRoomColor: !settings.inheritRoomColor })}
            role="switch"
            aria-checked={settings.inheritRoomColor}
            title="While you're in a shared session, take on the host's accent color so the whole room shares a vibe. Reverts to your own the moment you're solo or leave. Only the global accent changes — your deck colors stay."
          >
            <span className="toggle-knob" />
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-label">
            Deck artwork
            <span className="settings-sub muted"> · tint each deck to its track's cover</span>
          </span>
          <button
            className={`toggle ${settings.deckArtAccent ? "on" : ""}`}
            onClick={() => set({ deckArtAccent: !settings.deckArtAccent })}
            role="switch"
            aria-checked={settings.deckArtAccent}
            title="Theme each deck's accent color to the loaded track's album art. Turn off to keep your fixed Deck A / Deck B accents. (Album art is always served from our own cache for privacy — only the coloring is optional.)"
          >
            <span className="toggle-knob" />
          </button>
        </div>
      </div>

      {/* Vividness (band look) + saved/synced/shareable colour profiles. */}
      <ColorProfiles settings={settings} onChange={onChange} />
    </div>
  );
}
