import { useState } from "react";
import { type PanelPlacement, type Settings } from "@htl";
import type { StemStatus, DebugSection } from "../App";
import { type UseMidi } from "@htl/midi";
import { MidiPanel } from "./MidiPanel";
import { CenterResizeHandles, DockPlacementResizer, panelZIndex, useCenterZIndex } from "./DockResizer";
import { ProfileBar } from "./ProfileBar";
import { profilesForTab } from "./settings/profileAdapters";
import { AboutTab } from "./settings/AboutTab";
import { AudioTab } from "./settings/AudioTab";
import type { LyricDeck } from "./LyricsSettings";
import { ColorTab } from "./settings/ColorTab";
import { ControlsTab } from "./settings/ControlsTab";
import { DebugTab } from "./settings/DebugTab";
// Account & connections moved to the full-screen Profile (see ProfileScreen).

interface SettingsPanelProps {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
  loadedVideoIds?: string[]; // tracks currently on the decks (for per-model cache state)
  stemStatus?: Record<"A" | "B", StemStatus | null>; // live per-deck separation status/errors
  loadedDecks?: { id: "A" | "B"; neural: boolean; hasStems: boolean; model: string | null }[];
  onReanalyze?: (modelId: string, deck?: "A" | "B") => void; // fresh separation of one deck (or all)
  lyricDecks?: LyricDeck[]; // per-deck lyric state (source/line count/live progress) — the "are they firing?" readout
  onRetranscribe?: (deck: "A" | "B") => void; // wipe one deck's transcript and re-resolve it
  onGpuReenable?: () => void; // user opted to re-enable GPU after a crash auto-disabled it
  outputSupported?: boolean; // browser can route to a chosen output device (AudioContext.setSinkId)
  debug?: () => DebugSection[]; // live engine/session/device diagnostics (Debug tab)
  midi?: UseMidi; // USB-MIDI controller status + learn (MIDI tab)
  dockMode?: PanelPlacement; // RESOLVED placement from App (never the raw setting) — "sheet" on a phone
  onePanel?: boolean; // this viewport has ONE panel slot, so Controls hides what it cannot honour
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

// Settings modal, organised into tabs: Color (theme), Deck (feel), Accounts
// (sign-in), Info (about), FAQ (how it works & privacy).
export function SettingsPanel({
  settings,
  onChange,
  onClose,
  loadedVideoIds = [],
  loadedDecks = [],
  stemStatus,
  onReanalyze,
  lyricDecks = [],
  onRetranscribe,
  onGpuReenable,
  outputSupported = false,
  debug,
  midi,
  dockMode = "right",
  onePanel = false,
}: SettingsPanelProps) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const [tab, setTab] = useState<Tab>("color");
  // ★ ONE SAVE/SHARE/MANAGE CONTROL, IN THE HEADER, FOR THE WHOLE PANEL. It used to be an
  // inline bar per tab — Color, Controls and MIDI each grew their own, and Audio, the tab whose
  // setup most wants carrying between machines, had none. Three copies of one idea plus a hole.
  // Now it lives on the title line and simply changes what it operates on with the tab, which is
  // also what made Audio's missing profiles a two-line fix instead of a fourth bar.
  const tabProfiles = profilesForTab(tab, settings, onChange, midi);
  // This component only exists in the DOM while open (App conditionally mounts it), so mount
  // itself IS "just opened" — no separate open/close transition to track like Library's.
  const centerZ = useCenterZIndex(dockMode, true);
  const zIndex = panelZIndex(dockMode, "settings", settings.panelOrder, centerZ);

  return (
    <div className={`modal-backdrop dock-${dockMode}`} style={{ zIndex }} onPointerDown={onClose}>
      <DockPlacementResizer mode={dockMode} />
      <div className="panel settings-panel" onPointerDown={(e) => e.stopPropagation()}>
        {dockMode === "center" && <CenterResizeHandles panelKey="settings" />}
        <div className="settings-head">
          <h2>Settings</h2>
          {/* Absent on Debug / About, which have nothing to save. A control that is present but
              inert on a third of the tabs teaches people to stop looking at it. */}
          {tabProfiles && (
            <ProfileBar key={tab} adapter={tabProfiles.adapter} compact />
          )}
        </div>

        <div className="settings-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`settings-tab ${tab === t.key ? "on" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === "color" && <ColorTab settings={settings} set={set} />}

          {tab === "controls" && <ControlsTab settings={settings} set={set} onePanel={onePanel} />}

          {tab === "midi" && midi && <MidiPanel midi={midi} settings={settings} onChange={onChange} />}

          {tab === "audio" && (
            <AudioTab
              settings={settings}
              set={set}
              onChange={onChange}
              outputSupported={outputSupported}
              loadedVideoIds={loadedVideoIds}
              loadedDecks={loadedDecks}
              stemStatus={stemStatus}
              onReanalyze={onReanalyze}
              lyricDecks={lyricDecks}
              onRetranscribe={onRetranscribe}
              onGpuReenable={onGpuReenable}
            />
          )}


          {tab === "debug" && <DebugTab midi={midi} debug={debug} />}

          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </div>
  );
}


