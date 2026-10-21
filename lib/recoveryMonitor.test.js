const { openDatabase } = require('./db');
const { createRecoveryRepository } = require('./recoveryRepository');
const { createRecoveryMonitor } = require('./recoveryMonitor');
const { createMailer } = require('./mailer');
const { ZERO_HASH } = require('./recoveryRpc');
const ACCOUNT = '0x' + '11'.repeat(20),
  OP = '0x' + '22'.repeat(32),
  TX = '0x' + '33'.repeat(32);
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
function fixture(delay = 259200) {
  let now = 1800000000000;
  const db = openDatabase(':memory:');
  db.prepare(
    'INSERT INTO users(id,email,stored_auth,salt_v,email_verified,created_at,updated_at) VALUES (1,?,?,?,?,?,?)'
  ).run('owner@example.com', 'hash', 'a'.repeat(64), 1, now, now);
  const repo = createRecoveryRepository(db, { now: () => now });
  let state = {
    block: { number: 10, hash: hash(10), timestamp: now / 1000 },
    installed: true,
    delay,
    expiration: 604800,
    epoch: '1',
    activeOperationId: ZERO_HASH,
    schedules: {},
  };
  const logs = [];
  const rpc = {
    head: jest.fn(async () => state.block),
    getBlock: jest.fn(async (number) => ({
      ...state.block,
      number,
      hash: hash(number),
    })),
    assertBlock: jest.fn(async () => {}),
    logs: jest.fn(async (_account, from, to) =>
      logs.filter((r) => r.blockNumber >= from && r.blockNumber <= to)
    ),
    snapshot: jest.fn(async () => structuredClone(state)),
  };
  const chain = {
    chainId: 57057,
    name: 'zkTanenbaum',
    recoveryModule: ACCOUNT,
    explorerUrl: 'https://explorer-zk.tanenbaum.io',
    rpc,
  };
  const mailer = createMailer({
    transport: 'memory',
    publicBaseUrl: 'https://sysnode.info',
  });
  const monitor = createRecoveryMonitor({
    repository: repo,
    users: {
      findById: () => ({ email: 'owner@example.com', emailVerified: true }),
    },
    chains: [chain],
    mailer,
    now: () => now,
  });
  const sub = repo.subscribe(1, 57057, ACCOUNT, 'Test', state.block);
  const advance = (seconds = 1) => {
    now += seconds * 1000;
    state.block = {
      number: state.block.number + 1,
      hash: hash(state.block.number + 1),
      timestamp: now / 1000,
    };
  };
  function schedule(op = OP) {
    const scheduledAt = state.block.timestamp;
    state.activeOperationId = op;
    state.schedules[op] = { scheduledAt, executed: false, canceled: false };
    logs.push({
      kind: 'RecoveryScheduled',
      operationId: op,
      executableAt: scheduledAt + delay,
      blockNumber: state.block.number,
      blockHash: state.block.hash,
      txHash: TX,
      index: 0,
    });
  }
  return {
    db,
    repo,
    monitor,
    mailer,
    rpc,
    sub,
    advance,
    schedule,
    state,
    logs,
    setNow: (value) => {
      now = value;
    },
  };
}

test.each([600, 259200, 604800])(
  'bootstrap existing pending recovery, persist exact %is deadline and dedup across restart/ticks',
  async (delay) => {
    const f = fixture(delay);
    f.schedule();
    f.monitor.bootstrap(f.sub, f.state);
    expect(f.repo.operation(f.sub.id, OP).executable_at).toBe(
      f.state.block.timestamp + delay
    );
    await f.monitor.tick();
    await f.monitor.tick();
    expect(f.mailer.outbox).toHaveLength(1);
    expect(f.mailer.outbox[0].subject).toContain('recovery detected');
    expect(f.repo.operation(f.sub.id, OP).tx_hash).toBe(TX);
    f.db.close();
  }
);
test('cancellation before delivery suppresses stale initiation and reminder', async () => {
  const f = fixture();
  f.schedule();
  f.monitor.bootstrap(f.sub, f.state);
  f.state.schedules[OP].canceled = true;
  f.state.activeOperationId = ZERO_HASH;
  await f.monitor.tick();
  expect(f.mailer.outbox).toHaveLength(1);
  expect(f.mailer.outbox[0].subject).toContain('canceled or invalidated');
  expect(f.repo.pendingOutbox()).toHaveLength(0);
  f.db.close();
});
test('same-block schedule and execution remains visible as completed attempt', async () => {
  const f = fixture();
  f.schedule();
  f.state.schedules[OP].executed = true;
  f.state.activeOperationId = ZERO_HASH;
  f.logs.push({
    kind: 'RecoveryExecuted',
    operationId: OP,
    blockNumber: 10,
    blockHash: hash(10),
    txHash: TX,
    index: 1,
  });
  await f.monitor.tick();
  expect(f.repo.operation(f.sub.id, OP).state).toBe('executed');
  expect(f.mailer.outbox).toHaveLength(1);
  expect(f.mailer.outbox[0].subject).toContain('executed');
  f.db.close();
});
test('an unseen expired-then-replaced attempt does not claim a policy change', async () => {
  const f = fixture(600);
  f.schedule();
  f.advance(605500);
  const next = '0x' + '55'.repeat(32);
  f.schedule(next);
  await f.monitor.tick();
  expect(f.repo.operation(f.sub.id, OP).state).toBe('invalidated');
  expect(
    f.mailer.outbox.some((mail) => mail.subject.includes('no longer pending'))
  ).toBe(true);
  expect(
    f.mailer.outbox.some((mail) => mail.subject.includes('policy changed'))
  ).toBe(false);
  f.db.close();
});
test('reminder fires once using chain time and not worker wall clock', async () => {
  const f = fixture();
  f.schedule();
  await f.monitor.tick();
  f.advance(259200 - 86400);
  await f.monitor.tick();
  expect(
    f.mailer.outbox.filter((m) => m.subject.includes('deadline approaching'))
  ).toHaveLength(1);
  f.advance();
  await f.monitor.tick();
  expect(f.mailer.outbox).toHaveLength(2);
  f.db.close();
});
test('expired recovery never sends an overdue reminder', async () => {
  const f = fixture(600);
  f.schedule();
  await f.monitor.tick();
  f.advance(600 + 604800);
  await f.monitor.tick();
  expect(f.mailer.outbox.some((m) => m.subject.includes('expired'))).toBe(true);
  expect(
    f.mailer.outbox.some((m) => m.subject.includes('deadline approaching'))
  ).toBe(false);
  f.db.close();
});
test('policy uninstall/reinstall silently cancels storage and cannot resurrect reminder', async () => {
  const f = fixture(600);
  f.schedule();
  await f.monitor.tick();
  f.advance(400);
  f.state.epoch = '3';
  f.state.schedules[OP].canceled = true;
  f.state.activeOperationId = ZERO_HASH;
  await f.monitor.tick();
  expect(f.repo.operation(f.sub.id, OP).state).toBe('canceled');
  expect(
    f.mailer.outbox.some((m) => m.subject.includes('deadline approaching'))
  ).toBe(false);
  f.db.close();
});
test('reorg replays from enrollment anchor and labels vanished observation honestly', async () => {
  const f = fixture();
  f.schedule();
  await f.monitor.tick();
  f.advance(10);
  f.rpc.getBlock.mockImplementation(async (n) => ({
    ...f.state.block,
    number: n,
    hash: n === 10 ? hash(999) : hash(n),
  }));
  f.state.activeOperationId = ZERO_HASH;
  f.state.schedules = {};
  f.logs.splice(0);
  await f.monitor.tick();
  expect(f.rpc.logs).toHaveBeenLastCalledWith(ACCOUNT, 10, 11);
  expect(f.repo.operation(f.sub.id, OP).state).toBe('orphaned');
  expect(
    f.mailer.outbox.some((m) => m.subject.includes('chain reorganization'))
  ).toBe(true);
  expect(
    f.mailer.outbox.some((m) =>
      m.subject.includes('no longer on the current chain')
    )
  ).toBe(true);
  f.db.close();
});
test('RPC error marks degraded, preserves history, and retries without sending stale reminder', async () => {
  const f = fixture();
  f.schedule();
  await f.monitor.tick();
  f.advance(259200 - 86400);
  f.rpc.head.mockRejectedValue(new Error('outage'));
  await f.monitor.tick();
  expect(f.repo.getSubscription(f.sub.id).status).toBe('degraded');
  expect(f.repo.operation(f.sub.id, OP)).toBeDefined();
  expect(f.mailer.outbox).toHaveLength(1);
  f.db.close();
});
test('SMTP errors retain durable mail with backoff and no duplicate on subsequent success', async () => {
  const f = fixture();
  f.schedule();
  const actual = f.mailer.sendRecoveryAlert;
  f.mailer.sendRecoveryAlert = jest
    .fn()
    .mockRejectedValue(new Error('smtp_down'));
  await f.monitor.tick();
  expect(f.repo.pendingOutbox()).toHaveLength(0);
  expect(
    f.db.prepare('SELECT state,attempts FROM recovery_outbox').get()
  ).toMatchObject({ state: 'pending', attempts: 1 });
  f.advance(16);
  f.mailer.sendRecoveryAlert = actual;
  await f.monitor.tick();
  await f.monitor.tick();
  expect(f.mailer.outbox).toHaveLength(1);
  f.db.close();
});
test('disable/re-enable while observation is in flight fences old generation', async () => {
  const f = fixture();
  f.schedule();
  let release;
  f.rpc.logs.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const tick = f.monitor.tick();
  while (!release) await Promise.resolve();
  f.repo.disable(f.sub.id);
  f.repo.subscribe(1, 57057, ACCOUNT, 'New', f.state.block);
  release(f.logs);
  await tick;
  expect(f.repo.operations(f.sub.id)).toEqual([]);
  expect(f.mailer.outbox).toEqual([]);
  f.db.close();
});
test('concurrent ticks cannot duplicate delivery', async () => {
  const f = fixture();
  f.schedule();
  await Promise.all([f.monitor.tick(), f.monitor.tick(), f.monitor.tick()]);
  expect(f.mailer.outbox).toHaveLength(1);
  f.db.close();
});
test('current pending operation remains visible ahead of newer-timestamp orphaned history', () => {
  const f = fixture();
  f.schedule();
  f.monitor.bootstrap(f.sub, f.state);
  for (let i = 0; i < 30; i++)
    f.repo.putOperation(f.sub.id, {
      operationId: hash(i + 1000),
      scheduledAt: f.state.block.timestamp + 1000 + i,
      executableAt: f.state.block.timestamp + 2000 + i,
      expiresAt: 0,
      state: 'orphaned',
      txHash: null,
      blockNumber: 1000 + i,
      blockHash: hash(1000 + i),
    });
  expect(f.repo.operations(f.sub.id)[0].operation_id).toBe(OP);
  f.db.close();
});
