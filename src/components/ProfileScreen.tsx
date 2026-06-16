import { useCallback, useEffect, useState } from "react";
import {
  type Me,
  type Profile,
  type Provider,
  checkHandle,
  claimHandle,
  fetchMe,
  fetchProfile,
  saveProfile,
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

// Navigate to /@handle — App listens for popstate and opens the public-profile dock
// (which is mutually exclusive with this own-Profile dock, so it takes over).
function viewPublicProfile(handle: string): void {
  window.history.pushState(null, "", `/@${handle}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function ProfileScreen({ onClose }: { onClose: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingHandle, setEditingHandle] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
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
                <div className="profile-name">
                  {user?.displayName || user?.name ? (revealed ? user?.displayName || user?.name : maskName(user?.displayName || user?.name || "")) : "Signed in"}
                </div>
                {/* The @handle is the PUBLIC identity — always shown (never masked). */}
                {user?.handle ? (
                  <button className="profile-handle" onClick={() => setEditingHandle(true)} title="Change your handle">
                    @{user.handle}
                  </button>
                ) : (
                  <button className="profile-handle claim" onClick={() => setEditingHandle(true)}>
                    + Claim your @handle
                  </button>
                )}
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

            {editingHandle && (
              <HandleEditor
                current={user?.handle ?? null}
                onCancel={() => setEditingHandle(false)}
                onDone={() => {
                  setEditingHandle(false);
                  load();
                }}
              />
            )}

            {/* Public profile — display name + bio are what others see at /@handle.
                Distinct from the private account bits (email/connections) below. */}
            {editingProfile ? (
              <ProfileEditor
                displayName={user?.displayName ?? ""}
                bio={user?.bio ?? ""}
                onCancel={() => setEditingProfile(false)}
                onDone={() => {
                  setEditingProfile(false);
                  load();
                }}
              />
            ) : (
              <div className="profile-public">
                {profile?.counts && (
                  <div className="profile-counts">
                    <span>
                      <b>{profile.counts.followers}</b> follower{profile.counts.followers === 1 ? "" : "s"}
                    </span>
                    <span>
                      <b>{profile.counts.following}</b> following
                    </span>
                  </div>
                )}
                {user?.bio && <p className="profile-bio">{user.bio}</p>}
                <div className="profile-public-actions">
                  <button className="profile-edit-btn" onClick={() => setEditingProfile(true)}>
                    Edit profile
                  </button>
                  {user?.handle && (
                    <button className="profile-view-public" onClick={() => viewPublicProfile(user.handle!)}>
                      View public profile →
                    </button>
                  )}
                </div>
              </div>
            )}

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

// Inline claim/rename editor: an @-prefixed input that live-checks availability
// (debounced) against /api/handle/check, then claims via /api/me/handle. The
// server is the source of truth — this only mirrors its verdict for a fast hint.
function HandleEditor({
  current,
  onCancel,
  onDone,
}: {
  current: string | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(current ?? "");
  const [status, setStatus] = useState<{ kind: "idle" | "checking" | "ok" | "bad"; msg?: string }>({ kind: "idle" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const h = value.trim();
    if (!h || h === current) return setStatus({ kind: "idle" });
    setStatus({ kind: "checking" });
    const ctl = new AbortController();
    const t = setTimeout(() => {
      void checkHandle(h, ctl.signal)
        .then((r) => setStatus(r.available ? { kind: "ok", msg: "available" } : { kind: "bad", msg: r.reason || "unavailable" }))
        .catch(() => {
          /* aborted */
        });
    }, 350);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [value, current]);

  const save = async () => {
    setSaving(true);
    const r = await claimHandle(value.trim());
    setSaving(false);
    if (r.ok) onDone();
    else setStatus({ kind: "bad", msg: r.error || "couldn't save" });
  };
  const canSave = status.kind === "ok" && !saving;

  return (
    <div className="handle-editor">
      <div className="handle-editor-field">
        <span className="handle-at">@</span>
        <input
          className="handle-input"
          autoFocus
          value={value}
          maxLength={20}
          placeholder="yourname"
          spellCheck={false}
          autoCapitalize="none"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) void save();
            if (e.key === "Escape") onCancel();
          }}
        />
        <span className={`handle-status ${status.kind}`}>
          {status.kind === "checking" ? "…" : status.kind === "ok" ? "✓ available" : status.msg || ""}
        </span>
      </div>
      <div className="handle-editor-actions">
        <button className="handle-save" disabled={!canSave} onClick={() => void save()}>
          {saving ? "Saving…" : current ? "Rename" : "Claim"}
        </button>
        <button className="handle-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="handle-hint">Letters, numbers and _ · 3–20 chars · this is your public @name.</p>
    </div>
  );
}

// Edit the user-owned PUBLIC fields (display name + bio). Saves via PUT /api/me/profile;
// these never touch the Google-mirror name/avatar (the stomp-safe split).
function ProfileEditor({
  displayName,
  bio,
  onCancel,
  onDone,
}: {
  displayName: string;
  bio: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(displayName);
  const [bioText, setBioText] = useState(bio);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    await saveProfile({ displayName: name, bio: bioText });
    setSaving(false);
    onDone();
  };

  return (
    <div className="handle-editor profile-editor">
      <label className="profile-field">
        <span className="profile-field-label">Display name</span>
        <input
          className="handle-input"
          value={name}
          maxLength={48}
          placeholder="Your name"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="profile-field">
        <span className="profile-field-label">Bio</span>
        <textarea
          className="handle-input profile-bio-input"
          value={bioText}
          maxLength={300}
          rows={3}
          placeholder="A line about you"
          onChange={(e) => setBioText(e.target.value)}
        />
      </label>
      <div className="handle-editor-actions">
        <button className="handle-save" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="handle-cancel" onClick={onCancel}>
          Cancel
        </button>
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
