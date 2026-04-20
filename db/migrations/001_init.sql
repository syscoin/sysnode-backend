-- Migration 001: users, email_verifications, sessions, vaults.
--
-- Notes on design:
-- * All PKs are surrogate integers. Email is a natural key but we keep it as
--   a unique column to simplify reassignment and case handling.
-- * email is stored already-normalized (trim + lowercase + NFKC by the app).
-- * stored_auth is the argon2id-encoded form of the client-sent authHash.
-- * email_verified defaults 0; vault writes/reads are gated on verification.
-- * vaults is 1:1 with users and stores ONLY the encrypted blob, the public
--   per-user vault salt (saltV), and a short etag to detect stale clients.
-- * sessions table is kept for auditability/revocation; the cookie value is
--   stored hashed so DB dump does not yield session-stealing tokens.

CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL UNIQUE,
  stored_auth     TEXT    NOT NULL,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
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
  salt_v      TEXT    NOT NULL,
  blob        TEXT    NOT NULL,
  etag        TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);
