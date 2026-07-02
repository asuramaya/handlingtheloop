import { useCallback, useEffect, useState } from "react";
import { type SetCard, discardSet, fetchMySets, publishSet, renameSet, unpublishSet } from "@htl/account";
import { fmtTime } from "../../util/format";
import { trimRange } from "./SetList";

// G1b — the host's Recordings: the post-set lifecycle home. Capture-by-default drops a
// private DRAFT whenever a broadcast ends (G1a); here the host curates it — Publish (→ their
// profile + Discover, G1d), rename, or Discard. Lives on the OWN Profile (the "person" axis,
// `defaultOpen` as a real section) per the redesign; `setsRev` lets a host surface refetch
// when a fresh set lands. Hidden entirely until the first set.
export function RecordingsPanel({
  setsRev = 0,
  heading = "🔴 Recordings",
  defaultOpen = false,
  onPlay,
  onTrim,
}: {
  setsRev?: number;
  heading?: string;
  defaultOpen?: boolean;
  onPlay?: (id: string, range?: { start: number; end: number }) => void; // G1c: replay (curated range)
  onTrim?: (s: SetCard) => void; // trim the performance in/out before publishing
}) {
  const [sets, setSets] = useState<SetCard[] | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchMySets()
      .then(setSets)
      .catch(() => {});
  }, []);
  useEffect(() => load(), [load]);
  // A new recording just landed (a broadcast ended, G1a) → refetch + reveal it.
  useEffect(() => {
    if (setsRev > 0) {
      setOpen(true);
      load();
    }
  }, [setsRev, load]);

  const act = async (id: string, fn: () => Promise<boolean>) => {
    setBusy(id);
    await fn();
    setBusy(null);
    setConfirmDel(null);
    load();
  };
  const saveName = (id: string) => {
    void act(id, () => renameSet(id, title));
    setEditing(null);
  };

  if (!sets || sets.length === 0) return null; // nothing recorded yet → no clutter
  const drafts = sets.filter((s) => s.status === "draft").length;

  return (
    <section className="recordings">
      <button className="recordings-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="recordings-title">{heading} · {sets.length}</span>
        {drafts > 0 && <span className="recordings-badge">{drafts} draft{drafts > 1 ? "s" : ""}</span>}
        <span className="recordings-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="recordings-list">
          {sets.map((s) => (
            <li key={s.id} className={`rec-item ${s.status}`}>
              <div className="rec-cover" aria-hidden="true">
                {s.coverVideo ? <img src={`/api/art/${s.coverVideo}`} alt="" loading="lazy" /> : <span className="rec-cover-ph">♪</span>}
              </div>
              <div className="rec-main">
                {editing === s.id ? (
                  <input
                    className="rec-rename"
                    autoFocus
                    value={title}
                    placeholder={defaultLabel(s)}
                    onChange={(e) => setTitle(e.target.value)}
                    onBlur={() => saveName(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveName(s.id);
                      else if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <button
                    className="rec-name"
                    title="Rename"
                    onClick={() => {
                      setEditing(s.id);
                      setTitle(s.title ?? "");
                    }}
                  >
                    {s.title || defaultLabel(s)}
                  </button>
                )}
                <span className="rec-meta">
                  {s.status === "published" ? <span className="rec-pub">● Public</span> : <span className="rec-draft">Draft</span>}
                  {" · "}
                  {fmtTime(Math.round(s.duration / 1000))}
                  {" · "}
                  {s.tracks} track{s.tracks === 1 ? "" : "s"}
                </span>
              </div>
              <div className="rec-acts">
                {onPlay && (
                  <button className="rec-play" title="Replay this set on the decks" onClick={() => onPlay(s.id, trimRange(s))}>
                    ▶
                  </button>
                )}
                {onTrim && (
                  <button className="rec-trim" title="Trim the performance in/out" onClick={() => onTrim(s)}>
                    ✂
                  </button>
                )}
                {s.status === "draft" ? (
                  <button className="rec-publish" disabled={busy === s.id} onClick={() => act(s.id, () => publishSet(s.id))}>
                    Publish
                  </button>
                ) : (
                  <button className="rec-unpublish" disabled={busy === s.id} onClick={() => act(s.id, () => unpublishSet(s.id))}>
                    Unpublish
                  </button>
                )}
                {confirmDel === s.id ? (
                  <button className="rec-discard confirm" disabled={busy === s.id} onClick={() => act(s.id, () => discardSet(s.id))} title="Confirm discard">
                    Delete?
                  </button>
                ) : (
                  <button className="rec-discard" title="Discard recording" onClick={() => setConfirmDel(s.id)}>
                    🗑
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A friendly fallback label for an unnamed set ("Set · Jun 19"). */
function defaultLabel(s: SetCard): string {
  return `Set · ${new Date(s.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
