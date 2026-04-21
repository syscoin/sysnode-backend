const { openDatabase } = require('./db');
const { createReminderLog } = require('./reminderLog');

const FAKE_SALT_V = 'a'.repeat(64);

function mkUser(db, email = 'u@example.com') {
  const r = db
    .prepare(
      `INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, 'hash', FAKE_SALT_V, Date.now(), Date.now());
  return r.lastInsertRowid;
}

describe('reminderLog', () => {
  let db;
  let log;

  beforeEach(() => {
    db = openDatabase(':memory:');
    log = createReminderLog(db, { now: () => 1_700_000_000_000 });
  });

  afterEach(() => db.close());

  test('has() is false before any insert', () => {
    const uid = mkUser(db);
    expect(log.has(uid, 'cycle:1700000000', 'days_before')).toBe(false);
  });

  test('insert() + has() round-trip on the same key', () => {
    const uid = mkUser(db);
    const out = log.insert(uid, 'cycle:1700000000', 'days_before', 1);
    expect(out).toEqual({ inserted: true, sentAt: 1 });
    expect(log.has(uid, 'cycle:1700000000', 'days_before')).toBe(true);
    // But NOT the other bucket — they're independent.
    expect(log.has(uid, 'cycle:1700000000', 'final_24h')).toBe(false);
  });

  test('duplicate insert on same (user, scope_key, bucket) returns inserted=false', () => {
    // The UNIQUE constraint is the cross-tick idempotency guarantee;
    // the wrapper translates that collision into a soft result so the
    // dispatcher can treat the operation as "already sent" without a
    // try/catch boilerplate.
    const uid = mkUser(db);
    const first = log.insert(uid, 'cycle:1700000000', 'days_before');
    expect(first.inserted).toBe(true);
    const second = log.insert(uid, 'cycle:1700000000', 'days_before');
    expect(second).toEqual({ inserted: false, sentAt: null });
  });

  test('different buckets on same scope_key coexist', () => {
    const uid = mkUser(db);
    expect(log.insert(uid, 'cycle:1700000000', 'days_before').inserted).toBe(
      true
    );
    // Same cycle, escalating to the urgent bucket — this is the
    // intended flow when a user hasn't voted and is now inside 24h.
    expect(log.insert(uid, 'cycle:1700000000', 'final_24h').inserted).toBe(
      true
    );
    expect(log.has(uid, 'cycle:1700000000', 'days_before')).toBe(true);
    expect(log.has(uid, 'cycle:1700000000', 'final_24h')).toBe(true);
  });

  test('different users are isolated', () => {
    const u1 = mkUser(db, 'a@x.com');
    const u2 = mkUser(db, 'b@x.com');
    log.insert(u1, 'cycle:1', 'days_before');
    expect(log.has(u1, 'cycle:1', 'days_before')).toBe(true);
    expect(log.has(u2, 'cycle:1', 'days_before')).toBe(false);
  });

  test('insert defaults sentAt to now() when caller omits it', () => {
    const uid = mkUser(db);
    const out = log.insert(uid, 'cycle:x', 'days_before');
    expect(out.sentAt).toBe(1_700_000_000_000);
  });

  test('validates inputs', () => {
    expect(() => log.has(0, 'k', 'b')).toThrow();
    expect(() => log.has(1, '', 'b')).toThrow();
    expect(() => log.has(1, 'k', '')).toThrow();
    expect(() => log.insert(-1, 'k', 'b')).toThrow();
  });
});
