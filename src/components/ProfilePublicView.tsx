import { displayTrack } from "../util/format";
import { type ReactNode, useState } from "react";
import type { TrackMeta } from "@htl/library";
import { PeopleList } from "./social/PeopleList";
import { PERSON_REL_LABEL, type PersonRel } from "./social/PersonCardRow";
import { SongMenu, type SongActions } from "./social/SongMenu";

type ProfileTab = "songs" | "sets" | "followers" | "following";
/** Top songs shown before "Show all": a profile is a glance, not the whole play history. */
const TOP_N = 10;

// The public-facing profile card — the SINGLE render shared by the own-Profile hero
// (ProfileScreen) and the public /@handle page (PublicProfileScreen), so the two can't
// drift. It's purely presentational: avatar + name + @handle + bio + member-since header,
// an optional live slot, follower/following counts, an optional actions slot (Edit + "view
// as public" for the owner; Follow/Block for a visitor), and the top-songs list. See
// docs/social-layer.md → "Surface architecture (UI)".

type TopTrack = {
  videoId: string;
  thumbnail?: string | null;
  title?: string | null;
  artist?: string | null;
  plays: number;
};

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long" });
  } catch {
    return "—";
  }
}

export function ProfilePublicView({
  avatar,
  avatarLetter,
  name,
  handle,
  bio,
  memberSince,
  counts,
  friends,
  topTracks,
  emptyTopMsg = "No plays yet.",
  live,
  actions,
  headerAside,
  maskedAvatar,
  shareNote,
  onJam,
  onListen,
  onOpenPerson,
  rel,
  sets,
  songActions,
}: {
  onOpenPerson?: (handle: string) => void;
  /** Who this is to the viewer: colours the hero and tags the name. */
  rel?: PersonRel;
  /** The Sets tab: its count (when known) and its content. */
  sets?: { count?: number; node: ReactNode };
  /** What tapping a song can do (load, queue, keep). Absent → songs are display-only. */
  songActions?: SongActions; // a follower row opens INSIDE the dock (inline lists)
  avatar?: string | null;
  avatarLetter: string;
  name: string;
  handle: string | null;
  bio?: string | null;
  memberSince?: number | null;
  counts?: { followers: number; following: number } | null;
  friends?: boolean;
  topTracks: TopTrack[];
  emptyTopMsg?: string;
  live?: ReactNode;
  actions?: ReactNode;
  headerAside?: ReactNode;
  maskedAvatar?: boolean; // own streaming-safe mode dims the avatar
  shareText?: string; // share-sheet body (host-state-aware: "I'm live…") — owner only; visitors share the bare url
  shareTitle?: string;
  shareNote?: ReactNode; // legible "what your link does right now" line under the share button (owner only)
  onJam?: (handle: string) => void; // passed to the counts' PeopleList so its rows can knock/join
  onListen?: (handle: string) => void;
}) {
  // ★ ONE ROW OF TABS, NOT A PAGE OF SECTIONS (operator, 2026-11-12: "top song is the same kind of
  // item as followers/following and this layout wastes too much space on the top right"). Songs,
  // sets, followers and following are all lists of this person's things, so they are four tabs over
  // one section, each carrying its count; the counts line and the "Top songs" heading are gone. The
  // hero is one compact card in the relationship colour, and whatever acts on the person (Follow,
  // Listen, Knock…) sits in its right-hand column instead of under it, so the top right is used.
  const [tab, setTab] = useState<ProfileTab>("songs");
  const [allSongs, setAllSongs] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; track: TrackMeta } | null>(null);
  const maxPlays = topTracks.reduce((m, t) => Math.max(m, t.plays), 0);
  const songs = allSongs ? topTracks : topTracks.slice(0, TOP_N);
  const tabs: { key: ProfileTab; label: string; n?: number }[] = [
    { key: "songs", label: "Songs", n: topTracks.length },
    ...(sets ? [{ key: "sets" as const, label: "Sets", n: sets.count }] : []),
    ...(counts && handle
      ? [
          { key: "followers" as const, label: "Followers", n: counts.followers },
          { key: "following" as const, label: "Following", n: counts.following },
        ]
      : []),
  ];
  const aside = live || actions || headerAside;
  return (
    <>
      <div className={`pp-hero rel-${rel ?? "other"}`}>
        {avatar ? (
          <img className={`profile-avatar pp-avatar ${maskedAvatar ? "private" : ""}`} src={avatar} alt="" />
        ) : (
          <span className="profile-avatar pp-avatar fallback" aria-hidden="true">
            {avatarLetter.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="pp-id">
          <div className="pp-name">
            <span>{name}</span>
            {rel && PERSON_REL_LABEL[rel] && <span className={`rel-tag ${rel}`}>{PERSON_REL_LABEL[rel]}</span>}
            {friends && rel !== "friend" && <span className="rel-tag friend">Friend</span>}
          </div>
          <div className="pp-sub">
            {[handle && name !== `@${handle}` ? `@${handle}` : null, memberSince != null ? `since ${formatDate(memberSince)}` : null].filter(Boolean).join(" · ")}
          </div>
          {bio && <div className="pp-bio">{bio}</div>}
          {shareNote && <div className="profile-share-note">{shareNote}</div>}
        </div>
        {aside && (
          <div className="pp-aside">
            {live}
            {actions && <div className="pp-actions">{actions}</div>}
            {headerAside}
          </div>
        )}
      </div>

      <div className="settings-tabs session-tabs pp-tabs" role="tablist" aria-label="Profile">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`settings-tab ${tab === t.key ? "on" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.n != null && <span className="tab-count">{t.n}</span>}
          </button>
        ))}
      </div>

      {tab === "songs" &&
        (topTracks.length === 0 ? (
          <p className="discover-empty">{emptyTopMsg}</p>
        ) : (
          <div className="discover-section">
            <ol className="social-roster person-list pp-songs">
              {songs.map((t, i) => {
                const d = displayTrack(t.title, t.artist);
                const track: TrackMeta = { videoId: t.videoId, title: t.title || d.title, artist: t.artist || "", duration: 0, thumbnail: t.thumbnail || `/api/art/${t.videoId}`, views: null };
                return (
                  <li key={t.videoId} className={`social-card song-card ${songActions ? "can-open" : ""}`}>
                    <span className="pp-rank">{i + 1}</span>
                    <img className="pp-thumb" src={t.thumbnail || `/api/art/${t.videoId}`} alt="" loading="lazy" />
                    <div
                      className="social-card-main"
                      {...(songActions
                        ? {
                            role: "button",
                            tabIndex: 0,
                            title: "Load, queue or keep this song",
                            onClick: (e: React.MouseEvent) => setMenu({ x: e.clientX, y: e.clientY, track }),
                            onKeyDown: (e: React.KeyboardEvent) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setMenu({ x: r.left + 24, y: r.bottom, track });
                              }
                            },
                          }
                        : {})}
                    >
                      {/* ★ NEVER THE VIDEO ID: "Unknown track" says what is true (see server/trackName.ts). */}
                      <span className="social-card-name">{d.title || "Unknown track"}</span>
                      {t.artist && <span className="social-card-meta">{d.artist}</span>}
                    </div>
                    {/* Plays only say something when they differ: a column of "1×" was noise. */}
                    {maxPlays > 1 && <span className={`pp-plays ${t.plays === maxPlays ? "top" : ""}`}>{t.plays}×</span>}
                  </li>
                );
              })}
            </ol>
            {topTracks.length > TOP_N && (
              <button className="link-btn discover-more" onClick={() => setAllSongs((v) => !v)}>
                {allSongs ? "Show the top 10" : `Show all ${topTracks.length}`}
              </button>
            )}
          </div>
        ))}
      {tab === "sets" && sets?.node}
      {(tab === "followers" || tab === "following") && handle && (
        <PeopleList inline handle={handle} mode={tab} onClose={() => setTab("songs")} onJam={onJam} onListen={onListen} onOpen={onOpenPerson} />
      )}
      {menu && songActions && <SongMenu x={menu.x} y={menu.y} track={menu.track} actions={songActions} onClose={() => setMenu(null)} />}
    </>
  );
}
