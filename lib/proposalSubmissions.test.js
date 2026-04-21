'use strict';

const { openDatabase } = require('./db');
const {
  createProposalSubmissionsRepo,
  STATUS,
} = require('./proposalSubmissions');

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

function validInput(userId, overrides = {}) {
  return {
    userId,
    parentHash: '0',
    revision: 1,
    timeUnix: 1800000000,
    dataHex: '7b2274797065223a317d', // {"type":1}
    proposalHash: 'a'.repeat(64),
    title: 'Test',
    name: 'test-proposal',
    url: 'https://example.org/p',
    paymentAddress: 'sys1qabcdefghij1234567890',
    paymentAmountSats: 4250000000n,
    paymentCount: 1,
    startEpoch: 1800000000,
    endEpoch: 1802592000,
    ...overrides,
  };
}

// Custom matcher-esque helper: assert that calling `fn` throws an Error
// whose .code matches the given string. We check the machine-stable
// `.code` (not the human message), since that's what the route layer
// maps to HTTP status / user copy.
function expectThrowsCode(fn, expectedCode) {
  try {
    fn();
  } catch (e) {
    expect(e.code).toBe(expectedCode);
    return;
  }
  throw new Error(`expected throw with code ${expectedCode}, got nothing`);
}

function setup() {
  const db = openDatabase(':memory:');
  const user1 = seedUser(db, 'a@x.com');
  const user2 = seedUser(db, 'b@x.com');
  let clock = 1_700_000_000_000;
  const repo = createProposalSubmissionsRepo(db, { now: () => clock });
  return {
    db,
    repo,
    user1,
    user2,
    tick: (ms = 1000) => {
      clock += ms;
      return clock;
    },
  };
}

// ---------------- create ----------------
describe('create', () => {
  test('creates a row in status=prepared with all canonical fields', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    expect(s.status).toBe(STATUS.PREPARED);
    expect(s.userId).toBe(user1);
    expect(s.proposalHash).toBe('a'.repeat(64));
    expect(s.paymentAmountSats).toBe(4250000000n);
    expect(s.collateralTxid).toBeNull();
    expect(s.collateralConfs).toBe(0);
    expect(s.governanceHash).toBeNull();
  });

  test('preserves BigInt amount above 2^53', () => {
    const { repo, user1 } = setup();
    const huge = 18014398509481985n;
    const s = repo.create(validInput(user1, { paymentAmountSats: huge }));
    expect(s.paymentAmountSats).toBe(huge);
    expect(repo.getById(s.id).paymentAmountSats).toBe(huge);
  });

  test.each([
    ['userId', { userId: 0 }, 'user_required'],
    ['timeUnix', { timeUnix: 0 }, 'time_required'],
    ['dataHex', { dataHex: 'not hex' }, 'data_hex_invalid'],
    ['proposalHash', { proposalHash: 'short' }, 'proposal_hash_invalid'],
    ['name', { name: '' }, 'name_required'],
    ['url', { url: '' }, 'url_required'],
    ['paymentAddress', { paymentAddress: '' }, 'paymentAddress_required'],
    ['paymentAmountSats (zero)', { paymentAmountSats: 0n }, 'amount_invalid'],
    ['startEpoch missing', { startEpoch: null }, 'epoch_required'],
  ])('rejects invalid input: %s', (_label, patch, code) => {
    const { repo, user1 } = setup();
    expectThrowsCode(() => repo.create(validInput(user1, patch)), code);
  });
});

// ---------------- user isolation ----------------
describe('user isolation', () => {
  test('getByIdForUser returns null for a non-owner', () => {
    const { repo, user1, user2 } = setup();
    const s = repo.create(validInput(user1));
    expect(repo.getByIdForUser(s.id, user2)).toBeNull();
  });

  test('listForUser scopes to owner', () => {
    const { repo, user1, user2 } = setup();
    repo.create(validInput(user1, { proposalHash: 'a'.repeat(64) }));
    repo.create(validInput(user2, { proposalHash: 'b'.repeat(64) }));
    expect(repo.listForUser(user1).map((r) => r.proposalHash)).toEqual([
      'a'.repeat(64),
    ]);
    expect(repo.listForUser(user2).map((r) => r.proposalHash)).toEqual([
      'b'.repeat(64),
    ]);
  });
});

// ---------------- attachCollateral ----------------
describe('attachCollateral', () => {
  const txid = 'f'.repeat(64);

  test('prepared → awaiting_collateral and stores lowercase txid', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    const out = repo.attachCollateral(s.id, user1, txid.toUpperCase());
    expect(out.status).toBe(STATUS.AWAITING_COLLATERAL);
    expect(out.collateralTxid).toBe(txid);
  });

  test('returns null for a non-owner', () => {
    const { repo, user1, user2 } = setup();
    const s = repo.create(validInput(user1));
    expect(repo.attachCollateral(s.id, user2, txid)).toBeNull();
  });

  test('rejects from non-prepared status', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, txid);
    expectThrowsCode(
      () => repo.attachCollateral(s.id, user1, txid),
      'status_not_prepared'
    );
  });

  test('rejects an invalid txid', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    expectThrowsCode(
      () => repo.attachCollateral(s.id, user1, 'not-hex'),
      'txid_invalid'
    );
  });

  test('rejects a txid already used by another submission', () => {
    const { repo, user1, user2 } = setup();
    const a = repo.create(validInput(user1));
    const b = repo.create(
      validInput(user2, { proposalHash: 'b'.repeat(64) })
    );
    repo.attachCollateral(a.id, user1, txid);
    expectThrowsCode(
      () => repo.attachCollateral(b.id, user2, txid),
      'txid_already_used'
    );
  });
});

// ---------------- updateConfirmations ----------------
describe('updateConfirmations', () => {
  test('bumps confs and updated_at', () => {
    const { repo, user1, tick } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    tick(1000);
    const after = repo.updateConfirmations(s.id, 4);
    expect(after.collateralConfs).toBe(4);
    expect(after.updatedAt).toBeGreaterThan(s.updatedAt);
  });

  test('rejects negative/non-integer confs', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    expectThrowsCode(() => repo.updateConfirmations(s.id, -1), 'confs_invalid');
    expectThrowsCode(() => repo.updateConfirmations(s.id, 1.5), 'confs_invalid');
  });
});

// ---------------- markSubmitted ----------------
describe('markSubmitted', () => {
  const txid = 'a'.repeat(64);
  const govHash = 'b'.repeat(64);

  function arrange() {
    const ctx = setup();
    const s = ctx.repo.create(validInput(ctx.user1));
    ctx.repo.attachCollateral(s.id, ctx.user1, txid);
    return { ...ctx, s };
  }

  test('awaiting_collateral → submitted, records governanceHash lowercase', () => {
    const { repo, s } = arrange();
    const out = repo.markSubmitted(s.id, { governanceHash: govHash.toUpperCase() });
    expect(out.status).toBe(STATUS.SUBMITTED);
    expect(out.governanceHash).toBe(govHash);
  });

  test('rejects from a non-awaiting status', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    expectThrowsCode(
      () => repo.markSubmitted(s.id, { governanceHash: govHash }),
      'status_not_awaiting'
    );
  });

  test('rejects an invalid governance hash', () => {
    const { repo, s } = arrange();
    expectThrowsCode(
      () => repo.markSubmitted(s.id, { governanceHash: 'bad' }),
      'governance_hash_invalid'
    );
  });

  test('rejects a governance hash already recorded on another row', () => {
    const { db, repo, user1, user2 } = setup();
    const a = repo.create(validInput(user1));
    const b = repo.create(validInput(user2, { proposalHash: 'c'.repeat(64) }));
    repo.attachCollateral(a.id, user1, 'a'.repeat(64));
    repo.attachCollateral(b.id, user2, 'd'.repeat(64));
    repo.markSubmitted(a.id, { governanceHash: govHash });
    expectThrowsCode(
      () => repo.markSubmitted(b.id, { governanceHash: govHash }),
      'governance_hash_clash'
    );
    db.close();
  });
});

// ---------------- markFailed ----------------
describe('markFailed', () => {
  test('can fail from prepared', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    const out = repo.markFailed(s.id, {
      reason: 'canceled',
      detail: 'user aborted',
    });
    expect(out.status).toBe(STATUS.FAILED);
    expect(out.failReason).toBe('canceled');
    expect(out.failDetail).toBe('user aborted');
  });

  test('can fail from awaiting_collateral', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    const out = repo.markFailed(s.id, { reason: 'confirm_timeout' });
    expect(out.status).toBe(STATUS.FAILED);
  });

  test('cannot fail a submitted row', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    repo.markSubmitted(s.id, { governanceHash: 'b'.repeat(64) });
    expectThrowsCode(
      () => repo.markFailed(s.id, { reason: 'late_fail' }),
      'status_terminal'
    );
  });

  test('cannot fail an already-failed row (no double-writes)', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.markFailed(s.id, { reason: 'canceled' });
    expectThrowsCode(
      () => repo.markFailed(s.id, { reason: 'canceled' }),
      'status_terminal'
    );
  });
});

// ---------------- remove ----------------
describe('remove', () => {
  test('removes a prepared row', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    expect(repo.remove(s.id, user1)).toBe(1);
    expect(repo.getById(s.id)).toBeNull();
  });

  test('removes a failed row', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.markFailed(s.id, { reason: 'canceled' });
    expect(repo.remove(s.id, user1)).toBe(1);
  });

  test('refuses to remove awaiting_collateral (confirmations in flight)', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    expect(repo.remove(s.id, user1)).toBe(0);
    expect(repo.getById(s.id)).not.toBeNull();
  });

  test('refuses to remove submitted (permanent record)', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    repo.markSubmitted(s.id, { governanceHash: 'b'.repeat(64) });
    expect(repo.remove(s.id, user1)).toBe(0);
  });

  test('isolates users', () => {
    const { repo, user1, user2 } = setup();
    const s = repo.create(validInput(user1));
    expect(repo.remove(s.id, user2)).toBe(0);
    expect(repo.getById(s.id)).not.toBeNull();
  });
});

// ---------------- listByStatus / finders ----------------
describe('finders', () => {
  test('listByStatus returns rows matching a given status', () => {
    const { repo, user1 } = setup();
    const a = repo.create(validInput(user1));
    const b = repo.create(
      validInput(user1, { proposalHash: 'd'.repeat(64) })
    );
    repo.attachCollateral(b.id, user1, 'c'.repeat(64));
    expect(repo.listByStatus(STATUS.PREPARED).map((r) => r.id)).toEqual([a.id]);
    expect(repo.listByStatus(STATUS.AWAITING_COLLATERAL).map((r) => r.id)).toEqual([
      b.id,
    ]);
  });

  test('listByStatus rejects unknown status', () => {
    const { repo } = setup();
    expectThrowsCode(() => repo.listByStatus('bogus'), 'status_invalid');
  });

  test('findByCollateralTxid finds a row by txid (lowercased)', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'A'.repeat(64));
    expect(repo.findByCollateralTxid('a'.repeat(64)).id).toBe(s.id);
    expect(repo.findByCollateralTxid('nonexistent')).toBeNull();
  });

  test('findByGovernanceHash finds a row by gov hash (lowercased)', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    repo.markSubmitted(s.id, { governanceHash: 'B'.repeat(64) });
    expect(repo.findByGovernanceHash('b'.repeat(64)).id).toBe(s.id);
  });

  test('findByProposalHashForUser scopes to owner', () => {
    const { repo, user1, user2 } = setup();
    const s = repo.create(validInput(user1));
    expect(repo.findByProposalHashForUser(user1, s.proposalHash).id).toBe(s.id);
    expect(
      repo.findByProposalHashForUser(user2, s.proposalHash)
    ).toBeNull();
  });
});

// ---------------- cascade ----------------
describe('cascade on user delete', () => {
  test('submissions for a deleted user are removed', () => {
    const { db, repo, user1 } = setup();
    repo.create(validInput(user1));
    db.prepare('DELETE FROM users WHERE id = ?').run(user1);
    expect(repo.listForUser(user1)).toEqual([]);
  });
});
