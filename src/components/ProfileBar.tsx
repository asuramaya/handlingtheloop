import { useEffect, useRef, useState, type ReactNode } from "react";

// The shared "save / share / sync" control for the three named-profile systems — colour
// themes, keyboard profiles, MIDI maps. One selector dropdown + one tool row (Save as /
// Update / Rename / Duplicate / Copy / Export / Import / Delete) + a "· synced" badge + a
// transient note line, so all three Settings tabs look and behave identically. Adapter-
// driven: it knows nothing about Settings; each panel supplies how to snapshot / apply /
// build / (de)serialize its payload and commits the result via `onCommit`.

export interface ProfileLike {
  id: string;
  name: string;
}

export interface ProfileBarAdapter<P extends ProfileLike, Payload> {
  profiles: P[];
  activeId: string | null;
  /** What the dropdown's zero option reads ("Default keys", "Built-in / none"). */
  zeroLabel: string;
  /** Payload to apply when the zero option is picked; omit/undefined = leave live state as-is
   *  (colour has no overlay to clear — selecting "none" must NOT wipe the current colours). */
  zeroPayload?: () => Payload | undefined;
  /** Capture the live state as a payload (for Save as / Update). */
  snapshotCurrent: () => Payload;
  /** A profile's stored payload (applied when it's loaded / duplicated / imported). */
  payloadOf: (p: P) => Payload;
  buildNew: (name: string, payload: Payload) => P;
  duplicate: (p: P) => P;
  updateProfile: (p: P, payload: Payload) => P;
  parseText: (text: string) => P | null;
  exportText: (p: P) => string;
  /** Sub-label inside the synced badge, e.g. "12 custom". */
  describe?: (p: P) => string;
  /** Trailing text on each option, e.g. " · DDJ-FLX4". */
  optionSuffix?: (p: P) => string;
  /** Download file extension, e.g. "htltheme.json". */
  fileExt?: string;
  /** Singular noun for prompts, e.g. "theme" / "map" / "profile". */
  noun?: string;
  /** Extra controls rendered on the selector row (e.g. a colour swatch). */
  extras?: ReactNode;
  /** Commit a settings change: replace the list, set the active id, optionally apply a payload. */
  onCommit: (next: { profiles: P[]; activeId: string | null; payload?: Payload }) => void;
}

export function ProfileBar<P extends ProfileLike, Payload>({
  adapter,
  compact = false,
}: {
  adapter: ProfileBarAdapter<P, Payload>;
  // HEADER MODE. The nine verbs collapse behind one glyph and the selector shrinks to a chip,
  // so the whole control fits on the panel's title line instead of eating a card in every tab.
  // The grouping survives the collapse — the menu is still Save / Share / Manage, because that
  // grouping is what made nine peers readable and hiding them does not un-flatten them.
  compact?: boolean;
}) {
  const { profiles, activeId, noun = "profile" } = adapter;
  const active = profiles.find((p) => p.id === activeId) ?? null;
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState<null | "save" | "rename">(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Opening the namer focuses it, so the flow reads like the prompt it replaced: press, type,
  // Enter. Any change of the active profile disarms a pending delete — arming is about THIS
  // profile, and silently carrying it onto another one is exactly the accident it prevents.
  useEffect(() => {
    if (asking) nameRef.current?.focus();
  }, [asking]);
  useEffect(() => {
    setArmedDelete(false);
    setAsking(null);
  }, [activeId]);
  // Outside press / Escape closes the verb menu. Attached in an effect, so the pointerdown that
  // OPENED it has already been and gone and cannot immediately close it again — the same causal
  // guard the board's context menu needs.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement)?.closest?.(".profilebar-menu-wrap")) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);
  useEffect(() => {
    if (!armedDelete) return;
    const t = window.setTimeout(() => setArmedDelete(false), 4000);
    return () => window.clearTimeout(t);
  }, [armedDelete]);

  const flash = (m: string) => {
    setNote(m);
    window.setTimeout(() => setNote((cur) => (cur === m ? null : cur)), 1800);
  };

  const load = (id: string) => {
    if (!id) return adapter.onCommit({ profiles, activeId: null, payload: adapter.zeroPayload?.() });
    const p = profiles.find((x) => x.id === id);
    if (p) adapter.onCommit({ profiles, activeId: id, payload: adapter.payloadOf(p) });
  };
  // ★ NO window.prompt / window.confirm. Three reasons, in order of how much they cost:
  // a native dialog steals the whole window for a one-word answer and looks nothing like the
  // app around it; it cannot be styled, so it is the one part of this panel no design language
  // reaches; and it is blocked outright in a sandboxed iframe, which is how this panel gets
  // tested. Naming and confirming now happen INSIDE the card, in the row grammar.
  const commitName = (name: string) => {
    const n = name.trim();
    if (!n) return;
    if (asking === "save") {
      const p = adapter.buildNew(n, adapter.snapshotCurrent());
      adapter.onCommit({ profiles: [...profiles, p], activeId: p.id });
      flash(`Saved "${p.name}".`);
    } else if (asking === "rename" && active) {
      adapter.onCommit({ profiles: profiles.map((p) => (p.id === active.id ? { ...p, name: n } : p)), activeId });
      flash(`Renamed to "${n}".`);
    }
    setAsking(null);
  };
  const update = () => {
    if (!active) return;
    const updated = adapter.updateProfile(active, adapter.snapshotCurrent());
    adapter.onCommit({ profiles: profiles.map((p) => (p.id === active.id ? updated : p)), activeId });
    flash(`Updated "${active.name}".`);
  };

  const duplicate = () => {
    if (!active) return;
    const d = adapter.duplicate(active);
    adapter.onCommit({ profiles: [...profiles, d], activeId: d.id, payload: adapter.payloadOf(d) });
  };
  // Delete ARMS first and commits on a second press, so the destructive button is never one
  // stray click from gone — and disarms itself after 4s so it cannot sit armed and surprise you.
  const del = () => {
    if (!active) return;
    if (!armedDelete) return setArmedDelete(true);
    adapter.onCommit({ profiles: profiles.filter((p) => p.id !== active.id), activeId: null, payload: adapter.zeroPayload?.() });
    setArmedDelete(false);
    flash(`Deleted "${active.name}".`);
  };
  const copy = async () => {
    if (!active) return;
    const text = adapter.exportText(active);
    try {
      await navigator.clipboard.writeText(text);
      flash(`Copied "${active.name}" — paste to share.`);
    } catch {
      flash("Clipboard blocked — use Export to save a file instead.");
    }
  };
  const exportFile = () => {
    if (!active) return;
    const blob = new Blob([adapter.exportText(active)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${active.name.replace(/[^\w.-]+/g, "_")}.${adapter.fileExt ?? "htl.json"}`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const intake = (text: string) => {
    const p = adapter.parseText(text);
    if (!p) return flash(`That isn't a valid ${noun}.`);
    adapter.onCommit({ profiles: [...profiles, p], activeId: p.id, payload: adapter.payloadOf(p) });
    flash(`Imported "${p.name}".`);
  };
  const onFile = async (file: File | undefined) => {
    if (file) intake(await file.text());
  };
  const paste = async () => {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      flash(`Clipboard blocked — use Import to load a ${noun} file instead.`);
      return;
    }
    if (text.trim()) intake(text);
    else flash("Clipboard is empty.");
  };

  // The verb list, declared once and rendered by both modes — a compact menu that drifts from
  // the expanded bar is two controls wearing one name.
  const GROUPS: { title: string; items: { label: string; run: () => void; off?: boolean; danger?: boolean }[] }[] = [
    {
      title: "Save",
      items: [
        { label: `Save as…`, run: () => setAsking("save") },
        { label: "Update", run: update, off: !active },
      ],
    },
    {
      title: "Share",
      items: [
        { label: "Copy", run: copy, off: !active },
        { label: "Export", run: exportFile, off: !active },
        { label: "Import", run: () => fileRef.current?.click() },
        { label: "Paste", run: paste },
      ],
    },
    {
      title: "Manage",
      items: [
        { label: "Rename", run: () => setAsking("rename"), off: !active },
        { label: "Duplicate", run: duplicate, off: !active },
        { label: armedDelete ? "Sure?" : "Delete", run: del, off: !active, danger: true },
      ],
    },
  ];

  const selector = (
    <select
      className="profilebar-select"
      value={activeId ?? ""}
      onChange={(e) => load(e.target.value)}
      aria-label={`Active ${noun}`}
    >
      <option value="">{adapter.zeroLabel}</option>
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {adapter.optionSuffix?.(p) ?? ""}
        </option>
      ))}
    </select>
  );

  // The namer that replaced window.prompt: the answer is typed where the question was asked.
  const namer = asking && (
    <span className="profilebar-namer">
      <input
        ref={nameRef}
        className="profilebar-name-input"
        defaultValue={asking === "rename" ? (active?.name ?? "") : ""}
        placeholder={asking === "save" ? `name this ${noun}` : noun}
        aria-label={asking === "save" ? `Name this ${noun}` : `Rename ${noun}`}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitName((e.target as HTMLInputElement).value);
          if (e.key === "Escape") setAsking(null);
        }}
      />
      <button className="hw-btn small" onClick={() => commitName(nameRef.current?.value ?? "")}>OK</button>
      <button className="hw-btn small" onClick={() => setAsking(null)}>Cancel</button>
    </span>
  );

  const fileInput = (
    <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => onFile(e.target.files?.[0] ?? undefined)} />
  );

  if (compact) {
    return (
      <div className="profilebar compact">
        {adapter.extras}
        {selector}
        <span className="profilebar-menu-wrap">
          <button
            className={`profilebar-menu-btn ${menuOpen ? "on" : ""}`}
            aria-label={`Manage ${noun}s`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="profilebar-menu" role="menu">
              {GROUPS.map((g) => (
                <div key={g.title} className="profilebar-menu-group">
                  <div className="profilebar-menu-title">{g.title}</div>
                  {g.items.map((it) => (
                    <button
                      key={it.label}
                      role="menuitem"
                      className={`profilebar-menu-item ${it.danger ? "danger" : ""} ${it.danger && armedDelete ? "armed" : ""}`}
                      disabled={it.off}
                      onClick={() => {
                        it.run();
                        // Delete arms in place, so its menu stays open for the second press;
                        // everything else is done the moment it fires.
                        if (!(it.danger && !armedDelete)) setMenuOpen(false);
                      }}
                    >
                      {it.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </span>
        {namer}
        {fileInput}
        {note && <span className="profilebar-note compact">{note}</span>}
      </div>
    );
  }

  return (
    <div className="profilebar">
      <div className="settings-row">
        <span className="settings-label">Active</span>
        <span className="settings-control">
          {adapter.extras}
          {active && <span className="settings-value">{adapter.describe ? adapter.describe(active) : "saved"}</span>}
        </span>
      </div>
      {selector}
      {asking && (
        <div className="settings-row">
          <span className="settings-label">{asking === "save" ? `Name this ${noun}` : `Rename ${noun}`}</span>
          <span className="settings-control">{namer}</span>
        </div>
      )}
      {GROUPS.map((g) => (
        <div key={g.title} className="settings-row">
          <span className="settings-label">{g.title}</span>
          <span className="settings-control">
            <span className="seg-group">
              {g.items.map((it) => (
                <button
                  key={it.label}
                  className={`hw-btn small ${it.danger ? "danger" : ""} ${it.danger && armedDelete ? "armed" : ""}`}
                  disabled={it.off}
                  onClick={it.run}
                >
                  {it.label}
                </button>
              ))}
            </span>
          </span>
        </div>
      ))}
      {fileInput}
      {note && <p className="profilebar-note">{note}</p>}
    </div>
  );
}
