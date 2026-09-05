import { useEffect, useMemo, useState } from "react";
import {
  type FriendPresence,
  type ListenFace,
  type LiveRoom,
  type SetCard,
  fetchDiscoverSets,
  fetchLiveRooms,
  filterRooms,
  rankRooms,
  sendInvite,
} from "@htl/account";
import { FriendRow } from "./social/FriendRow";
import { LiveRoomRow } from "./social/LiveRoomRow";
import { SetList } from "./social/SetList";
import { goToHandle } from "./social/util";

// The ON AIR and SETS faces of the People dock's Explore fold: what there is to listen to right
// now, and what has been published. It reads the same live-rooms signal the Session entry and a
// profile's live badge read; here it is the directory. A row taps through to /@handle (your own)
// or tunes you in (anyone else). See docs/social-layer.md → "Surface architecture (UI)".
//
// ★ WHICH FACE IS SHOWING IS THE DOCK'S, NOT OURS. It used to be a segmented control drawn here,
// one row below the tab strip that was choosing between this surface and the graph — two controls
// for one choice. The fold's pill row above owns it now and hands it down.
//
// ★ SETS ARE A HALF, NOT A FOOTER. They used to sit BELOW a live directory that reshuffles every
// 30 s, so at any real room count they were permanently under the fold — and they are exactly
// what works when nobody is live, which is most of the time on a small network. The durable
// content had the worst position on the surface.

// How many rows a section shows before it offers "show all". Small enough that no single section
// can own the viewport, big enough to be worth reading without expanding.
const FRIEND_CAP = 5;
const ROOM_CAP = 12;

export function DiscoverScreen({
  face,
  self,
  tunedTo,
  friends,
  onListen,
  onJam,
  onPlaySet,
  onOpenPerson,
  view,
  setView,
}: {
  face: ListenFace;
  self: string | null;
  tunedTo: string | null;
  friends: FriendPresence[]; // mutual-follows online now (polled by App for the chin dot, passed in)
  onListen: (handle: string) => void;
  onJam: (handle: string) => void; // knock / join a friend's session (participate)
  onPlaySet?: (id: string) => void; // G1c/G1d: replay a published set on the decks
  onOpenPerson?: (handle: string) => void; // push a person INSIDE the dock (see PersonRow)
  // Filter and expansion belong to the DOCK, not to this component, which unmounts on every face
  // switch and would take them with it.
  view: { query: string; roomsExpanded: boolean; friendsExpanded: boolean };
  setView: (patch: Partial<{ query: string; roomsExpanded: boolean; friendsExpanded: boolean }>) => void;
}) {
  const [rooms, setRooms] = useState<LiveRoom[] | null>(null); // null = first load not back yet
  const [sets, setSets] = useState<SetCard[]>([]);
  const [invited, setInvited] = useState<Set<string>>(new Set()); // optimistic "Invited ✓" by handle
  const { query, roomsExpanded, friendsExpanded } = view;
  const setQuery = (q: string) => setView({ query: q });

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

  // ★ THE FOLLOW-GRAPH FETCH IS GONE. This used to pull the viewer's following list and
  // intersect it with the room list in the browser — and it pulled ONE PAGE, which is 50. Past
  // 50 follows a room hosted by someone you follow, who happened to sit on page 2, was filed
  // under strangers: personalisation that silently got worse the more you used the app, with
  // nothing to see and nothing to log. `/api/rooms/live` returns `rel` per room now, resolved
  // in the query that was already running. See server/db/rooms.ts.

  // Tapping a room TUNES IN (read-only listen); your own room taps through to its profile.
  const tap = (handle: string) => (handle === self ? goToHandle(handle) : onListen(handle));
  const live = useMemo(() => rooms ?? [], [rooms]);

  // ONE ranked list, re-derived only when the poll lands or the query changes. `now` is folded
  // in at rank time so "just started" ages correctly across a 30 s refresh.
  const ranked = useMemo(() => rankRooms(live, Date.now()), [live]);
  const shown = useMemo(() => filterRooms(ranked, query), [ranked, query]);
  const capped = roomsExpanded ? shown : shown.slice(0, ROOM_CAP);

  if (face === "sets") {
    return sets.length === 0 ? (
      <p className="discover-empty">No published sets yet.</p>
    ) : (
      <div className="discover-section">
        <SetList sets={sets} onPlay={onPlaySet} showHost />
      </div>
    );
  }

  return (
    <>
      {/* ★ ONE BOX, NOT TWO. This face used to open with the GLOBAL person search stacked on top
          of the room filter: two inputs, one above the other, asking the same-looking question
          about different things. Finding a person is what the People pill is for, one tap away;
          On air filters what is on air. At a hundred live rooms browsing stops working and
          filtering starts, so this box narrows by name, title, genre or what is playing. */}
      <div className="discover-filter">
        <input
          className="debug-filter discover-query"
          value={query}
          placeholder="Filter live rooms"
          aria-label="Filter live rooms"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="link-btn" onClick={() => setQuery("")}>Clear</button>
        )}
      </div>

      {/* FRIENDS ONLINE — the co-play door, CAPPED. Uncapped it was the section most likely to
          fill the viewport (it grows with your graph, not with who is broadcasting) and push the
          live directory under the fold, so the layout's priority order held only while you had
          few friends. A section that cannot overflow cannot bury the next one. */}
      {friends.length > 0 && (
        <div className="discover-section">
          <div className="social-section-head friends-online-head">
            ● Friends online <span className="friends-count">· {friends.length}</span>
          </div>
          <ul className="friends-online-list">
            {(friendsExpanded ? friends : friends.slice(0, FRIEND_CAP)).map((f) => (
              <FriendRow
                key={f.handle}
                friend={f}
                invited={invited.has(f.handle)}
                onInvite={invite}
                onJam={onJam}
                onOpen={onOpenPerson ?? goToHandle}
              />
            ))}
          </ul>
          {friends.length > FRIEND_CAP && (
            <button
              className="link-btn discover-more"
              onClick={() => setView({ friendsExpanded: !friendsExpanded })}
            >
              {friendsExpanded ? "Show fewer" : `Show all ${friends.length}`}
            </button>
          )}
        </div>
      )}

      {/* LIVE — ONE ranked list, not three stacked ones. It used to be "From people you follow"
          then "Also live now", which asked you to hold two buckets and told you nothing about
          the order inside either. Now every row carries the reason it ranked where it did. */}
      {rooms === null ? (
        <p className="discover-empty">Loading…</p>
      ) : (
        <div className="discover-section">
          <div className="social-section-head live-now-head">
            ● Live now
            {live.length > 0 && (
              <span className="friends-count">
                · {query ? `${shown.length} of ${live.length}` : live.length}
              </span>
            )}
          </div>
          {live.length === 0 ? (
            <p className="discover-empty">Nobody is live right now.</p>
          ) : shown.length === 0 ? (
            <p className="discover-empty">Nothing matches &ldquo;{query}&rdquo;.</p>
          ) : (
            <>
              <ul className="live-now-list">
                {capped.map(({ room, reason }) => (
                  <LiveRoomRow key={room.handle} room={room} self={self} tunedTo={tunedTo} onTap={tap} reason={reason} />
                ))}
              </ul>
              {shown.length > ROOM_CAP && (
                <button
                  className="link-btn discover-more"
                  onClick={() => setView({ roomsExpanded: !roomsExpanded })}
                >
                  {roomsExpanded ? "Show fewer" : `Show all ${shown.length}`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
