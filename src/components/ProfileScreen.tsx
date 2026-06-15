import { useCallback, useEffect, useState } from "react";
import {
  type Me,
  type Profile,
  type Provider,
  fetchMe,
  fetchProfile,
  startGoogleSignIn,
  startSpotifyConnect,
  startTidalConnect,
  logout as accountLogout,
  disconnectService,
} from "@htl/account";
import { maskEmail, maskName, toggleRevealed, usePrivacyRevealed } from "@htl/privacy";
import { DockResizer } from "./DockResizer";

// The full-screen Profile — the home for everything account-shaped (moved out of
// Settings ▸ Accounts): identity, connected services, member-since, and the user's
// top songs (most-played). Own profile only — peers in a session are device-scoped,
// never linked to an account id, by design.
function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long" });
  } catch {
    return "—";
  }
}

export function ProfileScreen({ onClose }: { onClose: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const revealed = usePrivacyRevealed();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchMe(), fetchProfile()])
      .then(([m, p]) => {
        setMe(m);
        setProfile(p);
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => load(), [load]);

  const user = me?.user;
  const signedIn = !!user;
  const hasSpotify = !!me?.connections.includes("spotify");
  const hasTidal = !!me?.connections.includes("tidal");
  const memberSince = profile?.user.memberSince ?? null;
  const top = profile?.topTracks ?? [];

  const signOut = async () => {
    await accountLogout();
    load();
  };
  const disconnect = async (p: Provider) => {
    await disconnectService(p);
    load();
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
        ) : !signedIn ? (
          <div className="profile-signin">
            <p className="profile-signin-copy">Sign in to get a profile, sync playlists, and host shared sessions.</p>
            <button className="hw-btn signin" onClick={startGoogleSignIn}>
              Sign in with Google
            </button>
          </div>
        ) : (
          <div className="profile-body">
            <div className="profile-id">
              {user?.avatar ? (
                <img className={`profile-avatar ${revealed ? "" : "private"}`} src={user.avatar} alt="" />
              ) : (
                <span className="profile-avatar fallback" aria-hidden="true">
                  {(user?.name || "?").slice(0, 1).toUpperCase()}
                </span>
              )}
              <div className="profile-id-text">
                <div className="profile-name">{user?.name ? (revealed ? user.name : maskName(user.name)) : "Signed in"}</div>
                {user?.email && <div className="profile-email">{revealed ? user.email : maskEmail(user.email)}</div>}
                {memberSince && <div className="profile-since">Member since {formatDate(memberSince)}</div>}
              </div>
              <button
                className={`room-eye ${revealed ? "on" : ""}`}
                onClick={toggleRevealed}
                title={revealed ? "Hide name & email (streaming-safe)" : "Reveal name & email"}
                aria-label={revealed ? "Hide name & email" : "Reveal name & email"}
              >
                {revealed ? "🙈" : "👁"}
              </button>
            </div>

            <div className="profile-conns">
              <ConnRow label="YouTube" sub="via Google" connected actionLabel="Disconnect" onAction={() => disconnect("google")} />
              <ConnRow
                label="Spotify"
                sub={hasSpotify ? "linked" : "connect to sync playlists"}
                connected={hasSpotify}
                actionLabel={hasSpotify ? "Disconnect" : "Connect"}
                onAction={() => (hasSpotify ? disconnect("spotify") : startSpotifyConnect())}
              />
              <ConnRow
                label="TIDAL"
                sub={hasTidal ? "linked" : "connect to sync playlists"}
                connected={hasTidal}
                actionLabel={hasTidal ? "Disconnect" : "Connect"}
                onAction={() => (hasTidal ? disconnect("tidal") : startTidalConnect())}
              />
            </div>

            <div className="profile-section">
              <div className="profile-section-head">Top songs</div>
              {top.length === 0 ? (
                <p className="profile-empty">No plays yet — load tracks onto the decks and your most-played show up here.</p>
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

            <button className="profile-signout" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ConnRow({
  label,
  sub,
  connected,
  actionLabel,
  onAction,
}: {
  label: string;
  sub: string;
  connected: boolean;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className={`profile-conn ${connected ? "on" : ""}`}>
      <span className="profile-conn-dot" aria-hidden="true" />
      <span className="profile-conn-text">
        <span className="profile-conn-label">{label}</span>
        <span className="profile-conn-sub">{sub}</span>
      </span>
      <button className="profile-conn-btn" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}
