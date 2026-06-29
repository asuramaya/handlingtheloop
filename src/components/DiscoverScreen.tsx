import { useEffect, useState } from "react";
import { type FriendPresence, type LiveRoom, type SetCard, fetchDiscoverSets, fetchFollowing, fetchLiveRooms, sendInvite } from "@htl/account";
import { DockResizer } from "./DockResizer";
import { FriendRow } from "./social/FriendRow";
import { LiveRoomRow } from "./social/LiveRoomRow";
import { PeopleList } from "./social/PeopleList";
import { PersonSearch } from "./social/PersonSearch";
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
  friends,
  onListen,
  onJam,
  onClose,
  onPlaySet,
}: {
  self: string | null;
  tunedTo: string | null;
  friends: FriendPresence[]; // mutual-follows online now (polled by App for the chin dot, passed in)
  onListen: (handle: string) => void;
  onJam: (handle: string) => void; // knock / join a friend's session (participate)
  onClose: () => void;
  onPlaySet?: (id: string) => void; // G1c/G1d: replay a published set on the decks
}) {
  const [rooms, setRooms] = useState<LiveRoom[] | null>(null); // null = first load not back yet
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [sets, setSets] = useState<SetCard[]>([]);
  const [invited, setInvited] = useState<Set<string>>(new Set()); // optimistic "Invited ✓" by handle
  const [graphOpen, setGraphOpen] = useState(false); // "People you follow" → the shared PeopleList

  const invite = (handle: string) => {
    setInvited((s) => new Set(s).add(handle)); // optimistic
    void sendInvite(handle);
  };

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
      .then((p) => alive && setFollowing(new Set(p.list.map((c) => c.handle).filter((h): h is string => !!h))))
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

  const renderRoom = (r: LiveRoom) => <LiveRoomRow key={r.handle} room={r} self={self} tunedTo={tunedTo} onTap={tap} />;

  return (
    <div className="modal-backdrop dock-right" onPointerDown={onClose}>
      <DockResizer varName="--dock-w-right" measure="parent" />
      <div className="panel discover-screen" onPointerDown={(e) => e.stopPropagation()}>
        <div className="discover-head">
          <span className="discover-title">Discover</span>
        </div>

        {/* PEOPLE SEARCH — the directory door. Find anyone by @handle or name even when no one's
            live; a hit taps through to /@handle where Follow / Invite / Knock / Listen live. */}
        <PersonSearch onJam={onJam} onListen={onListen} />

        {/* Your persistent roster — the SAME PeopleList a profile's "following" count opens. The
            durable counterpart to Friends-online: reach anyone you follow, on or off. */}
        {self && (
          <button type="button" className="people-following-link" onClick={() => setGraphOpen(true)}>
            People you follow <span className="person-go" aria-hidden="true">›</span>
          </button>
        )}

        {/* FRIENDS ONLINE — mutual follows who are on right now. The "play with a friend" door:
            Invite pulls them into your session; Knock/Join takes you into theirs. Above the public
            live directory because it's the higher-intent, co-play surface. */}
        {friends.length > 0 && (
          <div className="discover-section">
            <div className="social-section-head friends-online-head">
              ● Friends online <span className="friends-count">· {friends.length}</span>
            </div>
            <ul className="friends-online-list">
              {friends.map((f) => (
                <FriendRow
                  key={f.handle}
                  friend={f}
                  invited={invited.has(f.handle)}
                  onInvite={invite}
                  onJam={onJam}
                  onOpen={goToHandle}
                />
              ))}
            </ul>
          </div>
        )}

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

        {graphOpen && self && (
          <PeopleList handle={self} mode="following" onClose={() => setGraphOpen(false)} onJam={onJam} onListen={onListen} />
        )}
      </div>
    </div>
  );
}
