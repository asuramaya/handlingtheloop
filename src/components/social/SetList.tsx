import { useState } from "react";
import type { SetCard } from "@htl/account";
import { fmtTime } from "../../util/format";

// A published-set list — the browse card shared by Discover (showHost: many DJs) and a public
// /@handle profile (the host's own history). Tapping the card EXPANDS its captured tracklist
// (G2 — the shareable set artifact); the ▶ button replays it on-device (G1c) via onPlay.
export function SetList({ sets, onPlay, showHost }: { sets: SetCard[]; onPlay?: (id: string) => void; showHost?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (sets.length === 0) return null;
  return (
    <ul className="set-list">
      {sets.map((s) => {
        const expanded = open === s.id;
        return (
          <li key={s.id} className={`set-card ${expanded ? "open" : ""}`}>
            <div className="set-row">
              <button className="set-cover" aria-label="Show tracklist" onClick={() => setOpen(expanded ? null : s.id)}>
                {s.coverVideo ? <img src={`https://i.ytimg.com/vi/${s.coverVideo}/mqdefault.jpg`} alt="" loading="lazy" /> : <span className="set-cover-ph">♪</span>}
              </button>
              <button className="set-main" onClick={() => setOpen(expanded ? null : s.id)}>
                <span className="set-title">{s.title || setLabel(s)}</span>
                {showHost && s.handle && <span className="set-host">@{s.handle}</span>}
                <span className="set-meta">
                  {fmtTime(Math.round(s.duration / 1000))} · {s.tracks} track{s.tracks === 1 ? "" : "s"} · {expanded ? "▾" : "▸"}
                </span>
              </button>
              <button className="set-share-btn" title="Copy share link" onClick={() => shareSet(s.id)}>
                ⤴
              </button>
              {onPlay && (
                <button className="set-play-btn" title="Replay this set" onClick={() => onPlay(s.id)}>
                  ▶
                </button>
              )}
            </div>
            {expanded && (
              <ol className="set-tracks">
                {s.tracklist.length === 0 ? (
                  <li className="set-track-empty">No tracklist captured.</li>
                ) : (
                  s.tracklist.map((t, i) => (
                    <li key={i} className="set-track">
                      <span className="set-track-at">{fmtTime(Math.round(t.at / 1000))}</span>
                      <span className="set-track-name">
                        {t.title || t.videoId}
                        {t.artist && <span className="set-track-artist"> — {t.artist}</span>}
                      </span>
                    </li>
                  ))
                )}
              </ol>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function setLabel(s: SetCard): string {
  const at = s.publishedAt ?? s.createdAt;
  return `Set · ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

// Copy a shareable /set/:id link (G4 — it unfurls with an OG card off the worker). Falls back to
// the native share sheet on mobile.
function shareSet(id: string): void {
  const url = `${location.origin}/set/${id}`;
  const nav = navigator as Navigator & { share?: (d: { url: string }) => Promise<void> };
  if (nav.share) void nav.share({ url }).catch(() => {});
  else void navigator.clipboard?.writeText(url).catch(() => {});
}
