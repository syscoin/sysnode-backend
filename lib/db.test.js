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
        'proposal_drafts',
        'proposal_submissions',
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

  test('proposal_drafts cascade-delete when user is removed', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    const r = db
      .prepare(
        'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('a@b.com', 'hash', FAKE_SALT_V, now, now);
    const uid = r.lastInsertRowid;
    db.prepare(
      'INSERT INTO proposal_drafts (user_id, created_at, updated_at) VALUES (?, ?, ?)'
    ).run(uid, now, now);
    expect(db.prepare('SELECT COUNT(*) AS c FROM proposal_drafts').get().c).toBe(1);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    expect(db.prepare('SELECT COUNT(*) AS c FROM proposal_drafts').get().c).toBe(0);
    db.close();
  });

  test('proposal_submissions enforce unique collateral_txid when set, allow multiple NULLs', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    const r = db
      .prepare(
        'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('a@b.com', 'hash', FAKE_SALT_V, now, now);
    const uid = r.lastInsertRowid;
    const baseCols = [
      'user_id',
      'time_unix',
      'data_hex',
      'proposal_hash',
      'name',
      'url',
      'payment_address',
      'payment_amount_sats',
      'start_epoch',
      'end_epoch',
      'status',
      'collateral_txid',
      'created_at',
      'updated_at',
    ];
    const placeholders = baseCols.map(() => '?').join(',');
    const ins = db.prepare(
      `INSERT INTO proposal_submissions (${baseCols.join(',')}) VALUES (${placeholders})`
    );
    // data_hex varies per row because there is also a partial unique
    // index `(user_id, data_hex) WHERE status='prepared'` that guards
    // the /prepare idempotency contract (Codex PR8 round 3 P2). This
    // test cares only about the collateral_txid uniqueness; using a
    // distinct data_hex per row keeps the two unrelated invariants
    // decoupled.
    const row = (hash, txid, dataHex) => [
      uid,
      1700000000,
      dataHex,
      hash,
      'n',
      'u',
      'a',
      1,
      1700000000,
      1800000000,
      'prepared',
      txid,
      now,
      now,
    ];
    // Two rows with NULL txid are fine (both still in 'prepared').
    ins.run(...row('h1'.padEnd(64, '0'), null, 'de01'));
    ins.run(...row('h2'.padEnd(64, '0'), null, 'de02'));
    // A non-null txid is unique.
    ins.run(...row('h3'.padEnd(64, '0'), 'abc123', 'de03'));
    expect(() =>
      ins.run(...row('h4'.padEnd(64, '0'), 'abc123', 'de04'))
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  test('proposal_submissions governance_hash is unique when set', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    const r = db
      .prepare(
        'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('a@b.com', 'hash', FAKE_SALT_V, now, now);
    const uid = r.lastInsertRowid;
    const cols =
      'user_id,time_unix,data_hex,proposal_hash,name,url,payment_address,payment_amount_sats,start_epoch,end_epoch,status,governance_hash,created_at,updated_at';
    const ins = db.prepare(
      `INSERT INTO proposal_submissions (${cols}) VALUES (${cols
        .split(',')
        .map(() => '?')
        .join(',')})`
    );
    const ph = (hash, govHash) => [
      uid,
      1,
      'de',
      hash,
      'n',
      'u',
      'a',
      1,
      1,
      2,
      'submitted',
      govHash,
      now,
      now,
    ];
    ins.run(...ph('a'.repeat(64), 'g'.repeat(64)));
    expect(() => ins.run(...ph('b'.repeat(64), 'g'.repeat(64)))).toThrow(/UNIQUE/i);
    db.close();
  });

  test('proposal_submissions.draft_id is ON DELETE SET NULL (history survives)', () => {
    const db = openDatabase(':memory:');
    const now = Date.now();
    const r = db
      .prepare(
        'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('a@b.com', 'hash', FAKE_SALT_V, now, now);
    const uid = r.lastInsertRowid;
    const d = db
      .prepare(
        'INSERT INTO proposal_drafts (user_id, created_at, updated_at) VALUES (?, ?, ?)'
      )
      .run(uid, now, now);
    const did = d.lastInsertRowid;
    db.prepare(
      `INSERT INTO proposal_submissions (user_id, draft_id, time_unix, data_hex, proposal_hash, name, url, payment_address, payment_amount_sats, start_epoch, end_epoch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uid, did, 1, 'de', 'h'.repeat(64), 'n', 'u', 'a', 1, 1, 2, 'prepared', now, now);
    db.prepare('DELETE FROM proposal_drafts WHERE id = ?').run(did);
    const row = db
      .prepare('SELECT draft_id FROM proposal_submissions WHERE user_id = ?')
      .get(uid);
    expect(row.draft_id).toBeNull();
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
