import { useState, useSyncExternalStore } from "react";
import { fxBankStats, restoreFxFactory, resetFxArrangement } from "@htl/audio";
import { onSettingsSync, settingsSyncState } from "../../htl/state/settingsSync";
import { InfoDot } from "./InfoDot";

// Settings ▸ Audio ▸ Effect presets — the RESTORE side of the preset banks.
//
// ★ WHY IT LIVES HERE AND NOT IN THE MENU. Deleting one preset mid-set is a small annoyance and
// stays where the preset is, as a ✕ on its row. RESTORE is the dangerous one: it puts back every
// factory preset you pruned and drops every edit you made to one, which is exactly the wrong thing
// to fire by accident with a track playing. So it sits behind a settings modal behind a tab —
// three deliberate acts from the deck — and the destructive rung asks a second time.
//
// ★ AND IT IS A LADDER, NOT A BUTTON. "Restore factory presets" and "reset arrangement" are
// different sizes of undo, and neither of them touches presets you saved yourself: a restore that
// also deleted your own work would be a bank wipe wearing a friendlier name. Deleting those stays
// the ✕ in the menu, one at a time, where you can see what you are deleting.
const KINDS: { kind: string; label: string }[] = [
  { kind: "eq", label: "EQ" },
  { kind: "comp", label: "COMP" },
  { kind: "delay", label: "DELAY" },
  { kind: "reverb", label: "REVERB" },
  { kind: "saturator", label: "SAT" },
  { kind: "crush", label: "CRUSH" },
  { kind: "mod", label: "MOD" },
  { kind: "gate", label: "GATE" },
  { kind: "noise", label: "NOISE" },
  // The CHAIN bank is a bank like any other now, so its restore is the same ladder rather than a
  // feature it silently lacked.
  { kind: "chain", label: "CHAINS" },
];

export function FxBankSettings() {
  const [tick, setTick] = useState(0);
  const [confirm, setConfirm] = useState<string | null>(null);
  const rows = KINDS.map((k) => ({ ...k, s: fxBankStats(k.kind) }));
  // Only banks you have actually touched are worth a row — nine untouched effects is a wall of
  // "0 · 0 · 0" that says nothing and buries the ones that matter.
  const touched = rows.filter((r) => r.s.hidden || r.s.edited || r.s.sections || r.s.own);
  void tick;

  // ★ SAY WHETHER THE BANKS ARE ACTUALLY SAFE. They ride the account settings blob, which has a
  // 256 KB server cap, and a push that fails used to fail SILENTLY on every device at once — the
  // banks are the biggest thing in that blob and the likeliest to cross it. This is the one place
  // that would know, so it is the one place that has to say.
  const sync = useSyncExternalStore(onSettingsSync, settingsSyncState, settingsSyncState);
  const kb = sync.bytes ? `${Math.round(sync.bytes / 1024)} KB` : null;

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <span className="settings-label">Effect presets</span>
        <InfoDot
          text="The undo side of the preset banks. You group, reorder, edit and delete presets by right-clicking an effect tab on the board; this is where you put any of that back. Restore returns the deleted factory presets and undoes your edits to them. Reset goes further and also drops your sections and ordering. Neither one touches a preset you saved yourself — deleting those stays one at a time, in the menu, where you can see what you are deleting."
          label="Effect presets"
        />
        {sync.signedIn === false || sync.error || sync.lastPushAt ? (
          <span className={`fx-bank-sync ${sync.error ? "bad" : ""}`}>
            {sync.signedIn === false
              ? "this device only"
              : sync.error
                ? `not synced${kb ? ` · ${kb}` : ""}`
                : `synced${kb ? ` · ${kb}` : ""}`}
          </span>
        ) : null}
      </div>
      {touched.length === 0 ? (
        <p className="settings-note">Every bank is as it ships, so there is nothing to undo.</p>
      ) : (
        /* ★ ONE ROW PER TOUCHED BANK, in the shared grammar. It was a four-column bespoke row
           carrying a name, a stats string and TWO full-width word buttons — the widest row in
           the whole panel, and the two verbs read as equals when one of them is strictly bigger
           than the other. They are a `.seg-group` now, in the order they escalate, and the
           counts sit in the shared value slot like every other reading. */
        touched.map((r) => (
          <div key={r.kind} className="settings-row fx-bank-row">
            <span className="settings-label">{r.label}</span>
            <span className="settings-control">
              <span className="settings-value">
                {[r.s.own && `${r.s.own} yours`, r.s.sections && `${r.s.sections} sec`, r.s.edited && `${r.s.edited} edited`, r.s.hidden && `${r.s.hidden} hidden`].filter(Boolean).join(" · ")}
              </span>
              <span className="seg-group">
                <button
                  className="hw-btn small"
                  onClick={() => {
                    restoreFxFactory(r.kind);
                    setTick((t) => t + 1);
                  }}
                >
                  Restore
                </button>
                <button
                  className={`hw-btn small danger ${confirm === r.kind ? "armed" : ""}`}
                  onClick={() => {
                    if (confirm !== r.kind) return setConfirm(r.kind);
                    resetFxArrangement(r.kind);
                    setConfirm(null);
                    setTick((t) => t + 1);
                  }}
                  onBlur={() => setConfirm((c) => (c === r.kind ? null : c))}
                >
                  {confirm === r.kind ? "Sure?" : "Reset all"}
                </button>
              </span>
            </span>
          </div>
        ))
      )}
    </div>
  );
}
