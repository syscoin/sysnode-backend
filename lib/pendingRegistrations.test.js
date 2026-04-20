const { openDatabase } = require('./db');
const {
  createPendingRegistrationsRepo,
} = require('./pendingRegistrations');
const { _resetPepperForTests, hashAuthHash } = require('./kdf');

const AUTH =
  'a4f8b3c1d9e7f2a5b1c6d8e4f7a9b2c5d1e8f4a7b3c9d5e1f6a2b8c4d7e3f5a9';
const AUTH_B =
  'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';

describe('pending registrations repo', () => {
  let db;
  let repo;
  let clock;

  beforeEach(() => {
    _resetPepperForTests();
    process.env.SYSNODE_AUTH_PEPPER = 'f'.repeat(64);
    process.env.NODE_ENV = 'test';
    clock = 1_700_000_000_000;
    db = openDatabase(':memory:');
    repo = createPendingRegistrationsRepo(db, { now: () => clock });
  });

  afterEach(() => db.close());

  test('issue returns a 64-char hex token and stores only its SHA-256', () => {
    const token = repo.issue({ email: 'a@b.com', authHash: AUTH });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // DB row does NOT contain the plaintext token.
    const stored = db
      .prepare('SELECT token_hash, stored_auth FROM pending_registrations')
      .get();
    expect(stored.token_hash).not.toBe(token);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // And stored_auth is HMAC(authHash, pepper), not the raw authHash.
    expect(stored.stored_auth).toBe(hashAuthHash(AUTH));
    expect(stored.stored_auth).not.toBe(AUTH);
  });

  test('redeem returns {email, storedAuth} then invalidates the token', () => {
    const token = repo.issue({ email: 'User@B.Com ', authHash: AUTH });
    const first = repo.redeem(token);
    expect(first).toEqual({
      email: 'user@b.com', // normalized
      storedAuth: hashAuthHash(AUTH),
    });
    // Single-use: second redeem is a miss.
    expect(repo.redeem(token)).toBeNull();
  });

  test('redeem rejects malformed tokens and unknown tokens', () => {
    expect(repo.redeem('')).toBeNull();
    expect(repo.redeem('not-hex')).toBeNull();
    expect(repo.redeem('0'.repeat(64))).toBeNull(); // well-formed but not issued
  });

  test('expired rows are not redeemable and are reaped on access', () => {
    const token = repo.issue({ email: 'a@b.com', authHash: AUTH });
    clock += 31 * 60 * 1000; // past 30-min TTL
    expect(repo.redeem(token)).toBeNull();
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM pending_registrations')
      .get();
    expect(row.c).toBe(0);
  });

  test('multiple pending rows for the same email are independent', () => {
    // This is the core property that defeats the attacker-pre-register
    // scenario: attacker and victim both create pending rows for the same
    // email, and victim's redemption is unaffected by attacker's row.
    const attackerToken = repo.issue({
      email: 'victim@example.com',
      authHash: AUTH,
    });
    const victimToken = repo.issue({
      email: 'victim@example.com',
      authHash: AUTH_B,
    });
    expect(attackerToken).not.toBe(victimToken);

    const victimRedeem = repo.redeem(victimToken);
    expect(victimRedeem.storedAuth).toBe(hashAuthHash(AUTH_B));
    // Attacker's token is still live (until purgeForEmail wipes it).
    const attackerRedeem = repo.redeem(attackerToken);
    expect(attackerRedeem.storedAuth).toBe(hashAuthHash(AUTH));
  });

  test('purgeForEmail wipes every pending row for that email', () => {
    repo.issue({ email: 'victim@example.com', authHash: AUTH });
    repo.issue({ email: 'victim@example.com', authHash: AUTH_B });
    repo.issue({ email: 'other@example.com', authHash: AUTH });
    expect(repo.purgeForEmail('VICTIM@example.com')).toBe(2); // normalized
    const remaining = db
      .prepare('SELECT email_normalized FROM pending_registrations')
      .all();
    expect(remaining).toEqual([{ email_normalized: 'other@example.com' }]);
  });

  test('cleanupExpired removes only expired rows', () => {
    repo.issue({ email: 'fresh@x.com', authHash: AUTH });
    clock += 31 * 60 * 1000;
    repo.issue({ email: 'stillfresh@x.com', authHash: AUTH });
    const removed = repo.cleanupExpired();
    expect(removed).toBe(1);
    const emails = db
      .prepare('SELECT email_normalized FROM pending_registrations')
      .all();
    expect(emails).toEqual([{ email_normalized: 'stillfresh@x.com' }]);
  });

  test('rejects invalid email syntax at issue time', () => {
    expect(() =>
      repo.issue({ email: 'not-an-email', authHash: AUTH })
    ).toThrow(/invalid_email/);
  });
});
