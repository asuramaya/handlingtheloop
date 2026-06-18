import { useEffect, useState } from "react";
import { type PublicProfile, block, fetchPublicProfile, follow, unblock, unfollow } from "@htl/account";
import { DockResizer } from "./DockResizer";
import { ProfilePublicView } from "./ProfilePublicView";

// The PUBLIC profile at /@handle — anyone can view it (no email/connections, no
// edit controls). Renders the SAME ProfilePublicView as the own-Profile hero (so the
// two can't drift), and shares the right dock with Settings/Profile/Session/Discover
// (mutually exclusive) — App drives that via the `/@handle` path. The app has no router,
// so we expose a tiny `handleFromPath()` helper App polls on mount + popstate.

const HANDLE_PATH = /^\/@([A-Za-z0-9_]{1,20})$/;
/** The handle in the current URL path (`/@name` → "name"), or null. */
export const handleFromPath = (): string | null =>
  typeof window === "undefined" ? null : (window.location.pathname.match(HANDLE_PATH)?.[1] ?? null);

export function PublicProfileScreen({
  handle,
  onClose,
  onListen,
}: {
  handle: string;
  onClose: () => void;
  onListen?: (handle: string) => void;
}) {
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
            <ProfilePublicView
              avatar={profile.avatar}
              avatarLetter={profile.displayName || profile.handle}
              name={profile.displayName || `@${profile.handle}`}
              handle={profile.handle}
              bio={profile.bio}
              memberSince={profile.memberSince}
              counts={profile.counts}
              friends={rel?.mutual}
              topTracks={top}
              live={
                profile.live && !profile.isSelf && onListen ? (
                  <button className="listen-live-btn" onClick={() => onListen(profile.handle)}>
                    ● Listen live · {profile.liveListeners} tuned in
                  </button>
                ) : null
              }
              actions={
                !profile.isSelf && rel ? (
                  <>
                    <button className={`follow-btn ${rel.following ? "on" : ""}`} onClick={() => void onFollow()}>
                      {rel.following ? "Following" : rel.followedBy ? "Follow back" : "Follow"}
                    </button>
                    <button className="block-btn" onClick={() => void onBlock()}>
                      {rel.blocking ? "Unblock" : "Block"}
                    </button>
                  </>
                ) : null
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
