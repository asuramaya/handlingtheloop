import { useState } from "react";
import { type Settings } from "@htl";
import type { StemStatus, DebugSection } from "../App";
import { type UseMidi } from "@htl/midi";
import { MidiPanel } from "./MidiPanel";
import { DockResizer } from "./DockResizer";
import { AboutTab } from "./settings/AboutTab";
import { AudioTab } from "./settings/AudioTab";
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
  onGpuReenable?: () => void; // user opted to re-enable GPU after a crash auto-disabled it
  outputSupported?: boolean; // browser can route to a chosen output device (AudioContext.setSinkId)
  debug?: () => DebugSection[]; // live engine/session/device diagnostics (Debug tab)
  midi?: UseMidi; // USB-MIDI controller status + learn (MIDI tab)
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
  onGpuReenable,
  outputSupported = false,
  debug,
  midi,
}: SettingsPanelProps) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const [tab, setTab] = useState<Tab>("color");

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
          {tab === "color" && <ColorTab settings={settings} set={set} onChange={onChange} />}

          {tab === "controls" && <ControlsTab settings={settings} set={set} />}

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


