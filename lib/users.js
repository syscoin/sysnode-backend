const { normalizeEmail, isValidEmailSyntax } = require('./email');
const { hashAuthHash, verifyAuthHash } = require('./kdf');

function mapRow(row) {
  if (!row) return null;
  let prefs = {};
  try {
    prefs = row.notification_prefs ? JSON.parse(row.notification_prefs) : {};
  } catch {
    prefs = {};
  }
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified === 1,
    notificationPrefs: prefs,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createUsersRepo(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());

  const insert = db.prepare(
    `INSERT INTO users (email, stored_auth, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  );
  const insertVerified = db.prepare(
    `INSERT INTO users (email, stored_auth, email_verified, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`
  );
  const byId = db.prepare(`SELECT * FROM users WHERE id = ?`);
  const byEmail = db.prepare(`SELECT * FROM users WHERE email = ?`);
  const updateVerified = db.prepare(
    `UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`
  );
  const updateAuth = db.prepare(
    `UPDATE users SET stored_auth = ?, updated_at = ? WHERE id = ?`
  );
  const updatePrefs = db.prepare(
    `UPDATE users SET notification_prefs = ?, updated_at = ? WHERE id = ?`
  );

  function create({ email, authHash }) {
    const normalized = normalizeEmail(email);
    if (!isValidEmailSyntax(normalized)) {
      const e = new Error('invalid_email');
      e.code = 'invalid_email';
      throw e;
    }
    const stored = hashAuthHash(authHash);
    const t = now();
    try {
      const r = insert.run(normalized, stored, t, t);
      return mapRow(byId.get(r.lastInsertRowid));
    } catch (err) {
      if (err && /UNIQUE/i.test(err.message)) {
        const e = new Error('email_taken');
        e.code = 'email_taken';
        throw e;
      }
      throw err;
    }
  }

  function findById(id) {
    return mapRow(byId.get(id));
  }

  function findByEmail(email) {
    return mapRow(byEmail.get(normalizeEmail(email)));
  }

  function verifyAuth(email, authHash) {
    const row = byEmail.get(normalizeEmail(email));
    if (!row) return null;
    if (!verifyAuthHash(row.stored_auth, authHash)) return null;
    return mapRow(row);
  }

  function markEmailVerified(id) {
    updateVerified.run(now(), id);
  }

  // Create a user already marked email_verified using a pre-hashed
  // stored_auth snapshot (from pending_registrations.storedAuth). This is
  // the user-creation path for the deferred-binding register flow: the
  // account doesn't exist until the verification link is redeemed, so we
  // create-and-verify in a single DB call that's protected from concurrent
  // duplicates by the users.email UNIQUE constraint.
  function createVerifiedWithStoredAuth({ email, storedAuth }) {
    const normalized = normalizeEmail(email);
    if (!isValidEmailSyntax(normalized)) {
      const e = new Error('invalid_email');
      e.code = 'invalid_email';
      throw e;
    }
    const t = now();
    try {
      const r = insertVerified.run(normalized, storedAuth, t, t);
      return mapRow(byId.get(r.lastInsertRowid));
    } catch (err) {
      if (err && /UNIQUE/i.test(err.message)) {
        const e = new Error('email_taken');
        e.code = 'email_taken';
        throw e;
      }
      throw err;
    }
  }

  function updateAuthHash(id, authHash) {
    updateAuth.run(hashAuthHash(authHash), now(), id);
  }

  function updateNotificationPrefs(id, prefs) {
    const json = JSON.stringify(prefs || {});
    updatePrefs.run(json, now(), id);
  }

  return {
    create,
    createVerifiedWithStoredAuth,
    findById,
    findByEmail,
    verifyAuth,
    markEmailVerified,
    updateAuthHash,
    updateNotificationPrefs,
  };
}

module.exports = { createUsersRepo };
