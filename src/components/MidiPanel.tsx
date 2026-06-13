import { useState } from "react";
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
} from "@htl/midi";
import { ProfileBar } from "./ProfileBar";

// The full MIDI settings surface: device detection, the tested-controller list,
// a save/share/manage map library (synced to the account via Settings), and the
// per-deck (A / B / Global) MIDI-Learn grid. Split out of SettingsPanel so it can
// own its own state without bloating the modal.
export function MidiPanel({ midi, settings, onChange }: { midi: UseMidi; settings: Settings; onChange: (s: Settings) => void }) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const [deckTab, setDeckTab] = useState<"A" | "B" | "global">("A");

  const s = midi.status;
  const device = s.state === "connected" ? s.device : null;
  const matched = matchProfile(device);

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

      {/* Map manager — the shared save/share/sync control */}
      {settings.midiEnabled && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">MIDI maps</span>
          </div>
          <ProfileBar
            adapter={{
              profiles: settings.midiMaps,
              activeId: settings.activeMidiMapId,
              zeroLabel: matched ? `${matched.name} (built-in)` : "Built-in / none",
              zeroPayload: () => ({}),
              snapshotCurrent: () => ({ ...settings.midiBindings }),
              payloadOf: (m) => ({ ...m.bindings }),
              buildNew: (name, b) => createMap(name, { device, basedOn: matched?.id ?? null, bindings: b }),
              duplicate: duplicateMap,
              updateProfile: (m, b) => ({ ...m, bindings: b, updatedAt: Date.now() }),
              parseText: parseMap,
              exportText: exportMap,
              describe: (m) => `${bindingCount(m)} custom`,
              optionSuffix: (m) => (m.device ? ` · ${m.device}` : ""),
              fileExt: "htlmidi.json",
              noun: "map",
              onCommit: ({ profiles, activeId, payload }) =>
                set({ midiMaps: profiles, activeMidiMapId: activeId, ...(payload ? { midiBindings: payload } : {}) }),
            }}
          />
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
