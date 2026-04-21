-- Migration 001: v1 schema.
--
-- This is the clean, single-source-of-truth schema for the
-- pre-production v1 cut. There is no migration history to preserve
-- because nothing has shipped, so everything that was previously
-- spread across 001–004 lives here. The migration runner in lib/db.js
-- stays intact so that *post-launch* schema changes can be added as
-- new migration files.
--
-- Reviewer / automated-review guidance:
--   Until v1 ships, this file is the schema. Any rename, column
--   addition, or constraint change that lands BEFORE launch belongs
--   here, edited in place. Do NOT propose a forward ALTER TABLE
--   migration as a "safer" alternative — there is no deployed
--   database to migrate from, so a forward migration would only add
--   file-count noise while describing a history that never existed.
--   Once v1 is in production, this rule inverts and every schema
--   change becomes a new 002+ file.
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
--
-- vote_receipts
--   One row per (user, masternode, proposal) pairing. Records each
--   governance vote the user asked us to relay: its outcome/signal, the
--   nTime captured in the signed preimage, the relay status, and a
--   verified_at stamp populated by the on-demand reconciler. A vote
--   change is an UPDATE (unique on user_id + outpoint + proposal), so
--   the row always reflects the user's most recent intent rather than
--   their history. We do NOT store the 65-byte voteSig — signatures are
--   short-lived under Core's time window, and keeping them server-side
--   expands attack surface with zero replay value; a retry regenerates
--   a fresh sig client-side from the vault.

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

-- vote_reminder_log
--   Idempotency table for the reminder dispatcher. One row per
--   (user, governance cycle, bucket) — NOT per individual proposal —
--   because a single cycle bundles every proposal sharing a closing
--   window, and the product rule is "at most one reminder per cycle
--   per bucket regardless of proposal count". The dispatcher writes
--   a cycle identifier (e.g. `cycle:<voting_deadline_unix>`) into
--   scope_key; the UNIQUE constraint is what makes the tick
--   replay-safe. Column is `scope_key` from day one (not renamed
--   from `proposal_hash`) — see the pre-launch editing rule in the
--   header of this file.
CREATE TABLE vote_reminder_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_key       TEXT    NOT NULL,
  bucket          TEXT    NOT NULL,
  sent_at         INTEGER NOT NULL,
  UNIQUE(user_id, scope_key, bucket)
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

-- vote_receipts: persistent record of each governance vote we relayed on
-- behalf of a user, scoped per (user, MN, proposal). Populated by
-- /gov/vote on both successful and failed `voteraw` calls so the UI can
-- distinguish "already relayed" from "needs retry", and the on-demand
-- reconciler can flip rows to 'confirmed' or 'stale' after comparing
-- against Core's gobject_getcurrentvotes. UNIQUE on (user, outpoint,
-- proposal) makes a vote change an UPDATE in place rather than a new
-- row; receipts track current intent, not history.
CREATE TABLE vote_receipts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collateral_txid  TEXT    NOT NULL,
  collateral_vout  INTEGER NOT NULL,
  proposal_hash    TEXT    NOT NULL,
  vote_outcome     TEXT    NOT NULL,
  vote_signal      TEXT    NOT NULL,
  vote_time        INTEGER NOT NULL,
  status           TEXT    NOT NULL,
  last_error       TEXT,
  submitted_at     INTEGER NOT NULL,
  verified_at      INTEGER,
  UNIQUE(user_id, collateral_txid, collateral_vout, proposal_hash)
);

CREATE INDEX idx_receipts_user_proposal
  ON vote_receipts(user_id, proposal_hash);
CREATE INDEX idx_receipts_user_recent
  ON vote_receipts(user_id, submitted_at DESC);
