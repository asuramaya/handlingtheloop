// Settings ▸ Controls — jog feel, hardware jog wheel, Vinyl Speed Adjust motor, keyboard
// profiles + the key map. Pure render of (settings, set); no local state.
//
// ★ Written in the shared settings grammar (see the block comment atop settings.css): a CARD
// per group, a ROW per control (`label ⓘ ......... [value] [control]`), and every explanation
// behind an InfoDot rather than set as prose. This tab used to carry three paragraphs and
// fourteen `title=` attributes — the paragraphs outweighed the controls they introduced, and a
// native tooltip is mouse-only, so on a touch device half the explanations did not exist at all.
import type { DockMode, PanelKey, Settings } from "@htl";
import { KeyMap } from "../KeyHelp";
import { Slider } from "./Slider";
import { InfoDot } from "./InfoDot";

const DOCK_MODES: DockMode[] = ["left", "right", "center", "bottom"];

const PANEL_LABEL: Record<PanelKey, string> = { library: "Library", settings: "Settings", people: "People", session: "Session" };
const PANEL_DOCK_FIELD: Record<PanelKey, "libraryDock" | "settingsDock" | "peopleDock" | "sessionDock"> = {
  library: "libraryDock",
  settings: "settingsDock",
  people: "peopleDock",
  session: "sessionDock",
};

// A switch row in the shared grammar. Every toggle on this tab was the same nine lines of JSX
// with three words changed; the repetition is what let their labels and titles drift apart.
function ToggleRow({
  label,
  info,
  on,
  onToggle,
}: {
  label: string;
  info: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="settings-row">
      <span className="settings-label">
        {label}
        <InfoDot text={info} label={label} />
      </span>
      <button className={`toggle ${on ? "on" : ""}`} onClick={onToggle} role="switch" aria-checked={on} aria-label={label}>
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

// One panel's placement row: a ▲▼ stack-order pair, its label, and a Left/Right/Center/Bottom
// segmented pick — all four (Library/Settings/People/Session) share one "Panel placement"
// card. Row ORDER on screen doubles as the stack order it controls (top row = top of the
// stack), so dragging isn't needed to see or change "who's on top" — moving a row up IS
// moving it up. onMoveUp/onMoveDown are undefined at the two ends (nowhere left to go), which
// disables that button rather than wrapping around.
function PlacementRow({
  label,
  value,
  onChange,
  onMoveUp,
  onMoveDown,
}: {
  label: string;
  value: DockMode;
  onChange: (m: DockMode) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  return (
    <div className="settings-row">
      <span className="settings-label">
        <span className="mini-stack">
          <button className="mini" onClick={onMoveUp} disabled={!onMoveUp} aria-label={`Move ${label} up the stack`}>
            ▲
          </button>
          <button className="mini" onClick={onMoveDown} disabled={!onMoveDown} aria-label={`Move ${label} down the stack`}>
            ▼
          </button>
        </span>
        {label}
      </span>
      <span className="settings-control">
        <span className="seg-group">
          {DOCK_MODES.map((m) => (
            <button key={m} className={`hw-btn small ${value === m ? "on" : ""}`} onClick={() => onChange(m)}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </span>
      </span>
    </div>
  );
}

export function ControlsTab({
  settings,
  set,
  onePanel = false,
}: {
  settings: Settings;
  set: (patch: Partial<Settings>) => void;
  /** This viewport has ONE panel slot (see htl/state/usePhone ▸ ONE_PANEL_QUERY). The panel
   *  placement controls are hidden rather than shown-and-inert — see the block below. */
  onePanel?: boolean;
}) {
  return (
    <>
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Jog feel</span>
          <InfoDot
            text="How the platter responds when you grab it and let go, by mouse or touch. Play, Pause and Spinback have their own timing under Vinyl Speed Adjust."
            label="Jog feel"
          />
          <button className="link-btn" onClick={() => set({ jogWeight: 0.4, jogDrag: 0.4 })}>
            reset
          </button>
        </div>
        <Slider
          label="Weight"
          hint={settings.jogWeight < 0.2 ? "feather" : settings.jogWeight > 0.7 ? "heavy" : "balanced"}
          value={settings.jogWeight}
          onChange={(v) => set({ jogWeight: v })}
          info="A released platter's inertia. Heavier takes longer both to settle to a stop and to catch back up to play."
        />
        <Slider
          label="Drag"
          hint={settings.jogDrag < 0.2 ? "long glide" : settings.jogDrag > 0.7 ? "quick stop" : "balanced"}
          value={settings.jogDrag}
          onChange={(v) => set({ jogDrag: v })}
          info="How quickly a platter grips still. Only matters when a release settles to a stop, which means the deck is paused, or the release was too gentle to catch back up to play."
        />
        <ToggleRow
          label="Slip mode"
          info="Scratch, hold or loop over the track without losing your place. On release, playback snaps to where it would have been, on the beat, skipping the coast that Weight and Drag would otherwise give it. Toggle key: Z."
          on={settings.slip}
          onToggle={() => set({ slip: !settings.slip })}
        />
        <ToggleRow
          label="Mouse-wheel scrub"
          info="What the scroll wheel does over a waveform, not the jog wheel above. On, it scrubs the playhead and Ctrl or ⌘ plus wheel zooms. Off, the wheel zooms."
          on={settings.wheelSeeks}
          onToggle={() => set({ wheelSeeks: !settings.wheelSeeks })}
        />
      </div>

      {/* AUTO's taste, not its competence. The structural half of a transition — beatmatch, bass
          swap, gain staging, where the mix starts and ends — is not on this dial and never will
          be. This is only how much flourish sits on top, which is a preference, so it belongs to
          the user rather than to a heuristic. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Auto-DJ performance</span>
          <InfoDot
            text="How much flourish AUTO adds on top of the mix itself. Subtle beatmatches and blends and nothing else. Standard adds the small human touches — a treble lift as the new track takes over, a hot cue parked on its drop. Showy also reaches for the dramatic gestures: echo throws, gate stutters, spinbacks, cutting straight to a drop. None of them changes which track plays next."
            label="Auto-DJ performance"
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Flourish</span>
          <span className="settings-control">
            <span className="seg-group">
              {(["subtle", "standard", "showy"] as const).map((v) => (
                <button
                  key={v}
                  className={`hw-btn small ${settings.autoPerformance === v ? "on" : ""}`}
                  onClick={() => set({ autoPerformance: v })}
                  aria-pressed={settings.autoPerformance === v}
                >
                  {v[0].toUpperCase() + v.slice(1)}
                </button>
              ))}
            </span>
          </span>
        </div>

        {/* The auto-DJ's transition EFFECT is deliberately not here. It lives in a chain named
            AUTO in each deck's own rack, where every other effect in this app is dialled — put a
            reverb in it, or a delay, or three things, and set them however you like. AUTO only
            routes a stem into it for the length of a transition. Editing an effect from a settings
            tab meant leaving the instrument to adjust the instrument. */}
      </div>

      {/* Its own card, not a paragraph in the middle of the one above. These two sliders apply
          to hardware only, and a mid-card sentence saying so both broke the row grammar and was
          easy to read as applying to whatever you happened to be looking at. A card boundary
          states the same scope structurally, which is harder to misread and impossible to skip. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Hardware jog wheel</span>
          <InfoDot
            text="MIDI jog wheels only. Scratching with a mouse or a finger ignores both of these and uses Jog feel above."
            label="Hardware jog wheel"
          />
          <button className="link-btn" onClick={() => set({ jogSensitivity: 1, jogBendStrength: 1 })}>
            reset
          </button>
        </div>
        <Slider
          label="Sensitivity"
          hint={settings.jogSensitivity < 0.95 ? "fine" : settings.jogSensitivity > 1.05 ? "fast" : "vinyl"}
          value={settings.jogSensitivity}
          onChange={(v) => set({ jogSensitivity: v })}
          min={0.25}
          max={4}
          step={0.05}
          info="How far the track moves per encoder tick when you scratch or search on a hardware jog wheel."
        />
        <Slider
          label="Bend strength"
          hint={settings.jogBendStrength < 0.95 ? "gentle" : settings.jogBendStrength > 1.05 ? "strong" : "default"}
          value={settings.jogBendStrength}
          onChange={(v) => set({ jogBendStrength: v })}
          min={0.25}
          max={2}
          step={0.05}
          info="How hard a turn of the jog wheel's outer edge nudges pitch, without touching the top. The push-to-bend feel."
        />
      </div>

      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Vinyl Speed Adjust</span>
          <InfoDot
            text="How Play, Pause and Spinback spin the platter up and down like a real motor. Grabbing the jog wheel is separate, under Jog feel."
            label="Vinyl Speed Adjust"
          />
          <button className="link-btn" onClick={() => set({ vinylSpeed: true, vinylBrakeTime: 0.22, vinylStartTime: 0.18, backSpinLength: 0.5 })}>
            reset
          </button>
        </div>
        <ToggleRow
          label="Turntable motor"
          info="On, Play spins up and Pause brakes to a stop like a turntable. Off, both are instant. Spinback works either way: it is a gesture, not a motor setting."
          on={settings.vinylSpeed}
          onToggle={() => set({ vinylSpeed: !settings.vinylSpeed })}
        />
        <Slider
          label="Start"
          hint={settings.vinylStartTime < 0.1 ? "instant" : settings.vinylStartTime > 0.6 ? "slow spin-up" : "turntable"}
          value={settings.vinylStartTime}
          onChange={(v) => set({ vinylStartTime: v })}
          info="The Play button's spin-up, and only that: a motor catching the platter up to speed. Releasing a grabbed jog wheel back into play uses Weight instead."
        />
        <Slider
          label="Brake / touch"
          hint={settings.vinylBrakeTime < 0.1 ? "instant" : settings.vinylBrakeTime > 0.6 ? "slow stop" : "turntable"}
          value={settings.vinylBrakeTime}
          onChange={(v) => set({ vinylBrakeTime: v })}
          info="The Pause button's spin-down, and only that: a hand stopping the platter. Letting go of a grabbed jog wheel uses Weight and Drag instead."
        />
        <Slider
          label="Back spin length"
          hint={settings.backSpinLength < 0.34 ? "short" : settings.backSpinLength > 0.66 ? "long" : "normal"}
          value={settings.backSpinLength}
          onChange={(v) => set({ backSpinLength: v })}
          info="How far back it throws, and how long the motor takes to catch it up to play again. Applies to both the Spinback key or pad and a hard backward flick-release of the jog wheel."
        />
      </div>

      {/* The "Keyboard profiles" card was here. It is the panel-header control now — the same
          one Color, MIDI and Audio use, which is the point: a keymap and a colour theme are the
          same KIND of thing, and three tabs each drawing their own save bar said they were not. */}

      {/* Where each floating panel sits. Every option is an overlay — none of them push or
          resize the board, unlike the old single left/right docks (which used to squeeze the
          stage, flipped by a chin ⇄ button that's gone now that each panel picks its own
          placement here instead of one global swap). Left/Right are resizable-width edge docks;
          Bottom is a resizable-height sheet across the full width (Library really wants this —
          the pick for reading a wide track table over the deck-controls strip — but it's
          available to the others too). Center is a plain centered modal, sized to content.

          ★ AND ON A PHONE IT IS NOT SHOWN AT ALL, because there is nothing here it could mean.
          A phone has one panel slot; every panel fills it; placement, stack order and dim are
          all answers to questions that only exist when two panels can be on screen at once.
          The old copy handled this by writing "Desktop only" in the label and rendering the
          full working control anyway — four live segmented pickers, a stack order you could
          reorder, and a dim slider, all of which appeared to do something and did nothing. A
          control that is present but inert teaches people to stop trusting the panel it's in.
          A sentence saying why is smaller AND more honest than a control that lies. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Panel placement</span>
          <InfoDot
            text="Every option floats over the board rather than squeezing it. Left/Right: a resizable-width dock pinned to that edge. Bottom: a resizable-height sheet across the full width, over the deck controls. Center: a plain centered window, sized to content. The ▲▼ on each row sets the STACK order for when two panels share an edge — the top row always renders above the ones below it. Center panels ignore that order: whichever one you opened most recently is on top, like any other stack of modals."
            label="Panel placement"
          />
        </div>
        {onePanel && (
          <p className="settings-hint">
            This screen shows one panel at a time, full-screen — Library, Settings, People and
            Session each take the whole view and the chin switches between them. Placement,
            stack order and dimming are desktop settings; open Handling The Loop on a larger
            screen to change them. A tablet counts as a larger screen.
          </p>
        )}
        {!onePanel &&
          settings.panelOrder.map((key, i) => (
          <PlacementRow
            key={key}
            label={PANEL_LABEL[key]}
            value={settings[PANEL_DOCK_FIELD[key]]}
            onChange={(m) => set({ [PANEL_DOCK_FIELD[key]]: m } as Partial<Settings>)}
            onMoveUp={
              i > 0
                ? () => {
                    const order = [...settings.panelOrder];
                    [order[i - 1], order[i]] = [order[i], order[i - 1]];
                    set({ panelOrder: order });
                  }
                : undefined
            }
            onMoveDown={
              i < settings.panelOrder.length - 1
                ? () => {
                    const order = [...settings.panelOrder];
                    [order[i], order[i + 1]] = [order[i + 1], order[i]];
                    set({ panelOrder: order });
                  }
                : undefined
            }
          />
          ))}
        {!onePanel && (
          <Slider
            label="Dimming"
            hint={`${Math.round(settings.panelDim * 100)}%`}
            value={settings.panelDim}
            onChange={(v) => set({ panelDim: v })}
            info="How much the backdrop dims (and blurs) behind a Center-placed panel — the two are tied to one control, so 0% is genuinely no effect rather than just no colour tint. Doesn't affect Left/Right/Bottom docks (there's nothing exposed behind their footprint to dim), and doesn't affect a phone either: a full-screen panel IS the screen, so it is opaque rather than dimmed by however much you set here."
          />
        )}
      </div>

      {/* THE key map, and now the only one. The chin's "?" button opened a modal whose whole
          content was this same <KeyMap> over these same bindings; it is gone. This card was
          headless, which was fine while a second door existed and is not now — it is the
          destination, so it says what it is. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Key map</span>
          <InfoDot
            text="Every keyboard action, with its key. Click a key chip and press a new key to rebind it; each action also has a second, empty slot if you want two keys for it. Keys are stored by physical position, so a map made on one keyboard layout still works on another. The keys drive whichever deck has focus."
            label="Key map"
          />
        </div>
        <ToggleRow
          label="On-button key hints"
          info="Print each button's key in its corner, on the board itself. Desktop only, since a touch device has no keyboard to hint at."
          on={settings.keyHints}
          onToggle={() => set({ keyHints: !settings.keyHints })}
        />
        <KeyMap bindings={settings.keyBindings} onChange={(keyBindings) => set({ keyBindings })} />
      </div>
    </>
  );
}
