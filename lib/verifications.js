const crypto = require('crypto');

// Magic-link email verification tokens.
// Tokens live 30 min by default. Stored as SHA-256(token) so a DB leak
// does not reveal still-valid links.

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'hex').digest('hex');
}

function createVerificationsRepo(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  const insert = db.prepare(
    `INSERT INTO email_verifications (user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?)`
  );
  const byHash = db.prepare(
    `SELECT id, user_id AS userId, expires_at AS expiresAt,
            consumed_at AS consumedAt
     FROM email_verifications WHERE token_hash = ?`
  );
  const consume = db.prepare(
    `UPDATE email_verifications SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`
  );
  const purgeForUser = db.prepare(
    `DELETE FROM email_verifications WHERE user_id = ?`
  );

  function issue(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const t = now();
    insert.run(userId, hashToken(token), t + ttlMs, t);
    return token;
  }

  function redeem(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const row = byHash.get(hashToken(token));
    if (!row) return null;
    if (row.consumedAt !== null) return null;
    const t = now();
    if (row.expiresAt < t) return null;
    const info = consume.run(t, row.id);
    if (info.changes === 0) return null;
    return { userId: row.userId };
  }

  function clearForUser(userId) {
    purgeForUser.run(userId);
  }

  return { issue, redeem, clearForUser };
}

module.exports = { createVerificationsRepo };
