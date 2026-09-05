import {
  type Settings,
  type ColorValue,
  snapshotColors,
  createColorProfile,
  duplicateColorProfile,
  exportColorProfile,
  parseColorProfile,
} from "@htl";
import { InfoDot } from "./settings/InfoDot";
import { ProfileBar } from "./ProfileBar";

// The colour "play" controls in ONE self-contained component so the (co-edited) SettingsPanel
// needs only one line: band vividness (the frequency-colour look) and the saved, CLOUD-SYNCED,
// shareable colour themes — now via the shared <ProfileBar> so themes, keymaps and MIDI maps
// all look and act the same. A theme is a snapshot of the palette stored in
// settings.colorProfiles → the Settings blob syncs to /api/me/settings, so themes follow the
// user across devices. Copy/Export = share the JSON; Import/Paste = bring one back.
export function ColorProfiles({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });

  // A live gradient of the current palette, shown beside the bar so the menu reads as "colour".
  const liveSwatch = (): string => {
    const cols = [
      settings.accentA,
      settings.accentB,
      settings.freqLowColor,
      settings.freqMidColor,
      settings.freqHighColor,
      settings.stripColor,
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    return cols.length ? `linear-gradient(90deg, ${cols.join(", ")})` : "var(--surface)";
  };

  return (
    <>
      {/* Band vividness used to live here as a section of its own, holding one slider. It is a
          property of the band colours, so it now sits WITH them, under Frequency colour in the
          Colour tab — a control's home is the thing it modifies. */}

      <div className="color-group">
        <div className="color-group-head">
          <span className="color-group-title">Saved themes</span>
          <InfoDot text="Save the whole palette as a named theme. Themes sync to your account, and you can share one with a code." label="Saved themes" />
        </div>
        <ProfileBar
          adapter={{
            profiles: settings.colorProfiles ?? [],
            activeId: settings.activeColorProfileId ?? null,
            zeroLabel: "Built-in / none",
            // No overlay to clear — selecting "none" leaves the current colours untouched.
            snapshotCurrent: () => snapshotColors(settings as unknown as Record<string, ColorValue>),
            payloadOf: (p) => p.colors,
            buildNew: (name, colors) => createColorProfile(name, colors),
            duplicate: duplicateColorProfile,
            updateProfile: (p, colors) => ({ ...p, colors, updatedAt: Date.now() }),
            parseText: parseColorProfile,
            exportText: exportColorProfile,
            fileExt: "htltheme.json",
            noun: "theme",
            extras: <span className="profilebar-swatch" style={{ background: liveSwatch() }} />,
            onCommit: ({ profiles, activeId, payload }) =>
              set({ colorProfiles: profiles, activeColorProfileId: activeId, ...(payload ? (payload as Partial<Settings>) : {}) }),
          }}
        />
      </div>
    </>
  );
}
