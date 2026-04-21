const { openDatabase } = require('./db');

// `salt_v` is NOT NULL on users. Raw INSERTs in these tests (which
// exercise table mechanics, not user creation semantics) supply a
// fixed placeholder. The real app code in lib/users.js generates a
// per-user random salt at insert time; see lib/users.test.js for
// those guarantees.
const FAKE_SALT_V = 'aa'.repeat(32);

describe('db.openDatabase', () => {
  test('creates schema on a fresh in-memory DB', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'email_verifications',
        'pending_registrations',
        'sessions',
        'tracked_masternodes',
        'users',
        'vaults',
        'vote_reminder_log',
      ])
    );
    db.close();
  });

  test('users has notification_prefs column defaulting to {}', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    const r = db
      .prepare(
        'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('a@b.com', 'hash', FAKE_SALT_V, now, now);
    const row = db
      .prepare('SELECT notification_prefs FROM users WHERE id = ?')
      .get(r.lastInsertRowid);
    expect(row.notification_prefs).toBe('{}');
    db.close();
  });

  test('users requires a non-null salt_v', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    // `salt_v` is deliberately omitted here; SQLite should reject
    // the insert because it has no default.
    expect(() =>
      db
        .prepare(
          'INSERT INTO users (email, stored_auth, created_at, updated_at) VALUES (?, ?, ?, ?)'
        )
        .run('a@b.com', 'hash', now, now)
    ).toThrow(/NOT NULL.*salt_v/i);
    db.close();
  });

  test('tracked_masternodes enforces unique (user, txid, vout)', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    const r = db
      .prepare(
        'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('a@b.com', 'hash', FAKE_SALT_V, now, now);
    const uid = r.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO tracked_masternodes (user_id, collateral_txid, collateral_vout, label, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    ins.run(uid, 'abc', 0, 'mn1', now);
    expect(() => ins.run(uid, 'abc', 0, 'dup', now)).toThrow(/UNIQUE/i);
    ins.run(uid, 'abc', 1, 'mn2', now);
    db.close();
  });

  test('vote_reminder_log enforces one row per (user, scope_key, bucket)', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    const r = db
      .prepare(
        'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('a@b.com', 'hash', FAKE_SALT_V, now, now);
    const uid = r.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO vote_reminder_log (user_id, scope_key, bucket, sent_at) VALUES (?, ?, ?, ?)'
    );
    // Same scope_key, different buckets — allowed. Same scope_key +
    // same bucket is a collision by design (the dispatcher would be
    // re-sending what it already sent).
    ins.run(uid, 'cycle:1700000000', 'days_before', now);
    ins.run(uid, 'cycle:1700000000', 'final_24h', now);
    expect(() =>
      ins.run(uid, 'cycle:1700000000', 'days_before', now)
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  test('enforces unique email', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    const stmt = db.prepare(
      'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run('a@b.com', 'hash', FAKE_SALT_V, now, now);
    expect(() => stmt.run('a@b.com', 'hash2', FAKE_SALT_V, now, now)).toThrow(/UNIQUE/i);
    db.close();
  });

  test('cascades delete from users to sessions/vaults/email_verifications', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    const r = db
      .prepare(
        'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('a@b.com', 'hash', FAKE_SALT_V, now, now);
    const uid = r.lastInsertRowid;

    db.prepare(
      'INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)'
    ).run(uid, 'tokhash', now, now + 1000, now);

    db.prepare(
      'INSERT INTO vaults (user_id, blob, etag, updated_at) VALUES (?, ?, ?, ?)'
    ).run(uid, 'blob', 'etag', now);

    db.prepare(
      'INSERT INTO email_verifications (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).run(uid, 'vtokhash', now + 1000, now);

    db.prepare('DELETE FROM users WHERE id = ?').run(uid);

    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM vaults').get().c).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM email_verifications').get().c
    ).toBe(0);
    db.close();
  });

  test(
    'migrates existing databases that already applied 001 (vote_reminder_log.proposal_hash -> scope_key)',
    () => {
      // Regression for Codex PR 7 round 1 P1:
      //   Prior to PR 7, 001_init.sql shipped with
      //   vote_reminder_log(proposal_hash, ...). PR 7 needs the column
      //   named `scope_key`. Editing 001 alone does not help existing
      //   deployments because lib/db.js tracks applied migrations by
      //   filename — 001 is never re-run. This asserts the rename
      //   migration (002) is applied on top of a pre-001 database.
      //
      // We simulate an "old" DB by:
      //   1. Opening a fresh handle (runs 001 + 002 — fine for now).
      //   2. Rolling the column back to proposal_hash and deleting
      //      the schema_migrations row for 002, making the DB look
      //      exactly like a pre-PR-7 production database.
      //   3. Calling migrate() again — 002 should run and rename
      //      the column back to scope_key.
      const Database = require('better-sqlite3');
      const { migrate } = require('./db');
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      migrate(db);

      // Snapshot a row so we can verify the rename preserves data.
      const now = Date.now();
      const r = db
        .prepare(
          'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run('a@b.com', 'hash', FAKE_SALT_V, now, now);
      const uid = r.lastInsertRowid;
      db.prepare(
        'INSERT INTO vote_reminder_log (user_id, scope_key, bucket, sent_at) VALUES (?, ?, ?, ?)'
      ).run(uid, 'cycle:1700000000', 'days_before', now);

      // Undo 002: rename back, and drop its schema_migrations row.
      db.exec(
        'ALTER TABLE vote_reminder_log RENAME COLUMN scope_key TO proposal_hash;'
      );
      db.prepare(
        "DELETE FROM schema_migrations WHERE filename = '002_vote_reminder_log_scope_key.sql'"
      ).run();

      // Pre-condition: looks like a pre-PR-7 DB.
      expect(
        db
          .prepare("PRAGMA table_info('vote_reminder_log')")
          .all()
          .map((c) => c.name)
      ).toContain('proposal_hash');

      // Re-apply migrations — 002 should now run.
      migrate(db);

      const cols = db
        .prepare("PRAGMA table_info('vote_reminder_log')")
        .all()
        .map((c) => c.name);
      expect(cols).toContain('scope_key');
      expect(cols).not.toContain('proposal_hash');

      // Data preserved, UNIQUE constraint rewritten to use scope_key.
      const row = db
        .prepare('SELECT scope_key, bucket FROM vote_reminder_log')
        .get();
      expect(row.scope_key).toBe('cycle:1700000000');
      expect(row.bucket).toBe('days_before');
      expect(() =>
        db
          .prepare(
            'INSERT INTO vote_reminder_log (user_id, scope_key, bucket, sent_at) VALUES (?, ?, ?, ?)'
          )
          .run(uid, 'cycle:1700000000', 'days_before', now)
      ).toThrow(/UNIQUE/i);

      db.close();
    }
  );

  test('is idempotent: re-opening the same DB keeps data', () => {
    const path = `:memory:`;
    const db1 = openDatabase(path);
    // in-memory handles aren't shared, so we simulate idempotency with a
    // second migrate() call on the same handle.
    const now = Date.now();
    db1
      .prepare(
        'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('x@y.com', 'h', FAKE_SALT_V, now, now);
    // Re-run migrations module against same handle should be a no-op.
    const { migrate } = require('./db');
    expect(() => migrate(db1)).not.toThrow();
    expect(
      db1.prepare('SELECT COUNT(*) AS c FROM users').get().c
    ).toBe(1);
    db1.close();
  });
});
