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
          <button className="link-btn" onClick={() => set({ jogWeight: 0.4, jogDrag: 0.4, jogSensitivity: 1, jogBendStrength: 1 })}>
            reset
          </button>
        </div>
        <p className="settings-hint">
          How the platter responds when you grab it and let go, by mouse, touch or MIDI jog wheel. Play/Pause and
          Spinback have their own timing below.
        </p>
        <Slider
          label="Weight"
          hint={settings.jogWeight < 0.2 ? "feather" : settings.jogWeight > 0.7 ? "heavy" : "balanced"}
          value={settings.jogWeight}
          onChange={(v) => set({ jogWeight: v })}
          title="A released platter's inertia — heavier takes longer both to settle to a stop AND to catch back up to play."
        />
        <Slider
          label="Drag"
          hint={settings.jogDrag < 0.2 ? "long glide" : settings.jogDrag > 0.7 ? "quick stop" : "balanced"}
          value={settings.jogDrag}
          onChange={(v) => set({ jogDrag: v })}
          title="Only matters when a release settles to a STOP (deck paused, or too gentle to catch back up to play) — how quickly it grips still."
        />
        <div className="settings-row">
          <span className="settings-label">Slip mode (scrub returns on release)</span>
          <button
            className={`toggle ${settings.slip ? "on" : ""}`}
            onClick={() => set({ slip: !settings.slip })}
            role="switch"
            aria-checked={settings.slip}
            title="Scratch / hold / loop over the track without losing your place — on release, playback snaps to where it WOULD be (on-beat), skipping Weight/Drag's coast entirely. Toggle key: Z"
          >
            <span className="toggle-knob" />
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-label">Mouse-wheel scrub (else zooms)</span>
          <button
            className={`toggle ${settings.wheelSeeks ? "on" : ""}`}
            onClick={() => set({ wheelSeeks: !settings.wheelSeeks })}
            role="switch"
            aria-checked={settings.wheelSeeks}
            title="The SCROLL wheel over a waveform (not the jog wheel above): ON = scrub the playhead (Ctrl/⌘+wheel zooms); OFF = zoom the view"
          >
            <span className="toggle-knob" />
          </button>
        </div>
        <p className="settings-hint">MIDI jog wheel only. Mouse and touch scratching ignore these three.</p>
        <Slider
          label="Sensitivity"
          hint={settings.jogSensitivity < 0.95 ? "fine" : settings.jogSensitivity > 1.05 ? "fast" : "vinyl"}
          value={settings.jogSensitivity}
          onChange={(v) => set({ jogSensitivity: v })}
          min={0.25}
          max={4}
          step={0.05}
          title="How far the track moves per encoder tick when scratching/searching on a hardware jog wheel."
        />
        <Slider
          label="Bend strength"
          hint={settings.jogBendStrength < 0.95 ? "gentle" : settings.jogBendStrength > 1.05 ? "strong" : "default"}
          value={settings.jogBendStrength}
          onChange={(v) => set({ jogBendStrength: v })}
          min={0.25}
          max={2}
          step={0.05}
          title="How hard a passive (un-touched) turn of the hardware jog wheel nudges pitch — the 'push to bend' feel."
        />
      </div>

      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Vinyl Speed Adjust</span>
          <button className="link-btn" onClick={() => set({ vinylSpeed: true, vinylBrakeTime: 0.22, vinylStartTime: 0.18, backSpinLength: 0.5 })}>
            reset
          </button>
        </div>
        <p className="settings-hint">
          How the Play/Pause buttons and the Spinback key spin the platter up and down like a real motor. Grabbing the
          jog wheel is separate, above.
        </p>
        <div className="settings-row">
          <span className="settings-label">Turntable motor</span>
          <button
            className={`toggle ${settings.vinylSpeed ? "on" : ""}`}
            onClick={() => set({ vinylSpeed: !settings.vinylSpeed })}
            role="switch"
            aria-checked={settings.vinylSpeed}
            title="ON = Play spins up and Pause brakes to a stop like a turntable; OFF = both are instant. Spinback always works either way — it's a gesture, not a motor setting."
          >
            <span className="toggle-knob" />
          </button>
        </div>
        <Slider
          label="Start"
          hint={settings.vinylStartTime < 0.1 ? "instant" : settings.vinylStartTime > 0.6 ? "slow spin-up" : "turntable"}
          value={settings.vinylStartTime}
          onChange={(v) => set({ vinylStartTime: v })}
          title="The PLAY button's spin-up, only — a motor catching the platter to speed. A natural release back to play instead uses Weight above."
        />
        <Slider
          label="Brake / touch"
          hint={settings.vinylBrakeTime < 0.1 ? "instant" : settings.vinylBrakeTime > 0.6 ? "slow stop" : "turntable"}
          value={settings.vinylBrakeTime}
          onChange={(v) => set({ vinylBrakeTime: v })}
          title="The PAUSE button's spin-down, only — a grip stopping the platter. Letting go of a grabbed jog wheel instead uses Weight/Drag above."
        />
        <Slider
          label="Back spin length"
          hint={settings.backSpinLength < 0.34 ? "short" : settings.backSpinLength > 0.66 ? "long" : "normal"}
          value={settings.backSpinLength}
          onChange={(v) => set({ backSpinLength: v })}
          title="How far back it throws and how long the motor takes to catch it back up to play — for BOTH the Spinback key/pad and a hard backward flick-release of the jog wheel."
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
