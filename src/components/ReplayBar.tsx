import { useEffect, useState } from "react";
import type { ReplayState } from "../htl/replay/useSetReplay";
import { fmtTime } from "../util/format";

// When the owner replays their own draft, App passes a TrimEdit so they can curate the
// performance in/out before publishing (cut the dead air at the head/tail).
export interface TrimEdit {
  setId: string;
  start: number; // ms — seed in-point (existing trim or 0)
  end: number; // ms — seed out-point (existing trim or duration)
  onSave: (start: number, end: number) => void;
  onClear: () => void;
}

// G1c — the recorded-set replay transport: play/pause, a seekable progress bar, stop. TRIM mode
// (owner only) adds [Set start]/[Set end] (to the playhead) + Save, and shades the kept range —
// the curated [in,out] is what everyone then replays.
export function ReplayBar({ replay, trim }: { replay: ReplayState; trim?: TrimEdit | null }) {
  const [tin, setTin] = useState(0);
  const [tout, setTout] = useState(0);
  useEffect(() => {
    if (trim) {
      setTin(trim.start);
      setTout(trim.end || replay.duration);
    }
  }, [trim?.setId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!replay.active) return null;
  const pct = replay.duration > 0 ? (replay.position / replay.duration) * 100 : 0;

  const onScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    replay.seek(f * replay.duration);
  };

  const dur = replay.duration || 1;

  return (
    <div className="replay-bar">
      <div className="replay-row">
        <span className="replay-tag">{trim ? "✂ Trim your set" : "▶ Replaying a set"}</span>
        {replay.engineStale && (
          <span className="replay-stale" title="This set was recorded on a different engine version — the rebuild may differ.">
            ⚠ different version
          </span>
        )}
        {trim ? (
          <>
            <button className="replay-trim-save" disabled={tout <= tin} onClick={() => trim.onSave(Math.round(tin), Math.round(tout))} title="Save the trimmed performance">
              Save {fmtTime(Math.round((tout - tin) / 1000))}
            </button>
            <button className="replay-stop" onClick={trim.onClear} title="Cancel trimming">
              ✕
            </button>
          </>
        ) : (
          <button className="replay-stop" onClick={replay.stop} title="Stop replay (release the decks)">
            ✕
          </button>
        )}
      </div>
      <div className="replay-controls">
        <button className="replay-toggle" onClick={replay.toggle} disabled={replay.loading} aria-label={replay.playing ? "Pause" : "Play"}>
          {replay.loading ? "…" : replay.playing ? "❚❚" : "▶"}
        </button>
        <span className="replay-time">{fmtTime(Math.round(replay.position / 1000))}</span>
        <div className={`replay-track ${trim ? "trimming" : ""}`} onClick={onScrub} role="slider" aria-label="Seek" aria-valuenow={Math.round(pct)}>
          {trim && (
            <>
              <div className="replay-trim-shade" style={{ left: `${(tin / dur) * 100}%`, width: `${((tout - tin) / dur) * 100}%` }} />
              <div className="replay-trim-mark in" style={{ left: `${(tin / dur) * 100}%` }} data-label="IN" />
              <div className="replay-trim-mark out" style={{ left: `${(tout / dur) * 100}%` }} data-label="OUT" />
            </>
          )}
          <div className="replay-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="replay-time">{fmtTime(Math.round(replay.duration / 1000))}</span>
      </div>
      {trim && (
        <div className="replay-trim-row">
          <button className="replay-trim-set" onClick={() => setTin(replay.position)}>
            ⟦ Start here ({fmtTime(Math.round(tin / 1000))})
          </button>
          <span className="replay-trim-hint">scrub to the in/out, then Save</span>
          <button className="replay-trim-set" onClick={() => setTout(replay.position)}>
            End here ({fmtTime(Math.round(tout / 1000))}) ⟧
          </button>
        </div>
      )}
    </div>
  );
}
