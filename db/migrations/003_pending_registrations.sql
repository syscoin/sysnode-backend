-- Migration 003: pending registrations (deferred credential binding).
--
-- Before this migration, POST /auth/register wrote the submitted authHash
-- directly into users.stored_auth with email_verified = 0. That let an
-- attacker pre-register a victim's email with the attacker's own
-- credential; the victim would later click their verification link and
-- end up with an account bound to the attacker's hash. (Codex P1 in
-- https://github.com/syscoin/sysnode-backend/pull/2.)
--
-- Under the new model:
--   - /auth/register inserts a row into pending_registrations instead of
--     mutating users. Each call issues a new row with its own token.
--   - /auth/verify-email redeems a pending row by token_hash, creates the
--     user already-verified using the stored_auth captured on that row,
--     and purges all other pendings for that email.
-- That makes it impossible for an attacker's earlier pending row to land
-- credentials on a real (post-verify) user account.
--
-- stored_auth here is the same HMAC(authHash, pepper) hex string used in
-- users.stored_auth, NOT the raw client-submitted authHash. We keep the
-- pepper layer even on the pending row so a DB leak on its own does not
-- yield authentication material.

CREATE TABLE IF NOT EXISTS pending_registrations (
  token_hash       TEXT    PRIMARY KEY,
  email_normalized TEXT    NOT NULL,
  stored_auth      TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_registrations_email
  ON pending_registrations(email_normalized);

CREATE INDEX IF NOT EXISTS idx_pending_registrations_expires
  ON pending_registrations(expires_at);

-- One-time backfill: the pre-deferred /auth/register flow inserted users
-- rows with email_verified = 0 before email ownership was proven. Those
-- rows are untrusted (their stored_auth belongs to "whoever submitted
-- /register last" for that email, not to a verified account owner) AND,
-- under the new flow, they become permanently stranded: verify-email
-- no longer touches pre-existing rows, so the affected user could never
-- complete email verification without manual DB surgery. (Codex round-5
-- P1 in syscoin/sysnode-backend#2.)
--
-- We delete them here. Any user whose verification was in-flight at
-- deploy time simply re-registers — no data is lost (the account never
-- had verified credentials to begin with). Rows with email_verified = 1
-- are preserved untouched.
DELETE FROM users WHERE email_verified = 0;
