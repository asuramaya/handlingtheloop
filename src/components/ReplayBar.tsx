import { useState } from "react";
import type { ReplayState } from "../htl/replay/useSetReplay";
import { fmtTime } from "../util/format";

// G1c — the recorded-set replay transport. A slim bar that appears while a set is replaying
// (the decks are being driven by the recipe). Play/pause, a seekable progress bar, and stop
// (which releases the decks). A D5 engine-version mismatch warns that the rebuild may differ.
// G3 — mark a clip [in,out] and copy a shareable /set/:id?t= link to that moment.
export function ReplayBar({ replay }: { replay: ReplayState }) {
  const [clipIn, setClipIn] = useState<number | null>(null);
  const [shared, setShared] = useState(false);
  if (!replay.active) return null;
  const pct = replay.duration > 0 ? (replay.position / replay.duration) * 100 : 0;

  // First tap marks the in-point; second tap (out) copies the clip link to this moment.
  const clip = () => {
    if (clipIn == null) {
      setClipIn(replay.position);
      return;
    }
    const a = Math.round(Math.min(clipIn, replay.position) / 1000);
    const b = Math.round(Math.max(clipIn, replay.position) / 1000);
    setClipIn(null);
    if (!replay.setId || b <= a) return;
    const url = `${location.origin}/set/${replay.setId}?t=${a}-${b}`;
    const nav = navigator as Navigator & { share?: (d: { url: string }) => Promise<void> };
    if (nav.share) void nav.share({ url }).catch(() => {});
    else void navigator.clipboard?.writeText(url).catch(() => {});
    setShared(true);
    setTimeout(() => setShared(false), 1600);
  };

  const onScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    replay.seek(f * replay.duration);
  };

  return (
    <div className="replay-bar">
      <div className="replay-row">
        <span className="replay-tag">▶ Replaying a set</span>
        {replay.engineStale && (
          <span className="replay-stale" title="This set was recorded on a different engine version — the rebuild may differ.">
            ⚠ different version
          </span>
        )}
        <button
          className={`replay-clip ${clipIn != null ? "armed" : ""}`}
          onClick={clip}
          title={clipIn == null ? "Clip — mark the start of a moment" : "Mark the end + copy the clip link"}
        >
          {shared ? "link copied ✓" : clipIn == null ? "⚑ Clip" : `⚑ out (${fmtTime(Math.round(clipIn / 1000))})`}
        </button>
        <button className="replay-stop" onClick={replay.stop} title="Stop replay (release the decks)">
          ✕
        </button>
      </div>
      <div className="replay-controls">
        <button className="replay-toggle" onClick={replay.toggle} disabled={replay.loading} aria-label={replay.playing ? "Pause" : "Play"}>
          {replay.loading ? "…" : replay.playing ? "❚❚" : "▶"}
        </button>
        <span className="replay-time">{fmtTime(Math.round(replay.position / 1000))}</span>
        <div className="replay-track" onClick={onScrub} role="slider" aria-label="Seek" aria-valuenow={Math.round(pct)}>
          <div className="replay-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="replay-time">{fmtTime(Math.round(replay.duration / 1000))}</span>
      </div>
    </div>
  );
}
