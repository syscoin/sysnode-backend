const crypto = require('crypto');
const { normalizeEmail, isValidEmailSyntax } = require('./email');
const { hashAuthHash } = require('./kdf');

// Pending-registration repo.
//
// Contract:
// - issue({email, authHash}) returns the plaintext token to embed in the
//   verification email. Only its SHA-256 is stored. Multiple pending rows
//   can exist for the same email simultaneously; each redeems to its own
//   (email, stored_auth) snapshot independently of the others.
// - redeem(token) returns {email, storedAuth} once and only once. Subsequent
//   redeems for the same token return null. Expired rows also return null.
// - purgeForEmail(email) nukes every pending row for an email. Called by
//   /verify-email after successful user creation so stale attacker-spawned
//   tokens can't ever be redeemed.
// - cleanupExpired() is a periodic no-op sweep; fine to skip in dev.
//
// The stored_auth column is HMAC(authHash, pepper) — same format as
// users.stored_auth, so verify-email can copy the value straight across
// instead of re-hashing.

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'hex').digest('hex');
}

function createPendingRegistrationsRepo(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  const insert = db.prepare(
    `INSERT INTO pending_registrations
       (token_hash, email_normalized, stored_auth, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const byTokenHash = db.prepare(
    `SELECT token_hash       AS tokenHash,
            email_normalized AS email,
            stored_auth      AS storedAuth,
            expires_at       AS expiresAt
     FROM pending_registrations WHERE token_hash = ?`
  );
  const deleteByTokenHash = db.prepare(
    `DELETE FROM pending_registrations WHERE token_hash = ?`
  );
  const deleteByEmail = db.prepare(
    `DELETE FROM pending_registrations WHERE email_normalized = ?`
  );
  const deleteExpired = db.prepare(
    `DELETE FROM pending_registrations WHERE expires_at < ?`
  );

  function issue({ email, authHash }) {
    const normalized = normalizeEmail(email);
    if (!isValidEmailSyntax(normalized)) {
      const e = new Error('invalid_email');
      e.code = 'invalid_email';
      throw e;
    }
    const storedAuth = hashAuthHash(authHash);
    const token = crypto.randomBytes(32).toString('hex');
    const t = now();
    insert.run(hashToken(token), normalized, storedAuth, t, t + ttlMs);
    return token;
  }

  function redeem(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
      return null;
    }
    const h = hashToken(token);
    const row = byTokenHash.get(h);
    if (!row) return null;
    if (row.expiresAt < now()) {
      // Expired rows are dead weight; remove on access.
      deleteByTokenHash.run(h);
      return null;
    }
    // Atomic single-use: delete the row and return its payload only if
    // exactly one row was affected. This races cleanly even if two
    // handlers somehow redeem the same token simultaneously.
    const info = deleteByTokenHash.run(h);
    if (info.changes !== 1) return null;
    return { email: row.email, storedAuth: row.storedAuth };
  }

  function purgeForEmail(email) {
    const info = deleteByEmail.run(normalizeEmail(email));
    return info.changes;
  }

  function cleanupExpired() {
    const info = deleteExpired.run(now());
    return info.changes;
  }

  return { issue, redeem, purgeForEmail, cleanupExpired };
}

module.exports = { createPendingRegistrationsRepo };
