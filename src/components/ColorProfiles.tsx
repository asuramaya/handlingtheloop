import { useState } from "react";
import {
  type Settings,
  type ColorProfile,
  type ColorValue,
  snapshotColors,
  createColorProfile,
  exportColorProfile,
  parseColorProfile,
} from "@htl";

// All the waveform/colour "play" controls in ONE self-contained component so the
// (co-edited) SettingsPanel needs only one line — band vividness (the frequency-
// colour look) and the saved, CLOUD-SYNCED, shareable COLOUR PROFILES: the
// colour twin of the MIDI maps. A profile is a snapshot of the theme's colours, stored in
// settings.colorProfiles → the Settings blob syncs to /api/me/settings, so themes follow
// the user across devices. Share = export JSON to the clipboard; Import = paste it back.
export function ColorProfiles({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [name, setName] = useState("");
  const [flash, setFlash] = useState<string | null>(null);
  const profiles = settings.colorProfiles ?? [];
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });

  const note = (m: string) => {
    setFlash(m);
    window.setTimeout(() => setFlash((cur) => (cur === m ? null : cur)), 1800);
  };

  const saveCurrent = () => {
    const colors = snapshotColors(settings as unknown as Record<string, ColorValue>);
    const prof = createColorProfile(name || `Theme ${profiles.length + 1}`, colors);
    onChange({ ...settings, colorProfiles: [...profiles, prof], activeColorProfileId: prof.id });
    setName("");
  };
  const load = (p: ColorProfile) => onChange({ ...settings, ...(p.colors as Partial<Settings>), activeColorProfileId: p.id });
  const del = (p: ColorProfile) =>
    onChange({
      ...settings,
      colorProfiles: profiles.filter((x) => x.id !== p.id),
      activeColorProfileId: settings.activeColorProfileId === p.id ? null : settings.activeColorProfileId,
    });
  const share = async (p: ColorProfile) => {
    const text = exportColorProfile(p);
    try {
      await navigator.clipboard.writeText(text);
      note("Share code copied");
    } catch {
      try {
        window.prompt("Copy this theme's share code:", text);
      } catch {
        note("Couldn't copy");
      }
    }
  };
  const importProfile = async () => {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = window.prompt("Paste a theme share code:") || "";
    }
    if (!text.trim()) return;
    const p = parseColorProfile(text);
    if (!p) return note("Not a valid theme code");
    onChange({ ...settings, colorProfiles: [...profiles, p], activeColorProfileId: p.id });
    note(`Imported "${p.name}"`);
  };

  const swatch = (p: ColorProfile): string => {
    const c = p.colors;
    const cols = [c.accentA, c.accentB, c.freqLowColor, c.freqMidColor, c.freqHighColor, c.stripColor].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    return cols.length ? `linear-gradient(90deg, ${cols.join(", ")})` : "var(--surface)";
  };

  return (
    <>
      {settings.freqColors && (
        <div className="color-group">
          <div className="color-group-head">
            <span className="color-group-title">Band vividness</span>
            <span className="color-group-desc">Saturation of the frequency-coloured waveform — grey at 0%, as-picked at 100%, neon past it.</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">
              Vividness <span className="settings-sub muted">· {Math.round(settings.freqVividness * 100)}%</span>
            </span>
            <input
              type="range"
              className="settings-slider"
              min={0}
              max={2}
              step={0.05}
              value={settings.freqVividness}
              onChange={(e) => set({ freqVividness: Number(e.target.value) })}
              title="Band-colour saturation: 0% grey, 100% as-picked, 200% neon"
            />
          </div>
        </div>
      )}

      <div className="color-profiles color-group">
        <div className="color-group-head">
          <span className="color-group-title">Saved themes</span>
          <span className="color-group-desc">{flash ?? "Snapshot the whole palette as a named theme — synced to your account, shareable by code."}</span>
        </div>
        <div className="cprofile-actions">
          <input
            className="cprofile-name-input"
            value={name}
            placeholder="Theme name"
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveCurrent()}
          />
          <button className="cprofile-btn save" onClick={saveCurrent} title="Save the current colours as a theme">
            Save current
          </button>
          <button className="cprofile-btn" onClick={importProfile} title="Import a shared theme from your clipboard">
            Import
          </button>
        </div>
        {profiles.length === 0 ? (
          <p className="settings-hint muted">
            No saved themes yet — tweak the colours above, then Save current. They sync to your account, and you can share the code.
          </p>
        ) : (
          <div className="cprofile-list">
            {profiles.map((p) => (
              <div key={p.id} className={`cprofile ${settings.activeColorProfileId === p.id ? "on" : ""}`}>
                <span className="cprofile-swatch" style={{ background: swatch(p) }} />
                <button className="cprofile-load" onClick={() => load(p)} title="Apply this theme">
                  {p.name}
                </button>
                <button className="cprofile-icon" onClick={() => share(p)} title="Copy share code">
                  ⤴
                </button>
                <button className="cprofile-icon danger" onClick={() => del(p)} title="Delete">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
