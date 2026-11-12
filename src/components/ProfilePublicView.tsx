import { displayTrack } from "../util/format";
import { type ReactNode, useState } from "react";
import { PeopleList } from "./social/PeopleList";

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
  shareText,
  shareTitle,
  shareNote,
  onJam,
  onListen,
  onOpenPerson,
}: {
  onOpenPerson?: (handle: string) => void; // a follower row opens INSIDE the dock (inline lists)
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
  // Tapping a count opens the ONE canonical people list (PeopleList) — same surface Discover's
  // "People you follow" leads to. Only when we have a handle to scope the graph to.
  // ★ The counts are TABS over the profile's one section (Top songs | Followers | Following) when
  // the profile lives in the People dock (onOpenPerson given): the list opens in place, in the
  // row language. Outside the dock (a /@handle landing page) they still open the modal list.
  const [graph, setGraph] = useState<"followers" | "following" | null>(null);
  const inline = !!onOpenPerson;
  const pickGraph = (g: "followers" | "following") => setGraph((cur) => (inline && cur === g ? null : g));
  return (
    <>
      <div className="profile-id">
        {avatar ? (
          <img className={`profile-avatar ${maskedAvatar ? "private" : ""}`} src={avatar} alt="" />
        ) : (
          <span className="profile-avatar fallback" aria-hidden="true">
            {avatarLetter.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="profile-id-text">
          <div className="profile-name">{name}</div>
          {handle && (
            <span className="profile-handle">
              @{handle}
              <button
                className="profile-share-btn"
                onClick={() => {
                  const url = `${location.origin}/@${handle}`;
                  const nav = navigator as Navigator & {
                    share?: (d: { url: string; title?: string; text?: string }) => Promise<void>;
                  };
                  if (nav.share) void nav.share({ url, ...(shareTitle && { title: shareTitle }), ...(shareText && { text: shareText }) }).catch(() => {});
                  else void navigator.clipboard?.writeText(url).catch(() => {});
                }}
              >
                ⤴
              </button>
            </span>
          )}
          {shareNote && <div className="profile-share-note">{shareNote}</div>}
          {bio && <div className="profile-bio">{bio}</div>}
          {memberSince != null && <div className="profile-since">Member since {formatDate(memberSince)}</div>}
        </div>
        {headerAside}
      </div>

      {live}

      {(counts || actions) && (
        <div className="profile-graph">
          {counts && (
            <div className="profile-counts">
              {handle ? (
                <button type="button" className={`profile-count-btn ${inline && graph === "followers" ? "on" : ""}`} aria-pressed={inline ? graph === "followers" : undefined} onClick={() => pickGraph("followers")}>
                  <b>{counts.followers}</b> follower{counts.followers === 1 ? "" : "s"}
                </button>
              ) : (
                <span>
                  <b>{counts.followers}</b> follower{counts.followers === 1 ? "" : "s"}
                </span>
              )}
              {handle ? (
                <button type="button" className={`profile-count-btn ${inline && graph === "following" ? "on" : ""}`} aria-pressed={inline ? graph === "following" : undefined} onClick={() => pickGraph("following")}>
                  <b>{counts.following}</b> following
                </button>
              ) : (
                <span>
                  <b>{counts.following}</b> following
                </span>
              )}
              {friends && <span className="profile-friend">· Friends</span>}
            </div>
          )}
          {actions && <div className="profile-graph-actions">{actions}</div>}
        </div>
      )}

      {inline && graph && handle ? (
        <div className="profile-section">
          <div className="profile-section-head profile-section-tabs">
            <button type="button" className="link-btn" onClick={() => setGraph(null)}>
              Top songs
            </button>
            <span>· {graph === "followers" ? "Followers" : "Following"}</span>
          </div>
          <PeopleList inline handle={handle} mode={graph} onClose={() => setGraph(null)} onJam={onJam} onListen={onListen} onOpen={onOpenPerson} />
        </div>
      ) : (
      <div className="profile-section">
        <div className="profile-section-head">Top songs</div>
        {topTracks.length === 0 ? (
          <p className="profile-empty">{emptyTopMsg}</p>
        ) : (
          <ol className="profile-top">
            {topTracks.map((t, i) => (
              <li key={t.videoId} className="profile-top-row">
                <span className="profile-top-rank">{i + 1}</span>
                <img
                  className="profile-top-thumb"
                  src={t.thumbnail || `/api/art/${t.videoId}`}
                  alt=""
                  loading="lazy"
                />
                <span className="profile-top-meta">
                  {/* ★ NEVER THE VIDEO ID. This said `t.title || t.videoId`, so a track stored
                      without metadata printed "2PpBU7EfiEY" on a PUBLIC profile — an internal id
                      standing where a song name belongs. The server resolves the name now
                      (track_identity → community_tracks → the uploader's own conventions, see
                      server/trackName.ts) and can always produce something; this fallback is the
                      belt-and-braces for an older server or a partial payload, and it says what is
                      true — that we do not know — rather than showing the id. */}
                  <span className="profile-top-title">{displayTrack(t.title, t.artist).title || "Unknown track"}</span>
                  {t.artist && <span className="profile-top-artist">{displayTrack(t.title, t.artist).artist}</span>}
                </span>
                <span className="profile-top-plays">{t.plays}×</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      )}

      {!inline && graph && handle && (
        <PeopleList handle={handle} mode={graph} onClose={() => setGraph(null)} onJam={onJam} onListen={onListen} />
      )}
    </>
  );
}
