import { useRef, useState, type ReactNode } from "react";

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

export function ProfileBar<P extends ProfileLike, Payload>({ adapter }: { adapter: ProfileBarAdapter<P, Payload> }) {
  const { profiles, activeId, noun = "profile" } = adapter;
  const active = profiles.find((p) => p.id === activeId) ?? null;
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const flash = (m: string) => {
    setNote(m);
    window.setTimeout(() => setNote((cur) => (cur === m ? null : cur)), 1800);
  };

  const load = (id: string) => {
    if (!id) return adapter.onCommit({ profiles, activeId: null, payload: adapter.zeroPayload?.() });
    const p = profiles.find((x) => x.id === id);
    if (p) adapter.onCommit({ profiles, activeId: id, payload: adapter.payloadOf(p) });
  };
  const saveAs = () => {
    const name = window.prompt(`Name this ${noun}`, "")?.trim();
    if (!name) return;
    const p = adapter.buildNew(name, adapter.snapshotCurrent());
    adapter.onCommit({ profiles: [...profiles, p], activeId: p.id });
    flash(`Saved "${p.name}" — synced to your account.`);
  };
  const update = () => {
    if (!active) return;
    const updated = adapter.updateProfile(active, adapter.snapshotCurrent());
    adapter.onCommit({ profiles: profiles.map((p) => (p.id === active.id ? updated : p)), activeId });
    flash(`Updated "${active.name}".`);
  };
  const rename = () => {
    if (!active) return;
    const name = window.prompt(`Rename ${noun}`, active.name)?.trim();
    if (!name) return;
    adapter.onCommit({ profiles: profiles.map((p) => (p.id === active.id ? { ...p, name } : p)), activeId });
  };
  const duplicate = () => {
    if (!active) return;
    const d = adapter.duplicate(active);
    adapter.onCommit({ profiles: [...profiles, d], activeId: d.id, payload: adapter.payloadOf(d) });
  };
  const del = () => {
    if (!active || !window.confirm(`Delete "${active.name}"? This can't be undone.`)) return;
    adapter.onCommit({ profiles: profiles.filter((p) => p.id !== active.id), activeId: null, payload: adapter.zeroPayload?.() });
  };
  const copy = async () => {
    if (!active) return;
    const text = adapter.exportText(active);
    try {
      await navigator.clipboard.writeText(text);
      flash(`Copied "${active.name}" — paste to share.`);
    } catch {
      window.prompt("Copy this share code:", text);
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
      text = window.prompt(`Paste a ${noun} share code:`) || "";
    }
    if (text.trim()) intake(text);
  };

  return (
    <div className="profilebar">
      <div className="profilebar-row">
        <select className="profilebar-select" value={activeId ?? ""} onChange={(e) => load(e.target.value)}>
          <option value="">{adapter.zeroLabel}</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {adapter.optionSuffix?.(p) ?? ""}
            </option>
          ))}
        </select>
        {adapter.extras}
        {active && (
          <span className="profilebar-badge">{adapter.describe ? `${adapter.describe(active)} · synced` : "synced"}</span>
        )}
      </div>
      <div className="profilebar-tools">
        <button className="hw-btn small" onClick={saveAs}>Save as…</button>
        <button className="hw-btn small" onClick={update} disabled={!active}>Update</button>
        <button className="hw-btn small" onClick={rename} disabled={!active}>Rename</button>
        <button className="hw-btn small" onClick={duplicate} disabled={!active}>Duplicate</button>
        <button className="hw-btn small" onClick={copy} disabled={!active}>Copy</button>
        <button className="hw-btn small" onClick={exportFile} disabled={!active}>Export</button>
        <button className="hw-btn small" onClick={() => fileRef.current?.click()}>Import</button>
        <button className="hw-btn small" onClick={paste}>Paste</button>
        <button className="hw-btn small danger" onClick={del} disabled={!active}>Delete</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => onFile(e.target.files?.[0] ?? undefined)} />
      </div>
      {note && <p className="profilebar-note">{note}</p>}
    </div>
  );
}
