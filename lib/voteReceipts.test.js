const { openDatabase } = require('./db');
const {
  createVoteReceiptsRepo,
  createCurrentVotesCache,
  parseVoteString,
  parseCurrentVotes,
  DEFAULT_RECENT_RELAY_MS,
  DEFAULT_STALE_GRACE_MS,
} = require('./voteReceipts');

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

const H64_A = 'a'.repeat(64);
const H64_B = 'b'.repeat(64);
const H64_C = 'c'.repeat(64);
const H64_PROP = 'd'.repeat(64);
const H64_PROP_2 = 'e'.repeat(64);

// A 64-hex string with mixed case so we can test lowercase normalization
// on both ingress (parser) and upsert.
const H64_MIXED = 'A1b2C3d4E5f6'.repeat(5) + '1234';

function mkDbWithUsers() {
  const db = openDatabase(':memory:');
  // Insert two users so we can assert per-user isolation on reads.
  const ins = db.prepare(
    `INSERT INTO users (email, stored_auth, salt_v, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`
  );
  const t = Date.now();
  const info1 = ins.run('u1@example.com', 'x'.repeat(64), 'a'.repeat(64), t, t);
  const info2 = ins.run('u2@example.com', 'x'.repeat(64), 'b'.repeat(64), t, t);
  return { db, userId1: info1.lastInsertRowid, userId2: info2.lastInsertRowid };
}

function clockFromMs(initialMs) {
  const state = { t: initialMs };
  return {
    now: () => state.t,
    advance: (deltaMs) => {
      state.t += deltaMs;
    },
    set: (ms) => {
      state.t = ms;
    },
  };
}

// -----------------------------------------------------------------------
// parseVoteString — golden fixtures vs CGovernanceVote::ToString()
// -----------------------------------------------------------------------

describe('parseVoteString', () => {
  test('parses the canonical ToString format for each outcome', () => {
    // Core emits "<txid>-<n>:<nTime>:<outcome>:<signal>". These four
    // fixtures cover every outcome in src/governance/governancevote.cpp
    // ConvertOutcomeToString. If Core's format changes, these pins
    // fail first.
    const cases = [
      {
        input: `${H64_A}-0:1700000000:yes:funding`,
        expected: {
          collateralHash: H64_A,
          collateralIndex: 0,
          voteTime: 1700000000,
          voteOutcome: 'yes',
          voteSignal: 'funding',
        },
      },
      {
        input: `${H64_B}-7:1700000123:no:funding`,
        expected: {
          collateralHash: H64_B,
          collateralIndex: 7,
          voteTime: 1700000123,
          voteOutcome: 'no',
          voteSignal: 'funding',
        },
      },
      {
        input: `${H64_C}-1:1700000456:abstain:valid`,
        expected: {
          collateralHash: H64_C,
          collateralIndex: 1,
          voteTime: 1700000456,
          voteOutcome: 'abstain',
          voteSignal: 'valid',
        },
      },
      {
        input: `${H64_A}-2:1700000789:none:delete`,
        expected: {
          collateralHash: H64_A,
          collateralIndex: 2,
          voteTime: 1700000789,
          voteOutcome: 'none',
          voteSignal: 'delete',
        },
      },
      {
        input: `${H64_B}-3:1700000999:yes:endorsed`,
        expected: {
          collateralHash: H64_B,
          collateralIndex: 3,
          voteTime: 1700000999,
          voteOutcome: 'yes',
          voteSignal: 'endorsed',
        },
      },
    ];
    for (const { input, expected } of cases) {
      expect(parseVoteString(input)).toEqual(expected);
    }
  });

  test('lowercases the collateral txid', () => {
    const parsed = parseVoteString(`${H64_MIXED}-4:1700000000:yes:funding`);
    expect(parsed.collateralHash).toBe(H64_MIXED.toLowerCase());
  });

  test('accepts large vout indices (uint32 range)', () => {
    const parsed = parseVoteString(`${H64_A}-4294967295:1:yes:funding`);
    expect(parsed.collateralIndex).toBe(0xffffffff);
  });

  test.each([
    ['non-string', 42],
    ['empty string', ''],
    ['missing parts', `${H64_A}-0:1700000000:yes`],
    ['extra parts', `${H64_A}-0:1700000000:yes:funding:extra`],
    ['bad txid length', `${'a'.repeat(63)}-0:1700000000:yes:funding`],
    ['non-hex txid', `${'z'.repeat(64)}-0:1700000000:yes:funding`],
    ['negative vout', `${H64_A}--1:1700000000:yes:funding`],
    ['non-numeric vout', `${H64_A}-x:1700000000:yes:funding`],
    ['vout too large', `${H64_A}-4294967296:1700000000:yes:funding`],
    ['bad nTime', `${H64_A}-0:notanumber:yes:funding`],
    ['unknown outcome', `${H64_A}-0:1700000000:maybe:funding`],
    ['unknown signal', `${H64_A}-0:1700000000:yes:lunchmoney`],
    ['leading dash (empty txid)', `-0:1700000000:yes:funding`],
    ['trailing dash (empty vout)', `${H64_A}-:1700000000:yes:funding`],
  ])('rejects %s', (_label, input) => {
    expect(parseVoteString(input)).toBeNull();
  });
});

describe('parseCurrentVotes', () => {
  test('empty object returns empty array', () => {
    expect(parseCurrentVotes({})).toEqual([]);
  });

  test('null / array / non-object returns empty array', () => {
    expect(parseCurrentVotes(null)).toEqual([]);
    expect(parseCurrentVotes([])).toEqual([]);
    expect(parseCurrentVotes('nope')).toEqual([]);
    expect(parseCurrentVotes(undefined)).toEqual([]);
  });

  test('preserves voteHash key alongside parsed fields', () => {
    const voteHash = 'f'.repeat(64);
    const payload = {
      [voteHash]: `${H64_A}-0:1700000000:yes:funding`,
    };
    expect(parseCurrentVotes(payload)).toEqual([
      {
        voteHash,
        collateralHash: H64_A,
        collateralIndex: 0,
        voteTime: 1700000000,
        voteOutcome: 'yes',
        voteSignal: 'funding',
      },
    ]);
  });

  test('silently drops entries the parser rejects', () => {
    const good = 'f'.repeat(64);
    const bad = '0'.repeat(64);
    const payload = {
      [good]: `${H64_A}-0:1700000000:yes:funding`,
      [bad]: 'not-a-valid-vote-string',
    };
    const parsed = parseCurrentVotes(payload);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].voteHash).toBe(good);
  });
});

// -----------------------------------------------------------------------
// createVoteReceiptsRepo — persistence semantics
// -----------------------------------------------------------------------

describe('createVoteReceiptsRepo.upsert', () => {
  test('inserts a new row and returns the full record', () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_700_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    const r = repo.upsert({
      userId: userId1,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1700000000,
      status: 'relayed',
    });
    expect(r).toMatchObject({
      userId: userId1,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1700000000,
      status: 'relayed',
      lastError: null,
      submittedAt: 1_700_000_000_000,
      verifiedAt: null,
    });
    expect(typeof r.id).toBe('number');
  });

  test('UPSERTs in place on vote change, bumping submitted_at and clearing verified_at', () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_700_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    const first = repo.upsert({
      userId: userId1,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1700000000,
      status: 'confirmed',
    });
    // Simulate reconciler having stamped verified_at.
    db.prepare(
      `UPDATE vote_receipts SET verified_at = 1700000005000 WHERE id = ?`
    ).run(first.id);
    clock.advance(60_000);
    const second = repo.upsert({
      userId: userId1,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'no', // vote change
      voteSignal: 'funding',
      voteTime: 1700000060,
      status: 'relayed',
    });
    expect(second.id).toBe(first.id); // same row
    expect(second.voteOutcome).toBe('no');
    expect(second.status).toBe('relayed');
    expect(second.submittedAt).toBe(1_700_000_060_000);
    expect(second.verifiedAt).toBeNull();
  });

  test('lowercases collateralHash and proposalHash', () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    const upper = (H64_MIXED.toUpperCase());
    const propUpper = 'D'.repeat(64);
    const r = repo.upsert({
      userId: userId1,
      collateralHash: upper,
      collateralIndex: 1,
      proposalHash: propUpper,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'relayed',
    });
    expect(r.collateralHash).toBe(upper.toLowerCase());
    expect(r.proposalHash).toBe(propUpper.toLowerCase());
  });

  test.each([
    ['invalid userId', { userId: -1 }, /userId/],
    ['invalid collateralHash', { collateralHash: 'bad' }, /collateralHash/],
    ['invalid collateralIndex', { collateralIndex: -1 }, /collateralIndex/],
    ['invalid proposalHash', { proposalHash: 'bad' }, /proposalHash/],
    ['invalid voteOutcome', { voteOutcome: 'maybe' }, /voteOutcome/],
    ['invalid voteSignal', { voteSignal: 'nope' }, /voteSignal/],
    ['invalid voteTime', { voteTime: -1 }, /voteTime/],
    ['invalid status', { status: 'pending' }, /status/],
    ['invalid lastError', { lastError: 42 }, /lastError/],
  ])('rejects %s', (_label, override, pattern) => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    const base = {
      userId: userId1,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'relayed',
      lastError: null,
    };
    expect(() => repo.upsert({ ...base, ...override })).toThrow(pattern);
  });
});

describe('createVoteReceiptsRepo reads', () => {
  test('getByOutpoint returns null when nothing matches', () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    expect(
      repo.getByOutpoint({
        userId: userId1,
        collateralHash: H64_A,
        collateralIndex: 0,
        proposalHash: H64_PROP,
      })
    ).toBeNull();
  });

  test('listForProposal is ordered by submittedAt DESC', () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_000_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    repo.upsert({
      userId: userId1,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'relayed',
    });
    clock.advance(5_000);
    repo.upsert({
      userId: userId1,
      collateralHash: H64_B,
      collateralIndex: 1,
      proposalHash: H64_PROP,
      voteOutcome: 'no',
      voteSignal: 'funding',
      voteTime: 6,
      status: 'relayed',
    });
    const list = repo.listForProposal(userId1, H64_PROP);
    expect(list.map((r) => r.collateralHash)).toEqual([H64_B, H64_A]);
  });

  test('listForProposal is isolated per user', () => {
    const { db, userId1, userId2 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    repo.upsert({
      userId: userId1,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'relayed',
    });
    repo.upsert({
      userId: userId2,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'no',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'relayed',
    });
    expect(repo.listForProposal(userId1, H64_PROP)).toHaveLength(1);
    expect(repo.listForProposal(userId2, H64_PROP)).toHaveLength(1);
    expect(repo.listForProposal(userId1, H64_PROP)[0].voteOutcome).toBe('yes');
    expect(repo.listForProposal(userId2, H64_PROP)[0].voteOutcome).toBe('no');
  });

  test('summaryForUser aggregates per proposal with confirmed-outcome breakdown', () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_000_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    // Proposal A: 2 confirmed yes + 1 confirmed no + 1 failed.
    for (let i = 0; i < 2; i++) {
      repo.upsert({
        userId: userId1,
        collateralHash: 'a'.repeat(64),
        collateralIndex: i,
        proposalHash: H64_PROP,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1,
        status: 'confirmed',
      });
    }
    repo.upsert({
      userId: userId1,
      collateralHash: 'a'.repeat(64),
      collateralIndex: 2,
      proposalHash: H64_PROP,
      voteOutcome: 'no',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'confirmed',
    });
    repo.upsert({
      userId: userId1,
      collateralHash: 'a'.repeat(64),
      collateralIndex: 3,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'failed',
      lastError: 'signature_invalid',
    });
    // Proposal B: one stale, one relayed, one abstain confirmed.
    clock.advance(60_000);
    repo.upsert({
      userId: userId1,
      collateralHash: 'b'.repeat(64),
      collateralIndex: 0,
      proposalHash: H64_PROP_2,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 2,
      status: 'stale',
    });
    repo.upsert({
      userId: userId1,
      collateralHash: 'b'.repeat(64),
      collateralIndex: 1,
      proposalHash: H64_PROP_2,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 2,
      status: 'relayed',
    });
    repo.upsert({
      userId: userId1,
      collateralHash: 'b'.repeat(64),
      collateralIndex: 2,
      proposalHash: H64_PROP_2,
      voteOutcome: 'abstain',
      voteSignal: 'funding',
      voteTime: 2,
      status: 'confirmed',
    });

    const summary = repo.summaryForUser(userId1);
    // Ordered by latest submittedAt DESC → proposal B (newer upserts) first.
    expect(summary.map((s) => s.proposalHash)).toEqual([H64_PROP_2, H64_PROP]);
    const byHash = Object.fromEntries(summary.map((s) => [s.proposalHash, s]));
    expect(byHash[H64_PROP]).toMatchObject({
      total: 4,
      relayed: 0,
      confirmed: 3,
      stale: 0,
      failed: 1,
      confirmedYes: 2,
      confirmedNo: 1,
      confirmedAbstain: 0,
    });
    expect(byHash[H64_PROP_2]).toMatchObject({
      total: 3,
      relayed: 1,
      confirmed: 1,
      stale: 1,
      failed: 0,
      confirmedYes: 0,
      confirmedNo: 0,
      confirmedAbstain: 1,
    });
  });

  test('listRecent caps to 100 rows and respects custom limit', () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    for (let i = 0; i < 15; i++) {
      repo.upsert({
        userId: userId1,
        collateralHash: 'a'.repeat(64),
        collateralIndex: i,
        proposalHash: H64_PROP,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1,
        status: 'relayed',
      });
    }
    expect(repo.listRecent(userId1).length).toBe(10);
    expect(repo.listRecent(userId1, 5).length).toBe(5);
    expect(repo.listRecent(userId1, 999).length).toBe(15);
  });
});

// -----------------------------------------------------------------------
// decideRelay
// -----------------------------------------------------------------------

describe('createVoteReceiptsRepo.decideRelay', () => {
  function baseArgs(userId) {
    return {
      userId,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
    };
  }

  test('no existing receipt → relay', () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    expect(repo.decideRelay(baseArgs(userId1))).toEqual({ action: 'relay' });
  });

  test('confirmed same outcome → skip already_on_chain', () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    repo.upsert({
      ...baseArgs(userId1),
      voteTime: 1,
      status: 'confirmed',
    });
    const decision = repo.decideRelay(baseArgs(userId1));
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('already_on_chain');
  });

  test('confirmed different outcome → relay (vote change)', () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    repo.upsert({
      ...baseArgs(userId1),
      voteTime: 1,
      status: 'confirmed',
    });
    const decision = repo.decideRelay({
      ...baseArgs(userId1),
      voteOutcome: 'no',
    });
    expect(decision.action).toBe('relay');
    expect(decision.previous.voteOutcome).toBe('yes');
  });

  test('relayed same outcome within recent-relay window → skip recently_relayed', () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_000_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    repo.upsert({
      ...baseArgs(userId1),
      voteTime: 1,
      status: 'relayed',
    });
    clock.advance(DEFAULT_RECENT_RELAY_MS - 1);
    const decision = repo.decideRelay(baseArgs(userId1));
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('recently_relayed');
  });

  test('relayed same outcome beyond recent-relay window → relay', () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_000_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    repo.upsert({
      ...baseArgs(userId1),
      voteTime: 1,
      status: 'relayed',
    });
    clock.advance(DEFAULT_RECENT_RELAY_MS + 1);
    expect(repo.decideRelay(baseArgs(userId1)).action).toBe('relay');
  });

  test('failed receipt → relay', () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    repo.upsert({
      ...baseArgs(userId1),
      voteTime: 1,
      status: 'failed',
      lastError: 'signature_invalid',
    });
    expect(repo.decideRelay(baseArgs(userId1)).action).toBe('relay');
  });

  test('stale receipt → relay', () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    repo.upsert({
      ...baseArgs(userId1),
      voteTime: 1,
      status: 'stale',
    });
    expect(repo.decideRelay(baseArgs(userId1)).action).toBe('relay');
  });
});

// -----------------------------------------------------------------------
// reconcileForProposal
// -----------------------------------------------------------------------

describe('createVoteReceiptsRepo.reconcileForProposal', () => {
  function seed(repo, userId, overrides = {}) {
    return repo.upsert({
      userId,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'relayed',
      ...overrides,
    });
  }

  test('no receipts → no-op', async () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    const getCurrentVotes = jest.fn(async () => []);
    const result = await repo.reconcileForProposal({
      userId: userId1,
      proposalHash: H64_PROP,
      getCurrentVotes,
    });
    expect(result).toEqual({ updated: 0, receipts: [] });
    expect(getCurrentVotes).not.toHaveBeenCalled();
  });

  test('receipt found on chain → confirmed + verifiedAt set, adopts chain time', async () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_700_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    seed(repo, userId1);
    const getCurrentVotes = jest.fn(async () => [
      {
        voteHash: 'f'.repeat(64),
        collateralHash: H64_A,
        collateralIndex: 0,
        voteTime: 1700000123,
        voteOutcome: 'yes',
        voteSignal: 'funding',
      },
    ]);
    clock.advance(500);
    const { updated, receipts } = await repo.reconcileForProposal({
      userId: userId1,
      proposalHash: H64_PROP,
      getCurrentVotes,
    });
    expect(updated).toBe(1);
    expect(receipts[0]).toMatchObject({
      status: 'confirmed',
      voteTime: 1700000123,
      verifiedAt: 1_700_000_000_500,
      lastError: null,
    });
  });

  test('chain reports a different outcome → adopts chain (vote changed from another device)', async () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    seed(repo, userId1, { voteOutcome: 'yes' });
    const getCurrentVotes = async () => [
      {
        voteHash: 'f'.repeat(64),
        collateralHash: H64_A,
        collateralIndex: 0,
        voteTime: 1700000999,
        voteOutcome: 'no',
        voteSignal: 'funding',
      },
    ];
    const { receipts } = await repo.reconcileForProposal({
      userId: userId1,
      proposalHash: H64_PROP,
      getCurrentVotes,
    });
    expect(receipts[0]).toMatchObject({
      status: 'confirmed',
      voteOutcome: 'no',
      voteTime: 1700000999,
    });
  });

  test('previously failed receipt observed on chain → promoted to confirmed', async () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    seed(repo, userId1, { status: 'failed', lastError: 'rpc_error' });
    const getCurrentVotes = async () => [
      {
        voteHash: 'f'.repeat(64),
        collateralHash: H64_A,
        collateralIndex: 0,
        voteTime: 1700000123,
        voteOutcome: 'yes',
        voteSignal: 'funding',
      },
    ];
    const { receipts } = await repo.reconcileForProposal({
      userId: userId1,
      proposalHash: H64_PROP,
      getCurrentVotes,
    });
    expect(receipts[0]).toMatchObject({
      status: 'confirmed',
      lastError: null,
    });
  });

  test('relayed receipt absent beyond grace window → stale', async () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_000_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    seed(repo, userId1);
    const getCurrentVotes = async () => [];
    clock.advance(DEFAULT_STALE_GRACE_MS + 1);
    const { updated, receipts } = await repo.reconcileForProposal({
      userId: userId1,
      proposalHash: H64_PROP,
      getCurrentVotes,
    });
    expect(updated).toBe(1);
    expect(receipts[0].status).toBe('stale');
  });

  test('relayed receipt absent within grace window → left as relayed', async () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_000_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    seed(repo, userId1);
    const getCurrentVotes = async () => [];
    clock.advance(30_000);
    const { updated, receipts } = await repo.reconcileForProposal({
      userId: userId1,
      proposalHash: H64_PROP,
      getCurrentVotes,
    });
    expect(updated).toBe(0);
    expect(receipts[0].status).toBe('relayed');
  });

  test('failed receipt stays failed when still absent from chain', async () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_000_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    seed(repo, userId1, { status: 'failed', lastError: 'mn_not_found' });
    const getCurrentVotes = async () => [];
    clock.advance(DEFAULT_STALE_GRACE_MS + 1);
    const { updated, receipts } = await repo.reconcileForProposal({
      userId: userId1,
      proposalHash: H64_PROP,
      getCurrentVotes,
    });
    expect(updated).toBe(0);
    expect(receipts[0].status).toBe('failed');
    expect(receipts[0].lastError).toBe('mn_not_found');
  });

  test('previously confirmed receipt absent from current tally → left confirmed', async () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_000_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    seed(repo, userId1, { status: 'confirmed' });
    db.prepare(
      `UPDATE vote_receipts SET verified_at = 999_000_000_000 WHERE user_id = ?`
    ).run(userId1);
    const getCurrentVotes = async () => [];
    clock.advance(DEFAULT_STALE_GRACE_MS + 1);
    const { updated, receipts } = await repo.reconcileForProposal({
      userId: userId1,
      proposalHash: H64_PROP,
      getCurrentVotes,
    });
    expect(updated).toBe(0);
    expect(receipts[0].status).toBe('confirmed');
  });

  test('mixed batch: one confirmed, one stale, one failed, one relayed-in-grace', async () => {
    const { db, userId1 } = mkDbWithUsers();
    const clock = clockFromMs(1_000_000_000_000);
    const repo = createVoteReceiptsRepo(db, { now: clock.now });
    // MN A: relayed, chain has it → should become confirmed.
    repo.upsert({
      userId: userId1,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'relayed',
    });
    // MN B: relayed long ago, chain absent → should become stale.
    clock.set(500_000_000_000); // older submission
    repo.upsert({
      userId: userId1,
      collateralHash: H64_B,
      collateralIndex: 1,
      proposalHash: H64_PROP,
      voteOutcome: 'no',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'relayed',
    });
    // MN C: failed, chain absent → left alone.
    repo.upsert({
      userId: userId1,
      collateralHash: H64_C,
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'failed',
      lastError: 'signature_invalid',
    });
    // MN D: relayed recently (in grace), chain absent → left alone.
    clock.set(2_000_000_000_000 - 30_000);
    repo.upsert({
      userId: userId1,
      collateralHash: 'd'.repeat(64),
      collateralIndex: 0,
      proposalHash: H64_PROP,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      voteTime: 1,
      status: 'relayed',
    });
    clock.set(2_000_000_000_000);
    const getCurrentVotes = async () => [
      {
        voteHash: 'f'.repeat(64),
        collateralHash: H64_A,
        collateralIndex: 0,
        voteTime: 1700000123,
        voteOutcome: 'yes',
        voteSignal: 'funding',
      },
    ];
    const { updated, receipts } = await repo.reconcileForProposal({
      userId: userId1,
      proposalHash: H64_PROP,
      getCurrentVotes,
    });
    // A → confirmed, B → stale = 2 updates.
    expect(updated).toBe(2);
    const byHash = Object.fromEntries(
      receipts.map((r) => [r.collateralHash, r])
    );
    expect(byHash[H64_A].status).toBe('confirmed');
    expect(byHash[H64_B].status).toBe('stale');
    expect(byHash[H64_C].status).toBe('failed');
    expect(byHash['d'.repeat(64)].status).toBe('relayed');
  });

  test('RPC error → reconcile_rpc_failed, no row mutated', async () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    const seeded = seed(repo, userId1);
    const getCurrentVotes = jest.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      repo.reconcileForProposal({
        userId: userId1,
        proposalHash: H64_PROP,
        getCurrentVotes,
      })
    ).rejects.toThrow('reconcile_rpc_failed');
    const after = repo.getByOutpoint({
      userId: userId1,
      collateralHash: H64_A,
      collateralIndex: 0,
      proposalHash: H64_PROP,
    });
    expect(after.status).toBe('relayed');
    expect(after.submittedAt).toBe(seeded.submittedAt);
  });

  test('getCurrentVotes returning non-array → throws, no mutation', async () => {
    const { db, userId1 } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    seed(repo, userId1);
    await expect(
      repo.reconcileForProposal({
        userId: userId1,
        proposalHash: H64_PROP,
        getCurrentVotes: async () => 'nope',
      })
    ).rejects.toThrow(/must return an array/);
  });

  test('rejects invalid inputs synchronously', async () => {
    const { db } = mkDbWithUsers();
    const repo = createVoteReceiptsRepo(db);
    await expect(
      repo.reconcileForProposal({
        userId: -1,
        proposalHash: H64_PROP,
        getCurrentVotes: async () => [],
      })
    ).rejects.toThrow(/userId/);
    await expect(
      repo.reconcileForProposal({
        userId: 1,
        proposalHash: 'bad',
        getCurrentVotes: async () => [],
      })
    ).rejects.toThrow(/proposalHash/);
    await expect(
      repo.reconcileForProposal({
        userId: 1,
        proposalHash: H64_PROP,
      })
    ).rejects.toThrow(/getCurrentVotes/);
  });
});

// -----------------------------------------------------------------------
// createCurrentVotesCache
// -----------------------------------------------------------------------

describe('createCurrentVotesCache', () => {
  test('rejects invalid construction', () => {
    expect(() => createCurrentVotesCache({})).toThrow(/callRpc/);
  });

  test('parses and caches within TTL; second call does not hit RPC', async () => {
    const clock = clockFromMs(0);
    const callRpc = jest.fn(async () => ({
      ['f'.repeat(64)]: `${H64_A}-0:1700000000:yes:funding`,
    }));
    const cache = createCurrentVotesCache({
      callRpc,
      ttlMs: 60_000,
      now: clock.now,
    });
    const first = await cache.get(H64_PROP);
    expect(first).toEqual([
      {
        voteHash: 'f'.repeat(64),
        collateralHash: H64_A,
        collateralIndex: 0,
        voteTime: 1700000000,
        voteOutcome: 'yes',
        voteSignal: 'funding',
      },
    ]);
    clock.advance(30_000);
    const second = await cache.get(H64_PROP);
    expect(second).toBe(first); // reference-identical (same cached promise resolves to same array)
    expect(callRpc).toHaveBeenCalledTimes(1);
  });

  test('cache misses after TTL expires', async () => {
    const clock = clockFromMs(0);
    const callRpc = jest.fn(async () => ({}));
    const cache = createCurrentVotesCache({
      callRpc,
      ttlMs: 60_000,
      now: clock.now,
    });
    await cache.get(H64_PROP);
    clock.advance(60_001);
    await cache.get(H64_PROP);
    expect(callRpc).toHaveBeenCalledTimes(2);
  });

  test('invalidate() drops the cached entry', async () => {
    const callRpc = jest.fn(async () => ({}));
    const cache = createCurrentVotesCache({ callRpc });
    await cache.get(H64_PROP);
    cache.invalidate(H64_PROP);
    await cache.get(H64_PROP);
    expect(callRpc).toHaveBeenCalledTimes(2);
  });

  test('concurrent callers share one in-flight RPC (thundering-herd guard)', async () => {
    // Defer the RPC resolution so the three cache.get() calls all land
    // while the first is still in flight. A single deferred promise the
    // RPC awaits internally serialises the "gate" without race.
    let openGate;
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });
    const callRpc = jest.fn(async () => {
      await gate;
      return {};
    });
    const cache = createCurrentVotesCache({ callRpc });
    const p1 = cache.get(H64_PROP);
    const p2 = cache.get(H64_PROP);
    const p3 = cache.get(H64_PROP);
    openGate();
    await Promise.all([p1, p2, p3]);
    expect(callRpc).toHaveBeenCalledTimes(1);
  });

  test('failed call evicts so next caller retries', async () => {
    let turn = 0;
    const callRpc = jest.fn(async () => {
      turn += 1;
      if (turn === 1) throw new Error('rpc down');
      return {};
    });
    const cache = createCurrentVotesCache({ callRpc });
    await expect(cache.get(H64_PROP)).rejects.toThrow(/rpc down/);
    await expect(cache.get(H64_PROP)).resolves.toEqual([]);
    expect(callRpc).toHaveBeenCalledTimes(2);
  });

  test('rejects invalid proposalHash', async () => {
    const cache = createCurrentVotesCache({ callRpc: async () => ({}) });
    await expect(cache.get('bad')).rejects.toThrow(/invalid_proposal_hash/);
  });

  test('proposalHash is lowercased for cache keying', async () => {
    const callRpc = jest.fn(async () => ({}));
    const cache = createCurrentVotesCache({ callRpc });
    const upper = 'D'.repeat(64);
    const lower = 'd'.repeat(64);
    await cache.get(upper);
    await cache.get(lower);
    expect(callRpc).toHaveBeenCalledTimes(1);
    // callRpc was called with the lowercased form.
    expect(callRpc).toHaveBeenCalledWith(lower);
  });
});
