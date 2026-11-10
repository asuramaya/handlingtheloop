// Settings ▸ Interface ▸ colour. Pure render of (settings, set).
//
// ★ REWORKED SO IT ASKS ONE QUESTION PER CARD. Operator, 2026-11-02: "we can rework color a bit so
// its less confusing". The confusion was in the waveform: Strip, Frequency colors, Follow deck
// colour, the Lows/Mids/Highs swatches and the stem-lane swatches were five controls that OVERRODE
// each other, and the help texts were mostly about which one won ("ignored while this is on",
// "leave Strip empty and..."). Now the wave asks a single question — what colours it? — with three
// answers, and only the swatches that answer can actually use are shown:
//   • Deck colour  — every band and stem lane is built from the deck's own accent (no swatches);
//   • Frequency    — your Lows/Mids/Highs paint the plain wave, your lane colours paint stems;
//   • Flat         — one colour (Strip, or the deck's accent when Strip is empty) + lane colours.
// Markers (playhead, loops, grid) got their own card, and SHIFT's highlight moved to the interface
// colours, because it paints buttons, not the waveform.
import type { ReactNode } from "react";
import { contrastWarnings, type Settings, FREQ_LOW_DEFAULT, FREQ_MID_DEFAULT, FREQ_HIGH_DEFAULT, DEFAULT_CONTRAST } from "@htl";
import { Slider } from "./Slider";
import { InfoDot } from "./InfoDot";
import { ToggleRow } from "./ControlsTab";
import { randomTheme, randomMono } from "../../htl/state/randomPalette";
import { WaveformPreview } from "./WaveformPreview";

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
  | "slipMoveColor"
  | "stripColor"
  | "stemDrumsColor"
  | "stemBassColor"
  | "stemVocalsColor"
  | "stemOtherColor"
  | "freqLowColor"
  | "freqMidColor"
  | "freqHighColor";
// `def` is the built-in colour shown for an UNSET ("") value. Omitted → accent A.
type ColorTarget = { key: ColorKey; label: string; def?: string };

const STEM_LANES: ColorTarget[] = [
  { key: "stemDrumsColor", label: "Drums lane", def: "#ff5d73" },
  { key: "stemBassColor", label: "Bass lane", def: "#b06bff" },
  { key: "stemVocalsColor", label: "Vocals lane", def: "#5dff9e" },
  { key: "stemOtherColor", label: "Inst lane", def: "#36c2ff" },
];
const BANDS: ColorTarget[] = [
  { key: "freqLowColor", label: "Lows", def: FREQ_LOW_DEFAULT },
  { key: "freqMidColor", label: "Mids", def: FREQ_MID_DEFAULT },
  { key: "freqHighColor", label: "Highs", def: FREQ_HIGH_DEFAULT },
];

type WaveMode = "deck" | "freq" | "flat";
const WAVE_MODES: { id: WaveMode; label: string; info: string }[] = [
  { id: "deck", label: "Deck colour", info: "Every part of the wave — the bass, mid and high bands, and each stem lane — is a shade of that deck's own colour. A deck's wave reads as that deck at a glance." },
  { id: "freq", label: "Frequency", info: "The wave is coloured by what is in it: your Lows, Mids and Highs paint the plain wave, and each stem lane uses its own colour." },
  { id: "flat", label: "Flat", info: "One colour for the whole wave: Strip, or the deck's colour when Strip is cleared. Stem lanes keep their own colours." },
];
export function waveModeOf(s: Settings): WaveMode {
  if (!s.freqColors) return "flat";
  return s.bandFromDeck && s.stemsFollowDeck ? "deck" : "freq";
}
export function waveModePatch(m: WaveMode): Partial<Settings> {
  if (m === "deck") return { freqColors: true, bandFromDeck: true, stemsFollowDeck: true };
  if (m === "freq") return { freqColors: true, bandFromDeck: false, stemsFollowDeck: false };
  return { freqColors: false, bandFromDeck: false, stemsFollowDeck: false };
}

export function ColorTab({ settings, set }: { settings: Settings; set: (patch: Partial<Settings>) => void }) {
  const swatch = (t: ColorTarget, after?: ReactNode, fallback = false) => {
    const value = settings[t.key] || t.def || settings.accentA;
    return (
      // The row stays a <label> so a press anywhere on it opens the wheel, which stays anchored
      // to the input beside the swatch (see `.color-row > input` in settings.css).
      <label key={t.key} className={`settings-row color-row${fallback ? " is-fallback" : ""}`} title={`${t.label} — ${value}`}>
        <input type="color" value={value} aria-label={t.label} onChange={(e) => set({ [t.key]: e.target.value } as Partial<Settings>)} />
        <span className="settings-label">{t.label}</span>
        <span className="settings-control">
          {after}
          <span className="settings-value is-hex">{value}</span>
          <span className="color-swatch" style={{ background: value }} />
        </span>
      </label>
    );
  };
  const mode = waveModeOf(settings);
  const warns = contrastWarnings(settings);

  return (
    <div className="color-tab">
      <div className="settings-section color-intro">
        <span className="settings-label">Shuffle colours</span>
        <div className="color-rolls">
          <button className="color-roll" onClick={() => set(randomTheme())}>
            Palette
          </button>
          <button className="color-roll" onClick={() => set(randomMono())}>
            Mono
          </button>
        </div>
      </div>

      {/* Live sample of the wave in these colours. Pinned to the top of the scroll area so it
          stays in view while you work down the swatches below it. */}
      <WaveformPreview settings={settings} />

      {warns.length > 0 && (
        <div className="color-warnings">
          {warns.map((w) => (
            <div key={w} className="color-warning">
              <span className="color-warning-ico">⚠</span> {w}
            </div>
          ))}
        </div>
      )}

      <div className="settings-section color-group">
        <div className="settings-section-head color-group-head">
          <span className="settings-label color-group-title">Decks</span>
          <InfoDot label="Decks" text="The colour that identifies each deck. It runs through that deck's waveform, buttons, faders and meter." />
        </div>
        {/* ★ THE OVERRIDE COMES FIRST, and when it is on the fixed colours say they are the fallback.
            Before, "Deck A #00E5FF" sat above a cover-art toggle that was ON, so the row named a cyan
            deck while the board painted it orange — the setting looked broken. */}
        <ToggleRow
          label="From cover art"
          info="Each deck takes its colour from the cover art of whatever is loaded. The Deck A and Deck B colours below are used when a track has no art."
          on={settings.deckArtAccent}
          onToggle={() => set({ deckArtAccent: !settings.deckArtAccent })}
        />
        {swatch({ key: "accentA", label: settings.deckArtAccent ? "Deck A · no art" : "Deck A" }, undefined, settings.deckArtAccent)}
        {swatch({ key: "accentB", label: settings.deckArtAccent ? "Deck B · no art" : "Deck B" }, undefined, settings.deckArtAccent)}
        <ToggleRow
          label="Match the room"
          info="In a shared session you take on the host's colour, so the room looks the same to everyone in it. Your own comes back when you leave."
          on={settings.inheritRoomColor}
          onToggle={() => set({ inheritRoomColor: !settings.inheritRoomColor })}
        />
      </div>

      <div className="settings-section color-group">
        <div className="settings-section-head color-group-head">
          <span className="settings-label color-group-title">Waveform</span>
          <InfoDot label="Waveform" text="What colours the wave. Pick one; only the colours that choice uses are shown." />
        </div>
        <div className="settings-row">
          <span className="settings-label">
            Colour by
            {/* The chosen mode's explanation used to sit under the control as a sentence. */}
            <InfoDot label="Colour by" text={WAVE_MODES.find((m) => m.id === mode)!.info} />
          </span>
          <span className="settings-control">
            <span className="seg-group">
              {WAVE_MODES.map((m) => (
                <button key={m.id} className={`hw-btn small ${mode === m.id ? "on" : ""}`} onClick={() => set(waveModePatch(m.id))} aria-pressed={mode === m.id} title={m.info}>
                  {m.label}
                </button>
              ))}
            </span>
          </span>
        </div>
        {mode === "flat" &&
          swatch(
            { key: "stripColor", label: "Wave" },
            settings.stripColor ? (
              <button className="link-btn" onClick={(e) => (e.preventDefault(), set({ stripColor: "" }))}>
                use deck colour
              </button>
            ) : (
              <span className="settings-value">deck colour</span>
            ),
          )}
        {mode === "freq" && BANDS.map((t) => swatch(t))}
        {mode !== "deck" && STEM_LANES.map((t) => swatch(t))}
        {mode !== "flat" && (
          <>
            <ToggleRow
              label="Layered bands"
              info="On, each band gets its own slice of the wave, sized by how much of it there is, so a kick shows a wide low body with a bright core. Off, the shape takes one blended colour. Short lanes always blend."
              on={settings.bandLayers}
              onToggle={() => set({ bandLayers: !settings.bandLayers })}
            />
            <Slider
              label="Vividness"
              hint={`${Math.round(settings.freqVividness * 100)}%`}
              value={settings.freqVividness}
              onChange={(v) => set({ freqVividness: v })}
              min={0}
              max={2}
              step={0.05}
              info="How saturated the band colours are."
            />
          </>
        )}
        <ToggleRow label="Neon glow" info="A soft coloured bloom behind the wave." on={settings.glow} onToggle={() => set({ glow: !settings.glow })} />
        <ToggleRow
          label="De-brickwall"
          info="Loud modern masters are limited so hard the waveform flattens into a block. This opens the hidden detail back out, while drops and breakdowns stay visibly lower. Off shows raw amplitude."
          on={settings.waveformDebrick}
          onToggle={() => set({ waveformDebrick: !settings.waveformDebrick })}
        />
      </div>

      <div className="settings-section color-group">
        <div className="settings-section-head color-group-head">
          <span className="settings-label color-group-title">Markers</span>
          <InfoDot label="Markers" text="What is drawn over the wave: the playhead, loops and the beat grid." />
        </div>
        {swatch({ key: "selectorColor", label: "Playhead" })}
        {swatch({ key: "loopColor", label: "Loops" })}
        {swatch({ key: "markerColor", label: "Beat grid" })}
        <Slider
          label="Cue & loop bars"
          hint={`${settings.markerThickness ?? 2}px`}
          value={settings.markerThickness ?? 2}
          onChange={(v) => set({ markerThickness: v })}
          min={1}
          max={12}
          step={1}
          info="Width of the cue, hot-cue and loop marker bars on the deck waveform."
        />
        <Slider
          label="Playhead"
          hint={`${settings.playheadWidth ?? 2}px`}
          value={settings.playheadWidth ?? 2}
          onChange={(v) => set({ playheadWidth: v })}
          min={1}
          max={8}
          step={1}
          info="Width of the line in the middle of the deck waveform that marks where you are."
        />
        <Slider
          label="Beat grid weight"
          hint={`${(settings.gridWeight ?? 1).toFixed(1)}×`}
          value={settings.gridWeight ?? 1}
          onChange={(v) => set({ gridWeight: v })}
          min={0.5}
          max={3}
          step={0.1}
          info="How heavy the bar, beat and phrase lines are. Above 1× they also get more opaque."
        />
        <Slider
          label="Overview markers"
          hint={`${(settings.overviewMarkerScale ?? 1).toFixed(1)}×`}
          value={settings.overviewMarkerScale ?? 1}
          onChange={(v) => set({ overviewMarkerScale: v })}
          min={1}
          max={2.5}
          step={0.1}
          info="Size of the cue, loop and section marks on the song overview strips: their lines, letters and how close a tap has to be to jump to one."
        />
        <ToggleRow
          label="Waveforms meet in the middle"
          info="Deck B's header goes below its waveform, so the two waveforms touch and lining up beats, bars and cues is a straight line across both."
          on={settings.lanesMeet ?? true}
          onToggle={() => set({ lanesMeet: !(settings.lanesMeet ?? true) })}
        />
        <ToggleRow
          label="Dark edge on markers"
          info="A thin dark outline around cue, loop and hot-cue bars and the playhead, so they stand out over a bright waveform."
          on={settings.markerOutline ?? true}
          onToggle={() => set({ markerOutline: !(settings.markerOutline ?? true) })}
        />
      </div>

      <div className="settings-section color-group">
        <div className="settings-section-head color-group-head">
          <span className="settings-label color-group-title">Surfaces</span>
          <InfoDot label="Surfaces" text="The app around the decks: background, text, the lines between panels, and the highlight SHIFT gives the buttons it changes." />
        </div>
        {swatch({ key: "bgColor", label: "Background" })}
        {swatch({ key: "textColor", label: "Text" })}
        {swatch({ key: "borderColor", label: "Lines" })}
        {swatch({ key: "shiftColor", label: "SHIFT highlight" })}
        {swatch({ key: "slipMoveColor", label: "Censor · brake · spin", def: settings.shiftColor || "#ffd250" }, undefined, !settings.slipMoveColor)}
        <Slider
          label="Contrast"
          hint={settings.uiContrast < 0.25 ? "soft" : settings.uiContrast > 0.8 ? "inky" : "balanced"}
          value={settings.uiContrast ?? DEFAULT_CONTRAST}
          onChange={(v) => set({ uiContrast: v })}
          info="How far panels lift off the background. Soft is a washed grey; inky keeps panels close to the background for the most separation from the text."
        />
      </div>
    </div>
  );
}
