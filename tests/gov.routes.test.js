const request = require('supertest');
const { buildTestApp } = require('./helpers/buildTestApp');

const SAMPLE_AUTH =
  'a4f8b3c1d9e7f2a5b1c6d8e4f7a9b2c5d1e8f4a7b3c9d5e1f6a2b8c4d7e3f5a9';

// Deterministic 64-hex constants we can reuse across cases.
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

// 65 raw bytes = 88 base64 chars with padding. Real signatures are
// produced client-side; for HTTP plumbing tests we only need
// something that passes validateVoteBody.
// Canonical 65-byte base64 sig (all zero bytes). See gov.test.js for
// the full rationale; short version: "A".repeat(86)+"==" decodes to
// 64 bytes and is rejected by the strict validator.
const SIG = Buffer.alloc(65).toString('base64');

function extractCookies(res) {
  const raw = res.headers['set-cookie'] || [];
  const map = {};
  for (const c of raw) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    map[k] = v;
  }
  return map;
}

// Build a logged-in supertest agent on top of a test app. We register,
// verify, and log in a single user; the returned CSRF token is read
// from the `csrf` cookie emitted by /auth/login.
async function loggedInAgent(ctx, email = 'user@example.com') {
  const agent = request.agent(ctx.app);
  await agent
    .post('/auth/register')
    .send({ email, authHash: SAMPLE_AUTH });
  const token = ctx.mailer.outbox
    .find((m) => m.to === email)
    .html.match(/token=([0-9a-f]{64})/)[1];
  await agent.post('/auth/verify-email').send({ token });
  const loginRes = await agent
    .post('/auth/login')
    .send({ email, authHash: SAMPLE_AUTH });
  const csrf = extractCookies(loginRes).csrf;
  return { agent, csrf };
}

// The production masternodesProvider reads `dataStore.masternodesArr`
// live on every call so the tracker's 10s refresh is visible without
// route code holding a stale reference. Our tests mirror that with a
// mutable `state` object whose `masternodes` property can be swapped
// between requests.
function buildApp({
  masternodes = [
    { collateralHash: H2, collateralIndex: 0 },
    { collateralHash: H3, collateralIndex: 1 },
  ],
  voteRaw,
  getCurrentVotes,
  invalidateCurrentVotes,
} = {}) {
  const state = { masternodes };
  const calls = [];
  const rawFn =
    voteRaw ||
    (async (...args) => {
      calls.push(args);
      return 'Voted successfully';
    });
  const ctx = buildTestApp({
    masternodesProvider: () => state.masternodes,
    voteRaw: rawFn,
    getCurrentVotes,
    invalidateCurrentVotes,
  });
  return { ctx, state, calls };
}

describe('POST /gov/mns/lookup', () => {
  let ctx;
  let state;

  beforeEach(() => {
    ({ ctx, state } = buildApp({
      masternodes: [
        {
          votingaddress: 'sys1qalice',
          proTxHash: H1,
          collateralHash: H2,
          collateralIndex: 0,
          status: 'ENABLED',
          address: '1.2.3.4:8369',
          payee: 'sys1qpayeeA',
        },
        {
          votingaddress: 'sys1qbob',
          proTxHash: H2,
          collateralHash: H3,
          collateralIndex: 1,
          status: 'ENABLED',
          address: '5.6.7.8:8369',
          payee: 'sys1qpayeeB',
        },
      ],
    }));
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('401 when unauthenticated', async () => {
    const res = await request(ctx.app)
      .post('/gov/mns/lookup')
      .send({ votingAddresses: ['sys1qalice'] });
    expect(res.status).toBe(401);
  });

  test('403 csrf_missing when authenticated without CSRF token', async () => {
    const { agent } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/mns/lookup')
      .send({ votingAddresses: ['sys1qalice'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_missing');
  });

  test('returns matches for known voting addresses', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/mns/lookup')
      .set('X-CSRF-Token', csrf)
      .send({ votingAddresses: ['sys1qalice', 'sys1qbob'] });
    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(2);
    const v = res.body.matches.map((m) => m.votingaddress).sort();
    expect(v).toEqual(['sys1qalice', 'sys1qbob']);
    // Projection must include collateral fields so the client can
    // feed them straight into POST /gov/vote without a second lookup.
    const alice = res.body.matches.find(
      (m) => m.votingaddress === 'sys1qalice'
    );
    expect(alice.collateralHash).toBe(H2);
    expect(alice.collateralIndex).toBe(0);
    expect(alice.status).toBe('ENABLED');
  });

  test('unknown addresses are silently dropped (no 400)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/mns/lookup')
      .set('X-CSRF-Token', csrf)
      .send({
        votingAddresses: ['sys1qalice', 'sys1qwho', 'sys1qnope'],
      });
    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].votingaddress).toBe('sys1qalice');
  });

  test('empty array returns empty matches (200)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/mns/lookup')
      .set('X-CSRF-Token', csrf)
      .send({ votingAddresses: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matches: [] });
  });

  test('reflects mutations to the tracker between requests', async () => {
    // The router takes `masternodesProvider` as a callable, not a
    // snapshot. This test guarantees that a tracker refresh visible
    // to the provider is visible to a subsequent request — i.e. we
    // aren't caching the array.
    const { agent, csrf } = await loggedInAgent(ctx);
    const before = await agent
      .post('/gov/mns/lookup')
      .set('X-CSRF-Token', csrf)
      .send({ votingAddresses: ['sys1qcarol'] });
    expect(before.body.matches).toEqual([]);

    state.masternodes = [
      ...state.masternodes,
      {
        votingaddress: 'sys1qcarol',
        proTxHash: 'd'.repeat(64),
        collateralHash: 'e'.repeat(64),
        collateralIndex: 2,
        status: 'ENABLED',
        address: '9.9.9.9:8369',
        payee: 'sys1qpayeeC',
      },
    ];

    const after = await agent
      .post('/gov/mns/lookup')
      .set('X-CSRF-Token', csrf)
      .send({ votingAddresses: ['sys1qcarol'] });
    expect(after.body.matches).toHaveLength(1);
    expect(after.body.matches[0].collateralIndex).toBe(2);
  });

  test('rejects non-array votingAddresses with 400 invalid_body', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/mns/lookup')
      .set('X-CSRF-Token', csrf)
      .send({ votingAddresses: 'sys1qalice' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });
});

describe('POST /gov/vote', () => {
  function validVoteBody(overrides = {}) {
    return {
      proposalHash: H1,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      time: Math.floor(Date.now() / 1000),
      entries: [
        { collateralHash: H2, collateralIndex: 0, voteSig: SIG },
        { collateralHash: H3, collateralIndex: 1, voteSig: SIG },
      ],
      ...overrides,
    };
  }

  test('401 when unauthenticated', async () => {
    const { ctx } = buildApp();
    try {
      const res = await request(ctx.app)
        .post('/gov/vote')
        .send(validVoteBody());
      expect(res.status).toBe(401);
    } finally {
      ctx.db.close();
    }
  });

  test('403 csrf_missing when authenticated without CSRF token', async () => {
    const { ctx } = buildApp();
    try {
      const { agent } = await loggedInAgent(ctx);
      const res = await agent.post('/gov/vote').send(validVoteBody());
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('csrf_missing');
    } finally {
      ctx.db.close();
    }
  });

  test('relays per-entry votes via voteRaw and returns per-entry results', async () => {
    const { ctx, calls } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const body = validVoteBody();
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(body);
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(2);
      expect(res.body.rejected).toBe(0);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results.every((r) => r.ok)).toBe(true);

      // voteRaw arg order must match Core's voteraw RPC:
      // (collateralHash, collateralIndex, govHash, signal, outcome, time, sig)
      expect(calls).toHaveLength(2);
      const [cHash, cIdx, gHash, signal, outcome, time, sig] = calls[0];
      expect(cHash).toBe(H2);
      expect(cIdx).toBe(0);
      expect(gHash).toBe(H1);
      expect(signal).toBe('funding');
      expect(outcome).toBe('yes');
      expect(time).toBe(body.time);
      expect(sig).toBe(SIG);
    } finally {
      ctx.db.close();
    }
  });

  test('mixed success/failure returns 200 with per-entry errors', async () => {
    const voteRaw = jest
      .fn()
      .mockResolvedValueOnce('Voted successfully')
      .mockRejectedValueOnce(new Error('Masternode voting too often'));
    const { ctx } = buildApp({ voteRaw });
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(validVoteBody());
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(1);
      expect(res.body.rejected).toBe(1);
      const failing = res.body.results.find((r) => !r.ok);
      // Core's error message is mapped to a stable UI code.
      expect(failing.error).toBe('vote_too_often');
    } finally {
      ctx.db.close();
    }
  });

  test('unknown RPC errors collapse to rpc_error (no leakage of node internals)', async () => {
    const voteRaw = jest
      .fn()
      .mockRejectedValue(new Error('random internal RPC blowup #42'));
    const { ctx } = buildApp({ voteRaw });
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(validVoteBody());
      expect(res.status).toBe(200);
      expect(res.body.results.every((r) => r.error === 'rpc_error')).toBe(
        true
      );
    } finally {
      ctx.db.close();
    }
  });

  test('prechecks collateral outpoints against the current masternode cache before voteraw', async () => {
    const { ctx, calls } = buildApp({
      masternodes: [{ collateralHash: H2, collateralIndex: 0 }],
    });
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(validVoteBody());
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(1);
      expect(res.body.rejected).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(H2);
      expect(res.body.results[1]).toMatchObject({
        collateralHash: H3,
        collateralIndex: 1,
        ok: false,
        error: 'mn_not_found',
      });
    } finally {
      ctx.db.close();
    }
  });

  test('fails closed while the masternode cache is empty or warming', async () => {
    const { ctx, calls } = buildApp({ masternodes: [] });
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(validVoteBody());
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('masternode_cache_empty');
      expect(calls).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  test('fails closed when the masternode cache snapshot is stale', async () => {
    const { ctx, calls } = buildApp({
      masternodes: {
        masternodes: [{ collateralHash: H2, collateralIndex: 0 }],
        updatedAt: Date.now() - 60_000,
      },
    });
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(validVoteBody());
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('masternode_cache_stale');
      expect(calls).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  test('400 invalid_proposal_hash when proposalHash is malformed', async () => {
    const { ctx } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(validVoteBody({ proposalHash: 'not-hex' }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_proposal_hash');
    } finally {
      ctx.db.close();
    }
  });

  test('400 unsupported_vote_signal when voteSignal is not "funding"', async () => {
    // PR 5 enforces funding-only because other signals need the
    // operator BLS key, which the vault does not hold.
    const { ctx } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(validVoteBody({ voteSignal: 'valid' }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unsupported_vote_signal');
    } finally {
      ctx.db.close();
    }
  });

  test('400 no_entries when entries is empty', async () => {
    const { ctx } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(validVoteBody({ entries: [] }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('no_entries');
    } finally {
      ctx.db.close();
    }
  });

  test('400 on duplicate (collateralHash,index) entries', async () => {
    const { ctx } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(
          validVoteBody({
            entries: [
              { collateralHash: H2, collateralIndex: 0, voteSig: SIG },
              { collateralHash: H2, collateralIndex: 0, voteSig: SIG },
            ],
          })
        );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/^duplicate_entry:/);
    } finally {
      ctx.db.close();
    }
  });
});

describe('POST /gov/vote — receipts integration', () => {
  function vote(proposal, overrides = {}) {
    return {
      proposalHash: proposal,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      time: Math.floor(Date.now() / 1000),
      entries: [
        { collateralHash: H2, collateralIndex: 0, voteSig: SIG },
        { collateralHash: H3, collateralIndex: 1, voteSig: SIG },
      ],
      ...overrides,
    };
  }

  async function userIdFor(ctx, email) {
    // The users repo exposes `findByEmail` via ctx.users, which we
    // can reach from the appFactory return value.
    const row = ctx.users.findByEmail(email);
    return row && row.id;
  }

  test('successful votes persist receipts with status=relayed', async () => {
    const { ctx } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'alice@example.com');
      await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(vote(H1))
        .expect(200);
      const uid = await userIdFor(ctx, 'alice@example.com');
      const receipts = ctx.voteReceipts.listForProposal(uid, H1);
      expect(receipts).toHaveLength(2);
      const statuses = receipts.map((r) => r.status).sort();
      expect(statuses).toEqual(['relayed', 'relayed']);
      for (const r of receipts) {
        expect(r.voteOutcome).toBe('yes');
        expect(r.voteSignal).toBe('funding');
        expect(r.lastError).toBeNull();
        expect(r.verifiedAt).toBeNull();
      }
    } finally {
      ctx.db.close();
    }
  });

  test('failed votes persist receipts with status=failed and the classified code', async () => {
    const voteRaw = jest.fn().mockImplementation((hash) => {
      if (hash === H2) return Promise.resolve('ok');
      return Promise.reject(new Error('Failure to verify vote.'));
    });
    const { ctx } = buildApp({ voteRaw });
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'bob@example.com');
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(vote(H1));
      expect(res.status).toBe(200);
      const uid = await userIdFor(ctx, 'bob@example.com');
      const all = ctx.voteReceipts.listForProposal(uid, H1);
      const byOutpoint = Object.fromEntries(
        all.map((r) => [`${r.collateralHash}:${r.collateralIndex}`, r])
      );
      expect(byOutpoint[`${H2}:0`]).toMatchObject({
        status: 'relayed',
        lastError: null,
      });
      expect(byOutpoint[`${H3}:1`]).toMatchObject({
        status: 'failed',
        lastError: 'signature_invalid',
      });
    } finally {
      ctx.db.close();
    }
  });

  test('already-on-chain short-circuit: second vote with same outcome skips voteraw', async () => {
    const { ctx, calls } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'carol@example.com');
      const uid = await userIdFor(ctx, 'carol@example.com');
      // Seed a confirmed receipt for entry 0 so decideRelay
      // short-circuits it on the next POST. We also stamp
      // verified_at so decideRelay treats the confirmation as
      // authoritative — an unverified 'confirmed' row (never happens
      // via the reconciler, but possible here via raw upsert) is
      // intentionally treated as stale so a silent vote suppression
      // can't happen.
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: Math.floor(Date.now() / 1000),
        status: 'confirmed',
      });
      ctx.db
        .prepare(
          `UPDATE vote_receipts SET verified_at = ? WHERE user_id = ?`
        )
        .run(Date.now(), uid);
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(vote(H1));
      expect(res.status).toBe(200);
      // Only the non-confirmed entry hit the RPC.
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(H3);
      // Response flags the skipped row so the UI can render
      // "already on-chain" instead of the neutral "accepted".
      const byIdx = Object.fromEntries(
        res.body.results.map((r) => [r.collateralIndex, r])
      );
      expect(byIdx[0]).toMatchObject({
        ok: true,
        skipped: 'already_on_chain',
      });
      expect(byIdx[1]).toMatchObject({ ok: true });
      expect(byIdx[1].skipped).toBeUndefined();
    } finally {
      ctx.db.close();
    }
  });

  test('stale-confirmed: a confirmation older than the freshness window falls through to relay', async () => {
    // Codex-review guard: without a freshness check, a user who
    // changed their vote from another wallet would have their
    // subsequent submission here silently suppressed ("already on
    // chain") even though the chain has since been updated. When
    // verified_at is older than the freshness window we MUST relay
    // to give the current intent a chance to actually reach Core.
    const { ctx, calls } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'freya@example.com');
      const uid = await userIdFor(ctx, 'freya@example.com');
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: Math.floor(Date.now() / 1000),
        status: 'confirmed',
      });
      // Stamp verified_at far in the past (1 hour) — well beyond
      // the default 5-minute freshness window.
      ctx.db
        .prepare(`UPDATE vote_receipts SET verified_at = ? WHERE user_id = ?`)
        .run(Date.now() - 60 * 60 * 1000, uid);
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(vote(H1));
      expect(res.status).toBe(200);
      // Every entry (including the one with the stale-confirmed
      // receipt at index 0) hit the RPC.
      const rpcOutpoints = calls.map((c) => `${c[0]}:${c[1]}`).sort();
      expect(rpcOutpoints).toEqual([`${H2}:0`, `${H3}:1`].sort());
      // And no row was reported as "already_on_chain" — the stale
      // row was relayed, not short-circuited.
      for (const r of res.body.results) {
        expect(r.skipped).not.toBe('already_on_chain');
      }
    } finally {
      ctx.db.close();
    }
  });

  test('POST /gov/vote invalidates the current-votes cache for the proposal', async () => {
    // Codex-review guard: without cache invalidation, /gov/receipts
    // called shortly after a vote relay would reconcile against a
    // pre-relay snapshot (TTL ~2 min), delaying the
    // relayed→confirmed transition or, worse, re-confirming an old
    // outcome after a vote change. Asserting the route calls the
    // injected invalidator with the proposal hash pins the wiring.
    const invalidateCurrentVotes = jest.fn();
    const { ctx } = buildApp({ invalidateCurrentVotes });
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'iris@example.com');
      await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(vote(H1))
        .expect(200);
      expect(invalidateCurrentVotes).toHaveBeenCalledTimes(1);
      expect(invalidateCurrentVotes).toHaveBeenCalledWith(H1);
    } finally {
      ctx.db.close();
    }
  });

  test('invalidateCurrentVotes throwing does not fail the vote response', async () => {
    // The invalidator is a best-effort cache eviction — if it throws
    // (e.g. the cache was disposed during a shutdown race), the user's
    // vote response MUST still succeed with the relay results.
    const invalidateCurrentVotes = jest.fn(() => {
      throw new Error('boom');
    });
    const { ctx } = buildApp({ invalidateCurrentVotes });
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'jules@example.com');
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(vote(H1));
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(2);
    } finally {
      ctx.db.close();
    }
  });

  test('recently-relayed short-circuit: duplicate submit within 60s is deduped', async () => {
    const { ctx, calls } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'dan@example.com');
      // First vote — goes through normally.
      await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(vote(H1))
        .expect(200);
      expect(calls).toHaveLength(2);
      calls.length = 0;
      // Second identical vote in the same tick — both entries
      // should now short-circuit.
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(vote(H1));
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(0);
      expect(
        res.body.results.every((r) => r.skipped === 'recently_relayed')
      ).toBe(true);
    } finally {
      ctx.db.close();
    }
  });

  test('vote-change path relays afresh and UPSERTs the receipt in place', async () => {
    const { ctx, calls } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'eve@example.com');
      // First vote: yes.
      await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(vote(H1, { voteOutcome: 'yes' }))
        .expect(200);
      calls.length = 0;
      // Flip to no. Both entries should relay again (not skip)
      // because the outcome is different.
      const res = await agent
        .post('/gov/vote')
        .set('X-CSRF-Token', csrf)
        .send(vote(H1, { voteOutcome: 'no' }));
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect(
        res.body.results.every((r) => r.ok && !r.skipped)
      ).toBe(true);
      const uid = await userIdFor(ctx, 'eve@example.com');
      const receipts = ctx.voteReceipts.listForProposal(uid, H1);
      expect(receipts).toHaveLength(2);
      // Both receipts now reflect the new outcome — the UPSERT
      // replaced the previous yes rows in place, not inserted new
      // ones (the UNIQUE constraint would have blocked that anyway).
      expect(receipts.every((r) => r.voteOutcome === 'no')).toBe(true);
    } finally {
      ctx.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /gov/receipts
//
// These tests exercise the shape of the response (reconciled vs stored),
// the freshness-skip optimisation, the ?refresh=1 override, and the
// graceful-degradation behaviour when the reconcile RPC is unavailable.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /gov/receipts is a PURE READ: no RPC, no DB writes, no reconcile.
// Reconciliation lives on POST /gov/receipts/reconcile (CSRF-protected,
// tests directly below this describe block).
// ---------------------------------------------------------------------------

describe('GET /gov/receipts', () => {
  async function userIdFor(ctx, email) {
    const row = ctx.users.findByEmail(email);
    return row && row.id;
  }

  test('401 when unauthenticated', async () => {
    const { ctx } = buildApp();
    try {
      const res = await request(ctx.app).get(
        `/gov/receipts?proposalHash=${H1}`
      );
      expect(res.status).toBe(401);
    } finally {
      ctx.db.close();
    }
  });

  test('400 invalid_proposal_hash when query param missing or malformed', async () => {
    const { ctx } = buildApp();
    try {
      const { agent } = await loggedInAgent(ctx);
      const missing = await agent.get('/gov/receipts');
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe('invalid_proposal_hash');
      const malformed = await agent.get('/gov/receipts?proposalHash=nope');
      expect(malformed.status).toBe(400);
      expect(malformed.body.error).toBe('invalid_proposal_hash');
    } finally {
      ctx.db.close();
    }
  });

  test('returns empty + reconciled:false when user has no receipts', async () => {
    const { ctx } = buildApp({ getCurrentVotes: jest.fn() });
    try {
      const { agent } = await loggedInAgent(ctx);
      const res = await agent.get(`/gov/receipts?proposalHash=${H1}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ receipts: [], reconciled: false });
    } finally {
      ctx.db.close();
    }
  });

  test('returns stored rows as-is and NEVER calls getCurrentVotes', async () => {
    // Codex-review guard: GET must NOT trigger RPC. A CSRF-exempt
    // GET that performs RPC + DB writes would let a cross-site
    // top-level navigation or <img> tag silently trigger server-
    // side state changes on behalf of the authenticated user.
    const getCurrentVotes = jest.fn(async () => [
      {
        voteHash: 'f'.repeat(64),
        collateralHash: H2,
        collateralIndex: 0,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
      },
    ]);
    const { ctx } = buildApp({ getCurrentVotes });
    try {
      const { agent } = await loggedInAgent(ctx, 'alice@example.com');
      const uid = await userIdFor(ctx, 'alice@example.com');
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'relayed',
      });
      const res = await agent.get(`/gov/receipts?proposalHash=${H1}`);
      expect(res.status).toBe(200);
      expect(res.body.reconciled).toBe(false);
      expect(res.body.updated).toBeUndefined();
      expect(res.body.reconcileError).toBeUndefined();
      expect(res.body.receipts).toHaveLength(1);
      // Status is untouched — GET did NOT reconcile.
      expect(res.body.receipts[0]).toMatchObject({ status: 'relayed' });
      expect(getCurrentVotes).not.toHaveBeenCalled();
    } finally {
      ctx.db.close();
    }
  });

  test('synchronous listForProposal throw is handled as 500 internal', async () => {
    const { ctx } = buildApp();
    try {
      const { agent } = await loggedInAgent(ctx, 'hank@example.com');
      const orig = ctx.voteReceipts.listForProposal;
      ctx.voteReceipts.listForProposal = () => {
        throw new Error('disk gone');
      };
      try {
        const res = await agent.get(`/gov/receipts?proposalHash=${H1}`);
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('internal');
      } finally {
        ctx.voteReceipts.listForProposal = orig;
      }
    } finally {
      ctx.db.close();
    }
  });

  test('does not leak receipts across users', async () => {
    const { ctx } = buildApp();
    try {
      const { agent: aAgent } = await loggedInAgent(ctx, 'a@example.com');
      const { agent: bAgent } = await loggedInAgent(ctx, 'b@example.com');
      const aId = await userIdFor(ctx, 'a@example.com');
      ctx.voteReceipts.upsert({
        userId: aId,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'relayed',
      });
      const aRes = await aAgent.get(`/gov/receipts?proposalHash=${H1}`);
      const bRes = await bAgent.get(`/gov/receipts?proposalHash=${H1}`);
      expect(aRes.body.receipts).toHaveLength(1);
      expect(bRes.body.receipts).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /gov/receipts/reconcile
//
// State-changing reconcile path. CSRF-protected; may call
// `gobject_getcurrentvotes` and may write `status` + `verified_at`
// to vote_receipts. Historically lived on GET /gov/receipts but
// was split out so CSRF-exempt GETs remain side-effect-free.
// ---------------------------------------------------------------------------

describe('POST /gov/receipts/reconcile', () => {
  async function userIdFor(ctx, email) {
    const row = ctx.users.findByEmail(email);
    return row && row.id;
  }

  test('401 when unauthenticated', async () => {
    const { ctx } = buildApp();
    try {
      const res = await request(ctx.app)
        .post('/gov/receipts/reconcile')
        .send({ proposalHash: H1 });
      expect(res.status).toBe(401);
    } finally {
      ctx.db.close();
    }
  });

  test('403 csrf_missing when authenticated without CSRF token', async () => {
    const { ctx } = buildApp();
    try {
      const { agent } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/receipts/reconcile')
        .send({ proposalHash: H1 });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('csrf_missing');
    } finally {
      ctx.db.close();
    }
  });

  test('400 invalid_proposal_hash when body.proposalHash is missing / malformed', async () => {
    const { ctx } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const missing = await agent
        .post('/gov/receipts/reconcile')
        .set('X-CSRF-Token', csrf)
        .send({});
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe('invalid_proposal_hash');
      const malformed = await agent
        .post('/gov/receipts/reconcile')
        .set('X-CSRF-Token', csrf)
        .send({ proposalHash: 'nope' });
      expect(malformed.status).toBe(400);
      expect(malformed.body.error).toBe('invalid_proposal_hash');
    } finally {
      ctx.db.close();
    }
  });

  test('returns empty + reconciled:false when user has no receipts', async () => {
    const getCurrentVotes = jest.fn();
    const { ctx } = buildApp({ getCurrentVotes });
    try {
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/receipts/reconcile')
        .set('X-CSRF-Token', csrf)
        .send({ proposalHash: H1 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ receipts: [], reconciled: false });
      expect(getCurrentVotes).not.toHaveBeenCalled();
    } finally {
      ctx.db.close();
    }
  });

  test('reconciles on demand: flips relayed → confirmed when RPC reports the vote', async () => {
    const getCurrentVotes = jest.fn(async () => [
      {
        voteHash: 'f'.repeat(64),
        collateralHash: H2,
        collateralIndex: 0,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
      },
    ]);
    const { ctx } = buildApp({ getCurrentVotes });
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'alice@example.com');
      const uid = await userIdFor(ctx, 'alice@example.com');
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'relayed',
      });
      const res = await agent
        .post('/gov/receipts/reconcile')
        .set('X-CSRF-Token', csrf)
        .send({ proposalHash: H1 });
      expect(res.status).toBe(200);
      expect(res.body.reconciled).toBe(true);
      expect(res.body.updated).toBe(1);
      expect(res.body.receipts).toHaveLength(1);
      expect(res.body.receipts[0]).toMatchObject({
        status: 'confirmed',
        voteOutcome: 'yes',
      });
      expect(res.body.receipts[0].verifiedAt).toEqual(expect.any(Number));
      expect(getCurrentVotes).toHaveBeenCalledTimes(1);
    } finally {
      ctx.db.close();
    }
  });

  test('future-stamped verified_at is NOT treated as fresh (forces reconcile)', async () => {
    const getCurrentVotes = jest.fn(async () => []);
    const { ctx } = buildApp({ getCurrentVotes });
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'greta@example.com');
      const uid = await userIdFor(ctx, 'greta@example.com');
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'confirmed',
      });
      ctx.db
        .prepare(`UPDATE vote_receipts SET verified_at = ? WHERE user_id = ?`)
        .run(Date.now() + 60 * 60 * 1000, uid);
      const res = await agent
        .post('/gov/receipts/reconcile')
        .set('X-CSRF-Token', csrf)
        .send({ proposalHash: H1 });
      expect(res.status).toBe(200);
      expect(getCurrentVotes).toHaveBeenCalledTimes(1);
      expect(res.body.reconciled).toBe(true);
    } finally {
      ctx.db.close();
    }
  });

  test('skips RPC when every receipt is confirmed and freshly verified', async () => {
    const getCurrentVotes = jest.fn();
    const { ctx } = buildApp({ getCurrentVotes });
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'bob@example.com');
      const uid = await userIdFor(ctx, 'bob@example.com');
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'confirmed',
      });
      ctx.db
        .prepare(`UPDATE vote_receipts SET verified_at = ? WHERE user_id = ?`)
        .run(Date.now(), uid);
      const res = await agent
        .post('/gov/receipts/reconcile')
        .set('X-CSRF-Token', csrf)
        .send({ proposalHash: H1 });
      expect(res.status).toBe(200);
      expect(res.body.reconciled).toBe(false);
      expect(res.body.receipts).toHaveLength(1);
      expect(getCurrentVotes).not.toHaveBeenCalled();
    } finally {
      ctx.db.close();
    }
  });

  test('refresh:true forces reconciliation even when freshness window is intact', async () => {
    const getCurrentVotes = jest.fn(async () => []);
    const { ctx } = buildApp({ getCurrentVotes });
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'carol@example.com');
      const uid = await userIdFor(ctx, 'carol@example.com');
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'confirmed',
      });
      ctx.db
        .prepare(`UPDATE vote_receipts SET verified_at = ? WHERE user_id = ?`)
        .run(Date.now(), uid);
      const res = await agent
        .post('/gov/receipts/reconcile')
        .set('X-CSRF-Token', csrf)
        .send({ proposalHash: H1, refresh: true });
      expect(res.status).toBe(200);
      expect(res.body.reconciled).toBe(true);
      expect(getCurrentVotes).toHaveBeenCalledTimes(1);
    } finally {
      ctx.db.close();
    }
  });

  test('returns stored rows with reconcileError when RPC fails', async () => {
    const getCurrentVotes = jest.fn(async () => {
      throw new Error('connection refused');
    });
    const { ctx } = buildApp({ getCurrentVotes });
    try {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { agent, csrf } = await loggedInAgent(ctx, 'dan@example.com');
        const uid = await userIdFor(ctx, 'dan@example.com');
        ctx.voteReceipts.upsert({
          userId: uid,
          collateralHash: H2,
          collateralIndex: 0,
          proposalHash: H1,
          voteOutcome: 'yes',
          voteSignal: 'funding',
          voteTime: 1_700_000_000,
          status: 'relayed',
        });
        const res = await agent
          .post('/gov/receipts/reconcile')
          .set('X-CSRF-Token', csrf)
          .send({ proposalHash: H1 });
        expect(res.status).toBe(200);
        expect(res.body.reconciled).toBe(false);
        expect(res.body.reconcileError).toBe('rpc_failed');
        expect(res.body.receipts).toHaveLength(1);
        expect(res.body.receipts[0].status).toBe('relayed');
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      ctx.db.close();
    }
  });

  test('returns stored rows with reconciled:false when getCurrentVotes is not wired', async () => {
    const { ctx } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'eve@example.com');
      const uid = await userIdFor(ctx, 'eve@example.com');
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'relayed',
      });
      const res = await agent
        .post('/gov/receipts/reconcile')
        .set('X-CSRF-Token', csrf)
        .send({ proposalHash: H1 });
      expect(res.status).toBe(200);
      expect(res.body.reconciled).toBe(false);
      expect(res.body.reconcileError).toBeUndefined();
      expect(res.body.receipts).toHaveLength(1);
    } finally {
      ctx.db.close();
    }
  });

  test('synchronous listForProposal throw is handled as 500 internal', async () => {
    const { ctx } = buildApp();
    try {
      const { agent, csrf } = await loggedInAgent(ctx, 'hank@example.com');
      const orig = ctx.voteReceipts.listForProposal;
      ctx.voteReceipts.listForProposal = () => {
        throw new Error('disk gone');
      };
      try {
        const res = await agent
          .post('/gov/receipts/reconcile')
          .set('X-CSRF-Token', csrf)
          .send({ proposalHash: H1 });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('internal');
      } finally {
        ctx.voteReceipts.listForProposal = orig;
      }
    } finally {
      ctx.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /gov/receipts/summary
//
// Pure SELECT rollup — no RPC, no reconciliation. Asserts shape,
// per-user isolation, and that it handles the no-receipts case.
// ---------------------------------------------------------------------------

describe('GET /gov/receipts/summary', () => {
  async function userIdFor(ctx, email) {
    const row = ctx.users.findByEmail(email);
    return row && row.id;
  }

  test('401 when unauthenticated', async () => {
    const { ctx } = buildApp();
    try {
      const res = await request(ctx.app).get('/gov/receipts/summary');
      expect(res.status).toBe(401);
    } finally {
      ctx.db.close();
    }
  });

  test('returns empty array when user has no receipts', async () => {
    const { ctx } = buildApp();
    try {
      const { agent } = await loggedInAgent(ctx);
      const res = await agent.get('/gov/receipts/summary');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ summary: [] });
    } finally {
      ctx.db.close();
    }
  });

  test('aggregates status counts per proposal', async () => {
    const { ctx } = buildApp();
    try {
      const { agent } = await loggedInAgent(ctx, 'alice@example.com');
      const uid = await userIdFor(ctx, 'alice@example.com');
      // H1: 2 confirmed yes, 1 failed
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'confirmed',
      });
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H3,
        collateralIndex: 1,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'confirmed',
      });
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H2,
        collateralIndex: 1,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'failed',
        lastError: 'signature_invalid',
      });
      // H2: 1 relayed
      ctx.voteReceipts.upsert({
        userId: uid,
        collateralHash: H2,
        collateralIndex: 2,
        proposalHash: H2,
        voteOutcome: 'no',
        voteSignal: 'funding',
        voteTime: 1_700_000_001,
        status: 'relayed',
      });
      const res = await agent.get('/gov/receipts/summary');
      expect(res.status).toBe(200);
      expect(res.body.summary).toHaveLength(2);
      const byProposal = Object.fromEntries(
        res.body.summary.map((r) => [r.proposalHash, r])
      );
      expect(byProposal[H1]).toMatchObject({
        total: 3,
        confirmed: 2,
        failed: 1,
        relayed: 0,
        stale: 0,
        confirmedYes: 2,
        confirmedNo: 0,
      });
      expect(byProposal[H2]).toMatchObject({
        total: 1,
        relayed: 1,
        confirmed: 0,
      });
    } finally {
      ctx.db.close();
    }
  });

  test('does not leak summaries across users', async () => {
    const { ctx } = buildApp();
    try {
      const { agent: aAgent } = await loggedInAgent(ctx, 'a@example.com');
      const { agent: bAgent } = await loggedInAgent(ctx, 'b@example.com');
      const aId = await userIdFor(ctx, 'a@example.com');
      ctx.voteReceipts.upsert({
        userId: aId,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'confirmed',
      });
      const aRes = await aAgent.get('/gov/receipts/summary');
      const bRes = await bAgent.get('/gov/receipts/summary');
      expect(aRes.body.summary).toHaveLength(1);
      expect(bRes.body.summary).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /gov/receipts/recent
//
// "Your activity" backing route — the N most-recent receipts across all
// proposals for the calling user, ordered by submitted_at DESC. Pure
// SELECT; no RPC.
// ---------------------------------------------------------------------------

describe('GET /gov/receipts/recent', () => {
  async function userIdFor(ctx, email) {
    const row = ctx.users.findByEmail(email);
    return row && row.id;
  }

  test('401 when unauthenticated', async () => {
    const { ctx } = buildApp();
    try {
      const res = await request(ctx.app).get('/gov/receipts/recent');
      expect(res.status).toBe(401);
    } finally {
      ctx.db.close();
    }
  });

  test('returns empty list when the user has no receipts', async () => {
    const { ctx } = buildApp();
    try {
      const { agent } = await loggedInAgent(ctx);
      const res = await agent.get('/gov/receipts/recent');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ receipts: [] });
    } finally {
      ctx.db.close();
    }
  });

  test('defaults to 10 and returns rows in submitted_at DESC', async () => {
    // Use an injected monotonic clock so every upsert stamps a
    // distinct submitted_at. Without this, two upserts inside the
    // same millisecond would tie and the ORDER BY submitted_at
    // DESC ordering would depend on insertion-order (stable on
    // better-sqlite3 but brittle to assert against).
    let tick = 1_700_000_000_000;
    const { ctx } = buildApp();
    // Rebuild the receipts repo with a tick clock so we can predict
    // submitted_at for each upsert.
    const { createVoteReceiptsRepo } = require('../lib/voteReceipts');
    ctx.voteReceipts = createVoteReceiptsRepo(ctx.db, {
      now: () => {
        tick += 1;
        return tick;
      },
    });
    try {
      const { agent } = await loggedInAgent(ctx);
      const uid = await userIdFor(ctx, 'user@example.com');
      for (let i = 0; i < 12; i += 1) {
        ctx.voteReceipts.upsert({
          userId: uid,
          collateralHash: H2,
          collateralIndex: i,
          proposalHash: H1,
          voteOutcome: 'yes',
          voteSignal: 'funding',
          voteTime: 1_700_000_000 + i,
          status: 'confirmed',
        });
      }
      const res = await agent.get('/gov/receipts/recent');
      expect(res.status).toBe(200);
      // NOTE: the route's repo in appFactory is the one that
      // handles the request, not the local `ctx.voteReceipts` we
      // swapped above — the listRecent it exposes is bound to the
      // same db. Upserts above wrote to that db; the route will
      // read them back.
      expect(res.body.receipts).toHaveLength(10);
      // Most recent first: submittedAt strictly non-increasing.
      const submitted = res.body.receipts.map((r) => r.submittedAt);
      for (let i = 1; i < submitted.length; i += 1) {
        expect(submitted[i]).toBeLessThanOrEqual(submitted[i - 1]);
      }
    } finally {
      ctx.db.close();
    }
  });

  test('respects a custom limit and clamps to 50', async () => {
    const { ctx } = buildApp();
    try {
      const { agent } = await loggedInAgent(ctx);
      const uid = await userIdFor(ctx, 'user@example.com');
      for (let i = 0; i < 4; i += 1) {
        ctx.voteReceipts.upsert({
          userId: uid,
          collateralHash: H2,
          collateralIndex: i,
          proposalHash: H1,
          voteOutcome: 'yes',
          voteSignal: 'funding',
          voteTime: 1_700_000_000 + i,
          status: 'confirmed',
        });
      }
      const res1 = await agent.get('/gov/receipts/recent?limit=2');
      expect(res1.body.receipts).toHaveLength(2);

      // Values over 50 silently clamp so a client can ask for
      // "everything" without coordinating with the server ceiling.
      const res2 = await agent.get('/gov/receipts/recent?limit=500');
      expect(res2.status).toBe(200);
      expect(res2.body.receipts.length).toBeLessThanOrEqual(50);
    } finally {
      ctx.db.close();
    }
  });

  test('rejects invalid limit values with 400', async () => {
    const { ctx } = buildApp();
    try {
      const { agent } = await loggedInAgent(ctx);
      const res = await agent.get('/gov/receipts/recent?limit=abc');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_limit' });

      const res2 = await agent.get('/gov/receipts/recent?limit=0');
      expect(res2.status).toBe(400);

      const res3 = await agent.get('/gov/receipts/recent?limit=-5');
      expect(res3.status).toBe(400);

      // Partially-numeric and scientific-notation strings also
      // 400 rather than silently coercing to an integer value.
      // Previously Number.parseInt('2abc') → 2 and Number
      // .parseInt('1.5') → 1, masking client bugs.
      const res4 = await agent.get('/gov/receipts/recent?limit=2abc');
      expect(res4.status).toBe(400);
      const res5 = await agent.get('/gov/receipts/recent?limit=1.5');
      expect(res5.status).toBe(400);
      const res6 = await agent.get('/gov/receipts/recent?limit=1e3');
      expect(res6.status).toBe(400);
    } finally {
      ctx.db.close();
    }
  });

  test('does not leak receipts across users', async () => {
    const { ctx } = buildApp();
    try {
      const { agent: aAgent } = await loggedInAgent(ctx, 'a@example.com');
      const { agent: bAgent } = await loggedInAgent(ctx, 'b@example.com');
      const aId = await userIdFor(ctx, 'a@example.com');
      ctx.voteReceipts.upsert({
        userId: aId,
        collateralHash: H2,
        collateralIndex: 0,
        proposalHash: H1,
        voteOutcome: 'yes',
        voteSignal: 'funding',
        voteTime: 1_700_000_000,
        status: 'confirmed',
      });
      const aRes = await aAgent.get('/gov/receipts/recent');
      const bRes = await bAgent.get('/gov/receipts/recent');
      expect(aRes.body.receipts).toHaveLength(1);
      expect(bRes.body.receipts).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });
});
