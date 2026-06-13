import { useRef, useState } from "react";
import { isChromium } from "@htl";
import type { Settings } from "@htl";
import {
  LEARN_CONTROLS,
  LEARN_GROUPS,
  PROFILES,
  matchProfile,
  createMap,
  duplicateMap,
  exportMap,
  parseMap,
  bindingCount,
  type UseMidi,
  type MidiMap,
} from "@htl/midi";

// The full MIDI settings surface: device detection, the tested-controller list,
// a save/share/manage map library (synced to the account via Settings), and the
// per-deck (A / B / Global) MIDI-Learn grid. Split out of SettingsPanel so it can
// own its own state without bloating the modal.
export function MidiPanel({ midi, settings, onChange }: { midi: UseMidi; settings: Settings; onChange: (s: Settings) => void }) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const [deckTab, setDeckTab] = useState<"A" | "B" | "global">("A");
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const s = midi.status;
  const device = s.state === "connected" ? s.device : null;
  const matched = matchProfile(device);
  const maps = settings.midiMaps;
  const active = maps.find((m) => m.id === settings.activeMidiMapId) ?? null;

  // --- map operations (all just settings edits → auto-sync to the account) ---
  const loadMap = (id: string | null) => {
    if (id == null) return set({ activeMidiMapId: null, midiBindings: {} });
    const m = maps.find((x) => x.id === id);
    if (m) set({ activeMidiMapId: id, midiBindings: { ...m.bindings } });
  };
  const saveAsNew = () => {
    const name = window.prompt("Name this map", device ?? matched?.name ?? "Custom map")?.trim();
    if (!name) return;
    const m = createMap(name, { device, basedOn: matched?.id ?? null, bindings: settings.midiBindings });
    set({ midiMaps: [...maps, m], activeMidiMapId: m.id });
    setNote(`Saved "${m.name}" — synced to your account.`);
  };
  const updateActive = () => {
    if (!active) return;
    set({ midiMaps: maps.map((m) => (m.id === active.id ? { ...m, bindings: { ...settings.midiBindings }, updatedAt: Date.now() } : m)) });
    setNote(`Updated "${active.name}".`);
  };
  const renameActive = () => {
    if (!active) return;
    const name = window.prompt("Rename map", active.name)?.trim();
    if (!name) return;
    set({ midiMaps: maps.map((m) => (m.id === active.id ? { ...m, name } : m)) });
  };
  const duplicateActive = () => {
    if (!active) return;
    const d = duplicateMap(active);
    set({ midiMaps: [...maps, d], activeMidiMapId: d.id, midiBindings: { ...d.bindings } });
  };
  const deleteActive = () => {
    if (!active || !window.confirm(`Delete "${active.name}"? This can't be undone.`)) return;
    set({ midiMaps: maps.filter((m) => m.id !== active.id), activeMidiMapId: null, midiBindings: {} });
  };
  const exportActive = (m: MidiMap) => {
    const blob = new Blob([exportMap(m)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${m.name.replace(/[^\w.-]+/g, "_")}.htlmidi.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const shareActive = async (m: MidiMap) => {
    try {
      await navigator.clipboard?.writeText(exportMap(m));
      setNote(`Copied "${m.name}" to the clipboard — paste to share.`);
    } catch {
      setNote("Clipboard unavailable — use Export instead.");
    }
  };
  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    const m = parseMap(await file.text());
    if (!m) return setNote("That file isn't a valid HTL MIDI map.");
    set({ midiMaps: [...maps, m], activeMidiMapId: m.id, midiBindings: { ...m.bindings } });
    setNote(`Imported "${m.name}".`);
  };

  const visible = LEARN_CONTROLS.filter((c) => (deckTab === "global" ? !c.deck : c.deck === deckTab));

  return (
    <>
      {/* Enable + status */}
      <div className="settings-section">
        <div className="settings-row">
          <span className="settings-label">USB-MIDI controllers</span>
          <button
            className={`toggle ${settings.midiEnabled ? "on" : ""}`}
            onClick={() => {
              const next = !settings.midiEnabled;
              set({ midiEnabled: next });
              if (next) midi.connect(); // request inside the click so Chrome prompts
            }}
            role="switch"
            aria-checked={settings.midiEnabled}
            disabled={!midi.supported}
          >
            <span className="toggle-knob" />
          </button>
        </div>
        <p className="settings-hint">Plug in a DJ controller over USB. Desktop Chrome / Edge only — Safari and iOS don't support Web MIDI.</p>
        {!isChromium() && <p className="settings-hint" style={{ color: "#ff5d73" }}>This browser can't do Web MIDI — use desktop Chrome or Edge.</p>}
        {settings.midiEnabled && <StatusLine midi={midi} />}
      </div>

      {/* Hardware detection + the tested-device list */}
      {settings.midiEnabled && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">Detected hardware</span>
          </div>
          {device ? (
            matched ? (
              <p className="settings-hint" style={{ color: "#6ee7a8" }}>
                ✓ <strong>{device}</strong> — tested controller. The <strong>{matched.name}</strong> map is plug-and-play; no setup needed.
              </p>
            ) : (
              <p className="settings-hint" style={{ color: "#ffd250" }}>
                <strong>{device}</strong> isn't in the tested list yet. Learn its controls below (or import a shared map), then Save — it syncs to your account.
              </p>
            )
          ) : (
            <p className="settings-hint">No controller connected. Plug one in and it'll be detected automatically.</p>
          )}
          <div className="midi-device-list">
            <span className="settings-hint" style={{ margin: 0 }}>Tested &amp; plug-and-play:</span>
            {PROFILES.map((p) => (
              <span key={p.id} className={`midi-device-chip ${matched?.id === p.id ? "on" : ""}`}>
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Map manager */}
      {settings.midiEnabled && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">MIDI maps</span>
            {active && <span className="settings-hint" style={{ margin: 0 }}>{bindingCount(active)} custom · synced</span>}
          </div>
          <div className="settings-row">
            <select className="midi-map-select" value={settings.activeMidiMapId ?? ""} onChange={(e) => loadMap(e.target.value || null)}>
              <option value="">{matched ? `${matched.name} (built-in)` : "Built-in / none"}</option>
              {maps.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.device ? ` · ${m.device}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="midi-map-tools">
            <button className="hw-btn small" onClick={saveAsNew}>Save as…</button>
            <button className="hw-btn small" onClick={updateActive} disabled={!active}>Update</button>
            <button className="hw-btn small" onClick={renameActive} disabled={!active}>Rename</button>
            <button className="hw-btn small" onClick={duplicateActive} disabled={!active}>Duplicate</button>
            <button className="hw-btn small" onClick={() => active && shareActive(active)} disabled={!active}>Copy</button>
            <button className="hw-btn small" onClick={() => active && exportActive(active)} disabled={!active}>Export</button>
            <button className="hw-btn small" onClick={() => fileRef.current?.click()}>Import</button>
            <button className="hw-btn small danger" onClick={deleteActive} disabled={!active}>Delete</button>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => onImportFile(e.target.files?.[0] ?? undefined)} />
          </div>
          {note && <p className="settings-hint" style={{ color: "var(--neon-cyan)" }}>{note}</p>}
        </div>
      )}

      {/* Learn grid, split by deck */}
      {settings.midiEnabled && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">MIDI Learn</span>
            <span className="settings-hint" style={{ margin: 0 }}>Click a control, then move it on the board</span>
          </div>
          <div className="midi-subtabs">
            {(["A", "B", "global"] as const).map((t) => (
              <button key={t} className={`midi-subtab ${deckTab === t ? "on" : ""}`} onClick={() => setDeckTab(t)}>
                {t === "global" ? "Global" : `Deck ${t}`}
              </button>
            ))}
          </div>
          {LEARN_GROUPS.map((group) => {
            const rows = visible.filter((c) => c.group === group);
            if (!rows.length) return null;
            return (
              <div key={group} className="midi-learn-group">
                <div className="midi-learn-group-title">{group}</div>
                {rows.map((c) => {
                  const b = settings.midiBindings[c.id];
                  const learning = midi.learningId === c.id;
                  // Strip the "— Deck X" suffix since the sub-tab already says the deck.
                  const label = c.label.replace(/ — Deck [AB]$/, "");
                  return (
                    <div key={c.id} className={`midi-learn-row ${learning ? "learning" : ""}`}>
                      <span className="midi-learn-label">{label}</span>
                      <span className="midi-learn-addr">{b ? `${b.status.toString(16).toUpperCase().padStart(2, "0")}·${b.data}` : "—"}</span>
                      <button className="link-btn" onClick={() => midi.armLearn(learning ? null : c.id)}>
                        {learning ? "Press…" : b ? "Remap" : "Learn"}
                      </button>
                      {b && (
                        <button className="link-btn danger" title="Clear mapping" onClick={() => midi.clearLearn(c.id)}>
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* The live MIDI monitor + feedback prober now live in Settings ▸ Debug (always
          on, both directions) — point users there to read bytes / reverse-engineer LEDs. */}
      {settings.midiEnabled && (
        <p className="settings-hint">
          Live MIDI monitor &amp; LED/RGB feedback prober are in <strong>Settings ▸ Debug</strong> — read any control's
          bytes there and confirm a mapping live.
        </p>
      )}
    </>
  );
}

function StatusLine({ midi }: { midi: UseMidi }) {
  const s = midi.status;
  const row = (label: string, on: boolean, noteText: string, action: string, fn: () => void) => (
    <div className="conn-row">
      <span className={`conn-dot ${on ? "on" : ""}`} />
      <span className="conn-name">{label}</span>
      {noteText && <span className="conn-note">{noteText}</span>}
      <button className="hw-btn small conn-action" onClick={fn}>{action}</button>
    </div>
  );
  if (s.state === "unsupported") return row("No Web MIDI", false, "desktop Chrome / Edge", "—", () => {});
  if (s.state === "denied") return row("Permission denied", false, s.reason ?? "allow MIDI + reload", "Retry", midi.connect);
  if (s.state === "connected") return row(s.device ?? "MIDI device", true, s.profile ? `${s.profile}` : "generic — learn below", "Rescan", midi.connect);
  return row("No controller", false, "plug one in", "Connect", midi.connect);
}
