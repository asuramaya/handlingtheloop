import { useLayoutEffect, useRef, useState } from "react";
import { applySearch } from "./settings/settingsSearch";
import { SECTION_KEYS, changedKeys, resetPatch, type SectionKey } from "./settings/settingsSections";
import { ConfirmModal } from "./Dialog";
import { type PanelPlacement, type Settings } from "@htl";
import type { StemStatus, DebugSection } from "../App";
import { type UseMidi } from "@htl/midi";
import { MidiPanel } from "./MidiPanel";
import { CenterResizeHandles, DockPlacementResizer, panelZIndex, useCenterZIndex } from "./DockResizer";
import { ProfileBar } from "./ProfileBar";
import { profilesForTab } from "./settings/profileAdapters";
import { AboutTab } from "./settings/AboutTab";
import { AudioTab } from "./settings/AudioTab";
import { StemsTab } from "./settings/StemsTab";
import { LyricsSettings, type LyricDeck } from "./LyricsSettings";
import { ColorTab } from "./settings/ColorTab";
import { ControlsTab, PanelPlacementSection } from "./settings/ControlsTab";
import { TurntableTab } from "./settings/TurntableTab";
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


type Tab = "interface" | "controls" | "turntable" | "midi" | "audio" | "stems" | "lyrics" | "debug" | "about";
const TABS: { key: Tab; label: string }[] = [
  { key: "interface", label: "Interface" },
  { key: "controls", label: "Controls" },
  { key: "turntable", label: "Turntable" },
  { key: "midi", label: "MIDI" },
  { key: "audio", label: "Audio" },
  { key: "stems", label: "Stems" },
  { key: "lyrics", label: "Lyrics" },
  { key: "debug", label: "Debug" },
  { key: "about", label: "About" },
];
// Debug (live polling) and About (prose) are destinations, not settings: search skips them.
const SEARCHABLE: Tab[] = ["interface", "controls", "turntable", "midi", "audio", "stems", "lyrics"];

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
  const [tab, setTab] = useState<Tab>("interface");
  // ★ A LEFT-SIDE MENU, NOT A STRIP. Operator, 2026-11-02: "instead of the tabs being carded on
  // the top header, make them list down in a hamburger giving us more granularity", then: "it has
  // to be a hamburger on the left side" (the first cut dropped a list down from the header, and
  // in the side docks that header sat under the chin). Same shape as the Library: ☰ at the left
  // of the head, the sections down the left edge. Beside the content when the panel is wide; over
  // it, closing on pick, when the panel is a narrow dock. Remembered across opens.
  const [navOpen, setNavOpenRaw] = useState(() => {
    try {
      return localStorage.getItem("htl:setNav") === "1";
    } catch {
      return false;
    }
  });
  const setNavOpen = (f: (o: boolean) => boolean) =>
    setNavOpenRaw((o) => {
      const v = f(o);
      try {
        localStorage.setItem("htl:setNav", v ? "1" : "0");
      } catch {
        /* private mode: just not remembered */
      }
      return v;
    });
  const frameRef = useRef<HTMLDivElement>(null);
  const NAV_OVERLAY_BELOW = 520; // px of panel width under which the list overlays the content
  const current = TABS.find((t) => t.key === tab)!;
  // ★ ONE SAVE/SHARE/MANAGE CONTROL, IN THE HEADER, FOR THE WHOLE PANEL. It used to be an
  // inline bar per tab — Color, Controls and MIDI each grew their own, and Audio, the tab whose
  // setup most wants carrying between machines, had none. Three copies of one idea plus a hole.
  // Now it lives on the title line and simply changes what it operates on with the tab, which is
  // also what made Audio's missing profiles a two-line fix instead of a fourth bar.
  // Interface: its saved profiles are the colour themes (placement is not part of a theme).
  const tabProfiles = profilesForTab(tab === "interface" ? "color" : tab, settings, onChange, midi);
  // This component only exists in the DOM while open (App conditionally mounts it), so mount
  // itself IS "just opened" — no separate open/close transition to track like Library's.
  const centerZ = useCenterZIndex(dockMode, true);
  const zIndex = panelZIndex(dockMode, "settings", settings.panelOrder, centerZ);

  // ★ SEARCH STATE. Results are every searchable section rendered at once, filtered in the DOM
  // (settingsSearch.ts), re-filtered whenever a section's own content changes under it (a toggle
  // revealing a row, a device list arriving), so what matches is always what is really there.
  const [query, setQuery] = useState("");
  // ★ CHANGED-FROM-DEFAULT. A dot on each ☰ entry whose settings differ from the defaults, and a
  // reset for the section you are in (settingsSections.ts; a test keeps every setting placed).
  const [confirmReset, setConfirmReset] = useState<SectionKey | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [hits, setHits] = useState(-1);
  useLayoutEffect(() => {
    const root = resultsRef.current;
    if (!root || !query.trim()) return;
    const run = () => setHits(applySearch(root, query));
    run();
    const mo = new MutationObserver(run);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [query]);

  const renderTab = (t: Tab) => {
    switch (t) {
      case "interface":
        return (
          <>
            <ColorTab settings={settings} set={set} />
            <PanelPlacementSection settings={settings} set={set} onePanel={onePanel} />
          </>
        );
      case "controls":
        return <ControlsTab settings={settings} set={set} />;
      case "turntable":
        return <TurntableTab settings={settings} set={set} />;
      case "midi":
        return midi ? <MidiPanel midi={midi} settings={settings} onChange={onChange} /> : null;
      case "audio":
        return <AudioTab settings={settings} set={set} outputSupported={outputSupported} />;
      case "stems":
        return (
          <StemsTab
            settings={settings}
            set={set}
            loadedVideoIds={loadedVideoIds}
            loadedDecks={loadedDecks}
            stemStatus={stemStatus}
            onReanalyze={onReanalyze}
            onGpuReenable={onGpuReenable}
          />
        );
      case "lyrics":
        return <LyricsSettings settings={settings} onChange={onChange} decks={lyricDecks} onRetranscribe={onRetranscribe} />;
      case "debug":
        return <DebugTab midi={midi} debug={debug} />;
      case "about":
        return <AboutTab />;
    }
  };

  return (
    <div className={`modal-backdrop dock-${dockMode}`} style={{ zIndex }} onPointerDown={onClose}>
      <DockPlacementResizer mode={dockMode} />
      <div className="panel settings-panel" onPointerDown={(e) => e.stopPropagation()}>
        {dockMode === "center" && <CenterResizeHandles panelKey="settings" />}
        <div className="settings-head">
          <button
            className={`settings-nav-btn ${navOpen ? "open" : ""}`}
            onClick={() => setNavOpen((o) => !o)}
            aria-expanded={navOpen}
            aria-controls="settings-nav"
            aria-label={`Settings sections, now ${current.label}`}
          >
            <span className="settings-nav-icon" aria-hidden="true">☰</span>
            <h2>
              <span className="settings-crumb">
                Settings <span className="settings-nav-sep">/</span>{" "}
              </span>
              {query.trim() ? "Search" : current.label}
            </h2>
          </button>
          {/* Absent on Debug / About, which have nothing to save. A control that is present but
              inert on a third of the tabs teaches people to stop looking at it. */}
          {tabProfiles && (
            <ProfileBar key={tab} adapter={tabProfiles.adapter} compact />
          )}
        </div>

        <div ref={frameRef} className={`settings-frame ${navOpen ? "nav-open" : ""}`}>
          {navOpen && (
            <nav id="settings-nav" className="settings-nav" aria-label="Settings sections">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  className={`settings-nav-item ${tab === t.key ? "on" : ""}`}
                  aria-current={tab === t.key ? "page" : undefined}
                  onClick={() => {
                    setTab(t.key);
                    // Overlaying the content (a narrow dock)? Get out of the way once picked.
                    if ((frameRef.current?.offsetWidth ?? 0) < NAV_OVERLAY_BELOW) setNavOpen(() => false);
                  }}
                >
                  {t.label}
                  {t.key in SECTION_KEYS && changedKeys(settings, t.key as SectionKey).length > 0 && (
                    <span className="settings-nav-dot" title={`${changedKeys(settings, t.key as SectionKey).length} changed from default`} aria-label="changed from default" />
                  )}
                </button>
              ))}
            </nav>
          )}

        <div className="settings-body">
          {/* ★ SEARCH, at the top of the content rather than in the ☰ list: the list overlays the
              content in a narrow dock, so a box inside it would hide the very results it found. */}
          <div className="settings-search">
            <input
              type="search"
              placeholder="Search settings"
              aria-label="Search settings"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // In a narrow dock the open list OVERLAYS the content, i.e. the results; get it out
                // of the way the moment there is something to show.
                if (navOpen && (frameRef.current?.offsetWidth ?? 0) < NAV_OVERLAY_BELOW) setNavOpen(() => false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
            />
          </div>
          {query.trim() ? (
            <div ref={resultsRef} className="settings-search-results">
              {SEARCHABLE.filter((t) => t !== "midi" || midi).map((t) => (
                <section key={t} className="search-group">
                  <button
                    className="search-group-title"
                    onClick={() => {
                      setTab(t);
                      setQuery("");
                    }}
                  >
                    {TABS.find((x) => x.key === t)!.label} ›
                  </button>
                  <div className="search-group-body">{renderTab(t)}</div>
                </section>
              ))}
              {hits === 0 && <p className="settings-hint search-none">No settings match “{query.trim()}”.</p>}
            </div>
          ) : (
            <>
              {renderTab(tab)}
              {tab in SECTION_KEYS && changedKeys(settings, tab as SectionKey).length > 0 && (
                <div className="settings-reset-bar">
                  <span>
                    {changedKeys(settings, tab as SectionKey).length} setting{changedKeys(settings, tab as SectionKey).length > 1 ? "s" : ""} here differ from the defaults
                  </span>
                  <button className="link-btn" onClick={() => setConfirmReset(tab as SectionKey)}>
                    Reset {current.label}
                  </button>
                </div>
              )}
            </>
          )}
          {confirmReset && (
            <ConfirmModal
              title={`Reset ${TABS.find((x) => x.key === confirmReset)!.label}?`}
              message={`${changedKeys(settings, confirmReset).length} setting(s) go back to their defaults${confirmReset === "controls" && changedKeys(settings, "controls").includes("keyBindings") ? ", including your custom key bindings" : ""}. Saved profiles are kept.`}
              confirmLabel="Reset"
              onConfirm={() => onChange({ ...settings, ...resetPatch(settings, confirmReset) })}
              onClose={() => setConfirmReset(null)}
            />
          )}
        </div>
        </div>
      </div>
    </div>
  );
}


