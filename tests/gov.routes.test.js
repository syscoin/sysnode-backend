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
const SIG = 'A'.repeat(86) + '==';

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
function buildApp({ masternodes = [], voteRaw } = {}) {
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
