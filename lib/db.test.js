const { openDatabase } = require('./db');

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
        'sessions',
        'users',
        'vaults',
      ])
    );
    db.close();
  });

  test('enforces unique email', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    const stmt = db.prepare(
      'INSERT INTO users (email, stored_auth, created_at, updated_at) VALUES (?, ?, ?, ?)'
    );
    stmt.run('a@b.com', 'hash', now, now);
    expect(() => stmt.run('a@b.com', 'hash2', now, now)).toThrow(/UNIQUE/i);
    db.close();
  });

  test('cascades delete from users to sessions/vaults/email_verifications', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    const r = db
      .prepare(
        'INSERT INTO users (email, stored_auth, created_at, updated_at) VALUES (?, ?, ?, ?)'
      )
      .run('a@b.com', 'hash', now, now);
    const uid = r.lastInsertRowid;

    db.prepare(
      'INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)'
    ).run(uid, 'tokhash', now, now + 1000, now);

    db.prepare(
      'INSERT INTO vaults (user_id, salt_v, blob, etag, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(uid, 'salt', 'blob', 'etag', now);

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

  test('is idempotent: re-opening the same DB keeps data', () => {
    const path = `:memory:`;
    const db1 = openDatabase(path);
    // in-memory handles aren't shared, so we simulate idempotency with a
    // second migrate() call on the same handle.
    const now = Date.now();
    db1
      .prepare(
        'INSERT INTO users (email, stored_auth, created_at, updated_at) VALUES (?, ?, ?, ?)'
      )
      .run('x@y.com', 'h', now, now);
    // Re-run migrations module against same handle should be a no-op.
    const { migrate } = require('./db');
    expect(() => migrate(db1)).not.toThrow();
    expect(
      db1.prepare('SELECT COUNT(*) AS c FROM users').get().c
    ).toBe(1);
    db1.close();
  });
});
