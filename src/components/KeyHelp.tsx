import { useEffect, useMemo, useState } from "react";
import { KEY_ACTIONS, mergeBindings, bindingConflicts, codeLabel, type KeyBindings } from "@htl/state";

interface KeyMapProps {
  bindings: KeyBindings; // the user's saved overrides (settings.keyBindings)
  onChange: (next: KeyBindings) => void;
}

type Slot = "primary" | "secondary";

// Editable keyboard map (Settings ▸ Keys). Every action shows its PRIMARY key and a
// SECONDARY slot (blank by default) that also triggers it; click a chip then press a
// key to rebind. Bindings are physical key codes so they're layout-independent, and
// they persist in settings (so they sync across devices). The keys drive the focused
// deck; the shifted variant of each action is shown as a hint.
export function KeyMap({ bindings, onChange }: KeyMapProps) {
  const merged = useMemo(() => mergeBindings(bindings), [bindings]);
  const [capturing, setCapturing] = useState<string | null>(null); // `${id}:${slot}`

  // Surface any key bound to more than one action so a collision is never silent — the
  // dispatcher resolves it last-writer-wins (one action gets orphaned). Editing a chip steals
  // the code, but a saved map can still collide with a newly-shipped default (version drift).
  const conflicts = useMemo(() => bindingConflicts(merged), [merged]);
  const actionLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of KEY_ACTIONS) m.set(a.id, a.label);
    return m;
  }, []);

  // While a chip is armed, the next key press becomes its binding. We capture on the
  // window in the capture phase so nothing else (incl. the deck handler) sees it.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      // Ignore bare modifier presses — wait for a real key.
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      const [id, slot] = capturing.split(":") as [string, Slot];
      const code = e.code;
      // Steal the code from wherever it currently lives so a key drives one action.
      const next: KeyBindings = {};
      for (const a of KEY_ACTIONS) {
        const b = { ...merged[a.id] };
        if (b.primary === code) b.primary = "";
        if (b.secondary === code) b.secondary = "";
        next[a.id] = b;
      }
      next[id] = { ...next[id], [slot]: code };
      onChange(next);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, merged, onChange]);

  const clearBind = (id: string, slot: Slot) => {
    onChange({ ...merged, [id]: { ...merged[id], [slot]: "" } });
  };

  // Group the actions by their section for display.
  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, typeof KEY_ACTIONS>();
    for (const a of KEY_ACTIONS) {
      if (!map.has(a.group)) {
        map.set(a.group, []);
        order.push(a.group);
      }
      map.get(a.group)!.push(a);
    }
    return order.map((g) => ({ group: g, actions: map.get(g)! }));
  }, []);

  const chip = (id: string, slot: Slot, code: string) => {
    const armed = capturing === `${id}:${slot}`;
    return (
      <button
        className={`bind-chip ${armed ? "capturing" : ""} ${code ? "" : "empty"}`}
        onClick={() => setCapturing(armed ? null : `${id}:${slot}`)}
        title={slot === "primary" ? "Primary key — click, then press a key" : "Secondary key — click, then press a key"}
      >
        <span className="bind-key">{armed ? "Press a key…" : code ? codeLabel(code) : slot === "primary" ? "—" : "+ add"}</span>
        {code && !armed && (
          <span
            className="bind-clear"
            title="Clear"
            onClick={(e) => {
              e.stopPropagation();
              clearBind(id, slot);
            }}
          >
            ✕
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="keybinds">
      <div className="keybinds-head">
        <span className="keybinds-col-label">Action</span>
        <span className="keybinds-col-label">Primary · Secondary</span>
        <button className="keybinds-reset" onClick={() => onChange({})} title="Reset every shortcut to its default">
          Reset all
        </button>
      </div>
      {conflicts.size > 0 && (
        <div className="keybinds-conflicts" role="alert">
          {[...conflicts].map(([code, ids]) => (
            <div className="keybinds-conflict" key={code}>
              <span className="bind-key">{codeLabel(code)}</span> drives {ids.map((id) => actionLabel.get(id) ?? id).join(" + ")} — only the last takes effect; rebind one.
            </div>
          ))}
        </div>
      )}
      {groups.map(({ group, actions }) => (
        <div className="bind-group" key={group}>
          <div className="bind-group-title">{group}</div>
          {actions.map((a) => (
            <div className="bind-row" key={a.id}>
              <div className="bind-desc">
                {a.label}
                {a.shiftLabel && <span className="bind-shift"> · ⇧ {a.shiftLabel}</span>}
              </div>
              <div className="bind-chips">
                {chip(a.id, "primary", merged[a.id]?.primary ?? "")}
                {chip(a.id, "secondary", merged[a.id]?.secondary ?? "")}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
