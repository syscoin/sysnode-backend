const { openDatabase } = require('./db');
const { createVerificationsRepo } = require('./verifications');

function seedUser(db) {
  const now = Date.now();
  return db
    .prepare(
      'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run('a@b.com', 'x', 'aa'.repeat(32), now, now).lastInsertRowid;
}

describe('verifications repo', () => {
  let db;
  let repo;
  let now;

  beforeEach(() => {
    db = openDatabase(':memory:');
    now = 1_700_000_000_000;
    repo = createVerificationsRepo(db, { now: () => now });
  });

  afterEach(() => db.close());

  test('issue stores only the token hash', () => {
    const uid = seedUser(db);
    const token = repo.issue(uid);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const row = db.prepare('SELECT token_hash FROM email_verifications').get();
    expect(row.token_hash).not.toBe(token);
  });

  test('redeem returns userId for a valid token exactly once', () => {
    const uid = seedUser(db);
    const token = repo.issue(uid);
    expect(repo.redeem(token)).toEqual({ userId: uid });
    expect(repo.redeem(token)).toBeNull();
  });

  test('redeem fails for unknown or malformed tokens', () => {
    expect(repo.redeem('nope')).toBeNull();
    expect(repo.redeem('')).toBeNull();
    expect(repo.redeem('ab'.repeat(32))).toBeNull();
  });

  test('redeem fails after expiry', () => {
    const uid = seedUser(db);
    const token = repo.issue(uid);
    now += 31 * 60 * 1000;
    expect(repo.redeem(token)).toBeNull();
  });

  test('clearForUser invalidates every outstanding token for a user', () => {
    const uid = seedUser(db);
    const a = repo.issue(uid);
    const b = repo.issue(uid);
    repo.clearForUser(uid);
    expect(repo.redeem(a)).toBeNull();
    expect(repo.redeem(b)).toBeNull();
  });
});
