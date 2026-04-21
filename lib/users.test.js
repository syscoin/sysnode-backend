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

  test('create issues a fresh per-user saltV and surfaces it on reads', () => {
    const u = users.create({ email: 'salt@example.com', authHash: SAMPLE_HASH });
    // 32 bytes of randomness serialized as 64 lowercase hex chars.
    expect(u.saltV).toMatch(/^[0-9a-f]{64}$/);

    // findByEmail / findById must surface the same saltV (wire-stable
    // identity for the vault key derivation).
    expect(users.findByEmail('salt@example.com').saltV).toBe(u.saltV);
    expect(users.findById(u.id).saltV).toBe(u.saltV);
  });

  test('create yields a unique saltV per user', () => {
    const a = users.create({ email: 'a@x.com', authHash: SAMPLE_HASH });
    const b = users.create({ email: 'b@x.com', authHash: SAMPLE_HASH });
    expect(a.saltV).not.toBe(b.saltV);
  });

  test('saltV stays stable across authHash rotations (change-password)', () => {
    const u = users.create({ email: 'stable@x.com', authHash: SAMPLE_HASH });
    const before = u.saltV;
    const NEW_HASH =
      'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';
    users.updateAuthHash(u.id, NEW_HASH);
    // Rotating auth must NOT rotate saltV — otherwise every
    // change-password would orphan every previously-encrypted vault
    // blob. This invariant is load-bearing for the SYSV2 re-wrap
    // flow.
    expect(users.findById(u.id).saltV).toBe(before);
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

  describe('deleteById', () => {
    // The route (DELETE /auth/account) is the gatekeeper that enforces
    // re-proof-of-password before calling this. At the repo layer the
    // contract is narrower: "hard-delete the row and rely on the FK
    // cascades declared in 001_init.sql to wipe every dependent row".
    // These tests pin that cascade behavior so a future FK change
    // (e.g. loosening ON DELETE) is caught here instead of downstream.
    test('removes the users row and returns 1', () => {
      const u = users.create({ email: 'del@x.com', authHash: SAMPLE_HASH });
      expect(users.deleteById(u.id)).toBe(1);
      expect(users.findById(u.id)).toBeNull();
      expect(users.findByEmail('del@x.com')).toBeNull();
    });

    test('returns 0 when the id is not present (idempotent)', () => {
      expect(users.deleteById(999_999)).toBe(0);
    });

    test('cascades to sessions, vaults, and vote_reminder_log', () => {
      // Build enough state across dependent tables that a missing FK
      // cascade would leave observable orphans.
      const u = users.create({ email: 'casc@x.com', authHash: SAMPLE_HASH });
      users.markEmailVerified(u.id);

      db.prepare(
        `INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen)
         VALUES (?, ?, ?, ?, ?)`
      ).run(u.id, 'abc', now, now + 1000, now);
      db.prepare(
        `INSERT INTO vaults (user_id, blob, etag, updated_at)
         VALUES (?, ?, ?, ?)`
      ).run(u.id, 'blob', 'etag', now);
      db.prepare(
        `INSERT INTO vote_reminder_log (user_id, scope_key, bucket, sent_at)
         VALUES (?, ?, ?, ?)`
      ).run(u.id, 'cycle:1', 'days_before', now);

      expect(users.deleteById(u.id)).toBe(1);

      expect(
        db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(u.id).c
      ).toBe(0);
      expect(
        db.prepare('SELECT COUNT(*) AS c FROM vaults WHERE user_id = ?').get(u.id).c
      ).toBe(0);
      expect(
        db
          .prepare('SELECT COUNT(*) AS c FROM vote_reminder_log WHERE user_id = ?')
          .get(u.id).c
      ).toBe(0);
    });

    test('does NOT touch other users\' rows', () => {
      const a = users.create({ email: 'a@x.com', authHash: SAMPLE_HASH });
      const b = users.create({ email: 'b@x.com', authHash: SAMPLE_HASH });
      users.deleteById(a.id);
      expect(users.findById(a.id)).toBeNull();
      expect(users.findById(b.id)).not.toBeNull();
    });
  });

  describe('listWithRemindersEnabled', () => {
    // Helper: the list is what the reminder dispatcher iterates over.
    // The contract is "verified users who have not explicitly opted
    // out". Everything else in this describe-block verifies the four
    // boundary shapes that contract has to handle.
    function mkVerified(email, prefs) {
      const u = users.create({ email, authHash: SAMPLE_HASH });
      users.markEmailVerified(u.id);
      if (prefs !== undefined) {
        users.updateNotificationPrefs(u.id, prefs);
      }
      return u;
    }

    test('default (no prefs) is opt-in — user is returned', () => {
      const u = mkVerified('default@x.com');
      const list = users.listWithRemindersEnabled();
      expect(list.map((r) => r.id)).toContain(u.id);
    });

    test('voteReminders absent on a prefs document is still opt-in', () => {
      const u = mkVerified('absent@x.com', { otherNamespace: { foo: 1 } });
      const list = users.listWithRemindersEnabled();
      expect(list.map((r) => r.id)).toContain(u.id);
    });

    test('voteReminders.enabled === true is opt-in', () => {
      const u = mkVerified('explicit-on@x.com', {
        voteReminders: { enabled: true },
      });
      const list = users.listWithRemindersEnabled();
      expect(list.map((r) => r.id)).toContain(u.id);
    });

    test('voteReminders.enabled === false is the ONLY opt-out signal', () => {
      const u = mkVerified('opted-out@x.com', {
        voteReminders: { enabled: false },
      });
      const list = users.listWithRemindersEnabled();
      expect(list.map((r) => r.id)).not.toContain(u.id);
    });

    test('unverified users are excluded even if their prefs are default', () => {
      // Verified-but-default vs. unverified-but-default must not both
      // come back. The dispatcher should never email an unverified
      // address — that's the email that hasn't proven ownership yet.
      const unverified = users.create({
        email: 'unverified@x.com',
        authHash: SAMPLE_HASH,
      });
      const verified = mkVerified('verified@x.com');
      const ids = users.listWithRemindersEnabled().map((r) => r.id);
      expect(ids).toContain(verified.id);
      expect(ids).not.toContain(unverified.id);
    });
  });

  describe('promoteUnverifiedWithStoredAuth', () => {
    test('rotates stored_auth + flips email_verified on an unverified row', () => {
      const u = users.create({ email: 'a@b.com', authHash: SAMPLE_HASH });
      expect(u.emailVerified).toBe(false);
      const NEW_STORED = hashAuthHash(
        'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4'
      );

      const ok = users.promoteUnverifiedWithStoredAuth({
        id: u.id,
        storedAuth: NEW_STORED,
      });

      expect(ok).toBe(true);
      const after = users.findById(u.id);
      expect(after.emailVerified).toBe(true);
      // Promotion must NOT rotate saltV — the saltV was assigned at
      // row creation and any pre-verification encrypted-blob attempt
      // (there shouldn't be one in the deferred-binding flow, but
      // defense-in-depth) would be orphaned if we rolled it.
      expect(after.saltV).toBe(u.saltV);
      const row = db.prepare('SELECT stored_auth FROM users WHERE id = ?').get(u.id);
      expect(row.stored_auth).toBe(NEW_STORED);
    });

    test('refuses to touch an already-verified row', () => {
      const u = users.create({ email: 'a@b.com', authHash: SAMPLE_HASH });
      users.markEmailVerified(u.id);
      const originalRow = db
        .prepare('SELECT stored_auth FROM users WHERE id = ?')
        .get(u.id);
      const ATTACKER = hashAuthHash('deadbeef'.repeat(8));

      const ok = users.promoteUnverifiedWithStoredAuth({
        id: u.id,
        storedAuth: ATTACKER,
      });

      expect(ok).toBe(false);
      const row = db
        .prepare('SELECT stored_auth, email_verified FROM users WHERE id = ?')
        .get(u.id);
      expect(row.stored_auth).toBe(originalRow.stored_auth);
      expect(row.email_verified).toBe(1);
    });

    test('returns false for a non-existent id', () => {
      const ok = users.promoteUnverifiedWithStoredAuth({
        id: 999_999,
        storedAuth: hashAuthHash(SAMPLE_HASH),
      });
      expect(ok).toBe(false);
    });
  });
});
