'use strict';

const { openDatabase } = require('./db');
const { createProposalDraftsRepo } = require('./proposalDrafts');

const FAKE_SALT_V = 'aa'.repeat(32);

function seedUser(db, email = 'u@x.com') {
  const t = Date.now();
  const r = db
    .prepare(
      `INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, 'hash', FAKE_SALT_V, t, t);
  return Number(r.lastInsertRowid);
}

// Inject a now() we control so updated_at ordering is predictable.
function setup() {
  const db = openDatabase(':memory:');
  const user1 = seedUser(db, 'a@x.com');
  const user2 = seedUser(db, 'b@x.com');
  let clock = 1_700_000_000_000;
  const repo = createProposalDraftsRepo(db, { now: () => clock });
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

describe('proposalDrafts.create', () => {
  test('creates a draft with defaults when patch is empty', () => {
    const { repo, user1 } = setup();
    const d = repo.create(user1);
    expect(d.id).toEqual(expect.any(Number));
    expect(d.userId).toBe(user1);
    expect(d.title).toBe('');
    expect(d.name).toBe('');
    expect(d.url).toBe('');
    expect(d.description).toBe('');
    expect(d.paymentAddress).toBe('');
    expect(d.paymentAmountSats).toBe(0n);
    expect(d.paymentCount).toBe(1);
    expect(d.startEpoch).toBeNull();
    expect(d.endEpoch).toBeNull();
    expect(d.createdAt).toBe(d.updatedAt);
  });

  test('persists all provided fields', () => {
    const { repo, user1 } = setup();
    const d = repo.create(user1, {
      title: 'My first proposal',
      name: 'my-first',
      url: 'https://ex.co/p',
      description: 'pitch text',
      payment_address: 'sys1qaaa',
      payment_amount_sats: 4250000000n,
      payment_count: 3,
      start_epoch: 1800000000,
      end_epoch: 1802592000,
    });
    expect(d.title).toBe('My first proposal');
    expect(d.name).toBe('my-first');
    expect(d.url).toBe('https://ex.co/p');
    expect(d.description).toBe('pitch text');
    expect(d.paymentAddress).toBe('sys1qaaa');
    expect(d.paymentAmountSats).toBe(4250000000n);
    expect(d.paymentCount).toBe(3);
    expect(d.startEpoch).toBe(1800000000);
    expect(d.endEpoch).toBe(1802592000);
  });

  test('accepts payment_amount_sats as number, bigint, or digit-string', () => {
    const { repo, user1 } = setup();
    const a = repo.create(user1, { payment_amount_sats: 100 });
    const b = repo.create(user1, { payment_amount_sats: 100n });
    const c = repo.create(user1, { payment_amount_sats: '100' });
    expect(a.paymentAmountSats).toBe(100n);
    expect(b.paymentAmountSats).toBe(100n);
    expect(c.paymentAmountSats).toBe(100n);
  });

  test('preserves precision for BigInt values beyond 2^53', () => {
    const { repo, user1 } = setup();
    // 2^54 = 18014398509481984
    const huge = 18014398509481984n;
    const d = repo.create(user1, { payment_amount_sats: huge });
    expect(d.paymentAmountSats).toBe(huge);
    const fetched = repo.getByIdForUser(d.id, user1);
    expect(fetched.paymentAmountSats).toBe(huge);
  });

  test('rejects non-integer number amounts', () => {
    const { repo, user1 } = setup();
    expect(() =>
      repo.create(user1, { payment_amount_sats: 1.5 })
    ).toThrow(/integer/);
  });

  test('rejects non-digit string amounts', () => {
    const { repo, user1 } = setup();
    expect(() =>
      repo.create(user1, { payment_amount_sats: 'abc' })
    ).toThrow(/digits/);
  });
});

describe('proposalDrafts.getByIdForUser', () => {
  test('returns the draft for its owner', () => {
    const { repo, user1 } = setup();
    const d = repo.create(user1, { title: 'owner' });
    expect(repo.getByIdForUser(d.id, user1).title).toBe('owner');
  });

  test('returns null for a non-owner', () => {
    const { repo, user1, user2 } = setup();
    const d = repo.create(user1, { title: 'secret' });
    expect(repo.getByIdForUser(d.id, user2)).toBeNull();
  });

  test('returns null for an unknown id', () => {
    const { repo, user1 } = setup();
    expect(repo.getByIdForUser(999999, user1)).toBeNull();
  });
});

describe('proposalDrafts.listForUser', () => {
  test('lists user\u2019s drafts most-recent-first', () => {
    const { repo, user1, tick } = setup();
    const first = repo.create(user1, { title: 'first' });
    tick(1000);
    const second = repo.create(user1, { title: 'second' });
    const list = repo.listForUser(user1);
    expect(list.map((d) => d.id)).toEqual([second.id, first.id]);
  });

  test('isolates users', () => {
    const { repo, user1, user2 } = setup();
    repo.create(user1, { title: 'mine' });
    repo.create(user2, { title: 'theirs' });
    expect(repo.listForUser(user1).map((d) => d.title)).toEqual(['mine']);
    expect(repo.listForUser(user2).map((d) => d.title)).toEqual(['theirs']);
  });

  test('returns [] for a user with no drafts', () => {
    const { repo, user1 } = setup();
    expect(repo.listForUser(user1)).toEqual([]);
  });
});

describe('proposalDrafts.countForUser', () => {
  test('counts only the caller\u2019s drafts', () => {
    const { repo, user1, user2 } = setup();
    repo.create(user1);
    repo.create(user1);
    repo.create(user2);
    expect(repo.countForUser(user1)).toBe(2);
    expect(repo.countForUser(user2)).toBe(1);
  });
});

describe('proposalDrafts.update', () => {
  test('applies partial updates and bumps updated_at', () => {
    const { repo, user1, tick } = setup();
    const d = repo.create(user1, { title: 'before', url: 'https://a' });
    tick(2000);
    const updated = repo.update(d.id, user1, { title: 'after' });
    expect(updated.title).toBe('after');
    expect(updated.url).toBe('https://a'); // unchanged
    expect(updated.updatedAt).toBeGreaterThan(d.updatedAt);
  });

  test('returns null when the user does not own the draft', () => {
    const { repo, user1, user2 } = setup();
    const d = repo.create(user1, { title: 'mine' });
    expect(repo.update(d.id, user2, { title: 'hacked' })).toBeNull();
  });

  test('returns null when the id does not exist', () => {
    const { repo, user1 } = setup();
    expect(repo.update(9999, user1, { title: 'x' })).toBeNull();
  });

  test('empty patch is a no-op that still touches updated_at', () => {
    const { repo, user1, tick } = setup();
    const d = repo.create(user1, { title: 'x' });
    tick(1000);
    const after = repo.update(d.id, user1, {});
    expect(after.updatedAt).toBeGreaterThan(d.updatedAt);
    expect(after.title).toBe('x');
  });

  test('can null-out start/end epochs', () => {
    const { repo, user1 } = setup();
    const d = repo.create(user1, {
      start_epoch: 1800000000,
      end_epoch: 1802592000,
    });
    const after = repo.update(d.id, user1, {
      start_epoch: null,
      end_epoch: null,
    });
    expect(after.startEpoch).toBeNull();
    expect(after.endEpoch).toBeNull();
  });

  test('ignores unknown keys (defense in depth)', () => {
    const { repo, user1 } = setup();
    const d = repo.create(user1, { title: 'original' });
    const after = repo.update(d.id, user1, {
      title: 'updated',
      not_a_field: 'should_be_ignored',
    });
    expect(after.title).toBe('updated');
  });
});

describe('proposalDrafts.remove', () => {
  test('removes the caller\u2019s draft and returns 1', () => {
    const { repo, user1 } = setup();
    const d = repo.create(user1);
    expect(repo.remove(d.id, user1)).toBe(1);
    expect(repo.getByIdForUser(d.id, user1)).toBeNull();
  });

  test('returns 0 when the caller does not own the draft', () => {
    const { repo, user1, user2 } = setup();
    const d = repo.create(user1);
    expect(repo.remove(d.id, user2)).toBe(0);
    // Draft still exists for the owner
    expect(repo.getByIdForUser(d.id, user1)).not.toBeNull();
  });

  test('returns 0 for unknown id', () => {
    const { repo, user1 } = setup();
    expect(repo.remove(9999, user1)).toBe(0);
  });
});

describe('proposalDrafts cascade on user delete', () => {
  test('drafts vanish when their owner is deleted', () => {
    const { db, repo, user1 } = setup();
    repo.create(user1, { title: 't1' });
    repo.create(user1, { title: 't2' });
    db.prepare('DELETE FROM users WHERE id = ?').run(user1);
    expect(repo.listForUser(user1)).toEqual([]);
  });
});
