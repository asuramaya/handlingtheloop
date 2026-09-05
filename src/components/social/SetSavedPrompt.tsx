import { useEffect, useState } from "react";
import { type SetCard, discardSet, fetchMySets, publishSet } from "@htl/account";
import { fmtTime } from "../../util/format";

// The just-recorded prompt — the ONLY recordings affordance left in Session after the
// redesign (the full list is a "person" thing → Profile). When a broadcast ends and its
// recipe is saved (room.setsRev bumps, G1a), surface the fresh draft once: Publish now, or
// Discard. Anything else (keep as draft, rename, browse) is a tap away in Profile, so this
// stays a one-line nudge, never a manager. Dismissible; gone on dismiss or the next capture.
export function SetSavedPrompt({ setsRev }: { setsRev: number }) {
  const [set, setSet] = useState<SetCard | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (setsRev <= 0) return;
    let live = true;
    fetchMySets()
      .then((sets) => {
        if (live) setSet(sets.find((s) => s.status === "draft") ?? null); // newest-first → newest draft
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [setsRev]);

  if (!set) return null;
  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    await fn();
    setBusy(false);
    setSet(null);
  };

  return (
    <div className="set-saved">
      <div className="set-saved-main">
        <span className="set-saved-title">✓ Set recorded</span>
        <span className="set-saved-meta">
          {fmtTime(Math.round(set.duration / 1000))} · {set.tracks} track{set.tracks === 1 ? "" : "s"} · saved as a draft
        </span>
      </div>
      <div className="set-saved-acts">
        <button className="set-saved-publish" disabled={busy} onClick={() => run(() => publishSet(set.id))}>
          Publish
        </button>
        <button className="set-saved-discard" disabled={busy} onClick={() => run(() => discardSet(set.id))}>
          Discard
        </button>
        <button className="set-saved-x" onClick={() => setSet(null)}>
          ✕
        </button>
      </div>
    </div>
  );
}
