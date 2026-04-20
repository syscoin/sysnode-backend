const { openDatabase } = require('./db');
const { createSessionStore } = require('./sessions');

function seedUser(db) {
  const now = Date.now();
  const r = db
    .prepare(
      'INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run('a@b.com', 'x', 'aa'.repeat(32), now, now);
  return r.lastInsertRowid;
}

describe('sessions.createSessionStore', () => {
  let db;
  let store;
  let now;

  beforeEach(() => {
    db = openDatabase(':memory:');
    now = 1_700_000_000_000;
    store = createSessionStore(db, { now: () => now });
  });

  afterEach(() => db.close());

  test('issue returns an opaque token and persists only its hash', () => {
    const uid = seedUser(db);
    const { token, expiresAt } = store.issue(uid, {
      userAgent: 'jest',
      ip: '127.0.0.1',
    });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBeGreaterThan(now);

    const rows = db.prepare('SELECT token_hash FROM sessions').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('verify returns the session when token matches', () => {
    const uid = seedUser(db);
    const { token } = store.issue(uid);
    const s = store.verify(token);
    expect(s).not.toBeNull();
    expect(s.userId).toBe(uid);
  });

  test('verify returns null for unknown token', () => {
    expect(store.verify('deadbeef'.repeat(8))).toBeNull();
  });

  test('verify returns null for malformed token', () => {
    expect(store.verify('not-hex')).toBeNull();
    expect(store.verify('')).toBeNull();
    expect(store.verify(null)).toBeNull();
  });

  test('verify slides the expiry forward on access', () => {
    const uid = seedUser(db);
    const { token } = store.issue(uid);
    const row1 = db.prepare('SELECT expires_at FROM sessions').get();

    now += 24 * 60 * 60 * 1000; // one day later
    const s = store.verify(token);
    expect(s).not.toBeNull();

    const row2 = db.prepare('SELECT expires_at FROM sessions').get();
    expect(row2.expires_at).toBeGreaterThan(row1.expires_at);
  });

  test('verify honors absolute expiry cap', () => {
    const uid = seedUser(db);
    const { token } = store.issue(uid);
    // Fast-forward past absolute cap (30 days default).
    now += 31 * 24 * 60 * 60 * 1000;
    expect(store.verify(token)).toBeNull();
  });

  test('verify returns null after sliding expiry lapses', () => {
    const uid = seedUser(db);
    const { token } = store.issue(uid);
    // Beyond sliding window (14 days) but under absolute cap.
    now += 15 * 24 * 60 * 60 * 1000;
    expect(store.verify(token)).toBeNull();
  });

  test('revoke deletes the session by token', () => {
    const uid = seedUser(db);
    const { token } = store.issue(uid);
    expect(store.revoke(token)).toBe(true);
    expect(store.verify(token)).toBeNull();
    expect(store.revoke(token)).toBe(false);
  });

  test('revokeAllForUser clears every session (e.g. after password change)', () => {
    const uid = seedUser(db);
    const a = store.issue(uid).token;
    const b = store.issue(uid).token;
    expect(store.revokeAllForUser(uid)).toBe(2);
    expect(store.verify(a)).toBeNull();
    expect(store.verify(b)).toBeNull();
  });

  test('cleanupExpired removes only rows past absolute cap', () => {
    const uid = seedUser(db);
    store.issue(uid);
    now += 31 * 24 * 60 * 60 * 1000;
    store.issue(uid); // fresh session
    const removed = store.cleanupExpired();
    expect(removed).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c).toBe(1);
  });
});
