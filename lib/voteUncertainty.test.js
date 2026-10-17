const { openDatabase } = require('./db');
const {
  createVoteReceiptsRepo,
  createCurrentVotesCache,
} = require('./voteReceipts');
const { relayVotes } = require('./gov');
const H = 'a'.repeat(64),
  P = 'b'.repeat(64),
  NOW = 1800000000000;
let db, repo, clock;
const intent = (overrides = {}) => ({
  userId: 1,
  collateralHash: H,
  collateralIndex: 0,
  proposalHash: P,
  voteOutcome: 'no',
  voteSignal: 'funding',
  voteTime: NOW / 1000,
  status: 'submission_unknown',
  ...overrides,
});
beforeEach(() => {
  clock = NOW;
  db = openDatabase(':memory:');
  db.prepare(
    'INSERT INTO users(id,email,stored_auth,salt_v,email_verified,created_at,updated_at) VALUES(1,?,?,?,?,?,?)'
  ).run('fixture@example.test', 'auth', 'salt', 1, NOW, NOW);
  repo = createVoteReceiptsRepo(db, { now: () => clock });
});
afterEach(() => db.close());
const chain = (overrides = {}) => ({
  collateralHash: H,
  collateralIndex: 0,
  voteOutcome: 'no',
  voteSignal: 'funding',
  voteTime: NOW / 1000,
  ...overrides,
});
test('unknown is not a successful vote or reminder-suppression signal', () => {
  repo.upsert(intent());
  expect(repo.decideRelay(intent()).action).toBe('hold');
  expect(repo.hasAnyRelayedInCycle(1, [P])).toBe(false);
  expect(repo.summaryForUser(1)[0]).toMatchObject({
    unknown: 1,
    relayed: 0,
    confirmed: 0,
  });
});
test('older yes cannot confirm a timed-out requested no', async () => {
  repo.upsert(intent());
  await repo.reconcileForProposal({
    userId: 1,
    proposalHash: P,
    fresh: true,
    getCurrentVotes: async () => [
      chain({ voteOutcome: 'yes', voteTime: NOW / 1000 - 100 }),
    ],
  });
  expect(repo.listForProposal(1, P)[0]).toMatchObject({
    status: 'submission_unknown',
    voteOutcome: 'no',
  });
});
test('exact on-chain vote confirms uncertain submission', async () => {
  repo.upsert(intent());
  await repo.reconcileForProposal({
    userId: 1,
    proposalHash: P,
    fresh: true,
    getCurrentVotes: async () => [chain()],
  });
  expect(repo.listForProposal(1, P)[0]).toMatchObject({
    status: 'confirmed',
    voteOutcome: 'no',
    lastError: null,
  });
});
test('later chain vote supersedes without pretending the requested no succeeded', async () => {
  repo.upsert(intent());
  await repo.reconcileForProposal({
    userId: 1,
    proposalHash: P,
    fresh: true,
    getCurrentVotes: async () => [
      chain({ voteOutcome: 'yes', voteTime: NOW / 1000 + 60 }),
    ],
  });
  expect(repo.listForProposal(1, P)[0]).toMatchObject({
    status: 'confirmed',
    voteOutcome: 'yes',
    lastError: 'superseded_by_later_vote',
  });
});
test('time alone and early absence never permit resubmit; fresh absence after grace does', async () => {
  repo.upsert(intent());
  const getCurrentVotes = jest.fn(async () => []);
  await repo.reconcileForProposal({
    userId: 1,
    proposalHash: P,
    fresh: true,
    getCurrentVotes,
  });
  clock += 600001;
  expect(repo.decideRelay(intent()).action).toBe('hold');
  await repo.reconcileForProposal({
    userId: 1,
    proposalHash: P,
    getCurrentVotes,
  });
  expect(repo.decideRelay(intent()).action).toBe('hold');
  await repo.reconcileForProposal({
    userId: 1,
    proposalHash: P,
    fresh: true,
    getCurrentVotes,
  });
  expect(repo.listForProposal(1, P)[0].status).toBe('stale');
  expect(repo.decideRelay(intent()).action).toBe('relay');
  expect(getCurrentVotes).toHaveBeenLastCalledWith(P, { refresh: true });
});
test('read failure preserves uncertainty', async () => {
  repo.upsert(intent());
  clock += 600001;
  await expect(
    repo.reconcileForProposal({
      userId: 1,
      proposalHash: P,
      fresh: true,
      getCurrentVotes: async () => {
        throw Error('down');
      },
    })
  ).rejects.toThrow('reconcile_rpc_failed');
  expect(repo.listForProposal(1, P)[0].status).toBe('submission_unknown');
});

test('an early read completing after grace cannot certify retry eligibility', async () => {
  repo.upsert(intent());
  clock += 599999;
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  const work = repo.reconcileForProposal({
    userId: 1,
    proposalHash: P,
    fresh: true,
    getCurrentVotes: () => pending,
  });
  clock += 1000;
  release([]);
  await work;
  expect(repo.listForProposal(1, P)[0].status).toBe('submission_unknown');
});

test('receipt read failure cannot bypass an existing unknown after time passes', async () => {
  repo.upsert(intent());
  clock += 700000;
  jest.spyOn(repo, 'decideRelay').mockImplementation(() => {
    throw Error('database unavailable');
  });
  const voteRaw = jest.fn();
  const out = await relayVotes(
    voteRaw,
    {
      proposalHash: P,
      voteOutcome: 'no',
      voteSignal: 'funding',
      time: NOW / 1000,
      entries: [{ collateralHash: H, collateralIndex: 0, voteSig: 'public' }],
    },
    { receipts: repo, userId: 1 }
  );
  expect(voteRaw).not.toHaveBeenCalled();
  expect(out.results[0]).toMatchObject({
    notSubmitted: true,
    error: 'receipt_check_unavailable',
  });
  expect(repo.listForProposal(1, P)[0].status).toBe('submission_unknown');
});
test('late reconciliation cannot overwrite a newer intent/receipt', async () => {
  repo.upsert(intent());
  let release;
  const waiting = new Promise((r) => (release = r));
  const work = repo.reconcileForProposal({
    userId: 1,
    proposalHash: P,
    fresh: true,
    getCurrentVotes: () => waiting,
  });
  clock += 100;
  repo.upsert(
    intent({ voteOutcome: 'yes', voteTime: NOW / 1000 + 1, status: 'relayed' })
  );
  release([chain()]);
  await work;
  expect(repo.listForProposal(1, P)[0]).toMatchObject({
    voteOutcome: 'yes',
    status: 'relayed',
  });
});
test('late absence cannot stale a newer successful receipt', async () => {
  repo.upsert(intent());
  clock += 600001;
  let release;
  const waiting = new Promise((resolve) => (release = resolve));
  const work = repo.reconcileForProposal({
    userId: 1,
    proposalHash: P,
    fresh: true,
    getCurrentVotes: () => waiting,
  });
  clock += 100;
  repo.upsert(intent({ voteTime: NOW / 1000 + 1, status: 'relayed' }));
  release([]);
  await work;
  expect(repo.listForProposal(1, P)[0]).toMatchObject({
    status: 'relayed',
    voteTime: NOW / 1000 + 1,
  });
});
test('forced read bypasses settled and pending cache; ordinary reads still coalesce', async () => {
  const callRpc = jest.fn(async () => ({}));
  const cache = createCurrentVotesCache({ callRpc });
  await cache.get(P);
  await cache.get(P);
  expect(callRpc).toHaveBeenCalledTimes(1);
  await Promise.all([
    cache.get(P, { refresh: true }),
    cache.get(P, { refresh: true }),
  ]);
  expect(callRpc).toHaveBeenCalledTimes(3);
});

test('a forced read cannot inherit an older in-flight absence result', async () => {
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  const callRpc = jest
    .fn()
    .mockImplementationOnce(() => pending)
    .mockResolvedValueOnce({});
  const cache = createCurrentVotesCache({ callRpc });
  const first = cache.get(P);
  await Promise.resolve();
  await cache.get(P, { refresh: true });
  expect(callRpc).toHaveBeenCalledTimes(2);
  release({ [P]: `${H}-0:${NOW / 1000}:yes:funding` });
  expect(await first).toHaveLength(1);
  expect(await cache.get(P)).toEqual([]);
  expect(callRpc).toHaveBeenCalledTimes(2);
});

test.each(['submission_unknown', 'relayed'])(
  'late older %s completion cannot overwrite a newer successful vote',
  async (status) => {
    repo.upsert(
      intent({ voteTime: NOW / 1000 + 1, voteOutcome: 'no', status: 'relayed' })
    );
    repo.upsert(intent({ voteTime: NOW / 1000, voteOutcome: 'yes', status }));
    expect(repo.listForProposal(1, P)[0]).toMatchObject({
      voteTime: NOW / 1000 + 1,
      voteOutcome: 'no',
      status: 'relayed',
    });
  }
);
test.each(['submission_unknown', 'failed'])(
  'equal-time late %s cannot replace another known-successful intent',
  (status) => {
    repo.upsert(intent({ voteOutcome: 'no', status: 'relayed' }));
    repo.upsert(intent({ voteOutcome: 'yes', status }));
    expect(repo.listForProposal(1, P)[0]).toMatchObject({
      voteOutcome: 'no',
      status: 'relayed',
    });
  }
);
test('same-intent late uncertainty preserves confirmed evidence while a newer vote can change it', () => {
  repo.upsert(intent({ status: 'confirmed' }));
  repo.upsert(intent({ status: 'submission_unknown' }));
  expect(repo.listForProposal(1, P)[0].status).toBe('confirmed');
  repo.upsert(
    intent({ voteOutcome: 'yes', voteTime: NOW / 1000 + 1, status: 'relayed' })
  );
  expect(repo.listForProposal(1, P)[0]).toMatchObject({
    voteOutcome: 'yes',
    voteTime: NOW / 1000 + 1,
    status: 'relayed',
  });
});

test('a delayed old timeout through the relay layer does not replace a newer successful receipt', async () => {
  const base = {
    proposalHash: P,
    voteOutcome: 'yes',
    voteSignal: 'funding',
    time: NOW / 1000,
    entries: [
      { collateralHash: H, collateralIndex: 0, voteSig: 'public-fixture' },
    ],
  };
  let reject;
  const old = relayVotes(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
    base,
    { receipts: repo, userId: 1 }
  );
  await Promise.resolve();
  clock += 1000;
  await relayVotes(
    async () => 'Voted successfully',
    { ...base, time: NOW / 1000 + 1, voteOutcome: 'no' },
    { receipts: repo, userId: 1 }
  );
  reject(Object.assign(new Error('timeout'), { uncertain: true }));
  await old;
  expect(repo.listForProposal(1, P)[0]).toMatchObject({
    voteTime: NOW / 1000 + 1,
    voteOutcome: 'no',
    status: 'relayed',
  });
});

test('equal-time Core-accepted vote can advance uncertainty to stronger evidence',()=>{
  repo.upsert(intent({voteOutcome:'yes',status:'submission_unknown'}));
  repo.upsert(intent({voteOutcome:'no',status:'relayed'}));
  expect(repo.listForProposal(1,P)[0]).toMatchObject({voteOutcome:'no',status:'relayed'});
});
