-- Public identity for the social layer: a unique @handle plus user-owned display
-- fields, split OFF the Google-mirrored name/avatar. The split kills the login
-- "stomp" bug: upsertGoogleUser (server/db.ts) writes only the google-mirror
-- (name/avatar/email/last_login) on every sign-in, so it can never overwrite a
-- user's chosen display_name/avatar_url/handle. Public surfaces read
-- display_name ?? name and avatar_url ?? avatar.
--
-- v1 handle policy (see server/security.ts validateHandle): ascii [A-Za-z0-9_],
-- 3-20 chars, case-PRESERVED for display, NFKC+lowercase FOLDED for uniqueness.
-- handle is NULL until claimed — handle-less accounts are fully usable but not
-- publicly addressable (you opt into public identity by claiming).
--
-- Mirrored by ensureIdentityColumns() in server/db.ts so older/local DBs gain the
-- columns at runtime without a manual migrate.
ALTER TABLE users ADD COLUMN handle        TEXT;    -- public address, case-preserved (NULL until claimed)
ALTER TABLE users ADD COLUMN handle_folded TEXT;    -- NFKC+lowercase fold — the uniqueness key
ALTER TABLE users ADD COLUMN display_name  TEXT;    -- user-owned public name  (falls back to name)
ALTER TABLE users ADD COLUMN avatar_url    TEXT;    -- user-owned public avatar (falls back to avatar)
ALTER TABLE users ADD COLUMN bio           TEXT;    -- user-owned public bio
ALTER TABLE users ADD COLUMN handle_set_at INTEGER; -- epoch ms the handle was last (re)claimed — rename cooldown

-- Uniqueness on the FOLDED form, enforced by the DB (the app-level "is it taken?"
-- check is TOCTOU-racy; a conflicting INSERT/UPDATE fails atomically instead).
-- SQLite allows many NULLs in a UNIQUE index, so handle-less accounts coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_folded ON users(handle_folded);
