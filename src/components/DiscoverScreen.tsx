import { useEffect, useState } from "react";
import { type LiveRoom, fetchLiveRooms } from "@htl/account";
import { DockResizer } from "./DockResizer";
import { goToHandle } from "./social/util";

// Discover — the browse-what's-out-there surface, its OWN right-dock panel (NOT part of a
// profile, NOT part of the room). Two facets of one browse experience: LIVE NOW (sessions
// broadcasting right now) and SETS (published/popular recordings — lands with Epic G). It
// reads the same live-rooms signal the Session entry and a profile's live badge read; here
// it's the directory. A row taps through to /@handle (your own) or tunes you in (anyone
// else). See docs/social-layer.md → "Surface architecture (UI)".

export function DiscoverScreen({
  self,
  tunedTo,
  onListen,
  onClose,
}: {
  self: string | null;
  tunedTo: string | null;
  onListen: (handle: string) => void;
  onClose: () => void;
}) {
  const [rooms, setRooms] = useState<LiveRoom[] | null>(null); // null = first load not back yet
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchLiveRooms()
        .then((r) => alive && setRooms(r))
        .catch(() => alive && setRooms((prev) => prev ?? []));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Tapping a room TUNES IN (read-only listen); your own room taps through to its profile.
  const tap = (handle: string) => (handle === self ? goToHandle(handle) : onListen(handle));
  const live = rooms ?? [];

  return (
    <div className="modal-backdrop dock-right" onPointerDown={onClose}>
      <DockResizer varName="--dock-w-right" measure="parent" />
      <div className="panel discover-screen" onPointerDown={(e) => e.stopPropagation()}>
        <div className="discover-head">
          <span className="discover-title">Discover</span>
        </div>

        <div className="discover-section">
          <div className="social-section-head live-now-head">● Live now</div>
          {rooms === null ? (
            <p className="discover-empty">Loading…</p>
          ) : live.length === 0 ? (
            <p className="discover-empty">No one's live right now — when someone goes live, they show up here.</p>
          ) : (
            <ul className="live-now-list">
              {live.map((r) => (
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
          )}
        </div>

        {/* SETS facet plugs in here when Epic G1 lands (published/popular recordings, replayed
            on-device from the persisted recipe). Same browse UX, persistent twin of Live now. */}
      </div>
    </div>
  );
}
