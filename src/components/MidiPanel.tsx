import { useState } from "react";
import { isChromium } from "@htl";
import type { Settings } from "@htl";
import {
  LEARN_CONTROLS,
  LEARN_GROUPS,
  PROFILES,
  matchProfile,
  type UseMidi,
} from "@htl/midi";
import { InfoDot } from "./settings/InfoDot";

// The full MIDI settings surface: device detection, the tested-controller list,
// a save/share/manage map library (synced to the account via Settings), and the
// per-deck (A / B / Global) MIDI-Learn grid. Split out of SettingsPanel so it can
// own its own state without bloating the modal.
//
// ★ Written in the shared settings grammar (see the block comment atop settings.css), because
// Controls and MIDI sit next to each other in one tab strip and a reader crossing between them
// must not feel a seam. It had six `.settings-hint` paragraphs, four inline `style={{color}}`
// status colours, and a bespoke four-column `.midi-learn-row` that lined up with nothing —
// three private conventions where the panel already had public ones.
export function MidiPanel({ midi, settings, onChange }: { midi: UseMidi; settings: Settings; onChange: (s: Settings) => void }) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const [deckTab, setDeckTab] = useState<"A" | "B" | "global">("A");

  const s = midi.status;
  const device = s.state === "connected" ? s.device : null;
  const matched = matchProfile(device);

  const visible = LEARN_CONTROLS.filter((c) => (deckTab === "global" ? !c.deck : c.deck === deckTab));

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">USB-MIDI</span>
          <InfoDot
            text="Plug a DJ controller in over USB and the board follows it. Desktop Chrome and Edge only: Safari and iOS have no Web MIDI at all, so the switch stays off there whatever you do."
            label="USB-MIDI"
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Enable controllers</span>
          <button
            className={`toggle ${settings.midiEnabled ? "on" : ""}`}
            onClick={() => {
              const next = !settings.midiEnabled;
              set({ midiEnabled: next });
              if (next) midi.connect(); // request inside the click so Chrome prompts
            }}
            role="switch"
            aria-checked={settings.midiEnabled}
            aria-label="Enable controllers"
            disabled={!midi.supported}
          >
            <span className="toggle-knob" />
          </button>
        </div>
        {!isChromium() && (
          <p className="settings-note bad">This browser has no Web MIDI. Use desktop Chrome or Edge.</p>
        )}
        {settings.midiEnabled && <StatusLine midi={midi} />}
      </div>

      {/* Hardware detection + the tested-device list */}
      {settings.midiEnabled && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">Detected hardware</span>
            <InfoDot
              text="What is plugged in right now, and whether we already know it. A tested controller works the moment you connect it. Anything else needs its controls learned below, or a shared map imported, after which it behaves the same."
              label="Detected hardware"
            />
          </div>
          {/* Status as a CLASS, not an inline colour. Four hex literals sat here in `style={{}}`,
              invisible to the theme and to every contrast pass — and one of them was a green that
              appears nowhere else in the app. */}
          {device ? (
            matched ? (
              <p className="settings-note good">
                <strong>{device}</strong> is a tested controller. The <strong>{matched.name}</strong> map is already
                loaded, nothing to set up.
              </p>
            ) : (
              <p className="settings-note warn">
                <strong>{device}</strong> is not in the tested list. Learn its controls below or import a shared map,
                then save it.
              </p>
            )
          ) : (
            <p className="settings-note">No controller connected. Plug one in and it is picked up automatically.</p>
          )}
          <div className="midi-device-list">
            {PROFILES.map((p) => (
              <span key={p.id} className={`midi-device-chip ${matched?.id === p.id ? "on" : ""}`}>
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* The "MIDI maps" card was here. Same control, panel header, every tab. */}

      {/* Learn grid, split by deck */}
      {settings.midiEnabled && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">MIDI Learn</span>
            <InfoDot
              text="Teach the app one control at a time. Press Learn on a row, then move the knob, pad or fader you want it on, and the row shows the bytes it caught. Remap replaces one; the ✕ clears it. Deck A and Deck B are separate, and Global is everything that is not on a deck."
              label="MIDI Learn"
            />
          </div>
          {/* The deck switch is a ROW with a segmented cluster, the same shape ProfileBar's verbs
              and the Color tab's rolls use — `.midi-subtabs` was a fourth way to draw one. */}
          <div className="settings-row">
            <span className="settings-label">Learning</span>
            <span className="settings-control">
              <span className="seg-group">
                {(["A", "B", "global"] as const).map((t) => (
                  <button key={t} className={`hw-btn small ${deckTab === t ? "on" : ""}`} onClick={() => setDeckTab(t)}>
                    {t === "global" ? "Global" : `Deck ${t}`}
                  </button>
                ))}
              </span>
            </span>
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
                  // THE ROW GRAMMAR, exactly: name left, the caught bytes in the shared value
                  // slot (they are this control's VALUE, the same as a hex or a "4px"), actions
                  // right. The old bespoke 4-column grid lined up with nothing else in the panel.
                  return (
                    <div key={c.id} className={`settings-row midi-learn-row ${learning ? "learning" : ""}`}>
                      <span className="settings-label">{label}</span>
                      <span className="settings-control">
                        <span className="settings-value is-hex">
                          {b ? `${b.status.toString(16).toUpperCase().padStart(2, "0")}·${b.data}` : "—"}
                        </span>
                        <button className="hw-btn small" onClick={() => midi.armLearn(learning ? null : c.id)}>
                          {learning ? "Press…" : b ? "Remap" : "Learn"}
                        </button>
                        {b && (
                          <button className="hw-btn small danger" aria-label={`Clear ${label}`} onClick={() => midi.clearLearn(c.id)}>
                            ✕
                          </button>
                        )}
                      </span>
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
        <p className="settings-note">
          The live MIDI monitor and the LED feedback prober are in <strong>Settings ▸ Debug</strong>. Read any
          control's bytes there and confirm a mapping as it happens.
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
