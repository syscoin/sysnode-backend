-- Migration 002: vote-reminder infrastructure.
--
-- Privacy model:
-- * `notification_prefs` on users is a JSON blob holding per-user toggles.
--   voteReminders defaults to 0 (OFF). If the user never turns it on, no
--   outpoints are stored and there is no email<->MN correlation in our DB.
-- * `tracked_masternodes` stores public collateral outpoints the user opted
--   in to track. Populated only when voteReminders is enabled and the user
--   explicitly marks keys as tracked.
-- * `vote_reminder_log` is idempotency: one row per (user, proposal, bucket)
--   ensures we don't re-send the same 1-week / 3-day / 1-day reminder.
--   Retained for ~90 days via a cleanup job.
--
-- Why not encrypt outpoints: they are public on-chain and the correlation
-- being stored here is the whole point of the opt-in feature. Documented
-- explicitly in the UI toggle copy.

ALTER TABLE users ADD COLUMN notification_prefs TEXT NOT NULL DEFAULT '{}';

CREATE TABLE tracked_masternodes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collateral_txid   TEXT    NOT NULL,
  collateral_vout   INTEGER NOT NULL,
  label             TEXT,
  created_at        INTEGER NOT NULL,
  UNIQUE(user_id, collateral_txid, collateral_vout)
);

CREATE INDEX idx_tracked_mn_user ON tracked_masternodes(user_id);
CREATE INDEX idx_tracked_mn_outpoint
  ON tracked_masternodes(collateral_txid, collateral_vout);

CREATE TABLE vote_reminder_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_hash   TEXT    NOT NULL,
  bucket          TEXT    NOT NULL,
  sent_at         INTEGER NOT NULL,
  UNIQUE(user_id, proposal_hash, bucket)
);

CREATE INDEX idx_vote_reminder_sent ON vote_reminder_log(sent_at);
