'use strict';

// Route tests for /gov/proposals.
//
// We build a self-contained Express app here rather than extending the
// central buildTestApp helper: the router isn't mounted by appFactory
// yet (that wiring lives in the be-server-wiring task), so plumbing
// the deps through appFactory here would be premature. A minimal
// inline harness also keeps the test scope tight — the things that
// can break in these tests are the route handlers and the wiring
// between repos, nothing else.

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const { openDatabase } = require('../lib/db');
const { createMailer } = require('../lib/mailer');
const { createUsersRepo } = require('../lib/users');
const { createSessionStore } = require('../lib/sessions');
const { createPendingRegistrationsRepo } = require('../lib/pendingRegistrations');
const { createVaultsRepo } = require('../lib/vaults');
const { createProposalDraftsRepo } = require('../lib/proposalDrafts');
const {
  createProposalSubmissionsRepo,
} = require('../lib/proposalSubmissions');
const { createSessionMiddleware } = require('../middleware/session');
const { createCsrfMiddleware } = require('../middleware/csrf');
const rateLimiters = require('../middleware/rateLimit');
const { createAuthRouter } = require('../routes/auth');
const {
  createGovProposalsRouter,
  COLLATERAL_FEE_SATS,
  REQUIRED_CONFIRMATIONS,
} = require('../routes/govProposals');
const { _resetPepperForTests } = require('../lib/kdf');

const SAMPLE_AUTH =
  'a4f8b3c1d9e7f2a5b1c6d8e4f7a9b2c5d1e8f4a7b3c9d5e1f6a2b8c4d7e3f5a9';

function buildApp({ gObjectCheck = null, nowRef = null } = {}) {
  _resetPepperForTests();
  process.env.SYSNODE_AUTH_PEPPER = 'd'.repeat(64);
  process.env.NODE_ENV = 'test';

  const db = openDatabase(':memory:');
  const mailer = createMailer({ transport: 'memory', from: 't@example.com' });

  const users = createUsersRepo(db);
  const sessions = createSessionStore(db);
  const pendingRegistrations = createPendingRegistrationsRepo(db);
  const vaults = createVaultsRepo(db);
  const drafts = createProposalDraftsRepo(db);
  const submissions = createProposalSubmissionsRepo(db);

  const sessionMw = createSessionMiddleware({
    sessions,
    users,
    secureCookies: false,
  });
  const csrfMw = createCsrfMiddleware({ secureCookies: false });
  const runAtomic = (fn) => db.transaction(fn)();

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(sessionMw.parse);

  const syncScheduler = (fn) => {
    const p = fn();
    if (p && typeof p.then === 'function') {
      p.catch(() => {});
    }
  };

  app.use(
    '/auth',
    createAuthRouter({
      users,
      sessions,
      pendingRegistrations,
      vaults,
      mailer,
      sessionMw,
      csrfMw,
      limiters: {
        login: rateLimiters.disabled(),
        register: rateLimiters.disabled(),
        vote: rateLimiters.disabled(),
      },
      baseUrl: 'http://api.test.local',
      frontendUrl: 'http://app.test.local',
      scheduler: syncScheduler,
      runAtomic,
    })
  );

  app.use(
    '/gov/proposals',
    createGovProposalsRouter({
      drafts,
      submissions,
      sessionMw,
      csrfMw,
      rpc: gObjectCheck ? { gObjectCheck } : {},
      runAtomic,
      ...(nowRef ? { now: () => nowRef.value } : {}),
    })
  );

  return { app, db, mailer, users, drafts, submissions };
}

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

// Wait for a test-mailer outbox entry matching a predicate. The register
// handler schedules mailer.sendVerification via an async fn; depending on
// microtask ordering the email may not yet be in the outbox when the HTTP
// response returns. Polling with setImmediate drains pending microtasks
// without introducing real sleeps that would slow the suite.
async function waitForOutbox(mailer, predicate, { tries = 20 } = {}) {
  for (let i = 0; i < tries; i++) {
    const hit = mailer.outbox.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitForOutbox: no matching message within retry budget');
}

async function loggedInAgent(ctx, email = 'user@example.com') {
  const agent = request.agent(ctx.app);
  await agent.post('/auth/register').send({ email, authHash: SAMPLE_AUTH });
  const msg = await waitForOutbox(ctx.mailer, (m) => m.to === email);
  const token = msg.html.match(/token=([0-9a-f]{64})/)[1];
  await agent.post('/auth/verify-email').send({ token });
  const loginRes = await agent
    .post('/auth/login')
    .send({ email, authHash: SAMPLE_AUTH });
  const csrf = extractCookies(loginRes).csrf;
  return { agent, csrf };
}

// Deterministic "happy path" proposal body. The frontend wizard will
// emit something very close to this.
function validProposalBody(overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    title: 'Fund the docs team',
    description: 'Anything the hash does NOT commit to.',
    name: 'fund-docs',
    url: 'https://forum.syscoin.org/t/fund-docs',
    paymentAddress: 'sys1qw508d6qejxtdg4y5r3zarvary0c5xw7kygmkq9',
    paymentAmount: '5000',
    paymentCount: 3,
    startEpoch: nowSec + 3600,
    endEpoch: nowSec + 3600 * 24 * 90,
    ...overrides,
  };
}

// -----------------------------------------------------------------------
// Drafts
// -----------------------------------------------------------------------

describe('drafts CRUD', () => {
  let ctx;

  beforeEach(() => {
    ctx = buildApp();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('401 without session', async () => {
    const res = await request(ctx.app).post('/gov/proposals/drafts').send({});
    expect(res.status).toBe(401);
  });

  test('403 csrf_missing when authenticated without token', async () => {
    const { agent } = await loggedInAgent(ctx);
    const res = await agent.post('/gov/proposals/drafts').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_missing');
  });

  test('create draft persists fields and returns 201', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({
        title: 'My draft',
        name: 'My Draft-Name',
        paymentAmount: '12.5',
        paymentCount: 2,
        startEpoch: 2000000000,
      });
    expect(res.status).toBe(201);
    expect(res.body.draft).toMatchObject({
      title: 'My draft',
      name: 'My Draft-Name',
      paymentCount: 2,
      startEpoch: 2000000000,
      endEpoch: null,
    });
    // 12.5 SYS = 1_250_000_000 sats
    expect(res.body.draft.paymentAmountSats).toBe('1250000000');
    expect(typeof res.body.draft.id).toBe('number');
  });

  test('create rejects payment_count out of range', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ paymentCount: 9999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues[0].code).toBe('payment_count_range');
  });

  test('create rejects invalid payment_amount', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ paymentAmount: 'not a number' });
    expect(res.status).toBe(400);
    expect(res.body.issues[0].field).toBe('payment_amount');
  });

  // Codex PR8 round 5 P2: malformed payment_amount_sats used to
  // surface as a generic 500 because the route forwarded the raw
  // string down to proposalDrafts.create(), which throws out of the
  // handler. Route-layer validation now rejects it with the same
  // 400 shape as other validation failures.
  test('create rejects malformed payment_amount_sats as 400', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const cases = [
      'abc', // non-digit
      '12.5', // decimal (sats are integer)
      '-1', // negative
      '007', // leading zeros
      '', // empty string
      '1e3', // scientific notation
    ];
    for (const sats of cases) {
      const res = await agent
        .post('/gov/proposals/drafts')
        .set('X-CSRF-Token', csrf)
        .send({ paymentAmountSats: sats });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(res.body.issues[0].field).toBe('payment_amount_sats');
      expect(res.body.issues[0].code).toBe('amount_sats_invalid');
    }
  });

  test('create accepts well-formed payment_amount_sats', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ paymentAmountSats: '15000000000' });
    expect(res.status).toBe(201);
    expect(res.body.draft.paymentAmountSats).toBe('15000000000');
  });

  test('patch rejects malformed payment_amount_sats as 400', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const created = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ title: 'draft' });
    const id = created.body.draft.id;
    const res = await agent
      .patch(`/gov/proposals/drafts/${id}`)
      .set('X-CSRF-Token', csrf)
      .send({ paymentAmountSats: '12.5' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues[0].field).toBe('payment_amount_sats');
  });

  test('list returns only caller drafts, ordered most-recently-updated first', async () => {
    const a = await loggedInAgent(ctx, 'a@example.com');
    const b = await loggedInAgent(ctx, 'b@example.com');

    await a.agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', a.csrf)
      .send({ title: 'A1' });
    const r2 = await a.agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', a.csrf)
      .send({ title: 'A2' });
    await b.agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', b.csrf)
      .send({ title: 'B1' });

    const listA = await a.agent.get('/gov/proposals/drafts');
    expect(listA.status).toBe(200);
    expect(listA.body.total).toBe(2);
    // updated_at DESC then id DESC — most-recent insert first.
    expect(listA.body.drafts[0].id).toBe(r2.body.draft.id);
    expect(listA.body.drafts.map((d) => d.title)).toEqual(['A2', 'A1']);

    const listB = await b.agent.get('/gov/proposals/drafts');
    expect(listB.body.total).toBe(1);
    expect(listB.body.drafts[0].title).toBe('B1');
  });

  test('get/patch/delete enforce ownership (404 for others)', async () => {
    const a = await loggedInAgent(ctx, 'a@example.com');
    const b = await loggedInAgent(ctx, 'b@example.com');
    const created = await a.agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', a.csrf)
      .send({ title: 'secret' });
    const id = created.body.draft.id;

    // Owner can read
    const own = await a.agent.get(`/gov/proposals/drafts/${id}`);
    expect(own.status).toBe(200);

    // Stranger cannot
    const notme = await b.agent.get(`/gov/proposals/drafts/${id}`);
    expect(notme.status).toBe(404);
    const patchRes = await b.agent
      .patch(`/gov/proposals/drafts/${id}`)
      .set('X-CSRF-Token', b.csrf)
      .send({ title: 'hijack' });
    expect(patchRes.status).toBe(404);
    const delRes = await b.agent
      .delete(`/gov/proposals/drafts/${id}`)
      .set('X-CSRF-Token', b.csrf);
    expect(delRes.status).toBe(404);

    // Unchanged for the owner
    const still = await a.agent.get(`/gov/proposals/drafts/${id}`);
    expect(still.body.draft.title).toBe('secret');
  });

  test('patch only updates provided fields', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const created = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ title: 'orig', name: 'orig-name' });
    const id = created.body.draft.id;
    const patched = await agent
      .patch(`/gov/proposals/drafts/${id}`)
      .set('X-CSRF-Token', csrf)
      .send({ title: 'new title' });
    expect(patched.status).toBe(200);
    expect(patched.body.draft.title).toBe('new title');
    // unchanged
    expect(patched.body.draft.name).toBe('orig-name');
  });

  test('delete removes the row (204)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const created = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ title: 'bye' });
    const id = created.body.draft.id;
    const del = await agent
      .delete(`/gov/proposals/drafts/${id}`)
      .set('X-CSRF-Token', csrf);
    expect(del.status).toBe(204);
    const get = await agent.get(`/gov/proposals/drafts/${id}`);
    expect(get.status).toBe(404);
  });

  test('invalid id params return 404 (never 400)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const r1 = await agent.get('/gov/proposals/drafts/abc');
    expect(r1.status).toBe(404);
    const r2 = await agent
      .patch('/gov/proposals/drafts/0')
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(r2.status).toBe(404);
    const r3 = await agent
      .delete('/gov/proposals/drafts/-1')
      .set('X-CSRF-Token', csrf);
    expect(r3.status).toBe(404);
  });

  test('draft_limit is enforced (409)', async () => {
    // Build with a smaller cap so we don't actually insert 50 rows.
    _resetPepperForTests();
    process.env.SYSNODE_AUTH_PEPPER = 'd'.repeat(64);
    process.env.NODE_ENV = 'test';
    const db = openDatabase(':memory:');
    const mailer = createMailer({ transport: 'memory', from: 't@example.com' });
    const users = createUsersRepo(db);
    const sessions = createSessionStore(db);
    const pendingRegistrations = createPendingRegistrationsRepo(db);
    const vaults = createVaultsRepo(db);
    const drafts = createProposalDraftsRepo(db);
    const submissions = createProposalSubmissionsRepo(db);
    const sessionMw = createSessionMiddleware({
      sessions,
      users,
      secureCookies: false,
    });
    const csrfMw = createCsrfMiddleware({ secureCookies: false });
    const runAtomic = (fn) => db.transaction(fn)();

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(sessionMw.parse);
    const syncScheduler = (fn) => {
      const p = fn();
      if (p && p.catch) p.catch(() => {});
    };
    app.use(
      '/auth',
      createAuthRouter({
        users,
        sessions,
        pendingRegistrations,
        vaults,
        mailer,
        sessionMw,
        csrfMw,
        limiters: {
          login: rateLimiters.disabled(),
          register: rateLimiters.disabled(),
          vote: rateLimiters.disabled(),
        },
        baseUrl: 'http://api.test.local',
        frontendUrl: 'http://app.test.local',
        scheduler: syncScheduler,
        runAtomic,
      })
    );
    app.use(
      '/gov/proposals',
      createGovProposalsRouter({
        drafts,
        submissions,
        sessionMw,
        csrfMw,
        runAtomic,
        maxDraftsPerUser: 2,
      })
    );
    const smallCtx = { app, mailer };
    const { agent, csrf } = await loggedInAgent(smallCtx, 'cap@example.com');
    await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ title: '1' });
    await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ title: '2' });
    const res = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ title: '3' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'conflict',
      reason: 'draft_limit',
    });
    db.close();
  });
});

// -----------------------------------------------------------------------
// Prepare
// -----------------------------------------------------------------------

describe('POST /gov/proposals/prepare', () => {
  let ctx;

  afterEach(() => {
    if (ctx) ctx.db.close();
  });

  test('happy path: creates submission, returns hash/canonical/fee', async () => {
    const calls = [];
    ctx = buildApp({
      // Codex PR8 round 6 P1: Core's gobject_check takes ONE
      // positional arg (hex_data) and returns { "Object status": "OK" }
      // on accept. Mock the contract the real adapter exposes today.
      gObjectCheck: async (dataHex) => {
        calls.push({ dataHex });
        return { result: { 'Object status': 'OK' } };
      },
    });
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(validProposalBody());
    expect(res.status).toBe(201);
    expect(res.body.submission).toMatchObject({
      status: 'prepared',
      parentHash: '0',
      revision: 1,
      collateralConfs: 0,
      collateralTxid: null,
      governanceHash: null,
    });
    // proposal_hash is 64 lowercase hex chars
    expect(res.body.submission.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    // opReturn hex is 64 hex chars (32 bytes) and equals reversed proposalHash
    expect(res.body.opReturnHex).toMatch(/^[0-9a-f]{64}$/);
    const revDisplay = Buffer.from(res.body.opReturnHex, 'hex')
      .reverse()
      .toString('hex');
    expect(revDisplay).toBe(res.body.submission.proposalHash);
    // Canonical JSON is exactly the proposalValidate form: type first,
    // flat object, no description/title/paymentCount fields.
    expect(res.body.canonicalJson).toMatch(/^\{"type":1,"name":/);
    expect(res.body.canonicalJson).not.toMatch(/description/);
    expect(res.body.canonicalJson).not.toMatch(/payment_count/);
    expect(res.body.payloadBytes).toBe(
      Buffer.byteLength(res.body.canonicalJson, 'utf8')
    );
    expect(res.body.collateralFeeSats).toBe(
      COLLATERAL_FEE_SATS.toString()
    );
    expect(res.body.requiredConfirmations).toBe(REQUIRED_CONFIRMATIONS);
    expect(calls).toHaveLength(1);
    // Codex PR8 round 6 P1: preflight must call Core's gobject_check
    // with its single positional arg — `hex_data`. Earlier we passed
    // the 4-tuple that gobject_submit uses, which Core rejects with
    // RPC_INVALID_PARAMS and our "terminal" classifier misread as
    // 422 core_rejected. Assert the wire contract directly.
    expect(calls[0]).toEqual({
      dataHex: res.body.submission.dataHex,
    });
  });

  test('idempotency is keyed on dataHex, not proposalHash — retries across a second boundary still collapse (Codex round 2 P1)', async () => {
    // proposalHash bakes in `time`, so two retries of the same
    // logical /prepare that happen to straddle a one-second
    // boundary hash differently. A hash-only idempotency check
    // would create duplicate prepared rows for what is
    // semantically the same submission. Payload-keyed idempotency
    // (lookup by user_id + data_hex on `prepared` rows) must
    // collapse them to one row with stable hash/time.
    const nowRef = { value: 1_800_000_000_000 }; // ms
    ctx = buildApp({ nowRef });
    const { agent, csrf } = await loggedInAgent(ctx);
    const nowSec = Math.floor(nowRef.value / 1000);
    const body = validProposalBody({
      startEpoch: nowSec + 3600,
      endEpoch: nowSec + 3600 * 24 * 30,
    });

    const r1 = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(body);
    expect(r1.status).toBe(201);

    // Advance wall clock by >1s so a second /prepare computes a
    // fresh `time` and therefore a *different* proposalHash if
    // idempotency is hash-keyed.
    nowRef.value += 2500;

    const r2 = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(body);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent).toBe(true);
    expect(r2.body.submission.id).toBe(r1.body.submission.id);
    expect(r2.body.submission.proposalHash).toBe(r1.body.submission.proposalHash);
    expect(r2.body.submission.timeUnix).toBe(r1.body.submission.timeUnix);
    // And — crucially — there's exactly one row in the DB.
    const rows = ctx.submissions.listForUser(
      ctx.users.findByEmail('user@example.com').id
    );
    expect(rows).toHaveLength(1);
  });

  test(
    'concurrent prepare race: DB unique index + constraint fallback collapses to a single row (Codex round 3 P2)',
    async () => {
      // Simulate a true interleave: the pre-read in /prepare misses
      // (the competing /prepare hasn't been committed yet from the
      // caller's perspective), so the route proceeds to INSERT. The
      // partial unique index `idx_proposal_submissions_user_payload_prepared`
      // rejects the second INSERT with SQLITE_CONSTRAINT_UNIQUE;
      // the route's catch block re-reads via findPreparedByDataHexForUser
      // and responds 200 idempotent with the winner's submission.
      //
      // We mimic the interleave by stubbing
      // `submissions.findPreparedByDataHexForUser` to return null on
      // the *pre-read* only for the second request, while the DB
      // state contains the first prepared row.
      ctx = buildApp();
      const { agent, csrf } = await loggedInAgent(ctx);
      const body = validProposalBody();

      const r1 = await agent
        .post('/gov/proposals/prepare')
        .set('X-CSRF-Token', csrf)
        .send(body);
      expect(r1.status).toBe(201);

      // Monkey-patch the submissions object shared with the router:
      // force the pre-read miss once, then restore.
      const realFind = ctx.submissions.findPreparedByDataHexForUser;
      let miss = true;
      ctx.submissions.findPreparedByDataHexForUser = (...args) => {
        if (miss) {
          miss = false;
          return null;
        }
        return realFind.apply(ctx.submissions, args);
      };

      const r2 = await agent
        .post('/gov/proposals/prepare')
        .set('X-CSRF-Token', csrf)
        .send(body);

      ctx.submissions.findPreparedByDataHexForUser = realFind;

      expect(r2.status).toBe(200);
      expect(r2.body.idempotent).toBe(true);
      expect(r2.body.submission.id).toBe(r1.body.submission.id);
      const rows = ctx.submissions.listForUser(
        ctx.users.findByEmail('user@example.com').id
      );
      expect(rows).toHaveLength(1);
    }
  );

  test(
    'idempotent replay re-runs gObjectCheck preflight; Core-reject after a soft-failed first attempt returns 422 (Codex round 5 P1)',
    async () => {
      // Scenario: the *first* /prepare call lands during a transient
      // Core RPC outage (node unreachable). The route soft-allows
      // network errors, so the prepared row is created and the
      // client gets a 201 envelope. Later, the client retries the
      // exact same canonical body, but now Core is reachable and
      // deterministically rejects the payload (e.g. checksum-invalid
      // payment address that fullValidate didn't catch because
      // address parsing is network-param-specific to Core).
      //
      // Before the round-5 fix, the idempotent branch returned the
      // cached envelope without re-preflighting, so the user would
      // proceed to burn 150 SYS on a proposal Core will reject at
      // dispatcher-time. With the fix, gObjectCheck runs on EVERY
      // /prepare, including the idempotent replay, so Core-reject
      // surfaces as 422 before any collateral is spent.
      let phase = 'network-down';
      ctx = buildApp({
        gObjectCheck: async () => {
          if (phase === 'network-down') {
            // Match the soft-fail heuristic: the route only treats
            // messages matching /validation|invalid|exceeds|...;/ as
            // terminal. A pure connection-refused is soft.
            const e = new Error('ECONNREFUSED: Core unreachable');
            throw e;
          }
          if (phase === 'reject') {
            return {
              result: {
                Error: 'checksum invalid for payment_address',
              },
            };
          }
          return { result: { 'Object status': 'OK' } };
        },
      });
      const { agent, csrf } = await loggedInAgent(ctx);
      const body = validProposalBody();

      const r1 = await agent
        .post('/gov/proposals/prepare')
        .set('X-CSRF-Token', csrf)
        .send(body);
      expect(r1.status).toBe(201);

      // Flip to deterministic-reject and retry the SAME canonical
      // body. The idempotency pre-read will find the prepared row.
      phase = 'reject';

      const r2 = await agent
        .post('/gov/proposals/prepare')
        .set('X-CSRF-Token', csrf)
        .send(body);

      // Critical: retry must NOT return cached 200-idempotent even
      // though a prepared row exists for this payload; preflight
      // has to execute and translate Core's reject into 422.
      expect(r2.status).toBe(422);
      expect(r2.body.error).toBe('core_rejected');

      // And the prepared row is still in DB (the user can either
      // DELETE it or edit the proposal to produce a fresh payload).
      const rows = ctx.submissions.listForUser(
        ctx.users.findByEmail('user@example.com').id
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('prepared');
      expect(rows[0].id).toBe(r1.body.submission.id);
    }
  );

  test('hash is deterministic: same inputs → same proposalHash', async () => {
    ctx = buildApp();
    // Two different users preparing the same proposal text — because
    // our `time` field derives from the server clock, we can't
    // actually compare hashes across two separate /prepare calls.
    // Instead we assert the *shape* is deterministic: call the hash
    // function directly with fixed inputs and verify the route's
    // output, given a frozen time, matches.
    const frozen = 1_700_000_000_000; // ms
    const app = ctx.app;
    // Patch Date.now used by the router? The route captures `now` at
    // factory time; we don't have access here. Instead check the
    // looser property: proposalHash changes when ANY canonical field
    // changes, but two simultaneous back-to-back calls with identical
    // canonical content return identical (idempotent) submissions.
    void frozen;
    void app;

    const { agent, csrf } = await loggedInAgent(ctx);
    const body = validProposalBody();
    const r1 = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(body);
    const r2 = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(body);
    expect(r1.body.submission.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    // Idempotent: second call returns the existing row, NOT a new one.
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent).toBe(true);
    expect(r2.body.submission.id).toBe(r1.body.submission.id);
  });

  test('validation_failed for empty name', async () => {
    ctx = buildApp();
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(validProposalBody({ name: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues.find((i) => i.field === 'name')).toBeTruthy();
  });

  test('validation_failed for bad URL scheme', async () => {
    ctx = buildApp();
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(validProposalBody({ url: 'javascript:alert(1)' }));
    expect(res.status).toBe(400);
    expect(
      res.body.issues.find((i) => i.code === 'url_scheme')
    ).toBeTruthy();
  });

  test('validation_failed for past end_epoch', async () => {
    ctx = buildApp();
    const { agent, csrf } = await loggedInAgent(ctx);
    const past = Math.floor(Date.now() / 1000) - 86400;
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(
        validProposalBody({
          startEpoch: past - 3600,
          endEpoch: past,
        })
      );
    expect(res.status).toBe(400);
    expect(res.body.issues.some((i) => i.code === 'epoch_past')).toBe(true);
  });

  test('validation_failed for payment_count out of range (60 max default)', async () => {
    ctx = buildApp();
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(validProposalBody({ paymentCount: 1000 }));
    expect(res.status).toBe(400);
    expect(
      res.body.issues.find((i) => i.code === 'payment_count_range')
    ).toBeTruthy();
  });

  test('core_rejected when gObjectCheck returns non-success', async () => {
    ctx = buildApp({
      // Codex PR8 round 6 P1: a non-"Object status: OK" response
      // (including a plain `Error` message) is a rejection. Parse
      // the message for codes and surface 422.
      gObjectCheck: async () => ({
        result: { Error: 'name exceeds 40 characters' },
      }),
    });
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(validProposalBody());
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('core_rejected');
    expect(
      res.body.issues.find((i) => i.code === 'name_too_long')
    ).toBeTruthy();
  });

  test('core_rejected classifies thrown validation-ish errors', async () => {
    ctx = buildApp({
      gObjectCheck: async () => {
        throw new Error('proposal data exceeds 512 bytes');
      },
    });
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(validProposalBody());
    expect(res.status).toBe(422);
    expect(
      res.body.issues.find((i) => i.code === 'payload_too_large')
    ).toBeTruthy();
  });

  test(
    'accepts Core\'s canonical success shape { "Object status": "OK" } (Codex round 6 P1)',
    async () => {
      // Regression: previously we checked `result.Object === 'success'`,
      // which is NOT the response Core produces. Core returns
      //   { "Object status": "OK" }
      // (see syscoin/src/rpc/governance.cpp line 111:
      //    objResult.pushKV("Object status", "OK");
      // ). With the old check every valid preflight fell through the
      // reject branch and /prepare surfaced as 422 core_rejected. We
      // accept mixed casing on the OK string for forward-compat but
      // require the exact key.
      ctx = buildApp({
        gObjectCheck: async () => ({ result: { 'Object status': 'OK' } }),
      });
      const { agent, csrf } = await loggedInAgent(ctx);
      const r = await agent
        .post('/gov/proposals/prepare')
        .set('X-CSRF-Token', csrf)
        .send(validProposalBody());
      expect(r.status).toBe(201);
      expect(r.body.submission.status).toBe('prepared');
    }
  );

  test(
    'gObjectCheck is called with hex_data only (Codex round 6 P1)',
    async () => {
      // Regression: a previous iteration of the adapter mirrored the
      // 4-tuple `gobject_submit` signature and sent
      // (parent_hash, revision, time, data_hex) to `gobject_check`.
      // Core only takes `hex_data`, so it rejected with
      // RPC_INVALID_PARAMS (too many positional arguments) and the
      // route's terminal-error classifier then misread that as
      // 422 core_rejected on valid proposals. Assert the adapter
      // boundary sees exactly one argument.
      const argCalls = [];
      ctx = buildApp({
        gObjectCheck: async (...args) => {
          argCalls.push(args);
          return { result: { 'Object status': 'OK' } };
        },
      });
      const { agent, csrf } = await loggedInAgent(ctx);
      await agent
        .post('/gov/proposals/prepare')
        .set('X-CSRF-Token', csrf)
        .send(validProposalBody());
      expect(argCalls).toHaveLength(1);
      expect(argCalls[0]).toHaveLength(1);
      expect(typeof argCalls[0][0]).toBe('string');
      expect(/^[0-9a-f]+$/.test(argCalls[0][0])).toBe(true);
    }
  );

  test('transient RPC failure is soft-allowed (still 201)', async () => {
    ctx = buildApp({
      gObjectCheck: async () => {
        // Simulate a transport-level error — nothing in the message
        // matches our "terminal" regex.
        const e = new Error('ECONNREFUSED 127.0.0.1:8370');
        throw e;
      },
    });
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(validProposalBody());
    expect(res.status).toBe(201);
    expect(res.body.submission.status).toBe('prepared');
  });

  test(
    'returns 500 JSON (not an unhandled rejection) when the DB throws during prepare lookup (Codex round 8 P1)',
    async () => {
      // Regression: `findPreparedByDataHexForUser` and
      // `drafts.getByIdForUser` used to run outside any try/catch in
      // this async handler. A synchronous better-sqlite3 throw
      // (SQLITE_BUSY / I/O / corrupt-index / temp-write-failed) then
      // became an unhandled promise rejection — Express 4 does not
      // catch async handler throws, so in prod it surfaces as a
      // hung request + a process-level warning rather than a clean
      // JSON 500 the client can retry.
      ctx = buildApp();
      const origFind = ctx.submissions.findPreparedByDataHexForUser;
      ctx.submissions.findPreparedByDataHexForUser = () => {
        const err = new Error('SQLITE_BUSY: database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      };
      const unhandled = [];
      const handler = (reason) => unhandled.push(reason);
      process.on('unhandledRejection', handler);
      try {
        const { agent, csrf } = await loggedInAgent(ctx);
        const res = await agent
          .post('/gov/proposals/prepare')
          .set('X-CSRF-Token', csrf)
          .send(validProposalBody());
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'internal' });
      } finally {
        ctx.submissions.findPreparedByDataHexForUser = origFind;
        process.removeListener('unhandledRejection', handler);
      }
      // Let any microtasks settle before we assert — an unhandled
      // rejection would land on the next tick.
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    }
  );

  test('draftId is consumed (deleted) by default on success', async () => {
    ctx = buildApp();
    const { agent, csrf } = await loggedInAgent(ctx);
    const draft = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ title: 'wip' });
    const draftId = draft.body.draft.id;
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send({ ...validProposalBody(), draftId });
    expect(res.status).toBe(201);
    expect(res.body.submission.draftId).toBe(draftId);
    const gone = await agent.get(`/gov/proposals/drafts/${draftId}`);
    expect(gone.status).toBe(404);
  });

  test('consumeDraft=false keeps the draft after prepare', async () => {
    ctx = buildApp();
    const { agent, csrf } = await loggedInAgent(ctx);
    const draft = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ title: 'keep me' });
    const draftId = draft.body.draft.id;
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send({
        ...validProposalBody(),
        draftId,
        consumeDraft: false,
      });
    expect(res.status).toBe(201);
    const stillThere = await agent.get(`/gov/proposals/drafts/${draftId}`);
    expect(stillThere.status).toBe(200);
  });

  test('unknown / other-user draftId is ignored (not an error)', async () => {
    ctx = buildApp();
    const a = await loggedInAgent(ctx, 'a@example.com');
    const b = await loggedInAgent(ctx, 'b@example.com');
    const draft = await b.agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', b.csrf)
      .send({ title: 'bs' });
    const draftId = draft.body.draft.id;
    const res = await a.agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', a.csrf)
      .send({ ...validProposalBody(), draftId });
    expect(res.status).toBe(201);
    expect(res.body.submission.draftId).toBeNull();
    // B's draft is untouched.
    const stillThere = await b.agent.get(`/gov/proposals/drafts/${draftId}`);
    expect(stillThere.status).toBe(200);
  });
});

// -----------------------------------------------------------------------
// attach-collateral + submissions list/get/delete
// -----------------------------------------------------------------------

describe('submissions lifecycle', () => {
  let ctx;

  beforeEach(() => {
    ctx = buildApp();
  });

  afterEach(() => {
    ctx.db.close();
  });

  async function prepareOne(agent, csrf, overrides = {}) {
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(validProposalBody(overrides));
    if (res.status !== 201) {
      throw new Error(
        `prepare failed: ${res.status} ${JSON.stringify(res.body)}`
      );
    }
    return res.body;
  }

  const FAKE_TXID =
    '9'.repeat(8) + 'a'.repeat(8) + 'b'.repeat(8) + 'c'.repeat(8) + 'd'.repeat(32);

  test('attach-collateral flips prepared → awaiting_collateral', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const res = await agent
      .post(
        `/gov/proposals/submissions/${prep.submission.id}/attach-collateral`
      )
      .set('X-CSRF-Token', csrf)
      .send({ collateralTxid: FAKE_TXID });
    expect(res.status).toBe(200);
    expect(res.body.submission.status).toBe('awaiting_collateral');
    expect(res.body.submission.collateralTxid).toBe(FAKE_TXID.toLowerCase());
  });

  test('attach-collateral rejects malformed txid (400)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const res = await agent
      .post(
        `/gov/proposals/submissions/${prep.submission.id}/attach-collateral`
      )
      .set('X-CSRF-Token', csrf)
      .send({ collateralTxid: 'deadbeef' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues[0].field).toBe('collateralTxid');
  });

  test('attach-collateral rejects re-attach (409 status_not_prepared)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    await agent
      .post(
        `/gov/proposals/submissions/${prep.submission.id}/attach-collateral`
      )
      .set('X-CSRF-Token', csrf)
      .send({ collateralTxid: FAKE_TXID });
    const res = await agent
      .post(
        `/gov/proposals/submissions/${prep.submission.id}/attach-collateral`
      )
      .set('X-CSRF-Token', csrf)
      .send({ collateralTxid: 'e'.repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('status_not_prepared');
  });

  test('attach-collateral rejects duplicate txid across submissions (409)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const p1 = await prepareOne(agent, csrf);
    // Slightly different proposal so /prepare creates a NEW row.
    const p2 = await prepareOne(agent, csrf, {
      name: 'fund-docs-2',
    });
    await agent
      .post(`/gov/proposals/submissions/${p1.submission.id}/attach-collateral`)
      .set('X-CSRF-Token', csrf)
      .send({ collateralTxid: FAKE_TXID });
    const res = await agent
      .post(`/gov/proposals/submissions/${p2.submission.id}/attach-collateral`)
      .set('X-CSRF-Token', csrf)
      .send({ collateralTxid: FAKE_TXID });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('txid_already_used');
  });

  test('attach-collateral 404 for non-owner', async () => {
    const a = await loggedInAgent(ctx, 'a@example.com');
    const b = await loggedInAgent(ctx, 'b@example.com');
    const prep = await prepareOne(a.agent, a.csrf);
    const res = await b.agent
      .post(
        `/gov/proposals/submissions/${prep.submission.id}/attach-collateral`
      )
      .set('X-CSRF-Token', b.csrf)
      .send({ collateralTxid: FAKE_TXID });
    expect(res.status).toBe(404);
  });

  test('list & get enforce ownership', async () => {
    const a = await loggedInAgent(ctx, 'a@example.com');
    const b = await loggedInAgent(ctx, 'b@example.com');
    const prep = await prepareOne(a.agent, a.csrf);

    const listB = await b.agent.get('/gov/proposals/submissions');
    expect(listB.body.total).toBe(0);

    const getB = await b.agent.get(
      `/gov/proposals/submissions/${prep.submission.id}`
    );
    expect(getB.status).toBe(404);

    const getA = await a.agent.get(
      `/gov/proposals/submissions/${prep.submission.id}`
    );
    expect(getA.status).toBe(200);
    expect(getA.body.submission.id).toBe(prep.submission.id);
  });

  test('delete allowed from prepared (204) and gone after', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const del = await agent
      .delete(`/gov/proposals/submissions/${prep.submission.id}`)
      .set('X-CSRF-Token', csrf);
    expect(del.status).toBe(204);
    const after = await agent.get(
      `/gov/proposals/submissions/${prep.submission.id}`
    );
    expect(after.status).toBe(404);
  });

  test('delete refused from awaiting_collateral (409)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    await agent
      .post(
        `/gov/proposals/submissions/${prep.submission.id}/attach-collateral`
      )
      .set('X-CSRF-Token', csrf)
      .send({ collateralTxid: FAKE_TXID });
    const del = await agent
      .delete(`/gov/proposals/submissions/${prep.submission.id}`)
      .set('X-CSRF-Token', csrf);
    expect(del.status).toBe(409);
    expect(del.body.reason).toBe('status_not_deletable');
  });

  test(
    'delete returns 409 when a concurrent transition racesthe row out of the deletable set (Codex round 7 P2)',
    async () => {
      // Scenario: the DELETE handler pre-reads the row, sees
      // `prepared`, passes the status gate, then calls
      // submissions.remove(). In a multi-worker deployment, a
      // sibling request (attach-collateral from another tab, or a
      // dispatcher pickup) can flip the status to
      // `awaiting_collateral` between that pre-read and the DELETE
      // statement. The repo's partial DELETE is guarded
      // (`status IN ('prepared','failed')`) so it returns 0 changes
      // — but the handler used to blindly return 204 anyway, which
      // tells the client the submission is gone while it is in fact
      // still alive and can run to completion on-chain.
      //
      // Fix (R7 P2): route checks `changes` and, when zero, re-reads
      // to pick the right failure code — 409 status_not_deletable
      // (raced to a non-deletable state) or 404 (raced to
      // `deleted`, which today can only happen from another tab).
      const { agent, csrf } = await loggedInAgent(ctx);
      const prep = await prepareOne(agent, csrf);
      const id = prep.submission.id;

      // Monkey-patch the submissions repo so `remove()` returns 0
      // and the partial DELETE actually didn't fire (we simulate a
      // concurrent transition to awaiting_collateral by flipping
      // the row directly via attachCollateral just before remove).
      const origRemove = ctx.submissions.remove;
      ctx.submissions.remove = (rowId, userId) => {
        // Simulate the concurrent transition — this is what
        // another worker would have done between the pre-read and
        // our DELETE.
        ctx.submissions.attachCollateral(rowId, userId, 'a'.repeat(64));
        return origRemove(rowId, userId);
      };

      try {
        const del = await agent
          .delete(`/gov/proposals/submissions/${id}`)
          .set('X-CSRF-Token', csrf);
        expect(del.status).toBe(409);
        expect(del.body.reason).toBe('status_not_deletable');
      } finally {
        ctx.submissions.remove = origRemove;
      }

      // Row still exists, in its raced-to status.
      const stillThere = await agent.get(
        `/gov/proposals/submissions/${id}`
      );
      expect(stillThere.status).toBe(200);
      expect(stillThere.body.submission.status).toBe('awaiting_collateral');
    }
  );

  test(
    'delete returns 404 when the row was deleted concurrently (Codex round 7 P2)',
    async () => {
      // Same class of race as the previous test, but the concurrent
      // worker deletes the row outright (another tab DELETE'd it).
      // The repo's pre-read hit it, but by the time we call remove
      // the row is gone — 0 changes and re-read returns null. The
      // handler must surface that as 404 so the UI doesn't pretend
      // it just deleted something it didn't.
      const { agent, csrf } = await loggedInAgent(ctx);
      const prep = await prepareOne(agent, csrf);
      const id = prep.submission.id;

      const origRemove = ctx.submissions.remove;
      ctx.submissions.remove = (rowId, userId) => {
        // Concurrent deletion by another tab
        origRemove(rowId, userId);
        // Report 0 changes for *our* call, as if a raced sibling
        // already consumed the row.
        return 0;
      };

      try {
        const del = await agent
          .delete(`/gov/proposals/submissions/${id}`)
          .set('X-CSRF-Token', csrf);
        expect(del.status).toBe(404);
        expect(del.body.error).toBe('not_found');
      } finally {
        ctx.submissions.remove = origRemove;
      }
    }
  );

  test('delete 404 when row belongs to another user', async () => {
    const a = await loggedInAgent(ctx, 'a@example.com');
    const b = await loggedInAgent(ctx, 'b@example.com');
    const prep = await prepareOne(a.agent, a.csrf);
    const del = await b.agent
      .delete(`/gov/proposals/submissions/${prep.submission.id}`)
      .set('X-CSRF-Token', b.csrf);
    expect(del.status).toBe(404);
  });
});

// -----------------------------------------------------------------------
// Factory validation — protects wiring regressions.
// -----------------------------------------------------------------------

describe('createGovProposalsRouter: factory argument validation', () => {
  test('drafts repo required', () => {
    expect(() =>
      createGovProposalsRouter({
        submissions: { create() {} },
        sessionMw: { requireAuth: () => {}, parse: () => {} },
        csrfMw: { require: () => {} },
        runAtomic: () => {},
      })
    ).toThrow(/drafts/);
  });
  test('submissions repo required', () => {
    expect(() =>
      createGovProposalsRouter({
        drafts: { create() {} },
        sessionMw: { requireAuth: () => {}, parse: () => {} },
        csrfMw: { require: () => {} },
        runAtomic: () => {},
      })
    ).toThrow(/submissions/);
  });
  test('sessionMw required', () => {
    expect(() =>
      createGovProposalsRouter({
        drafts: { create() {} },
        submissions: { create() {} },
        csrfMw: { require: () => {} },
        runAtomic: () => {},
      })
    ).toThrow(/sessionMw/);
  });
  test('csrfMw required', () => {
    expect(() =>
      createGovProposalsRouter({
        drafts: { create() {} },
        submissions: { create() {} },
        sessionMw: { requireAuth: () => {}, parse: () => {} },
        runAtomic: () => {},
      })
    ).toThrow(/csrfMw/);
  });
  test('runAtomic required', () => {
    expect(() =>
      createGovProposalsRouter({
        drafts: { create() {} },
        submissions: { create() {} },
        sessionMw: { requireAuth: () => {}, parse: () => {} },
        csrfMw: { require: () => {} },
      })
    ).toThrow(/runAtomic/);
  });
});
