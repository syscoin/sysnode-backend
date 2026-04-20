const { openDatabase } = require('./db');
const { createUsersRepo } = require('./users');
const { hashAuthHash, _resetPepperForTests } = require('./kdf');

const SAMPLE_HASH =
  'a4f8b3c1d9e7f2a5b1c6d8e4f7a9b2c5d1e8f4a7b3c9d5e1f6a2b8c4d7e3f5a9';

describe('users repo', () => {
  let db;
  let users;
  let now;

  beforeEach(() => {
    _resetPepperForTests();
    process.env.SYSNODE_AUTH_PEPPER = 'c'.repeat(64);
    process.env.NODE_ENV = 'test';
    db = openDatabase(':memory:');
    now = 1_700_000_000_000;
    users = createUsersRepo(db, { now: () => now });
  });

  afterEach(() => db.close());

  test('create normalizes email and stores hashed authHash', () => {
    const u = users.create({ email: '  User@Example.COM  ', authHash: SAMPLE_HASH });
    expect(u.email).toBe('user@example.com');
    expect(u.id).toBeDefined();
    expect(u.emailVerified).toBe(false);

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    expect(row.stored_auth).toBe(hashAuthHash(SAMPLE_HASH));
  });

  test('create rejects duplicate email', () => {
    users.create({ email: 'a@b.com', authHash: SAMPLE_HASH });
    expect(() => users.create({ email: 'a@b.com', authHash: SAMPLE_HASH })).toThrow(
      /email_taken/
    );
  });

  test('create rejects malformed email', () => {
    expect(() => users.create({ email: 'nope', authHash: SAMPLE_HASH })).toThrow(
      /invalid_email/
    );
  });

  test('findByEmail returns user including camelCase fields', () => {
    users.create({ email: 'a@b.com', authHash: SAMPLE_HASH });
    const u = users.findByEmail('A@B.com');
    expect(u).not.toBeNull();
    expect(u.email).toBe('a@b.com');
    expect(u.emailVerified).toBe(false);
    expect(u.notificationPrefs).toEqual({});
  });

  test('findById matches findByEmail', () => {
    const u1 = users.create({ email: 'a@b.com', authHash: SAMPLE_HASH });
    const u2 = users.findById(u1.id);
    expect(u2.email).toBe('a@b.com');
  });

  test('verifyAuth returns user only on correct authHash', () => {
    users.create({ email: 'a@b.com', authHash: SAMPLE_HASH });
    expect(users.verifyAuth('a@b.com', SAMPLE_HASH)).not.toBeNull();
    expect(users.verifyAuth('a@b.com', 'deadbeef'.repeat(8))).toBeNull();
    expect(users.verifyAuth('nope@b.com', SAMPLE_HASH)).toBeNull();
  });

  test('markEmailVerified flips the flag', () => {
    const u = users.create({ email: 'a@b.com', authHash: SAMPLE_HASH });
    users.markEmailVerified(u.id);
    expect(users.findById(u.id).emailVerified).toBe(true);
  });

  test('updateAuthHash replaces stored_auth', () => {
    const u = users.create({ email: 'a@b.com', authHash: SAMPLE_HASH });
    const NEW_HASH =
      'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';
    users.updateAuthHash(u.id, NEW_HASH);
    expect(users.verifyAuth('a@b.com', SAMPLE_HASH)).toBeNull();
    expect(users.verifyAuth('a@b.com', NEW_HASH)).not.toBeNull();
  });

  test('notification prefs read/update round-trip', () => {
    const u = users.create({ email: 'a@b.com', authHash: SAMPLE_HASH });
    users.updateNotificationPrefs(u.id, { voteReminders: true });
    expect(users.findById(u.id).notificationPrefs).toEqual({
      voteReminders: true,
    });
  });
});
