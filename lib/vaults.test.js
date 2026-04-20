const { openDatabase } = require('./db');
const { createVaultsRepo, etagFor } = require('./vaults');

function seedUser(db) {
  const now = Date.now();
  return db
    .prepare(
      'INSERT INTO users (email, stored_auth, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
    .run('a@b.com', 'x', now, now).lastInsertRowid;
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

  test('first put creates a vault, issues saltV, returns etag', () => {
    const uid = seedUser(db);
    const { saltV, etag } = vaults.put(uid, { blob: 'ciphertextA' });
    expect(saltV).toMatch(/^[0-9a-f]{64}$/);
    expect(etag).toBe(etagFor('ciphertextA'));
    const got = vaults.get(uid);
    expect(got.blob).toBe('ciphertextA');
    expect(got.saltV).toBe(saltV);
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
    expect(second.saltV).toBe(first.saltV); // saltV is sticky

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
});
