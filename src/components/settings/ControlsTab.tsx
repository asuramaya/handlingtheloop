// Settings ▸ Controls — waveform wheel, Auto-DJ flourish, panel placement and the key map (the
// jog's controls live in Settings ▸ Platter). Pure render of (settings, set); no local state.
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
export function ToggleRow({
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
      {/* The jog's own controls moved to Settings ▸ Platter (one card, drawn). This one is NOT a
          jog setting — it is what the scroll wheel does over a waveform — so it stays here. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Waveform</span>
        </div>
        <ToggleRow
          label="Mouse-wheel scrub"
          info="What the scroll wheel does over a waveform. On, it scrubs the playhead and Ctrl or ⌘ plus wheel zooms. Off, the wheel zooms."
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
