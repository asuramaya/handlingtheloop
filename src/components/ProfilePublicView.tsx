import type { ReactNode } from "react";

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
}: {
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
}) {
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
          {handle && <span className="profile-handle">@{handle}</span>}
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
              <span>
                <b>{counts.followers}</b> follower{counts.followers === 1 ? "" : "s"}
              </span>
              <span>
                <b>{counts.following}</b> following
              </span>
              {friends && <span className="profile-friend">· Friends</span>}
            </div>
          )}
          {actions && <div className="profile-graph-actions">{actions}</div>}
        </div>
      )}

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
                  src={t.thumbnail || `https://i.ytimg.com/vi/${t.videoId}/default.jpg`}
                  alt=""
                  loading="lazy"
                />
                <span className="profile-top-meta">
                  <span className="profile-top-title">{t.title || t.videoId}</span>
                  {t.artist && <span className="profile-top-artist">{t.artist}</span>}
                </span>
                <span className="profile-top-plays">{t.plays}×</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
