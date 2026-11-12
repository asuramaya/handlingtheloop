import { useEffect, useMemo, useRef, useState } from "react";
import { type FriendPresence, type GraphMode, type PersonCard, fetchFollowers, fetchFollowing, readGraph, writeGraph } from "@htl/account";
import { FollowRequests } from "./FollowRequests";
import { FriendRow } from "./FriendRow";
import { PersonRow } from "./PersonRow";
import { PersonSearch } from "./PersonSearch";

// PEOPLE — your graph, as one sectioned list under one search box.
//
// ★ SECTIONS, NOT A TOGGLE (operator, 2026-11-11: the Session-style redesign). It was a
// Following | Followers pill pair one level under the dock's own pills, so you saw one side of
// your graph at a time and mutuals were buried in both. Now the tab reads top to bottom by how
// reachable someone is: Requests (somebody is waiting on you), Online now, Friends (mutual),
// Following, Followers (who you have not followed back), then People you may know. Each side of
// the graph still pages 50 at a time behind its own Load more, and the cache keeps the paged run.
//
// ★ ONE SEARCH BOX. The local "filter what is loaded" box is gone: the global search above finds
// anyone, follower or not, and filtering a window of a paged list while implying you searched
// the whole graph was the half-honest version of the same thing.
type Side = { list: PersonCard[] | null; more: boolean; loading: boolean };

function useSide(self: string | null, mode: GraphMode) {
  const [side, setSide] = useState<Side>(() => {
    const hit = self ? readGraph(self, mode) : null;
    return { list: hit?.list ?? null, more: hit?.more ?? false, loading: false };
  });
  // ★ RESET ON MOUNT, not just on unmount (StrictMode remounts the same instance; a ref latched
  // false by the first cleanup made every later Load more bail and stick on "Loading…").
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!self) {
      setSide({ list: [], more: false, loading: false });
      return;
    }
    // ★ SERVE THE CACHE FIRST, and do not re-fetch behind it.
    const hit = readGraph(self, mode);
    if (hit) {
      setSide({ list: hit.list, more: hit.more, loading: false });
      return;
    }
    let alive = true;
    const fetcher = mode === "followers" ? fetchFollowers : fetchFollowing;
    fetcher(self, 0)
      .then((p) => {
        if (!alive) return;
        setSide({ list: p.list, more: p.more, loading: false });
        writeGraph(self, mode, p.list, p.more);
      })
      .catch(() => alive && setSide({ list: [], more: false, loading: false }));
    return () => {
      alive = false;
    };
  }, [self, mode]);

  const loadMore = () => {
    if (side.loading || !side.list || !self) return;
    setSide((s) => ({ ...s, loading: true }));
    const fetcher = mode === "followers" ? fetchFollowers : fetchFollowing;
    fetcher(self, side.list.length)
      .then((p) => {
        if (!mounted.current) return;
        setSide((s) => {
          const next = [...(s.list ?? []), ...p.list];
          writeGraph(self, mode, next, p.more); // the cache holds the WHOLE paged run, not page 1
          return { list: next, more: p.more, loading: false };
        });
      })
      .catch(() => mounted.current && setSide((s) => ({ ...s, loading: false })));
  };
  return { ...side, loadMore };
}

const byName = (a: PersonCard, b: PersonCard) =>
  (b.live ? 2 : 0) + (b.online ? 1 : 0) - ((a.live ? 2 : 0) + (a.online ? 1 : 0)) ||
  (a.displayName || a.handle || "").localeCompare(b.displayName || b.handle || "");

export function PeopleGraph({
  self,
  signedIn,
  friends,
  onJam,
  onListen,
  onOpenPerson,
  onInvite,
  invited,
  onClaim,
  onSignIn,
  view,
  setView,
}: {
  self: string | null;
  signedIn: boolean;
  friends: FriendPresence[];
  onJam: (handle: string) => void;
  onListen: (handle: string) => void;
  onOpenPerson: (handle: string) => void;
  onInvite: (handle: string) => void;
  invited: ReadonlySet<string>;
  onClaim: () => void;
  onSignIn: () => void;
  view: { query: string };
  setView: (patch: Partial<{ query: string }>) => void;
}) {
  const following = useSide(self, "following");
  const followers = useSide(self, "followers");

  const shown = useMemo(
    () => new Set([...friends.map((f) => f.handle), ...[...(following.list ?? []), ...(followers.list ?? [])].map((c) => c.handle ?? "")]),
    [friends, following.list, followers.list],
  );
  const { friendsList, followingOnly, followersOnly } = useMemo(() => {
    const fl = following.list ?? [];
    const fr = followers.list ?? [];
    const online = new Set(friends.map((f) => f.handle));
    return {
      // Friends online already have their own section above; the rest of the mutuals are here.
      friendsList: fl.filter((c) => c.followsYou && !(c.handle && online.has(c.handle))).sort(byName),
      followingOnly: fl.filter((c) => !c.followsYou).sort(byName),
      followersOnly: fr.filter((c) => !c.following).sort(byName),
    };
  }, [following.list, followers.list, friends]);

  if (!self) {
    return signedIn ? (
      <div className="people-empty">
        <span className="people-empty-glyph" aria-hidden="true">＠</span>
        <b>Claim a @handle</b>
        <span>Your handle is how people find and follow you.</span>
        <button className="hw-btn small primary" onClick={onClaim}>
          Claim a @handle
        </button>
      </div>
    ) : (
      <div className="people-empty">
        <span className="people-empty-glyph" aria-hidden="true">👥</span>
        <b>Sign in to see your people</b>
        <span>Follow DJs, see who is online, and invite friends into a session.</span>
        <button className="hw-btn small primary" onClick={onSignIn}>
          Sign in with Google
        </button>
      </div>
    );
  }

  const loading = following.list === null || followers.list === null;
  const nobody = !loading && friends.length === 0 && following.list!.length === 0 && followers.list!.length === 0;
  const rows = (cards: PersonCard[]) =>
    cards.map((c, i) => <PersonRow key={c.handle ?? `i${i}`} card={c} onJam={onJam} onListen={onListen} onOpen={onOpenPerson} />);
  const more = (side: ReturnType<typeof useSide>, label: string) =>
    side.more && (
      <button className="link-btn discover-more" onClick={side.loadMore} disabled={side.loading}>
        {side.loading ? "Loading…" : `Load more ${label}`}
      </button>
    );

  return (
    <PersonSearch q={view.query} setQ={(query) => setView({ query })} onJam={onJam} onListen={onListen} onOpen={onOpenPerson} exclude={shown}>
      <FollowRequests onOpen={onOpenPerson} />
      {friends.length > 0 && (
        <div className="discover-section">
          <div className="social-roster-sep">Online now · {friends.length}</div>
          <ul className="social-roster person-list">
            {friends.map((f) => (
              <FriendRow key={f.handle} friend={f} invited={invited.has(f.handle)} onInvite={onInvite} onJam={onJam} onOpen={onOpenPerson} />
            ))}
          </ul>
        </div>
      )}
      {loading ? (
        <p className="discover-empty">Loading…</p>
      ) : nobody ? (
        <div className="people-empty">
          <span className="people-empty-glyph" aria-hidden="true">👋</span>
          <b>No one here yet</b>
          <span>Search above, or follow someone from the list below.</span>
        </div>
      ) : (
        <>
          {friendsList.length > 0 && (
            <div className="discover-section">
              <div className="social-roster-sep">Friends · {friendsList.length}</div>
              <ul className="social-roster person-list">{rows(friendsList)}</ul>
            </div>
          )}
          {(followingOnly.length > 0 || following.more) && (
            <div className="discover-section">
              <div className="social-roster-sep">Following · {followingOnly.length}{following.more ? "+" : ""}</div>
              <ul className="social-roster person-list">{rows(followingOnly)}</ul>
              {more(following, "following")}
            </div>
          )}
          {(followersOnly.length > 0 || followers.more) && (
            <div className="discover-section">
              <div className="social-roster-sep">Followers · {followersOnly.length}{followers.more ? "+" : ""}</div>
              <ul className="social-roster person-list">{rows(followersOnly)}</ul>
              {more(followers, "followers")}
            </div>
          )}
        </>
      )}
    </PersonSearch>
  );
}
