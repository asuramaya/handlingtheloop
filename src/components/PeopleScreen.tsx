import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type ExploreFace,
  type FriendPresence,
  type PeoplePane,
  type PeopleTab,
  type PeopleView,
  type YouFace,
  paneOf,
  viewForPane,
} from "@htl/account";
import { CenterResizeHandles, DockPlacementResizer, edgeZIndex, useCenterZIndex } from "./DockResizer";
import type { DockMode, PanelKey } from "@htl";
import { DiscoverScreen } from "./DiscoverScreen";
import { ProfileScreen } from "./ProfileScreen";
import { ActivityFeed } from "./social/ActivityFeed";
import { PublicProfileScreen } from "./PublicProfileScreen";
import { PeopleGraph } from "./social/PeopleGraph";
import type { Notifications } from "./social/useNotifications";

// PEOPLE — one dock for everything that is about a person rather than about the room.
//
// ★ WHY THREE SURFACES BECAME ONE. The chin carried a Profile button, a Discover button and a
// bell, and the three overlapped badly:
//   • The bell's main section was "Live now": LiveRoomRows for people you follow who are
//     broadcasting. Discover's main section was the same rows, from a second 30 s poll.
//   • The bell knew it, and ended with a button reading "See all in Discover ›". A popover whose
//     last control sends you somewhere better is a preview of a page, not a page.
//   • Profile sat apart, but "me" and "everyone else" are the same axis viewed from two ends.
// So: one button, and the live-rooms list belongs to Discover alone.
//
// ★ AND WHY FOUR TABS BECAME TWO FOLDS. Listen / People / Activity / You read as four peers and
// were not: the first two are both "browse other people" and the last two are both "mine". Worse,
// Listen and People each carried their own segmented control INSIDE the body (On air|Sets,
// Following|Followers), so the strip and a segment one row below it were splitting a single
// choice. Now the strip is the two things you actually pick between, and each fold's faces are
// the pill row under it — the same five destinations through one control instead of three.
//
// SESSION deliberately stays its own chin button. It is not a browsing surface — it is present
// tense and operational (who is on the decks right now, let them in, go live), and it has to be
// one tap away mid-performance. Folding it in here would put a live control behind a tab.

const EXPLORE_FACES: { key: ExploreFace; label: string }[] = [
  { key: "air", label: "On air" },
  { key: "sets", label: "Sets" },
  { key: "people", label: "People" },
];
const YOU_FACES: { key: YouFace; label: string }[] = [
  { key: "profile", label: "Profile" },
  { key: "activity", label: "Activity" },
];
const PANE_LABEL: Record<PeoplePane, string> = {
  air: "On air",
  sets: "Sets",
  people: "People",
  profile: "Profile",
  activity: "Activity",
};

export function PeopleScreen({
  view,
  setView,
  onClose,
  self,
  tunedTo,
  friends,
  notifications,
  onListen,
  onJam,
  onPlaySet,
  onTrimSet,
  live,
  listeners,
  onGoToSession,
  dockMode = "right",
  panelOrder = ["library", "settings", "people", "session"],
}: {
  // The dock's whole position — which pane, which pushed person, and every per-pane control +
  // scroll offset. Owned by App so it survives this component unmounting on close.
  view: PeopleView;
  setView: (patch: Partial<PeopleView> | ((v: PeopleView) => PeopleView)) => void;
  onClose: () => void;
  self: string | null;
  tunedTo: string | null;
  friends: FriendPresence[];
  notifications: Notifications;
  onListen: (handle: string) => void;
  onJam: (handle: string) => void;
  onPlaySet?: (id: string, range?: { start: number; end: number }) => void;
  onTrimSet?: (s: { id: string; trimStart?: number | null; trimEnd?: number | null; duration: number }) => void;
  live?: boolean;
  listeners?: number;
  onGoToSession?: () => void;
  dockMode?: DockMode; // desktop placement (Settings ▸ Controls); mobile ignores this and stays full-screen
  panelOrder?: PanelKey[]; // stack priority when an edge/bottom dock overlaps another (Settings ▸ Controls)
}) {
  const [seenOnce, setSeenOnce] = useState(false);
  const { unread, markSeen } = notifications;
  const { tab, person } = view;
  const pane = paneOf(view);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const goPane = (p: PeoplePane) => setView(viewForPane(p));
  // Tapping a TAB opens the face you left in that fold, not its default.
  const goTab = (t: PeopleTab) => goPane(t === "explore" ? view.explore : view.you);
  // PUSH / POP. Tapping a person from a list you are already reading must not evict that list —
  // it is one level deep, because a person's page leads back to a list and never deeper.
  const push = (handle: string) => setView({ person: handle });
  const pop = () => setView({ person: null });

  // ★ SCROLL IS PART OF WHERE YOU ARE — and it must be held in a REF, not in view state.
  //
  // The first version wrote every scroll position into the store and restored from it in a layout
  // effect keyed on that same value. That is a feedback loop: each save re-ran the restore, which
  // re-asserted the position, and any unrelated re-render (the 30 s presence and notification
  // polls, several times a minute) re-ran it too and slammed the list back to the last COMMITTED
  // offset — measured as scrollTop snapping to 0 while the user was reading. It also re-rendered
  // a 150-row list on every frame of a scroll.
  //
  // So the live position lives in a ref (zero renders, no loop) and is COMMITTED to the store only
  // at the boundaries that matter: leaving a pane, and unmounting the dock. Restore reads the ref,
  // and runs only when the pane or the pushed person changes.
  const scrollMem = useRef<Record<string, number>>({ ...view.scroll });

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // A pushed person always opens at ITS top; only the pane roots restore a position.
    el.scrollTop = person ? 0 : (scrollMem.current[pane] ?? 0);
  }, [pane, person]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || person) return;
    const onScroll = () => {
      scrollMem.current[pane] = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      // Leaving this pane (or the dock) — persist what the ref accumulated.
      setView((v) => ({ ...v, scroll: { ...v.scroll, ...scrollMem.current } }));
    };
  }, [pane, person, setView]);

  // Mark seen when Activity is actually shown — not when the panel opens. Opening onto Profile
  // and having the badge silently clear would lose you the one list you had not read.
  useEffect(() => {
    if (pane === "activity" && !person && !seenOnce) {
      setSeenOnce(true);
      markSeen();
    }
    if (pane !== "activity") setSeenOnce(false);
  }, [pane, person, seenOnce, markSeen]);

  const badge = unread > 9 ? "9+" : String(unread);
  const faces: { key: PeoplePane; label: string }[] = tab === "explore" ? EXPLORE_FACES : YOU_FACES;
  // Conditionally mounted by App (only exists while open) — mount itself IS "just opened".
  const centerZ = useCenterZIndex(dockMode, true);
  const zIndex = dockMode === "center" ? centerZ : edgeZIndex("people", panelOrder);

  return (
    <div className={`modal-backdrop dock-${dockMode}`} style={{ zIndex }} onPointerDown={onClose}>
      <DockPlacementResizer mode={dockMode} />
      <div className="panel people-screen" onPointerDown={(e) => e.stopPropagation()}>
        {dockMode === "center" && <CenterResizeHandles panelKey="people" />}
        {/* THE HEAD IS THE STACK. At the root it names the dock; pushed, it becomes a back
            control that says what you are going back TO. "‹ People" is an instruction, "‹" on
            its own is a guess. */}
        <div className="settings-head">
          {person ? (
            <button className="people-back" onClick={pop}>
              <span aria-hidden="true">‹</span> {PANE_LABEL[pane]}
            </button>
          ) : (
            <h2>People</h2>
          )}
        </div>

        {!person && (
          <>
            <div className="settings-tabs">
              <button
                className={`settings-tab ${tab === "explore" ? "on" : ""}`}
                onClick={() => goTab("explore")}
              >
                Explore
              </button>
              <button className={`settings-tab ${tab === "you" ? "on" : ""}`} onClick={() => goTab("you")}>
                You
                {/* The badge rides the TAB while the fold is closed and the PILL once it is open,
                    so unread is never a thing you have to open a tab to discover. */}
                {unread > 0 && tab !== "you" && <span className="tab-badge">{badge}</span>}
              </button>
            </div>

            <div className="people-faces" role="tablist" aria-label="Section">
              {faces.map((f) => (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={pane === f.key}
                  className={`face-pill ${pane === f.key ? "on" : ""}`}
                  onClick={() => goPane(f.key)}
                >
                  {f.label}
                  {f.key === "activity" && unread > 0 && <span className="tab-badge">{badge}</span>}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="settings-body people-body" ref={bodyRef}>
          {person ? (
            <PublicProfileScreen
              embedded
              handle={person}
              onClose={pop}
              onListen={onListen}
              onJam={onJam}
              onPlaySet={onPlaySet}
            />
          ) : (
            <>
              {(pane === "air" || pane === "sets") && (
                <DiscoverScreen
                  face={pane}
                  self={self}
                  tunedTo={tunedTo}
                  friends={friends}
                  onListen={onListen}
                  onJam={onJam}
                  onPlaySet={onPlaySet}
                  onOpenPerson={push}
                  view={view.listen}
                  setView={(patch) => setView((v) => ({ ...v, listen: { ...v.listen, ...patch } }))}
                />
              )}
              {pane === "people" && (
                <PeopleGraph
                  self={self}
                  onJam={onJam}
                  onListen={onListen}
                  onOpenPerson={push}
                  view={view.people}
                  setView={(patch) => setView((v) => ({ ...v, people: { ...v.people, ...patch } }))}
                />
              )}
              {pane === "activity" && (
                <ActivityFeed
                  data={notifications.data}
                  onJam={onJam}
                  onDiscover={() => goPane("people")}
                  onOpenPerson={push}
                  view={view.activity}
                  setView={(patch) => setView((v) => ({ ...v, activity: { ...v.activity, ...patch } }))}
                />
              )}
              {pane === "profile" && (
                <ProfileScreen
                  embedded
                  onClose={onClose}
                  live={live}
                  listeners={listeners}
                  onGoToSession={onGoToSession}
                  onPlaySet={onPlaySet}
                  onTrimSet={onTrimSet}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
