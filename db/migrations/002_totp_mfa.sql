-- Migration 002: optional TOTP MFA.
--
-- Adds account-scoped TOTP state and short-lived login challenges. Shared
-- secrets are encrypted by the application before storage; recovery codes and
-- login challenge tokens are hashed at rest.

CREATE TABLE user_totp (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc          TEXT,
  pending_secret_enc  TEXT,
  recovery_hashes     TEXT    NOT NULL DEFAULT '[]',
  enabled             INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE mfa_challenges (
  token_hash  TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_mfa_challenges_user ON mfa_challenges(user_id);
CREATE INDEX idx_mfa_challenges_expires ON mfa_challenges(expires_at);
