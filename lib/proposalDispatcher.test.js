'use strict';

const { openDatabase } = require('./db');
const { createProposalSubmissionsRepo } = require('./proposalSubmissions');
const {
  createProposalDispatcher,
  REQUIRED_CONFS,
  DEFAULT_TIMEOUT_MS,
} = require('./proposalDispatcher');

const FAKE_SALT_V = 'aa'.repeat(32);

function seedUser(db, email = 'u@x.com') {
  const t = Date.now();
  const r = db
    .prepare(
      `INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, 'h', FAKE_SALT_V, t, t);
  return Number(r.lastInsertRowid);
}

function makeSubmission(repo, userId, overrides = {}) {
  return repo.create({
    userId,
    parentHash: '0',
    revision: 1,
    timeUnix: 1800000000,
    dataHex: '7b2274797065223a317d',
    proposalHash: 'a'.repeat(64),
    title: 'T',
    name: 'name',
    url: 'https://example.org/p',
    paymentAddress: 'sys1qabcdefghij1234567890',
    paymentAmountSats: 100n,
    paymentCount: 1,
    startEpoch: 1800000000,
    endEpoch: 1802592000,
    ...overrides,
  });
}

// A minimal fake RPC that lets us script per-txid responses and
// per-call behavior for gObjectSubmit. Keeps tests declarative.
function makeFakeRpc() {
  const txs = new Map(); // txid (lowercase) -> { confirmations } | error (Error instance)
  const submitScript = []; // FIFO: each entry is { result } or { error }
  const calls = { getRawTransaction: [], gObjectSubmit: [] };

  return {
    txs,
    submitScript,
    calls,
    rpc: {
      async getRawTransaction(txid /* , verbose */) {
        calls.getRawTransaction.push(txid);
        const entry = txs.get(txid.toLowerCase());
        if (entry instanceof Error) throw entry;
        if (!entry) {
          const e = new Error('No such mempool or blockchain transaction');
          throw e;
        }
        return entry;
      },
      async gObjectSubmit(parentHash, revision, time, dataHex, txid) {
        calls.gObjectSubmit.push({ parentHash, revision, time, dataHex, txid });
        if (submitScript.length === 0) {
          throw new Error('fakeRpc: no submit script entries queued');
        }
        const next = submitScript.shift();
        if (next.error) throw next.error;
        return next.result;
      },
    },
  };
}

function setup() {
  const db = openDatabase(':memory:');
  const userId = seedUser(db);
  let clock = 1_700_000_000_000;
  const repo = createProposalSubmissionsRepo(db, { now: () => clock });
  const logs = [];
  const fake = makeFakeRpc();
  const dispatcher = createProposalDispatcher({
    submissions: repo,
    rpc: fake.rpc,
    log: (level, event, meta) => logs.push({ level, event, meta }),
    now: () => clock,
  });
  return {
    db,
    repo,
    dispatcher,
    fake,
    logs,
    userId,
    tick: (ms) => {
      clock += ms;
      return clock;
    },
  };
}

// ---------------- confirmation tracking ----------------
describe('proposalDispatcher — confirmation tracking', () => {
  test('exports REQUIRED_CONFS = 6', () => {
    expect(REQUIRED_CONFS).toBe(6);
  });

  test('records confs from RPC, does not submit before threshold', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'f'.repeat(64));
    fake.txs.set('f'.repeat(64), { confirmations: 3 });
    const stats = await dispatcher.tick();
    expect(stats.scanned).toBe(1);
    const after = repo.getById(s.id);
    expect(after.collateralConfs).toBe(3);
    expect(after.status).toBe('awaiting_collateral');
    expect(fake.calls.gObjectSubmit.length).toBe(0);
  });

  test('0 confirmations (mempool only) is tolerated', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'f'.repeat(64));
    // No `confirmations` field — mempool-only shape
    fake.txs.set('f'.repeat(64), { txid: 'f'.repeat(64) });
    await dispatcher.tick();
    expect(repo.getById(s.id).collateralConfs).toBe(0);
    expect(repo.getById(s.id).status).toBe('awaiting_collateral');
  });

  test('skipped rows that are prepared/submitted/failed', async () => {
    const { repo, dispatcher, userId } = setup();
    const s = makeSubmission(repo, userId);
    // Still in 'prepared' — dispatcher should not touch it
    const stats = await dispatcher.tick();
    expect(stats.scanned).toBe(0);
    expect(repo.getById(s.id).status).toBe('prepared');
  });
});

// ---------------- submit once mature ----------------
describe('proposalDispatcher — submission', () => {
  test('submits when confs >= threshold and flips to submitted', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ result: 'b'.repeat(64) });

    const stats = await dispatcher.tick();
    expect(stats.advanced).toBe(1);
    expect(fake.calls.gObjectSubmit).toHaveLength(1);
    expect(fake.calls.gObjectSubmit[0]).toMatchObject({
      parentHash: '0',
      revision: 1,
      time: 1800000000,
      dataHex: '7b2274797065223a317d',
      txid: 'a'.repeat(64),
    });
    const after = repo.getById(s.id);
    expect(after.status).toBe('submitted');
    expect(after.governanceHash).toBe('b'.repeat(64));
  });

  test('accepts governance hash in uppercase and lowercases it', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 10 });
    fake.submitScript.push({ result: 'B'.repeat(64) });
    await dispatcher.tick();
    expect(repo.getById(s.id).governanceHash).toBe('b'.repeat(64));
  });

  test('bad response shape: leaves row in awaiting_collateral and logs', async () => {
    const { repo, dispatcher, fake, logs, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ result: { not: 'a string' } });
    await dispatcher.tick();
    expect(repo.getById(s.id).status).toBe('awaiting_collateral');
    expect(logs.find((l) => l.event === 'gObject_submit_bad_response')).toBeTruthy();
  });

  test('terminal Core error → row marked failed', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({
      error: new Error(
        'Governance object is not valid - b...b - payment_address is invalid'
      ),
    });
    await dispatcher.tick();
    const after = repo.getById(s.id);
    expect(after.status).toBe('failed');
    expect(after.failReason).toBe('submit_rejected');
    expect(after.failDetail).toMatch(/payment_address is invalid/);
  });

  test('transient Core error → row stays awaiting_collateral, will retry', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ error: new Error('ECONNREFUSED') });
    await dispatcher.tick();
    expect(repo.getById(s.id).status).toBe('awaiting_collateral');
  });

  test('two back-to-back ticks: first submits, second is a no-op', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ result: 'c'.repeat(64) });

    await dispatcher.tick();
    // Second tick — no new submit scripting queued; a rescan should
    // find no rows in awaiting_collateral so gObjectSubmit isn't called.
    await dispatcher.tick();
    expect(fake.calls.gObjectSubmit.length).toBe(1);
    expect(repo.getById(s.id).status).toBe('submitted');
  });

  test('multiple rows: error in one doesn\u2019t block the others', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const a = makeSubmission(repo, userId, { proposalHash: 'a'.repeat(64) });
    const b = makeSubmission(repo, userId, { proposalHash: 'b'.repeat(64) });
    repo.attachCollateral(a.id, userId, '1'.repeat(64));
    repo.attachCollateral(b.id, userId, '2'.repeat(64));
    fake.txs.set('1'.repeat(64), { confirmations: 6 });
    fake.txs.set('2'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ error: new Error('ECONNREFUSED') }); // a transient
    fake.submitScript.push({ result: 'd'.repeat(64) }); // b submits OK

    await dispatcher.tick();
    expect(repo.getById(a.id).status).toBe('awaiting_collateral');
    expect(repo.getById(b.id).status).toBe('submitted');
  });
});

// ---------------- missing collateral tx ----------------
describe('proposalDispatcher — missing tx handling', () => {
  test('tx not found (fresh row): row untouched, retries next tick', async () => {
    const { repo, dispatcher, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    // No tx in fake.txs → "No such mempool" thrown
    await dispatcher.tick();
    expect(repo.getById(s.id).status).toBe('awaiting_collateral');
  });

  test('tx not found after timeout → marked failed', async () => {
    const { repo, dispatcher, userId, tick } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    tick(DEFAULT_TIMEOUT_MS + 1);
    await dispatcher.tick();
    const after = repo.getById(s.id);
    expect(after.status).toBe('failed');
    expect(after.failReason).toBe('collateral_not_found');
  });

  test('other RPC errors do NOT trigger timeout-based fail', async () => {
    const { repo, dispatcher, fake, userId, tick } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), new Error('Node overloaded, try again'));
    tick(DEFAULT_TIMEOUT_MS + 1);
    await dispatcher.tick();
    expect(repo.getById(s.id).status).toBe('awaiting_collateral');
  });
});

// ---------------- factory arg validation ----------------
describe('proposalDispatcher — factory validation', () => {
  test('requires submissions repo', () => {
    expect(() =>
      createProposalDispatcher({
        rpc: { getRawTransaction: () => {}, gObjectSubmit: () => {} },
      })
    ).toThrow(/submissions/);
  });

  test('requires rpc.getRawTransaction', () => {
    expect(() =>
      createProposalDispatcher({
        submissions: { listByStatus: () => [] },
        rpc: { gObjectSubmit: () => {} },
      })
    ).toThrow(/getRawTransaction/);
  });

  test('requires rpc.gObjectSubmit', () => {
    expect(() =>
      createProposalDispatcher({
        submissions: { listByStatus: () => [] },
        rpc: { getRawTransaction: () => {} },
      })
    ).toThrow(/gObjectSubmit/);
  });
});
