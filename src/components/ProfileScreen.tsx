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
import { ProfilePublicView } from "./ProfilePublicView";
import { RecordingsPanel } from "./social/RecordingsPanel";

// The own Profile — PUBLIC-FIRST (Option B, docs/social-layer.md → "Surface architecture"):
// your public card (the shared ProfilePublicView, identical to /@handle) is the hero, edited
// in place; the account plumbing (connections, sign-out, email) is demoted to a collapsible
// "Account" footer. NOT tabbed — hierarchy does the separating. The hero is a pure WYSIWYG
// of your public card (so "view as public" is redundant); ALL editing lives in the Account
// section. Own profile only; session peers are device-scoped, never linked to an account id.

export function ProfileScreen({
  onClose,
  live,
  listeners,
  onGoToSession,
}: {
  onClose: () => void;
  live?: boolean; // you're broadcasting a public lobby right now (B3 own-live badge)
  listeners?: number;
  onGoToSession?: () => void; // tapping the live badge opens the Session dock
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false); // inline edit panel (handle + display/bio) revealed
  const [accountOpen, setAccountOpen] = useState(false); // the demoted Account section (connections/sign-out)
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

  // A signed-in account with no @handle yet → open Account so the claim CTA (which now
  // lives there) is visible; otherwise the hero is a clean public card and Account stays shut.
  useEffect(() => {
    if (signedIn && !user?.handle) setAccountOpen(true);
  }, [signedIn, user?.handle]);

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
            {/* HERO — your public card, the SAME render as /@handle (no drift), edited in place. */}
            <ProfilePublicView
              avatar={user?.avatar}
              maskedAvatar={!revealed}
              avatarLetter={user?.displayName || user?.name || "?"}
              name={
                user?.displayName || user?.name
                  ? revealed
                    ? user?.displayName || user?.name || "Signed in"
                    : maskName(user?.displayName || user?.name || "")
                  : "Signed in"
              }
              handle={user?.handle ?? null}
              bio={user?.bio}
              memberSince={memberSince}
              counts={profile?.counts ?? null}
              topTracks={top}
              emptyTopMsg="No plays yet — load tracks onto the decks and your most-played show up here."
              live={
                live ? (
                  <button className="profile-live-badge" onClick={onGoToSession} title="Open the session">
                    ● Live now{listeners ? ` · ${listeners} listening` : ""}
                  </button>
                ) : null
              }
              headerAside={
                <button
                  className={`room-eye ${revealed ? "on" : ""}`}
                  onClick={toggleRevealed}
                  title={revealed ? "Hide name & email (streaming-safe)" : "Reveal name & email"}
                  aria-label={revealed ? "Hide name & email" : "Reveal name & email"}
                >
                  {revealed ? "🙈" : "👁"}
                </button>
              }
            />

            {/* Your sets (G1b) — your recorded sets, drafts + published; the persistent twin
                of your live status. The "person" axis home for recordings (the Session shows
                only a just-recorded prompt). Self-hides until your first set. */}
            {user?.handle && <RecordingsPanel heading="Your sets" defaultOpen />}

            {/* ACCOUNT — demoted, collapsible footer: the rare set-and-forget plumbing
                (connections / email / sign-out), kept off the public hero. */}
            <div className={`profile-account ${accountOpen ? "open" : ""}`}>
              <button
                className="profile-account-head"
                onClick={() => setAccountOpen((v) => !v)}
                aria-expanded={accountOpen}
              >
                <span className="profile-account-title">⚙ Account</span>
                <span className="profile-account-summary">
                  {["YouTube", hasSpotify && "Spotify", hasTidal && "TIDAL"].filter(Boolean).join(" · ")}
                </span>
                <span className="profile-account-caret" aria-hidden="true">
                  {accountOpen ? "⌃" : "⌄"}
                </span>
              </button>
              {accountOpen && (
                <div className="profile-account-body">
                  {/* Identity editing lives here (config), not on the public hero. The button
                      claims a handle for a new account, else edits handle + display/bio in place. */}
                  {!editing ? (
                    <button className="profile-edit-btn account-edit" onClick={() => setEditing(true)}>
                      {user?.handle ? "Edit profile" : "+ Claim your @handle"}
                    </button>
                  ) : (
                    <div className="profile-edit-panel">
                      <HandleEditor
                        current={user?.handle ?? null}
                        onCancel={() => setEditing(false)}
                        onDone={() => {
                          setEditing(false);
                          load();
                        }}
                      />
                      {user?.handle && (
                        <ProfileEditor
                          displayName={user?.displayName ?? ""}
                          bio={user?.bio ?? ""}
                          onCancel={() => setEditing(false)}
                          onDone={() => {
                            setEditing(false);
                            load();
                          }}
                        />
                      )}
                    </div>
                  )}
                  {user?.email && <div className="profile-email">{revealed ? user.email : maskEmail(user.email)}</div>}
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
                  <button className="profile-signout" onClick={signOut}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
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
