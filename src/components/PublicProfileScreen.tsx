import { useEffect, useState } from "react";
import { type PublicProfile, type SetCard, block, fetchHandleSets, fetchPublicProfile, follow, unblock, unfollow } from "@htl/account";
import { DockResizer } from "./DockResizer";
import { ProfilePublicView } from "./ProfilePublicView";
import { SetList } from "./social/SetList";

// The PUBLIC profile at /@handle — anyone can view it (no email/connections, no
// edit controls). Renders the SAME ProfilePublicView as the own-Profile hero (so the
// two can't drift), and shares the right dock with Settings/Profile/Session/Discover
// (mutually exclusive) — App drives that via the `/@handle` path. The app has no router,
// so we expose a tiny `handleFromPath()` helper App polls on mount + popstate.

const HANDLE_PATH = /^\/@([A-Za-z0-9_]{1,20})$/;
/** The handle in the current URL path (`/@name` → "name"), or null. */
export const handleFromPath = (): string | null => {
  if (typeof window === "undefined") return null;
  // Browsers keep the path percent-encoded, so a shared /@dev link that arrives as /%40dev
  // (the @ encoded — by a link builder, a redirect, or a hand-typed URL) would miss the
  // literal-@ regex and the public profile / live session never resolved for an anon visitor.
  // Decode first so BOTH /@dev and /%40dev match. Guard a malformed % escape (decode throws).
  let path = window.location.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* malformed escape → fall back to the raw path */
  }
  return path.match(HANDLE_PATH)?.[1] ?? null;
};

export function PublicProfileScreen({
  handle,
  onClose,
  onListen,
  onJam,
  onPlaySet,
}: {
  handle: string;
  onClose: () => void;
  onListen?: (handle: string) => void;
  onJam?: (handle: string) => void; // mutual-friend co-play (knock / step-up)
  onPlaySet?: (id: string) => void; // G1d: replay one of this DJ's published sets
}) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [sets, setSets] = useState<SetCard[]>([]);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setSets([]);
    fetchPublicProfile(handle, ctl.signal)
      .then(setProfile)
      .finally(() => setLoading(false));
    fetchHandleSets(handle, ctl.signal)
      .then(setSets)
      .catch(() => {});
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
              onJam={onJam}
              onListen={onListen}
              topTracks={top}
              live={
                // The one state×relationship CTA — the whole landing in a single tap (which is
                // also the iOS audio-unlock gesture). Live → everyone joins the audience; a mutual
                // friend gets the "you can step up" hint. Private but reachable + mutual → knock to
                // jam. Otherwise nothing here (Follow lives in `actions`).
                profile.isSelf ? null : profile.live ? (
                  <button className="listen-live-btn" onClick={() => onListen?.(profile.handle)}>
                    ● {rel?.mutual ? "Join live" : "Listen live"} · {profile.liveListeners} tuned in
                    {rel?.mutual && <span className="listen-live-sub"> · you can step up</span>}
                  </button>
                ) : rel?.mutual && profile.online ? (
                  <button className="jam-knock-btn" onClick={() => onJam?.(profile.handle)}>
                    ✋ Knock to jam
                  </button>
                ) : null
              }
              actions={
                !profile.isSelf && rel ? (
                  <>
                    {rel.requested ? (
                      <button className="follow-btn on" disabled title="Waiting for approval">
                        Requested
                      </button>
                    ) : (
                      <button className={`follow-btn ${rel.following ? "on" : ""}`} onClick={() => void onFollow()}>
                        {rel.following ? "Following" : rel.followedBy ? "Follow back" : profile.private ? "Request" : "Follow"}
                      </button>
                    )}
                    <button className="block-btn" onClick={() => void onBlock()}>
                      {rel.blocking ? "Unblock" : "Block"}
                    </button>
                  </>
                ) : null
              }
            />

            {/* Private account, and you're not a follower → their content is hidden. */}
            {profile.private && !profile.isSelf && !rel?.following && (
              <p className="profile-private-note">🔒 This account is private. {rel?.requested ? "Your request is pending." : "Follow to see their sets."}</p>
            )}

            {/* This DJ's published sets (G1d) — tap to replay on your decks. */}
            {sets.length > 0 && (
              <div className="profile-section">
                <div className="profile-section-head">Sets</div>
                <SetList sets={sets} onPlay={onPlaySet} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
