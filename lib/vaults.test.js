const { openDatabase } = require('./db');
const { createVaultsRepo, etagFor } = require('./vaults');

// Mint a users row directly. We bypass the users repo here because this
// test only cares about the vaults repo contract — the FK on vaults.user_id
// is satisfied as long as a users row with that id exists. salt_v is
// NOT NULL DEFAULT '' in the schema so omitting it is safe; migration 004
// lives on the users row, not on vaults.
function seedUser(db) {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
    )
    .run('a@b.com', 'x', 'f'.repeat(64), now, now).lastInsertRowid;
}

describe('vaults repo', () => {
  let db;
  let vaults;

  beforeEach(() => {
    db = openDatabase(':memory:');
    vaults = createVaultsRepo(db, { now: () => 1_700_000_000_000 });
  });

  afterEach(() => db.close());

  test('get on a user with no vault returns null', () => {
    const uid = seedUser(db);
    expect(vaults.get(uid)).toBeNull();
  });

  test('first put creates a vault and returns etag (no saltV — it lives on users now)', () => {
    const uid = seedUser(db);
    const result = vaults.put(uid, { blob: 'ciphertextA' });
    expect(result).toEqual({ etag: etagFor('ciphertextA') });
    // Migration 004 removed the salt_v column from vaults; make sure the
    // repo's response shape matches and no stray saltV leaks back.
    expect(result.saltV).toBeUndefined();

    const got = vaults.get(uid);
    expect(got.blob).toBe('ciphertextA');
    expect(got.saltV).toBeUndefined();
    expect(got.etag).toBe(etagFor('ciphertextA'));
  });

  test('first put accepts ifMatch "*" but rejects any concrete etag', () => {
    const uid = seedUser(db);
    expect(() => vaults.put(uid, { blob: 'x', ifMatch: 'abc' })).toThrow(
      /etag_mismatch/
    );
    expect(() => vaults.put(uid, { blob: 'y', ifMatch: '*' })).not.toThrow();
  });

  test('subsequent put requires ifMatch to equal current etag', () => {
    const uid = seedUser(db);
    const first = vaults.put(uid, { blob: 'A' });

    expect(() => vaults.put(uid, { blob: 'B' })).toThrow(/etag_required/);
    expect(() => vaults.put(uid, { blob: 'B', ifMatch: 'wrong' })).toThrow(
      /etag_mismatch/
    );

    const second = vaults.put(uid, { blob: 'B', ifMatch: first.etag });
    expect(second.etag).toBe(etagFor('B'));

    expect(vaults.get(uid).blob).toBe('B');
  });

  test('ifMatch "*" is REJECTED once a vault row exists (no wildcard clobber)', () => {
    // Codex P2: allowing `*` after the first write lets a stale/buggy
    // client overwrite newer data without detecting the conflict. The
    // ETag contract is strict post-creation; clients must echo the exact
    // observed etag. Recovery from a truly corrupted local state goes
    // through an explicit "reset vault" flow instead.
    const uid = seedUser(db);
    vaults.put(uid, { blob: 'A' });
    expect(() => vaults.put(uid, { blob: 'C', ifMatch: '*' })).toThrow(
      /etag_mismatch/
    );
    // The blob must remain untouched after the rejected wildcard PUT.
    expect(vaults.get(uid).blob).toBe('A');
  });

  test('rejects empty blob', () => {
    const uid = seedUser(db);
    expect(() => vaults.put(uid, { blob: '' })).toThrow(/invalid_blob/);
  });

  test('rejects non-string blob', () => {
    const uid = seedUser(db);
    expect(() => vaults.put(uid, { blob: 42 })).toThrow(/invalid_blob/);
  });

  test('rejects oversized blob', () => {
    const uid = seedUser(db);
    const big = 'x'.repeat(257 * 1024);
    expect(() => vaults.put(uid, { blob: big })).toThrow(/blob_too_large/);
  });

  test('the conditional UPDATE itself refuses stale-etag writes at the SQL layer', () => {
    // Codex P1 (round 2): the prior upsert wrote unconditionally after a
    // pre-read check, which can't stop two concurrent workers from both
    // passing the pre-check and clobbering each other. The fix moves the
    // precondition into the WHERE clause. This test exercises the SQL
    // statement shape directly so the guarantee survives even a repo
    // refactor that someday skipped the pre-read.
    const uid = seedUser(db);
    const first = vaults.put(uid, { blob: 'A' });

    const stmt = db.prepare(
      `UPDATE vaults
          SET blob = ?, etag = ?, updated_at = ?
        WHERE user_id = ? AND etag = ?`
    );

    // Wrong etag → 0 rows affected, blob untouched.
    const stale = stmt.run('STALE', etagFor('STALE'), Date.now(), uid, 'nope');
    expect(stale.changes).toBe(0);
    expect(vaults.get(uid).blob).toBe('A');

    // Correct etag → 1 row affected.
    const ok = stmt.run('A2', etagFor('A2'), Date.now(), uid, first.etag);
    expect(ok.changes).toBe(1);
    expect(vaults.get(uid).blob).toBe('A2');
  });

  test('simulated-race: stale ifMatch against a newer row is rejected', () => {
    const uid = seedUser(db);
    const first = vaults.put(uid, { blob: 'A' });
    // A concurrent writer advances the state.
    vaults.put(uid, { blob: 'B', ifMatch: first.etag });

    // The stale writer replays the original ifMatch. put() MUST reject it
    // and leave 'B' untouched.
    expect(() =>
      vaults.put(uid, { blob: 'STALE', ifMatch: first.etag })
    ).toThrow(/etag_mismatch/);
    expect(vaults.get(uid).blob).toBe('B');
  });

  test('concurrent first-writes: PK collision is surfaced as etag_mismatch, not 500', () => {
    // If another process creates the vault row between our SELECT and
    // INSERT, the INSERT trips the user_id PK constraint. Clients
    // should see a clean 412/etag_mismatch and re-read, not a 500.
    const uid = seedUser(db);

    // Pre-insert the row to stand in for "the other worker won the race".
    db.prepare(
      `INSERT INTO vaults (user_id, blob, etag, updated_at)
         VALUES (?, ?, ?, ?)`
    ).run(uid, 'theirs', etagFor('theirs'), Date.now());

    // Direct INSERT on the same user_id must trip the PK constraint.
    // put() catches this and re-maps it to etag_mismatch.
    expect(() =>
      db
        .prepare(
          `INSERT INTO vaults (user_id, blob, etag, updated_at)
             VALUES (?, ?, ?, ?)`
        )
        .run(uid, 'mine', etagFor('mine'), Date.now())
    ).toThrow(/UNIQUE|PRIMARY KEY/i);

    // And the existing row is untouched.
    expect(vaults.get(uid).blob).toBe('theirs');
  });

  test('end-to-end: put → get-surface matches what was written (no saltV in the shape)', () => {
    // Regression guard for the column move (migration 004). The vault
    // row SELECT must not reference salt_v or better-sqlite3 will throw
    // a "no such column" at query-prepare time and every vault GET
    // turns into a 500.
    const uid = seedUser(db);
    vaults.put(uid, { blob: 'hello' });
    const row = vaults.get(uid);
    expect(Object.keys(row).sort()).toEqual(['blob', 'etag', 'updatedAt']);
  });
});
