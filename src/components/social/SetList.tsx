import type { SetCard } from "@htl/account";
import { fmtTime } from "../../util/format";

// A published-set list — the browse card shared by Discover (showHost: many DJs) and a public
// /@handle profile (the host's own history). Tapping a card replays it on-device (G1c) via the
// onPlay handler threaded down from App; without onPlay (e.g. signed-out) it's a static list.
export function SetList({ sets, onPlay, showHost }: { sets: SetCard[]; onPlay?: (id: string) => void; showHost?: boolean }) {
  if (sets.length === 0) return null;
  return (
    <ul className="set-list">
      {sets.map((s) => (
        <li
          key={s.id}
          className="set-card"
          onClick={onPlay ? () => onPlay(s.id) : undefined}
          role={onPlay ? "button" : undefined}
          title={onPlay ? "Replay this set" : undefined}
        >
          <div className="set-cover" aria-hidden="true">
            {s.coverVideo ? <img src={`https://i.ytimg.com/vi/${s.coverVideo}/mqdefault.jpg`} alt="" loading="lazy" /> : <span className="set-cover-ph">♪</span>}
            {onPlay && <span className="set-play">▶</span>}
          </div>
          <div className="set-main">
            <span className="set-title">{s.title || setLabel(s)}</span>
            {showHost && s.handle && <span className="set-host">@{s.handle}</span>}
            <span className="set-meta">
              {fmtTime(Math.round(s.duration / 1000))} · {s.tracks} track{s.tracks === 1 ? "" : "s"}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function setLabel(s: SetCard): string {
  const at = s.publishedAt ?? s.createdAt;
  return `Set · ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
