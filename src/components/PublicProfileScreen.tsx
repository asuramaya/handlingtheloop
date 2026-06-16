import { useEffect, useState } from "react";
import { type PublicProfile, block, fetchPublicProfile, follow, unblock, unfollow } from "@htl/account";
import { DockResizer } from "./DockResizer";

// The PUBLIC profile at /@handle — anyone can view it (no email/connections, no
// edit controls). Mirrors the visual language of the own-Profile screen, and
// shares the right dock with Settings/Profile/Session (mutually exclusive) — App
// drives that via the `/@handle` path. The app has no router, so we expose a tiny
// `handleFromPath()` helper App polls on mount + popstate.

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long" });
  } catch {
    return "—";
  }
}

const HANDLE_PATH = /^\/@([A-Za-z0-9_]{1,20})$/;
/** The handle in the current URL path (`/@name` → "name"), or null. */
export const handleFromPath = (): string | null =>
  typeof window === "undefined" ? null : (window.location.pathname.match(HANDLE_PATH)?.[1] ?? null);

export function PublicProfileScreen({ handle, onClose }: { handle: string; onClose: () => void }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    fetchPublicProfile(handle, ctl.signal)
      .then(setProfile)
      .finally(() => setLoading(false));
    return () => ctl.abort();
  }, [handle]);

  const top = profile?.topTracks ?? [];
  const rel = profile?.relationship ?? null;

  const onFollow = async () => {
    if (!profile) return;
    const r = await (rel?.following ? unfollow : follow)(profile.handle);
    if (r) setProfile({ ...profile, relationship: r.relationship, counts: r.counts });
  };
  const onBlock = async () => {
    if (!profile) return;
    const r = await (rel?.blocking ? unblock : block)(profile.handle);
    if (r) setProfile({ ...profile, relationship: r.relationship, counts: r.counts });
  };

  return (
    <div className="modal-backdrop dock-right" onPointerDown={onClose}>
      <DockResizer varName="--dock-w-right" measure="parent" />
      <div className="panel profile-screen" onPointerDown={(e) => e.stopPropagation()}>
        <div className="profile-head">
          <span className="profile-head-title">Profile</span>
        </div>

        {loading ? (
          <p className="settings-hint">Loading…</p>
        ) : !profile ? (
          <div className="profile-signin">
            <p className="profile-signin-copy">@{handle} isn't a handle (yet).</p>
          </div>
        ) : (
          <div className="profile-body">
            <div className="profile-id">
              {profile.avatar ? (
                <img className="profile-avatar" src={profile.avatar} alt="" />
              ) : (
                <span className="profile-avatar fallback" aria-hidden="true">
                  {(profile.displayName || profile.handle).slice(0, 1).toUpperCase()}
                </span>
              )}
              <div className="profile-id-text">
                <div className="profile-name">{profile.displayName || `@${profile.handle}`}</div>
                <span className="profile-handle">@{profile.handle}</span>
                {profile.bio && <div className="profile-bio">{profile.bio}</div>}
                {profile.memberSince && <div className="profile-since">Member since {formatDate(profile.memberSince)}</div>}
              </div>
            </div>

            <div className="profile-graph">
              <div className="profile-counts">
                <span>
                  <b>{profile.counts.followers}</b> follower{profile.counts.followers === 1 ? "" : "s"}
                </span>
                <span>
                  <b>{profile.counts.following}</b> following
                </span>
                {rel?.mutual && <span className="profile-friend">· Friends</span>}
              </div>
              {!profile.isSelf && rel && (
                <div className="profile-graph-actions">
                  <button className={`follow-btn ${rel.following ? "on" : ""}`} onClick={() => void onFollow()}>
                    {rel.following ? "Following" : rel.followedBy ? "Follow back" : "Follow"}
                  </button>
                  <button className="block-btn" onClick={() => void onBlock()}>
                    {rel.blocking ? "Unblock" : "Block"}
                  </button>
                </div>
              )}
            </div>

            <div className="profile-section">
              <div className="profile-section-head">Top songs</div>
              {top.length === 0 ? (
                <p className="profile-empty">No plays yet.</p>
              ) : (
                <ol className="profile-top">
                  {top.map((t, i) => (
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
          </div>
        )}
      </div>
    </div>
  );
}
