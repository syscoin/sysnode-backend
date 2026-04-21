const crypto = require('crypto');
const { normalizeEmail, isValidEmailSyntax } = require('./email');
const { hashAuthHash, verifyAuthHash } = require('./kdf');

// saltV is 32 bytes of random material exposed as 64 lowercase hex chars.
// Generated once per user at creation time (see migration 004) and never
// mutated afterwards — password changes rotate authHash but NOT saltV, so
// the client's HKDF(master, saltV) → vaultKey output for a given password
// is stable only within one saltV epoch. Rotating saltV would invalidate
// every existing encrypted blob, which is the opposite of what
// change-password should do.
function generateSaltV() {
  return crypto.randomBytes(32).toString('hex');
}

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
    // Always lower-cased on the wire. Migration 004 backfills in lowercase
    // via SQLite's lower(hex(...)), and generateSaltV emits lowercase too,
    // but defensively normalize on read in case a future import/restore
    // lands uppercase bytes in the column.
    saltV: typeof row.salt_v === 'string' ? row.salt_v.toLowerCase() : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createUsersRepo(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());

  const insert = db.prepare(
    `INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertVerified = db.prepare(
    `INSERT INTO users (email, stored_auth, salt_v, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`
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
  const promoteUnverified = db.prepare(
    `UPDATE users
        SET stored_auth    = ?,
            email_verified = 1,
            updated_at     = ?
      WHERE id = ?
        AND email_verified = 0`
  );

  function create({ email, authHash }) {
    const normalized = normalizeEmail(email);
    if (!isValidEmailSyntax(normalized)) {
      const e = new Error('invalid_email');
      e.code = 'invalid_email';
      throw e;
    }
    const stored = hashAuthHash(authHash);
    const saltV = generateSaltV();
    const t = now();
    try {
      const r = insert.run(normalized, stored, saltV, t, t);
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
    const saltV = generateSaltV();
    const t = now();
    try {
      const r = insertVerified.run(normalized, storedAuth, saltV, t, t);
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

  // Rotate an existing unverified users row to verified, rebinding its
  // stored_auth to a pre-hashed snapshot (from pendingRegistrations).
  // Guarded by a WHERE email_verified = 0 clause so this cannot be used
  // to reset the credential on an already-verified account — that
  // operation requires /change-password.
  //
  // Returns true iff exactly one row transitioned from unverified →
  // verified; callers treat false as "the row was already verified or
  // no longer exists" and should fall back to the already_verified /
  // insert-new-row paths accordingly.
  //
  // This exists as a defense-in-depth complement to migration 003:
  // that migration purges legacy unverified rows at deploy time, but
  // the code path guards against any future regression that might
  // re-introduce an unverified row into the users table.
  function promoteUnverifiedWithStoredAuth({ id, storedAuth }) {
    const info = promoteUnverified.run(storedAuth, now(), id);
    return info.changes === 1;
  }

  function updateNotificationPrefs(id, prefs) {
    const json = JSON.stringify(prefs || {});
    updatePrefs.run(json, now(), id);
  }

  // Hard-delete a user row. All dependent rows
  // (sessions, vaults, email_verifications, tracked_masternodes,
  //  vote_reminder_log, vote_receipts) cascade automatically via
  // their FK ON DELETE CASCADE constraints — see db/migrations/001_init.sql.
  //
  // `pending_registrations` is NOT cascaded (it's keyed by email, not
  // user_id) and is the caller's responsibility to purge via
  // pendingRegistrations.purgeForEmail() inside the same transaction —
  // otherwise a stale verification token whose email matches the
  // deleted account would be redeemable into a fresh row, effectively
  // re-registering the account without the user's consent.
  //
  // Returns the number of rows deleted (1 on success, 0 if already
  // gone). Callers should treat 0 as a no-op rather than an error:
  // any idempotent retry after a partial failure converges here.
  const deleteUserById = db.prepare(`DELETE FROM users WHERE id = ?`);
  function deleteById(id) {
    const info = deleteUserById.run(id);
    return info.changes;
  }

  // List verified users who are eligible for governance reminder
  // emails. "Eligible" = default (no explicit opt-out recorded).
  //
  // The notification_prefs column defaults to '{}' for fresh accounts,
  // so an account with no prefs at all is treated as opted-in. A user
  // who explicitly toggles vote reminders off stores
  // { voteReminders: { enabled: false } }; we filter those out here.
  //
  // We do NOT filter in SQL (json_extract availability depends on how
  // SQLite was compiled, and better-sqlite3 can but we don't want to
  // make that assumption portable across future storage engines). The
  // user table is small (human-scale), so an in-process filter is the
  // pragmatic choice and keeps the "default = opt in" semantics in one
  // place — mapRow → consumer.
  const selectAllVerified = db.prepare(
    `SELECT * FROM users WHERE email_verified = 1`
  );

  function listWithRemindersEnabled() {
    const rows = selectAllVerified.all();
    const out = [];
    for (const row of rows) {
      const u = mapRow(row);
      if (!u) continue;
      const prefs = u.notificationPrefs || {};
      const vr = prefs.voteReminders;
      // Three acceptable shapes for "enabled":
      //   - prefs entirely absent         → opt-in by default
      //   - voteReminders absent          → opt-in by default
      //   - voteReminders.enabled !== false → opt-in
      // Explicit false is the only signal that suppresses the email.
      if (vr && vr.enabled === false) continue;
      out.push(u);
    }
    return out;
  }

  return {
    create,
    createVerifiedWithStoredAuth,
    promoteUnverifiedWithStoredAuth,
    findById,
    findByEmail,
    verifyAuth,
    markEmailVerified,
    updateAuthHash,
    updateNotificationPrefs,
    listWithRemindersEnabled,
    deleteById,
  };
}

module.exports = { createUsersRepo };
