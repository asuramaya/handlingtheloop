// Settings ▸ Controls — jog feel, Vinyl Speed Adjust motor, keyboard profiles + keymap.
// Pure render of (settings, set); no local state.
import type { Settings } from "@htl";
import { createKeyProfile, duplicateKeyProfile, exportKeyProfile, parseKeyProfile, keyBindingCount } from "@htl";
import { KeyMap } from "../KeyHelp";
import { ProfileBar } from "../ProfileBar";
import { Slider } from "./Slider";

export function ControlsTab({ settings, set }: { settings: Settings; set: (patch: Partial<Settings>) => void }) {
  return (
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
  );
}
