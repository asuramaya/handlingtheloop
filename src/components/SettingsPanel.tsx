import { useEffect, useState } from "react";
import {
  contrastWarnings,
  type Settings,
  type StretchQuality,
  type StretchEngine,
  STRETCH_PRESETS,
  type StemQuality,
  STEM_PRESETS,
  STEM_MODELS,
  getStemModel,
  modelSupport,
  isMobileDevice,
  isChromium,
  fetchStemManifest,
  hasStemsLocal,
  probeWebGPU,
  webGpuAdapterInfo,
  webGpuShaderF16,
  isGpuBlocked,
  unblockGpu,
  stemFailLevel,
  resetStemGuard,
  isUntestedGpuPlatform,
  FREQ_LOW_DEFAULT,
  FREQ_MID_DEFAULT,
  FREQ_HIGH_DEFAULT,
  DEFAULT_CONTRAST,
  type StemModel,
  createKeyProfile,
  duplicateKeyProfile,
  exportKeyProfile,
  parseKeyProfile,
  keyBindingCount,
} from "@htl";
import type { StemStatus, DebugSection } from "../App";
import { KeyMap } from "./KeyHelp";
import { ProfileBar } from "./ProfileBar";
import { type UseMidi } from "@htl/midi";
import { MidiPanel } from "./MidiPanel";
import { ColorProfiles } from "./ColorProfiles";
import { LyricsSettings } from "./LyricsSettings";
import { DockResizer } from "./DockResizer";
import { AboutTab } from "./settings/AboutTab";
import { DebugTab } from "./settings/DebugTab";
import { Slider } from "./settings/Slider";
// Account & connections moved to the full-screen Profile (see ProfileScreen).

interface SettingsPanelProps {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
  loadedVideoIds?: string[]; // tracks currently on the decks (for per-model cache state)
  stemStatus?: Record<"A" | "B", StemStatus | null>; // live per-deck separation status/errors
  onReanalyze?: (modelId: string) => void; // force a fresh separation of the loaded track(s)
  onGpuReenable?: () => void; // user opted to re-enable GPU after a crash auto-disabled it
  outputSupported?: boolean; // browser can route to a chosen output device (AudioContext.setSinkId)
  debug?: () => DebugSection[]; // live engine/session/device diagnostics (Debug tab)
  midi?: UseMidi; // USB-MIDI controller status + learn (MIDI tab)
}

// What each model can do on THIS device, as a short badge for the picker.
function supportBadge(m: StemModel): { text: string; cls: string } {
  switch (modelSupport(m)) {
    case "instant":
      return { text: "Instant", cls: "ok" };
    case "runs":
      // demucs on the CPU backend runs everywhere but is SLOW — set the expectation.
      if (m.tier === "cpu")
        return { text: `Runs here (slow) · ${m.sizeMB} MB`, cls: "warn" };
      return { text: isMobileDevice() ? `Runs on phone · ${m.sizeMB} MB` : `Runs here · ${m.sizeMB} MB`, cls: "ok" };
    case "needs-gpu":
      // On a phone it's gated for memory; on desktop it just needs WebGPU enabled.
      return { text: isMobileDevice() ? "Desktop GPU only" : "Enable WebGPU to run here", cls: "warn" };
    case "blocked":
      return { text: "Disabled — crashed here", cls: "warn" };
    default:
      // Mobile can't separate neural on-device (OOM-crashes Safari) — it's
      // download-only: adopt the stems once a desktop has separated that track.
      return { text: isMobileDevice() ? "Cached only · a desktop separates" : "Desktop separates", cls: "warn" };
  }
}

type Tab = "color" | "controls" | "midi" | "audio" | "debug" | "about";
const TABS: { key: Tab; label: string }[] = [
  { key: "color", label: "Color" },
  { key: "controls", label: "Controls" },
  { key: "midi", label: "MIDI" },
  { key: "audio", label: "Audio" },
  { key: "debug", label: "Debug" },
  { key: "about", label: "About" },
];

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
    desc: "Each deck's signature colour — its waveform, buttons, faders and meter.",
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
    desc: "Markers drawn over the waveforms, plus the waveform body (Strip — unset follows the deck colour).",
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
    desc: "Per-stem waveform colours — they match the DRUM / BASS / VOICE / INST buttons.",
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

// Settings modal, organised into tabs: Color (theme), Deck (feel), Accounts
// (sign-in + streaming cookie), Info (about), FAQ (how it works & privacy).
export function SettingsPanel({
  settings,
  onChange,
  onClose,
  loadedVideoIds = [],
  stemStatus,
  onReanalyze,
  onGpuReenable,
  outputSupported = false,
  debug,
  midi,
}: SettingsPanelProps) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const [tab, setTab] = useState<Tab>("color");

  // Audio OUTPUT devices (speaker select). enumerateDevices only fills in `label`
  // once the page has been granted mic permission at least once; until then the OS
  // hides device names. `outputNeedsPerm` tracks that so we can offer a one-tap
  // "Show device names" that asks for (and immediately drops) a mic stream. Listed
  // only when the Audio tab is open and the browser supports setSinkId.
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [outputNeedsPerm, setOutputNeedsPerm] = useState(false);
  const [outputPermErr, setOutputPermErr] = useState(""); // why a reveal failed (blocked / no device)
  useEffect(() => {
    if (tab !== "audio" || !outputSupported || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
        if (cancelled) return;
        setOutputs(devs);
        // labels blank = permission not yet granted (names hidden by the OS)
        setOutputNeedsPerm(devs.length > 0 && devs.every((d) => !d.label));
      } catch {
        /* enumerate can throw in locked-down contexts; just show none */
      }
    };
    void refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, [tab, outputSupported]);

  // One-shot: ask for mic permission so enumerateDevices reveals output labels,
  // then immediately stop the stream (we never record — we only want the names).
  const revealOutputNames = async () => {
    setOutputPermErr("");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
      setOutputs(devs);
      setOutputNeedsPerm(devs.length > 0 && devs.every((d) => !d.label));
    } catch (e) {
      // Surface WHY instead of silently no-op'ing (the old behaviour looked like the
      // button did nothing). NotAllowedError = blocked by the user OR by a restrictive
      // Permissions-Policy (microphone=()); NotFoundError = no input device.
      const name = e instanceof DOMException ? e.name : "";
      setOutputPermErr(
        name === "NotAllowedError"
          ? "Microphone access is blocked — allow it for this site (it's only used to read device names; nothing is recorded). On the deployed site this needs the latest build."
          : name === "NotFoundError"
            ? "No audio input device found — your OS hides output names until some audio device is available."
            : "Couldn't read device names on this browser.",
      );
    }
  };

  // Per-model cache state for the tracks currently on the decks: a model is
  // "cached" (usable on ANY device, incl. phones) if every loaded track already
  // has its four stems in R2. Probed when the Stems tab is open.
  const [cachedModels, setCachedModels] = useState<Record<string, boolean>>({});
  const loadedKey = loadedVideoIds.join(",");
  // Refresh badges once the real WebGPU-adapter probe resolves (so GPU models flip
  // to "Runs here" the moment WebGPU is actually available).
  const [, setGpuProbed] = useState(false);
  useEffect(() => {
    probeWebGPU().then(() => setGpuProbed(true));
  }, []);
  // A model is "cached for the loaded track(s)" if EVERY loaded track has its stems
  // either on local disk (instant) OR complete in the shared R2 cache. We check
  // local FIRST (cheap, and it's what the "loaded from disk" status reflects) and
  // only hit the network when local misses. The result is NOT blanked on tab/track
  // switches — it persists and is overwritten when the fresh probe resolves, so the
  // badge doesn't flicker. Re-probes when the loaded tracks change OR a separation
  // finishes (a deck reaching a terminal cached/ready/promoted state).
  const doneKey = (["A", "B"] as const)
    .map((d) => {
      const p = stemStatus?.[d]?.phase;
      return p === "ready" || p === "cached" || p === "promoted" ? `${d}:${stemStatus?.[d]?.src ?? ""}` : "";
    })
    .join("|");
  useEffect(() => {
    if (loadedVideoIds.length === 0) {
      setCachedModels({});
      return;
    }
    let cancelled = false;
    (async () => {
      const out: Record<string, boolean> = {};
      for (const m of STEM_MODELS) {
        if (m.kind === "dsp") continue;
        const checks = await Promise.all(
          loadedVideoIds.map(async (v) => {
            if (await hasStemsLocal(v, m.id)) return true;
            const man = await fetchStemManifest(v, m.id).catch(() => null);
            return !!man?.complete;
          }),
        );
        out[m.id] = checks.length > 0 && checks.every(Boolean);
      }
      if (!cancelled) setCachedModels(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey, doneKey]);


  return (
    <div className="modal-backdrop dock-right" onPointerDown={onClose}>
      <DockResizer varName="--dock-w-right" measure="parent" />
      <div className="panel settings-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
        </div>

        <div className="settings-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`settings-tab ${tab === t.key ? "on" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === "color" && (
            <div className="color-tab">
              {/* Header: one-shot rolls to explore, on the right of the intro line. */}
              <div className="color-intro">
                <span className="color-intro-text">Make it yours. Every surface follows the colours below — pick a swatch to change it live.</span>
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
              </div>

              {/* Vividness (band look) + saved/synced/shareable colour profiles. */}
              <ColorProfiles settings={settings} onChange={onChange} />
            </div>
          )}

          {tab === "controls" && (
            <>
              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">Jog feel</span>
                  <button className="link-btn" onClick={() => set({ jogWeight: 0.4, jogDrag: 0.4, jogSensitivity: 1, jogBendStrength: 1, jogVinylDefault: true })}>
                    reset
                  </button>
                </div>
                <Slider
                  label="Weight"
                  hint={settings.jogWeight < 0.2 ? "feather" : settings.jogWeight > 0.7 ? "heavy" : "balanced"}
                  value={settings.jogWeight}
                  onChange={(v) => set({ jogWeight: v })}
                />
                <Slider
                  label="Drag"
                  hint={settings.jogDrag < 0.2 ? "long glide" : settings.jogDrag > 0.7 ? "quick stop" : "balanced"}
                  value={settings.jogDrag}
                  onChange={(v) => set({ jogDrag: v })}
                />
                <Slider
                  label="Sensitivity"
                  hint={settings.jogSensitivity < 0.95 ? "fine" : settings.jogSensitivity > 1.05 ? "fast" : "vinyl"}
                  value={settings.jogSensitivity}
                  onChange={(v) => set({ jogSensitivity: v })}
                  min={0.25}
                  max={4}
                  step={0.05}
                />
                <Slider
                  label="Bend strength"
                  hint={settings.jogBendStrength < 0.95 ? "gentle" : settings.jogBendStrength > 1.05 ? "strong" : "default"}
                  value={settings.jogBendStrength}
                  onChange={(v) => set({ jogBendStrength: v })}
                  min={0.25}
                  max={2}
                  step={0.05}
                />
                <div className="settings-row">
                  <span className="settings-label">Jog default mode</span>
                  <button
                    className={`toggle ${settings.jogVinylDefault ? "on" : ""}`}
                    onClick={() => set({ jogVinylDefault: !settings.jogVinylDefault })}
                    role="switch"
                    aria-checked={settings.jogVinylDefault}
                    title="Starting mode for a controller jog before its VINYL state is known: ON = scratch (vinyl), OFF = bend (CDJ). The wheel re-detects the real mode as soon as you turn it."
                  >
                    {settings.jogVinylDefault ? "scratch" : "bend"}
                  </button>
                </div>
                <div className="settings-row">
                  <span className="settings-label">Wheel seeks (else zooms)</span>
                  <button
                    className={`toggle ${settings.wheelSeeks ? "on" : ""}`}
                    onClick={() => set({ wheelSeeks: !settings.wheelSeeks })}
                    role="switch"
                    aria-checked={settings.wheelSeeks}
                    title="Mouse wheel over a waveform: ON = scrub the playhead (Ctrl/⌘+wheel zooms); OFF = zoom the view"
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">Vinyl Speed Adjust</span>
                  <button className="link-btn" onClick={() => set({ vinylSpeed: true, vinylBrakeTime: 0.22, vinylStartTime: 0.18, backSpinLength: 0.5 })}>
                    reset
                  </button>
                </div>
                <div className="settings-row">
                  <span className="settings-label">Turntable motor</span>
                  <button
                    className={`toggle ${settings.vinylSpeed ? "on" : ""}`}
                    onClick={() => set({ vinylSpeed: !settings.vinylSpeed })}
                    role="switch"
                    aria-checked={settings.vinylSpeed}
                    title="ON = Play spins up and Pause/touch brakes to a stop like a turntable; OFF = instant transport"
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>
                <Slider
                  label="Brake / touch"
                  hint={settings.vinylBrakeTime < 0.1 ? "instant" : settings.vinylBrakeTime > 0.6 ? "slow stop" : "turntable"}
                  value={settings.vinylBrakeTime}
                  onChange={(v) => set({ vinylBrakeTime: v })}
                />
                <Slider
                  label="Start"
                  hint={settings.vinylStartTime < 0.1 ? "instant" : settings.vinylStartTime > 0.6 ? "slow spin-up" : "turntable"}
                  value={settings.vinylStartTime}
                  onChange={(v) => set({ vinylStartTime: v })}
                />
                <Slider
                  label="Back spin length"
                  hint={settings.backSpinLength < 0.34 ? "short" : settings.backSpinLength > 0.66 ? "long" : "normal"}
                  value={settings.backSpinLength}
                  onChange={(v) => set({ backSpinLength: v })}
                />
              </div>

              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">Keyboard profiles</span>
                </div>
                <ProfileBar
                  adapter={{
                    profiles: settings.keyProfiles ?? [],
                    activeId: settings.activeKeyProfileId ?? null,
                    zeroLabel: "Default keys",
                    zeroPayload: () => ({}),
                    snapshotCurrent: () => ({ ...settings.keyBindings }),
                    payloadOf: (p) => p.bindings,
                    buildNew: (name, b) => createKeyProfile(name, b),
                    duplicate: duplicateKeyProfile,
                    updateProfile: (p, b) => ({ ...p, bindings: b, updatedAt: Date.now() }),
                    parseText: parseKeyProfile,
                    exportText: exportKeyProfile,
                    describe: (p) => `${keyBindingCount(p)} custom`,
                    fileExt: "htlkeys.json",
                    noun: "profile",
                    onCommit: ({ profiles, activeId, payload }) =>
                      set({ keyProfiles: profiles, activeKeyProfileId: activeId, ...(payload ? { keyBindings: payload } : {}) }),
                  }}
                />
              </div>

              <div className="settings-section">
                <div className="settings-row">
                  <span className="settings-label">On-button key hints</span>
                  <button
                    className={`toggle ${settings.keyHints ? "on" : ""}`}
                    onClick={() => set({ keyHints: !settings.keyHints })}
                    role="switch"
                    aria-checked={settings.keyHints}
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>
                <KeyMap bindings={settings.keyBindings} onChange={(keyBindings) => set({ keyBindings })} />
              </div>
            </>
          )}

          {tab === "midi" && midi && <MidiPanel midi={midi} settings={settings} onChange={onChange} />}

          {tab === "audio" && (
            <>
              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">Output device</span>
                </div>
                {outputSupported ? (
                  <>
                    <select
                      className="settings-select"
                      value={settings.audioOutputId}
                      onChange={(e) => set({ audioOutputId: e.target.value })}
                    >
                      <option value="">System default</option>
                      {outputs.map((d, i) => (
                        <option key={d.deviceId || i} value={d.deviceId}>
                          {d.label || `Output ${i + 1}`}
                        </option>
                      ))}
                    </select>
                    {outputNeedsPerm && (
                      <p className="settings-hint muted">
                        Device names are hidden until you grant audio permission once.{" "}
                        <button className="link-btn" onClick={revealOutputNames}>
                          Show device names
                        </button>
                      </p>
                    )}
                    {outputPermErr && <p className="settings-hint" style={{ color: "#ffd250" }}>{outputPermErr}</p>}
                  </>
                ) : (
                  <p className="settings-hint muted">
                    This browser can’t switch the output device (Chrome or Edge can). Use your system sound settings to
                    choose a speaker.
                  </p>
                )}
              </div>

              {outputSupported && (
                <div className="settings-section">
                  <div className="settings-section-head">
                    <span className="settings-label">Cue / Headphone</span>
                  </div>
                  <select
                    className="settings-select"
                    value={settings.audioCueOutputId}
                    onChange={(e) => set({ audioCueOutputId: e.target.value })}
                  >
                    <option value="">None — single output</option>
                    {outputs.map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>
                        {d.label || `Output ${i + 1}`}
                      </option>
                    ))}
                  </select>
                  <p className="settings-hint muted">
                    Pick a second device (headphones) to pre-listen each deck like a DJ board. The deck’s <strong>CUE</strong>{" "}
                    button becomes a fader — tap still sets / jumps the cue point, drag or scroll sets its headphone level.
                    Tapped pre-fader, so you can cue a deck that’s faded out.
                  </p>
                  {outputNeedsPerm && (
                    <p className="settings-hint muted">
                      Device names are hidden until you grant audio permission once.{" "}
                      <button className="link-btn" onClick={revealOutputNames}>
                        Show device names
                      </button>
                    </p>
                  )}
                </div>
              )}

              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">Stretch engine</span>
                </div>
                <div className="seg">
                  {([
                    ["wsola", "WSOLA"],
                    ["pv", "Phase-locked"],
                  ] as [StretchEngine, string][]).map(([e, label]) => (
                    <button
                      key={e}
                      className={`seg-btn ${settings.stretchEngine === e ? "on" : ""}`}
                      onClick={() => set({ stretchEngine: e })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="settings-hint muted">
                  {settings.stretchEngine === "pv"
                    ? "Phase-locked vocoder — cleanest on full mixes (kills the metallic edge), more CPU."
                    : "Time-domain WSOLA — lightest CPU, crisp transients; can sound metallic on dense mixes."}
                </p>
                <div className="seg">
                  {(Object.keys(STRETCH_PRESETS) as StretchQuality[]).map((q) => (
                    <button
                      key={q}
                      className={`seg-btn ${settings.stretchQuality === q ? "on" : ""}`}
                      onClick={() => set({ stretchQuality: q })}
                    >
                      {STRETCH_PRESETS[q].label}
                    </button>
                  ))}
                </div>
                <p className="settings-hint muted">
                  ~{STRETCH_PRESETS[settings.stretchQuality].latencyMs} ms latency · grain{" "}
                  {STRETCH_PRESETS[settings.stretchQuality].frame}
                </p>
                <div className="settings-row">
                  <span className="settings-label">Transient preservation</span>
                  <button
                    className={`toggle ${settings.stretchTransient ? "on" : ""}`}
                    onClick={() => set({ stretchTransient: !settings.stretchTransient })}
                    role="switch"
                    aria-checked={settings.stretchTransient}
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>
                {settings.stretchTransient && (
                  <Slider
                    label="Transient threshold"
                    hint={settings.stretchTThresh <= 1.7 ? "sensitive" : settings.stretchTThresh >= 3 ? "strict" : "balanced"}
                    value={settings.stretchTThresh}
                    onChange={(v) => set({ stretchTThresh: v })}
                    min={1.3}
                    max={4}
                    step={0.1}
                  />
                )}
                <div className="settings-row">
                  <span className="settings-label">Anti-alias pitch-up</span>
                  <button
                    className={`toggle ${settings.stretchAa ? "on" : ""}`}
                    onClick={() => set({ stretchAa: !settings.stretchAa })}
                    role="switch"
                    aria-checked={settings.stretchAa}
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>
                <p className="settings-hint muted">
                  Keep attacks crisp under big tempo stretch; remove fizz on key-ups.
                </p>
              </div>

              {isGpuBlocked() && (
                <div className="stem-blocked-banner">
                  <span>GPU stem separation crashed and was disabled. CPU models and cached results still work.</span>
                  <button
                    className="link-btn"
                    onClick={() => {
                      unblockGpu();
                      onGpuReenable?.();
                    }}
                  >
                    Re-enable GPU
                  </button>
                </div>
              )}

              {(stemStatus?.A || stemStatus?.B) && (
                <div className="settings-section">
                  <div className="settings-section-head">
                    <span className="settings-label">Stem status</span>
                  </div>
                  {(["A", "B"] as const).map((d) => {
                    const st = stemStatus?.[d];
                    if (!st) return null;
                    return (
                      <div key={d} className={`stem-status-row ${st.phase}`}>
                        <span className="stem-status-deck">{d}</span>
                        <span className="stem-status-detail">{st.detail}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">{isMobileDevice() ? "Stems" : "Stem separation"}</span>
                </div>
                {isMobileDevice() ? (
                  <>
                  <div className="settings-row">
                    <span className="settings-label">
                      Split tracks into stems
                      <span className="settings-sub muted"> · on-device · per-stem mixer + colours</span>
                    </span>
                    <button
                      className={`toggle ${settings.mobileStems ? "on" : ""}`}
                      onClick={() => set({ mobileStems: !settings.mobileStems })}
                      role="switch"
                      aria-checked={settings.mobileStems}
                    >
                      <span className="toggle-knob" />
                    </button>
                  </div>
                  <div className="stem-mobile-note">
                    Off keeps the lightest plain mix. On splits every loaded deck on-device (or adopts the shared
                    cache when a desktop already made them). Auto-DJ turns this on while it runs.
                    {stemFailLevel() > 0 && (
                      <>
                        {" "}
                        Downgraded after a crash —{" "}
                        <button
                          className="link-btn"
                          onClick={() => {
                            resetStemGuard();
                            location.reload();
                          }}
                        >
                          retry full quality
                        </button>
                        .
                      </>
                    )}
                  </div>
                  </>
                ) : (
                  <div className="stem-models">
                    {STEM_MODELS
                      // Open-Unmix is retired from the picker — HT-Demucs (GPU) is the only
                      // neural splitter we offer now. The registry entry stays so already-
                      // cached umx stems still resolve; it's just no longer selectable.
                      .filter((m) => m.arch !== "openunmix")
                      // GPU/demucs is hidden on phones (WebGPU OOM-crashes Safari); the
                      // rest stay, shown as download-only on mobile.
                      .filter((m) => !(isMobileDevice() && m.tier === "gpu"))
                      // The fp16 demucs model only works where the adapter exposes shader-f16
                      // (absent on today's Linux+NVIDIA WebGPU → its f16 shaders → noise). Hide
                      // it until the feature appears, then it auto-shows.
                      .filter((m) => !m.needsShaderF16 || webGpuShaderF16())
                      .map((m) => {
                        const sup = modelSupport(m);
                        const badge = supportBadge(m);
                        const cached = cachedModels[m.id];
                        const blocked = sup === "blocked" && !cached;
                        const untested = m.tier === "gpu" && sup === "runs" && isUntestedGpuPlatform();
                        return (
                          <button
                            key={m.id}
                            className={`stem-model ${settings.stemModel === m.id ? "on" : ""} ${blocked ? "blocked" : ""} ${
                              untested ? "untested" : ""
                            }`}
                            disabled={blocked}
                            onClick={() => !blocked && set({ stemModel: m.id })}
                          >
                            <span className="stem-model-label">
                              {m.label}
                              {m.kind !== "dsp" && <span className={`stem-badge ${badge.cls}`}>{badge.text}</span>}
                              {untested && <span className="stem-badge warn">Untested here — may crash</span>}
                              {cached && <span className="stem-badge cached">✓ cached for loaded track</span>}
                            </span>
                            <span className="stem-model-note">{m.note}</span>
                          </button>
                        );
                      })}
                  </div>
                )}

                {!isMobileDevice() && (
                  <div className="settings-row stem-autoenhance">
                    <span className="settings-label">
                      Auto-enhance
                      <span className="settings-sub muted"> · use cached neural stems when a track has them</span>
                    </span>
                    <button
                      className={`toggle ${settings.autoEnhance ? "on" : ""}`}
                      onClick={() => set({ autoEnhance: !settings.autoEnhance })}
                      role="switch"
                      aria-checked={settings.autoEnhance}
                      title="When a track already has cached neural stems, use them automatically instead of the plain mix"
                    >
                      <span className="toggle-knob" />
                    </button>
                  </div>
                )}

                {!isMobileDevice() && getStemModel(settings.stemModel).tier === "gpu" && (
                  <div className="stem-quality">
                    <div className="settings-section-head">
                      <span className="settings-label">Separation quality</span>
                      <span className="settings-sub muted">{STEM_PRESETS[settings.stemQuality].mult} compute</span>
                    </div>
                    <div className="seg">
                      {(Object.keys(STEM_PRESETS) as StemQuality[]).map((q) => (
                        <button
                          key={q}
                          className={`seg-btn ${settings.stemQuality === q ? "on" : ""}`}
                          onClick={() => set({ stemQuality: q })}
                        >
                          {STEM_PRESETS[q].label}
                        </button>
                      ))}
                    </div>
                    <p className="settings-hint muted">{STEM_PRESETS[settings.stemQuality].blurb}</p>
                  </div>
                )}

                {(() => {
                  const sel = getStemModel(settings.stemModel);
                  if (sel.kind === "dsp" || isMobileDevice()) return null;
                  const canReanalyze = modelSupport(sel) === "runs" && loadedVideoIds.length > 0 && !!onReanalyze;
                  return (
                    <button
                      className="stem-reanalyze"
                      disabled={!canReanalyze}
                      onClick={() => canReanalyze && onReanalyze?.(sel.id)}
                      title={
                        loadedVideoIds.length === 0
                          ? "Load a track first"
                          : modelSupport(sel) !== "runs"
                            ? `${sel.label} can't be separated on this device`
                            : `Re-run ${sel.label} on the loaded track(s), overwriting the cached stems`
                      }
                    >
                      ↻ Re-analyze loaded track{loadedVideoIds.length > 1 ? "s" : ""} with {sel.label}
                    </button>
                  );
                })()}
                {!isMobileDevice() && (() => {
                  const sel = getStemModel(settings.stemModel);
                  const gpu = sel.tier === "gpu";
                  const sup = modelSupport(sel);
                  const chromium = isChromium();
                  // A GPU-tier model only runs on the GPU under CHROMIUM; on Safari/
                  // Firefox the worker runs this same model on the stable wasm CPU EP
                  // (the JSEP/WebGPU path is Chromium-only — see isChromium). Show what's
                  // actually in play so the speed expectation is honest.
                  const onGpu = gpu && chromium && sup === "runs";
                  const adapter = webGpuAdapterInfo();
                  const kind = gpu ? (chromium ? (sup === "runs" ? "gpu" : "none") : "cpu") : "cpu";
                  const text = gpu
                    ? chromium
                      ? onGpu
                        ? adapter || "WebGPU"
                        : sup === "blocked"
                          ? "Disabled after a crash — re-enable above, or use a CPU model / cached result"
                          : "WebGPU not available here — pick a CPU model, or use a cached result"
                      : "Runs on CPU here (wasm SIMD) — slower than a Chromium GPU, but stable. The result caches for everyone."
                    : sel.kind === "dsp"
                      ? "Plain mix · no stem separation"
                      : "Neural · ORT WebAssembly";
                  return (
                    <div className={`stem-device ${kind}`}>
                      <span className="stem-device-tag">{gpu && chromium ? "GPU" : "CPU"}</span>
                      <span className="stem-device-text">{text}</span>
                    </div>
                  );
                })()}
              </div>

              <LyricsSettings settings={settings} onChange={onChange} />
            </>
          )}


          {tab === "debug" && <DebugTab midi={midi} debug={debug} />}

          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </div>
  );
}


