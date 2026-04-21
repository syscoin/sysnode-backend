// Thin repo over the `vote_reminder_log` table (see migration 001).
//
// The reminder dispatcher uses this to answer two questions:
//
//   1. "Has (user, scope_key, bucket) already been sent?"  → has()
//   2. "Record that (user, scope_key, bucket) has just been sent."  → insert()
//
// The UNIQUE constraint on (user_id, scope_key, bucket) is our
// cross-tick idempotency guarantee: even if two dispatcher ticks race
// (single-instance via setInterval today, but defense-in-depth for a
// future multi-instance deploy), at most one row is created and the
// second INSERT raises a UNIQUE violation we translate to a harmless
// "already sent" signal.
//
// `scope_key` is owned by the dispatcher; this module is deliberately
// schema-agnostic about its format. Today that is `cycle:<deadline>`;
// tomorrow it could be `proposal:<hash>` without any change here.

function createReminderLog(db, opts = {}) {
  if (!db) throw new Error('createReminderLog: db is required');
  const now = opts.now ?? (() => Date.now());

  const hasStmt = db.prepare(
    `SELECT 1
       FROM vote_reminder_log
      WHERE user_id   = ?
        AND scope_key = ?
        AND bucket    = ?
      LIMIT 1`
  );

  const insertStmt = db.prepare(
    `INSERT INTO vote_reminder_log (user_id, scope_key, bucket, sent_at)
     VALUES (?, ?, ?, ?)`
  );

  function validateArgs(userId, scopeKey, bucket) {
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error('reminderLog: userId must be a positive integer');
    }
    if (typeof scopeKey !== 'string' || scopeKey.length === 0) {
      throw new Error('reminderLog: scopeKey must be a non-empty string');
    }
    if (typeof bucket !== 'string' || bucket.length === 0) {
      throw new Error('reminderLog: bucket must be a non-empty string');
    }
  }

  function has(userId, scopeKey, bucket) {
    validateArgs(userId, scopeKey, bucket);
    return !!hasStmt.get(userId, scopeKey, bucket);
  }

  // Returns:
  //   { inserted: true,  sentAt }  — fresh row written
  //   { inserted: false, sentAt:null } — already logged (UNIQUE hit)
  //
  // We translate the UNIQUE violation into a soft false so callers can
  // treat "insert-or-skip" as a single call without a surrounding
  // try/catch. Any other SQLite error propagates unchanged.
  function insert(userId, scopeKey, bucket, sentAt) {
    validateArgs(userId, scopeKey, bucket);
    const when =
      Number.isFinite(sentAt) && sentAt >= 0 ? sentAt : now();
    try {
      insertStmt.run(userId, scopeKey, bucket, when);
      return { inserted: true, sentAt: when };
    } catch (err) {
      if (err && /UNIQUE/i.test(err.message)) {
        return { inserted: false, sentAt: null };
      }
      throw err;
    }
  }

  return { has, insert };
}

module.exports = { createReminderLog };
