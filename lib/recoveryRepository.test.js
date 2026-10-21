const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { migrate } = require('./db');
const { createRecoveryRepository } = require('./recoveryRepository');

test('new migration preserves an existing verified account and cascades alert data only on explicit user deletion', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(
    fs.readFileSync(
      path.join(__dirname, '../db/migrations/001_init.sql'),
      'utf8'
    )
  );
  db.exec(
    'CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)'
  );
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(
    '001_init.sql',
    1
  );
  db.prepare(
    'INSERT INTO users(id,email,stored_auth,salt_v,email_verified,created_at,updated_at) VALUES (1,?,?,?,?,?,?)'
  ).run('existing@example.com', 'original-hash', 'aa', 1, 1, 1);
  migrate(db);
  expect(
    db.prepare('SELECT stored_auth,email_verified FROM users WHERE id=1').get()
  ).toEqual({ stored_auth: 'original-hash', email_verified: 1 });
  const repo = createRecoveryRepository(db, { now: () => 1000 });
  const sub = repo.subscribe(
    1,
    57057,
    '0x' + '11'.repeat(20),
    'Existing account',
    { number: 100 },
    '0x' + '22'.repeat(20)
  );
  repo.queue(sub.id, 'test', 'enabled', null);
  expect(repo.pendingOutbox()).toHaveLength(1);
  db.prepare('DELETE FROM users WHERE id=1').run();
  expect(repo.pendingOutbox()).toEqual([]);
  expect(repo.getSubscription(sub.id)).toBeUndefined();
  db.close();
});

test.each(['reminder', 'scheduled'])(
  'only unsent same-generation %s notices can be rearmed, preserving delivery backoff',
  (kind) => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(db);
    db.prepare(
      'INSERT INTO users(id,email,stored_auth,salt_v,email_verified,created_at,updated_at) VALUES (1,?,?,?,?,?,?)'
    ).run('owner@example.test', 'hash', 'a'.repeat(64), 1, 1, 1);
    let now = 1000;
    const repo = createRecoveryRepository(db, { now: () => now });
    const account = '0x' + '11'.repeat(20),
      op = '0x' + '22'.repeat(32);
    const sub = repo.subscribe(
      1,
      57057,
      account,
      'Test',
      { number: 1 },
      account
    );
    const enqueue =
      kind === 'reminder' ? repo.queueReminder : repo.queueInitiation;
    enqueue(sub.id, op);
    const original = repo.pendingOutbox()[0];
    repo.retry(original.id, 2);
    const retryAt = db
      .prepare('SELECT next_attempt_at FROM recovery_outbox WHERE id=?')
      .get(original.id).next_attempt_at;
    repo.supersede(original.id);
    enqueue(sub.id, op);
    expect(
      db
        .prepare(
          'SELECT state,attempts,next_attempt_at FROM recovery_outbox WHERE id=?'
        )
        .get(original.id)
    ).toEqual({
      state: 'pending',
      attempts: 1,
      next_attempt_at: retryAt,
    });
    expect(repo.pendingOutbox()).toEqual([]);
    now = retryAt;
    repo.sent(original.id);
    enqueue(sub.id, op);
    expect(
      db
        .prepare('SELECT COUNT(*) n FROM recovery_outbox WHERE kind=?')
        .get(kind).n
    ).toBe(1);
    expect(repo.pendingOutbox()).toEqual([]);
    repo.queue(sub.id, 'other-notice', 'scheduled', op);
    const other = repo.pendingOutbox()[0];
    repo.supersede(other.id);
    repo.queue(sub.id, 'other-notice', 'scheduled', op);
    expect(repo.pendingOutbox()).toEqual([]);
    repo.disable(sub.id);
    enqueue(sub.id, '0x' + '33'.repeat(32));
    expect(repo.pendingOutbox()).toEqual([]);
    const reenrolled = repo.subscribe(
      1,
      57057,
      account,
      'New enrollment',
      { number: 2 },
      account
    );
    enqueue(reenrolled.id, op);
    expect(repo.pendingOutbox()).toHaveLength(1);
    expect(repo.pendingOutbox()[0].generation).toBe(2);
    const originalNewGeneration = repo.pendingOutbox()[0];
    repo.supersede(originalNewGeneration.id);
    repo.queue(reenrolled.id, 'resumed-on-new-fork', kind, op);
    const resumed = repo.pendingOutbox()[0];
    enqueue(reenrolled.id, op);
    expect(repo.pendingOutbox().map((row) => row.id)).toEqual([resumed.id]);
    expect(
      db
        .prepare('SELECT state FROM recovery_outbox WHERE id=?')
        .get(originalNewGeneration.id).state
    ).toBe('superseded');
    db.close();
  }
);
