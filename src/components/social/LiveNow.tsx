import { useEffect, useState } from "react";
import { type LiveRoom, fetchLiveRooms } from "@htl/account";
import { goToHandle } from "./util";

// The public "live now" directory — rooms broadcasting right now, busiest first. Polls the
// live registry; a row taps through to that host's /@handle (or tunes in if it isn't you).
export function LiveNow({
  self,
  tunedTo,
  onListen,
}: {
  self: string | null;
  tunedTo: string | null;
  onListen: (handle: string) => void;
}) {
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchLiveRooms()
        .then((r) => alive && setRooms(r))
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (rooms.length === 0) return null;
  // Tapping a room TUNES IN (read-only listen); your own room taps through to its profile.
  const tap = (handle: string) => (handle === self ? goToHandle(handle) : onListen(handle));
  return (
    <div className="live-now">
      <div className="social-section-head live-now-head">● Live now</div>
      <ul className="live-now-list">
        {rooms.map((r) => (
          <li
            key={r.handle}
            className={`live-room ${r.handle === tunedTo ? "tuned" : ""}`}
            onClick={() => tap(r.handle)}
          >
            {r.avatar ? (
              <img className="live-room-avatar" src={r.avatar} alt="" loading="lazy" />
            ) : (
              <span className="live-room-avatar fallback" aria-hidden="true">
                {(r.displayName || r.handle).slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="live-room-main">
              <span className="live-room-name">
                {r.displayName || `@${r.handle}`}
                {r.handle === self && <span className="live-room-you"> (you)</span>}
              </span>
              <span className="live-room-np">
                {r.npTitle ? `${r.npArtist ? `${r.npArtist} — ` : ""}${r.npTitle}` : `@${r.handle}`}
              </span>
            </span>
            <span className="live-room-count">{r.listeners} 🎧</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
