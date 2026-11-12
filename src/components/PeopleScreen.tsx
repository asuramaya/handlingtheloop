import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type AccountUser,
  type FriendPresence,
  type PeoplePane,
  type PeopleView,
  ME_PAGE,
  logout as accountLogout,
  paneOf,
  sendInvite,
  startGoogleSignIn,
  viewForPane,
} from "@htl/account";
import { maskName, usePrivacyRevealed } from "@htl/privacy";
import { CenterResizeHandles, DockPlacementResizer, panelZIndex, useCenterZIndex } from "./DockResizer";
import type { PanelKey, PanelPlacement } from "@htl";
import { DiscoverScreen } from "./DiscoverScreen";
import { AccountSettings, ProfileScreen } from "./ProfileScreen";
import { ActivityFeed } from "./social/ActivityFeed";
import { LinkSheet } from "./social/LinkSheet";
import { PublicProfileScreen } from "./PublicProfileScreen";
import { PeopleGraph } from "./social/PeopleGraph";
import type { Notifications } from "./social/useNotifications";

// PEOPLE — one dock for everything that is about a person rather than about the room.
//
// ★ THE SESSION PANEL'S SHAPE (operator, 2026-11-11: "work on people tab, similar redesign").
// Three bands: the TOP never scrolls (title, your avatar, one tab strip), the BODY is the chosen
// tab and the only scroller, and the FOOT carries the one action that fits the tab you are on.
//   • One strip, Live | People | Activity | ⚙. It was Explore / You with a pill row under each,
//     one choice split across two controls.
//   • Your own profile is not a tab: your avatar in the title row pushes it, the same way a row
//     pushes anyone else's. The account (handle, privacy, connections, delete) is the ⚙ tab.
//   • Every list is the same row (PersonCardRow): tap it for what you can do, and Profile ›.
//   • The footer is contextual: Go live on Live, Share profile on People and on your profile
//     (Edit profile beside it there), Find people on Activity, Sign out on ⚙.
//
// SESSION deliberately stays its own chin button. It is not a browsing surface — it is present
// tense and operational (who is on the decks right now, let them in, go live), and it has to be
// one tap away mid-performance.

const TABS: { key: PeoplePane; label: string }[] = [
  { key: "live", label: "Live" },
  { key: "people", label: "People" },
  { key: "activity", label: "Activity" },
];
const PANE_LABEL: Record<PeoplePane, string> = {
  live: "Live",
  people: "People",
  activity: "Activity",
  settings: "Settings",
};

export function PeopleScreen({
  view,
  setView,
  onClose,
  self,
  user,
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
  onGoLive,
  dockMode = "right",
  panelOrder = ["library", "settings", "people", "session"],
}: {
  // The dock's whole position — which pane, which pushed person, and every per-pane control +
  // scroll offset. Owned by App so it survives this component unmounting on close.
  view: PeopleView;
  setView: (patch: Partial<PeopleView> | ((v: PeopleView) => PeopleView)) => void;
  onClose: () => void;
  self: string | null;
  user?: AccountUser | null;
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
  /** Actually go live (start the session if needed, open it to the public). */
  onGoLive?: () => void;
  dockMode?: PanelPlacement; // RESOLVED placement from App (never the raw setting) — "sheet" on a phone
  panelOrder?: PanelKey[]; // stack priority when an edge/bottom dock overlaps another (Settings ▸ Controls)
}) {
  const [seenOnce, setSeenOnce] = useState(false);
  const { unread, markSeen } = notifications;
  const { person } = view;
  const pane = paneOf(view);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const revealed = usePrivacyRevealed();
  const [shareOpen, setShareOpen] = useState(false);
  const [editRequested, setEditRequested] = useState(false);
  const [invited, setInvited] = useState<Set<string>>(new Set()); // optimistic "Invited ✓" by handle
  const signedIn = !!user;

  const goPane = (p: PeoplePane) => {
    setShareOpen(false);
    if (p !== "settings") setEditRequested(false);
    setView(viewForPane(p));
  };
  // PUSH / POP. Tapping a person from a list you are already reading must not evict that list —
  // it is one level deep, because a person's page leads back to a list and never deeper.
  const push = (handle: string) => {
    setShareOpen(false);
    setView({ person: handle === self ? ME_PAGE : handle });
  };
  const pop = () => {
    setShareOpen(false);
    setView({ person: null });
  };
  const invite = (handle: string) => {
    setInvited((s) => new Set(s).add(handle)); // optimistic
    void sendInvite(handle);
  };

  // ★ SCROLL IS PART OF WHERE YOU ARE — held in a REF, not in view state (writing every scroll
  // into the store and restoring from it was a feedback loop that snapped lists back to 0 on the
  // 30 s polls). Committed to the store only when leaving a pane or closing the dock.
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
      setView((v) => ({ ...v, scroll: { ...v.scroll, ...scrollMem.current } }));
    };
  }, [pane, person, setView]);

  // Mark seen when Activity is actually shown — not when the panel opens.
  useEffect(() => {
    if (pane === "activity" && !person && !seenOnce) {
      setSeenOnce(true);
      markSeen();
    }
    if (pane !== "activity") setSeenOnce(false);
  }, [pane, person, seenOnce, markSeen]);

  const badge = unread > 9 ? "9+" : String(unread);
  const centerZ = useCenterZIndex(dockMode, true);
  const zIndex = panelZIndex(dockMode, "people", panelOrder, centerZ);
  const onMe = person === ME_PAGE;
  const profileUrl = self ? `${location.origin}/@${self}` : null;
  const myName = user ? (revealed ? user.displayName || user.name || "You" : maskName(user.displayName || user.name || "")) : "";

  const signOut = async () => {
    await accountLogout();
    location.reload(); // every surface (room, library sync, this dock) re-reads the signed-out state
  };

  // ── The footer: one action that fits where you are ─────────────────────────────────────────
  const share = profileUrl ? (
    <button className={`hw-btn small ${shareOpen ? "on" : ""}`} onClick={() => setShareOpen((o) => !o)} aria-expanded={shareOpen}>
      ⇪ Share profile
    </button>
  ) : null;
  let footLeft: React.ReactNode = null;
  let footRight: React.ReactNode = null;
  if (onMe) {
    footLeft = share;
    footRight = signedIn ? (
      <button
        className="hw-btn small"
        onClick={() => {
          setEditRequested(true);
          goPane("settings");
        }}
      >
        Edit profile
      </button>
    ) : null;
  } else if (!person) {
    // ★ GO LIVE GOES LIVE (operator, 2026-11-12: "i clicked go live, it looks like im live but
    // ... still says go live and i do not see my room listed"). It used to only OPEN the Session
    // panel, which read as having gone live while nothing had. Now it starts the session if
    // needed and opens it to the public; once live the button says so and opens Session. Without
    // a @handle there is no public room to open, so it goes to claiming one.
    if (pane === "live" && signedIn)
      footRight = live ? (
        <button className="hw-btn small live" onClick={onGoToSession} title="Open the Session panel">
          ● Live{listeners ? ` · ${listeners} listening` : ""}
        </button>
      ) : (
        <button
          className="hw-btn small primary"
          onClick={() => {
            if (self && onGoLive) onGoLive();
            else {
              setEditRequested(true);
              goPane("settings");
            }
          }}
          title={self ? `Open @${self} to anyone: they tune in to listen` : "Claim a @handle to go live"}
        >
          ● Go live
        </button>
      );
    if (pane === "people") footLeft = share;
    if (pane === "settings" && signedIn)
      footRight = (
        <button className="hw-btn small danger" onClick={() => void signOut()}>
          Sign out
        </button>
      );
  }

  return (
    <div className={`modal-backdrop dock-${dockMode}`} style={{ zIndex }} onPointerDown={onClose}>
      <DockPlacementResizer mode={dockMode} />
      <div className="panel people-screen" onPointerDown={(e) => e.stopPropagation()}>
        {dockMode === "center" && <CenterResizeHandles panelKey="people" />}

        {/* ═════════════ TOP — fixed ═════════════ */}
        <div className="session-top">
          {/* THE HEAD IS THE STACK. At the root it names the dock; pushed, it is a back control
              that says what you are going back TO. */}
          <div className="settings-head">
            {person ? (
              <button className="people-back" onClick={pop}>
                <span aria-hidden="true">‹</span> {PANE_LABEL[pane]}
              </button>
            ) : (
              <h2>People</h2>
            )}
            {signedIn ? (
              <button
                className={`people-me ${onMe ? "on" : ""}`}
                onClick={() => (onMe ? pop() : push(ME_PAGE))}
                title="Your profile"
                aria-label="Your profile"
                aria-pressed={onMe}
              >
                {user?.avatar && revealed ? <img src={user.avatar} alt="" /> : <span>{(myName || "?").slice(0, 1).toUpperCase()}</span>}
              </button>
            ) : (
              <button className="hw-btn small primary people-signin" onClick={startGoogleSignIn}>
                Sign in
              </button>
            )}
          </div>

          {!person && (
            <div className="settings-tabs session-tabs" role="tablist" aria-label="People">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={pane === t.key}
                  className={`settings-tab ${pane === t.key ? "on" : ""}`}
                  onClick={() => goPane(t.key)}
                >
                  {t.label}
                  {t.key === "activity" && unread > 0 && <span className="tab-badge">{badge}</span>}
                </button>
              ))}
              <button
                role="tab"
                aria-selected={pane === "settings"}
                aria-label="Account settings"
                title="Account settings"
                className={`settings-tab session-tab-gear ${pane === "settings" ? "on" : ""}`}
                onClick={() => goPane("settings")}
              >
                ⚙
              </button>
            </div>
          )}
        </div>

        {/* ═════════════ BODY — the only scroller ═════════════ */}
        <div className="settings-body session-body people-body" ref={bodyRef}>
          {onMe ? (
            <ProfileScreen embedded onOpenPerson={push} onClose={onClose} live={live} listeners={listeners} onGoToSession={onGoToSession} onPlaySet={onPlaySet} onTrimSet={onTrimSet} />
          ) : person ? (
            <PublicProfileScreen key={person} embedded onOpenPerson={push} handle={person} onClose={pop} onListen={onListen} onJam={onJam} onPlaySet={onPlaySet} />
          ) : (
            <>
              {pane === "live" && (
                <DiscoverScreen
                  self={self}
                  live={!!live}
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
                  signedIn={signedIn}
                  friends={friends}
                  onJam={onJam}
                  onListen={onListen}
                  onOpenPerson={push}
                  onInvite={invite}
                  invited={invited}
                  onClaim={() => {
                    setEditRequested(true);
                    goPane("settings");
                  }}
                  onSignIn={startGoogleSignIn}
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
              {pane === "settings" && <AccountSettings editRequested={editRequested} />}
            </>
          )}
        </div>

        {/* ═════════════ SHARE SHEET ═════════════ */}
        {shareOpen && profileUrl && <LinkSheet url={profileUrl} label="Share your profile" shareTitle="Handling The Loop" onClose={() => setShareOpen(false)} />}

        {/* ═════════════ FOOT — the action for this tab ═════════════ */}
        {(footLeft || footRight) && (
          <div className="session-foot">
            <span className="session-foot-left">{footLeft}</span>
            {footRight}
          </div>
        )}
      </div>
    </div>
  );
}
