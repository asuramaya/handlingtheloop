-- Handle tombstoning (anti-impersonation, 2026-06-30). When an @handle is freed (account
-- deleted) or renamed away, it's held for a window so a re-claimer can't inherit the prior
-- owner's old /@handle links, mentions, OG cards, and screenshots. `prev_user` lets the original
-- owner re-claim their own handle during the hold (e.g. an A→B→A rename). Checked in
-- setUserHandle + the handle-claim/check routes. Mirrored at runtime by ensureIdentityColumns.
CREATE TABLE IF NOT EXISTS reserved_handles (
  folded    TEXT PRIMARY KEY, -- the NFKC+lowercase fold (uniqueness key), matching users.handle_folded
  until     INTEGER NOT NULL, -- epoch ms the hold expires
  prev_user TEXT              -- the id that released it (may re-claim during the hold)
);
