// Settings ▸ Color — theme pickers (grouped swatches), random/mono rolls, appearance
// toggles, and the saved/synced colour profiles. Owns the colour-roll helpers; pure
// render of (settings, set, onChange).
import { contrastWarnings, type Settings, FREQ_LOW_DEFAULT, FREQ_MID_DEFAULT, FREQ_HIGH_DEFAULT, DEFAULT_CONTRAST } from "@htl";
import { Slider } from "./Slider";
import { InfoDot } from "./InfoDot";
import { randomTheme, randomMono } from "../../htl/state/randomPalette";

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
    desc: "The colour that identifies each deck. It runs through that deck's waveform, buttons, faders and meter.",
    targets: [
      { key: "accentA", label: "Deck A" },
      { key: "accentB", label: "Deck B" },
    ],
  },
  {
    id: "interface",
    title: "Interface",
    desc: "The app's own surfaces: the background behind everything, the text on top of it, and the lines between panels.",
    targets: [
      { key: "bgColor", label: "Background" },
      { key: "textColor", label: "Text" },
      { key: "borderColor", label: "Border" },
    ],
  },
  {
    id: "waveform",
    title: "Waveform",
    desc: "The markers drawn over a waveform, and the wave itself. Leave Strip empty and the wave follows the deck colour.",
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
    desc: "One colour per stem lane, matching its DRUM, BASS, VOICE and INST button. Each colour also shades its own lane, from a deep body up to a bright core.",
    targets: [
      { key: "stemDrumsColor", label: "Drums", def: "#ff5d73" },
      { key: "stemBassColor", label: "Bass", def: "#b06bff" },
      { key: "stemVocalsColor", label: "Vocals", def: "#5dff9e" },
      { key: "stemOtherColor", label: "Inst", def: "#36c2ff" },
    ],
  },
  {
    id: "bands",
    title: "Frequency colour",
    desc: "Colours a wave by what is in it. These three hues paint the plain waveform. A stem lane uses its own colour instead.",
    targets: [
      { key: "freqLowColor", label: "Lows", def: FREQ_LOW_DEFAULT },
      { key: "freqMidColor", label: "Mids", def: FREQ_MID_DEFAULT },
      { key: "freqHighColor", label: "Highs", def: FREQ_HIGH_DEFAULT },
    ],
  },
];

// HSL → #rrggbb (h 0–360, s/l 0–100).
// The palette rolls live in `@htl/state/randomPalette` — pure, and property-tested over 400 rolls
// apiece, because a generator is only as good as its WORST roll and the old one drew all
// seventeen hues independently (two decks the same colour was just something that happened).
export function ColorTab({
  settings,
  set,
}: {
  settings: Settings;
  set: (patch: Partial<Settings>) => void;
}) {
  // Non-colour controls, filed under the group whose colours they act on. See the render.
  const extras: Record<string, React.ReactNode> = {
    // NOTE: "Follow deck colour" used to appear HERE as well, with the same words, driving
    // `stemsFollowDeck` while the copy in the bands group drove `bandFromDeck`. Two switches,
    // one idea — and the two flags cover render paths that are mutually exclusive (a lane is
    // drawn as a stem OR as the plain banded wave, never both), so wanting one without the
    // other is incoherent. There is now ONE switch, in the bands group, that writes both.

    decks: (
      <>
          <div className="settings-row">
            <span className="settings-label">
              Room color
              <InfoDot text="In a shared session you take on the host's accent, so the room looks the same to everyone in it. Your own colour comes back the moment you leave. Your deck colours are never touched." label="Room color" />
            </span>
            <button
              className={`toggle ${settings.inheritRoomColor ? "on" : ""}`}
              onClick={() => set({ inheritRoomColor: !settings.inheritRoomColor })}
              role="switch"
              aria-checked={settings.inheritRoomColor}
            >
              <span className="toggle-knob" />
            </button>
          </div>
          <div className="settings-row">
            <span className="settings-label">
              Deck artwork
              <InfoDot text="Each deck takes its accent from the cover art of whatever is loaded. Turn this off to keep your fixed Deck A and Deck B colours. Cover art is always served from our own cache, so only the colouring is optional." label="Deck artwork" />
            </span>
            <button
              className={`toggle ${settings.deckArtAccent ? "on" : ""}`}
              onClick={() => set({ deckArtAccent: !settings.deckArtAccent })}
              role="switch"
              aria-checked={settings.deckArtAccent}
            >
              <span className="toggle-knob" />
            </button>
          </div>
      </>
    ),
    interface: (
      <Slider
        label="Contrast"
        hint={settings.uiContrast < 0.25 ? "soft" : settings.uiContrast > 0.8 ? "inky" : "balanced"}
        value={settings.uiContrast ?? DEFAULT_CONTRAST}
        onChange={(v) => set({ uiContrast: v })}
      />
    ),
    waveform: (
      <>
        <div className="settings-row">
          <span className="settings-label">
              Neon glow
              <InfoDot text="A soft coloured bloom behind the wave." label="Neon glow" />
            </span>
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
              De-brickwall
              <InfoDot text="Loud modern masters are limited so hard that the waveform flattens into a block. This finds the detail still hiding inside a section and opens it back out, while drops and breakdowns stay visibly lower than the rest. Music that already has room to breathe is left alone. Off shows raw amplitude." label="De-brickwall" />
            </span>
            <button
              className={`toggle ${settings.waveformDebrick ? "on" : ""}`}
              onClick={() => set({ waveformDebrick: !settings.waveformDebrick })}
              role="switch"
              aria-checked={settings.waveformDebrick}
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
      </>
    ),
    bands: (
      <>
          <div className="settings-row">
            <span className="settings-label">
              Frequency colors
              <InfoDot text="Colours the wave by what is in it: bass, mid and high, instead of one flat colour. The plain waveform uses the three hues above, and each stem lane uses its own. Off gives a flat Strip colour, or the deck's accent if Strip is empty." label="Frequency colors" />
            </span>
            <button
              className={`toggle ${settings.freqColors ? "on" : ""}`}
              onClick={() => set({ freqColors: !settings.freqColors })}
              role="switch"
              aria-checked={settings.freqColors}
            >
              <span className="toggle-knob" />
            </button>
          </div>
          <div className="settings-row">
            <span className="settings-label">
              Layered bands
              <InfoDot text="How that colour is drawn. On, each band takes its own slice of the wave, sized by how much of it is there, so a kick shows a wide low body with a bright core. Off, the whole shape takes one blended colour. Layering needs height, so a short lane falls back to the blend by itself." label="Layered bands" />
            </span>
            <button
              className={`toggle ${settings.bandLayers ? "on" : ""}`}
              onClick={() => set({ bandLayers: !settings.bandLayers })}
              role="switch"
              aria-checked={settings.bandLayers}
            >
              <span className="toggle-knob" />
            </button>
          </div>
        {/* ONE switch, two render flags. `bandFromDeck` colours the plain banded wave and
            `stemsFollowDeck` colours the stem lanes; they are separate inputs because they feed
            different paint paths, but they answer the same question, so the panel asks it once.
            Reads ON only when BOTH are set, so a profile saved when these were two controls
            settles to a coherent state on the first click. */}
        {(() => {
          const followDeck = settings.bandFromDeck && settings.stemsFollowDeck;
          return (
            <div className="settings-row">
              <span className="settings-label">
                Follow deck colour
                <InfoDot text="Builds every waveform colour out of the deck's own accent: the three frequency bands, and each stem lane. One hue in a range of shades, from a deep body up to a bright core, so a deck's wave reads as that deck at a glance. The Lows, Mids, Highs and stem-lane swatches are ignored while this is on." label="Follow deck colour" />
              </span>
              <button
                className={`toggle ${followDeck ? "on" : ""}`}
                onClick={() => set({ bandFromDeck: !followDeck, stemsFollowDeck: !followDeck })}
                role="switch"
                aria-checked={followDeck}
              >
                <span className="toggle-knob" />
              </button>
            </div>
          );
        })()}
        {settings.freqColors && (
          <div className="settings-row">
            <span className="settings-label">
              Vividness <span className="settings-sub muted">· {Math.round(settings.freqVividness * 100)}%</span>
            </span>
            <input
              type="range"
              className="settings-slider"
              min={0}
              max={2}
              step={0.05}
              value={settings.freqVividness}
              onChange={(e) => set({ freqVividness: Number(e.target.value) })}
            />
          </div>
        )}
      </>
    ),
  };

  return (
    <div className="color-tab">
      {/* One-shot rolls, alone on their row. The sentence that used to sit beside them
          ("Make it yours. Every surface follows the colours below…") explained what a settings
          tab is; the swatches do that themselves the moment you see one. */}
      {/* The two rolls, as a segmented pair. They were emoji-labelled buttons floating alone on
          an otherwise empty row, which read as leftovers rather than as a control: the emoji did
          the work the styling should have done, and nothing said the two belonged together.
          Same segmented language as the phone deck switch, so the panel has one vocabulary. */}
      <div className="settings-section color-intro">
        <span className="settings-label">Shuffle</span>
        <div className="color-rolls">
          <button className="color-roll" onClick={() => set(randomTheme())}>
            Palette
          </button>
          <button className="color-roll" onClick={() => set(randomMono())}>
            Mono
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
        <div key={g.id} className="settings-section color-group">
          <div className="settings-section-head color-group-head">
            <span className="settings-label color-group-title">{g.title}</span>
            <InfoDot text={g.desc} label={g.title} />
          </div>
          {/* A colour is a control like any other, so it gets a ROW — name left, hex in the
              shared value slot, chip on the right at the same 44x24 as a toggle. The old
              wrapping chip grid was a second layout language inside the same card, and it
              orphaned a chip on its own line whenever a group held an odd count. */}
          {g.targets.map((t) => {
            // Strip / unset values show their built-in default (or deck A).
            const value = settings[t.key] || t.def || settings.accentA;
            return (
              // ★ THE PICKER IS ANCHORED TO THE INPUT, so the input is positioned for the
              // ANCHOR (right-aligned, one popup wide — see `.color-row > input` in
              // settings.css), not for the hit area. The row stays a <label>, which forwards a
              // press anywhere on it to the input without moving that anchor — so the whole
              // row opens the wheel and the wheel still opens beside the swatch.
              <label key={t.key} className="settings-row color-row" title={`${t.label} — ${value}`}>
                <input
                  type="color"
                  value={value}
                  aria-label={t.label}
                  onChange={(e) => set({ [t.key]: e.target.value } as Partial<Settings>)}
                />
                <span className="settings-label">{t.label}</span>
                <span className="settings-control">
                  <span className="settings-value is-hex">{value}</span>
                  <span className="color-swatch" style={{ background: value }} />
                </span>
              </label>
            );
          })}
          {/* Each group's non-colour controls sit WITH the colours they act on. They used to be
              pooled in one "Appearance" section, which meant the switch for a thing and the thing
              itself were never on screen together — you set Frequency colours in one place and
              chose its hues in another, three sections away. */}
          {extras[g.id]}
        </div>
      ))}

      {/* Saved themes used to be a card down here. The whole save/share/manage control is one
          thing in the PANEL HEADER now (see SettingsPanel), the same control on every tab. */}
    </div>
  );
}
