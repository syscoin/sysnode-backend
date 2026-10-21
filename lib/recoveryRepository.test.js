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

test('terminal retry selection is bounded and preserves backoff, latest result and enrollment scope', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrate(db);
  db.prepare(
    'INSERT INTO users(id,email,stored_auth,salt_v,email_verified,created_at,updated_at) VALUES (1,?,?,?,?,?,?)'
  ).run('owner@example.test', 'hash', 'a'.repeat(64), 1, 1, 1);
  let now = 1000;
  const repo = createRecoveryRepository(db, { now: () => now });
  const account = '0x' + '11'.repeat(20);
  const sub = repo.subscribe(1, 57057, account, 'Test', { number: 1 }, account);
  const ops = [];
  try {
    for (let i = 1; i <= 21; i++) {
      const op = '0x' + i.toString(16).padStart(64, '0');
      ops.push(op);
      repo.putOperation(sub.id, {
        operationId: op,
        scheduledAt: 1,
        executableAt: 601,
        expiresAt: 1201,
        state: 'canceled',
        blockNumber: 1,
        blockHash: '0x' + 'aa'.repeat(32),
      });
      repo.queue(sub.id, `cancel:${op}`, 'canceled', op);
      const notice = repo
        .pendingOutbox()
        .find((row) => row.operation_id === op);
      if (i === 1) repo.retry(notice.id, 2);
      repo.supersede(notice.id);
    }
    expect(repo.unnotifiedTerminalIds(sub.id)).toHaveLength(20);
    repo.rearmTerminal(sub.id, ops[0]);
    const restored = db
      .prepare(
        'SELECT state,attempts,next_attempt_at FROM recovery_outbox WHERE operation_id=?'
      )
      .get(ops[0]);
    expect(restored).toEqual({
      state: 'pending',
      attempts: 1,
      next_attempt_at: 61000,
    });
    expect(repo.pendingOutbox()).toEqual([]);

    // A newer acknowledged outcome makes an older unsent notice obsolete.
    repo.queue(sub.id, 'newer-result', 'executed', ops[1]);
    const newer = repo.pendingOutbox()[0];
    repo.sent(newer.id);
    expect(repo.unnotifiedTerminalIds(sub.id)).not.toContain(ops[1]);

    // A superseded notice is eligible only for the currently stored result.
    repo.setState(sub.id, ops[2], 'executed');
    expect(repo.unnotifiedTerminalIds(sub.id)).not.toContain(ops[2]);
    repo.disable(sub.id);
    expect(repo.unnotifiedTerminalIds(sub.id)).toEqual([]);
    now += 1;
    const next = repo.subscribe(
      1,
      57057,
      account,
      'Again',
      { number: 2 },
      account
    );
    repo.putOperation(next.id, {
      operationId: ops[3],
      scheduledAt: 1,
      executableAt: 601,
      expiresAt: 1201,
      state: 'canceled',
      blockNumber: 1,
      blockHash: '0x' + 'aa'.repeat(32),
    });
    expect(repo.unnotifiedTerminalIds(next.id)).toEqual([]);
  } finally {
    db.close();
  }
});

test('observed transition identities persist, isolate enrollments and roll back with their state', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrate(db);
  db.prepare(
    'INSERT INTO users(id,email,stored_auth,salt_v,email_verified,created_at,updated_at) VALUES (1,?,?,?,?,?,?)'
  ).run('owner@example.test', 'hash', 'a'.repeat(64), 1, 1, 1);
  const options = { now: () => 1000 };
  let repo = createRecoveryRepository(db, options);
  const account = '0x' + '11'.repeat(20),
    op = '0x' + '22'.repeat(32);
  const sub = repo.subscribe(1, 57057, account, 'Test', { number: 1 }, account);
  const row = {
    operationId: op,
    scheduledAt: 1,
    executableAt: 601,
    expiresAt: 1201,
    state: 'pending',
    blockNumber: 1,
    blockHash: '0x' + 'aa'.repeat(32),
  };
  try {
    repo.putOperation(sub.id, row);
    expect(() =>
      repo.atomic(() => {
        repo.setState(sub.id, op, 'canceled');
        repo.queueTransition(sub.id, op, 'canceled');
        throw new Error('transaction_aborted');
      })
    ).toThrow('transaction_aborted');
    expect(repo.operation(sub.id, op).state).toBe('pending');
    expect(repo.pendingOutbox()).toEqual([]);

    repo.atomic(() => {
      repo.setState(sub.id, op, 'canceled');
      repo.queueTransition(sub.id, op, 'canceled');
    });
    const first = repo.pendingOutbox()[0];
    expect(first.event_key).toContain(':transition:0:canceled:g1');
    repo.sent(first.id);
    // Recreating the repository models a worker restart, not an in-memory ID.
    repo = createRecoveryRepository(db, options);
    repo.atomic(() => {
      repo.setState(sub.id, op, 'pending');
      repo.queueTransition(sub.id, op, 'scheduled');
    });
    const resumed = repo.pendingOutbox()[0];
    expect(resumed.event_key).toContain(`:transition:${first.id}:scheduled:g1`);
    repo.sent(resumed.id);
    repo.atomic(() => {
      repo.setState(sub.id, op, 'canceled');
      repo.queueTransition(sub.id, op, 'canceled');
    });
    expect(repo.pendingOutbox()[0].event_key).toContain(
      `:transition:${resumed.id}:canceled:g1`
    );

    expect(repo.markReconcileNeeded(sub.id, sub.generation)).toBe(true);
    expect(repo.getSubscription(sub.id).reconcile_needed).toBe(1);
    repo.disable(sub.id);
    repo.degraded(sub.id, sub.generation);
    expect(repo.getSubscription(sub.id).status).toBe('disabled');
    expect(repo.markReconcileNeeded(sub.id, sub.generation)).toBe(false);
    repo.queueTransition(sub.id, op, 'executed');
    expect(repo.pendingOutbox()).toEqual([]);
    const reenrolled = repo.subscribe(
      1,
      57057,
      account,
      'Again',
      { number: 2 },
      account
    );
    expect(reenrolled.reconcile_needed).toBe(0);
    repo.degraded(sub.id, sub.generation);
    expect(repo.getSubscription(sub.id).status).toBe('catching_up');
    expect(repo.markReconcileNeeded(sub.id, sub.generation)).toBe(false);
    expect(repo.getSubscription(sub.id).reconcile_needed).toBe(0);
    repo.putOperation(reenrolled.id, row);
    repo.queueTransition(reenrolled.id, op, 'canceled');
    expect(repo.pendingOutbox()[0].event_key).toContain(
      ':transition:0:canceled:g2'
    );
  } finally {
    db.close();
  }
});
