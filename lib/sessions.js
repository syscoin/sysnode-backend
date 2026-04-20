const crypto = require('crypto');

// Session store.
//
// Design:
// - Tokens are 32 random bytes, hex-encoded (64 chars). This is what goes into
//   the cookie. The DB stores SHA-256(token); a DB leak does not yield a
//   session-stealing token.
// - Sliding expiry: each successful verify() extends the session by another
//   `slidingMs` (default 14 days). This gives comfy "stay signed in".
// - Absolute expiry: a session can never live longer than `absoluteMs` (default
//   30 days) from creation. Guarantees periodic re-auth even for active users.
// - `now` is injected for testability.

const DAY_MS = 24 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'hex').digest('hex');
}

function createSessionStore(db, opts = {}) {
  const slidingMs = opts.slidingMs ?? 14 * DAY_MS;
  const absoluteMs = opts.absoluteMs ?? 30 * DAY_MS;
  const now = opts.now ?? (() => Date.now());

  const insert = db.prepare(
    `INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const selectByHash = db.prepare(
    `SELECT id, user_id AS userId, created_at AS createdAt,
            expires_at AS expiresAt, last_seen AS lastSeen
     FROM sessions WHERE token_hash = ?`
  );
  const updateSliding = db.prepare(
    `UPDATE sessions SET expires_at = ?, last_seen = ? WHERE id = ?`
  );
  const deleteByHash = db.prepare(`DELETE FROM sessions WHERE token_hash = ?`);
  const deleteByUser = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);
  const deleteExpired = db.prepare(
    `DELETE FROM sessions WHERE expires_at < ? OR created_at + ? < ?`
  );

  function issue(userId, meta = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const t = now();
    const expiresAt = t + slidingMs;
    insert.run(
      userId,
      tokenHash,
      t,
      expiresAt,
      t,
      meta.userAgent || null,
      meta.ip || null
    );
    return { token, expiresAt };
  }

  function verify(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
      return null;
    }
    const hash = hashToken(token);
    const row = selectByHash.get(hash);
    if (!row) return null;

    const t = now();
    if (row.expiresAt < t) return null;
    if (row.createdAt + absoluteMs < t) return null;

    const newExpiresAt = Math.min(t + slidingMs, row.createdAt + absoluteMs);
    updateSliding.run(newExpiresAt, t, row.id);

    return {
      id: row.id,
      userId: row.userId,
      createdAt: row.createdAt,
      expiresAt: newExpiresAt,
    };
  }

  function revoke(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
      return false;
    }
    const hash = hashToken(token);
    const info = deleteByHash.run(hash);
    return info.changes > 0;
  }

  function revokeAllForUser(userId) {
    const info = deleteByUser.run(userId);
    return info.changes;
  }

  function cleanupExpired() {
    const t = now();
    const info = deleteExpired.run(t, absoluteMs, t);
    return info.changes;
  }

  return {
    issue,
    verify,
    revoke,
    revokeAllForUser,
    cleanupExpired,
  };
}

module.exports = { createSessionStore, hashToken };
