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

function buildApp({
  gObjectCheck = null,
  nowRef = null,
  networkInfo = null,
  buildCollateralPsbt = null,
} = {}) {
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
        verifyEmail: rateLimiters.disabled(),
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
      ...(networkInfo ? { networkInfo } : {}),
      ...(buildCollateralPsbt ? { buildCollateralPsbt } : {}),
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

  // Codex PR8 round 16 P2: shape-valid but over-int64 payment_amount_sats
  // used to pass draft validation (the regex only checks digit shape)
  // and then overflowed the SQLite INTEGER column at insert/update,
  // surfacing as a generic 500. With the MAX_PAYMENT_AMOUNT_SATS gate
  // the route now returns a deterministic 400 with `amount_too_large`
  // so the client can correct the payload.
  test('create rejects payment_amount_sats above int64_max as 400 (Codex round 16 P2)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    // 2^63 exactly — one past the largest signed 64-bit integer,
    // the canonical overflow case.
    const over = '9223372036854775808';
    const res = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ paymentAmountSats: over });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues[0].field).toBe('payment_amount_sats');
    expect(res.body.issues[0].code).toBe('amount_too_large');
  });

  test('create accepts exactly int64_max payment_amount_sats (Codex round 16 P2)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    // 2^63 - 1 — the largest value the SQLite INTEGER column can
    // hold. Business-nonsensical for SYS but must pass draft
    // validation so we do not reject a representable payload.
    const max = '9223372036854775807';
    const res = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ paymentAmountSats: max });
    expect(res.status).toBe(201);
    expect(res.body.draft.paymentAmountSats).toBe(max);
  });

  test('patch rejects payment_amount_sats above int64_max as 400 (Codex round 16 P2)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const created = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ title: 'draft' });
    const id = created.body.draft.id;
    const res = await agent
      .patch(`/gov/proposals/drafts/${id}`)
      .set('X-CSRF-Token', csrf)
      .send({ paymentAmountSats: '9999999999999999999' }); // 10^19, > 2^63
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues[0].field).toBe('payment_amount_sats');
    expect(res.body.issues[0].code).toBe('amount_too_large');
  });

  test('create with over-range decimal paymentAmount also rejected as amount_too_large', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    // 10^13 SYS = 10^21 sats — parses fine to BigInt, but the
    // int64 gate below must still fire so the error code is
    // deterministic instead of a 500 at the repo layer.
    const res = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ paymentAmount: '10000000000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues[0].field).toBe('payment_amount_sats');
    expect(res.body.issues[0].code).toBe('amount_too_large');
  });

  // Codex PR8 round 17 P2: raw JSON numbers above
  // `Number.MAX_SAFE_INTEGER` are rounded by JSON.parse BEFORE the
  // route handler sees them. Earlier code then `BigInt(n)`-d the
  // already-rounded double, silently persisting a different
  // `payment_amount_sats` than the caller sent. Reject non-safe
  // integers with a dedicated code so clients know to switch to a
  // digit string for large values.
  test('create rejects paymentAmountSats as unsafe JSON number (Codex round 17 P2)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    // Use the JSON text explicitly so the number is parsed in
    // transit — supertest's .send(object) would let JS stringify
    // the literal, and we want the over-safe-integer path.
    const body = `{"paymentAmountSats": 9007199254740993}`;
    const res = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues[0].field).toBe('payment_amount_sats');
    expect(res.body.issues[0].code).toBe('amount_sats_unsafe_number');
  });

  test('create accepts paymentAmountSats at Number.MAX_SAFE_INTEGER (Codex round 17 P2)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    // 2^53 - 1 is losslessly representable both as a JS number and
    // as a BigInt, so the route MUST accept it without forcing the
    // caller to switch to a string.
    const body = `{"paymentAmountSats": 9007199254740991}`;
    const res = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body.draft.paymentAmountSats).toBe('9007199254740991');
  });

  test('create accepts paymentAmountSats as a large digit string (Codex round 17 P2)', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    // Well past safe-integer but still inside int64 — the correct
    // way for a client to submit large amounts.
    const res = await agent
      .post('/gov/proposals/drafts')
      .set('X-CSRF-Token', csrf)
      .send({ paymentAmountSats: '100000000000000000' }); // 10^17, < 2^63
    expect(res.status).toBe(201);
    expect(res.body.draft.paymentAmountSats).toBe('100000000000000000');
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
          verifyEmail: rateLimiters.disabled(),
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
    'prepare race fallback: DB throw on winner re-read returns JSON 500, not unhandled rejection (Codex round 12 P2)',
    async () => {
      // Regression: the unique-constraint recovery path re-reads
      // the winning row via findPreparedByDataHexForUser. That call
      // is synchronous better-sqlite3 and can throw (SQLITE_BUSY,
      // I/O, corrupt index) — without a local try/catch the throw
      // escaped as an unhandled rejection in the async Express 4
      // handler, reintroducing exactly the async-error gap the
      // surrounding code was designed to avoid. Fix: wrap the
      // re-read in try/catch and return the structured
      // `{ error: 'internal' }` JSON 500 the rest of the handler
      // already uses for DB failures.
      ctx = buildApp();
      const { agent, csrf } = await loggedInAgent(ctx);
      const body = validProposalBody();

      // Prime a prepared row so the UNIQUE index will reject the
      // second insert and push us into the recovery branch.
      const r1 = await agent
        .post('/gov/proposals/prepare')
        .set('X-CSRF-Token', csrf)
        .send(body);
      expect(r1.status).toBe(201);

      // Make the pre-read miss (drives the second /prepare into
      // the INSERT → UNIQUE-race branch) AND make the winner
      // re-read throw a synthetic SQLITE_BUSY.
      const realFind = ctx.submissions.findPreparedByDataHexForUser;
      let calls = 0;
      ctx.submissions.findPreparedByDataHexForUser = () => {
        calls += 1;
        if (calls === 1) return null; // pre-read miss
        // The recovery-path re-read — this is the call round-12
        // P2 protects. Throw synchronously as better-sqlite3
        // would under SQLITE_BUSY.
        const e = new Error('database is locked');
        e.code = 'SQLITE_BUSY';
        throw e;
      };

      const r2 = await agent
        .post('/gov/proposals/prepare')
        .set('X-CSRF-Token', csrf)
        .send(body);

      ctx.submissions.findPreparedByDataHexForUser = realFind;

      expect(r2.status).toBe(500);
      expect(r2.body).toEqual({ error: 'internal' });
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

  // Codex PR8 round 11 P1: narrow gObjectCheck terminal-error
  // matcher. The previous heuristic included a bare /invalid/
  // regex, which matched JSON-RPC transport/parser errors that
  // routinely contain the word "invalid" — for example the
  // messages below from fetch/jsonrpc client layers. Those are
  // transient outages, NOT Core validation rejects, and must
  // soft-allow through to a 201 prepare (let the idempotent
  // replay or a subsequent retry handle it) instead of being
  // misreported as a permanent 422 core_rejected.
  test.each([
    ['Invalid URL'],
    ['invalid response from server'],
    ['invalid JSON-RPC response: expected object'],
    ['invalid utf-8 sequence in headers'],
    ['request failed: invalid status line'],
  ])(
    'transport error containing "invalid" is soft-allowed not terminal (%s) (Codex round 11 P1)',
    async (transportMsg) => {
      ctx = buildApp({
        gObjectCheck: async () => {
          throw new Error(transportMsg);
        },
      });
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/proposals/prepare')
        .set('X-CSRF-Token', csrf)
        .send(validProposalBody());
      expect(res.status).toBe(201);
      expect(res.body.submission.status).toBe('prepared');
    }
  );

  // Complementary regression: the matcher still has to fire for
  // actual Core governance-validation phrases. If it does not,
  // bad payloads silently get filed as `prepared` and the user
  // only learns the object is garbage once the dispatcher
  // eventually submits and Core rejects it — a much worse UX
  // because collateral may already be burned by then.
  test.each([
    ['name exceeds 40 characters', 'name_too_long'],
    ['proposal data exceeds 512 bytes', 'payload_too_large'],
    ['payment_address is invalid', 'address_invalid'],
    ['Invalid data hex', null],
    ['Governance object is not valid - start_epoch', 'epoch_order'],
    ['Object submission rejected: hash mismatch', null],
  ])(
    'genuine Core reject phrase "%s" still returns 422 (Codex round 11 P1)',
    async (coreMsg, expectedIssueCode) => {
      ctx = buildApp({
        gObjectCheck: async () => {
          throw new Error(coreMsg);
        },
      });
      const { agent, csrf } = await loggedInAgent(ctx);
      const res = await agent
        .post('/gov/proposals/prepare')
        .set('X-CSRF-Token', csrf)
        .send(validProposalBody());
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('core_rejected');
      if (expectedIssueCode) {
        expect(
          res.body.issues.some((i) => i.code === expectedIssueCode)
        ).toBe(true);
      }
    }
  );

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

  test(
    'concurrent draft delete between pre-read and insert degrades to draftId:null (Codex round 9 P2)',
    async () => {
      // Regression: draft ownership USED to be resolved OUTSIDE the
      // `runAtomic` transaction. A concurrent delete of that draft
      // (e.g. another tab or an earlier /prepare that raced us) could
      // therefore invalidate the FK between the cached id and the
      // actual row, and the subsequent submissions.create would
      // throw SQLITE_CONSTRAINT (foreign key) — bubbling out as a
      // generic 500 even though the user's action is a perfectly
      // normal race we should degrade through.
      //
      // Fix: resolve draft ownership inside the same atomic block
      // that creates the submission. If the draft is gone by the
      // time we enter the transaction, fall back to draftId:null
      // instead of 500ing.
      //
      // We simulate the race by stubbing `drafts.getByIdForUser` to
      // return null (as if the row was deleted between the client
      // sending the request and the transaction starting). With the
      // fix in place, prepare succeeds with 201 and draftId:null.
      ctx = buildApp();
      const { agent, csrf } = await loggedInAgent(ctx);
      // Create a real draft so the request body's draftId survives
      // input validation (parseIntId + > 0).
      const draft = await agent
        .post('/gov/proposals/drafts')
        .set('X-CSRF-Token', csrf)
        .send({ title: 'will-race' });
      const draftId = draft.body.draft.id;

      // Simulate "concurrent delete landed before /prepare took the
      // write lock": force the inside-txn lookup to return null.
      const origGet = ctx.drafts.getByIdForUser;
      ctx.drafts.getByIdForUser = () => null;
      try {
        const res = await agent
          .post('/gov/proposals/prepare')
          .set('X-CSRF-Token', csrf)
          .send({ ...validProposalBody(), draftId });
        expect(res.status).toBe(201);
        expect(res.body.submission.draftId).toBeNull();
      } finally {
        ctx.drafts.getByIdForUser = origGet;
      }
    }
  );

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

  // Codex PR8 round 17 P2: /prepare used to `BigInt(f.paymentAmountSats)`
  // directly, which silently rounded raw JSON numbers above
  // `Number.MAX_SAFE_INTEGER` at parse time. The submission row's
  // canonical JSON + proposal_hash would then encode a different
  // payment amount than the caller typed. Reject unsafe numeric
  // input up-front so the caller can re-submit as a digit string.
  test('prepare rejects paymentAmountSats as unsafe JSON number (Codex round 17 P2)', async () => {
    ctx = buildApp({
      gObjectCheck: async () => ({ result: { 'Object status': 'OK' } }),
    });
    const { agent, csrf } = await loggedInAgent(ctx);
    const body = validProposalBody();
    // Strip paymentAmount so the sats path is taken.
    delete body.paymentAmount;
    // Send the JSON with a raw unsafe-integer literal in transit.
    const raw =
      JSON.stringify(body).replace(/}$/, '') +
      `, "paymentAmountSats": 9007199254740993}`;
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues[0].field).toBe('payment_amount_sats');
    expect(res.body.issues[0].code).toBe('amount_sats_unsafe_number');
  });

  test('prepare accepts paymentAmountSats as a large digit string (Codex round 17 P2)', async () => {
    // Digit strings parse losslessly through BigInt — this is the
    // recommended wire form for large amounts.
    ctx = buildApp({
      gObjectCheck: async () => ({ result: { 'Object status': 'OK' } }),
    });
    const { agent, csrf } = await loggedInAgent(ctx);
    const body = {
      ...validProposalBody(),
      paymentAmount: undefined,
      paymentAmountSats: '100000000000000000', // 10^17 sats, < 2^63
    };
    delete body.paymentAmount;
    const res = await agent
      .post('/gov/proposals/prepare')
      .set('X-CSRF-Token', csrf)
      .send(body);
    expect(res.status).toBe(201);
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
// GET /gov/proposals/network
// -----------------------------------------------------------------------

describe('GET /gov/proposals/network', () => {
  test('reports paliPathEnabled=false when nothing is wired', async () => {
    const ctx = buildApp();
    try {
      const { agent } = await loggedInAgent(ctx);
      const res = await agent.get('/gov/proposals/network');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        chain: 'unknown',
        slip44: null,
        networkKey: null,
        paliPathEnabled: false,
      });
    } finally {
      ctx.db.close();
    }
  });

  test('reports the configured network when both wired', async () => {
    const ctx = buildApp({
      networkInfo: { chain: 'main', slip44: 57, networkKey: 'mainnet' },
      buildCollateralPsbt: async () => ({
        psbt: { psbt: 'AA==', assets: '[]' },
        feeSats: '1',
      }),
    });
    try {
      const { agent } = await loggedInAgent(ctx);
      const res = await agent.get('/gov/proposals/network');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        chain: 'main',
        slip44: 57,
        networkKey: 'mainnet',
        paliPathEnabled: true,
      });
    } finally {
      ctx.db.close();
    }
  });

  test('reports paliPathEnabled=false when networkInfo is set but builder is not', async () => {
    // Defensive branch: a deploy that configures SYSCOIN_NETWORK but
    // forgets SYSCOIN_BLOCKBOOK_URL. The server still runs; /network
    // tells the FE the path is disabled so the button stays hidden.
    const ctx = buildApp({
      networkInfo: { chain: 'main', slip44: 57, networkKey: 'mainnet' },
    });
    try {
      const { agent } = await loggedInAgent(ctx);
      const res = await agent.get('/gov/proposals/network');
      expect(res.body.paliPathEnabled).toBe(false);
      expect(res.body.networkKey).toBe('mainnet');
    } finally {
      ctx.db.close();
    }
  });

  test('401 without session', async () => {
    const ctx = buildApp();
    try {
      const res = await request(ctx.app).get('/gov/proposals/network');
      expect(res.status).toBe(401);
    } finally {
      ctx.db.close();
    }
  });
});

// -----------------------------------------------------------------------
// POST /gov/proposals/submissions/:id/collateral/psbt
// -----------------------------------------------------------------------

describe('POST /gov/proposals/submissions/:id/collateral/psbt', () => {
  let ctx;

  beforeEach(() => {
    ctx = null;
  });

  afterEach(() => {
    if (ctx) ctx.db.close();
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

  const SAMPLE_XPUB =
    'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
  const SAMPLE_CHANGE = 'sys1qw508d6qejxtdg4y5r3zarvary0c5xw7kygmkq9';

  function withBuilder({ impl } = {}) {
    return buildApp({
      networkInfo: { chain: 'main', slip44: 57, networkKey: 'mainnet' },
      buildCollateralPsbt:
        impl ||
        (async () => ({
          psbt: { psbt: 'BASE64PSBT==', assets: '[]' },
          feeSats: '2000',
        })),
    });
  }

  test('503 pali_path_disabled when builder unwired', async () => {
    ctx = buildApp();
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const res = await agent
      .post(`/gov/proposals/submissions/${prep.submission.id}/collateral/psbt`)
      .set('X-CSRF-Token', csrf)
      .send({ xpub: SAMPLE_XPUB, changeAddress: SAMPLE_CHANGE });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('pali_path_disabled');
  });

  test('401 without session', async () => {
    ctx = withBuilder();
    const res = await request(ctx.app)
      .post('/gov/proposals/submissions/1/collateral/psbt')
      .send({ xpub: SAMPLE_XPUB, changeAddress: SAMPLE_CHANGE });
    expect(res.status).toBe(401);
  });

  test('403 csrf_missing', async () => {
    ctx = withBuilder();
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const res = await agent
      .post(`/gov/proposals/submissions/${prep.submission.id}/collateral/psbt`)
      .send({ xpub: SAMPLE_XPUB, changeAddress: SAMPLE_CHANGE });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_missing');
  });

  test('404 for non-existent submission id', async () => {
    ctx = withBuilder();
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .post('/gov/proposals/submissions/999999/collateral/psbt')
      .set('X-CSRF-Token', csrf)
      .send({ xpub: SAMPLE_XPUB, changeAddress: SAMPLE_CHANGE });
    expect(res.status).toBe(404);
  });

  test('404 when the submission belongs to another user', async () => {
    ctx = withBuilder();
    const a = await loggedInAgent(ctx, 'a@example.com');
    const b = await loggedInAgent(ctx, 'b@example.com');
    const prep = await prepareOne(a.agent, a.csrf);
    const res = await b.agent
      .post(`/gov/proposals/submissions/${prep.submission.id}/collateral/psbt`)
      .set('X-CSRF-Token', b.csrf)
      .send({ xpub: SAMPLE_XPUB, changeAddress: SAMPLE_CHANGE });
    expect(res.status).toBe(404);
  });

  test('409 when submission is already awaiting_collateral', async () => {
    ctx = withBuilder();
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const txid =
      'a'.repeat(8) + 'b'.repeat(8) + 'c'.repeat(8) + 'd'.repeat(8) + 'e'.repeat(32);
    // Move the row past `prepared` via the existing manual path.
    await agent
      .post(
        `/gov/proposals/submissions/${prep.submission.id}/attach-collateral`
      )
      .set('X-CSRF-Token', csrf)
      .send({ collateralTxid: txid });
    const res = await agent
      .post(`/gov/proposals/submissions/${prep.submission.id}/collateral/psbt`)
      .set('X-CSRF-Token', csrf)
      .send({ xpub: SAMPLE_XPUB, changeAddress: SAMPLE_CHANGE });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('status_not_prepared');
  });

  test('400 when xpub missing', async () => {
    ctx = withBuilder();
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const res = await agent
      .post(`/gov/proposals/submissions/${prep.submission.id}/collateral/psbt`)
      .set('X-CSRF-Token', csrf)
      .send({ changeAddress: SAMPLE_CHANGE });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues[0].field).toBe('xpub');
  });

  test('400 when changeAddress missing', async () => {
    ctx = withBuilder();
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const res = await agent
      .post(`/gov/proposals/submissions/${prep.submission.id}/collateral/psbt`)
      .set('X-CSRF-Token', csrf)
      .send({ xpub: SAMPLE_XPUB });
    expect(res.status).toBe(400);
    expect(res.body.issues[0].field).toBe('changeAddress');
  });

  test('happy path returns PSBT envelope + echoed opReturnHex', async () => {
    let captured;
    ctx = withBuilder({
      impl: async (args) => {
        captured = args;
        return {
          psbt: { psbt: 'BASE64PSBT==', assets: '[]' },
          feeSats: '2000',
        };
      },
    });
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const res = await agent
      .post(`/gov/proposals/submissions/${prep.submission.id}/collateral/psbt`)
      .set('X-CSRF-Token', csrf)
      .send({ xpub: SAMPLE_XPUB, changeAddress: SAMPLE_CHANGE, feeRate: 15 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      psbt: { psbt: 'BASE64PSBT==', assets: '[]' },
      feeSats: '2000',
      opReturnHex: prep.opReturnHex,
      collateralFeeSats: COLLATERAL_FEE_SATS.toString(),
      networkKey: 'mainnet',
    });
    // Builder received the exact args we forwarded, plus the server-
    // recomputed opReturnHex.
    expect(captured.xpub).toBe(SAMPLE_XPUB);
    expect(captured.changeAddress).toBe(SAMPLE_CHANGE);
    expect(captured.feeRate).toBe(15);
    expect(captured.opReturnHex).toBe(prep.opReturnHex);
  });

  test('422 insufficient_funds is not a 500', async () => {
    ctx = withBuilder({
      impl: async () => {
        const e = new Error('insufficient_funds');
        e.code = 'insufficient_funds';
        e.shortfallSats = '123';
        throw e;
      },
    });
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const res = await agent
      .post(`/gov/proposals/submissions/${prep.submission.id}/collateral/psbt`)
      .set('X-CSRF-Token', csrf)
      .send({ xpub: SAMPLE_XPUB, changeAddress: SAMPLE_CHANGE });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: 'insufficient_funds',
      shortfallSats: '123',
    });
  });

  test('400 network_mismatch maps to xpub validation issue', async () => {
    ctx = withBuilder({
      impl: async () => {
        const e = new Error('network_mismatch');
        e.code = 'network_mismatch';
        e.detail = 'expected zpub... for mainnet';
        throw e;
      },
    });
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const res = await agent
      .post(`/gov/proposals/submissions/${prep.submission.id}/collateral/psbt`)
      .set('X-CSRF-Token', csrf)
      .send({ xpub: SAMPLE_XPUB, changeAddress: SAMPLE_CHANGE });
    expect(res.status).toBe(400);
    expect(res.body.issues[0]).toEqual({
      field: 'xpub',
      code: 'network_mismatch',
      message: 'expected zpub... for mainnet',
    });
  });

  test('502 on blockbook_unreachable', async () => {
    ctx = withBuilder({
      impl: async () => {
        const e = new Error('blockbook_unreachable');
        e.code = 'blockbook_unreachable';
        e.detail = 'ENOTFOUND';
        throw e;
      },
    });
    const { agent, csrf } = await loggedInAgent(ctx);
    const prep = await prepareOne(agent, csrf);
    const res = await agent
      .post(`/gov/proposals/submissions/${prep.submission.id}/collateral/psbt`)
      .set('X-CSRF-Token', csrf)
      .send({ xpub: SAMPLE_XPUB, changeAddress: SAMPLE_CHANGE });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('upstream_unreachable');
    expect(res.body.detail).toBe('ENOTFOUND');
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
