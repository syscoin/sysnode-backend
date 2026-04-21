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
--
-- proposal_drafts
--   User's in-progress proposal text. Server-side so the same draft
--   is available across devices once the user is logged in (Twitter-
--   compose-style: log out / close / switch devices and the drafts
--   follow the account). Drafts are plaintext because a governance
--   proposal's content is, by definition, about to go public on
--   chain — encrypting it would add friction for zero security
--   benefit. The payment_amount is stored in satoshis as INTEGER
--   (fits in int64 for every imaginable proposal size) to avoid the
--   float-precision traps of storing SYS decimals.
--
-- proposal_submissions
--   One row per proposal the user has actually committed to publishing
--   (i.e. they've advanced past the draft step). The row is created at
--   "prepare" time with a frozen canonical snapshot (parent_hash +
--   revision + time_unix + data_hex + proposal_hash) — those fields
--   are the hash preimage and must not change after this point, else
--   the 150 SYS collateral OP_RETURN would stop matching. The row
--   moves through a small state machine advanced partly by the user
--   (reporting a collateral txid) and partly by the reminder-style
--   dispatcher (watching confirmations, calling gobject_submit once
--   mature). Statuses:
--       prepared             hash + dataHex computed, shown to user,
--                            no collateral yet.
--       awaiting_collateral  user has supplied a collateral txid;
--                            dispatcher is polling confirmations.
--       submitted            gobject_submit succeeded; governance_hash
--                            is set. Terminal (happy path).
--       failed               something fatal happened; fail_reason
--                            is a stable machine code, fail_detail is
--                            raw context. Terminal.
--   There is no 'abandoned' status — users who back out before paying
--   just DELETE their row. The status column has no CHECK constraint
--   so the repo layer owns validation (mirroring vote_receipts.status).

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

-- proposal_drafts: user's in-progress proposal content. No canonical
-- snapshot or hash here — drafts haven't committed to an on-chain
-- identity yet. `payment_amount_sats` is an integer number of
-- satoshis (int64 range easily accommodates any realistic amount);
-- storing SYS as a decimal REAL would drift under float arithmetic.
-- `start_epoch` / `end_epoch` are nullable because a user may save
-- before choosing a superblock.
CREATE TABLE proposal_drafts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                 TEXT    NOT NULL DEFAULT '',
  name                  TEXT    NOT NULL DEFAULT '',
  url                   TEXT    NOT NULL DEFAULT '',
  description           TEXT    NOT NULL DEFAULT '',
  payment_address       TEXT    NOT NULL DEFAULT '',
  payment_amount_sats   INTEGER NOT NULL DEFAULT 0,
  payment_count         INTEGER NOT NULL DEFAULT 1,
  start_epoch           INTEGER,
  end_epoch             INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX idx_proposal_drafts_user_recent
  ON proposal_drafts(user_id, updated_at DESC);

-- proposal_submissions: once the user commits to publishing, we
-- snapshot the canonical (parent_hash, revision, time_unix, data_hex,
-- proposal_hash) tuple. Anything derived from data_hex (name, url,
-- payment_*) is duplicated in typed columns for indexing and display,
-- but the source of truth for what the chain sees is data_hex — the
-- repo layer guarantees the denormalized columns stay in sync with
-- it. draft_id is intentionally ON DELETE SET NULL so a user can
-- clean up their drafts list without destroying the historical
-- record of what they submitted.
CREATE TABLE proposal_submissions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id              INTEGER REFERENCES proposal_drafts(id) ON DELETE SET NULL,

  parent_hash           TEXT    NOT NULL DEFAULT '0',
  revision              INTEGER NOT NULL DEFAULT 1,
  time_unix             INTEGER NOT NULL,
  data_hex              TEXT    NOT NULL,
  proposal_hash         TEXT    NOT NULL,

  title                 TEXT    NOT NULL DEFAULT '',
  name                  TEXT    NOT NULL,
  url                   TEXT    NOT NULL,
  payment_address       TEXT    NOT NULL,
  payment_amount_sats   INTEGER NOT NULL,
  payment_count         INTEGER NOT NULL DEFAULT 1,
  start_epoch           INTEGER NOT NULL,
  end_epoch             INTEGER NOT NULL,

  status                TEXT    NOT NULL,
  collateral_txid       TEXT,
  collateral_confs      INTEGER NOT NULL DEFAULT 0,
  governance_hash       TEXT,
  fail_reason           TEXT,
  fail_detail           TEXT,

  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

-- Per-user recency index (for the "your submissions" page).
CREATE INDEX idx_proposal_submissions_user_recent
  ON proposal_submissions(user_id, updated_at DESC);

-- Dispatcher-facing index: the watcher tick scans rows by status to
-- advance them, so keep that lookup fast regardless of table size.
CREATE INDEX idx_proposal_submissions_status
  ON proposal_submissions(status, updated_at);

-- Partial uniqueness on collateral_txid: a given collateral tx can
-- only back a single proposal submission. Two rows claiming the same
-- txid is a bug (probably a duplicate "I paid, here's the txid" call
-- from the user). NULL txids are exempt, which is the correct
-- treatment for rows still in `prepared` state.
CREATE UNIQUE INDEX idx_proposal_submissions_collateral_txid
  ON proposal_submissions(collateral_txid)
  WHERE collateral_txid IS NOT NULL;

-- Codex PR8 round 3 P2: enforce /prepare idempotency at the DB layer.
-- The route reads by (user_id, data_hex, status='prepared') and then
-- inserts; without this partial unique index, two concurrent requests
-- with identical payload can both miss the read and both insert,
-- producing duplicate `prepared` rows for the same logical proposal.
-- Once the row moves past `prepared` (the user attaches collateral,
-- or it ends up `submitted`/`failed`), the partial predicate no
-- longer matches and a subsequent retry with the same dataHex is
-- free to create a fresh `prepared` row — which is the correct UX:
-- the old submission is locked to a specific collateral txid, and a
-- re-prepare is the user explicitly asking for a clean second take.
CREATE UNIQUE INDEX idx_proposal_submissions_user_payload_prepared
  ON proposal_submissions(user_id, data_hex)
  WHERE status = 'prepared';

-- Governance hash is likewise unique once set — it IS the proposal's
-- on-chain identity. A NULL is expected for rows not yet submitted.
CREATE UNIQUE INDEX idx_proposal_submissions_governance_hash
  ON proposal_submissions(governance_hash)
  WHERE governance_hash IS NOT NULL;
