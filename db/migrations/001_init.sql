-- Migration 001: v1 schema.
--
-- This is the clean, single-source-of-truth schema for the
-- pre-production v1 cut. There is no migration history to preserve
-- because nothing has shipped, so everything that was previously
-- spread across 001–004 lives here. The migration runner in lib/db.js
-- stays intact so that *post-launch* schema changes can be added as
-- new migration files.
--
-- Table overview
-- --------------
-- users
--   id              surrogate PK.
--   email           normalized (trim + lowercase + NFKC) at the app layer.
--   stored_auth     HMAC-SHA256(authHash, SYSNODE_AUTH_PEPPER) — the
--                   server-side transform of the client-derived authHash.
--                   We never store the raw client authHash.
--   email_verified  0/1. Vault read/write is gated on 1.
--   salt_v          per-user, per-account random salt that feeds
--                   HKDF(master, salt_v) → vaultKey on the client. Stable
--                   for the account's lifetime; rotated only on explicit
--                   "rotate vault key" flows (not in v1). Delivered to the
--                   client on /auth/login and /auth/me so the first-write
--                   path can derive vaultKey without an extra round-trip.
--   notification_prefs  opt-in JSON blob (e.g. vote reminders). Defaults
--                       to '{}' so a fresh account sends nothing.
--
-- email_verifications
--   One row per outstanding /auth/verify-email token. Tokens are stored
--   as hashes — a DB leak alone cannot reconstruct verification links.
--
-- sessions
--   Cookie-backed session rows. Also hashed at rest.
--
-- vaults
--   1:1 with users, created lazily on first PUT. No salt_v here — that
--   lives on the user row (see above).
--
-- tracked_masternodes, vote_reminder_log
--   Opt-in vote-reminder machinery. Populated only when the user turns
--   on voteReminders in notification_prefs.
--
-- pending_registrations
--   Holds /auth/register submissions (email + HMAC'd stored_auth) until
--   the email is verified, at which point the users row is created from
--   the pending row. This prevents an attacker from pre-binding their
--   own credential to a victim's email before the victim verifies.

CREATE TABLE users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  email               TEXT    NOT NULL UNIQUE,
  stored_auth         TEXT    NOT NULL,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  salt_v              TEXT    NOT NULL,
  notification_prefs  TEXT    NOT NULL DEFAULT '{}',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX idx_users_email ON users(email);

CREATE TABLE email_verifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_email_verifications_user ON email_verifications(user_id);

CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE vaults (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  blob        TEXT    NOT NULL,
  etag        TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);

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

CREATE TABLE pending_registrations (
  token_hash       TEXT    PRIMARY KEY,
  email_normalized TEXT    NOT NULL,
  stored_auth      TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);

CREATE INDEX idx_pending_registrations_email
  ON pending_registrations(email_normalized);

CREATE INDEX idx_pending_registrations_expires
  ON pending_registrations(expires_at);
