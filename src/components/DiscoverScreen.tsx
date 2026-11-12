import { useEffect, useMemo, useRef, useState } from "react";
import {
  type FriendPresence,
  type LiveRoom,
  type RoomSort,
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

// The LIVE tab of the People dock: what there is to listen to right now (friends online, rooms on
// air) and, below it, what has been published (sets). One list of things to hear: On air and Sets
// were two pills (operator, 2026-11-11: one tab strip, Live | People | Activity | ⚙). It reads the same live-rooms signal the Session entry and a
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
// ★ THE LAST ANSWER, KEPT ACROSS MOUNTS (operator, 2026-11-12: "flickeryness moving from tab to
// tab"). This component unmounts on every tab hop, and every return started from null: a
// "Loading…" line, then the list, then the sets dropping in under it, each one moving the page.
// The last rooms and sets are shown at once and refreshed behind them.
const memo: { rooms: Partial<Record<RoomSort, LiveRoom[]>>; sets: SetCard[] | null; setsCursor: string | null; setsCapped: boolean } = {
  rooms: {},
  sets: null,
  setsCursor: null,
  setsCapped: false,
};
const ROOM_CAP = 12;

export function DiscoverScreen({
  self,
  live: selfLive = false,
  tunedTo,
  friends,
  onListen,
  onJam,
  onPlaySet,
  onOpenPerson,
  view,
  setView,
}: {
  self: string | null;
  /** Am I live? Going live (or off) re-reads the directory so my own room shows (or leaves). */
  live?: boolean;
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
  const [rooms, setRoomsState] = useState<LiveRoom[] | null>(() => memo.rooms.busy ?? null); // null = first load not back yet
  const [sets, setSetsState] = useState<SetCard[]>(() => memo.sets ?? []);
  // Did the SERVER cap its answer? Distinct from ROOM_CAP below, which is this screen's own
  // display cap over a set it genuinely has all of. Conflating the two is what made "Show all N"
  // a false claim past the server's limit — see the note on the expander.
  const [roomsCapped, setRoomsCapped] = useState(false);
  // ★ THE SORT IS THE USER'S, and it is not a cosmetic preference — it decides whether the
  // directory can be PAGED at all. Busy ranks by listener count, which the server rewrites on
  // every host heartbeat, so it can only ever be the capped top slice. Recent orders by a value
  // that does not move while a broadcast lives, so it walks the whole list. Default busy
  // (operator, 39dc683e): ranking is what you want first; paging is what you want when you have
  // hit the wall.
  const [sort, setSort] = useState<RoomSort>("busy");
  const setRooms = (v: LiveRoom[] | null | ((p: LiveRoom[] | null) => LiveRoom[] | null)) =>
    setRoomsState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      if (next) memo.rooms[sortRef.current] = next;
      return next;
    });
  const setSets = (v: SetCard[] | ((p: SetCard[]) => SetCard[])) =>
    setSetsState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      memo.sets = next;
      return next;
    });
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState<LiveRoom[]>([]); // pages 2+ under "recent", appended in order
  const [setsCapped, setSetsCapped] = useState(memo.setsCapped);
  // Sets page the same way the `recent` rooms do, and for the same reason: `published_at` does not
  // move once a set is published, so walking it is coherent. Unlike the rooms list there is no
  // poll behind this, so nothing ever invalidates the pages already on screen.
  const [setsCursor, setSetsCursor] = useState<string | null>(memo.setsCursor);
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
      .then((p) => {
        if (!alive) return;
        setSets(p.items);
        setSetsCapped(p.truncated);
        setSetsCursor(p.nextCursor ?? null);
        memo.setsCapped = p.truncated;
        memo.setsCursor = p.nextCursor ?? null;
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchLiveRooms({ sort })
        .then((p) => {
          if (!alive) return;
          setRooms(p.items);
          setRoomsCapped(p.truncated);
          setCursor(p.nextCursor ?? null);
          // Page 1 refreshed → pages 2+ describe a list that has moved on. Dropping them is the
          // honest reset: keeping them would show rooms ranked against a snapshot that is gone.
          setMore([]);
        })
        .catch(() => alive && setRooms((prev) => prev ?? []));
    load();
    // The directory hears about a new broadcast a beat after the room opens; ask again shortly.
    const soon = setTimeout(load, 2500);
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearTimeout(soon);
      clearInterval(t);
    };
  }, [sort, selfLive]);

  // ★ THE FOLLOW-GRAPH FETCH IS GONE. This used to pull the viewer's following list and
  // intersect it with the room list in the browser — and it pulled ONE PAGE, which is 50. Past
  // 50 follows a room hosted by someone you follow, who happened to sit on page 2, was filed
  // under strangers: personalisation that silently got worse the more you used the app, with
  // nothing to see and nothing to log. `/api/rooms/live` returns `rel` per room now, resolved
  // in the query that was already running. See server/db/rooms.ts.

  const openPerson = onOpenPerson ?? goToHandle;
  const live = useMemo(() => [...(rooms ?? []), ...more], [rooms, more]);

  // ONE ranked list, re-derived only when the poll lands or the query changes. `now` is folded
  // in at rank time so "just started" ages correctly across a 30 s refresh.
  const ranked = useMemo(() => rankRooms(live, Date.now()), [live]);
  const shown = useMemo(() => filterRooms(ranked, query), [ranked, query]);
  const capped = roomsExpanded ? shown : shown.slice(0, ROOM_CAP);

  const setsSection =
    sets.length === 0 ? null : (
      <div className="discover-section">
        <div className="social-roster-sep">Sets</div>
        <SetList sets={sets} onPlay={onPlaySet} showHost />
        {/* ★ THE NOTE WAS A DEAD END FOR AS LONG AS THERE WAS NOWHERE TO GO. /api/sets/discover is
            capped server-side, and a list that stops at the cap without saying so reads as the
            complete catalogue — so this said "showing the newest N" and stopped, which is the same
            half-honesty the rooms list had before it got a way round its own wall. The server has
            paged since 7972ad1; the client wrapper was discarding the cursor. Now the note only
            appears when there is genuinely no further page, and otherwise you get the door. */}
        {setsCursor ? (
          <button
            className="link-btn discover-more"
            onClick={() => {
              // Clearing the cursor is also the in-flight guard: this button only exists while
              // one is held, so a second tap cannot append the same page twice.
              setSetsCursor(null);
              void fetchDiscoverSets({ cursor: setsCursor }).then((p) => {
                setSets((prev) => [...prev, ...p.items]);
                setSetsCursor(p.nextCursor ?? null);
              });
            }}
          >
            Load more
          </button>
        ) : (
          setsCapped && <p className="discover-empty">Showing the {sets.length} newest. More have been published.</p>
        )}
      </div>
    );

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
          placeholder="Search live rooms"
          aria-label="Filter live rooms"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="link-btn" onClick={() => setQuery("")}>Clear</button>
        )}
        {/* Beside the filter, not in a menu: both of these narrow the same list, and the sort is
            the one that decides whether you can reach past the cap at all. Two words, no chrome. */}
        {/* A real two-way switch (operator, 2026-11-12: the underlined words were "flimsy"). */}
        <div className="seg-group discover-sort" role="group" aria-label="Sort live rooms">
          {(["busy", "recent"] as const).map((s) => (
            <button
              key={s}
              className={`hw-btn small ${sort === s ? "on" : ""}`}
              aria-pressed={sort === s}
              onClick={() => { if (sort !== s) { setSort(s); setView({ roomsExpanded: false }); } }}
              title={s === "busy" ? "Most listeners first" : "Most recently started first — browse them all"}
            >
              {s === "busy" ? "Busiest" : "Newest"}
            </button>
          ))}
        </div>
      </div>

      {/* FRIENDS ONLINE — the co-play door, CAPPED. Uncapped it was the section most likely to
          fill the viewport (it grows with your graph, not with who is broadcasting) and push the
          live directory under the fold, so the layout's priority order held only while you had
          few friends. A section that cannot overflow cannot bury the next one. */}
      {friends.length > 0 && (
        <div className="discover-section">
          <div className="social-roster-sep">Friends online · {friends.length}</div>
          <ul className="social-roster person-list">
            {(friendsExpanded ? friends : friends.slice(0, FRIEND_CAP)).map((f) => (
              <FriendRow
                key={f.handle}
                friend={f}
                invited={invited.has(f.handle)}
                onInvite={invite}
                onJam={onJam}
                onOpen={openPerson}
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
      ) : live.length === 0 ? (
        friends.length === 0 &&
        sets.length === 0 && (
          <div className="people-empty">
            <span className="people-empty-glyph" aria-hidden="true">📻</span>
            <b>Nobody is live right now</b>
            <span>When someone goes live, they show up here.</span>
          </div>
        )
      ) : (
        <div className="discover-section">
          <div className="social-roster-sep">
            On air · {query ? `${shown.length} of ${live.length}` : live.length}
          </div>
          {shown.length === 0 ? (
            <p className="discover-empty">Nothing matches &ldquo;{query}&rdquo;.</p>
          ) : (
            <>
              <ul className="social-roster person-list">
                {capped.map(({ room, reason }) => (
                  <LiveRoomRow key={room.handle} room={room} self={self} tunedTo={tunedTo} onListen={onListen} onOpen={openPerson} reason={reason} />
                ))}
              </ul>
              {/* ★ "Show all N" WAS A CLAIM THIS SCREEN COULD NOT MAKE. /api/rooms/live is
                  capped server-side, so past that cap `shown.length` is the size of a SLICE and
                  "all" named the wrong number — the same silent-truncation defect as the
                  follow-graph page documented above, one surface along. The expander only says
                  "all" when the server did not cap; when it did, it counts what it has and the
                  note below says the rest exists. */}
              {shown.length > ROOM_CAP && (
                <button
                  className="link-btn discover-more"
                  onClick={() => setView({ roomsExpanded: !roomsExpanded })}
                >
                  {roomsExpanded ? "Show fewer" : roomsCapped ? `Show ${shown.length}` : `Show all ${shown.length}`}
                </button>
              )}
              {/* ★ A DEAD END BECOMES A DOOR. Saying "more are live than fit here" and stopping is
                  only half-honest — it names the wall without saying there is a way round it. The
                  busiest list cannot page (the server re-ranks it every heartbeat), but the newest
                  one can, so the note hands you the sort that reaches the rest. */}
              {roomsCapped && !query && sort === "busy" && (
                <p className="discover-empty">
                  Showing the busiest {live.length}. More rooms are live —{" "}
                  <button className="link-btn" onClick={() => { setSort("recent"); setView({ roomsExpanded: false }); }}>
                    browse by newest
                  </button>{" "}
                  to see them all.
                </p>
              )}
              {sort === "recent" && cursor && !query && (
                <button
                  className="link-btn discover-more"
                  onClick={() => {
                    void fetchLiveRooms({ sort: "recent", cursor }).then((p) => {
                      setMore((prev) => [...prev, ...p.items]);
                      setCursor(p.nextCursor ?? null);
                    });
                  }}
                >
                  Load more
                </button>
              )}
            </>
          )}
        </div>
      )}
      {setsSection}
    </>
  );
}
