-- Set trimming (G3 reframed): the host curates a recorded set's in/out points before publishing,
-- so the performance plays without the dead air at the head/tail. NULL = no trim (full length).
ALTER TABLE sets ADD COLUMN trim_start INTEGER;
ALTER TABLE sets ADD COLUMN trim_end INTEGER;
