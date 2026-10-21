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
    snapshot: jest.fn(async (_account, ids = []) => {
      const result = structuredClone(state);
      const requested = new Set([...ids, state.activeOperationId]);
      result.schedules = Object.fromEntries(
        Object.entries(result.schedules).filter(([id]) => requested.has(id))
      );
      return result;
    }),
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
  const newMonitor = () =>
    createRecoveryMonitor({
      repository: repo,
      users: {
        findById: () => ({ email: 'owner@example.com', emailVerified: true }),
      },
      chains: [chain],
      mailer,
      now: () => now,
    });
  const monitor = newMonitor();
  const sub = repo.subscribe(1, 57057, ACCOUNT, 'Test', state.block, ACCOUNT);
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
    chain,
    newMonitor,
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
test('initiation superseded only during delivery is rearmed after the recovery returns', async () => {
  const f = fixture(600);
  try {
    f.schedule();
    f.monitor.bootstrap(f.sub, f.state);
    // Delivery sees a losing branch, but the polling pass has not stored it.
    f.state.schedules[OP].canceled = true;
    f.state.activeOperationId = ZERO_HASH;
    await f.monitor.deliver();
    expect(f.repo.operation(f.sub.id, OP).state).toBe('pending');
    expect(f.mailer.outbox).toEqual([]);

    // The canonical branch again contains the pending attempt before polling.
    f.state.schedules[OP].canceled = false;
    f.state.activeOperationId = OP;
    f.advance(301);
    await f.monitor.tick();
    expect(
      f.mailer.outbox.filter((mail) =>
        mail.subject.includes('recovery detected')
      )
    ).toHaveLength(1);
    await f.monitor.tick();
    expect(
      f.mailer.outbox.filter((mail) =>
        mail.subject.includes('deadline approaching')
      )
    ).toHaveLength(1);
  } finally {
    f.db.close();
  }
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
test('an attempt first observed after an outage expires still sends one terminal notice', async () => {
  const f = fixture(600);
  await f.monitor.tick();
  f.advance();
  f.schedule();
  f.rpc.head.mockRejectedValueOnce(new Error('outage'));
  await f.monitor.tick();
  expect(f.repo.getSubscription(f.sub.id).status).toBe('degraded');
  expect(f.repo.operation(f.sub.id, OP)).toBeUndefined();

  f.advance(600 + 604800);
  await f.monitor.tick();
  await f.monitor.tick();
  expect(f.repo.operation(f.sub.id, OP)).toMatchObject({
    state: 'expired',
    tx_hash: TX,
  });
  expect(f.mailer.outbox).toHaveLength(1);
  expect(f.mailer.outbox[0].subject).toContain('expired');
  expect(
    f.db
      .prepare('SELECT kind,state FROM recovery_outbox WHERE operation_id=?')
      .all(OP)
  ).toEqual([{ kind: 'expired', state: 'sent' }]);
  f.db.close();
});
test('bootstrap marks an expired notice provisional and revalidates it before delivery', async () => {
  const f = fixture(600);
  f.schedule();
  f.advance(600 + 604800);
  f.monitor.bootstrap(f.sub, f.state);
  expect(f.repo.pendingOutbox()).toMatchObject([{ kind: 'expired' }]);
  expect(f.repo.getSubscription(f.sub.id).reconcile_needed).toBe(1);

  // A replacement chain can give the same operation a later schedule. The
  // queued terminal notice must not claim expiry based on its stale snapshot.
  const replacement = structuredClone(f.state);
  replacement.schedules[OP].scheduledAt = f.state.block.timestamp;
  await tickWithDeliverySnapshot(f, replacement);
  expect(f.mailer.outbox).toEqual([]);
  expect(
    f.db.prepare("SELECT state FROM recovery_outbox WHERE kind='expired'").get()
      .state
  ).toBe('superseded');
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
test.each([
  ['canceled', 'executed'],
  ['executed', 'canceled'],
])(
  'reorg correction reports terminal %s to %s changes once',
  async (previous, next) => {
    const f = fixture(600);
    try {
      f.schedule();
      await f.monitor.tick();
      f.advance();
      f.state.activeOperationId = ZERO_HASH;
      f.state.schedules[OP][previous] = true;
      await f.monitor.tick();
      expect(
        f.mailer.outbox.filter((mail) => mail.subject.includes(previous))
      ).toHaveLength(1);

      // The old terminal block is replaced; the same operation has a different
      // terminal result on the new canonical branch before the next poll.
      f.advance();
      f.rpc.getBlock.mockImplementation(async (number) => ({
        ...f.state.block,
        number,
        hash: number === 11 ? hash(999) : hash(number),
      }));
      f.state.schedules[OP][previous] = false;
      f.state.schedules[OP][next] = true;
      await f.monitor.tick();
      await f.monitor.tick();
      expect(f.repo.operation(f.sub.id, OP).state).toBe(next);
      expect(
        f.mailer.outbox.filter((mail) => mail.subject.includes(next))
      ).toHaveLength(1);
    } finally {
      f.db.close();
    }
  }
);
const TERMINAL_STATES = [
  'canceled',
  'executed',
  'expired',
  'invalidated',
  'orphaned',
];
function observeState(f, state, branch) {
  const scheduledAt = f.logs[0].executableAt - f.state.delay;
  f.state.block = {
    number: 10 + branch,
    hash: hash(100 + branch),
    timestamp:
      state === 'expired'
        ? scheduledAt + f.state.delay + f.state.expiration
        : scheduledAt + branch,
  };
  f.rpc.getBlock.mockImplementation(async (number) => ({
    ...f.state.block,
    number,
    hash:
      number === f.state.block.number
        ? f.state.block.hash
        : hash(1000 + number),
  }));
  f.state.activeOperationId =
    state === 'pending' || state === 'expired' ? OP : ZERO_HASH;
  f.state.schedules =
    state === 'orphaned'
      ? {}
      : {
          [OP]: {
            scheduledAt,
            canceled: state === 'canceled',
            executed: state === 'executed',
          },
        };
}
const sentKinds = (f) =>
  f.db
    .prepare(
      "SELECT kind FROM recovery_outbox WHERE operation_id=? AND state='sent' ORDER BY id"
    )
    .all(OP)
    .map((row) => row.kind);
async function tickWithDeliverySnapshot(f, deliverySnapshot) {
  let delivering = false;
  f.rpc.assertBlock.mockImplementationOnce(async () => {
    delivering = true;
  });
  f.rpc.snapshot.mockImplementation(async () =>
    structuredClone(delivering ? deliverySnapshot : f.state)
  );
  try {
    await f.monitor.tick();
  } finally {
    f.rpc.snapshot.mockImplementation(async () => structuredClone(f.state));
  }
}
test.each(TERMINAL_STATES)(
  'each observed %s -> pending -> same-terminal cycle notifies even when branch hashes repeat',
  async (terminal) => {
    const f = fixture(600);
    try {
      f.schedule();
      await f.monitor.tick();
      for (let cycle = 0; cycle < 2; cycle++) {
        observeState(f, terminal, 1);
        await f.monitor.tick();
        await f.monitor.tick();
        observeState(f, 'pending', 2);
        await f.monitor.tick();
        await f.monitor.tick();
      }
      observeState(f, terminal, 1);
      await f.monitor.tick();
      await f.monitor.tick();
      expect(sentKinds(f)).toEqual([
        'scheduled',
        terminal,
        'scheduled',
        terminal,
        'scheduled',
        terminal,
      ]);
    } finally {
      f.db.close();
    }
  }
);
test.each(
  TERMINAL_STATES.flatMap((previous) =>
    TERMINAL_STATES.filter((next) => next !== previous).map((next) => [
      previous,
      next,
    ])
  )
)(
  'each observed terminal %s -> %s -> original cycle notifies with reused exact branch hashes',
  async (previous, next) => {
    const f = fixture(600);
    try {
      f.schedule();
      await f.monitor.tick();
      for (const [state, branch] of [
        [previous, 1],
        [next, 2],
        [previous, 1],
        [next, 2],
        [previous, 1],
      ]) {
        observeState(f, state, branch);
        await f.monitor.tick();
        await f.monitor.tick();
      }
      expect(sentKinds(f)).toEqual([
        'scheduled',
        previous,
        next,
        previous,
        next,
        previous,
      ]);
    } finally {
      f.db.close();
    }
  }
);
test('repeated observed timing changes notify once per transition even when deadlines repeat', async () => {
  const f = fixture(600);
  try {
    f.schedule();
    await f.monitor.tick();
    const original = f.state.schedules[OP].scheduledAt;
    for (const offset of [20, 0, 20, 0]) {
      f.state.schedules[OP].scheduledAt = original + offset;
      await f.monitor.tick();
      await f.monitor.tick();
    }
    expect(sentKinds(f)).toEqual([
      'scheduled',
      'timing_changed',
      'timing_changed',
      'timing_changed',
      'timing_changed',
    ]);
  } finally {
    f.db.close();
  }
});
test.each(
  TERMINAL_STATES.flatMap((terminal) =>
    ['pending', ...TERMINAL_STATES.filter((state) => state !== terminal)].map(
      (losingState) => [terminal, losingState]
    )
  )
)(
  'delivery-only %s notice superseded by %s is repaired without duplicate stable notices',
  async (terminal, losingState) => {
    const f = fixture(600);
    try {
      f.schedule();
      await f.monitor.tick();
      observeState(f, terminal, 1);
      const canonical = structuredClone(f.state);
      // Only delivery sees the losing fork; persisted polling state stays put.
      observeState(f, losingState, 2);
      const losing = structuredClone(f.state);
      Object.assign(f.state, canonical);
      await tickWithDeliverySnapshot(f, losing);
      expect(f.repo.operation(f.sub.id, OP).state).toBe(terminal);
      expect(sentKinds(f)).toEqual(['scheduled']);
      observeState(f, terminal, 1);
      await f.monitor.tick();
      await f.monitor.tick();
      expect(sentKinds(f)).toEqual(['scheduled', terminal]);
    } finally {
      f.db.close();
    }
  }
);
test('terminal correction is suppressed when delivery no longer observes that outcome', async () => {
  const f = fixture(600);
  try {
    f.schedule();
    await f.monitor.tick();
    f.advance();
    f.state.activeOperationId = ZERO_HASH;
    f.state.schedules[OP].canceled = true;
    await f.monitor.tick();
    f.advance();
    f.rpc.getBlock.mockImplementation(async (number) => ({
      ...f.state.block,
      number,
      hash: number === 11 ? hash(999) : hash(number),
    }));
    f.state.schedules[OP].canceled = false;
    f.state.schedules[OP].executed = true;
    const replacement = structuredClone(f.state);
    replacement.schedules[OP].executed = false;
    replacement.schedules[OP].canceled = true;
    await tickWithDeliverySnapshot(f, replacement);
    expect(f.repo.operation(f.sub.id, OP).state).toBe('executed');
    expect(
      f.mailer.outbox.some((mail) => mail.subject.includes('executed'))
    ).toBe(false);
    expect(
      f.db
        .prepare("SELECT state FROM recovery_outbox WHERE kind='executed'")
        .get().state
    ).toBe('superseded');
  } finally {
    f.db.close();
  }
});
test.each([
  ['canceled', 'executed'],
  ['executed', 'canceled'],
])(
  'delivery-only %s supersession is repaired when %s fork disappears',
  async (terminal, losingState) => {
    const f = fixture(600);
    try {
      f.schedule();
      await f.monitor.tick();
      f.advance();
      f.state.activeOperationId = ZERO_HASH;
      f.state.schedules[OP][terminal] = true;
      const losing = structuredClone(f.state);
      losing.schedules[OP][terminal] = false;
      losing.schedules[OP][losingState] = true;
      await tickWithDeliverySnapshot(f, losing);
      expect(f.repo.operation(f.sub.id, OP).state).toBe(terminal);
      expect(
        f.mailer.outbox.filter((mail) => mail.subject.includes(terminal))
      ).toHaveLength(0);

      f.state.schedules[OP][losingState] = false;
      f.state.schedules[OP][terminal] = true;
      await f.monitor.tick();
      await f.monitor.tick();
      expect(
        f.mailer.outbox.filter((mail) => mail.subject.includes(terminal))
      ).toHaveLength(1);
    } finally {
      f.db.close();
    }
  }
);
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
test.each(['executed', 'orphaned'])(
  'terminal state and cursor remain atomic across failed backfill and shallow reorg to %s',
  async (replacement) => {
    const f = fixture(600);
    try {
      f.schedule();
      await f.monitor.tick();
      const previous = f.repo.getSubscription(f.sub.id);
      f.advance();
      f.state.activeOperationId = ZERO_HASH;
      f.state.schedules[OP].canceled = true;
      f.rpc.logs.mockRejectedValueOnce(new Error('log_query_failed'));
      await f.monitor.tick();
      expect(f.repo.getSubscription(f.sub.id)).toMatchObject({
        cursor: previous.cursor,
        cursor_hash: previous.cursor_hash,
        status: 'degraded',
      });
      expect(f.repo.operation(f.sub.id, OP).state).toBe('canceled');
      expect(f.repo.getSubscription(f.sub.id).reconcile_needed).toBe(1);
      expect(sentKinds(f)).toEqual(['scheduled', 'canceled']);

      // The replacement begins after the still-canonical cursor. A restart
      // must not depend on any in-memory record of the rejected observation.
      f.state.block.hash = hash(999);
      if (replacement === 'orphaned') f.state.schedules = {};
      else {
        f.state.schedules[OP].canceled = false;
        f.state.schedules[OP].executed = true;
        f.logs.push({
          kind: 'RecoveryExecuted',
          operationId: OP,
          blockNumber: f.state.block.number,
          blockHash: f.state.block.hash,
          txHash: TX,
          index: 1,
        });
      }
      f.monitor = f.newMonitor();
      await f.monitor.tick();
      await f.monitor.tick();
      expect(f.repo.operation(f.sub.id, OP).state).toBe(replacement);
      expect(sentKinds(f)).toEqual(['scheduled', 'canceled', replacement]);
      expect(f.repo.getSubscription(f.sub.id).status).toBe('active');
    } finally {
      f.db.close();
    }
  }
);
test('provisional observations remain independently revalidated throughout a log outage', async () => {
  const f = fixture(600);
  try {
    f.schedule();
    f.rpc.logs.mockRejectedValue(new Error('log_query_failed'));
    await f.monitor.tick();
    expect(f.repo.operation(f.sub.id, OP).state).toBe('pending');
    expect(sentKinds(f)).toEqual(['scheduled']);
    const cursor = f.repo.getSubscription(f.sub.id).cursor;
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance();
      f.state.activeOperationId = ZERO_HASH;
      f.state.schedules[OP].canceled = true;
      await f.monitor.tick();
      expect(f.repo.operation(f.sub.id, OP).state).toBe('canceled');
      expect(f.repo.getSubscription(f.sub.id).cursor).toBe(cursor);
      expect(f.repo.getSubscription(f.sub.id).reconcile_needed).toBe(1);
      expect(sentKinds(f)).toEqual(['scheduled', 'canceled']);
    }
    f.rpc.logs.mockResolvedValue([]);
    await f.monitor.tick();
    expect(f.repo.operation(f.sub.id, OP).state).toBe('canceled');
    expect(sentKinds(f)).toEqual(['scheduled', 'canceled']);
    expect(f.repo.getSubscription(f.sub.id).cursor).toBe(f.state.block.number);
  } finally {
    f.db.close();
  }
});
test('multi-page catchup preserves and revalidates provisional terminal observations', async () => {
  const f = fixture(600);
  try {
    f.schedule();
    f.monitor.bootstrap(f.sub, f.state);
    await f.monitor.deliver();
    f.state.block = {
      number: 5000,
      hash: hash(5000),
      timestamp: f.state.block.timestamp + 5,
    };
    f.state.activeOperationId = ZERO_HASH;
    f.state.schedules[OP].canceled = true;
    await f.monitor.tick();
    expect(f.repo.getSubscription(f.sub.id)).toMatchObject({
      cursor: 2009,
      status: 'catching_up',
    });
    expect(f.repo.operation(f.sub.id, OP).state).toBe('canceled');
    expect(f.repo.getSubscription(f.sub.id).reconcile_needed).toBe(1);
    expect(sentKinds(f)).toEqual(['scheduled', 'canceled']);
    f.monitor = f.newMonitor();
    await f.monitor.tick();
    expect(f.repo.getSubscription(f.sub.id).cursor).toBe(4009);
    expect(f.repo.operation(f.sub.id, OP).state).toBe('canceled');

    // Only the uncheckpointed tip is replaced; block 4009 still matches.
    f.state.block.hash = hash(9999);
    f.state.schedules[OP].canceled = false;
    f.state.schedules[OP].executed = true;
    f.rpc.getBlock.mockImplementation(async (number) => ({
      ...f.state.block,
      number,
      hash: number === f.state.block.number ? f.state.block.hash : hash(number),
    }));
    await f.monitor.tick();
    expect(f.repo.getSubscription(f.sub.id)).toMatchObject({
      cursor: 5000,
      cursor_hash: hash(9999),
      status: 'active',
    });
    expect(f.repo.operation(f.sub.id, OP).state).toBe('executed');
    expect(sentKinds(f)).toEqual(['scheduled', 'canceled', 'executed']);
  } finally {
    f.db.close();
  }
});
test('a failed cursor transaction cannot clear the provisional terminal reconciliation flag', async () => {
  const f = fixture(600);
  try {
    f.schedule();
    await f.monitor.tick();
    const cursor = f.repo.getSubscription(f.sub.id).cursor;
    f.repo.markReconcileNeeded(f.sub.id, f.sub.generation);
    f.advance();
    f.state.activeOperationId = ZERO_HASH;
    f.state.schedules[OP].canceled = true;
    jest.spyOn(f.repo, 'updateHealth').mockImplementationOnce(() => {
      throw new Error('database_write_failed');
    });
    await f.monitor.tick();
    expect(f.repo.operation(f.sub.id, OP).state).toBe('canceled');
    expect(f.repo.getSubscription(f.sub.id)).toMatchObject({
      cursor,
      status: 'degraded',
      reconcile_needed: 1,
    });
    expect(sentKinds(f)).toEqual(['scheduled', 'canceled']);
    expect(f.repo.pendingOutbox()).toEqual([]);
    await f.monitor.tick();
    expect(f.repo.operation(f.sub.id, OP).state).toBe('canceled');
    expect(f.repo.getSubscription(f.sub.id).reconcile_needed).toBe(0);
    expect(sentKinds(f)).toEqual(['scheduled', 'canceled']);
  } finally {
    f.db.close();
  }
});
test('terminal reconciliation survives bounded reorg pages, a later log failure and restart', async () => {
  const f = fixture(600);
  try {
    f.schedule();
    await f.monitor.tick();
    f.advance();
    f.state.activeOperationId = ZERO_HASH;
    f.state.schedules[OP].canceled = true;
    await f.monitor.tick();
    expect(sentKinds(f)).toEqual(['scheduled', 'canceled']);

    f.state.block = {
      number: 5000,
      hash: hash(5000),
      timestamp: f.state.block.timestamp + 5,
    };
    f.state.schedules[OP].canceled = false;
    f.state.schedules[OP].executed = true;
    f.rpc.getBlock.mockImplementation(async (number) => ({
      ...f.state.block,
      number,
      hash: number === 11 ? hash(999) : hash(number),
    }));
    await f.monitor.tick();
    expect(f.repo.getSubscription(f.sub.id).cursor).toBe(2009);
    expect(f.repo.getSubscription(f.sub.id).reconcile_needed).toBe(1);
    expect(f.repo.operation(f.sub.id, OP).state).toBe('executed');
    f.rpc.logs.mockRejectedValueOnce(new Error('later_page_failed'));
    await f.monitor.tick();
    expect(f.repo.getSubscription(f.sub.id)).toMatchObject({
      cursor: 2009,
      status: 'degraded',
      reconcile_needed: 1,
    });
    f.monitor = f.newMonitor();
    await f.monitor.tick();
    expect(f.repo.getSubscription(f.sub.id).cursor).toBe(4009);
    await f.monitor.tick();
    await f.monitor.tick();
    expect(f.repo.operation(f.sub.id, OP).state).toBe('executed');
    expect(sentKinds(f)).toEqual(['scheduled', 'canceled', 'executed']);
    expect(f.repo.getSubscription(f.sub.id)).toMatchObject({
      cursor: 5000,
      status: 'active',
      reconcile_needed: 0,
    });
  } finally {
    f.db.close();
  }
});
test('completed discoveries from an early page survive shallow reorg and log failure beyond the UI row limit', async () => {
  const f = fixture(600);
  const ids = Array.from({ length: 25 }, (_, i) => hash(1000 + i));
  try {
    for (const [i, operationId] of ids.entries()) {
      f.state.schedules[operationId] = {
        scheduledAt: f.state.block.timestamp,
        executed: true,
        canceled: false,
      };
      f.logs.push({
        kind: 'RecoveryScheduled',
        operationId,
        executableAt: f.state.block.timestamp + 600,
        blockNumber: 10 + i,
        blockHash: hash(10 + i),
        txHash: hash(2000 + i),
        index: 0,
      });
    }
    f.state.block = {
      number: 5000,
      hash: hash(5000),
      timestamp: f.state.block.timestamp + 5,
    };
    await f.monitor.tick();
    expect(f.repo.getSubscription(f.sub.id)).toMatchObject({
      cursor: 2009,
      reconcile_needed: 1,
    });
    expect(
      ids.every((id) => f.repo.operation(f.sub.id, id)?.state === 'executed')
    ).toBe(true);
    expect(f.repo.operations(f.sub.id)).toHaveLength(20);

    // The changed head does not alter the older, still-matching page checkpoint.
    // A failed next page must not hide any of the 25 provisional discoveries.
    f.state.block.hash = hash(9999);
    f.state.schedules = {};
    f.rpc.logs.mockRejectedValueOnce(new Error('next_page_unavailable'));
    f.monitor = f.newMonitor();
    await f.monitor.tick();
    expect(
      ids.every((id) => f.repo.operation(f.sub.id, id).state === 'orphaned')
    ).toBe(true);
    expect(f.repo.getSubscription(f.sub.id)).toMatchObject({
      cursor: 2009,
      status: 'degraded',
      reconcile_needed: 1,
    });
    f.logs.splice(0);
    f.rpc.getBlock.mockImplementation(async (number) => ({
      ...f.state.block,
      number,
      hash: number === f.state.block.number ? f.state.block.hash : hash(number),
    }));
    await f.monitor.tick();
    await f.monitor.tick();
    expect(f.repo.getSubscription(f.sub.id)).toMatchObject({
      cursor: 5000,
      status: 'active',
      reconcile_needed: 0,
    });
    expect(
      ids.every((id) => f.repo.operation(f.sub.id, id).state === 'orphaned')
    ).toBe(true);
  } finally {
    f.db.close();
  }
});
test('reconciliation capacity exhaustion is explicit and never clears pending work', async () => {
  const f = fixture(600);
  try {
    f.repo.atomic(() => {
      for (let i = 0; i < 1001; i++)
        f.repo.putOperation(f.sub.id, {
          operationId: hash(i + 1),
          scheduledAt: 1,
          executableAt: 601,
          expiresAt: 1201,
          state: 'executed',
          blockNumber: 1,
          blockHash: hash(1),
        });
      f.repo.markReconcileNeeded(f.sub.id, f.sub.generation);
    });
    await f.monitor.tick();
    expect(f.rpc.snapshot).toHaveBeenCalledTimes(1);
    expect(f.repo.getSubscription(f.sub.id)).toMatchObject({
      status: 'degraded',
      reconcile_needed: 1,
      cursor: 9,
    });
    expect(f.repo.operation(f.sub.id, hash(1001)).state).toBe('executed');
  } finally {
    f.db.close();
  }
});
test('1000 historical operations cannot suppress a new active recovery alert', async () => {
  const f = fixture(600);
  try {
    f.repo.atomic(() => {
      for (let i = 0; i < 1000; i++)
        f.repo.putOperation(f.sub.id, {
          operationId: hash(i + 1),
          scheduledAt: 1,
          executableAt: 601,
          expiresAt: 1201,
          state: 'executed',
          blockNumber: 1,
          blockHash: hash(1),
        });
      f.repo.markReconcileNeeded(f.sub.id, f.sub.generation);
    });
    f.schedule();
    await f.monitor.tick();
    expect(f.repo.operation(f.sub.id, OP).state).toBe('pending');
    expect(sentKinds(f)).toEqual(['scheduled']);
    expect(f.repo.getSubscription(f.sub.id)).toMatchObject({
      status: 'degraded',
      reconcile_needed: 1,
      cursor: 9,
    });
  } finally {
    f.db.close();
  }
});
test('a newly provisional terminal does not orphan unrelated history absent from its snapshot', async () => {
  const f = fixture(600);
  try {
    f.schedule();
    await f.monitor.tick();
    f.advance();
    f.state.activeOperationId = ZERO_HASH;
    f.state.schedules[OP].canceled = true;
    await f.monitor.tick();
    const next = hash(777);
    f.advance();
    f.schedule(next);
    await f.monitor.tick();
    f.advance();
    f.state.activeOperationId = ZERO_HASH;
    f.state.schedules[next].canceled = true;
    await f.monitor.tick();
    expect(f.repo.operation(f.sub.id, OP).state).toBe('canceled');
    expect(f.repo.operation(f.sub.id, next).state).toBe('canceled');
  } finally {
    f.db.close();
  }
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
  f.repo.subscribe(1, 57057, ACCOUNT, 'New', f.state.block, ACCOUNT);
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
test('registry module change degrades an old subscription and never reads replacement state', async () => {
  const f = fixture();
  f.schedule();
  await f.monitor.tick();
  f.chain.recoveryModule = '0x' + '99'.repeat(20);
  f.rpc.snapshot.mockClear();
  await f.monitor.tick();
  expect(f.repo.getSubscription(f.sub.id).status).toBe('degraded');
  expect(f.rpc.snapshot).not.toHaveBeenCalled();
  f.db.close();
});
test('queued reminder revalidates rescheduled deadline at delivery without relying on a worker visit', async () => {
  const f = fixture(600);
  f.schedule();
  await f.monitor.tick();
  const originalAt = f.state.schedules[OP].scheduledAt;
  f.advance(400);
  f.repo.queue(f.sub.id, 'queued-old-reminder', 'reminder', OP);
  // Same operation ID can be included later on a replacement chain. The DB
  // intentionally still contains the old deadline, as for a subscriber not
  // selected in this round's bounded monitoring batch.
  f.state.schedules[OP].scheduledAt = originalAt + 1000;
  await f.monitor.deliver();
  expect(
    f.mailer.outbox.filter((m) => m.subject.includes('deadline approaching'))
  ).toHaveLength(0);
  expect(
    f.db
      .prepare("SELECT state FROM recovery_outbox WHERE kind='reminder'")
      .get().state
  ).toBe('pending');
  f.advance(1000);
  await f.monitor.deliver();
  const reminders = f.mailer.outbox.filter((m) =>
    m.subject.includes('deadline approaching')
  );
  expect(reminders).toHaveLength(1);
  expect(reminders[0].text).toContain(
    new Date((originalAt + 1600) * 1000).toISOString()
  );
  f.db.close();
});
test('a reminder suppressed on an orphaned cancellation is rearmed at the restored deadline only once', async () => {
  const f = fixture(600);
  f.schedule();
  await f.monitor.tick();
  const originalAt = f.state.schedules[OP].scheduledAt;
  f.advance(300);
  f.monitor.bootstrap(f.repo.getSubscription(f.sub.id), f.state);
  // The next confirmed block cancels the operation before delivery.
  f.advance(1);
  f.state.schedules[OP].canceled = true;
  f.state.activeOperationId = ZERO_HASH;
  await f.monitor.deliver();
  await f.monitor.tick();
  expect(
    f.db
      .prepare("SELECT state FROM recovery_outbox WHERE kind='reminder'")
      .get().state
  ).toBe('superseded');

  // That cancellation is orphaned. On the replacement branch the exact same
  // operation was scheduled later; its new halfway point has not arrived yet.
  f.setNow((originalAt + 400) * 1000);
  f.state.block = { number: 13, hash: hash(113), timestamp: originalAt + 400 };
  f.rpc.getBlock.mockImplementation(async (number) => ({
    ...f.state.block,
    number,
    hash: hash(number + 100),
  }));
  f.state.activeOperationId = OP;
  f.state.schedules[OP] = {
    scheduledAt: originalAt + 200,
    executed: false,
    canceled: false,
  };
  f.logs.splice(0, f.logs.length, {
    kind: 'RecoveryScheduled',
    operationId: OP,
    executableAt: originalAt + 800,
    blockNumber: 11,
    blockHash: hash(111),
    txHash: TX,
    index: 0,
  });
  await f.monitor.tick();
  expect(
    f.mailer.outbox.filter((m) => m.subject.includes('deadline approaching'))
  ).toHaveLength(0);
  f.setNow((originalAt + 600) * 1000);
  f.state.block = { number: 14, hash: hash(114), timestamp: originalAt + 600 };
  await f.monitor.tick();
  await f.monitor.tick();
  expect(
    f.mailer.outbox.filter((m) => m.subject.includes('deadline approaching'))
  ).toHaveLength(1);
  expect(f.repo.operation(f.sub.id, OP).state).toBe('pending');
  f.db.close();
});
test('queued enabled confirmation cannot claim monitoring after a disabled-registry restart', async () => {
  const f = fixture();
  f.repo.queue(f.sub.id, 'enabled', 'enabled', null);
  const disabled = createRecoveryMonitor({
    repository: f.repo,
    users: {
      findById: () => ({ email: 'owner@example.com', emailVerified: true }),
    },
    chains: [],
    mailer: f.mailer,
    now: () => f.state.block.timestamp * 1000,
  });
  await disabled.tick();
  expect(f.mailer.outbox).toEqual([]);
  expect(
    f.db.prepare("SELECT state FROM recovery_outbox WHERE kind='enabled'").get()
      .state
  ).toBe('pending');
  f.repo.disable(f.sub.id);
  f.repo.queue(f.sub.id, 'disabled', 'disabled', null);
  await disabled.deliver();
  expect(f.mailer.outbox).toHaveLength(1);
  expect(f.mailer.outbox[0].subject).toContain('alerts disabled');
  f.db.close();
});
test('enabled confirmation waits for healthy monitoring and current RPC availability', async () => {
  const f = fixture();
  f.repo.queue(f.sub.id, 'enabled', 'enabled', null);
  await f.monitor.deliver();
  expect(f.mailer.outbox).toEqual([]);
  f.advance(16);
  await f.monitor.tick();
  expect(f.mailer.outbox).toHaveLength(1);
  f.db.close();
});
