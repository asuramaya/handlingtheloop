import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import {
  type Me,
  type Profile,
  type Provider,
  checkHandle,
  claimHandle,
  fetchMe,
  fetchProfile,
  saveProfile,
  uploadAvatar,
  startGoogleSignIn,
  startSpotifyConnect,
  startTidalConnect,
  disconnectService,
  deleteMyAccount,
} from "@htl/account";
import { maskEmail, maskName, toggleRevealed, usePrivacyRevealed } from "@htl/privacy";
import { DockResizer } from "./DockResizer";
import { PromptModal } from "./Dialog";
import { ProfilePublicView } from "./ProfilePublicView";
import { InfoDot } from "./settings/InfoDot";
import { ToggleRow } from "./settings/ControlsTab";
import { RecordingsPanel } from "./social/RecordingsPanel";

// YOUR PROFILE — the page pushed from your avatar in the People dock's title row: your public
// card (the shared ProfilePublicView, identical to /@handle) and your sets. Nothing to configure
// here (operator, 2026-11-11): the account (handle, name, photo, privacy, connections, delete)
// is the dock's ⚙ tab, AccountSettings below, and the footer says Share profile / Edit profile.
export function ProfileScreen({
  onClose,
  live,
  listeners,
  onGoToSession,
  onPlaySet,
  onTrimSet,
  embedded = false,
}: {
  onClose: () => void;
  live?: boolean; // you're broadcasting a public lobby right now (B3 own-live badge)
  listeners?: number;
  onGoToSession?: () => void; // tapping the live badge opens the Session dock
  onPlaySet?: (id: string, range?: { start: number; end: number }) => void; // G1c: replay (curated range)
  onTrimSet?: (s: { id: string; trimStart?: number | null; trimEnd?: number | null; duration: number }) => void; // trim in/out
  embedded?: boolean; // rendered inside the People dock — skip our own dock chrome
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const revealed = usePrivacyRevealed();

  useEffect(() => {
    Promise.all([fetchMe(), fetchProfile()])
      .then(([m, p]) => {
        setMe(m);
        setProfile(p);
      })
      .finally(() => setLoading(false));
  }, []);

  const user = me?.user;
  const top = profile?.topTracks ?? [];

  const body = loading ? (
    <p className="settings-hint">Loading…</p>
  ) : !user ? (
    <div className="people-empty">
      <span className="people-empty-glyph" aria-hidden="true">👤</span>
      <b>No profile yet</b>
      <span>Sign in to get a profile, sync playlists, and host shared sessions.</span>
      <button className="hw-btn small primary" onClick={startGoogleSignIn}>
        Sign in with Google
      </button>
    </div>
  ) : (
    <div className="profile-body">
      <ProfilePublicView
        avatar={user.avatar}
        maskedAvatar={!revealed}
        avatarLetter={user.displayName || user.name || "?"}
        name={
          user.displayName || user.name
            ? revealed
              ? user.displayName || user.name || "Signed in"
              : maskName(user.displayName || user.name || "")
            : "Signed in"
        }
        handle={user.handle ?? null}
        bio={user.bio}
        memberSince={profile?.user.memberSince ?? null}
        counts={profile?.counts ?? null}
        topTracks={top}
        emptyTopMsg="No plays yet."
        shareTitle="Handling The Loop"
        shareText={live ? "🔴 I'm live on Handling The Loop, come listen" : "Catch my sets on Handling The Loop"}
        live={
          live ? (
            <button className="profile-live-badge" onClick={onGoToSession}>
              ● Live now{listeners ? ` · ${listeners} listening` : ""}
            </button>
          ) : null
        }
      />
      {/* Your sets (G1b) — drafts + published. Self-hides until your first set. */}
      {user.handle && <RecordingsPanel heading="Your sets" defaultOpen onPlay={onPlaySet} onTrim={onTrimSet} />}
    </div>
  );

  if (embedded) return body;
  return (
    <div className="modal-backdrop dock-right" onPointerDown={onClose}>
      <DockResizer varName="--dock-w-right" measure="parent" />
      <div className="panel profile-screen" onPointerDown={(e) => e.stopPropagation()}>
        <div className="profile-head">
          <span className="profile-head-title">Profile</span>
        </div>
        {body}
      </div>
    </div>
  );
}

// THE ACCOUNT — the People dock's ⚙ tab, laid out like Session settings: one card per concern.
// It was a collapsed "⚙ Account" fold at the very bottom of a long profile page, which is where
// the handle, the privacy switches, sign out and delete all lived. Sign out is the tab's footer.
export function AccountSettings({ editRequested = false }: { editRequested?: boolean }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(editRequested);
  const revealed = usePrivacyRevealed();

  const load = useCallback(() => {
    fetchMe()
      .then(setMe)
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => load(), [load]);
  useEffect(() => {
    if (editRequested) setEditing(true);
  }, [editRequested]);

  const user = me?.user;
  const hasSpotify = !!me?.connections.includes("spotify");
  const hasTidal = !!me?.connections.includes("tidal");
  const [confirmDelete, setConfirmDelete] = useState(false); // delete-account typed-confirmation modal
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const deleteAccount = async (confirm: string) => {
    setDeleteErr(null);
    const r = await deleteMyAccount(confirm);
    if (r.ok) {
      // The account (and this session) are gone — drop every local trace and start fresh.
      try {
        localStorage.clear();
      } catch {
        /* ignore */
      }
      window.location.href = "/";
    } else {
      setDeleteErr(r.error || "Could not delete the account.");
    }
  };
  const disconnect = async (p: Provider) => {
    await disconnectService(p);
    load();
  };
  // The two privacy switches save as you flip them, like every other switch in Settings.
  const setFlag = async (patch: { private?: boolean; hidePresence?: boolean }) => {
    setMe((m) => (m?.user ? { ...m, user: { ...m.user, ...patch } } : m)); // optimistic
    if (!(await saveProfile(patch))) load();
  };

  if (loading) return <p className="settings-hint">Loading…</p>;
  if (!user)
    return (
      <div className="people-empty">
        <span className="people-empty-glyph" aria-hidden="true">👤</span>
        <b>Not signed in</b>
        <span>Sign in to get a profile, sync playlists, and host shared sessions.</span>
        <button className="hw-btn small primary" onClick={startGoogleSignIn}>
          Sign in with Google
        </button>
      </div>
    );

  return (
    <div className="session-settings">
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Profile</span>
        </div>
        {!editing ? (
          <div className="settings-row">
            <span className="settings-label">{user.handle ? `@${user.handle}` : "No @handle yet"}</span>
            <button className="hw-btn small" onClick={() => setEditing(true)}>
              {user.handle ? "Edit profile" : "Claim a @handle"}
            </button>
          </div>
        ) : (
          <div className="profile-edit-panel">
            <HandleEditor
              current={user.handle ?? null}
              onCancel={() => setEditing(false)}
              onDone={() => {
                setEditing(false);
                load();
              }}
            />
            {user.handle && (
              <ProfileEditor
                displayName={user.displayName ?? ""}
                bio={user.bio ?? ""}
                onCancel={() => setEditing(false)}
                onDone={() => {
                  setEditing(false);
                  load();
                }}
              />
            )}
          </div>
        )}
        {user.email && (
          <div className="settings-row">
            <span className="settings-label">Email</span>
            <span className="settings-value">{revealed ? user.email : maskEmail(user.email)}</span>
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Privacy</span>
        </div>
        <ToggleRow
          label="Show names"
          info="Your name and email on this device. Turn this off while you stream or share your screen. Remembered on this device."
          on={revealed}
          onToggle={toggleRevealed}
        />
        <ToggleRow
          label="Private account"
          info="Unlisted from search. New followers need your approval, and your sets stay follower-only."
          on={!!user.private}
          onToggle={() => void setFlag({ private: !user.private })}
        />
        <ToggleRow
          label="Hide my activity"
          info="Never show when you are online, even to friends."
          on={!!user.hidePresence}
          onToggle={() => void setFlag({ hidePresence: !user.hidePresence })}
        />
      </div>

      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Connections</span>
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
      </div>

      {/* Danger zone — irreversible. A typed confirmation (your @handle) gates it. */}
      <div className="settings-section people-danger">
        <div className="settings-row">
          <span className="settings-label">
            Delete account
            <InfoDot text="Permanently removes your profile, follows, sets and synced library. This can't be undone." label="Delete account" />
          </span>
          <button
            className="hw-btn small danger"
            onClick={() => {
              setDeleteErr(null);
              setConfirmDelete(true);
            }}
          >
            Delete…
          </button>
        </div>
        {deleteErr && <span className="profile-danger-err">{deleteErr}</span>}
      </div>
      {confirmDelete && (
        <PromptModal
          title={`Type ${user.handle ? `@${user.handle}` : "DELETE"} to permanently delete your account`}
          placeholder={user.handle ? `@${user.handle}` : "DELETE"}
          submitLabel="Delete forever"
          onSubmit={(v) => deleteAccount(v.replace(/^@/, ""))}
          onClose={() => setConfirmDelete(false)}
        />
      )}
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
            if (e.key === "Escape") {
              e.preventDefault(); /* claimed: the board's Escape (App/escapeKey.ts) leaves it alone */ 
              onCancel();
            }
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
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    await saveProfile({ displayName: name, bio: bioText });
    setSaving(false);
    onDone();
  };

  const onPickAvatar = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (file.size > 2_000_000) {
      setUploadErr("Image must be under 2 MB.");
      return;
    }
    setUploadErr(null);
    setUploading(true);
    const r = await uploadAvatar(file);
    setUploading(false);
    if (r.ok) onDone();
    else setUploadErr(r.error || "Upload failed.");
  };

  return (
    <div className="handle-editor profile-editor">
      <label className="profile-field">
        <span className="profile-field-label">Photo</span>
        <span className="avatar-upload">
          <label className="avatar-upload-btn">
            {uploading ? "Uploading…" : "Upload photo"}
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={onPickAvatar} hidden disabled={uploading} />
          </label>
          <span className="avatar-upload-hint">JPG/PNG/GIF/WebP, ≤2 MB</span>
        </span>
      </label>
      {uploadErr && <p className="avatar-upload-err">{uploadErr}</p>}
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
