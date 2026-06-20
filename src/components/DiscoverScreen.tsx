import { useEffect, useState } from "react";
import { type LiveRoom, type SetCard, fetchDiscoverSets, fetchFollowing, fetchLiveRooms } from "@htl/account";
import { DockResizer } from "./DockResizer";
import { SetList } from "./social/SetList";
import { goToHandle } from "./social/util";

// Discover — the browse-what's-out-there surface, its OWN right-dock panel (NOT part of a
// profile, NOT part of the room). Facets of one browse experience: "From people you follow"
// (J1) + LIVE NOW (the whole public directory), and SETS (published/popular recordings —
// lands with Epic G). It reads the same live-rooms signal the Session entry and a profile's
// live badge read; here it's the directory. A row taps through to /@handle (your own) or
// tunes you in (anyone else). See docs/social-layer.md → "Surface architecture (UI)".

export function DiscoverScreen({
  self,
  tunedTo,
  onListen,
  onClose,
  onPlaySet,
}: {
  self: string | null;
  tunedTo: string | null;
  onListen: (handle: string) => void;
  onClose: () => void;
  onPlaySet?: (id: string) => void; // G1c/G1d: replay a published set on the decks
}) {
  const [rooms, setRooms] = useState<LiveRoom[] | null>(null); // null = first load not back yet
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [sets, setSets] = useState<SetCard[]>([]);

  useEffect(() => {
    let alive = true;
    fetchDiscoverSets()
      .then((s) => alive && setSets(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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

  // Who I follow → so the directory can surface their rooms first (J1). Refreshed when the
  // signed-in handle changes; the follow graph shifts slowly, so no polling.
  useEffect(() => {
    if (!self) {
      setFollowing(new Set());
      return;
    }
    let alive = true;
    fetchFollowing(self)
      .then((cards) => alive && setFollowing(new Set(cards.map((c) => c.handle).filter((h): h is string => !!h))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [self]);

  // Tapping a room TUNES IN (read-only listen); your own room taps through to its profile.
  const tap = (handle: string) => (handle === self ? goToHandle(handle) : onListen(handle));
  const live = rooms ?? [];
  const followed = self ? live.filter((r) => following.has(r.handle)) : [];
  const rest = followed.length ? live.filter((r) => !following.has(r.handle)) : live;

  const renderRoom = (r: LiveRoom) => (
    <li key={r.handle} className={`live-room ${r.handle === tunedTo ? "tuned" : ""}`} onClick={() => tap(r.handle)}>
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
  );

  return (
    <div className="modal-backdrop dock-right" onPointerDown={onClose}>
      <DockResizer varName="--dock-w-right" measure="parent" />
      <div className="panel discover-screen" onPointerDown={(e) => e.stopPropagation()}>
        <div className="discover-head">
          <span className="discover-title">Discover</span>
        </div>

        {rooms === null ? (
          <p className="discover-empty">Loading…</p>
        ) : live.length === 0 ? (
          <div className="discover-section">
            <div className="social-section-head live-now-head">● Live now</div>
            <p className="discover-empty">No one's live right now — when someone goes live, they show up here.</p>
          </div>
        ) : (
          <>
            {followed.length > 0 && (
              <div className="discover-section">
                <div className="social-section-head">From people you follow</div>
                <ul className="live-now-list">{followed.map(renderRoom)}</ul>
              </div>
            )}
            {rest.length > 0 && (
              <div className="discover-section">
                <div className="social-section-head live-now-head">
                  {followed.length > 0 ? "Also live now" : "● Live now"}
                </div>
                <ul className="live-now-list">{rest.map(renderRoom)}</ul>
              </div>
            )}
          </>
        )}

        {/* SETS — published recordings, replayed on-device from the recipe (G1d). The
            persistent twin of Live now; tap a card to replay it on your decks. */}
        {sets.length > 0 && (
          <div className="discover-section">
            <div className="social-section-head">Sets</div>
            <SetList sets={sets} onPlay={onPlaySet} showHost />
          </div>
        )}
      </div>
    </div>
  );
}
